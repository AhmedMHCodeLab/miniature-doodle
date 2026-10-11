# Redis in the cluster

Describes: `main` with Redis merged (ALPHA-89, PR #54) and its password added in the app hardening (ALPHA-81, 8 Oct).

This page covers the Redis that api-gateway uses for rate limiting: what it holds, how it runs on EKS, what happens when it fails, and why it looks like this.

- One Redis pod, `redis-0`, in namespace `order-platform` next to the 9 services. ArgoCD installs it from plain manifests in `kubernetes/platform/redis`.
- Only api-gateway uses it. Each request adds 1 to a counter, and the counter deletes itself after 60 seconds.
- Redis writes every change to a log on a 1Gi encrypted disk, so a restarted pod comes back with its counters.
- If Redis is down or slower than 100 ms, the gateway lets the request through. Orders never wait on Redis.
- Redis requires a password, kept in Secrets Manager. No disk snapshot yet; see "What we accepted".

Stop here if you only need the shape. Below: one request end to end, the failure cases, the rules you must not break, and why it is built this way.

---

## 1. One request, end to end

Sara is logged in. She sends her 121st request inside one minute.

```
Sara --> Traefik --> api-gateway ----------------------> Service "redis" (order-platform, port 6379)
                        |  key rl:user:<hash of Sara's ID>          |
                        |  one Lua script: add 1, and start a       v
                        |  60 s expiry if the key is new         redis-0 (the pod)
                        |                                           |  appends the write to its log
                        |<------------------ count = 121 ---------- |  on /data (1Gi gp3 disk)
                        v
                 limit is 120 a minute, so Sara gets
                 429 Too Many Requests, Retry-After = seconds left in the window
```

Her first 120 requests go through. The 121st gets 429. Sixty seconds after her first request the key expires and she starts again from 0.

The limits come from ADR 0003:

- 120 a minute per logged-in user (`rl:user:...`);
- 60 a minute per IP when not logged in (`rl:ip:...`);
- 20 a minute per IP on login, register and the shipping webhook (`rl:sensitive:...`).

IDs are hashed before they reach Redis, so it holds no emails or IP addresses.

The gateway finds Redis through `REDIS_URL: redis://redis:6379` in `kubernetes/deploy/services/api-gateway/values.yaml`. The short name `redis` only works inside the same namespace, which is why Redis lives in `order-platform`.

---

## 2. When things go wrong

The gateway never blocks a request because of Redis. Every Redis problem below ends the same way for the customer: the request goes through, just without a rate limit.

| Situation | What the gateway does | What happens to Redis |
|---|---|---|
| The pod restarts (crash, node drain, Karpenter moving it) | Lets requests through until Redis answers | The new pod mounts the same disk, replays its log, and the counters come back with their time left |
| No node is free in the disk's AZ | Lets requests through | The pod stays Pending. An EBS disk lives in one AZ, so the pod can only run there. Karpenter can add a node in that AZ. |
| Redis takes longer than 100 ms | Lets the request through and counts it as `result="redis_error"` in `gateway_rate_limit_decisions_total` | Nothing |
| `REDIS_URL` is not set | Rate limiting is off, one warning at startup | Not involved |
| `REDIS_URL` is malformed | The gateway refuses to start | Not involved |
| `terraform destroy` while Redis is still running | Not involved | The cluster created the disk, not Terraform, so it is left behind and keeps billing. Delete Redis first (the teardown follow-up to ALPHA-95). |

---

## 3. Rules that must stay true

1. The Service is called `redis` and lives in `order-platform`. The gateway's URL depends on both.
2. `--appendonly yes`, `--dir /data` and the disk mounted at `/data` stay together. The root filesystem is read-only, so `/data` is the only place Redis can write, and a log on a disk that dies with the pod restores nothing.
3. `persistentVolumeClaimRetentionPolicy.whenDeleted: Delete` stays. Without it, deleting Redis leaves a billed disk behind.
4. One replica. Two separate Redis pods would each hold half the counts, so every limit would double.
5. The image tag stays exact (`redis:7.4.11-alpine`). Never `latest` or a floating `7`.
6. The `gp3` StorageClass and the `order-platform` namespace come from `platform/manifests` (wave -2), before Redis (wave -1). Redis's ArgoCD app must not create the namespace.
7. The password comes only from Secrets Manager (`eks-v2-<env>-redis-password`), through the `redis-auth` ExternalSecret. Redis reads it from `/etc/redis/redis.conf`, a file mounted from that Secret, so it never appears in the pod's command line. The probes read it from `REDISCLI_AUTH`, the gateway from `REDIS_PASSWORD`. Changing the secret restarts Redis and the gateway through Reloader.

---

## 4. Why it is built this way

**Why in the cluster, not ElastiCache.** The brief asks for "PostgreSQL and Redis running in the cluster with persistent storage", and Mo's eks-v2 README asks for a Redis StatefulSet with AOF on an encrypted gp3 volume. ElastiCache would add a Terraform module, TLS, an auth token, new CI permissions, and about $13 a month for one `cache.t4g.micro` in London ($0.018 an hour running Redis, or about $10.50 a month running Valkey). Postgres moved to RDS because losing orders costs money. Redis holds counters that expire in a minute, so a managed service protects nothing we need. ADR 0006.

**Why keep a disk the app doesn't need.** A StatefulSet is the Kubernetes workload that gives a pod a fixed name (`redis-0`) and its own disk, which follows the pod when it moves. The app would survive losing every counter: the worst case is one minute of fresh allowances. We keep the disk because the client asked for it in writing, and it costs cents. AOF (append-only file) is Redis's write log, replayed after a restart. It only helps if the disk survives, so the two come as a pair. ADR 0006.

**Why 1Gi and not the README's 10Gi.** The counters expire after 60 seconds, so the data is tiny. When Redis compacts its log it writes the new file before deleting the old one, so the disk needs room for two copies, and 1Gi is far more than that. At the London gp3 rate of $0.0928 per GB a month ([EBS pricing](https://aws.amazon.com/ebs/pricing/)), 1Gi costs about $0.09 a month and 10Gi about $0.93.

**Why Redis and not Valkey.** Valkey is a fork that speaks the same protocol. docker-compose runs Redis, and the gateway's Lua script and tests have only ever run against Redis. For the Q&A: Redis 7.4 is licensed RSALv2 or SSPLv1, not BSD ([Redis licences](https://redis.io/legal/licenses/)). We run it inside our own platform, not as a service for others. If that is ever challenged, Valkey is the swap, after running the gateway tests against it.

**Why the exact tag `7.4.11-alpine`.** It is the official image, published 18 Sep 2026 on Docker Hub. An exact tag means a restart can never pull a different Redis.

**Why plain manifests and not a chart.** The other platform tools use an upstream chart plus our values. For Redis we rendered three charts with `helm template` on 4 Oct:

| Chart | What we found |
|---|---|
| Bitnami `redis` 28.3.1 | Its default image gets no new tags on Docker Hub since Bitnami's catalogue change of 28 Aug 2025 ([bitnami/charts#35164](https://github.com/bitnami/charts/issues/35164)) |
| groundhog2k `redis` 2.4.8 | Works, but defaults to a Deployment and adds a 150-line init script, mostly for Sentinel |
| CloudPirates `redis` 0.35.4 | Renders almost the same as our files, but it is pre-1.0 |

Ours is about 60 lines of YAML in two files, with no third-party dependency. The CloudPirates render also caught one gap in ours (the service-account token was mounted), which is fixed.

**Why gp3 is now the cluster default.** On EKS 1.30 and later, AWS stopped marking gp2 as the default StorageClass on new clusters ([containers-roadmap#1330](https://github.com/aws/containers-roadmap/issues/1330)), and ours runs 1.35. Without a default, any claim that names no class waits forever. gp3 is also cheaper: $0.0928 per GB a month in London, against $0.116 for gp2. Prometheus moved from gp2 to gp3 in the same change.

**Why the probes run `redis-cli ping`.** A port check passes while Redis is hung but still listening. Ping only passes if Redis answers a command.

**Why the namespace has its own manifest.** If Redis's ArgoCD app created `order-platform` (`CreateNamespace=true`), Redis would become the accidental owner of the namespace all 9 services share.

**Why Karpenter is allowed to move it.** We left off Karpenter's "do not disrupt" setting. When Karpenter merges nodes, Redis restarts on the same disk and the gateway lets requests through meanwhile. A node that can never be removed would cost more than that short gap.

---

## 5. What we accepted

- A restart is a short window with no rate limiting. How long a reschedule takes is not measured yet.
- The disk lives in one AZ. If that AZ has no free node, Redis waits for one. If the whole AZ is down, Redis is down until it comes back, and the gateway lets requests through meanwhile.
- 1Gi instead of the README's 10Gi. We meet the intent (persistent, encrypted, gp3) and not the number.
- No snapshot or restore yet. It needs the EBS snapshot controller and a VolumeSnapshotClass ([EKS docs](https://docs.aws.amazon.com/eks/latest/userguide/csi-snapshot-controller.html)). The checklist line "snapshot taken and restored" stays unmet until a follow-up ticket covers Redis and Prometheus.
- No TLS. Redis sends the password in clear text inside the cluster. It holds hashed IDs and counters, no card data.
- A NetworkPolicy (`kubernetes/platform/redis/networkpolicy.yaml`) lets only api-gateway pods connect on 6379. It needs the VPC CNI network policy agent, which the eks module turns on (`enableNetworkPolicy`); without the agent a policy is accepted and ignored.
- docker-compose still runs a floating `redis:7-alpine`, so local and cluster Redis are not the same version yet.

---

## 6. How we know it works

Checked on a laptop with Docker on 4 Oct, not on a cluster:

- the image runs as uid 999 and gid 1000, with a read-only root filesystem and all capabilities dropped;
- a key set with a 300 second expiry survived a restart and came back with 299 seconds left;
- `redis-cli ping` exits 1 when nothing is listening, so the probes catch a dead Redis;
- `kubeconform -strict` accepts all 5 resources.

Checked in `services/api-gateway/main.go`: the 100 ms timeout, the three limits, the `rl:<scope>:<hash>` keys, and the behaviour for an unset, malformed or unreachable `REDIS_URL`.

Not deployed yet. After the first deploy, run the checks below.

---

## 7. Reference

### Check it after a deploy

```bash
kubectl get sc                                                          # gp3 (default), nothing else marked default
kubectl -n order-platform get pods,pvc -l app.kubernetes.io/name=redis   # redis-0 Running, data-redis-0 Bound
kubectl -n order-platform exec redis-0 -- redis-cli config get appendonly   # yes (redis-cli uses REDISCLI_AUTH from the pod)
kubectl -n order-platform exec redis-0 -- env -u REDISCLI_AUTH redis-cli ping   # NOAUTH: no password, no access
kubectl -n order-platform logs deploy/api-gateway | grep "Redis connected"
```

To test the disk: set a key with a long expiry, `kubectl -n order-platform delete pod redis-0`, wait for it to come back, and read the key again.

### What is in Redis

| Key | Counts | Limit per 60 s window |
|---|---|---|
| `rl:user:<hash>` | requests from one logged-in user | 120 |
| `rl:ip:<hash>` | requests from one IP when not logged in | 60 |
| `rl:sensitive:<hash>` | login, register and webhook calls from one IP | 20 |

Every key expires 60 seconds after its first request. The limits can be changed with `RATE_LIMIT_*` variables on the gateway. The deploy values don't change them.

### Where the code lives

| What | Where |
|---|---|
| The pod and its disk | `kubernetes/platform/redis/statefulset.yaml` |
| The two Services (`redis`, `redis-headless`) | `kubernetes/platform/redis/service.yaml` |
| The password (`redis-auth`, from Secrets Manager) | `kubernetes/platform/redis/externalsecret.yaml` |
| Where Terraform makes the password | `infra/terraform/modules/secrets-manager/main.tf` |
| The ArgoCD app (wave -1) | `kubernetes/platform/apps/redis.yaml` |
| gp3 StorageClass and the namespace (wave -2) | `kubernetes/platform/manifests/storageclass-gp3.yaml`, `namespace-order-platform.yaml` |
| The limiter | `services/api-gateway/main.go` |
| The URL the gateway uses | `kubernetes/deploy/services/api-gateway/values.yaml` |

Next: ADR 0006 for the options we weighed, or Gateway and dashboard for what the gateway does with the counters.
