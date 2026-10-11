# ADR 0006: Run Redis in the cluster, with a small disk

**Status:** Accepted, 4 Oct (ALPHA-89). On branch `alpha-89-redis`, not merged, not deployed.
**Decision in one line:** the gateway's rate-limit counters live in one Redis pod inside the cluster, run as a StatefulSet with a 1Gi encrypted gp3 disk and its write log (AOF) on.

## Context

**What Redis does here.** Only api-gateway uses it. Each request adds 1 to a counter per user or IP, and the counter expires after 60 seconds. If Redis doesn't answer within 100 ms, the request goes through (ADR 0003). Losing everything in Redis costs one minute of fresh allowances and nothing else.

**What the client asked for.**

- The project brief: "PostgreSQL and Redis running in the cluster with persistent storage".
- Mo's eks-v2 README, the graded checklist: Redis as a StatefulSet with AOF on a 10Gi encrypted gp3 volume, and volumes that survive pod restarts.

**What the stakeholders asked for (24 Sep).**

- AWS spend is capped at $200, and cost is the first thing graded.
- Zero loss of order and payment data.
- Multi-AZ and disaster recovery designed, not necessarily built.

**The team's existing pattern.**

- Postgres moved from the cluster to RDS on 29 Sep, because losing orders and payments costs money.
- Platform tools install through ArgoCD, one Application each (ADR 0005).
- docker-compose runs Redis locally, and the gateway's limiter tests ran against it (ADR 0003).

**How it came up.** ALPHA-89 was written for ElastiCache, on the idea that nothing stateful should stay in the cluster once Postgres left. On 3 Oct Naima asked for a comparison with the README's StatefulSet before building, and argued for it: we had no StatefulSet anywhere, it costs nothing extra, and it keeps the hop inside the cluster.

**What limits us.** Everything is due Fri 9 Oct. The CI role has no `elasticache:*` permission today.

## Options

| Option | What it is | Cost | For | Against |
|---|---|---|---|---|
| **A. StatefulSet with a small disk and AOF (chosen)** | One Redis pod with its own encrypted disk and write log | About $0.09 a month for 1Gi of gp3 (London, $0.0928 per GB a month) | Meets the client's wording. No new AWS permissions: the EBS CSI driver is already installed. | The app doesn't need the disk. The disk ties the pod to one AZ. One more thing to clean up before `terraform destroy`. |
| B. Deployment with no disk | The same pod, keeping nothing across restarts | Nothing | Exactly what the app needs. Least to build. Can run in any AZ. | Departs from "persistent storage" in the brief, so it needs sign-off from Saad or Mo. |
| C. ElastiCache | AWS runs Redis outside the cluster | About $13 a month for one `cache.t4g.micro` in London ($0.018 an hour running Redis; about $10.50 a month running Valkey) | Nothing to patch. Terraform owns it, so destroy removes it. | New module, subnet group, TLS, auth token and CI permissions. Outside the client's wording. The app uses nothing it adds. |

The cost gap is about $13 a month against a $200 cap. It didn't decide this on its own.

## Decision

**A.** In order of weight:

1. **The client wrote it down.** The brief and the README both ask for Redis in the cluster with persistent storage. A is the only option that meets the wording without going back to the client.
2. **Managed Redis protects nothing here.** Postgres went to RDS because its data is worth money. Redis holds a tally that expires in 60 seconds, so replicas, backups and patching guard nothing we care about.
3. **It is cheap to meet.** The extra work is a StorageClass, a volume template and two Redis flags. The disk costs cents a month.
4. **AOF and the disk come as a pair.** A log on a disk that dies with the pod restores nothing, so both are on or both are off. The app would be fine with both off (B). The written requirement tips it to both on.

The settings and the smaller choices (Redis not Valkey, the exact image tag, 1Gi, no password, the namespace manifest, plain YAML instead of a chart) are in "Redis in the cluster", section 4.

## Consequences

- **A restart is a short gap with no rate limiting.** Orders carry on. Reschedule time isn't measured yet.
- **The disk ties Redis to one AZ.** If no node is free there, the pod waits until Karpenter adds one.
- **Terraform doesn't know about the disk.** `whenDeleted: Delete` removes it only when the StatefulSet is deleted, and the destroy workflow doesn't do that today. The teardown follow-up to ALPHA-95 has to.
- **1Gi, not the README's 10Gi.** We meet the intent (persistent, encrypted, gp3), not the number. Matching it would cost about $0.84 a month more.
- **No snapshot or restore yet.** The checklist line "snapshot taken and restored" stays unmet until a follow-up ticket adds the EBS snapshot controller.
- **No password, no TLS, no network policy.** Any pod in the cluster can reach Redis. It holds hashed IDs and counters, no card data.
- **This depends on the gateway failing open.** If a route ever starts blocking requests when Redis is down, a single pod becomes a weak point.

## How we know it works

On a laptop with Docker, 4 Oct:

- the container runs as uid 999 and gid 1000 with a read-only root filesystem and all capabilities dropped;
- a key set with a 300 second expiry survived a restart and came back with 299 seconds left;
- `kubeconform -strict` accepts all 5 resources.

In the code (`services/api-gateway/main.go`): any Redis error or a reply slower than 100 ms lets the request through.

Not deployed yet. The proof after the first deploy: the gateway logs "Redis connected for rate limiting", `gateway_rate_limit_decisions_total` shows both `allowed` and `limited`, and a counter is still there after `kubectl delete pod redis-0`.

## Revisit when

- A route changes from failing open to failing closed. Look at C.
- Per-IP limits move to Traefik (ADR 0003).
- Traffic grows towards the 10k-user scenario. A replica or a managed cache comes next.
- Saad or Mo confirms Redis needs no persistent storage. Drop to B.
- The team decides Redis needs a password.

## Sources

- Official docs:
  - [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
  - [Kubernetes StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
  - [AWS EBS pricing](https://aws.amazon.com/ebs/pricing/) and [ElastiCache pricing](https://aws.amazon.com/elasticache/pricing/), London (eu-west-2) rates checked 4 Oct
  - [EKS snapshot controller](https://docs.aws.amazon.com/eks/latest/userguide/csi-snapshot-controller.html)
- Inside the project:
  - the project brief and Mo's eks-v2 README (the Redis wording and checklist);
  - the stakeholder assumptions (24 Sep);
  - ADR 0003 and ADR 0005;
  - the RDS decision (29 Sep);
  - ALPHA-89 and the 3 Oct call with Naima;
  - `services/api-gateway/main.go`, and the Docker and kubeconform runs of 4 Oct.
