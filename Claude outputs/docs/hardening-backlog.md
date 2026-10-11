# Hardening backlog (app)

Rule we're working to (24 Sep): **fix first, then harden.** A fix is anything that stops the flow finishing, or leaves data wrong, for honest users on a normal day. Hardening is anything that only breaks under attack, heavy load or a rare failure. Everything below works today for normal use; each item says why it waits and where the evidence is.

Source for each item: app inspection 23 Sep (§ numbers), the fix work 24–25 Sep, or official docs as linked.

## Identity and access
| Item | Why it can wait | Evidence | Ticket |
|---|---|---|---|
| Real login and a user store | Login accepts any email/password; no users table exists. Needed before anything below can be per-person. Multi-day. | §1.6 | App issue (Notion) |
| Authorization gaps: customers can read/advance other customers' orders, create products, refund any payment, read the full ledger | Needs real identity first | §2.7, §2.9 | ALPHA-46 |
| Client-controlled order pricing (total and negative quantities come from the request) | Needs server-side price lookup | §2.9 | ALPHA-47 / ALPHA-50 |
| Shipping webhook has no authentication | Only matters once a real carrier calls it | §2.9 | ALPHA-49 |
| Hardcoded JWT secret fallback | Compose always sets `JWT_SECRET`; becomes a secret-manager item on EKS | §1.5 | App issue (Notion) |
| Postgres app role is a full superuser | Least privilege / PCI; no functional impact | Capacity work 24 Sep | — |

## Rate limiting (interim design shipped in ALPHA-73)
| Item | Why it can wait | Evidence | Ticket |
|---|---|---|---|
| **Dashboard gets its own identity and limit** | All dashboard tabs log in as `admin@platform.local`, so they share one per-user bucket (120/min). Mitigated now by refreshing every 30 s instead of 10 s (3 tabs = 48/min). Proper fix = per-client limits once real staff logins exist. | Dashboard: 8 data calls per refresh. AWS Well-Architected: throttling "can be configured per-client" ([REL05-BP02](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_mitigate_interaction_failure_throttle_requests.html)); Grafana enforces a minimum refresh interval to protect the backend ([docs](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/)) | — |
| **Shared-IP logins** | Login is limited per IP (20/min). Many shoppers behind one carrier or office IP could hit it on Black Friday. Watch `gateway_rate_limit_decisions_total{result="limited"}` before changing the number. | Capacity model | — |
| Move per-IP limiting to Traefik (distributed, token bucket) | Needs Traefik on EKS. Traefik groups by IP or header and can share limits across replicas via Redis ([docs](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/ratelimit/)) | Decision D1a | — |
| Fixed window allows a double burst at the window edge | Known trade-off of the interim design | Decision D2 | — |
| Gateway overwrites `X-Forwarded-For` with `ip:port` when forwarding; invalid tokens aren't limited; the "limited" log line isn't throttled | Cosmetic / low risk | ALPHA-73 review notes | — |

## Payments and orders
| Item | Why it can wait | Evidence | Ticket |
|---|---|---|---|
| `Idempotency-Key` replay on `/charge` (Stripe / IETF pattern): replay the saved result including failures, 422 on a changed request | The one-completed-charge rule already stops double charges; this adds exact replay | ALPHA-51 decision 24 Sep | ALPHA-51 (moved out) |
| Refund is not safe to repeat or run concurrently | Only reachable once cancellation handling exists | §2.7 | ALPHA-78 |
| Ledger doesn't balance after a refund (one credit row, no debit) | Reporting only | §2.7 | — |
| Payment and shipping still only log their events (no outbox) | Nothing consumes them yet | ALPHA-44 split | ALPHA-44 (remaining) |
| Sent outbox rows are never cleaned up; payloads hold customer email | Growth + GDPR-style retention | Outbox ADR | — |
| Worker de-duplication by event `id` | Every step is already safe to repeat | ALPHA-45 scope | ALPHA-78 |

## Scheduler
| Item | Why it can wait | Evidence | Ticket |
|---|---|---|---|
| Not safe with more than one replica (each job runs per pod and on every start) | Run 1 replica until fixed | §2.11 | — |
| Writes directly to orders/products/reservations, bypassing the owning services | Works; makes consistency harder | App issue (Notion) | App issue |
| Expiry can race with release or commit at the 15-minute mark (both subtract `reserved`); `GREATEST(…,0)` hides it | Needs a hold that expires exactly while being committed | §2.4, ALPHA-77 | — |
| Timezone bug: `TIMESTAMP` columns vs process-local time | Can't trigger inside containers (all UTC) | §2.2 | — |
| Failed-payment retries, daily digest delivery | Features; digest also counts refunds as revenue | §1.3, §1.4, §2.5 | App issues |
| Notifications never render or send | Feature | §2.8 | ALPHA-78 |

## Capacity and operations
| Item | Why it can wait | Evidence | Ticket |
|---|---|---|---|
| Pool sizes / connection budget / PgBouncer | Decide from the k6 runs; hot-row contention, not connection count, drove waits so far | Capacity plan, 24 Sep contention test | ALPHA-74 |
| SQS in Terraform: visibility timeout ≥ 60 s, DLQ retention longer than the queue | Local queue already set to 60 s | ALPHA-45 | Infra (SQS module) |
| DLQ redrive runbook | Proven locally: `aws sqs start-message-move-task` re-processed a stuck order in 10 s | Evidence log 24 Sep | Runbook |
| Worker starts before the queue exists locally (one failed poll, recovers in 5 s) | Local only; Terraform creates the queue on EKS | Evidence log 24 Sep | — |