# Fix evidence log (Sprint 2, app fixes)

Every number below was measured, not estimated. "Local" = Ahmed's docker compose stack. "Sandbox" = Claude's Postgres 16 test environment. Use these in PR evidence sections, ADRs and the stakeholder Q&A.

## First end-to-end order (local, 24 Sep 23:20, local-only branch merging ALPHA-44 + ALPHA-51 + ALPHA-45)
- `POST` order 1 (2 × mug-1, £20) → `201 pending`. Worker picked up `order.created` about 5 s later → reserve → charge → confirm → message deleted. Order 1 ended **`confirmed`**, `reserved = 2`.
- `stock` stayed 5: expected, stock commit is ALPHA-77.
- The worker also received the follow-up `order.status_changed` event and skipped it (no handler yet, ALPHA-78), so it didn't go to the DLQ.
- Startup: the worker's first receive failed with `NonExistentQueue` because it started before Floci's init script created the queue; the next poll 5 s later worked. Harmless locally; compose `depends_on` waits for the container to start, not for the queue to exist.
- Before these fixes every order stayed `pending` forever (worker never read the queue).

### Failure paths (local, 24 Sep 23:23–23:29) — all three outcomes proven live
- **Out of stock:** order 2 (10 × mug-1, only 3 available) → worker log "order 2: not enough stock, cancelling" → order 2 **`cancelled`**, payment never called.
- **Payment outage:** payment-service stopped, order 3 placed → worker logged **3** "Failed to handle" (one per receive, 60 s visibility timeout apart), then the message landed in `order-events-dlq` (**ApproximateNumberOfMessages 1**). Order 3 stayed `pending` with its stock held.
- **Recovery by DLQ redrive:** payment-service restarted, then `aws sqs start-message-move-task --source-arn …order-events-dlq` (works on Floci; AWS equivalent is the same API or the console "Start DLQ redrive"). Within 10 s the worker re-processed order 3. Operational fix, no code change: every step is safe to repeat, so a redriven message can't double-charge.
- **Card declined:** on that retry the simulated provider declined order 3 (it fails ~1 in 10 at random) → worker log "order 3: payment declined, releasing stock and cancelling" → payment row `failed` £10, reservation **`released`**, order 3 **`cancelled`**.

## ALPHA-48 Dashboard through the gateway (branch `alpha-48-dashboard-gateway-routing`, commit `a8ea851`)
- Before (inspection 23 Sep): dashboard opened on dashboard-api `:8086` → every `/api/*` and `/auth/*` call 404; only `/healthz` and `/dashboard/healthz` answered, so only 2 service dots green.
- Before, first load through `:8080` (local, 25 Sep): `/auth/login` 200, but the 6 data calls fired before it returned → **6 × 401**, tables empty until the next refresh. A token kept in localStorage was reused forever, so after its 24 h expiry every call 401s until storage is cleared.
- After, headless browser against a stub gateway with a 0.8 s login: old page **7 of 7** data calls rejected (fresh load and expired stored token); new page **0 of 7**.
- After, live through `:8080` (local, 25 Sep): order 8 placed from the page → `confirmed` in under 5 s, mug stock 3 → 2; order 7 hit the simulated 10% card decline → stock released, cancelled; product `tee-1` added from the Inventory tab; all 7 service dots green.
- Gateway routing tests: 5 new (page served without token, `/dashboard/*` keeps its path, data needs a token, other routes still strip their prefix, unknown path 404); pass alongside ALPHA-73's 10 when merged.
- Refresh 10 s → 30 s: 8 data calls per refresh = 48/min per tab at 10 s (3 tabs = 144/min, over the shared 120/min per-user limit) → 16/min per tab at 30 s (7 tabs fit).

## ALPHA-77 Commit stock on confirm (branch `alpha-77-commit-stock-on-confirm` on top of ALPHA-51; worker call on `alpha-45`)
- Live (local, 24 Sep 23:43): order 4 (2 × mug-1) → `stock` **5 → 3**, `reserved` 0, reservation **`committed`**.
- Order 1's earlier hold of 2 had already been expired by the scheduler and returned to sale before this fix landed — the exact bug ALPHA-77 closes.
- Sandbox: 9 inventory tests pass, 5 runs in a row with `-race` (commit 5 → 3, commit twice → still 3, 20 concurrent commits → still 3, reserve after the sale holds nothing). Mutation: dropping `committed` from reserve's "already done" check makes the repeat reserve hold stock again (test fails with 201). Worker: 8 tests pass (adds commit failure → message kept).

## ALPHA-45 Worker SQS consumer (branch `alpha-45-worker-sqs-consumer`, commit `30e71fc`)
- 7 handler tests pass (local and sandbox, `-race` in sandbox): happy path, repeat delivery, out of stock → cancel without charging, card declined → release + cancel, payment 500 → message kept, inventory unreachable → message kept, events without a handler skipped.
- Real-SQS test (receive → delete → queue empty) passed in the sandbox against a local SQS API.

## ALPHA-73 Gateway rate limiting (branch `alpha-73-gateway-rate-limiting`, PR #25)

| Test | Before (`main`) | After |
|---|---|---|
| 22 × `POST /auth/login` from one client (local, 24 Sep) | 22 × 200 — login had no rate limiting at all | 20 × 200, then 429, 429 |
| `gateway_rate_limit_decisions_total` after that run | metric didn't exist | `{scope="sensitive",result="allowed"} 20`, `{result="limited"} 2` |
| Inspection 23 Sep, old limiter | 150 separate requests → 150 × 200 (counted per ip:port); rotating `X-Forwarded-For` → 150 × 200 | 10 tests covering R1–R7 pass |

## ALPHA-51 Idempotent worker operations (branch `alpha-51-idempotent-worker-ops`)

### Reproduced bugs (before)
- Order status: concurrent confirm + cancel both succeeded in **25 of 30** runs (sandbox, 23 Sep).
- Release: two overlapping releases took `reserved` **3 → −3** (sandbox, 23 Sep).
- Charge: 6 `POST /charge` for order 9001 → **6 payment rows, 5 completed** (local, 24 Sep).

### Inventory reserve/release — commit `9d1e7f7`
| Test (sandbox, Postgres 16) | Old code | New code |
|---|---|---|
| Reserve the same order twice | stock held twice | held once (201 then 200) |
| 10 concurrent reserves, same order | `reserved = 5` | `reserved = 1` |
| 20 concurrent releases, same order (started at 3) | **`reserved = −57`** | `reserved = 0` |
| Full suite | 3 of 5 tests fail | 5/5 pass, 20 runs in a row with `-race` |

Local (Ahmed, 24 Sep): 5/5 tests pass; migration created the unique index on real local data; live check `/reserve` order 777 twice → **201, 200**, `reserved = 2`, both responses carry the same `expires_at` (proves the repeat returned the existing reservation).

### Payment charge — committed 24 Sep
Rule: an already-paid order is never charged again. Matching repeat (same customer, amount, currency) → 200 + existing payment ID + `already_paid: true`; different details → 409 + existing payment ID.

| Test | Result |
|---|---|
| Suite (sandbox) | 6/6 pass, 10 runs in a row with `-race` |
| Mutation: unique index removed | 20 concurrent charges → **20 completed charges** (index is what stops it) |
| Mutation: index doesn't exclude refunds | every refund fails with **500** (refund rows are stored as `status='completed'`, `method='refund'`) |
| Local suite (Ahmed, 24 Sep) | 6/6 pass |
| Live, order 9101: £10, £10, £5 | **201**, **200** `already_paid: true` (same payment ID), **409** "order already paid with different details" |

### Test-writing lessons (worth repeating to the team)
- A concurrency test proves nothing until the connection pool is warm: with one open connection the first goroutine finished before the others connected, and the old buggy code passed. Warming 20 connections made the old code fail (−57).
- Tests that open a new pool per test without closing it exhausted Postgres connection slots after ~10 runs ("remaining connection slots are reserved") — the same per-pool connection budget issue measured in the capacity work.

### Order status changes — commit `cb5f19a` (26 Sep, rebased onto `alpha-44`)
Rule: only one of two simultaneous status changes wins; asking for the status the order already has returns 200 `changed: false` and writes nothing.

| Test | Result |
|---|---|
| Suite (sandbox) | 4/4 pass, 5 runs in a row with `-race` |
| Old code | fails 3 of 4 (repeat confirm gave 409; confirm and cancel both won) |
| Mutation: `AND status = $3` removed | race test fails |
| Mutation: same-status check removed | repeat test fails |

Branch note: `alpha-51` was rebased onto `alpha-44` because the status handler it edits was rewritten in #23. Inventory and payment trees checked identical to the old branch. `alpha-77` rebased on top (`ed7a8d2`).

### Worker status check — commit `f507ac3` on `alpha-45` (26 Sep)
Rule: before any step the worker reads the order's status. `pending` runs the flow, `cancelled` only releases, `confirmed` or later only commits.

| Test | Result |
|---|---|
| Worker suite (sandbox) | 12/12 pass with `-race` (4 new) |
| New: redelivery after confirm | only `/commit` is called |
| New: redelivery after cancel | only `/release` is called, no charge |
| New: order-service 503 on the check | message kept |
| New: release fails | message kept |
| Mutation: status check removed | 3 tests fail |

## ALPHA-74 DB pool metrics (branch `alpha-74-db-pool-metrics`, PR #24)
- 600 reservations, 60 at a time, straight to inventory-service (local, 24 Sep): all on one product → ~570 of 600 waited for a DB connection every run (≈95–408 s total wait); spread over 60 products → 0 waited. Row counts confirmed every request succeeded (1,800 spread + 2,400 hot reservations).
- `max_idle_closed_total` reached 194 under bursts (MaxIdleConns 5 vs MaxOpenConns 25 → connection churn).
- Environment facts: `max_connections` 100, 3 reserved for superusers; app role `app` is a full superuser (least-privilege issue for hardening).

## ALPHA-44 Order events outbox (branch `alpha-44-order-events-outbox`, PR #23)
- 8 tests pass with `-race`; removing `SKIP LOCKED`, moving the order insert outside the transaction, or not marking rows sent each makes a test fail.
- End to end with Floci: order created → message on `order-events`; Floci stopped → order still 201, event waits with attempts/last_error; Floci restarted → delivered. Redelivery verified 23 Sep: same message received 3 times, then moved to the DLQ (`maxReceiveCount 3`).
