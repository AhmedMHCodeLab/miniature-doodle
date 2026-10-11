# Capacity model and load-test plan

**Status:** Draft. Journey mix, rate-limiter approach and provisional SLOs confirmed by Ahmed on 24 Sep.
**Date:** 24 Sep 2026
**Author:** Ahmed

**Purpose:** Decide, from evidence, whether the platform needs smaller DB connection pools, a total connection budget, a connection pooler (PgBouncer), or none of these. This doc fixes the traffic we test with *before* any k6 script exists, so the numbers can't drift to fit the results.

## 1. Assumptions

Every number here is labelled with where it comes from. None is measured user data: we have no analytics yet.

| # | Assumption | Value | Source / type |
|---|---|---|---|
| A1 | Registered user base | 1,000 | Stakeholder baseline |
| A2 | Share online at the same time, normal evening | 20% → **200 concurrent shoppers** | Planning assumption (not an industry fact) |
| A3 | Time between one shopper's actions ("think time") | **~20 s** | Synthetic assumption |
| A4 | Black Friday multiplier | **×10** | Stress-test assumption, not a forecast |
| A5 | Staff dashboard tabs open | **3** | Planning assumption |

Derived shopper action rate at normal evening peak: 200 shoppers ÷ 20 s = **10 actions per second**.

## 2. What a "request" is in this system (verified in the repo)

- **There is no shopper frontend in the repo.** The only web page is the ops dashboard. Shopper traffic is therefore modelled as the API calls a shopper app would make.
- **One open dashboard tab** runs `refreshAll` every 10 s, which is about 13 requests, or about **1.3 RPS per tab**. `/dashboard/summary` alone runs 10 SQL queries.
  - Dashboard calls go **directly to dashboard-api**, because its routes don't work through api-gateway (app-inspection §2.10).

## 3. Journey mix (confirmed for the first test)

| Journey | API calls | Calls per action | Share of actions | DB work per call |
|---|---|---|---|---|
| Catalogue browse | `GET /api/inventory/products` | 1 | 40% | 1 read, up to 100 rows |
| Product detail | `GET /api/inventory/products/{id}` | 1 | 45% | 1 read by primary key |
| Checkout | `POST /auth/login` + `POST /api/orders/` | 2 | 5% | login: none; order: 1 transaction, 3 inserts (order, history, outbox) |
| Order lookup | `GET /api/orders/{id}` | 1 | 10% | 1 read by primary key |

Shopper RPS at normal peak = 10 actions/s × (0.40×1 + 0.45×1 + 0.05×2 + 0.10×1) = 10 × 1.05 = **~10.5 RPS**.
Plus staff: 3 tabs × 1.3 = **~4 RPS** (with 10 DB queries per summary call).
**Total ≈ 14.5 RPS**, which matches the ~15 RPS normal-evening level below.

## 4. Load levels

| Level | Target arrival rate | Meaning |
|---|---|---|
| L1 Normal evening | **~15 RPS** | Everyday peak (A2 × A3 × mix + staff) |
| L2 Black Friday | **~150 RPS** | L1 × A4. The shopper mix shifts toward checkout (proposed: checkout 10%, browse 35%), and **a share of checkouts and product views target one "doorbuster" product** (proposed: 30%) |
| L3 Stress / headroom | **~300 RPS** | A deliberately conservative ceiling (2× Black Friday). **Not a forecast.** It exists to find where the system bends. |

## 5. How the tests run

- **Tool: k6, open model.** Use the `constant-arrival-rate` / `ramping-arrival-rate` executors, so requests keep arriving at the target rate even when the system slows down. With the default closed model, virtual users wait on slow responses, the load drops, and results look better than reality (coordinated omission; see the k6 docs).
- **Every request is checked for its status code.** A fast error must never count as a fast success (lesson from 24 Sep: `curl -o /dev/null` hid errors).
- **Shape per run:** 2 min ramp → 5 min hold at the target → 1 min ramp down. Repeat each level 3 times, since laptop results vary.
- **Order of runs:**
  1. L1, 1 replica per service (baseline)
  2. L2, 1 replica
  3. L2, 2 replicas (does throughput rise, or do only connections rise?)
  4. L3, 2 replicas
  5. L2 with SQS stopped (outbox relay holding connections)

## 6. What we measure (all captured during each run)

| Signal | Where | What it tells us |
|---|---|---|
| Latency p95/p99, error rate | k6 | Whether we meet the SLOs |
| `go_sql_wait_count_total`, `go_sql_wait_duration_seconds_total` | service `/metrics` | Requests queuing for a DB connection **inside** the service (invisible to Postgres) |
| `go_sql_in_use_connections`, `go_sql_max_idle_closed_total` | service `/metrics` | Pool usage and connection churn |
| Connections per service and state | `pg_stat_activity` grouped by `application_name` | Total DB connections vs the budget of 97 |
| Lock waits | `pg_stat_activity` where `wait_event_type = 'Lock'` | Hot-row contention |
| Oldest unsent outbox row | `order_outbox` | Event-delivery SLO |

**Pass criteria** are provisional test criteria for the first iteration (not agreed production SLOs):
- `POST /api/orders/` p95 < 500 ms
- error rate < 1%
- 99% of events on the queue within 5 s
- zero `too many connections` errors

## 7. How results map to a decision

| Observation at L2 / L3 | Meaning | Direction |
|---|---|---|
| Low in-use, waits ≈ 0, DB CPU fine | Pools oversized but harmless | Set a total connection budget per service; no pooler |
| Waits rising, Postgres CPU low | Connections held too long | Shorten hold time first (transactions, relay, slow calls) |
| Postgres CPU/IO saturated | DB is the limit | Smaller pools, query/index fixes, bigger DB. A pooler adds no throughput. |
| Lock waits dominate | Hot-row contention | Inventory reservation design change; pooling won't help |
| Many replicas, mostly idle, total near 97 | Idle connections exhaust the budget | PgBouncer justified, after testing lib/pq and the scheduler lock design against transaction pooling |

## 8. Known limits of this test setup (read before trusting a number)

1. **Checkout does not touch inventory today.** Reservations only happen through the worker, which isn't built yet. To model the Black Friday hot-product effect, the L2/L3 scripts add a direct `POST /reserve` per checkout as a stand-in for what the worker will do. This is labelled synthetic.
2. **api-gateway rate limiting is broken in a way that distorts tests.** It counts per client IP *and port*, 100 requests/min. A k6 virtual user reusing one connection above ~1.7 RPS will start getting `429`s. **Decided:** fix the limiter before the main run (§10); k6 still counts 429s separately so any that remain are visible. **Fixed 24 Sep** (interim, gateway-only): per-user limits for logged-in traffic, stricter per-IP limits on login/register/webhook. Because k6 logs in thousands of users from one IP (like an office behind one NAT), the test environment raises `RATE_LIMIT_SENSITIVE_PER_WINDOW`; that setting is recorded with each run's results.
3. **Laptop numbers are for comparison only.** k6, nine services and Postgres share one machine. Capacity numbers come from a short run on the dev EKS cluster.
4. **Login accepts any credentials** (known bug), so test users need no setup, and login cost is lower than it will be once real authentication exists.

## 9. Evidence already collected

On 24 Sep, on the local stack: 600 reservations, 60 at a time, straight to inventory-service.
- **All on one product:** about 570 of 600 waited for a DB connection, every run.
- **Spread across 60 products:** 0 waited.
- Row counts confirmed every request succeeded.

Conclusion so far: at the same traffic, **contention on a hot row** is what drives connection waiting, not the number of connections.

## 10. Decisions (24 Sep)

- [x] Journey mix 40/45/5/10 for normal traffic. Black Friday uses 10% checkout. The hot-product scenario is a **separate, labelled contention test**; the 30% share is not a forecast.
- [x] **Fix the api-gateway rate limiter first, then run all capacity tests through the gateway.** The limiter is part of the system we're designing, so bypassing it would hide a real production problem. A direct-to-service DB test can come later to isolate Postgres.
- [x] Draft SLOs are **provisional test criteria**, not agreed production SLOs.
