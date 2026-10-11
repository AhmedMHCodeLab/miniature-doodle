## What

order-service now delivers its events (`order.created`, `order.status_changed`) to the SQS queue `order-events`. Before this, `publishEvent` only logged them, so no order could move past `pending`.

Events go through a **transactional outbox**:

1. The event is saved in `order_outbox` in the same database transaction as the order.
2. A background relay sends unsent rows to SQS every second and marks them sent.

Ticket: ALPHA-XX <!-- link the Plane ticket -->
Design + alternatives: ADR "How order-service delivers events" <!-- link the Plane page -->

## Why this approach

- **Zero data loss** was a stated client requirement (Saad, 14 Sep). Sending straight to SQS after saving the order can lose the event if SQS is down or the pod dies in between.
- With the outbox, an order can't exist without its event, and creating orders keeps working during an SQS outage.
- Standard queue kept as-is (FIFO considered and rejected; reasons in the ADR).

## Changes

- `publisher.go`: small SQS client wrapper using the AWS SDK for Go v2. Config comes from the standard AWS env vars. `AWS_ENDPOINT_URL` points it at Floci locally.
- `outbox.go`: `enqueueEvent` (write the event inside a transaction) and the relay (`FOR UPDATE SKIP LOCKED`, so multiple replicas never double-send).
- `main.go`:
  - `createOrder` and `handleUpdateStatus` now use one transaction each. A failed `order_events` insert is no longer ignored.
  - New `order_outbox` table in `migrate()`.
  - Relay starts on boot and stops cleanly on SIGTERM.
  - `publishEvent` removed.
- `go.mod` / `go.sum`: adds `aws-sdk-go-v2` (config, sqs). **The Go directive moves 1.22 → 1.24**, because the SDK requires it. The Dockerfile builder `golang:1.26-alpine` is unaffected. Local and CI Go must be ≥ 1.24.
- No changes to `docker-compose.yml`. The existing floci env vars are enough.

## How it was tested

- 8 tests (`go test ./...`), run against real Postgres 16 and a local SQS API, all passing with `-race`.
  - Database/SQS tests skip automatically when `TEST_DATABASE_URL` / `AWS_ENDPOINT_URL` aren't set.
- Checked that the tests catch real mistakes: removing `SKIP LOCKED`, moving the order insert outside the transaction, or not marking rows sent each makes a test fail.
- End to end:
  - create order → message on the queue with the expected envelope
  - stop SQS → order still returns 201, event waits with `attempts` / `last_error` recorded
  - start SQS → event delivered
  - SIGTERM → clean shutdown
- Reviewer steps: see the "Order events" guide, sections 5–7.

## Not in this PR (follow-ups)

- **Worker consumption.** Blocked until reserve, charge and status updates are safe to repeat. Messages can be delivered twice. Each carries a unique `id` for de-duplication.
- Compare-and-set on status updates (concurrent transitions can both succeed today).
- Outbox for payment-service and shipping-service.
- Retention/cleanup of sent outbox rows (payload includes customer email).
- Terraform SQS module:
  - visibility timeout above the default 30 s (worst-case handler ≈ 40 s)
  - DLQ retention longer than the source queue's
