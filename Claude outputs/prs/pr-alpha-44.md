## Description

order-service now sends its events (`order.created`, `order.status_changed`) to the SQS queue `order-events`. Before this, `publishEvent` only logged them, so no order could move past `pending`.

Events go through a **transactional outbox**:

1. The event is saved in a new `order_outbox` table, in the same database transaction as the order.
2. A background relay sends unsent rows to SQS every second and marks them sent.

**Why:** zero data loss was a stated client requirement (14 Sep). Sending straight to SQS after saving the order can lose the event if SQS is down or the pod dies in between. With the outbox, an order can't exist without its event, and creating orders keeps working during an SQS outage. Standard queue kept; FIFO was considered and rejected (reasons in the ADR).

**Changes**
- `publisher.go`: small SQS client (AWS SDK for Go v2). Config comes from the standard AWS env vars; `AWS_ENDPOINT_URL` points it at Floci locally.
- `outbox.go`: `enqueueEvent` (writes the event inside the order's transaction) and the relay (`FOR UPDATE SKIP LOCKED`, so several replicas never send the same row twice).
- `main.go`: `createOrder` and `handleUpdateStatus` each use one transaction, and a failed `order_events` insert is no longer ignored. New `order_outbox` table in `migrate()`. The relay starts on boot (only if `SQS_QUEUE_URL` is set) and stops cleanly on SIGTERM. `publishEvent` removed.
- `go.mod` / `go.sum`: adds `aws-sdk-go-v2` (config, sqs). **Go directive 1.22 → 1.24**, required by the SDK. The Dockerfile builder (`golang:1.26-alpine`) is unaffected; local Go must be ≥ 1.24.
- No `docker-compose.yml` change; the existing floci env vars are enough.

**Breaking change:** none for callers. API responses are unchanged.

**Not in this PR (ALPHA-44 stays open for these)**
- Outbox for payment-service and shipping-service.
- Worker consumption: blocked until reserve, charge and status updates are safe to repeat (ALPHA-51). Messages can arrive twice; each carries a unique `id` for de-duplication.
- Compare-and-set on status updates (two concurrent transitions can both succeed today; ALPHA-51).
- Cleanup of sent outbox rows (payload includes customer email).
- Terraform SQS settings: visibility timeout above the default 30 s, DLQ retention longer than the source queue.

## Ticket Link

Ticket: [ALPHA-44](https://app.plane.so/production-simulation/browse/ALPHA-44/)

Design and alternatives: ADR "How order-service delivers events" (Plane page). How to run and check it: "Order events" guide (Plane page), sections 5–7.

## Screenshots / Evidence

- 8 tests (`go test ./...`) against Postgres 16 and a local SQS API, passing with `-race`. Database/SQS tests skip when `TEST_DATABASE_URL` / `AWS_ENDPOINT_URL` are not set.
- The tests catch real mistakes: removing `SKIP LOCKED`, moving the order insert outside the transaction, or not marking rows sent each makes a test fail.
- End to end on the local stack with Floci:
  - create order → message on `order-events` with the expected envelope
  - stop Floci → order still returns 201; the event waits with `attempts` / `last_error` recorded
  - start Floci → event delivered
  - SIGTERM → clean shutdown

## Checklist

- [x] Tests passing locally
- [ ] Lint/format checks passing
- [ ] Terraform plan reviewed (if infra change) — n/a, no infra change
- [x] Docs updated (if needed) — ADR + "Order events" guide as Plane pages
- [ ] Breaking change — noted in description — none
