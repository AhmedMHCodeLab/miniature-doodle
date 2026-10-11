## Description

Fixes the api-gateway rate limiter, which did not limit anything in practice.

**What was wrong (on `main`)**
- It counted per `RemoteAddr`, which includes the client's port. Every new connection got a fresh counter, so the limit never held.
- It trusted the leftmost `X-Forwarded-For` value, which the client controls. Anyone could pick their own "IP" per request.
- `INCR` and `EXPIRE` were two separate calls. If the second failed, the key never expired and that client stayed blocked.

**What it does now**
- **Who is counted:** logged-in requests per user (JWT `sub`); public requests per client IP. The IP comes from the connection; `X-Forwarded-For` is read right-to-left only when the connection comes from a proxy listed in `TRUSTED_PROXY_CIDRS`.
- **Stricter limit on login and register** (per IP), to slow down password guessing.
- **Atomic counter:** one Lua script does INCR + expiry, so every key always expires.
- **Blocked requests** get `429` with a `Retry-After` header.
- **Fails open:** if Redis is down, requests go through and a JSON log line is written (at most one per 10 s). Rate limiting must not take the site down.
- **Metric:** `gateway_rate_limit_decisions_total` on a separate port (9090, host 9091 locally), never routed by the gateway.
- **Config via env** (defaults in brackets): `RATE_LIMIT_WINDOW_SECONDS` (60), `RATE_LIMIT_USER_PER_WINDOW` (120), `RATE_LIMIT_IP_PER_WINDOW` (60), `RATE_LIMIT_SENSITIVE_PER_WINDOW` (20), `TRUSTED_PROXY_CIDRS` (empty).

**Interim design:** gateway-only, fixed window. Chosen to get the app stable for the infra work; we revisit it at the hardening pass. When Traefik sits in front on EKS, `TRUSTED_PROXY_CIDRS` must be set to its range, otherwise every request looks like it comes from Traefik's IP.

**Breaking change:** clients that go over the limit now actually get `429`. Load tests through the gateway will see 429s at the configured limits.

`go.mod`: adds `prometheus/client_golang` v1.23.2; Go directive 1.22 → 1.23.0.

## Ticket Link

Ticket: [ALPHA-73](https://app.plane.so/production-simulation/browse/ALPHA-73/)

Design note: ADR "Gateway rate limiting (interim)" (Plane page).

## Screenshots / Evidence

- 10 tests in `main_test.go`: client IP (port stripped, spoofed headers ignored from untrusted peers, forwarded chain read only from a trusted proxy), per-user limit, stricter login/register limit, atomic counter with expiry, `Retry-After` on 429, config from env and defaults, fail open when Redis is down.
- Redis-backed tests run only when `TEST_REDIS_URL` is set (they FLUSH that DB, so use a spare one): `TEST_REDIS_URL=redis://localhost:6379/15 go test ./...`

## Checklist

- [x] Tests passing locally
- [ ] Lint/format checks passing
- [ ] Terraform plan reviewed (if infra change) — n/a, no infra change
- [ ] Docs updated (if needed) — ADR page to be added in Plane
- [x] Breaking change — noted in description
