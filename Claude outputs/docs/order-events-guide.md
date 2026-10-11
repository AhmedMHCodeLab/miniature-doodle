# Order events: how they work and how to check them

This guide is for anyone on the team touching order-service, the worker, or the SQS setup. No prior SQS knowledge is assumed.
Design reasoning: see the ADR "How order-service delivers events".

## 1. The idea in one picture

```
POST /api/orders/
      │
      ▼
order-service ── ONE database transaction ─────────────────────┐
      │   INSERT orders              (the order)                │  all three saved,
      │   INSERT order_events        (history row)              │  or none of them
      │   INSERT order_outbox        (the event, not sent yet)  │
      │                                                         ┘
      ▼
201 returned to the customer

meanwhile, every second, inside order-service:
outbox relay ── reads unsent rows from order_outbox
             ── sends each one to SQS queue "order-events"
             ── marks it sent (sent_at = now)
                     │
                     ▼
               worker (reads the queue: not implemented yet)
```

In plain words:

- The order and its "please tell everyone" note are written in the same step.
- A background loop (the **relay**) delivers the notes to the queue.
- If the queue is down, the notes wait in the database and go out when it's back.

## 2. Words you'll see

| Word | Meaning here |
|---|---|
| **Event** | A small JSON message saying something happened, e.g. `order.created` |
| **SQS queue** | AWS's message queue. Locally we use **Floci**, which pretends to be AWS on `localhost:4566` |
| **Outbox** | The `order_outbox` table: events saved but maybe not sent yet |
| **Relay** | The loop in order-service that moves outbox rows to SQS |
| **Transaction** | A group of database writes that all succeed or all fail together |
| **At-least-once** | Every event is delivered; occasionally the same event is delivered twice |
| **DLQ** | Dead-letter queue (`order-events-dlq`). A message moves there after 3 failed processing attempts |

## 3. What a message looks like

```json
{
  "id": "order-service-42",
  "type": "order.created",
  "timestamp": "2026-09-24T10:15:00Z",
  "payload": {
    "order_id": 42,
    "customer_id": "alice@example.com",
    "items": [{ "product_id": "p1", "quantity": 1, "price": 50 }],
    "total": 50,
    "currency": "GBP"
  }
}
```

- `type`, `payload` and `timestamp` are the same shape the worker already expects.
- `id` is new. It's unique per event. **Anyone consuming these messages must use `id` to ignore a repeat delivery.**
- `timestamp` is when the event *happened* (the row was saved), not when it was sent.

Event types order-service emits:

| Type | When | Payload |
|---|---|---|
| `order.created` | `POST /api/orders/` | `order_id`, `customer_id`, `items`, `total`, `currency` |
| `order.status_changed` | `PUT /api/orders/status` | `order_id`, `old_status`, `new_status` |

## 4. Configuration

No new settings. order-service uses what's already in `docker-compose.yml`:

| Variable | Local value | On EKS |
|---|---|---|
| `SQS_QUEUE_URL` | `http://floci:4566/000000000000/order-events` | the real queue URL |
| `AWS_REGION` | `us-east-1` | the cluster's region |
| `AWS_ENDPOINT_URL` | `http://floci:4566` | **must not be set** (it would send traffic to Floci) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` / `test` | **not set**: credentials come from the pod's IAM role |

If `SQS_QUEUE_URL` is missing, order-service still saves events and logs `WARNING: SQS_QUEUE_URL not set`. Nothing is sent until it's configured.

IAM on EKS: order-service needs only `sqs:SendMessage` on the `order-events` queue ARN.

## 5. See it working (5 minutes, zsh)

```zsh
docker compose up -d --build order-service
docker compose logs order-service | grep -i outbox     # expect: "Outbox relay started, publishing to ..."

TOKEN=$(curl -s -X POST localhost:8080/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"me@test.com","password":"x"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -s -X POST localhost:8080/api/orders/ -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"items":[{"product_id":"p1","quantity":1,"price":50}]}'

# The event in the database: sent should be 't' within a second or two
docker compose exec postgres psql -U app -d orders -c \
  "SELECT id, event_type, sent_at IS NOT NULL AS sent, attempts, last_error FROM order_outbox ORDER BY id DESC LIMIT 5;"

# The message on the queue. Floci's inspection endpoint only looks: it does not receive or delete.
curl -s "http://localhost:4566/_aws/sqs/messages?QueueUrl=http://localhost:4566/000000000000/order-events" | python3 -m json.tool
```

## 6. Failure drill: prove nothing is lost when SQS is down

```zsh
docker compose stop floci                                    # queue "goes down"
curl -s -X POST localhost:8080/api/orders/ -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"items":[{"product_id":"p2","quantity":1,"price":20}]}'
# Expect 201: orders are still accepted.

docker compose exec postgres psql -U app -d orders -c \
  "SELECT id, sent_at IS NOT NULL AS sent, attempts, left(last_error, 60) FROM order_outbox ORDER BY id DESC LIMIT 3;"
# Expect: newest row sent = f, attempts climbing, last_error filled in.

docker compose start floci
# Wait a few seconds, then re-run the SELECT. Expect: sent = t.
```

**Caveat, Floci specific:** Floci keeps queues in memory by default. After a Floci restart the queues exist again only if its init script recreates them (`scripts/floci-init.sh`). If the row stays unsent with `NonExistentQueue` in `last_error`, run `docker compose restart floci` and check `aws sqs list-queues`.

## 7. Run the automated tests

The database tests need a **throwaway** database. They wipe `orders`, `order_events` and `order_outbox` in whatever database you point them at. **Never use `orders`.**

```zsh
docker compose exec postgres createdb -U app orders_test      # once

# Option A: Go 1.24+ installed locally
cd services/order-service
TEST_DATABASE_URL='postgres://app:localdev@localhost:5432/orders_test?sslmode=disable' \
AWS_ENDPOINT_URL=http://localhost:4566 AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
go test ./... -v -count=1

# Option B: no local Go. Run inside the same image the Dockerfile builds with.
# The compose network is <project>_default. Find yours with: docker network ls | grep _default
docker run --rm --network alpha-pilot-4week_default -e CGO_ENABLED=0 \
  -e TEST_DATABASE_URL='postgres://app:localdev@postgres:5432/orders_test?sslmode=disable' \
  -e AWS_ENDPOINT_URL=http://floci:4566 -e AWS_REGION=us-east-1 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test \
  -v "$PWD/services/order-service":/src -w /src golang:1.26-alpine go test ./... -v -count=1
```

Without `TEST_DATABASE_URL` / `AWS_ENDPOINT_URL`, the integration tests **skip** instead of failing. That keeps CI green where there's no Postgres or Floci.

| Test | What it proves |
|---|---|
| `TestCreateOrderSavesOrderAndEventTogether` | One request = one order + one history row + one outbox event |
| `TestCreateOrderSavesNothingWhenOutboxWriteFails` | If the event can't be saved, the order isn't saved either |
| `TestStatusChangeQueuesEvent` | Status changes produce `order.status_changed` |
| `TestRelaySendsPendingEventsAndMarksThemSent` | Relay sends each event once, in the expected envelope |
| `TestRelayKeepsEventWhenQueueIsDown` | Queue down → event kept with the error recorded → delivered after recovery |
| `TestTwoRelaysDoNotSendTheSameEvent` | Two replicas never send the same event at the same time |
| `TestSQSPublisherDeliversMessage` | A real SQS API receives exactly what was sent |
| `TestSQSPublisherReturnsErrorForMissingQueue` | A wrong queue URL is an error, never a silent drop |

## 8. Troubleshooting queries

```sql
-- Events waiting to be sent, oldest first
SELECT id, event_type, created_at, attempts, last_error
FROM order_outbox WHERE sent_at IS NULL ORDER BY id;

-- Anything stuck for more than 5 minutes means the relay can't reach SQS
SELECT count(*) FROM order_outbox
WHERE sent_at IS NULL AND created_at < NOW() - INTERVAL '5 minutes';
```

| Symptom | Likely cause |
|---|---|
| `last_error` says `NonExistentQueue` | Wrong `SQS_QUEUE_URL`, or the queue isn't created (Floci restarted) |
| `last_error` says `no such host`, `connection refused` or timeouts | Floci or SQS unreachable (e.g. `docker compose stop floci`), or the endpoint/network is wrong |
| No outbox rows at all | order-service isn't the new build: `docker compose up -d --build order-service` |

## 9. Known limits and follow-ups

- **Duplicates are possible** (at-least-once). Consumers must ignore repeats using `id`. The worker must not be switched on until inventory reserve, payment charge and order status changes are safe to repeat.
- **Sent rows are never cleaned up yet.** Payloads include the customer email, so a retention job is needed.
- **Two concurrent status changes can still both succeed.** That's a separate fix (compare-and-set on the `UPDATE`).
- **Not yet on the outbox pattern:** payment-service and shipping-service.
