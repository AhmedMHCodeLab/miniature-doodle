# Application: start here

Describes: `main` after the app hardening PRs (ALPHA-81, 8 Oct). Earlier: the Sprint 2 fixes (PRs #23, #24, #25, #29, #31, #32, #33) and PR #63.

**What this is.** The application side of the EKS v2 order platform. 9 Go services sit behind one gateway, share one Postgres database, and pass order events through one SQS queue.

**What changed in Sprint 2.** Before, every order stayed `pending` forever. order-service only logged its events and the worker never read the queue. Now an order placed through the gateway gets its stock held, gets charged, gets confirmed, and its stock is taken off the shelf. You can watch it happen on the dashboard.

**What changed in Sprint 4.** The order flow now runs end to end: confirm, ship, deliver and cancel with a refund, each with its email. The app was then hardened: one real admin login, internal routes closed to the outside, a signed carrier webhook, safe retries of an order, and secrets for Redis and the webhook in Secrets Manager.

**How we worked.** Fix first, harden later. What is not built yet, and why, is listed near the bottom of this page.

**Read next.** How an order flows (15 minutes). If you want to see it working first, go to Run, build, test and follow "Place an order" (5 minutes).

---

## The services

| Service | Local port | What it does |
|---|---|---|
| api-gateway | 8080 | The front door. Admin login, rate limits, forwards only the public `/api/...` routes, serves the dashboard page. |
| order-service | 8081 | Orders and their status. Sends order events to SQS. |
| inventory-service | 8082 | Products and stock holds (reserve, release, commit). |
| payment-service | 8083 | Charges, refunds, ledger. The card provider is simulated and declines about 1 in 10 charges. |
| notification-service | 8084 | Records notifications, each once. No email provider yet, so nothing leaves the system. |
| shipping-service | 8085 | Shipments, created from the order's address, and the signed carrier webhook. |
| worker | none (health on 8090) | Reads the queue and drives each order through its steps. |
| scheduler | none | Timed jobs: expire stock holds (every minute), cancel abandoned orders through order-service (every 5 min), payment retries (15 min), clean up old rows (30 min), digest (hourly). Run 1 replica only. |
| dashboard-api | 8086 | The admin page and its reports. |

Also running: Postgres (5432), Redis (6379, used by the rate limiter) and Floci (4566, a local stand-in for AWS).

Only 8080 is the real way in. The other ports are open on your machine so you can call one service directly while debugging. On EKS only the gateway will be reachable from outside.

```
 browser or curl
       |
       v
 api-gateway :8080 ------ redis (rate limits)
       |
       +--> order-service ---- saves order + event together ----> postgres
       |          |
       |          | relay sends the event (about 1 second)
       |          v
       |    SQS queue "order-events" ----> worker ----> inventory, payment, order-service
       |          |
       |          | after 3 failed tries
       |          v
       |    "order-events-dlq"
       |
       +--> inventory, payment, shipping, notification, dashboard-api
```

All services use the same Postgres instance.

---

## The order journey in 6 steps

1. The customer places an order through the gateway. order-service saves it as `pending`, together with its event, in one database transaction.
2. order-service sends the event to SQS, usually within a second.
3. The worker picks it up and asks inventory to hold the stock.
4. The worker asks payment to charge.
5. The worker marks the order `confirmed`.
6. The worker tells inventory to commit the held stock. The items are now sold.

If the stock is short or the card is declined, the worker undoes what it did and cancels the order. The details are in How an order flows.

---

## What changed in Sprint 2

| Problem | Fix | Ticket and PR | Read more |
|---|---|---|---|
| Events were only logged, so orders stayed pending | Outbox and SQS publisher | ALPHA-44, #23 | How an order flows, ADR 0001 |
| The worker never read the queue | Worker consumer, which checks the order's status before each run | ALPHA-45, #33 | How an order flows |
| A retried message could charge twice, hold stock twice, push `reserved` below zero, or let confirm and cancel both win | Database rules make every step safe to repeat | ALPHA-51, #31 | How an order flows, ADR 0002 |
| Sold stock came back on sale after 15 minutes | Stock commit | ALPHA-77, #32 | How an order flows |
| The rate limiter never limited anyone, and login had no limit | Limit by user and by real IP | ALPHA-73, #25 | Gateway and dashboard, ADR 0003 |
| Dashboard broken on 8086 and empty on first load | Serve it through the gateway | ALPHA-48, #29 | Gateway and dashboard |
| No way to see which service holds database connections | Connection names and pool metrics | ALPHA-74, #24 | Run, build, test |

Earlier groundwork: Dockerfiles for all 9 services (ALPHA-56, #15) and Floci for local AWS (ALPHA-61, #3).

---

## What changed in Sprint 4 (app hardening, ALPHA-81)

| Problem | Fix | Read more |
|---|---|---|
| Orders stopped at `confirmed`, nothing was shipped or emailed | Status events drive shipments and emails, each once | How an order flows |
| The client set the price | Prices come from inventory | ADR 0007 |
| A retried order request made a second order | `Idempotency-Key` on `POST /orders` | ADR 0008 |
| Any email and password logged in, and sign-up gave anyone a token | One admin login, password from a GitHub secret into Secrets Manager; sign-up closed | Gateway and dashboard, ADR 0009 |
| A client could send its own `X-User-Email` and `X-User-Role` | The gateway deletes them and sets its own | Gateway and dashboard |
| Charge, refund, reserve, restock and send email were reachable from the internet | Only public routes are forwarded, the rest get 404 | Gateway and dashboard |
| Anyone could call the carrier webhook and mark parcels delivered | Calls must be signed with a shared secret | ADR 0010 |
| Product names or notes could run code in the admin's browser | Everything from the API is shown as text | Gateway and dashboard |
| A dashboard button confirmed orders without payment | Removed | |
| Every shipment had a placeholder address | Orders take a shipping address | How an order flows |
| The scheduler cancelled orders behind order-service's back, so no refund or restock | It asks order-service, which refuses if the order moved on | How an order flows |
| A hold expiring mid-payment could lose stock or give it back twice | One side claims the hold in the database; the worker holds again or refunds | How an order flows |
| Times compared wrong when a server wasn't on UTC | Postgres works out every cut-off | How an order flows |
| Old rows were kept forever, with customer emails and addresses in them | Retention rules in the scheduler | How an order flows |
| Redis had no password | Password from Secrets Manager | Redis in the cluster |
| A retried card charge could be declined first and approved on the retry | `Idempotency-Key` on `/charge`; the worker sends the same key on every retry | ADR 0008 |
| Requests with a bad token were never counted, and services saw Traefik's `ip:port` as the client | Bad tokens count against the real client IP (429 after 20 a minute); the client chain is kept, and a forged one is dropped | Gateway and dashboard |
| No browser protection headers | Content-Security-Policy and friends on every response; the page's code moved to `app.js` | Gateway and dashboard |
| Any pod in the cluster could connect to Redis | NetworkPolicy: only api-gateway may connect; the VPC CNI network policy agent is turned on | Redis in the cluster |
| Worker and scheduler were missing from the Services tab | dashboard-api asks their health ports from inside the cluster | Gateway and dashboard |
| Payment and shipping logged "Event -> SQS" but sent nothing | The log now says the event is only logged | |
| Nobody would notice a message stuck in the DLQ | CloudWatch alarm and a runbook | DLQ runbook |

---

## Not built yet

Each of these was looked at and left on purpose. The reason is next to it.

| Item | Why it is not built | What it would take |
|---|---|---|
| Customer accounts, and "a customer only sees their own orders" | The only screen is the admin dashboard, so every login is the admin and an ownership check has nothing to check. | A user table with Argon2id password hashes (OWASP), sign-up, then filter orders and payments by `X-User-Email` for role `customer`. |
| Each service with its own database login | All services connect as one user. The tables split cleanly (checked in the code on 8 Oct): each service writes only its own, dashboard-api only reads (orders, payments, products, shipments), and the scheduler reads and cleans across them. Doing it needs a role and a secret per service, created on both the in-cluster dev Postgres and RDS, while both are being rebuilt this week. | One Postgres role per service with grants from that list; dashboard-api read-only first, because it is the easiest and touches the most tables. |
| Money handled as a float in Go | Postgres stores every amount as an exact `DECIMAL`. Go adds up in floats and rounds each total to the penny before saving. | Integer pence in Go. It touches every service and the ledger, so not this late. |
| Payment and shipment events through an outbox | Those events are only written to the log. Nothing consumes them, so nothing can be lost. | Use the outbox (ADR 0001) the day something consumes them. |
| De-duplicating events by id | Every step is safe to repeat (ADR 0002), so a duplicate changes nothing. | A processed-events table, if a step ever stops being safe to repeat. |
| Customer email on orders | Orders belong to whoever is logged in, so today that is the admin's email. | Comes with customer accounts. |
| Locking the admin account after failed logins | Login is limited per IP (20 a minute in the gateway). A per-account lockout would let anyone lock out the only admin, so the per-IP limit and a long password are the guards. | A per-account slow-down instead of a lockout, with customer accounts. |
| Redis traffic encrypted (TLS) | Inside the cluster only, and the NetworkPolicy limits who can connect. Redis holds counters and hashed IDs. | Redis TLS plus the gateway's client config. |
| `Strict-Transport-Security` | Dev uses a staging certificate; HSTS would lock browsers out until the real one is in place. | Add at Traefik with production certificates. |

---

## Words you'll see

| Word | Meaning here |
|---|---|
| Event | A small JSON message saying something happened, like `order.created`. |
| Outbox | The `order_outbox` table. Events are saved here with the order, then sent. |
| Relay | The loop inside order-service that sends outbox rows to SQS. |
| At least once | SQS always delivers, but sometimes delivers the same message twice. |
| Safe to repeat | Doing the same call twice has the same result as doing it once. Also called idempotent. |
| Hold (reservation) | Stock set aside for an order. It expires after 15 minutes unless committed. |
| Commit | Turning a hold into a sale. Stock goes down for good. |
| DLQ | Dead letter queue. Where a message goes after 3 failed tries. |
| Visibility timeout | How long SQS hides a message from others while one worker handles it. |
| Long polling | Asking SQS to wait up to 20 seconds for a message instead of answering empty straight away. |
| Floci | A local program that pretends to be AWS, so we can run SQS on a laptop for free. |

---

## Reading path

| Time | Read | You should now know |
|---|---|---|
| 5 min | This page | What each service does and what Sprint 2 fixed |
| 15 min | How an order flows, up to "Rules that must stay true" | The full order journey, what happens on failure, what not to break |
| 30 min | Run, build, test: "Place an order". Then Gateway and dashboard, top section | How to run it, watch an order confirm, and why 8080 matters |
| Deeper | Order events queue (SQS) | How the queue is set up in AWS and what the app needs from it |
| Deeper | Redis in the cluster | Where the rate-limit counters live on EKS, and what happens when Redis restarts |
| Deeper | The ADRs | The options we weighed and why we picked what we did |
| When paged | DLQ runbook (`docs/sqs/dlq-runbook.md`) | What to do when the DLQ alarm fires |
