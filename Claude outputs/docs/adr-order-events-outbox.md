# ADR: How order-service delivers events (Standard SQS queue + transactional outbox)

**Status:** Proposed, for team review
**Date:** 24 Sep 2026
**Author:** Ahmed
**Code:** `services/order-service/` (`publisher.go`, `outbox.go`, `main.go`)

## Context

When an order is created or changes status, order-service has to tell the rest of the platform (inventory, payment, shipping, notification) through an **event**: a small JSON message placed on the SQS queue `order-events`. The worker reads that queue and calls the other services.

Before this change, `publishEvent` in order-service only **logged** the event. Nothing reached the queue, so no order ever progressed past `pending`.

Two design questions came up once sending was implemented:

1. **What happens if sending fails?** The order is saved in Postgres and the event goes to SQS. These are two separate systems. If the database write succeeds and the SQS send fails (SQS unreachable, pod killed in between), the order exists but nobody downstream hears about it. The scheduler then cancels it after 30 minutes with no error anywhere.
2. **Standard or FIFO queue?**

The client requirements that decide this come from Saad's stakeholder Q&A on 14 Sep:

- **zero tolerance for data loss**
- **cost efficiency as the #1 priority**
- PCI-DSS / audit readiness

## Decision

### 1. Events go through a transactional outbox

- The event is written to the table `order_outbox` in the **same database transaction** as the order change. The order and its event are saved together, or neither is.
- A background loop inside order-service (the **relay**) reads unsent rows every second, sends them to SQS, and marks them `sent_at`.
- If SQS is unreachable, rows stay unsent. The relay records `attempts` and `last_error` and retries on the next tick.

### 2. Keep the Standard queue

This is the queue that `scripts/floci-init.sh` already creates, with its DLQ (dead-letter queue: where messages go after repeated failed processing, `maxReceiveCount 3`).

## Options considered

### What to do when a send fails

| Option | What it does | Why not chosen / chosen |
|---|---|---|
| A1. Send directly, log failures | Simplest | A failed send loses the event for good. Breaks "zero data loss". |
| A2. Send directly, return 500 on failure | Caller sees the error | The order row is already saved, so a client retry creates a **duplicate order**. |
| **A3. Transactional outbox** | Event saved with the order; relay delivers it | **Chosen.** Nothing is lost, and creating an order no longer depends on SQS being up. Costs one table, one loop and about 200 lines of code plus tests. |

### Which queue type

| Option | For | Against |
|---|---|---|
| **Standard** | Already provisioned and tested (redelivery and DLQ verified locally 23 Sep). The order state machine already rejects out-of-order status changes. | Messages can arrive twice or out of order. |
| FIFO | Strict order per message group; sender retries de-duplicated for 5 minutes. | Consumers still receive duplicates after a crash or visibility timeout. One stuck message blocks its whole group. AWS warns a DLQ breaks FIFO ordering. Needs queue rename, Terraform change and a group ID on every send. |

## Consequences

### What we gain

- An order can't exist without its event, which covers the "zero data loss" requirement.
- `POST /api/orders/` keeps working while SQS is down. Events queue up in Postgres and are delivered after recovery. Verified: order accepted during an SQS outage, delivered after the queue came back.
- The order row, its `order_events` history row and the outbox row are now atomic. Before, a failed `order_events` insert was silently ignored.
- Safe with several order-service replicas on EKS. `FOR UPDATE SKIP LOCKED` means two replicas never send the same row at the same time (covered by a test).
- Cost: the relay polls Postgres, not SQS, so an idle relay makes **zero SQS requests**.

### What we accept (known limits)

- **At-least-once delivery.** If the pod dies after SQS accepts a message but before `sent_at` is saved, that event is sent again. Every event carries a unique `"id"` (e.g. `order-service-42`). **Consumers must use it to ignore repeats.** The worker must not start consuming until inventory reservation, payment charge and order status changes are safe to repeat.
- **Delivery delay:** up to ~1 second plus SQS latency.
- **Table growth:** sent rows are kept. Payloads contain the customer email, so a retention/cleanup job is needed later (GDPR-style retention was a stated client concern). Tracked as a follow-up.
- **Log noise during an outage:** the relay logs one error per tick until SQS is back.
- **Go version:** the AWS SDK for Go v2 requires Go 1.24, so `services/order-service/go.mod` moves from `go 1.22` to `go 1.24`. The Docker builder (`golang:1.26-alpine`) already satisfies this. CI and local toolchains need 1.24+.

### Not changed by this ADR (separate tickets)

- The status-update race: two concurrent status changes can both succeed. The fix is compare-and-set on the `UPDATE`.
- payment-service and shipping-service still only log their events. Same pattern to follow.
- The worker still does not read the queue.

## How this was verified

- 8 automated tests in `services/order-service`:
  - atomic save
  - rollback when the outbox write fails
  - status events
  - relay sends and marks sent
  - relay keeps events while the queue is down
  - two replicas don't double-send
  - real SQS send
  - error on a missing queue
- Three of the tests were checked by deliberately breaking the code and confirming the test fails. All pass under Go's race detector.
- End-to-end run: order-service binary, Postgres 16 and a local SQS emulator. Order created → message on queue with the expected envelope. SQS stopped → order still accepted, event waited (`attempts` increasing, `last_error` recorded) → SQS restored → event delivered → clean shutdown.

## References

- AWS: [SQS at-least-once delivery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html) · [Visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html) · [Dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html) · [FIFO delivery logic](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html) · [SDK endpoint environment variables](https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html) · [Go SDK v2 retries](https://docs.aws.amazon.com/sdk-for-go/v2/developer-guide/configure-retries-timeouts.html)
- Floci: [SQS service docs](https://floci.io/floci/services/sqs/)
