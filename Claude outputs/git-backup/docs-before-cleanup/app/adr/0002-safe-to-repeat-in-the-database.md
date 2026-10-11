# ADR 0002: The database makes every worker step safe to repeat

**Status:** Accepted for Sprint 2 (ALPHA-51, PR #31) for stock holds, charges and status changes. Reviewed at the hardening pass (8 Oct): option B is now built (ALPHA-119, ADR 0008); option C stays unbuilt.
**Decision in one line:** stock holds, charges and status changes are protected by database rules (unique indexes and guarded updates), so a repeated or simultaneous call can't do damage, whoever sends it.

## Context

SQS delivers every message at least once, and sometimes twice (ADR 0001). The worker also retries on purpose after a timeout. So every call the worker makes will sometimes arrive twice, or twice at the same moment.

We reproduced what that did to the old code before fixing anything:

| Call | What happened |
|---|---|
| Charge the same order 6 times | 6 payment rows, 5 of them completed |
| Release the same hold 20 times at once | `reserved` went from 3 to minus 57 |
| Confirm and cancel the same order at once | Both succeeded in 25 of 30 runs |

This had to be fixed before the worker could safely read the queue.

## Options

| Option | What it is | Result |
|---|---|---|
| **A. Database rules (chosen)** | Unique indexes and guarded updates, so a second attempt finds the first one's result | Holds for any caller and any timing, with no caller changes. |
| B. Idempotency-Key header on `/charge` | The caller sends a key, and payment saves and replays the first result for that key (the Stripe and IETF draft pattern) | Exact replay, including failed attempts. More work for payments only. **Built on 8 Oct (ADR 0008).** The database rule still stops a second completed charge; the key adds an exact replay, so a declined charge can't be approved on a retry. |
| C. Worker skips events it has already seen, by `id` | Keep a list of processed event IDs | Not needed while every step is safe to repeat. **Not built (8 Oct)** for that reason. |

## Decision

**Stock holds (inventory):**

- At most one active hold per order and product, enforced by a unique partial index.
- A repeated reserve returns the existing hold with 200, where a new one returns 201.
- A reserve for stock that's already committed also returns 200, so it holds nothing.
- Release claims its rows with `UPDATE ... SET status = 'released' WHERE status = 'active' RETURNING ...`. Only the call that actually changed a row lowers `reserved`.

**Charges (payment):**

- At most one completed charge per order, enforced by a unique partial index. Refund rows are left out, because they are stored as completed with method `refund`.
- A repeat with the same customer, amount and currency returns 200 with the existing payment ID and `already_paid: true`.
- A repeat with different details returns 409 with the existing payment ID. That means the caller has a bug.
- `/charge` refuses `method: refund`.

**Status changes (order):**

- Update only if the status is still what we read (`WHERE status = <current>`), so only one of two simultaneous changes wins. The loser gets 409.
- Asking for the status the order already has returns 200 with `changed: false` and writes nothing.

**Worker (ALPHA-45, PR #33):** before any step, the worker reads the order's status. `pending` runs the full flow, `cancelled` only releases, `confirmed` or later only commits. This is the worker's side of the same rule: a message that comes back late can't redo work the order has moved past.

## Consequences

- Retries and DLQ redrives are safe. We redrove a stuck order and it was not charged twice.
- The new unique indexes can't be created if duplicates already exist. Before deploying, check that no order has two completed charges or two active holds for the same product.
- A repeated charge doesn't replay a failed attempt. It only protects successful ones. Option B covers that later.
- A message that comes back after an order is confirmed no longer ends in the DLQ. The worker sees `confirmed` and only commits the stock, and a repeated confirm would return 200 anyway.
- The worker makes one extra call per message (the status read). If order-service is down, the message waits and is retried like any other technical failure.

## How we know it works

- inventory: 5 tests on reserve and release, run 20 times in a row with the race detector. The old code ended at minus 57 and the new code at 0. The 20 concurrent tests only caught the bug once the connection pool was warmed first.
- payment: 6 tests. With the unique index removed, 20 concurrent charges all completed, so the index is what stops it. Live: 10 GBP gave 201, 10 GBP again gave 200 `already_paid`, 5 GBP gave 409.
- status: 4 tests, including confirm and cancel racing 30 times, run 5 times with the race detector. The old code fails 3 of them. Removing either the `WHERE status` guard or the same-status check makes a test fail.
- worker: 4 tests for a message coming back after a confirm or a cancel, and for order-service being down during the check.

## Revisit when

- Hardening starts: add Idempotency-Key replay (option B).
- Refunds get handled by the worker (ALPHA-78). Refunds need the same protection.
