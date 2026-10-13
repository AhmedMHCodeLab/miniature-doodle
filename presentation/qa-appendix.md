# Technical Q&A appendix

Likely questions from the panel, with short answers and the evidence behind each. Answer first in one or two sentences, then offer the detail. If an answer depends on something we have not tested, say so before anyone asks.

Evidence labels used below:

- **Code**: true in the repository at commit `4b1c5da` (13 Oct). File paths are relative to the repo root.
- **EKS**: seen working on the dev cluster, with the date.
- **Test**: covered by a Go test or a local drill.
- **Not run**: written, planned or configured, but never exercised.

Appendix slides A1 to A8 carry the diagrams and tables for most of these.

---

## The product and what we built

**What did CoderCo give you, and what did you build?**
CoderCo gave us the Go source for nine services, a compose file and no tests. The order event publisher was a log line and the worker had no queue code, so no order could get past pending. We built the outbox and publisher, the whole worker flow, idempotency in orders and payments, the gateway's route allow-list and rate limiter rework, pricing from inventory, 168 test functions, and everything around the code: Dockerfiles, Terraform, the Helm chart, ArgoCD and the pipelines.
*Code:* upstream `codercohq/eks-v2` at `e19e419`, our import `af985c9` is identical; `services/order-service/outbox.go`, `services/worker/main.go`, `services/*/idempotency.go`, `services/api-gateway/allowlist.go`.
*Do not claim:* graceful shutdown, `/livez`, `waitForDB` and the May bug fixes. Upstream wrote those.

**Why is it called Kit Room?**
We gave the generic order platform one clear use, equipping new starters, so the demo has a story. The API and the order flow are the ones the brief grades: create, reserve, pay, ship, deliver.

---

## Data and state (slides 14, A5)

**The brief says Postgres on a StatefulSet. Why is there RDS at all?**
Dev runs Postgres on a StatefulSet with a 20 Gi encrypted gp3 volume and daily snapshots, which is the brief's requirement and costs only a disk. We wrote staging and prod for RDS because production needs failover, point-in-time restore and patching we would rather not run by hand. Be clear that staging and prod were never deployed, so RDS has never run live.
*Code:* `kubernetes/platform/apps/templates/postgres.yaml` (dev only), `infra/terraform/environments/{staging,prod}/main.tf` (module "rds").
*Note:* `ARCHITECTURE.md` still says "StatefulSet in dev and staging". The code says dev only; the code wins.

**Why one database for seven services instead of one per service?**
An order, its stock hold, its payment state and its outbox event need to commit together or be checked against each other. One Postgres keeps those transactions simple. The cost: one shared database user, and a schema change in one service can affect another (see migrations below).

**Your Postgres pod gets rescheduled to another AZ. What happens to its volume?**
It cannot follow. An EBS volume lives in one AZ, and the StorageClass uses `WaitForFirstConsumer`, so the volume is created where the pod first runs and Kubernetes pins it there. A pod or node failure is fine: the pod comes back on the same volume in the same AZ. If the whole AZ is lost, the pod stays Pending until the AZ returns or we restore the latest snapshot into a new volume in a healthy AZ, losing writes made since that snapshot.
*Code:* `kubernetes/platform/manifests/storageclass-gp3.yaml`. *Not run:* the AZ-loss restore.

**Have you actually restored a snapshot?**
Snapshots are scheduled daily at 01:00 UTC, keeping 7, and the snapshot class was confirmed on the dev cluster on 10 Oct. A restore checked against known data is not in our records, so we do not claim it. The procedure is on slide A5: snapshot, scale to 0, delete the PVC, recreate it from the snapshot, scale to 1, then check known orders are back.
*Code:* `kubernetes/platform/postgres/snapshot-schedule.yaml`, `kubernetes/platform/manifests/volumesnapshotclass-ebs.yaml`.
*Watch out:* the snapshot class uses `deletionPolicy: Delete`, so deleting the VolumeSnapshot object also deletes the EBS snapshot. `ARCHITECTURE.md` says `Retain`; the manifest says `Delete`.

**How do schema changes work? What about rollback?**
Today each service runs `CREATE TABLE IF NOT EXISTS` at start-up. That creates tables but cannot change them and keeps no history. The plan, not built, is versioned migrations with golang-migrate, run as an ArgoCD PreSync Job, using expand then contract so old and new code both work during a rollout. Code rolls back by reverting the tag; schema only moves forward, with a fix-forward migration.

**Adding a column the dashboard reads: how without downtime?**
Expand: add it nullable or with a default. Deploy order-service to write it, backfill, then deploy dashboard-api to read it. Contract in a later release. Every step works with the version before it.

**Redis?**
One pod on a StatefulSet with AOF, used only for the gateway's rate-limit counters. Its volume is 1 Gi, smaller than the brief's 10 Gi, because the counters are tiny and it saves cost. If Redis is down, the gateway fails open: the platform stays up without rate limiting, and a metric records it.
*Code:* `kubernetes/platform/redis/statefulset.yaml`, `services/api-gateway/main.go` (`rateLimited`).

---

## Messaging and order processing (slides 10 to 13, A4)

**Why SQS rather than Kafka?**
The services were written for SQS, it is managed, it costs almost nothing at our volume, and it has retries, visibility timeouts and a dead-letter queue built in. Kafka through Strimzi would mean three brokers on persistent volumes and rewriting the producers. We gave up ordering and replay, and we accepted at-least-once delivery.

**What is the transactional outbox, and why bother?**
Saving the order and sending the event are two systems. If the send fails after the save, nothing downstream ever happens. order-service writes the event row in the same transaction as the order, and a relay sends unsent rows to SQS every second, using `FOR UPDATE SKIP LOCKED` so replicas do not collide. If SQS, or the NAT path to it, is down, orders are still accepted and the events go out when it returns.
*Code:* `services/order-service/outbox.go`. *Test:* `outbox_test.go`.

**Can a customer be charged twice?**
Not by a retry. Four layers absorb repeats: the request's Idempotency-Key, with a primary key on (customer, key); the worker reading the order's status before acting, plus compare-and-set on status changes; a fixed charge key per order and a unique index allowing one completed charge per order; and a dedupe key on every email. Before the fixes we measured 6 payment rows from 6 retries of one charge; now it is 1.
*Code:* `services/order-service/idempotency.go`, `services/payment-service/idempotency.go`, `services/payment-service/main.go` (`uq_payments_one_completed_charge`). *Test:* team fix-evidence log, 23 to 24 Sep; all suites pass with `-race` (re-run 13 Oct). *EKS:* smoke test 8 Oct, "retry with same Idempotency-Key returns the same order".

**What happens to an event that fails three times?**
The worker does not delete a message it failed to handle. SQS hides it for 60 seconds, then delivers it again. On the third failed receive it moves to the dead-letter queue, kept for 14 days. Once the cause is fixed we redrive it, and because every step is safe to repeat the order resumes where it stopped.
*Code:* `infra/terraform/modules/sqs/main.tf` (maxReceiveCount 3, DLQ retention 14 days). *Test:* local drill 24 Sep with payment-service stopped: 3 receives, DLQ, redrive, processed.
*Gap:* the DLQ CloudWatch alarm exists but has no notification target, and redrive is manual.

**payment-service is down for two minutes. What happens to in-flight orders?**
New orders are still accepted, because placing one does not call payment-service. The worker's charge fails, the message returns after 60 seconds, and most orders complete once payment is back. Three failures in a row move a message to the DLQ. Stock stays held for 15 minutes before the scheduler releases it.

**Why not SQS FIFO for exactly-once?**
FIFO deduplication only covers a five-minute window and still needs idempotent consumers once a message is retried after a failure. We do not need ordering, because the worker reads the order's current state. Standard SQS plus idempotent steps is simpler.

**Can processing outrun the 60-second visibility timeout?**
In theory, yes: the worker takes up to 10 messages and works through them one by one. A slow batch could see a message reappear while it is still being handled. Every step is safe to repeat, so the cost is duplicated work, not duplicated charges. Known limit; the fix is to extend visibility or take fewer messages per batch.

**Payment and shipment events?**
Only order events go through the outbox. Payment and shipment events are logged, not queued. That is on our limits list.

---

## Delivery and releases (slides 15, A1, A6)

**A developer pushes a change to payment-service. Walk us through it.**
The PR runs only payment-service's job: go vet, go test with the race detector, docker build and Trivy, which fails on HIGH or CRITICAL. On merge, the image is built once and pushed to ECR as `payment-service-<sha>`, and a GitHub App commits that tag to the dev values file. ArgoCD sees the change and syncs only payment-service-dev. Argo Rollouts sends 50% of pods to the new version, checks error rate and p95 latency in Prometheus, then goes to 100%.
*Code:* `.github/workflows/ci.yaml`, `kubernetes/platform/apps/templates/order-platform.yaml`, `kubernetes/charts/microservice/templates/deployment.yaml`, `analysis-template.yaml`.
*Be honest:* the canary landed last, in the 13 Oct sync. It has not been tried against a bad release, and with no traffic its checks pass by default (the template says so in a comment).

**How do app deploys and infra changes stay out of each other's way?**
Different paths trigger different pipelines. `services/` runs the application pipeline; `infra/` runs Terraform plan on PRs and a manual apply of a saved plan. They share nothing except the image tag ArgoCD reads from Git. Terraform state is split into three stacks (bootstrap, infrastructure, ArgoCD bootstrap) so an ArgoCD change cannot plan a VPC change.

**A junior pushes a bad image for notification-service. How fast can you roll back? Does ArgoCD help?**
New pods fail readiness and the old ones keep serving. Rollback is reverting one tag commit; ArgoCD syncs only notification-service and the other eight see no diff. It is about as fast as one rollout, since the old image is still in ECR (immutable tags, newest 40 kept). ArgoCD helps: Git shows exactly which commit to revert. It costs a little speed, because ArgoCD has to notice the commit.
*Not run:* we have not drilled a deliberate bad release.

**Zero-downtime releases?**
It is an aim, not a claim. The chart uses `maxUnavailable: 0`, readiness probes, PodDisruptionBudgets and a 5-minute progress deadline. But on 10 Oct a 30 to 60 second blip during an ArgoCD sync was never explained, so we do not claim zero downtime.

**Why Helm over Kustomize?**
Nine services with nearly identical needs. One chart means a security or probe fix reaches all nine at once, and `values.schema.json` rejects mistyped values. The chart refuses to render the scheduler with more than one replica or an HPA. The cost: templates are harder to read and one chart bug reaches every service, which is why CI renders every service and validates it with kubeconform.

**One ECR repository? The brief says one per service.**
One shared repository, `eks-v2-shared-ecr`, with tags `<service>-<sha>`, immutable tags, scan on push and a lifecycle rule keeping the newest 40 images. One push role and one lifecycle policy instead of nine. It departs from the brief's wording; per-service repositories would give per-service permissions and retention.
*Code:* `bootstrap/main.tf`, `bootstrap/policies/ecr-lifecycle.json`.

**Is prod running? Why one AWS account?**
No. Staging and prod are fully defined (own VPC, cluster, state, GitHub Environment and IAM role) and plan cleanly, but have never been deployed. Dev is the environment that has run, and it is torn down between sessions to save cost. One account because cross-account access for the shared ECR, the Route 53 zone and the state did not fit the time we had.

---

## Security (slides 17, A2, A7)

**How do GitHub Actions get into AWS?**
OIDC to a role per environment. The trust is pinned to our organisation and repository IDs and to the GitHub Environment name, so another repo or branch cannot assume it. Pull requests use a read-only plan role. Staging and prod only apply a plan made on main, and a prod apply waits for an approver other than the person who started the run.
*Code:* `bootstrap/github-actions-roles.tf`, `.github/workflows/terraform-apply.yaml` (`exclude-workflow-initiator-as-approver: true`).

**Why Pod Identity, not IRSA?**
Same intent: each workload gets its own narrow role. Pod Identity roles trust `pods.eks.amazonaws.com`, so we do not need an OIDC provider per cluster, and the association sits in Terraform next to the role. order-service may only `sqs:SendMessage`; the worker may only receive and delete. IMDSv2 with a hop limit of 1 stops pods borrowing the node role. The cost: it departs from the brief's wording, needs the agent add-on, and does not work on Fargate.
*Code:* `infra/terraform/modules/pod-identity/main.tf`.

**How do secrets reach a pod? What happens on rotation? Do all nine restart?**
Terraform writes them to Secrets Manager under a customer-managed KMS key. External Secrets, the only reader, syncs them into one Kubernetes Secret per service every 15 minutes, and the pod loads them as environment variables. On rotation, Reloader (configured for Argo Rollouts) restarts only the workloads that use the changed Secret, one pod at a time: a JWT rotation restarts api-gateway only, a database password restarts the seven database services. The gap: until the refresh lands, new connections from old pods fail.

**Login accepts any email. Isn't that a hole?**
Yes, and it is first on our limits list. The provided gateway issues a token for any email and password, and any signed-in user can list every order. We hardened the edge instead: a required JWT secret, rate limits on login and bad tokens, and internal routes refused from outside. Real accounts and ownership checks come before any real user.
*EKS:* smoke test 8 Oct, internal routes return 404 from outside (before the fix they reached the services).

**What else would you fix first?**
One shared database user; Redis with no password, NetworkPolicy or TLS; an unsigned carrier webhook; no CSP or HSTS; money summed as floats; a Let's Encrypt staging certificate in dev. All on slide A7.

---

## Scaling, load and cost (slides 16, A3, A8)

**What scales, and on what?**
The seven HTTP services use a CPU HPA at 70% (dev: gateway 2 to 3 pods, the others 1 to 3). The worker is fixed at one pod; queue depth through KEDA is the better signal and is next. The scheduler never scales: the chart refuses it, because a second pod would run every job twice. Karpenter adds on-demand nodes above three t3.medium base nodes, capped at 16 vCPU and 64 GiB.

**What breaks first under load? Did you load test?**
We did not run a load test. The k6 plan and scripts exist in `tests/load/` but were never executed, so the following is reasoned from configuration: database connections break first, because the seven pools allow 115 connections against Postgres's default of 100, and each extra pod adds up to 25. Then the single Postgres writer. Our first next step is to run the plan and size pools or add PgBouncer from what it shows.

**Spot instances?**
The NodePool is on-demand only. Postgres, Redis and the scheduler each run as a single pod and cannot tolerate eviction. The stateless services and the worker could; a separate spot pool for them is a cost lever we did not take.

**How much did you spend? Why keep a NAT gateway?**
About $50 of AWS by 10 Oct, mostly EC2, against the $200 cap. That is the latest figure in our meeting records; give the final bill if you have it. The hourly costs are the EKS control plane, three base nodes, the NAT gateway and the NLB, which is why we tear dev down when idle. One NAT stays because GitHub, Let's Encrypt and public registries cannot be reached through VPC endpoints at all, and doing the AWS APIs through interface endpoints would mean at least 6 services across 3 AZs, 18 billed endpoints every hour. The trade-off: one AZ outage cuts outbound traffic everywhere, which the outbox turns into delay rather than lost orders.

**Logging cost?**
The EKS control plane sends five log types to CloudWatch, kept 30 days. Application logs are not shipped anywhere; they stay in the pods. A cheaper control-plane setup would keep only audit and authenticator logs. Metrics come from Prometheus in the cluster.

**It's 2am and orders are failing. How do you find out what's wrong?**
Grafana has a platform overview and a per-service detail dashboard, and Prometheus has alert rules for service down, error rate, p95 latency, worker event failures, Redis errors in the limiter, crash loops and node health. Alertmanager sends to Slack in prod only. Each environment's Grafana gets its own hostname through Traefik (ALPHA-124). Gaps: no tracing, and application logs are not centralised.
*Code:* `kubernetes/charts/monitoring/`, `kubernetes/helm-values/envs/prod/prometheus-values.yaml`.

---

## Process

**What would you do differently?**
Run the load test before choosing pool sizes and node caps, and stand staging up earlier so RDS, promotion and a restore drill had a real place to run. We also spent days moving between Postgres options; deciding by environment earlier would have saved them.

**What went wrong during the project?**
On 6 Oct the cluster became unreachable mid-demo because the pipeline role had no EKS access entry; we fixed it by hand and then put it in Terraform so a rebuild cannot repeat it (ALPHA-120). On 5 Oct Docker Hub pull limits broke builds; base images now come from ECR Public. The 10 Oct sync blip is still unexplained.
