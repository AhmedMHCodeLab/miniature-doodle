# Run, build, test

Describes: `main` after the app hardening PRs (ALPHA-81, 8 Oct).

This page is the hands-on part: run the app on your laptop, watch an order move, break things on purpose, and run the tests.

Most people only need this:

```bash
docker compose up -d --build
# open http://localhost:8080 (not 8086), log in as admin@platform.local / admin,
# place an order, check it shows "confirmed" within about 5 seconds
go run scripts/smoke/main.go -base http://localhost:8080    # every step should say PASS
```

Tests skip instead of failing when their database, Floci or Redis isn't set. Always read the output for `SKIP`.

---

## 1. Run the stack

```bash
docker compose up -d --build
docker compose ps          # everything should say Up
```

Open **http://localhost:8080** and log in as `admin@platform.local` with password `admin` (local only; `docker-compose.yml`). The dashboard on 8086 loads, but all its data calls fail there (see Gateway and dashboard).

Local-only secrets in `docker-compose.yml`: Redis password `localdev`, carrier webhook secret `local-carrier-secret`. On EKS all of them come from Secrets Manager.

If an order sits at `pending` after `docker compose up --build`, restart the two services that talk to the queue: `docker compose restart worker order-service`.

Local AWS is Floci on port 4566. When it starts, it runs `scripts/floci-init.sh`, which creates the `order-events` queue and its dead letter queue `order-events-dlq`. A message moves to the DLQ after 3 failed tries. The visibility timeout is 60 seconds.

On a fresh start, the worker sometimes polls before the queue exists. It logs one `NonExistentQueue` error, then recovers 5 seconds later. You can ignore it.

---

## 2. Place an order and watch it move

From the dashboard: Orders tab, pick a product and quantity, fill in the shipping address, then Place Order. The price always comes from inventory.

From the terminal:

```bash
TOKEN=$(curl -s -X POST localhost:8080/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@platform.local","password":"admin"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')

curl -s -X POST localhost:8080/api/orders/ -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(date +%s%N)" \
  -d '{"items":[{"product_id":"mon-001","quantity":1}],
       "shipping_address":{"name":"Sara","line1":"1 High St","city":"Leeds","postcode":"LS1 1AA"}}'
# note the "id" in the reply, for example 42. Send the same command again with the same key
# and you get order 42 back, not a new order.

sleep 5
curl -s localhost:8080/api/orders/42 -H "Authorization: Bearer $TOKEN"
# expect "status":"confirmed"
```

Check each step in the database:

```bash
docker compose exec postgres psql -U app -d orders

-- was the event sent?
SELECT id, event_type, sent_at IS NOT NULL AS sent, attempts, last_error
FROM order_outbox ORDER BY id DESC LIMIT 5;

-- was stock held, then committed?
SELECT order_id, product_id, quantity, status FROM reservations ORDER BY created_at DESC LIMIT 5;

-- was it charged once?
SELECT order_id, amount, status, method FROM payments ORDER BY created_at DESC LIMIT 5;
```

Watch the worker: `docker compose logs -f worker`.

The simulated card provider declines about 1 in 10 charges. A cancelled order with a released hold after a decline is correct.

---

## 3. Failure drills

These are the drills we ran on 24 Sep. They're worth running once so the failure paths aren't a surprise.

**SQS down: the order is still accepted and the event waits.**

```bash
docker compose stop floci
# place an order: expect 201
# order_outbox: newest row sent = f, attempts going up, last_error filled
docker compose start floci
# a few seconds later: sent = t
```

Floci keeps queues in memory. After a restart it recreates them from `floci-init.sh`. If `last_error` shows `NonExistentQueue`, run `docker compose restart floci`.

**A service down: retries, then the DLQ.**

```bash
docker compose stop payment-service
# place an order: after about 3 minutes (3 tries, 60 s apart) the message is in the DLQ
docker compose exec floci aws sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/order-events-dlq \
  --attribute-names ApproximateNumberOfMessages
```

**DLQ redrive: send stuck messages back once the service is healthy.**

```bash
docker compose start payment-service
docker compose exec floci aws sqs start-message-move-task \
  --source-arn arn:aws:sqs:us-east-1:000000000000:order-events-dlq
# the worker picks the message up within seconds and finishes the order
```

On AWS it's the same API, or "Start DLQ redrive" in the SQS console. Redrive is safe because every step is safe to repeat.

---

## 4. Smoke test: is the platform working?

One command runs a real order through the public URL and prints PASS or FAIL for each step: health of every service, admin login, an order with an address, a retry with the same key, confirm, stock taken, charge, emails, ship, deliver, cancel with refund, and the doors that must stay shut (wrong password, sign-up, unsigned webhook, internal routes).

```bash
go run scripts/smoke/main.go -base http://localhost:8080

# on EKS dev (the certificate is Let's Encrypt staging, hence -insecure)
go run scripts/smoke/main.go -base https://dashboard.dev.eksv2.naimaosmann.com -insecure -password "$(aws secretsmanager get-secret-value --secret-id eks-v2-dev-admin-password --query SecretString --output text)"
```

It creates two real orders, so run it against local or dev only, never prod. Someone ordering the same product during the run can make a stock step fail; run it again. The exit code is 1 if any step failed.

---

## 5. Run the tests

Tests sit next to the code (`main_test.go` in each service), which is how Go works. Run them from the service folder.

The database tests wipe their tables. Always give them a throwaway database, never `orders`:

```bash
docker compose exec postgres createdb -U app orders_test    # once
```

| Service | What the tests need | Example |
|---|---|---|
| order-service | `TEST_DATABASE_URL`, plus `AWS_ENDPOINT_URL` for the SQS tests | see below |
| inventory-service, payment-service | `TEST_DATABASE_URL` | |
| worker | nothing for the handler tests. `AWS_ENDPOINT_URL` for the real-queue test | |
| api-gateway | `TEST_REDIS_URL` for the rate limiter tests, with the password: `redis://:localdev@localhost:6379/15`. Routing and login tests need nothing. | |
| scheduler, shipping-service, notification-service | `TEST_DATABASE_URL` | |

```bash
cd services/order-service
TEST_DATABASE_URL='postgres://app:localdev@localhost:5432/orders_test?sslmode=disable' \
AWS_ENDPOINT_URL=http://localhost:4566 AWS_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
go test ./... -race -count=1 -v
```

No Go on your machine? Run the tests inside the same image the Dockerfile uses (`golang:1.26-alpine`) on the compose network. The order events guide has the full command.

Two things we learned the hard way:

- A concurrency test proves nothing on a cold connection pool. With one connection open, the first request finished before the others started, and the buggy code passed. The inventory tests open 20 connections first.
- Each test must close its pool (`t.Cleanup(db.Close)`). Otherwise Postgres runs out of connection slots after about 10 runs.

CI runs `go test -race` for each changed service, but without a database or Redis, so those tests skip there. The database tests only protect main when someone runs them as above.

---

## 6. Build images

Every service uses the same two-stage Dockerfile:

1. **Build** in `golang:1.26-alpine`. `CGO_ENABLED=0` gives a static binary, and `-trimpath -ldflags "-s -w"` keeps it small.
2. **Run** on `gcr.io/distroless/static-debian13`, pinned by digest, as user `nonroot`. There is no shell in the final image.

Adding a service: copy an existing Dockerfile and `.dockerignore`, then change the labels and the `EXPOSE` port.

Because there's no shell, you can't `docker exec` into a running service to look around. Check logs, the health endpoint, or run the binary in the builder image instead.

---

## 7. Who is holding database connections

Each service names its connections (`PGAPPNAME`), so Postgres can show who holds what:

```sql
SELECT application_name, state, count(*) FROM pg_stat_activity
GROUP BY 1, 2 ORDER BY 1;
```

inventory-service also exposes pool metrics (`go_sql_*`) at http://localhost:9092/metrics.

What we found so far: 600 stock holds on one product, 60 at a time, made about 570 requests wait for a connection. The same load spread over 60 products made none wait. The waits come from requests queueing on the same database row, not from having too few connections. The decision on pool sizes waits for the load tests (ALPHA-80).

---

## 8. When something looks wrong

| You see | Likely cause | Fix |
|---|---|---|
| Dashboard tables empty, or orders fail, on 8086 | The page needs the gateway | Use 8080 |
| Dashboard empty on 8080 after a code change | Old image | `docker compose up -d --build api-gateway dashboard-api` |
| Order stays `pending` | Worker not running, or the queue missing | `docker compose logs worker`, then restart floci and the worker |
| `order_outbox` rows not sent | Floci down, or wrong `SQS_QUEUE_URL` | Check `last_error` |
| 429 responses | Rate limit hit | Wait for `Retry-After`. Raise the limit in compose only for load tests. |
| Order cancelled after about a second | Simulated decline, or not enough stock | Check the worker log line for the order |
| Test says `SKIP` | Its env var isn't set | See the table in section 4 |

Next: back to Application: start here, or the ADRs for the reasoning.
