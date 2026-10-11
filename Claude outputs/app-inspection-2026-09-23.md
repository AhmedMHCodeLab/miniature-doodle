# EKS v2 app inspection: 23 Sep 2026

Scope: all 9 services on Ahmed's `alpha-56-app-dockerisation` checkout (3,076 lines of Go), checked against the six App Issues in Notion. Every service was built from source and run against Postgres 16 + Redis 7 in a sandbox, and each runtime claim below was reproduced there. Labels: **Verified (runtime)** means reproduced by running it, **Verified (code)** means read at the line cited, **Assumption** means inferred and not tested, **Open** means it needs a decision or a docs check.

Line numbers refer to `services/<svc>/main.go` on this branch.

---

## 1. Corrections to the six App Issues already in Notion

| # | Issue | Status | What to change |
|---|---|---|---|
| 1 | Scheduler bypasses service boundaries | Accurate | Add: the scheduler's `UPDATE orders SET status='cancelled' WHERE id=$1` (scheduler L163) has no `AND status='pending'` guard. It can overwrite an order that was confirmed after the SELECT ran (same race as §2.3). |
| 2 | Abandoned orders don't release inventory | **Impact overstated** | Reservations expire after 15 min (inventory L243) and `expireReservations` runs every minute. Abandonment triggers at 30 min, so while the scheduler is healthy the reservation is already `expired` by the time the order is cancelled. The actual gaps are: no `order_events` row, no `order.status_changed` event, so no refund when a payment completed but the confirm step failed, and no customer notification. Today no reservation is ever created in the order flow (the worker is stubbed), so the proposed AC "integration test proves no active reservation remains" **passes today without any fix**. Reword the impact and AC. |
| 3 | Failed payment retries | Accurate, but a dependency is missing | A retry **must not ship before charge idempotency** (§2.7). Retry eligibility also needs the order's status. The retry window is 1 h but abandonment cancels at 30 min, so a naive retry charges customers for orders that are already cancelled. |
| 4 | Daily digest delivery | Accurate, scope bigger than written | (a) Its revenue query counts refunds as revenue (§2.5). (b) It runs **every hour** (scheduler L73), so wiring up delivery as-is sends 24 "daily" digests. (c) notification-service has no digest template and **never renders templates** (§2.8). (d) There's no recipient: no admin identity exists anywhere. **Open:** ask Saad who receives it. |
| 5 | Hardcoded JWT fallback | Accurate | Compose already sets `JWT_SECRET=local-dev-secret`, so fail-closed won't break local dev. |
| 6 | Login accepts any credentials | Accurate, scope bigger than written | `handleRegister` (gateway L122) also issues a token for any email and stores nothing. **No users table exists in any service.** "Verify against the configured identity source" means building a user store with password hashing. That's a multi-day ticket, not a quick fix, so estimate it that way or split it. |

**Not in the list, and the root cause of the whole flow:** SQS publish is a log line in order/payment/shipping (e.g. order L388 `// Students implement actual SQS SendMessage here`), and `receiveSQSMessages` returns `nil` (worker L186). **Verified (runtime):** creating an order writes 0 reservations; the event only appears in the log.

---

## 2. New bugs found (ranked)

### 2.1 Stock is never consumed. The platform oversells indefinitely. **Verified (runtime)**
There is no `stock = stock - …` anywhere in the codebase (grep across all 9 services). Reservations have only three states: `active`, `released`, `expired`. None of them means "committed". So every reservation, **including one for a paid and delivered order**, expires after 15 min, and the units go back into `available`.
Repro: reserve 2 units for order 1, set order 1 to `delivered`, run the scheduler, and the result is `stock=5 reserved=0`, reservation `expired`.
Fix: when the order is confirmed or paid, a commit step does `stock -= q, reserved -= q` and sets the reservation status to `committed` in a single transaction. Expiry only touches `active`.
**Concept:** reservation → commit (two-phase stock allocation). A hold and a sale have to be separate states.

### 2.2 Timezone bug: fresh orders get cancelled as "abandoned". **Verified (runtime)**
The columns are `TIMESTAMP` without a time zone, filled by `NOW()` in the DB's zone (UTC). The scheduler passes `time.Now().Add(-30m)` in the **process's local zone** (scheduler L143). Postgres silently drops the offset when it casts to `timestamp` (`'…23:49+03:00'::timestamp` becomes `23:49`).
- With `TZ=Asia/Qatar`, an order created 8 seconds earlier was cancelled. With `TZ=UTC`, the same order stayed `pending`.
- Inventory has the same skew: a 15-min reservation was stored with a **3 h 15 min** TTL (inventory L243).
- `retryFailedPayments` (L177) uses the same pattern.
In containers both sides default to UTC, so this is latent there. It fires on the first `go run` against the compose Postgres from any machine set to UTC+3.
Fix: compute cutoffs in SQL (`created_at < NOW() - interval '30 minutes'`), or migrate the columns to `TIMESTAMPTZ`.
**Concept:** always store `timestamptz` and keep the DB as the single clock.

### 2.3 Order status changes race: an order ends up both confirmed and cancelled. **Verified (runtime)**
`handleUpdateStatus` reads the status (order L318), validates it, then runs `UPDATE … WHERE id=$2` with no status guard (L343). I fired concurrent `confirmed` and `cancelled` requests at a fresh pending order: **both returned 200 in 25 of 30 runs**. The order ended `confirmed`, but a `pending→cancelled` event was also emitted. Once the worker is live, that event means **release inventory and refund on a confirmed order**.
Fix: `UPDATE orders SET status=$1 WHERE id=$2 AND status=$3` and check `RowsAffected()`; 0 rows means 409. For idempotency, treat "already in the target state" as success.
**Concept:** compare-and-set / optimistic concurrency.

### 2.4 Concurrent releases double-decrement `reserved`. **Verified (runtime)**
`handleRelease` reads active reservations without a row lock (inventory L315). A second caller that reads before the first commits decrements again. Using the exact statements from the handler in two sessions: `reserved` went **3 → -3**, which makes `available` = 8 against stock 5. `expireReservations` has the same pattern (scheduler L128–130); `GREATEST(…, 0)` hides the corruption without preventing it. Once SQS redelivery exists this happens without any attacker.
Fix: `UPDATE reservations SET status='released' WHERE order_id=$1 AND status='active' RETURNING product_id, quantity`, then decrement only what was returned.
**Concept:** claim-then-act. The row you change is the lock.

### 2.5 Digest revenue counts refunds as revenue. **Verified (runtime)**
Refunds are inserted as `status='completed', method='refund'` (payment L267). The digest sums every `completed` row (scheduler L203). Test: two charges of £100 with one refunded. The dashboard reports net £100; **the digest reports £200**. The dashboard's queries (dashboard L119–122) do this correctly, so reuse them.

### 2.6 Rate limiting never triggers for a normal client. **Verified (runtime)**
`clientIP` falls back to `r.RemoteAddr`, which is `ip:port` (gateway L294). Every new TCP connection gets its own bucket (Redis keys seen: `rate:127.0.0.1:40444`, `…:40430`). Results: 150 separate requests gave 150 × 200. On one keep-alive connection, the 101st request got 429. When `X-Forwarded-For` is present it wins and is client-controlled; rotating it gave 150 × 200.
Behind Traefik, the correct key is the client IP Traefik resolves. **Open:** Traefik's docs describe `forwardedHeaders.trustedIPs` / `insecure` but don't state what happens to untrusted inbound XFF by default. Verify before relying on the first XFF hop.
**Concept:** trusted proxy hops. A client IP can only be trusted from the hop you control.

### 2.7 Payment integrity. **Verified (runtime) unless marked**
- No idempotency: two charges for the same order both succeeded (2 × £100).
- `tx.Commit()` error ignored (payment L189): the handler returns 201 and publishes `payment.completed` even if the commit failed. **Verified (code)**
- The ledger doesn't balance: a charge writes debit+credit, a refund writes one credit row. After one refund the ledger showed debit 200 / credit 300.
- Refund: `SELECT` without a lock, then insert (L237). Two parallel refunds both pass the `completed` check. **Verified (code), not reproduced**
- Any customer can charge any `customer_id`, refund any payment, read the full `/ledger` and anyone's `/balance/{email}`.

### 2.8 notification-service never sends or renders anything. **Verified (runtime)**
The stored body is literally `Hi {{.CustomerName}}, your order #{{.OrderID}}…`. Nothing executes `text/template`. An unknown template name falls back to the name itself (L170). An insert error is ignored and the handler still returns 201 `"sent"` with id 0 (L184). `/history` returns every recipient's notifications to any logged-in customer, which is a GDPR exposure of email addresses.

### 2.9 Authorization gaps. **Verified (runtime)**
Bob read and advanced Alice's order. Any customer can create products. Order totals come from the client: 2 units at £0.01 were accepted, and quantity −3 produced a total of −£150. A nonexistent product was accepted. A negative inventory reservation (−10) raised `available` above stock. The unauthenticated `/api/shipping/webhook` accepts any status and emits it as the event type (`shipment.anything_i_want`).

### 2.10 Dashboard can't work behind the gateway as coded. **Verified (runtime)**
The UI calls both `/dashboard/*` and `/api/*`, `/auth/*` on `window.location.origin`. Through the gateway, every `/dashboard/*` path returns 404; only `/api/dashboard/dashboard/summary` works. Served directly from dashboard-api, the `/api/*` and `/auth/*` calls return 404.
Option: fix it in Traefik without touching code (`/`, `/dashboard/*` → dashboard-api; `/api/*`, `/auth/*` → gateway on one host). **Trade-off:** that exposes revenue and summary endpoints unauthenticated to the internet. The alternative is moving the dashboard routes behind gateway auth. Your call.

### 2.11 Scheduler isn't safe with more than one replica. **Verified (code)**
The jobs run on in-process tickers (scheduler L70–74), and each job also runs immediately on start (L87). With 2 replicas, or on every rollout, each job runs twice. Pick one: `replicas: 1` + `strategy: Recreate`, a `pg_try_advisory_lock` per job, or K8s CronJobs.
**Concept:** singleton workloads and leader election.

---

## 3. Worker choreography: the stub comments don't form a consistent flow
**Verified (code):** these problems show up as soon as the worker is implemented the way its comments describe (worker L102–177).

- **Double confirm.** `order.created` confirms the order at step 4, and `payment.completed` confirms it again. The second request is `confirmed→confirmed`, which returns 409; the worker treats that as an error, the message is redelivered 3×, then lands in the DLQ.
- **Loop into 409.** `processing` creates a shipment, and `shipment.created` then sets the order to `processing` again, which is invalid.
- **No owner for two transitions.** Nothing moves an order `confirmed→processing`, and no handler exists for `shipment.in_transit` to move it `processing→shipped`. `shipment.delivered` then tries `processing→delivered`, which the state machine rejects.
- **Shipments can't be created.** Orders store no address, and `createShipment` requires `recipient_name` (shipping L199). No data exists to build a valid shipment from.
- **Duplicate notifications.** `shipment.delivered` sends a delivery notification, and so does `order.status_changed(delivered)`.

**Before writing worker code:** put an event → action → owner table in the ticket (one owner per transition) and pick orchestration (worker drives the sequence) or choreography (services react to each other's events). That table is ADR material and a strong stakeholder-Q&A answer.

---

## 4. Suggested order for the SQS fix chain

1. **Event table + ADR** (§3). Half a day, and it unblocks everything else.
2. **Publisher** in order/payment/shipping (+ scheduler): `aws-sdk-go-v2/service/sqs` `SendMessage`. **Verified (AWS SDK reference):** Go v2 reads `AWS_ENDPOINT_URL` / `AWS_ENDPOINT_URL_SQS`, so the compose floci env works without code branching.
3. **Idempotency before consumption.** Status compare-and-set (§2.3), one reserve per order_id, one completed charge per order_id (unique partial index), one shipment per order_id, and the release claim fix (§2.4). **Verified (AWS SQS docs):** standard queues are at-least-once, and AWS states consumers must be idempotent.
4. **Consumer.** `ReceiveMessage` with `WaitTimeSeconds=20`, max 10. `DeleteMessage` only on success. Visibility timeout longer than the worst-case handler time (up to 4 HTTP calls × 10 s client timeout). The DLQ with `maxReceiveCount 3` already exists in `floci-init.sh`.
5. **Stock commit** (§2.1).
6. **Scheduler tickets 1–4**, routed through the APIs/events above.

**Open (your call):** publishing after the DB commit is a dual write. If SQS is down, the event is lost. Saad stated zero tolerance for data loss, and the principled answer is a transactional outbox: an `outbox` row in the same transaction, relayed to SQS. That is extra scope. Weigh it against Sunday, or record it as a known risk in an ADR.
**Concept:** dual-write problem and the transactional outbox.

---

## 5. Housekeeping found on the way

- **Your Dockerfile PR branch is stale on GitHub.** Local `alpha-56` was rebased onto `main` (`29ebe04` on top of `ba9c7c8`) and never pushed. `origin/alpha-56` still carries the pre-merge floci commits (`ee9a174`, `71ea27b`) under `e8f94f6`, so the PR diff shows changes that are already on main.
  - Inspect first (read-only): `git log --oneline origin/alpha-56-app-dockerisation..alpha-56-app-dockerisation` and the PR's *Files changed* tab.
  - Then: `git push --force-with-lease origin alpha-56-app-dockerisation`. This **replaces the 3 remote commits** with your rebased one. `--force-with-lease` refuses if anyone pushed to that branch since your last fetch. **Open:** whether branch protection blocks force-push on feature branches.
- **No service code changes on disk yet** for the 7 in-progress tickets: `git diff HEAD -- services` is empty and there are no stashes. Only the staged `.gitattributes` and the scheduler↔floci compose wiring.
- **Queue name / region (corrected 23 Sep):** `.env.local` was a stale leftover and has been deleted. Compose's hardcoded `order-events` / `us-east-1` is the single source locally, confirmed at runtime (`list-queues` shows `order-events` + `order-events-dlq`, `maxReceiveCount 3`). Region only needs reconciling with Terraform's `eu-west-2` once Terraform owns the queues.
- **Worker Dockerfile** does `COPY go.mod ./` only. Once the SQS SDK is added, it needs `COPY go.mod go.sum ./`.
- **`.env`**: its header says "Committed template", but `.gitignore` ignores `.env`, so it will never be committed.

---

## 6. Estimation read (internal)
Of the six Notion tickets, #4 (digest) and #6 (login) are each bigger than their titles suggest (§1), and #3 is blocked on idempotency. Add §2.1, §2.3 and §2.4, which the SQS chain can't ship safely without, and "all by Sunday" is at risk. Re-scoping in the thread now, with the reasons above, scores better under the honest-estimation criterion than a slip discovered on Sunday.
