# App hardening: handover for a fresh chat

Written 7 Oct 2026 (Wed), checked against GitHub and Plane the same day. **Updated late on 7 Oct: eleven more fixes are built and tested and sit in one patch file (section 13, top entry). Start there.** Everything a new chat needs to carry on the app hardening work without the old conversation: who we are, how Ahmed wants to work, what the code and tickets look like right now, what is left (grouped), how to build and test each piece, and which docs to update once the work is done.

This file stands alone. It does not rely on any other document being available.

---

## 1. Read this first

**Who and what.** Ahmed is a DevOps/Platform Engineer in Doha, shadow leader of Team Alpha in CoderCo's Production Engineering Simulation (4 weeks, two competing teams of 5, graded on how the team worked and what shipped). The team takes a 9-service Go order platform to production on EKS. Final deadline: submission Sun 11 Oct, everything merged by Fri 9 Oct. Today is Wed 7 Oct.

**The job in this chat.** Ahmed wants to do the remaining app hardening tonight, group by group, with you. All of it is tracked in one Plane ticket, ALPHA-81. Work through the groups in section 6 in the order in section 7.

**Treat the project as a real client project.** Decide on the client's requirement, what the app actually does and the cost, security and PCI drivers. Do not describe any of it as a lab, a portfolio piece or a grader's hoop.

**The one rule that overrides the rest.** Ahmed must understand every step. Teach in plain English first, technical term second, one concept at a time, using one real example (Sara orders 2 mugs, it becomes order 42). If he says he is lost, stop, recap in plain words (what we change, why, what is verified, the one decision in front of him) and ask where he lost the thread.

---

## 2. How to work with Ahmed

### 2.1 The loop for each item

1. Say what the item risks in one sentence and name the reusable engineering concept behind it (for example "compare-and-set", "idempotency key", "claim then act"). Only concepts that transfer to AWS, Kubernetes, networking or CI/CD.
2. Read the current code first and show where the behaviour comes from. Label every technical statement Verified (name the source), Assumption, or Open question. Never fill a gap with confident wording.
3. Give at least two options with trade-offs. Keep your recommendation separate from his decision. For security or architecture choices lay out the trade-off and let him own the call. Flag a concern once, then execute his decision.
4. For design-heavy items (idempotency key, hold-expiry race, login), check the official docs first and say what question each doc answers. Do not summarise the docs in place of him reading the important parts.
5. Build the smallest safe slice, tests first or alongside. Include a test for duplicates, concurrency, retries and partial failure where they apply. Concurrency tests only mean something with a warm connection pool (open 4 to 20 connections first), otherwise the goroutines run one after the other.
6. Show real evidence: run the suite with `-race`, and do a mutation check (remove the fix, confirm the test fails).
7. Hand him the exact git commands and a commit split. Ahmed runs every git command himself.
8. End with two or three questions about the mechanism, not syntax. If he cannot answer, explain the missing link with a smaller example.

If production is truly urgent, say why, compress the teaching and take the smallest safe action first. A due date alone is not an emergency.

### 2.2 Hard limits

- **Git is off limits.** No commit, push, checkout, reset, revert, restore, stash or any other git-mutating command. Inspecting status, diff, log and files is fine. Ahmed runs git; you give the commands.
- **Local file edits are allowed**, with scope agreed per task. Look at the uncommitted working tree before proposing changes so nothing of his is overwritten.
- **No Claude attribution** in commits or PR text (no Co-Authored-By, no "Generated with"), even if tooling suggests it.
- **Never touch credentials.** Never enter, store, echo or ask for secrets or tokens.
- **No manual steps on EKS** ("we don't do manual"). Anything that must happen after a deploy is automated through GitOps, config or startup logic. Manual steps are acceptable for local work only.
- **Do not approve, cancel or re-run IaC workflows.** Tell Naima before adding Ahmed's EKS access entry.
- **Destructive commands** (anything that can overwrite local state, `docker compose down -v`, `git clean`, DB truncates) get a plain statement of what they overwrite and a non-destructive inspection alternative first.
- **Docs that are Ahmed's:** never move or delete them. Team docs live in the repo under `docs/<area>/` and he moves them in himself.
- **Do not bloat the repo.** Update an existing doc rather than creating a new one, and keep small decisions in the ticket or memory.

### 2.3 Writing style

- Plain words, short sentences, real numbers and named tools. No em dashes, no section signs, no decorative symbols.
- Avoid AI tells: no "it's not X, it's Y", no preview-body-restate scaffolding, no vague attribution, no hedge stacking, no bold lead-in bullet walls, none of: delve, leverage, robust, seamless, landscape, realm, navigate, underscore, testament, crucial, comprehensive, foster, ensure, "Here's the thing", "Let me break this down".
- Cut hedging qualifiers. Give a one-word verdict directly when asked for one.
- Team-facing writing (PRs, tickets, commits, thread posts) can be drafted by you in a senior engineer's voice: short, states why, trusts the reader to read the diff.
  - Commit: subject line, body only when the why is not obvious.
  - PR: what it adds, ticket, brief evidence, any handoff. No testing or screenshot section.
  - Ticket: user story plus deliverables only. Anything extra goes in a comment.
  - Thread post: status, blocker or ask in a few lines.
  - ADRs and PR text stay in Ahmed's own words: draft if asked, and tell him to rewrite in his voice.
- Team docs must be self-contained. Never cite meetings, calls, dated discussions or Notion as the source of a decision. State the decision and the reason.

---

## 3. Team rules (from Saad, the stakeholder and scrum master)

- Branch name: `alpha-<id>-<short-desc>`. Commit: `type(scope): subject` (Conventional Commits), one commit per piece of work, squash fix-ups. PR title: conventional prefix plus the ticket, for example `fix(order-service): ... (ALPHA-81)`. The PR creator merges after another person approves. No self-approval. Post the PR in the team thread and tag everyone.
- Every piece of work has a ticket. Scope growth is announced publicly. Mid-sprint additions finish in the sprint or go back to the backlog.
- Tickets are a user story plus deliverables, in simple language. Story points are free text in the description (`point: N`), counted as hours. Waiting on a dependency does not count.
- A draft PR keeps the ticket In Progress. Done means merged. Before closing a ticket, move any deferred deliverable to another ticket. Duplicates get a "duplicate of" comment, never deleted.
- Do not take over a teammate's in-progress ticket without talking to them.
- A running app beats documentation. Keep Plane pages uncluttered, rough notes in one place.
- Priority order set by the stakeholder: cost first, then security, then uptime, then features. $200 AWS cap.
- Plane access: Ahmed said using AI to write and update tickets is fine within these rules.

---

## 4. The system in 90 seconds

Nine Go services (standard library `net/http`), one shared Postgres database `orders`, Redis for the gateway rate limiter, and one SQS queue with a dead-letter queue (DLQ).

| Service | Local port | Job |
|---|---|---|
| api-gateway | 8080 | Front door. Login (any email works today), rate limits, routes `/api/<service>/...` to each service, serves the dashboard page. |
| order-service | 8081 | Orders and their status. Writes the order, its history and an outbox row in one transaction. A relay sends outbox rows to SQS every second. |
| inventory-service | 8082 | Products, stock holds (`/reserve`, `/release`, `/commit`, `/restock`). |
| payment-service | 8083 | `/charge`, `/refund`, ledger. Card provider is simulated and declines about 1 in 10. |
| notification-service | 8084 | Renders templates and records notifications, each once (`dedupe_key`). |
| shipping-service | 8085 | One shipment per order, `PUT /shipments/by-order/{id}`, public `/webhook`. |
| dashboard-api | 8086 | Serves the static page `services/dashboard-api/static/index.html`. Only works through the gateway. |
| worker | none | Reads SQS. Handles `order.created` and `order.status_changed`. |
| scheduler | none | Timed jobs: expire holds, cancel abandoned orders, digest, cleanup. |

Order journey for Sara's order 42 (2 mugs, 119.98):

1. `POST /api/orders/` through the gateway. order-service looks up each price in inventory, saves order, event history and outbox row in one transaction, returns 201 `pending`.
2. The relay sends `order.created` to SQS within about a second.
3. The worker reads it: checks the order status first, reserves stock, charges the card, sets the order `confirmed`, commits the stock.
4. Setting a status writes a new outbox event, `order.status_changed`. The worker handles it: `confirmed` creates a shipment and sends the confirmation email, `processing`, `shipped` and `delivered` move the shipment and send the matching email, `cancelled` cancels the shipment and refunds the payment.
5. Business "no" (out of stock, card declined) is a final answer: undo, cancel, delete the message. A 5xx or timeout keeps the message, SQS redelivers, and after 3 receives (60 s visibility timeout) it lands in the DLQ.

Valid status moves: pending to confirmed or cancelled, confirmed to processing or cancelled, processing to shipped or cancelled, shipped to delivered.

**Why every step must be safe to repeat.** SQS delivers at least once. Messages can arrive twice, late, or after the order moved on. The database enforces this, not the caller: unique indexes with `ON CONFLICT DO NOTHING`, compare-and-set updates (`UPDATE ... WHERE status = $current`), `FOR UPDATE` row locks, dedupe keys.

**Deployed.** EKS dev at `dashboard.dev.eksv2.naimaosmann.com` (HTTP only). Path: Route53, NLB, Traefik, api-gateway, services. RDS Postgres (locked decision, do not reopen). Secrets from AWS Secrets Manager through External Secrets. Redis runs in the cluster (StatefulSet with a disk, no password). Deploy flow: merge to `main`, CI builds images, a bot commit "point dev at <sha> images" updates the tag, ArgoCD syncs dev (the sync step is Assumption, not checked from here).

---

## 5. Verified state on 7 Oct

Checked in the browser on GitHub and through the Plane connector, plus the local clone.

**Already merged to `main` (this was not in the earlier plan docs):**

- PR #63 `fix(app): repair the order flow and harden the app (ALPHA-81, ALPHA-50, ALPHA-78)` merged as `28c526e`, 9 commits, approved by naima90, 11 checks passed. After it, the bot commit "point dev at 28c526e images" landed. Everything described as "built on branch, not merged" in older notes is now on `main`.
- PR #54 (Redis, ALPHA-89) merged 6 Oct. PR #47 (metrics endpoint) merged.

**The 9 commits in PR #63:**

| Commit | What |
|---|---|
| `862386c` | api-gateway refuses to start without `JWT_SECRET` |
| `b251b7b` | inventory validates products, `/restock`, demo seed |
| `81414af` | compose and dev set `SEED_DEMO_PRODUCTS` |
| `7ce37ee` | payment refund by order, safe to repeat, ledger balanced |
| `91d8d35` | notification-service sends each email once, fills templates |
| `c07160c` | shipping-service one shipment per order, `PUT /shipments/by-order/{id}` |
| `04893d8` | worker handles `order.status_changed` |
| `08d5f3e` | order-service takes prices from inventory, total rounded to pence |
| `683da14` | dashboard order form picks the product from a dropdown |

**Open on GitHub:** four Renovate PRs (#55 go modules, #56 and #57 docker images, #58 GitHub Actions) and Ramla's #46 (local monitoring stack). Renovate touches `go.mod`, `go.sum` and Dockerfiles in every service. Do not edit those files in hardening commits. If a Renovate PR merges first, rebase.

**Local clone** (`C:\Users\ahmed\Desktop\CoderCo\Projects\Alpha-Pilot-4week`): on branch `alpha-81-app-hardening`, identical to the merged PR head. Its cached `origin/main` is stale (a fetch from the cloud sandbox fails on SSH). First command in a new session: Ahmed runs `git fetch origin`, then branches from fresh `main`.

**Local-only, not in the repo** (deliberate): `docs/app/`, `docs/sqs/`, `docs/redis/`, `docs.zip`, `Claude outputs/` (excluded via `.git/info/exclude`), `infra/terraform/local/`. Do not commit or move them.

**Plane ALPHA-81** ("App hardening", In Progress). Description is the user story plus grouped task-list deliverables. It currently ends with `point: 8` (it said 12 earlier; Ahmed or a teammate changed it). Ticked deliverables are the ones merged in PR #63. Open items are unticked. Two comments hold the scope note and notes on the open items. ALPHA-50, ALPHA-46, ALPHA-78 were cancelled as duplicates of ALPHA-81; ALPHA-49 and ALPHA-47 were already cancelled. ALPHA-80 (capacity load tests) and ALPHA-89 (Redis, done) are separate.

**Confirmed still open by reading the code on 7 Oct:**

| Item | Evidence |
|---|---|
| No idempotency key anywhere | grep for `Idempotency-Key` in services: no hits |
| Dashboard builds HTML from data unescaped | 14 `innerHTML` assignments in `static/index.html`, no escape helper |
| Scheduler cancels with raw SQL | `services/scheduler/main.go` line 164: `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, no status guard, no event, only a log line |
| Scheduler has no tests and no `ORDER_SERVICE_URL` | not in `docker-compose.yml` or `kubernetes/deploy/envs/dev/scheduler.yaml` |
| Gateway proxies every `/api/<service>/...` path to any logged-in user | `handleProxy` in `services/api-gateway/main.go`, route map at line 55 |
| Shipping webhook has no authentication and accepts any status text | `handleCarrierWebhook` in `services/shipping-service/main.go` |
| Redis has no password | no `requirepass` anywhere |
| Only order-service uses `TIMESTAMPTZ` (3 places) | grep |
| Scheduler cleanup deletes `order_events` after 90 days only | `cleanupOldEvents`; nothing cleans `order_outbox`, notifications or shipments |
| Orders have no address field | grep in order-service |

**Not verified from here:** whether ArgoCD has synced the `28c526e` images onto the EKS dev cluster, and whether the EKS check deliverable passes. Ahmed must see it in the dashboard.

---

## 6. What is left, grouped

Same groups as the ticket. Plan item numbers in brackets (the old plan numbered 35 items). Status: **Done** = merged on `main`. **Open** = not built. **Risk** = we state it as a known risk if not built by Fri.

Time estimates are mine, not measured. Total open work is about 55 hours, and real login alone is several days, so not everything will fit. Section 7 gives the order.

### Group A. Orders and payments

| # | Item | Status | Detail |
|---|---|---|---|
| 7 | Prices come from inventory, unknown products refused | Done | order-service looks up each item's price in inventory at create and ignores the request price. Trade-off accepted: if inventory is down, new orders fail with 503 (3 s timeout) instead of being accepted. |
| 3, 20 | Refund by order, safe to repeat, ledger balances | Done | Repeat refund returns 200, changes nothing. Refund writes both ledger sides. |
| 28 | Scheduler cancels abandoned orders through order-service | Built and tested 7 Oct, in Ahmed's working tree, not committed (Ahmed commits it first, see section 13) | See 6.A1 and the progress log (section 13). Likely cause of the live failure on 6 Oct ("cannot transition from cancelled to confirmed", card charged, nothing refunded). |
| 4 | Idempotency key on `POST /orders` | **Built and tested 7 Oct (patch 1 and 2), not committed** | See 6.A2 and section 13. Reproduced 7 Oct: two identical concurrent requests gave orders 6 and 7, both confirmed, both charged. |
| 4b | Idempotency key replay on `/charge` | Open, low priority | Only adds exact replay of failed attempts. The worker is the only legitimate caller, and one completed charge per order is already enforced by a unique index. |
| 19 | Hold expiry race and `/commit` on an expired hold | **Built and tested 7 Oct (patches 6, 9, 10), not committed** | See 6.A3 and section 13. |
| 30 | Money as pence or a decimal type, not a float | Risk | Totals are rounded to pence on create (`roundMoney` in `services/order-service/pricing.go`). The Go code still uses `float64`. The database already uses DECIMAL. |

**6.A1 Scheduler abandoned-order cancel (item 28).**

- Today: `detectAbandonedOrders` selects `pending` orders older than 30 minutes and runs `UPDATE orders SET status='cancelled'` itself. No `AND status='pending'` guard, so it can overwrite an order the worker confirmed a moment earlier. No outbox event, so the worker never releases stock or refunds. No history row.
- Fix: call order-service `PUT /status` with `{"order_id": N, "new_status": "cancelled"}`. That path already has compare-and-set, history and the outbox event, and the worker's `order.status_changed` handler then refunds, restocks and cancels the shipment. Treat 200 as done, 409 as "someone else moved it, skip", other errors as retry on the next tick.
- Needs `ORDER_SERVICE_URL` for the scheduler in `docker-compose.yml` (scheduler uses the `database-env` anchor only) and in `kubernetes/deploy/envs/dev/scheduler.yaml`. The scheduler is pinned to 1 replica (`singleton: true`).
- Scheduler has no tests. Add one with an `httptest` fake order-service and a real Postgres.
- Concept to teach: one owner per state transition. The service that owns the state machine is the only writer.
- Built 7 Oct (details in section 13). One addition to the design above: `PUT /status` takes an optional `expected_status`. Reason: `confirmed` to `cancelled` is a valid move, so if the worker confirmed the order between the scheduler's SELECT and its call, a plain cancel would succeed and refund a paid order. With `expected_status: "pending"` order-service answers 409 and leaves it alone. Old order-service replicas ignore the field, so the order of rollout does not break anything (the race window only stays open until order-service is updated).

**6.A2 Idempotency key on `POST /orders` (item 4). BUILT 7 Oct as designed below, see section 13.** Design:

- What already holds: one completed charge per order (unique index in payment-service). `/charge` again with the same details returns 200 `already_paid`, different amount returns 409. Stock holds and status changes are safe to repeat.
- What does not hold: `POST /orders` always inserts. A double click, a client retry after a timeout or a direct API call each creates a new order with its own hold and its own charge, because nothing says it is the same intent.
- Design (option A): `Idempotency-Key` header, required on `POST /orders` (400 without it, otherwise a direct caller with no key gets no protection, which is the case the stakeholder asked about). Table `idempotency_keys` with unique `(customer_id, key)`, a hash of the request body and the order id, written in the same transaction as the order. Same key and same body: 200 with the original order. Same key and different body: 422. A different key is a different order by design (same as Stripe). Keys kept 24 hours, pruned by the scheduler with the other retention work (item 17).
- Concurrent requests with the same key: the second `INSERT` into the unique index waits for the first transaction in Postgres, so the "in progress" 409 from the IETF draft may be unnecessary. Confirm with a concurrency test before relying on it.
- Dashboard: send a fresh UUID key per click and disable the Place Order button while the request runs. The k6 load scripts (ALPHA-80) must send a key too.
- Done when: 10 simultaneous identical requests with one key give one order, one outbox event, one stock hold; same key with a different body gives 422; a different key gives a second order.
- Rejected options: same customer plus same items within N seconds (blocks legitimate repeat purchases), client-generated order id as primary key (same effect, more schema change), disabling the button only (no protection against the API), a checkout session (right at larger scale, too big for this week).
- Standards checked 7 Oct: Stripe idempotent requests (saves status and body of the first request per key, errors on changed parameters, keys kept at least 24 hours, V4 UUIDs, up to 255 characters), AWS Builders' Library "Making retries safe with idempotent APIs" (record the id in the same ACID operation, equivalent response on retry, validation error on mismatch), IETF `Idempotency-Key` header draft (draft-07, not an RFC: same payload returns the earlier result, different payload 422, still running 409, missing key 400, scope the key to the client).
- Concept to teach: idempotency key versus idempotent operation, and why the key row and the order row must commit together.

**6.A3 Hold expiry race (item 19). BUILT 7 Oct, see section 13.** What was built: the scheduler's `expireReservation` claims one hold (active to expired) and gives the stock back in the same transaction only if the claim changed a row; inventory `/commit` answers 409 when the order has no active hold and nothing committed (a repeat of a real commit is still 200); the worker, on that 409 for a paid order, takes the stock again and commits, or cancels the order (refund through the cancel handling) if the stock is gone. Original analysis:

- The scheduler's `expireReservations` marks holds expired and subtracts `reserved` with `GREATEST(..., 0)`. A hold that expires exactly while `/commit` or `/release` runs can subtract twice, and `GREATEST` hides the drift. `/commit` on an expired hold returns 200, so a paid order can finish without stock leaving the shelf.
- Fix: claim-then-act. Expire with `UPDATE ... WHERE status='active' AND expires_at < NOW() RETURNING ...` and subtract only for rows it claimed. `/commit` returns 409 for an expired hold. The worker must handle that 409 (a paid order whose hold expired needs a decision: re-reserve or refund).
- Test needs a hold that expires while being committed, with a warm pool.

### Group B. Access and identity

| # | Item | Status | Detail |
|---|---|---|---|
| 8 | Product create rejects negative price and stock, no raw DB errors | Done | |
| 10 | Gateway refuses to start without `JWT_SECRET` | Done | Breaking change, already set in compose and dev. |
| 29 | Gateway refuses internal routes | **Built and tested 7 Oct (patch 4), not committed** | Allow-list per service. See 6.B1. |
| 9 | Shipping webhook rejects unknown statuses and unproven callers | Open | **Status validation built 7 Oct (patch 3).** The webhook now takes only `in_transit` and `delivered`, needs a tracking number, and moves the shipment forward only. A signed or secret-checked caller is NOT built: it needs a secret from Secrets Manager, so it touches the platform side. ALPHA-49 was cancelled "not within sprint scope", so the unauthenticated caller stays a stated risk. |
| 31 | Dashboard confirm button no longer skips payment | **Built 7 Oct (patch 11), not committed** | The pending to confirmed button is removed (the worker confirms after the charge). Cancel is still offered. |
| 5 | Real login with hashed passwords | Risk, multi-day | Login accepts any email and any password, every login gets role `customer`. There is no user table. State it plainly in the Q&A rather than rush it. |
| 6 | Ownership checks and admin-only routes | Risk | Decided 7 Oct: depends on item 5. Without real login, an ownership check only stops someone who is not trying (anyone can log in as anyone). A role check would lock the dashboard (`admin@platform.local` is role `customer`) out of its own actions. The worker also calls order-service directly with no user. |
| 11 | Per-service database logins | Risk | On RDS all 7 database services connect as the RDS master user. One role per service is 9 secrets plus grants. |
| 34 | Redis requires a password | Open, small | Deferred from the Redis ticket. Needs a secret and the gateway's `REDIS_URL` updated, through External Secrets, not by hand. |

**6.B1 Gateway refuses internal routes (item 29). BUILT 7 Oct, see section 13.** The k6 scripts were not in the repo, so the allow-list was built from the dashboard's calls plus the services' own read routes. Original analysis:

- The gateway's `handleProxy` forwards every `/api/<service>/<path>` to the service for any logged-in user. That exposes `/api/payments/refund`, `/api/inventory/restock`, `/commit`, `/release`, `/reserve`. Those are for the worker, which calls the services directly on their cluster addresses and never goes through the gateway (Verified from the worker code). So blocking them at the gateway does not break the worker.
- Before blocking, list every path the dashboard calls (`static/index.html`) and the k6 scripts. Checked 7 Oct: the dashboard calls `/auth/login`, `/api/orders/` (GET and POST), `PUT /api/orders/status`, `/api/inventory/products` (GET and POST), `/api/payments/ledger`, `/api/shipping/shipments`, `/api/notifications/history` and `/dashboard/summary`. It does not call `/refund`, `/restock`, `/commit`, `/release` or `/reserve` (no match in the page). Check the k6 scripts before blocking.
- The shipping webhook (`/api/shipping/webhook`) is a public path in the gateway (no token needed) and gets the 20/min sensitive limit per IP. That is why status validation and a caller secret matter there.
- Prefer an allow-list per service over a deny-list (a new internal route stays blocked by default).
- Add gateway tests (the gateway has a routing test file; extend it).

### Group C. Rate limiting

ADR 0003 describes the interim gateway limiter: fixed 60 s window in Redis, scopes user 120/min (JWT `sub`), anonymous IP 60/min, sensitive paths 20/min per IP (`/auth/login`, `/auth/register`, shipping webhook), 429 plus `Retry-After`, fails open if Redis is down, trusted proxies only for `X-Forwarded-For`.

| # | Item | Status | Detail |
|---|---|---|---|
| 25 | Redis running on EKS | Done | PR #54, merged 6 Oct. |
| 13 | `TRUSTED_PROXY_CIDRS` lists the VPC range | Done in config | Dev sets `10.6.0.0/16`, the NLB keeps the client IP (`preserve_client_ip.enabled=true`). Not proven until the EKS check (Group G). |
| 12 | Per-IP limits move to Traefik with shared counters | Risk | Traefik RateLimit middleware. Needs the Traefik values file. Not required for the app to be correct. |
| 14 | Dashboard has its own login and limit | Risk | Needs real login (item 5). All tabs share `admin@platform.local`, one 120/min bucket. Mitigated by the 30 s refresh (16 requests a minute per tab). |
| 15 | Shared-IP shoppers share the 20/min login limit | Risk | Decide the number from the `gateway_rate_limit_decisions_total{result="limited"}` metric under load (ALPHA-80). |
| 16 | Small gaps: `ip:port` in `X-Forwarded-For`, invalid tokens not counted, "limited" log line not throttled | Risk | Each fixed or accepted in writing. |

### Group D. Dashboard

| # | Item | Status | Detail |
|---|---|---|---|
| | Revenue net of refunds, longer error toasts | Done | |
| 27 | Stored XSS | **Built and checked in a real browser 7 Oct (patch 5), not committed** | See 6.D1. |
| 33 | Services tab shows worker and scheduler health | Risk | Both run a `/healthz` on a health port (scheduler default 8091), but the gateway does not route to them and the dashboard's service list does not include them. Needs a route or a status endpoint the dashboard can reach, and a decision on whether the gateway should expose it. |

**6.D1 Dashboard XSS (item 27). BUILT 7 Oct, see section 13.** Original analysis:

- The page builds table HTML by string-joining server data into `innerHTML` at 14 places (lines 236, 252 to 253, 324 to 325, 357, 370 to 371, 383 to 384, 394, 407 to 408, 427 of `static/index.html`). A product name such as `<img src=x onerror=...>` runs in every viewer's browser, including the admin's, whose token sits in `localStorage`.
- Fix: one `esc()` helper that escapes `& < > " '`, applied to every interpolated value, or build rows with `textContent`. Escape on output, not on input.
- Test: create a product named with markup (through the API or the Inventory tab), confirm it renders as text on every tab. Add the markup case to the browser check.
- Concept to teach: why escaping happens at the point of output, and why stored XSS is worse than reflected.

### Group E. Shipping and emails

| # | Item | Status | Detail |
|---|---|---|---|
| | Worker creates and moves shipments, sends 4 emails once each | Done | Confirmed, shipped, delivered, payment failed. Placeholder address "PLACEHOLDER - no address collected yet (ALPHA-78)". |
| 35a | Orders store a real shipping address | Risk | Placeholder decided by Ahmed. Needs an address on the order and the dashboard form. |
| 35b | Cancellation email, and a failed email is not lost | **Built and tested 7 Oct (patch 8), not committed** | New `order_cancelled` email, sent once per order as the last step of the cancel handling; a failed send returns an error so the message is retried. The payment failed email stays best effort, so a declined order gets both emails (payment failed, then cancelled). |
| 21 | Payment and shipment events go through the outbox | Risk | Today they are only logged. Same pattern as order-service (event row in the same transaction, relay sends). |
| 35c | De-duplicate events by event id | Risk | Each step is already safe to repeat, so this adds protection, not a fix. |

### Group F. Data and operations

| # | Item | Status | Detail |
|---|---|---|---|
| 18 | Scheduler pinned to 1 replica | Done | Chart `singleton: true`, Recreate strategy. |
| 24 | SQS settings match the app | Done | Visibility 60 s, `maxReceiveCount` 3, DLQ kept 14 days vs 4 days for the queue. |
| | Demo products on local and dev | Done | `SEED_DEMO_PRODUCTS`, off everywhere else. |
| 17, 32 | Retention for outbox, notifications, shipments | **Partly built 7 Oct (patch 6)**: outbox sent rows 7 days, idempotency keys 24 h, notifications 90 days, order events 90 days. Shipments and their tracking events are NOT pruned (still a stated risk). Original note: | Sent `order_outbox` rows are never deleted and the payload holds the customer email. Notifications and shipments keep customer emails too. Agree a retention, extend the scheduler's `cleanupOldEvents` (today only `order_events` at 90 days). The idempotency keys join this job. |
| 22 | Timezone-aware timestamps | **Mostly fixed 7 Oct (patches 6, 7)**: every cut-off in the scheduler, the digest and the stock hold length is now computed by Postgres, not passed in from the Go clock. The columns are still `TIMESTAMP` without a zone. It did trigger: Ahmed's laptop (UTC+3) cancelled every young order on the first scheduler run. |
| 23 | DLQ runbook and a DLQ-not-empty alert | Risk, runbook is cheap, NOT written yet (docs work) | Redrive proven locally: `aws sqs start-message-move-task --source-arn <dlq-arn>` re-processed a stuck order in 10 s. The alert is an Alertmanager item on the platform side. |

### Group G. Proof (last)

- Check on EKS dev through the dashboard: place an order, confirm, ship, deliver, cancel with refund. 22 logins from one client IP in a minute give 20 x 200 and 2 x 429. That one test proves Redis works on EKS and the real client IP survives the NLB.
- Docs and ADRs updated (section 9).
- Known-risk write-up for everything not built (section 10).

---

## 7. Suggested order for tonight

1. Ahmed: `git fetch origin`, then a fresh branch from `main` (suggested `alpha-81-scheduler-cancel`; one branch and PR per piece keeps review small, and it matches one commit per piece of work).
2. 6.A1 scheduler cancel (small, closes the last known money leak). DONE in the working tree on 7 Oct, waiting for Ahmed's commits, PR and local drill (section 13).
3. 6.A2 idempotency key on `POST /orders`. DONE in the patch file (patches 1, 2).
4. 6.B1 gateway internal routes plus webhook status validation. DONE (patches 3, 4).
5. 6.D1 dashboard XSS, and the manual confirm button. DONE (patches 5, 11).
6. Cheap Group E and F items: cancellation email DONE (patch 8), retention partly DONE (patch 6), DLQ runbook NOT done (docs), Redis password NOT done (platform side, needs External Secrets).
7. 6.A3 hold expiry race. DONE (patches 6, 7, 9, 10).
8. Group G proof on EKS, docs and known-risk write-up. Do not leave these to the end of Friday. **This is what is left.**

Flag once, then follow his call: the ticket says `point: 8` and the open work is far more than that. Either raise the points and announce the scope growth publicly, or move the items we will not finish into another ticket before closing ALPHA-81 (Saad's rule).

---

## 8. Build and test recipe

**Local stack.** `docker compose up -d --build`, then open `http://localhost:8080` (not 8086, the dashboard only works through the gateway). `SEED_DEMO_PRODUCTS=true` in compose seeds demo products. Login accepts any email. The dashboard uses `admin@platform.local`.

**Tests.** Tests sit beside the code. Integration tests skip (they do not fail) when their environment variable is missing, so read the output for "SKIP". Ahmed runs suites against a throwaway Postgres:

```
docker run -d --name pgtest -e POSTGRES_USER=app -e POSTGRES_PASSWORD=localdev -e POSTGRES_DB=test -p 5433:5432 postgres:16
cd services/<service>
TEST_DATABASE_URL='postgres://app:localdev@localhost:5433/test?sslmode=disable' go test ./... -race -count=1
```

Suites that exist: order-service (status, pricing, outbox), inventory-service, payment-service, notification-service (10 tests), shipping-service (11 tests), worker (handler tests with a fake services harness, plus a real-SQS test that needs `AWS_ENDPOINT_URL`), api-gateway (routing and rate limiter, limiter needs Redis). The scheduler has none. CI does not run `go test` for everything, so a green pipeline does not prove the logic.

**Test habits to keep.**

- Warm the pool before a concurrency test, otherwise the old buggy code passes.
- Close each test's pool (`t.Cleanup(db.Close)`), otherwise Postgres runs out of connection slots after about 10 tests.
- Do a mutation check for every fix: remove the fix, watch the test fail, put it back.
- Never trust a latency or success number without checking status codes.
- A test that passes where the database and the process share a time zone proves nothing about time. Run once with them different (`options=-c TimeZone=UTC` in the Postgres URL against a Go process in another zone).
- After `docker run -d postgres`, wait for it. Early connections get reset while the image initialises.

**Sandbox note.** If you work from a cloud shell with no Docker, you can run a local Postgres 16 as the `postgres` user in a scratch directory and point `TEST_DATABASE_URL` at it. Services with metrics need the metrics port stubbed, or run with `GOFLAGS=-mod=mod` and an offline module cache. Whatever you run there is a proposal until Ahmed runs it on his machine.

**Commands Ahmed needs from you** (give them exactly, do not run them):

```
git fetch origin
git switch -c alpha-81-<short-desc> origin/main
git add <exact files>
git commit -m "<type>(<scope>): <subject>"
git push -u origin alpha-81-<short-desc>
```

Never `git add -A` (his `docs/` and `docs.zip` are untracked on purpose). Never touch `go.mod` or `go.sum` in a hardening commit.

---

## 9. Docs to update once the work is done

Rule: update docs in the same step as the change, but do not polish them before building. Once a decision is made, build, then document. Repo docs stay lean: a root README, a short README per folder, inline comments on non-obvious settings. Decisions, trade-offs and history go in Plane. All of the repo docs below are local and untracked in Ahmed's clone; he moves them into the repo himself.

**Style for every doc** (the existing set is the model):

- Guide: first line "Describes: `main` as of <date> (<sha>)", the shape in brief with a "stop here" line, one example walked end to end, failure table (situation, reply, what happens), "Rules that must stay true", "Why it is built this way" with real numbers, "What we accepted", "How we know it works", reference, a "Next:" pointer.
- ADR: header with status, date and ticket and the decision in one line; Context; an options table with at least 3 options; Decision and Consequences; How we know it works; Revisit when; Sources (official docs linked, plus tickets and PRs).
- Plain English first, real numbers, no em dashes, no filler. Say "not deployed yet" or "not safe yet" in the open.

**Current docs describe `main` as of 3 Oct (`e300366`) and are stale in these ways:**

| Doc | What to change | Triggered by |
|---|---|---|
| `docs/app/README.md` | "Describes" line. Services table (notification-service says nothing is sent, shipping has no flow). "What changed" table: add the Sprint 3 and 4 rows with PR #63 and the ticket. "Not safe yet": remove client pricing, refunds not repeat-safe, "orders stop at confirmed"; keep or add what stays open (login, ownership, retention, and so on). | Groups A, B, E |
| `docs/app/order-flow.md` | Sequence now continues past `confirmed` (processing, shipped, delivered, cancel with refund). Rules: one shipment per order, email once per (order, status), refund by order and repeat-safe, price from inventory. Reference: reply codes (402 decline), `PUT /shipments/by-order/{id}`, `dedupe_key`, states table. If item 28 lands, the abandoned-order cancel now goes through `PUT /status`. If item 4 lands, add the idempotency key to the happy path and rules. | A, E |
| `docs/app/gateway-and-dashboard.md` | Routing table (internal routes refused, allow-list), `JWT_SECRET` required, dashboard order dropdown, XSS fix and the escape rule, Services tab, Redis password and the 21st login proof, what changed with Traefik if item 12 lands. | B, C, D |
| `docs/app/run-build-test.md` | `SEED_DEMO_PRODUCTS`, new env vars (scheduler `ORDER_SERVICE_URL`, Redis password), tests that now exist and their counts, a curl drill for the idempotency key (same key twice returns the same order), DLQ redrive runbook if item 23 lands, scheduler test. | A, F |
| `docs/app/adr/0002-safe-to-repeat-in-the-database.md` | Header says Idempotency-Key replay moved to ALPHA-81. Add a note: built for `POST /orders` (option B in the ADR, which endpoint, 24 h retention), and that refunds, shipments and emails use the same unique-index pattern. If `/charge` replay is not built, say so. | A |
| `docs/app/adr/0003-interim-gateway-rate-limiting.md` | Status and "Revisit when": Redis now runs on EKS, which items moved to Traefik or stayed in the gateway, small gaps fixed or accepted. | C |
| New ADR 0007 (check the next free number: 0001 to 0003 app, 0004 SQS, 0005 platform tools through ArgoCD, 0006 Redis) | Pricing from inventory: options (A inventory lookup in order-service, B check in the worker at reserve time), decision A, the 3 s timeout, 503 when inventory is down, the trade-off against the outbox goal in ADR 0001 (orders are no longer accepted while inventory is down). Ahmed writes it in his own words. | A |
| `docs/app/adr/0001-order-events-outbox.md` | One line in Consequences about the pricing trade-off, and payment and shipment events if item 21 lands. | A, E |
| `docs/sqs/order-events-queue.md` | New producers and consumers if events move to the outbox, the DLQ runbook and alert, the `order.status_changed` handlers, the abandoned-order cancel. | E, F |
| `docs/redis/redis-in-the-cluster.md` | Header says "branch `alpha-89-redis`, not merged, not deployed": it merged as PR #54 on 6 Oct. Add the password once built and the live check result. | C, G |
| `docs/app/gateway-and-dashboard.md` (added 7 Oct) | The gateway allow-list table (copy the rules from `services/api-gateway/allowlist.go`), 404 for everything else, whole-segment prefix matching, `.`/`..`/empty segments never forwarded. The dashboard: `esc()` rule, the Idempotency-Key it sends (and why it is built from `getRandomValues`: `crypto.randomUUID()` needs https and dev is http), no confirm button for pending orders. | B, D |
| `docs/app/order-flow.md` (added 7 Oct) | `POST /orders` requires `Idempotency-Key` (400 without, 200 replay with `Idempotent-Replayed: true`, 422 for the same key with a different body, 24 h). The cancel path now ends with the `order_cancelled` email. A hold that expired before the commit: inventory 409, worker holds again or cancels and refunds. The scheduler cancels through `PUT /status` with `expected_status`. | A, E |
| `docs/app/run-build-test.md` (added 7 Oct) | Curl drill: same key twice returns the same order, no key gives 400. The dashboard has no manual confirm for pending orders, so any drill that clicked it must wait for the worker instead. The scheduler, inventory, shipping, worker and gateway test counts. | A, D |
| `docs/app/adr/0002-safe-to-repeat-in-the-database.md` (added 7 Oct) | Idempotency key built for `POST /orders` only. Claim the key first, in the same transaction (no gaps in order ids). Replay is answered before pricing, so it works while inventory is down. | A |
| Plane ALPHA-81 | Tick deliverables as they merge, update points, post the scope-growth note publicly, move unfinished deliverables to another ticket before closing, link the PRs both ways. Keep: user story plus deliverables in the description, extras in comments. | all |
| Plane "Application docs" page | Links only to the repo docs, one line each. Update if a doc is added. | A |
| Team thread | Short status post per merged PR, and the scope-growth announcement. | all |

**Source-of-truth notes in the Claude project** (if the new chat has access): the hardening plan has statuses that say "built on branch", the hardening backlog and the fix evidence log are history, and the "ready patches" page records two commits that are now merged, so it can be deleted (Ahmed's call, never delete for him). Keep the plan's numbered items and decisions; update statuses only.

---

## 10. Known risks for the stakeholder Q&A (if not built by Fri)

Graders pick areas people did not work on, so everyone must be able to explain each of these. The answer format is: what can go wrong, why it waited, how we would fix it.

- Login accepts any email (5), no ownership checks (6), per-service DB logins (11), Redis password if not built (34), shipping webhook caller not authenticated (9).
- Money held as a float (30), timestamp columns still without a time zone (22: the cut-offs are now computed by the database, the columns are unchanged), retention of shipments and tracking events (17, 32: the other tables are pruned now).
- Rate limiting still in the gateway rather than Traefik (12), shared dashboard login (14), shared-IP login limit (15), small gaps (16).
- Payment and shipment events not on the outbox (21), events not de-duplicated by id (35c).
- Services tab lacks worker and scheduler health (33), no real shipping address (35a), the shipping webhook still has no caller secret (9), the gateway rate-limit gaps (16).
- Anyone logged in can still move any order's status through `PUT /api/orders/status` (it is on the allow-list because the dashboard uses it). This follows from items 5 and 6 (no real login, no roles) and is the honest answer if asked why the allow-list still contains it.
- The dashboard page has no Content-Security-Policy header. Output escaping fixes the hole; a CSP would be a second layer and is not built.
- Items 4, 19, 27, 28, 29 and 31 are built in the patch series. If they are not merged by Friday they join this list; for item 4 the answer is: payments cannot be charged twice for one order (unique index), a repeated order request creates a second order, and the fix is an idempotency key on order create (built, see 6.A2).

Defences worth knowing by heart:

- Fix first, harden later (24 Sep): a fix is anything that breaks the normal flow or leaves data wrong for honest users on a normal day; hardening only matters under attack, heavy load or a rare failure.
- Standard SQS not FIFO: the state machine already rejects out-of-order moves, FIFO does not remove duplicate handling, and one stuck message blocks a group.
- Fail open on the limiter: Redis holds disposable counters. Losing orders costs money; losing counters costs nothing, which is also why Postgres is on RDS and Redis has a disk only because the client's wording asks for it.
- RDS is locked. Upstream sources lean the other way, so the defence must be explicit if asked.

---

## 11. Starter prompt for the new chat

Paste this, then attach or link this file.

> I'm Ahmed, shadow leader of Team Alpha. Read the attached handover first, starting with the newest entry in section 13. The code for the ALPHA-81 app hardening is built and sits in one patch file; I will tell you whether `git am` worked and paste my test output. Help me check it, then we do the docs, the ADRs, the DLQ runbook and the EKS check (Group G). Follow the loop in section 2.1 and the hard limits in 2.2. Do not run git commands. Explain in plain English one concept at a time and tell me when you are unsure.

The new chat needs: repo access to `EKS-V2-Alpha-Team/Alpha-Pilot-4week`, the Plane connector (project id `7db53982-1974-414a-96aa-ce69357976d8`, ALPHA-81 work item id `e5bf704d-fc16-4bea-aea9-ecac252b244f`), and a way to run Go tests against Postgres.

---

## 12. Sources and what was checked

- GitHub, 7 Oct, built-in browser: PR #63 page (merged `28c526e`, 9 commits, approved by naima90), commits on `main`, open PR list (5).
- Plane, 7 Oct: ALPHA-81 description and point text, state list of work items.
- Local clone, 7 Oct: branch and status, the code searches in section 5, `docs/` contents and headings.
- Earlier work, carried over: idempotency research (Stripe, AWS Builders' Library, IETF draft), the live reproduction of the double order, the shipping and notification wiring tests (notification 10 tests, shipping 11 tests, worker handler tests), the plan of 35 items and its decisions.
- Official docs to read when building: [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests), [AWS Builders' Library, making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/), [IETF Idempotency-Key header draft](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header), [Postgres INSERT ... ON CONFLICT](https://www.postgresql.org/docs/16/sql-insert.html), [Traefik RateLimit middleware](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/ratelimit/), [Amazon SQS dead-letter queue redrive](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-dead-letter-queue-redrive.html).
- Not checked: ArgoCD sync state on the EKS dev cluster, the live EKS check, whether the dashboard calls any internal route that item 29 would block (read the page first), and the exact reply codes of every service for the new items.

---

## 13. Progress log (update this at the end of every working session)

### 7 Oct, late night: eleven more fixes built, packaged as one patch file (newest entry, read this first)

**What happened in this session, in order.**

1. Ahmed's second test run failed again. Cause: `services/scheduler/main.go` and `main_test.go` on his machine were the OLD versions (the pre-fix cutoff). Something put them back after I had written the fixed ones (a stash, a checkout or a pull are the usual suspects; I could not tell which). I wrote the fixed files again and checked their hashes on his machine (`cb98f2e9` and `e1bf5324` are the first 8 characters of the SHA-256). He was also running `cd services/order-service` from inside `services/scheduler`, so the order-service suite never ran. Rule for the rest of the work: run everything from the repo root, and after any `git stash`, `switch` or `pull`, run `git status` and re-check that the files you expect are there.
2. I built the rest of the Group A, B, D, E, F code fixes listed below in a scratch copy, tested each one in a sandbox Postgres (and Redis for the gateway), and packaged them as 11 commits.

**How to apply (Ahmed runs it).** The 11 commits are in `Claude outputs/alpha-81-final.mbox` (an old, stale copy named `IGNORE-old-alpha-81-series.mbox` sits beside it; delete it). I checked that `git am` applies all 11 cleanly, with no warnings, onto a clone of `origin/main` (`90ad23c`) plus item 28 committed. It will not apply on top of uncommitted item 28 changes, so commit item 28 first. From the repo root, in PowerShell:

```
git status
# item 28 first (two commits, as in the earlier entry below), then:
git am "Claude outputs/alpha-81-final.mbox"
git log --oneline -13
```

If `git am` stops with an error, run `git am --abort` and paste the message. The commits are authored as Ahmed, carry no Claude attribution, and each has a subject and a short why in the body. He can reword any of them with `git commit --amend` / `git rebase -i` before pushing. Suggested: one branch and one PR for the whole series (PR #63 had 9 commits), title `fix(app): idempotent orders, gateway allow-list, XSS, safe stock holds and cancel emails (ALPHA-81)`.

**The 11 commits (patch number, what it does, how it was checked).** All checks are in the cloud sandbox (Postgres 16, a real Redis for the gateway, a real Chromium for the dashboard). Every service was also run with the Go process in a different time zone from the database. Whatever the sandbox shows is a proposal until Ahmed's own run is green.

| # | Commit | What changed | Evidence |
|---|---|---|---|
| 1 | `feat(order-service): require an Idempotency-Key on POST /orders` | New `idempotency.go` and table `idempotency_keys` (primary key `(customer_id, key)`, request hash, order id, `TIMESTAMPTZ`). Header required, 400 without it or over 255 characters. The key is claimed first inside the order transaction (`INSERT ... ON CONFLICT DO NOTHING`; if 0 rows, roll back and answer from the stored row), so retries leave no gaps in order ids. Replay is answered before pricing, so it works while inventory is down. Same key and same request: 200 with the original order and `Idempotent-Replayed: true`. Same key, different request: 422. A failed first attempt leaves no key behind. Keys are per customer. | 8 new tests incl. 10 simultaneous identical requests x 20 rounds = exactly one 201, one order, one `order.created` event; 4 mutation checks each fail the right test; `-race` x4. Existing tests send a unique key through `postOrder`. |
| 2 | `feat(dashboard-api): send an Idempotency-Key when placing an order` | Fresh key per order, the same key is reused if the same order is clicked again after no clear answer (timeout, 5xx), a new one after a clear answer; Place Order button disabled while the request runs. Key built from `crypto.getRandomValues` because `crypto.randomUUID()` needs https and dev is http only. | Node harness with a stub `fetch`: reuse after network error, new key after success and after a 400, button disabled and re-enabled. |
| 3 | `fix(shipping-service): only accept in_transit and delivered on the carrier webhook` | The public webhook now needs a tracking number and a status of `in_transit` or `delivered` (400 otherwise, 404 for an unknown number), and goes through the same forward-only, repeat-safe code as the worker (`moveShipmentByOrder`, split out of the by-order handler). Before: any status text was written to the shipment and published as `shipment.<anything>`, and database errors were ignored. The response body is now the shipment-move result (`shipment_id`, `tracking_number`, `status`, `changed`) instead of `{"status":"accepted"}`; nothing in the repo reads it. | 4 new tests; 2 mutation checks. |
| 4 | `fix(api-gateway): only forward the routes meant for the outside world` | New `allowlist.go`: per service, a list of method + path rules (the dashboard's calls plus the services' own read routes). Everything else is a 404 at the gateway: `/charge`, `/refund`, `/reserve`, `/release`, `/commit`, `/restock`, `/send`, `POST /shipments`, `PUT /shipments/by-order/...`. Prefixes now match whole path segments; `.`, `..` and empty segments are never forwarded. Public paths and the 20/min limit on the webhook are unchanged. The worker is unaffected (it calls the services directly). `PUT /api/orders/status` stays exposed because the dashboard uses it. | 5 new tests incl. every dashboard call still forwarded and every internal route blocked with a request counter proving none reached a service; mutation checks; the full gateway suite (20 tests) with a real Redis. |
| 5 | `fix(dashboard-api): escape API data before it goes into the page` | `esc()` helper, applied to every value that comes from the API and goes into `innerHTML`; ids in `onclick` forced to numbers. | Chromium with hostile data in every table (script in `Claude outputs/dashboard-xss-check.js`): before, 3 injected scripts ran and 31 injected `<img>` tags existed; after, 0 and 0, the markup shows as text. |
| 6 | `fix(scheduler): give expired stock back once, prune old rows, count time in the database` | `expireReservation` claims one hold (active to expired) and returns the stock in the same transaction only if the claim changed a row, so a hold committed at the instant it expires is not given back twice. New `retention.go`: order events 90 days, sent outbox rows 7 days (an unsent row is never deleted), idempotency keys 24 hours, notifications 90 days; a missing table is logged and the other rules still run. The failed-payment window and the digest's "today" are computed by Postgres. | 6 new tests incl. commit racing expiry 40 times (never reserved down twice); 4 mutation checks. |
| 7 | `fix(inventory-service): time a stock hold with the database clock` | Hold end = `NOW() + 15 minutes` in SQL (`RETURNING expires_at`). Before, the Go clock's wall time was written into a `TIMESTAMP` column the scheduler compares with `NOW()`: a service west of the database made holds expire at once. | 1 new test with the service in UTC-8, UTC+13 and UTC; the old code fails with -645 / +615 minutes. |
| 8 | `feat(worker): email the customer when an order is cancelled` | `order_cancelled` template in notification-service. The worker sends it as the last step of the cancel handling, once per order (dedupe key `order_cancelled:<id>`). Not best effort: a failure returns an error and SQS redelivers; the earlier steps are repeat-safe. A declined order now gets two emails (payment failed, then cancelled): kept on purpose, say so if asked. | 3 new worker tests, 1 notification test that starts from a database without the template. |
| 9 | `fix(worker): take the stock again when the hold expired before the commit` | If inventory answers 409 to `/commit` for an order that is already paid, the worker holds the stock again and commits; if the stock is gone it cancels the order (the cancel handling refunds it). Also covers a redelivered or redriven message for a confirmed order. | 4 new tests; 1 mutation check. |
| 10 | `fix(inventory-service): refuse to commit an order that has no active hold` | `/commit` answers 409 unless the order was already committed (a repeat is still 200). Before it answered 200 "committed 0" for an expired hold, so a paid order could finish without the stock leaving the shelf. **Deploy after patch 9 reaches the cluster** (same PR and one CI run is fine; the window is minutes and the only effect of the wrong order is a few messages retrying). | 4 new tests incl. 20 simultaneous commits all 200; 2 mutation checks. |
| 11 | `fix(dashboard-api): remove the confirm button that skipped payment` | No pending to confirmed button (the worker confirms after the charge). Cancel stays. | XSS script still clean. |

**Things Ahmed should know before the Q&A (my choices, his to overrule).**

- The key is required. Every other caller of `POST /orders` must send one. **The k6 load scripts (ALPHA-80) must send a unique `Idempotency-Key` per request**; reusing one key returns the same order and the test measures nothing. They were not in the repo, so I could not check them.
- The first request creates (201), a replay returns 200 with the order's current status, not a frozen copy of the first answer.
- Retention numbers (outbox 7 days, idempotency keys 24 hours, notifications 90 days) are my picks. The ticket asked to "agree a retention"; change them in `services/scheduler/retention.go`.
- A paid order whose stock is gone is cancelled and refunded (patch 9). The alternative is to keep it and back-order; that is a business call.
- Lint: `golangci-lint` with its default linters reports only the unchecked-error pattern (`Encode`, `Close`, `Rollback`) that the existing code already has everywhere, plus one old `ineffassign` in `listOrders`. Nothing new in kind.

**Run every suite before pushing (Ahmed, from the repo root, PowerShell; same throwaway Postgres as before, all suites share it and truncate their own tables, so run them one after another).**

```
$env:TEST_DATABASE_URL="postgres://app:app@localhost:5544/test?sslmode=disable"
cd services/order-service;        go test ./... -race -count=1; cd ../..
cd services/scheduler;            go test ./... -race -count=1; cd ../..
cd services/inventory-service;    go test ./... -race -count=1; cd ../..
cd services/shipping-service;     go test ./... -race -count=1; cd ../..
cd services/notification-service; go test ./... -race -count=1; cd ../..
cd services/worker;               go test ./... -race -count=1; cd ../..
docker run -d --name redistest -p 6390:6379 redis:7
$env:TEST_REDIS_URL="redis://localhost:6390/15"
cd services/api-gateway;          go test ./... -race -count=1; cd ../..
```

New tests per package: order-service 8 (idempotency), scheduler 6 (housekeeping) on top of the 7 from item 28, inventory 5, shipping 4, notification 1, worker 7, gateway 5. Read the output for "SKIP": a skipped database test is not a pass. If one fails, paste the output; do not edit the code.

**Local drill for the idempotency key (compose up, through the gateway; local data only).**

1. Log in and keep the token: `curl -s -X POST http://localhost:8080/auth/login -H "Content-Type: application/json" -d "{\"email\":\"sara@example.com\",\"password\":\"x\"}"`.
2. Place the same order twice with one key, then once with another: the first answer is 201, the second is 200 with the same id (header `Idempotent-Replayed: true`), the third is 201 with a new id. Without the header: 400.
3. `SELECT count(*) FROM orders` grew by 2, not 3.

**Not built, and why (all go in the known-risk write-up).** Redis password (needs a secret through External Secrets: platform side); the shipping webhook caller secret (same); real login and ownership checks (items 5 and 6, multi-day); per-service database logins (11); payment and shipment events through the outbox (21); event-id de-duplication (35c); Services tab for worker and scheduler health (33); a real shipping address (35a); money as a decimal in Go (30); rate-limit gaps in the gateway (16, including the `ip:port` in `X-Forwarded-For`); shipments retention; the DLQ runbook and alert (docs and platform); a Content-Security-Policy header on the dashboard (second layer after escaping).

**What is left for Ahmed (in this order).** 1. Commit item 28, run `git am`, run all suites, push, open the PR. 2. Post the scope-growth thread and settle ALPHA-81's points (it says 8 and the real work is several times that). 3. Docs: section 9, including the new rows for the gateway, the order flow, `run-build-test.md` and ADR 0002; ADR 0007 for the pricing trade-off in his own words; write the DLQ runbook. 4. Group G: the EKS dev check through the dashboard (place, confirm by the worker, ship, deliver, cancel with refund; 22 logins from one IP in a minute give 20 x 200 and 2 x 429). 5. The known-risk write-up from section 10 and the list above.

**Starter note for a new chat.** Start from this entry, not from item 28. First ask Ahmed whether `git am` succeeded and what his test runs printed. Do not rebuild anything that is in the table above.

### 7 Oct, evening (earlier entry): item 28 built, tested, not yet committed

**State when this session stopped.** Four files changed in Ahmed's working tree on the stale branch `alpha-81-app-hardening` (identical to merged PR #63, so nothing else differs). Nothing is committed, pushed or deployed. Plane is not updated (nothing to tick until it merges).

| File | Change |
|---|---|
| `services/order-service/main.go` | `PUT /status` accepts optional `expected_status`. If set and different from the order's current status, answer 409 `order is X, expected Y`. Checked after the "same status again is a repeat" rule, before the transition rules. |
| `services/order-service/status_test.go` | Three new tests: expected status stops a change to an order that moved on (confirmed order, cancel expecting pending gives 409, no cancel event); matching expected status is applied; an already cancelled order is still a 200 repeat. |
| `services/scheduler/main.go` | `detectAbandonedOrders` now calls `cancelAbandonedOrders(client, baseURL, age)`. It selects pending ids older than `age` (oldest first, `LIMIT 100`; the age is worked out by the database, `created_at < NOW() - make_interval(secs => $1)`, see the time zone finding below), closes the rows, then for each id sends `PUT {ORDER_SERVICE_URL}/status` with `{order_id, new_status: "cancelled", expected_status: "pending"}`. 200 with `changed:true` counts, 200 with `changed:false` does not, 409 or 404 skips that order, a transport error or 5xx stops the run (next run retries). The scheduler no longer writes to `orders`. `ORDER_SERVICE_URL` defaults to `http://order-service:8081`, same as the worker, so compose and the Helm chart need no change (assumption for EKS: the chart's service DNS matches the code defaults, per a comment in `_helpers.tpl`; confirm on dev). |
| `services/scheduler/main_test.go` (new) | Seven tests with a fake order-service and a real Postgres (the seventh checks the age against databases in three different time zones): cancels only old pending orders through the API and never writes the table, 409 skips and carries on, already cancelled not counted, 503 stops the run, unreachable server cancels nothing, batch capped at 100. Skips without `TEST_DATABASE_URL`. |

**Evidence (cloud sandbox, Postgres 16, metrics stubbed because the sandbox cannot download the Prometheus modules; Ahmed's run is the real one).**

- order-service full suite: pass with `-race`, 3 new tests included.
- scheduler suite: 7 tests pass with `-race`, repeated runs, with the Go process at UTC and at UTC+3 and the database session in Qatar, UTC and Los Angeles time.
- Mutation 1, scheduler writes `orders` itself again: two scheduler tests fail.
- Mutation 2, `expected_status` removed from the request: the scheduler test fails.
- Mutation 4, the Go-side cutoff put back: the new time zone test and the main cancel test fail.
- Mutation 3, the order-service guard disabled: the stale-cancel test fails with 200 instead of 409.
- End to end, scheduler code against the real order-service handler and a real database: the old pending order became `cancelled`, `order_events` got `pending->cancelled`, `order_outbox` got `order.status_changed` with `new_status` `cancelled`; a stale cancel of a confirmed order got 409 and the order stayed `confirmed`.
- Not run: anything in Ahmed's compose stack or on EKS, and the worker acting on the cancel event (the worker's cancel handling is already covered by its own tests).

**Found on Ahmed's machine, fixed (item 22 is real outside containers).** His first test run failed: a 1 minute old order was cancelled along with the old one (`cancelled: got 2, want 1`). Cause: `orders.created_at` is a `TIMESTAMP` without a time zone, written by the database's `NOW()` (UTC in his Docker Postgres). The first version passed a Go `time.Now().Add(-30m)` as the cutoff. Postgres drops the zone from that value and compares bare wall clocks, so a laptop in UTC+3 against a UTC database was 3 hours off, and every order younger than 3 hours looked abandoned. My sandbox missed it because its Postgres and its Go process shared one time zone. Reproduced afterwards with a Go process at UTC+3 against a UTC database (old code fails exactly as his did, new code passes), against Los Angeles and Auckland sessions, and with the Go-side cutoff put back as a mutation (the new zone test fails). In production the containers and RDS all run UTC, so this would not have fired there, but the cancel was one wrong cutoff away from cancelling live orders on any machine in another zone. The fix: let the database compute the age (`NOW() - make_interval(...)`), which uses the same clock and zone that wrote `created_at`.

Same class, not fixed (item 22, left as a known risk): `cleanupOldEvents` (`created_at < $1` with a Go cutoff, 90 days, so harmless) and `retryFailedPayments` (only logs). The lesson for the Q&A: item 22 was written off as "cannot trigger, everything is UTC", and a developer laptop proved it wrong in one test run.

**What Ahmed does next (exact commands, he runs them).**

```
git fetch origin
git switch -c alpha-81-scheduler-cancel origin/main
```

If git refuses to switch because of local changes, run `git stash push -u -- services/scheduler services/order-service`, then the switch, then `git stash pop`. Then run the tests against a throwaway database (they truncate `orders`):

```
docker rm -f pgtest
docker run -d --name pgtest -e POSTGRES_USER=app -e POSTGRES_PASSWORD=localdev -e POSTGRES_DB=test -p 5433:5432 postgres:16
# wait: the image restarts Postgres once while it initialises, and tests started too early get "connection reset by peer"
sleep 8; docker exec pgtest pg_isready -U app -d test
cd services/order-service
TEST_DATABASE_URL='postgres://app:localdev@localhost:5433/test?sslmode=disable' go test ./... -race -count=1
cd ../scheduler
TEST_DATABASE_URL='postgres://app:localdev@localhost:5433/test?sslmode=disable' go test ./... -race -count=1
```

Two commits, order-service first because the scheduler depends on it:

```
git add services/order-service/main.go services/order-service/status_test.go
git commit -m "feat(order-service): refuse a status change when the order has moved on"
git add services/scheduler/main.go services/scheduler/main_test.go
git commit -m "fix(scheduler): cancel abandoned orders through order-service"
```

Commit body for the second one, if he wants it: "The scheduler cancelled with a raw UPDATE: no status check, no event, so no refund and no restock. It now asks order-service, which owns the status rules." No Claude attribution lines.

**Live drill on compose after the commits** (local data only; it changes rows in the local database and nothing else):

1. `docker compose up -d --build order-service scheduler worker`, then `docker compose stop worker` so the order stays pending.
2. Place an order on `http://localhost:8080` (note its id, say 42). It stays `pending` and its stock is held.
3. Age it: `docker compose exec postgres psql -U <user> -d orders -c "UPDATE orders SET created_at = NOW() - interval '31 minutes' WHERE id = 42"` (use the compose database credentials; do not paste them into chat).
4. `docker compose restart scheduler` (it runs every job on start). Expect the scheduler log "Cancelled abandoned order #42".
5. Check the order is `cancelled`, `order_events` has `pending->cancelled`, and `order_outbox` has an `order.status_changed` row.
6. `docker compose start worker`. It should log "order 42 cancelled, giving back stock and money", and the product's `reserved` goes back down.

**PR (Ahmed's words, draft only).** Title `fix(scheduler): cancel abandoned orders through order-service (ALPHA-81)`. Body: one or two lines saying abandoned orders are now cancelled through order-service so the refund and restock happen, plus the ticket link. No testing section.

**ADR note for later.** Nothing new needs an ADR. Update `docs/app/order-flow.md` (the abandoned-order path and the `expected_status` rule) when the PR merges.

**Open question for Ahmed.** `expected_status` is a small addition to order-service beyond the ticket text. It closes the race the ticket itself describes. If he would rather not touch order-service, drop the first commit and the `expected_status` line in the scheduler, and say in the Q&A that the race window is a few milliseconds and ends in a consistent refund.

**Next item.** 6.A2, the idempotency key on `POST /orders`. Everything for it is decided in section 6.A2, so the new chat can start by reading `createOrder` in `services/order-service/main.go` and writing the concurrency test first. Branch from fresh `main` after the scheduler PR is merged or, if that is slow, from `main` and rebase later (both touch `services/order-service/main.go`, so expect a small conflict near `handleUpdateStatus` versus `createOrder`: they are different functions, so it should merge cleanly).
