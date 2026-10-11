# ADR 0001: Order events go through an outbox and a Standard SQS queue

**Status:** Accepted in PR #23 (ALPHA-44). Was "Proposed" on 24 Sep.
**Decision in one line:** order-service saves each event in the same database transaction as the order, and a background loop sends it to a Standard SQS queue.

## Context

When an order is created or changes status, order-service has to tell the rest of the platform with an event, a small JSON message on the SQS queue `order-events`. The worker reads that queue and calls the other services.

Before this change, `publishEvent` only logged the event. Nothing reached the queue, so no order ever got past `pending`.

Once sending was built, two questions came up:

1. **What if sending fails?** The order goes to Postgres and the event goes to SQS, which are two different systems. If the save works and the send fails, the order exists but nobody hears about it. The scheduler then cancels it after 30 minutes, and no error shows up anywhere.
2. **Standard or FIFO queue?**

What decided it, from the stakeholder Q&A on 14 Sep:

- zero tolerance for data loss
- cost as the top priority
- audit readiness (PCI DSS)

## Options

**When a send fails:**

| Option | What it does | Result |
|---|---|---|
| A1. Send directly, log failures | Simplest | A failed send loses the event for good. Breaks "zero data loss". |
| A2. Send directly, return 500 on failure | The caller sees the error | The order is already saved, so when the client retries it creates a duplicate order. |
| **A3. Outbox** | Save the event with the order; a loop delivers it | **Chosen.** Nothing is lost, and taking an order no longer depends on SQS being up. Costs one table, one loop, and about 200 lines of code plus tests. |

**Queue type:**

| Option | For | Against |
|---|---|---|
| **Standard (chosen)** | Already set up and tested (redelivery and DLQ checked on 23 Sep). The order status rules already reject out-of-order changes. | Messages can arrive twice or out of order. |
| FIFO | Strict order per group; the sender's repeats are removed for 5 minutes | The worker still gets duplicates after a crash or a timeout. One stuck message blocks its whole group. AWS warns a DLQ breaks FIFO order. Needs a queue rename, a Terraform change and a group ID on every send. |

## Decision

- The event is written to `order_outbox` in the same transaction as the order change. Both are saved, or neither is.
- A loop inside order-service (the relay) reads unsent rows every second, sends them to SQS and marks them sent. If SQS is down, rows stay unsent with `attempts` and `last_error` filled in, and the relay tries again on the next pass.
- Keep the Standard queue with its DLQ (`maxReceiveCount` 3).

## Consequences

What we gain:

- An order can't exist without its event.
- Orders are still accepted while SQS is down. We tested this: an order placed during an SQS outage was delivered once the queue came back.
- The order, its history row and its event are saved together. Before, a failed history insert was silently ignored.
- Safe with several order-service copies on EKS. `FOR UPDATE SKIP LOCKED` stops two copies sending the same row, and a test covers it.
- An idle relay makes no SQS requests, because it reads Postgres, not SQS.

What we accept:

- **At least once.** If the pod dies after SQS accepted a message but before the row was marked sent, the event goes again. Every event carries a unique `id`, and every step the worker calls is safe to repeat (ADR 0002).
- **Up to about 1 second of delay** before an event reaches the queue.
- **Sent rows are kept.** Their payload holds the customer email, so a cleanup job is needed later.
- **Log noise during an outage.** One error per second until SQS is back.
- **Go 1.24.** The AWS SDK for Go v2 needs it, so order-service moved from Go 1.22.

## How we know it works

- 8 tests: atomic save, rollback when the outbox write fails, status events, the relay sending and marking rows, the relay keeping events while the queue is down, two copies not double-sending, a real SQS send, and an error on a missing queue.
- 3 of them were checked by breaking the code on purpose. All pass with Go's race detector.
- End to end with Postgres 16 and a local SQS: the order is created and the message arrives. Then SQS is stopped, the order is still accepted and the event waits. SQS is started again and the event is delivered.

## Revisit when

- payment-service and shipping-service start sending events. Use the same pattern.
- Outbox cleanup is built.

## References

AWS: [at-least-once delivery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html), [visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html), [dead letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html), [FIFO delivery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html).
