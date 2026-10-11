# App hardening plan

Ticket: ALPHA-81 App hardening. Planned for the last week of the simulation.

**What this is.** The list of application problems we knowingly left for later, what each one risks, and what "done" means for it.

**Why they waited.** In Sprint 2 we fixed first and hardened later. A fix is anything that breaks the normal flow or leaves data wrong for honest users on a normal day. Hardening is anything that only breaks under attack, heavy load, or a rare failure. Everything below works today for normal use.

**What to do first.** The cheap items that remove a large risk: 8, 10, 18 and 24. After that, work down Group 2 as far as the week allows. Whatever is left becomes a documented, known risk for the stakeholder Q&A.

Items 1 and 2 were ready before hardening started, so they were committed as fixes on 26 Sep (PR #31 and PR #33). They stay listed so the numbering doesn't change.

---

## Group 1. Finish correctness

| # | Problem | What can go wrong | Done when | Status |
|---|---|---|---|---|
| 1 | Order status changes aren't safe to repeat or to race. Moved here from ALPHA-51. | A redelivered message asking for `confirmed` again gets a 409, so the message ends up in the DLQ. Confirm and cancel at the same moment can both succeed (25 of 30 runs in a test). | Same status again returns 200 and writes nothing; only one of two racing changes wins | Done in PR #31 (ALPHA-51) |
| 2 | The worker redoes every step when a message comes back after the order was already finished | If the stock commit fails once after the confirm, the retry hits item 1's 409, the commit never runs, and 15 minutes later the sold items go back on sale. If a message comes back after a cancel (a failed delete or a crash), the worker can hold the stock and charge the card again for a cancelled order. | The worker checks the order's status first: `pending` runs the flow, `cancelled` only releases, `confirmed` or later only commits | Done in PR #33 (ALPHA-45) |
| 3 | Refunds aren't safe to repeat or to run twice at once | A repeated cancel could refund twice | Same protection as charges | Needs design. Only reachable once cancellations trigger refunds (ALPHA-78). |
| 4 | Charge replay with an Idempotency-Key. Moved here from ALPHA-51. | Today a repeat of a successful charge is safe, but a repeat of a failed one isn't replayed exactly | `/charge` saves and replays the first result per key; the same key with different details gets 422 | Design agreed 24 Sep (Stripe and IETF draft pattern) |

## Group 2. Security and identity (bigger, pick by value)

| # | Problem | Risk | Done when | Ticket |
|---|---|---|---|---|
| 5 | Login accepts any email and password; there is no user store | Anyone can be anyone | Real users with hashed passwords | New |
| 6 | Any logged-in user can read or change any order, create products, refund any payment, read the full ledger | Data exposure, fraud | Checks on who owns what; admin-only routes | ALPHA-46 |
| 7 | The order total and quantities come from the request | A customer can set their own price, or a negative quantity | Prices looked up server-side; quantities validated | ALPHA-50 |
| 8 | Product create accepts negative prices (found during ALPHA-48) | Bad catalogue data | Validation on create | New |
| 9 | The shipping webhook has no authentication | Anyone can mark shipments delivered | Signed or secret-checked webhook | ALPHA-49 |
| 10 | The JWT secret has a hard-coded fallback | Tokens can be forged if the variable is ever missing | No fallback: the secret comes from Secrets Manager, and the gateway refuses to start without it | Overlaps with the secrets work |
| 11 | The Postgres app role is a full superuser | One bug means full database control; fails least-privilege for PCI | One role per service, only the grants it needs | New |

## Group 3. Rate limiting (after Traefik is running)

The design and its limits are in ADR 0003.

| # | Problem | Done when |
|---|---|---|
| 12 | Per-IP limits live only in the gateway | Per-IP limits in Traefik's RateLimit middleware, sharing counters in Redis |
| 13 | `TRUSTED_PROXY_CIDRS` is empty | It lists Traefik's addresses, or every request looks like it comes from Traefik |
| 14 | All dashboard tabs share one admin login and one limit (mitigated with a 30 s refresh) | The dashboard has its own identity and limit |
| 15 | Many shoppers behind one office or mobile IP share the login limit of 20 per minute | Limit reviewed against the `limited` metric from load tests |
| 16 | Small gaps: `X-Forwarded-For` is set to `ip:port` when forwarding; invalid tokens aren't counted; the "limited" log line isn't throttled | Each fixed or accepted in writing |

## Group 4. Data and operations

| # | Problem | Risk | Done when |
|---|---|---|---|
| 17 | Sent outbox rows are never deleted, and their payload holds the customer email | Table growth; data kept longer than needed | Cleanup job with an agreed retention |
| 18 | The scheduler runs every job in every copy | Two replicas double-expire holds and double-cancel orders | Pinned to 1 replica on EKS (quick), or leader election (proper) |
| 19 | Hold expiry can race with release or commit at the 15-minute mark (hidden by `GREATEST(..., 0)`) | `reserved` drifts | Expiry uses the same claim-then-act pattern as release |
| 20 | The ledger doesn't balance after a refund (one credit row, no debit) | Wrong reports | Refund writes both sides |
| 21 | payment-service and shipping-service still only log their events | Events lost once something consumes them | Same outbox pattern as order-service (ADR 0001) |
| 22 | Timezone mix: `TIMESTAMP` columns against process-local time | Wrong expiry times outside UTC | `TIMESTAMPTZ` everywhere (can't trigger in our containers, which all run UTC) |
| 23 | DLQ redrive is a manual step with no runbook | Stuck orders stay stuck | Runbook, plus an alert when the DLQ isn't empty |
| 24 | SQS in Terraform must match what the app expects | A 30 s default visibility timeout would cause duplicate work | Visibility timeout of 60 s or more, `maxReceiveCount` 3, DLQ retention longer than the queue's (infra SQS module) |

---

## Not in this ticket

- Shipping, delivery and notification handlers, refunds on cancel, and de-duplication by event ID: ALPHA-78.
- Pool sizes, PgBouncer and load tests: ALPHA-80.
- CI running `go test`: pipeline work, owned by whoever owns the CI pipeline.

## How to pick for the last week

1. The items that are cheap and remove a large risk: 8 (validation), 10 (no JWT fallback), 18 (1 scheduler replica) and 24 (SQS settings, together with the infra work).
2. Then 7, 6 and 9, in that order, if there's time. Item 5 (real login) is days of work on its own. If it doesn't fit, say so plainly in the Q&A along with how we'd do it.

Everything not done by the end stays on this list as a known risk, with the reason it waited.
