# Gateway and dashboard

Describes: `main` after the app hardening PRs (ALPHA-81, 8 Oct). Earlier: PRs #25 and #29.

This page covers how requests get into the app, who is let in, and how they are limited.

- One admin login. The password comes from a GitHub secret into Secrets Manager; any other email or password gets a 401. Sign-up is closed (403).
- The gateway forwards only the routes meant for the outside world. Everything else (charge, refund, reserve, restock, send email, create shipment) gets a 404 and never reaches the service.
- The carrier webhook is open, but only accepts calls signed with the carrier's shared secret.

- Everything goes through api-gateway on port 8080. That includes the dashboard page, because the page calls `/api` and `/auth` on whatever address served it. Opened on 8086, those calls get a 404.
- Limits per 60 seconds: 120 per logged-in user, 60 per IP when not logged in, and 20 per IP on login, register and the shipping webhook. Over the limit you get a 429 and a `Retry-After` header.
- If Redis is down, requests are let through, and the gateway logs it and counts it.
- On EKS the client's real IP reaches the gateway: the NLB keeps it, Traefik passes it on in `X-Forwarded-For`, and the gateway believes that header only from inside the VPC.
- A request with a missing or bad token is counted against its real client IP; after 20 a minute it gets 429. Good tokens are never counted, so an attacker can't lock out real users who share the IP.
- Every dashboard tab logs in as the same admin and so shares one limit. That's why the dashboard refreshes every 30 seconds.

---

## 1. Where requests go

| Request path | Goes to | Notes |
|---|---|---|
| `/` | dashboard-api | The dashboard page. No token needed for the page itself. |
| `/dashboard/...` | dashboard-api | Path kept as is, because dashboard-api serves it under `/dashboard/`. |
| `/api/orders/...` | order-service | The `/api/orders` part is removed before forwarding. The same happens for every `/api/...` route. Only the routes in section 2 are forwarded. |
| `/api/inventory/...` | inventory-service | |
| `/api/payments/...` | payment-service | |
| `/api/shipping/...` | shipping-service | `/api/shipping/webhook` needs no token, but must be signed (section 2). |
| `/api/notifications/...` | notification-service | |
| `/api/dashboard/...` | dashboard-api | |
| `/auth/login` | the gateway itself | Admin email and password only. Returns a token valid for 24 hours. |
| `/auth/register` | the gateway itself | Closed: always 403. |
| `/healthz`, `/api/<service>/healthz` | gateway / each service | No token needed. |

Every other request needs `Authorization: Bearer <token>`.

---

## 2. Who gets in

**Login.** There is one account, the dashboard admin. The email is `ADMIN_EMAIL` (default `admin@platform.local`); the password is `ADMIN_PASSWORD`. On EKS it comes from the `ADMIN_PASSWORD` GitHub secret, through Terraform into Secrets Manager (`eks-v2-<env>-admin-password`) and an ExternalSecret; it is never in the repo. On a laptop it is `admin` (docker compose). The gateway keeps only a SHA-256 of the password and compares in constant time. A wrong email and a wrong password get the same 401, so the email can't be guessed. If `ADMIN_PASSWORD` is missing the gateway still starts, but refuses every login.

**Sign-up is closed.** It used to hand a valid token to anyone. Customer accounts need a user table with hashed passwords first (OWASP recommends Argon2id); see "Not built yet" in the app README.

**Who the services think is calling.** The gateway tells services who the user is in `X-User-Email` and `X-User-Role`, taken from the checked token. It deletes any copy of those headers a client sent, on every route.

**Routes the outside world can use** (everything else is 404 at the gateway, `allowlist.go`):

| Service | Allowed |
|---|---|
| orders | `GET /`, `POST /`, `GET /<id>`, `PUT /status` (the dashboard moves and cancels orders) |
| inventory | `GET /products`, `POST /products`, `GET /products/<id>`, `GET /low-stock` |
| payments | `GET /ledger`, `GET /balance/<id>` |
| notifications | `GET /history`, `GET /templates` |
| shipping | `GET /shipments`, `GET /shipments/<id>`, `GET /track/<n>`, `POST /webhook` |
| all | `GET /healthz` |

Paths with `.`, `..` or empty segments are never forwarded. The worker and scheduler call services directly inside the cluster, so they are not affected.

**The carrier webhook** (`POST /api/shipping/webhook`). The carrier signs each call: header `X-Carrier-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw body with the shared secret `CARRIER_WEBHOOK_SECRET` (Secrets Manager: `eks-v2-<env>-carrier-webhook-secret`). This is the scheme GitHub uses for its webhooks. Unsigned or wrongly signed: 401. No secret configured: 503 for every call. Only `in_transit` and `delivered` are accepted. A replayed call is harmless, because a shipment only moves forward. ADR 0010.

**Redis** needs a password (`eks-v2-<env>-redis-password`). Redis reads it from a mounted config file, its probes from `REDISCLI_AUTH`, the gateway from `REDIS_PASSWORD`. If they don't match, the gateway can't count and lets requests through (fail open), and logs it.

---

## 3. How the limiter decides who you are

| Who | Counted by | Limit per 60 s | Applies to |
|---|---|---|---|
| Logged-in user | User ID inside the token (`sub`) | 120 | All normal API calls |
| Not logged in | Client IP | 60 | Public paths such as health checks |
| Sensitive paths | Client IP | 20 | `/auth/login`, `/auth/register`, `/api/shipping/webhook` |

Details that matter:

- The client IP is the address that connected, without the port. `X-Forwarded-For` and `X-Real-IP` are believed only when the request comes from a proxy listed in `TRUSTED_PROXY_CIDRS`. Locally that list is empty, so nobody can fake their IP.
- Counters live in Redis under keys like `rl:user:<hash>`. The ID is hashed, so no emails or IPs are stored in Redis.
- Counting and setting the expiry happen in one Redis step, so a crash can't leave a counter that never resets.
- If Redis doesn't answer within 100 ms, the request is allowed (fail open). The gateway logs this at most once every 10 seconds.

Watch it with the metric `gateway_rate_limit_decisions_total{scope, result}` on port 9090 inside the container (9091 on your laptop). That port is never routed through the gateway.

---

## 4. How the dashboard behaves

1. The page loads from `/` on 8080 and shows only the login box.
2. The admin types the email and password. Wrong details show an error and the box stays.
3. The token is kept in the page's memory only, never in browser storage, so it is gone when the tab closes.
4. It loads its tables, then refreshes every 30 seconds.
5. When the token expires (24 hours) the next refresh gets a 401 and the login box comes back.
6. Placing an order sends an `Idempotency-Key`, and a shipping address when any address field is filled in.
7. The Services tab shows all 9 services. The worker and scheduler take no traffic, so dashboard-api asks their health ports from inside the cluster (`/dashboard/worker/healthz`, `/dashboard/scheduler/healthz`).

Why 30 seconds: one refresh makes 8 data calls. At the old 10 seconds that's 48 calls a minute per tab. Three open tabs make 144, over the 120 limit they share. At 30 seconds one tab makes 16 a minute, so 7 tabs fit.

---

## 5. Rules that must stay true

1. The gateway is the only way in. On EKS, nothing else is exposed.
2. Forwarding headers are trusted only from known proxies. Otherwise anyone can pick their own IP and dodge the limit.
3. Login, register and the webhook keep the stricter per-IP limit.
4. The metrics port is never routed through the gateway.
5. The dashboard loads data only after it has a token.
6. A route is reachable from outside only if it is listed in `allowlist.go`. Adding a public endpoint means adding it there.
7. Only the gateway sets `X-User-Email` and `X-User-Role`.
8. No password, secret or key is written in the code or the Helm values. They come from Secrets Manager through External Secrets.

---

## 6. Why it is built this way

**What was wrong before.** The old limiter counted by IP and port. Every new connection has a new port, so every connection got a fresh allowance and nothing was ever limited: 150 separate requests all returned 200. Login and register had no limit at all.

**The choices we made for now** (full reasoning in ADR 0003):

| Question | Options | What we picked | Why |
|---|---|---|---|
| Where do limits live? | Gateway only, or Traefik at the edge | Gateway only, for now | Traefik isn't running yet. Per-user limits need the token, which only the gateway reads. |
| How are requests counted? | Fixed 60 s window, or a token bucket | Fixed window | Simple, and fine for the first version |
| What if Redis is down? | Let requests through, or block them | Let them through | A Redis blip shouldn't take the whole shop down. It's logged and counted. |

**Dashboard:** it needs the same address as the API because the page uses paths like `/api/orders` without a host. Serving it from the gateway fixes that with one route and no changes to the page's paths. Slowing the refresh was the quick fix for the shared limit. Separate staff accounts would give each person their own limit; that needs the user store described in the README.

**Why one admin login and not a user store.** The only screen is the admin dashboard, and the deadline didn't allow a user table, password hashing and account management done properly. One account whose password lives in Secrets Manager closes the real hole (anyone could log in as anyone) without building half a user system. ADR 0009.

---

## 7. Traefik and the client IP

Traefik runs in front of the gateway on EKS, behind an NLB.

- The NLB keeps the client's IP (`preserve_client_ip.enabled=true` in `kubernetes/helm-values/traefik-values.yaml`; AWS turns this off by default for IP targets). Traefik adds it to `X-Forwarded-For`.
- `TRUSTED_PROXY_CIDRS` is the VPC range (`10.6.0.0/16` in dev), so the gateway believes that header only from Traefik's pods. A client outside the VPC can't fake its IP.
- Traefik does not rate-limit. Limits live in the gateway only (Redis, shared across its pods). A Traefik limit would count per Traefik pod in memory and add a second set of numbers to keep in line; see "Not built yet" in the app README.
- The gateway's own limits (per user, per IP, stricter on login) still apply behind it, in Redis, shared across gateway pods.

Everything per IP depends on the client IP really reaching the gateway. If it didn't, every client would share one bucket and normal traffic would be blocked. Check it after each new NLB:

```bash
# 1. the target group keeps the client IP
TG=$(aws elbv2 describe-target-groups --query "TargetGroups[?contains(TargetGroupName, 'traefik')].TargetGroupArn" --output text)
for t in $TG; do aws elbv2 describe-target-group-attributes --target-group-arn "$t" \
  --query "Attributes[?Key=='preserve_client_ip.enabled'].Value" --output text; done   # true

# 2. the gateway counts you under your own public IP
curl -sk -X POST https://dashboard.dev.eksv2.naimaosmann.com/auth/login -d '{}' >/dev/null
H=$(printf '%s' "$(curl -s https://checkip.amazonaws.com)" | sha256sum | cut -c1-32)
kubectl -n order-platform exec redis-0 -- redis-cli --scan --pattern "rl:sensitive:$H"   # one key = your IP was seen
```

---

## 8. How we know it works

- 10 gateway limiter tests, run against real Redis with the race detector.
- 22 logins in a row from one client gave 20 successes and 2 blocks (429). Before the fix, all 22 succeeded.
- 5 routing tests: the page is served without a token, `/dashboard/` keeps its path, data still needs a token, the other routes still strip their prefix, unknown paths give a 404.
- First load before the fix: 6 data calls went out before login finished and all got 401. After: 0 of 7 rejected in a browser test.
- Live on 8080: an order was placed from the page and confirmed, a product was added, and all 7 service dots were green.
- Hardening (8 Oct), gateway: 5 allow-list tests and 5 login tests (right and wrong password, other email, closed sign-up, no password configured, identity headers sent by a client). Each guard was broken on purpose and its test failed.
- Shipping webhook: 2 tests covering no signature, another secret, a body changed after signing, a bad format and no secret configured. Breaking the check makes them fail.
- Browser test of the page: login box first, wrong password shows an error, right password loads the tables, no token in browser storage, an order with an address was placed.
- Against the running services with a password-protected Redis: wrong login 401, sign-up 403, unsigned webhook 401, no token 401, an internal route 404, an order with a bad address 400.

---

## 9. Settings

| Variable | Default | What it does |
|---|---|---|
| `RATE_LIMIT_WINDOW_SECONDS` | 60 | Window length |
| `RATE_LIMIT_USER_PER_WINDOW` | 120 | Per logged-in user |
| `RATE_LIMIT_IP_PER_WINDOW` | 60 | Per IP, not logged in |
| `RATE_LIMIT_SENSITIVE_PER_WINDOW` | 20 | Per IP on login, register, webhook |
| `TRUSTED_PROXY_CIDRS` | empty | Proxies whose forwarding headers are believed |
| `METRICS_PORT` | 9090 | Prometheus metrics |
| `REDIS_URL` | none | Redis for the counters (no password in it) |
| `REDIS_PASSWORD` | none | Redis password, from Secrets Manager |
| `ADMIN_EMAIL` | `admin@platform.local` | The admin login |
| `ADMIN_PASSWORD` | none | The admin password, from Secrets Manager (ExternalSecret). Without it nobody can log in |
| `DASHBOARD_SERVICE_URL` | `http://dashboard-api:8086` | Where the page and `/dashboard/` go |

Small gaps fixed on 8 Oct (ALPHA-119):

- `X-Forwarded-For` sent to the services used to be replaced with Traefik's `ip:port`, so services saw the proxy, not the client. From a trusted proxy the gateway now keeps the incoming chain and Go's reverse proxy appends this hop (`client, traefik-pod`). From anyone else it drops the header, so a client can't write it. `X-Real-IP` is always set by the gateway to the real client IP, so a service that wants one trustworthy value reads that.
- A request with a missing or invalid token is now counted against its IP before the 401 (scope `badtoken`, the same 20 a minute as login), so bad tokens can't be sent without limit.

## 10. Security headers

The gateway adds these to every response, the dashboard page included:

| Header | Value | What it stops |
|---|---|---|
| `Content-Security-Policy` | scripts, data and images only from the page's own address; no plugins; no framing | Injected HTML running a script or sending data to another site. The page has no inline scripts or onclick handlers for this reason; its code is `static/app.js`. Inline `style` attributes are still allowed. |
| `X-Frame-Options` | `DENY` | The page being shown inside another site (clickjacking), for older browsers |
| `X-Content-Type-Options` | `nosniff` | A browser guessing a file is a script |
| `Referrer-Policy` | `no-referrer` | The page address leaking to other sites |

No `Strict-Transport-Security` yet: dev still uses a Let's Encrypt staging certificate, and HSTS would lock browsers out until the real certificate is in place. Add it at Traefik once production certificates are used.

Next: Run, build, test.
