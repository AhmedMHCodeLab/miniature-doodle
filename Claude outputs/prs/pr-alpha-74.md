## Description

First step of the capacity baseline: make database connections visible, so the load test can tell us whether we need smaller pools, a connection budget, or a pooler (PgBouncer). No behaviour change for users.

**Changes**
- `docker-compose.yml`: sets `PGAPPNAME` on the seven services that use Postgres. The driver sends it as `application_name`, so `pg_stat_activity` shows which service owns each connection.
- inventory-service: new `metrics.go` with a `/metrics` endpoint on a **separate port** (`METRICS_PORT`, default 9090; host 9092 locally). The gateway proxies `/api/inventory/*` to the app port, so a separate port means it can never expose metrics to the internet.
  - Reports Go runtime metrics plus the DB pool stats: connections open / in use / idle, and how often and how long requests waited for a free connection (`go_sql_wait_count_total`, `go_sql_wait_duration_seconds_total`).
- `go.mod`: adds `prometheus/client_golang` v1.23.2; Go directive 1.22 → 1.23.0.

**Breaking change:** none.

**Not in this PR (ALPHA-74 stays open):** order-service metrics, the k6 script, the L1–L3 runs and the pool decision.

## Ticket Link

Ticket: [ALPHA-74](https://app.plane.so/production-simulation/browse/ALPHA-74/)

Plan: "Capacity model and load-test plan" (Plane page).

## Screenshots / Evidence

- `curl -s localhost:9092/metrics | grep go_sql_` returns the pool metrics.
- Connections per service: `SELECT application_name, state, count(*) FROM pg_stat_activity GROUP BY 1,2;`
- First finding with these metrics: 600 reservations, 60 at a time, straight to inventory-service.
  - All on one product: about 570 of 600 waited for a DB connection.
  - Spread over 60 products: 0 waited.
  - So a hot row, not the number of connections, drives the waiting.

## Checklist

- [ ] Tests passing locally — no new tests; checked by hand as above
- [ ] Lint/format checks passing
- [ ] Terraform plan reviewed (if infra change) — n/a, no infra change
- [x] Docs updated (if needed) — capacity plan
- [ ] Breaking change — noted in description — none
