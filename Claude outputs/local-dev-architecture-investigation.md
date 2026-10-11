# Local Development Architecture — Investigation and Proposal (Team Alpha)

**Written:** 21 Sep 2026. **Status:** research output, nothing implemented, no repo or git state modified.
**Supersedes:** the local-dev conclusions in `claude/local-dev-investigation-handover.md` §4 Thread 2 and Thread 3. Those were reached before Floci's actual service coverage was read. Two of their load-bearing premises turned out to be wrong.

Labels used throughout: **Verified** (checked against official docs, the repo, or a meeting transcript, with the source named) · **Derived** (a conclusion from verified facts plus a stated mechanism) · **Open question** (needs an experiment).

---

## 0. What changed in my understanding

Two corrections to the handover, both material.

**Correction 1 — Floci EKS is not a token gesture.** The handover called it "partial" and assumed the AWS-specific integrations were all missing. Verified against [Floci's EKS docs](https://floci.io/floci/services/eks/): Floci runs a real `rancher/k3s` container per cluster, exposes the API server on a host port, and `aws eks update-kubeconfig --name <cluster>` followed by `kubectl get nodes` is the documented workflow. More importantly: *"Every cluster gets an OIDC identity provider, so the full IRSA flow (trust policy, service-account token, `sts:AssumeRoleWithWebIdentity`) works end to end."* The [STS docs](https://floci.io/floci/services/sts/) corroborate with specifics — RS256 signature verification against the issuer's key, `iss` exact match, `aud` must contain `sts.amazonaws.com`, trust-policy evaluation including `Principal.Federated` and the `Condition` block.

**Correction 2 — Floci RDS and ElastiCache are real, and that is a trap, not an opportunity.** Verified: [Floci RDS](https://floci.io/floci/services/rds/) *"manages real PostgreSQL, MySQL, MariaDB, and SQL Server Docker containers and proxies TCP connections to them"*; ElastiCache is listed as a real container behind a RESP TCP proxy. So `Terraform → Floci RDS → PostgreSQL` genuinely works. It is still the wrong choice for Alpha, because Verified from the [eks-v2 production README](https://github.com/codercohq/eks-v2): *"PostgreSQL on a StatefulSet with a 20Gi PVC (gp3, encrypted)"* and *"Redis on a StatefulSet with AOF persistence on a 10Gi PVC (gp3, encrypted)"*. Alpha does not use RDS or ElastiCache in production. Emulating them locally would reproduce an AWS service the platform never calls, and would skip the StatefulSet, PVC, probe and persistence behaviour that production actually depends on.

That second correction is the one that reframes the whole question, so it goes first in the model below.

---

## 1. The mental model

### 1.1 The observation that sets the seam

Alpha's production design deliberately keeps its data services inside Kubernetes. Postgres and Redis are StatefulSets on EBS, not RDS and ElastiCache. Run that forward and ask what AWS APIs an Alpha *workload* actually calls at runtime:

| AWS API | Called by | Verified from |
|---|---|---|
| SQS | order, payment, shipping (publish), worker (consume) | `os.Getenv("SQS_QUEUE_URL")` in exactly those four services |
| Secrets Manager | External Secrets Operator, on the platform's behalf | README: *"Secrets sourced from AWS Secrets Manager via External Secrets or the Secrets Store CSI Driver"* |
| STS | the IRSA exchange behind both of the above | README: *"Least-privilege IAM with IRSA for every service that touches AWS"* |
| ECR | the kubelet, pulling images | README: *"ECR repositories, one per service"* |

Four. That is the entire runtime AWS surface. Verified in the repo: no `go.mod` across the nine services requires `aws-sdk-go-v2` or anything AWS; the only external dependencies in the whole application are `lib/pq`, `go-redis/v8` and `golang-jwt/v5`. The nine services read exactly three environment variables between them — `DATABASE_URL`, `REDIS_URL`, `SQS_QUEUE_URL`.

Everything else AWS contributes — VPC routing, the NLB, EBS volumes, node capacity — is **substrate**. Workloads never call it. They consume it through Kubernetes objects: a `Service`, a `PersistentVolumeClaim`, a scheduling decision. Kubernetes is the portability layer, and that is the entire point of building on EKS rather than on EC2.

### 1.2 The seam

So the local/production boundary should be drawn at the **infrastructure ↔ platform** line, not through Terraform:

- **Substrate (AWS-only).** VPC, subnets, NAT, security groups, the NLB, EBS, managed node groups, Karpenter. No useful local equivalent exists and none should be built. Locally, k3s supplies functional stand-ins (Docker bridge networking, ServiceLB, local-path volumes) that are *not* shaped like AWS and are not pretending to be.
- **Platform (identical both sides).** Helm charts, values, Kubernetes manifests, Traefik routing rules, StatefulSets, probes, HPAs, ArgoCD applications, the kube-prometheus stack, External Secrets objects. Byte-identical artifacts, parameterised by a values file. This is where the reuse is real and where most of Alpha's remaining risk sits.
- **Application (identical both sides).** The same container images, the same three env vars, the same service-to-service URLs.
- **The four-API slice.** SQS, Secrets Manager, STS, ECR — faithfully emulated by Floci in both the light and full local tiers.

### 1.3 What this implies about Terraform

Terraform's job in production is to build the substrate. The substrate is precisely the layer with no useful local equivalent. So Terraform-pointed-at-Floci reproduces the least valuable thing available, which inverts the intuition that started this investigation.

The narrow slice where shared Terraform does pay: **SQS and Secrets Manager**. Both are real implementations in Floci, both are consumed by workloads at runtime, both are small modules. One `modules/sqs` consumed by `live/local/` and `live/dev/` is a genuine proof that the module interface is parameterised, and it costs nothing inside the module.

The rest of the six locked modules — VPC, EKS cluster, Karpenter, Pod Identity, observability — should stay AWS-only. Attempting them locally forces `count = var.is_local ? 0 : 1` into module bodies, at which point the production code path stops being the path that was tested.

**Answer to the framing question, stated plainly:** how much of the same infrastructure *intent* survives between local and AWS is high, but the carrier is Helm values and Kubernetes manifests, not Terraform configuration.

### 1.4 Side-by-side

```
                              ALPHA PLATFORM
                                    │
        ┌───────────────────────────┴───────────────────────────┐
      LOCAL                                                 PRODUCTION
        │                                                       │
  SUBSTRATE                                               SUBSTRATE
  Docker bridge network                                   Terraform → AWS
  k3s single node                                          VPC 3 public / 6 private, 1 NAT
  ServiceLB (klipper)                                       EKS 1.33 + managed node groups
  local-path PV provisioner                                 Karpenter
        │  (no Terraform, no emulation)                      NLB + AWS LB Controller
        │                                                    EBS gp3 + EBS CSI (IRSA)
        │                                                       │
  FOUR-API SLICE                                          AWS APIs
  Floci: SQS · Secrets Manager · STS/OIDC · ECR           SQS · Secrets Manager · STS · ECR
  Terraform (shared modules: sqs, secrets)                Terraform (same modules)
        │                                                       │
  PLATFORM  ◄──────── identical charts + manifests ─────► PLATFORM
  Traefik · cert-manager (self-signed issuer)             Traefik · cert-manager (Let's Encrypt)
  External Secrets · ArgoCD                               External Secrets · ArgoCD
  kube-prometheus-stack · HPA                             kube-prometheus-stack · HPA
  Postgres StatefulSet (local-path)                       Postgres StatefulSet (gp3)
  Redis StatefulSet (local-path)                          Redis StatefulSet (gp3)
        │                                                       │
  APPLICATION  ◄────── identical images + env ──────────► APPLICATION
  9 services, images from Floci ECR                       9 services, images from ECR
        └───────────────────────────┬───────────────────────────┘
                              Alpha workloads
```

The only lines that differ are in the substrate block and three values-file entries: `storageClassName`, the cert-manager issuer, and the Traefik Service type/annotations.

---

## 2. Component inventory

"Correspondence" is how much of the production behaviour the local implementation actually exercises.

| Component | Production | Local | Corresp. | Terraform | Shared config | Difference that matters |
|---|---|---|---|---|---|---|
| Kubernetes API | EKS 1.33, managed control plane | Floci EKS → k3s container, API on :6500–6599 | High | `aws_eks_cluster` records metadata; the k3s server is real | every manifest and chart | k3s version skew vs 1.33; no control-plane HA |
| Node capacity | managed node groups, 3 AZs | single k3s node | None | prod only | — | no AZ spread, no node failure testing. Accept. |
| Autoscaling (node) | Karpenter | none | None | prod only | — | Karpenter creates EC2 and the node joins via bootstrap; Floci's `RunInstances` starts a plain container that never runs kubelet (**Derived**) |
| Autoscaling (pod) | HPA + metrics-server | HPA + k3s metrics-server | High | n/a | HPA manifests | load profile differs, mechanism identical |
| Ingress L7 | Traefik Helm chart | same Traefik chart | High | n/a | Ingress/IngressRoute, middlewares, TLS config | k3s bundles its own Traefik — must be disabled or matched (**Open question**, §6.2) |
| Ingress L4 | NLB via AWS LB Controller | k3s ServiceLB | None | prod only | Service manifest minus annotations | LB annotations, target-group health checks, cross-zone — untestable locally |
| TLS | cert-manager + Let's Encrypt | cert-manager + self-signed ClusterIssuer | Medium | n/a | Certificate objects, cert-manager chart | ACME order/challenge flow is prod-only |
| DNS | ExternalDNS + Route 53 | `nip.io` or hosts entry | None | prod only | — | prod-only. Zero local value. |
| Postgres | StatefulSet, 20Gi gp3 PVC, encrypted | StatefulSet, local-path PVC | **High** | neither (it is a chart, not AWS) | StatefulSet, initContainers, probes, service | `storageClassName` and encryption-at-rest only |
| Redis | StatefulSet, AOF, 10Gi gp3 | StatefulSet, AOF, local-path | **High** | neither | same | `storageClassName` only. App uses `INCR` + `EXPIRE` — nothing exotic (Verified in api-gateway) |
| SQS + DLQ | AWS SQS | Floci SQS | **Very high** | **shared module** | queue name, redrive policy | Floci implements standard + FIFO, DLQ redrive, visibility timeout, long polling 0–20s, message attributes, FIFO dedup ([docs](https://floci.io/floci/services/sqs/)) |
| Secrets | Secrets Manager + External Secrets | Floci Secrets Manager + same ESO chart | **High** | **shared module** | SecretStore/ExternalSecret CRs, ESO chart | ESO takes `AWS_SECRETSMANAGER_ENDPOINT` and `AWS_STS_ENDPOINT` ([docs](https://external-secrets.io/latest/provider/aws-access/)); KMS not documented in Floci; rotation-via-Lambda listed but untested |
| Workload identity | IRSA | Floci per-cluster OIDC + `AssumeRoleWithWebIdentity` | **High** | IAM roles/trust policies | ServiceAccount annotations, role trust JSON | see §5.2 — this is the decision |
| Registry | one ECR repo, immutable tags | Floci ECR (real `registry:2`), k3s pulls via `FLOCI_SERVICES_EKS_ECR_REGISTRY_MIRROR` | **High** | shared-ish | image URIs via values | scanning, lifecycle enforcement and replication absent ([docs](https://floci.io/floci/services/ecr/)); tag immutability *is* enforced |
| Storage/CSI | EBS CSI + IRSA, gp3 default, VolumeSnapshotClass | k3s local-path | Medium | prod only | PVC manifests | snapshots and volume expansion absent |
| Networking | VPC, subnets, NAT, SGs, VPC endpoints | Docker bridge | **None** | prod only | — | Floci records VPC objects but *"nothing routes packets"* for NAT/peering ([EC2 docs](https://floci.io/floci/services/ec2/)); SG CIDRs unenforced by default |
| Observability | kube-prometheus-stack | same chart | High | prod only (module) | ServiceMonitors, dashboards, alert rules | no CloudWatch, no cross-AZ metrics |
| GitOps | ArgoCD App-of-Apps, auto-sync dev | same ArgoCD, same repo | **High** | prod only | Application manifests, overlays | local points at a branch, prod at main |
| CI/CD | GH Actions OIDC → ECR → ArgoCD | direct build + push to Floci ECR | Low | prod only | Dockerfiles | workflow itself is prod-only |

---

## 3. Layer boundary

**Infrastructure** — exists underneath, provisioned by Terraform in production, *not reproduced* locally: VPC and subnets, NAT, security groups, NLB, EBS volumes, managed node groups, Karpenter, the EKS control plane itself. Locally this collapses into "one k3s container and a Docker bridge."

**Infrastructure that crosses the line** — the four-API slice, provisioned by Terraform in both: SQS queue and DLQ, Secrets Manager secrets, IAM roles and trust policies for IRSA, the ECR repository.

**Platform** — Helm-installed, identical both sides: Traefik, cert-manager, External Secrets Operator, ArgoCD, kube-prometheus-stack, metrics-server, and the Postgres and Redis StatefulSets. Note that the EKS *Add-on API* is irrelevant here: every one of these is a Helm chart or manifest set, and Floci's missing `CreateAddon`/`DescribeAddon` operations change nothing about installing them. The two components that genuinely are AWS add-ons — the EBS CSI driver and the AWS Load Balancer Controller — are the two with no local job, because there is no EBS and no ELB to drive.

**Application** — the nine services, one image each, three env vars, `/livez` and `/healthz` on every one, `waitForDB()` + `migrate()` on seven of them.

Connection points, local and AWS, are the same three in both: a `Service` DNS name for service-to-service HTTP, a `PersistentVolumeClaim` for state, and a signed AWS API call for the four-API slice.

---

## 4. Options and trade-offs

### Option A — Compose only (today's direction)

Nine service containers, Postgres, Redis, Floci for SQS.

Gives: the application wiring, real SQS semantics including DLQ redrive, the service-to-service call graph, a fast edit-rebuild loop. Costs: roughly zero — it is ~90% built already. Reproduces: the application layer. Does not reproduce: every Kubernetes object the team will actually be graded on. Complexity: lowest. Five devs: trivially fine.

The honest weakness — Alpha's remaining risk is almost entirely in the platform layer, and Compose validates none of it. A chart that renders wrong, a probe that flaps, a StatefulSet that will not bind a PVC, an ArgoCD sync loop: all invisible here.

### Option B — Local Kubernetes without AWS emulation (kind or k3d)

Gives: the whole platform layer — charts, Traefik routing, probes, PVCs, ArgoCD, Prometheus. Costs: a cluster per dev, image-loading friction (`kind load docker-image`, with the `:latest` trap the handover already documented). Reproduces: Kubernetes. Does not reproduce: SQS, Secrets Manager, IRSA — so External Secrets and workload identity have to be stubbed, which is exactly the security surface the README emphasises. Complexity: medium. Five devs: fine.

### Option C — Floci EKS + Floci AWS APIs + Terraform against Floci, as the single local environment

Gives: everything in B, plus `aws eks update-kubeconfig`, IRSA end to end, External Secrets against a real Secrets Manager API, image pulls from a real ECR, and a shared Terraform path for SQS and secrets. Costs: Floci's nested-Docker requirement (host socket mount), a k3s container plus Floci plus the RDS/ElastiCache containers it may spawn, EKS Phase-1 gaps, and a documented platform caveat — *"Container addresses unreachable from macOS/Windows Docker Desktop hosts"*. Complexity: highest. Five devs on five machines: this is where it could break, and Team Alpha is Windows, UK and Canada mixed.

The weakness: making this the *only* local environment puts a heavyweight dependency in front of a one-line Go change.

### Option D — Tiered local environment (recommended)

Two local tiers plus the cloud, each with an explicit job.

| | Tier 1 · app loop | Tier 2 · platform loop | Tier 3 · AWS dev |
|---|---|---|---|
| Runtime | Docker Compose | Floci EKS (k3s) + Floci APIs | real EKS |
| Answers | "does my handler work?" | "does my chart work?" | "does the substrate work?" |
| Start cost | seconds | minutes | Terraform apply, real money |
| Run it when | changing Go code | changing charts, manifests, ArgoCD, IRSA, secrets | changing VPC, Karpenter, NLB, CSI, or before a demo |

Gives: the fast loop stays fast, and the platform loop exists for the people who need it without being imposed on everyone. Costs: two local paths to document — mitigated by the fact that the images and the four-API slice are shared between them, so the duplication is a compose file and a values file, not two architectures. Complexity: medium, spread over time. Five devs: each picks the tier their ticket needs.

---

## 5. Recommendation

### 5.1 Adopt Option D, staged

**Now (Sprint 2).** Tier 1 to a finished, documented state: commit the Dockerfiles, prove the stack runs, add healthchecks and `depends_on: condition:` (Floci publishes `GET /_floci/init` for exactly this), keep Postgres and Redis as plain containers, keep Floci for SQS. This is the local-dev ticket that blocks the EKS work, and it is nearly done.

**Sprint 2, in parallel, time-boxed.** Run experiments E3–E5 (§7) as a spike, not as a commitment: 2–3 hours total. They decide whether Tier 2 is real. Kill criterion stated up front — if `aws eks update-kubeconfig` does not yield a working cluster, or IRSA does not complete end to end, Tier 2 is dropped and Option B (plain k3d) becomes the fallback for platform work.

**Sprint 3, only if the spike passes.** Tier 2 as the environment for chart and GitOps work, with the same Helm values files the dev overlay uses.

**Always.** Tier 3 stays the only place VPC, NLB, Karpenter, EBS CSI and cost behaviour are validated. The $200 cap makes that cheap if the cluster is applied, demonstrated and destroyed rather than left running.

Do not build: Terraform modelling of VPC, EKS, Karpenter or Pod Identity against Floci; Floci RDS or ElastiCache; a second container registry alongside ECR; S3-on-Floci for Terraform state.

### 5.2 The decision that has to happen this week: IRSA vs Pod Identity

The Sep 18 architecture session chose Pod Identity. That contradicts the eks-v2 README (*"IRSA for every service that touches AWS"*) and has never been reconciled. This investigation adds a second consideration.

For IRSA: the README mandates it; Floci implements the whole flow with real cryptographic verification, so workload identity becomes the one piece of AWS-native security that can be tested on a laptop; and the team already has OIDC federation working for GitHub Actions, so the mental model is in place.

For Pod Identity: simpler role trust policies with no per-cluster OIDC provider and no thumbprint handling; one role usable across clusters; no ServiceAccount annotation sprawl; it is the direction AWS is steering new clusters. These are real advantages and the session did not choose it arbitrarily.

Against Pod Identity, specifically for Alpha: it depends on the `eks-pod-identity-agent` add-on and the `CreatePodIdentityAssociation` API. Floci's EKS operation list covers clusters, access entries, node groups, Fargate profiles and tagging — no Pod Identity associations — and Add-on APIs are named as a Phase-1 gap. So Pod Identity cannot be exercised locally at all, and it puts the team at odds with the document they are graded against in the stakeholder Q&A.

My read: IRSA. It satisfies the brief, it is testable locally, and "we chose IRSA because the requirement specified it and because it is the only workload-identity model we could validate before touching AWS" is a better answer under questioning than the reverse. The call is the team's, and it belongs in an ADR either way since a decision this visible will be asked about.

---

## 6. Risks and unknowns

**6.1 Floci IRSA in-cluster, end to end.** The docs assert it. Nobody has run it with Alpha's chart set. If the projected token's `aud` or `iss` does not line up with what Floci's STS expects, the single largest reason to prefer Tier 2 over plain k3d evaporates. → E4.

**6.2 k3s bundled Traefik.** k3s ships Traefik, ServiceLB, local-path and metrics-server by default and they are disabled with `--disable=traefik`. Floci's documented EKS variables expose the image, ports, data path, network, endpoint mode, IRSA signing and ECR mirror — **no k3s server-argument passthrough**. So installing Alpha's own Traefik release may collide with the bundled one. Workarounds exist (different namespace, or a `.skip` file in the manifests directory) but both are unverified against Floci. → E3.

**6.3 Terraform idempotency against Floci.** `hashicorp/aws ~> 6.65` converging to a clean second apply on SQS and Secrets Manager is unproven. Floci's Terraform guide documents the provider config and an endpoints block but lists no resource-level caveats, which is weaker evidence than a passing run. → E2.

**6.4 Cross-platform behaviour for five developers.** Floci documents that container addresses are unreachable from macOS and Windows Docker Desktop hosts, and that cross-VPC isolation depends on Docker daemon rules which OrbStack does not apply. Team Alpha spans Windows, UK machines and Canada. A local environment that works on one laptop and not the others is worse than no local environment. → E6.

**6.5 Footprint.** Floci + a k3s container + nine pods + Postgres + Redis + Prometheus on a laptop. No memory or CPU guidance is published. → E6.

**6.6 Host Docker socket.** Floci requires `/var/run/docker.sock` mounted to manage nested containers. On a locked-down machine this is a hard stop.

**6.7 k3s version skew.** Floci defaults to `rancher/k3s:latest` against a production target of EKS 1.33 or above. Pinning is possible via `FLOCI_SERVICES_EKS_DEFAULT_IMAGE`; picking the pin is a decision nobody has made.

**6.8 ELBv2.** No dedicated Floci service page; control-plane operations exist (there is a CloudFormation provisioner for them in the repo) but no documented data plane. Whether the AWS Load Balancer Controller can even reconcile against it is unknown and, given the recommendation, does not need answering.

**6.9 Secrets Manager depth.** KMS integration is not documented; rotation is listed as `RotateSecret` via Lambda, untested. If the team's KMS ticket expects local validation, it will not get it.

---

## 7. Experiments

Ordered by how much they change. Each is non-destructive to the repo; none requires a git operation.

**E1 · Does the current stack run at all?**
Hypothesis: with the CRLF fixed in `scripts/floci-init.sh`, `docker compose up --build` brings all nine services up and the Floci ready hook creates both queues.
Experiment: fix line endings, `docker compose up --build`, then `curl localhost:4566/_floci/init` and `docker compose exec floci aws sqs list-queues`. Capture `time docker compose build` warm after touching one service.
Expected: `order-events` and `order-events-dlq` present, redrive policy pointing at the DLQ with `maxReceiveCount: 3`.
Changes: unblocks the Dockerfile PR, makes the published Floci doc true or false, and the rebuild number closes the GHCR ticket. ~15 min.

**E2 · Does Terraform converge against Floci?**
Hypothesis: `hashicorp/aws ~> 6.65` applies SQS against Floci 2.1.0 and a second apply is a no-op.
Experiment: the scratch-directory probe in the handover §8, extended with an `aws_secretsmanager_secret`.
Expected: "0 to add, 0 to change, 0 to destroy" on the second apply.
Changes: if it converges, `live/local/` consuming the shared `modules/sqs` is viable. If phantom diffs persist, drop shared Terraform entirely and keep Floci as an API target configured by script. ~15 min.

**E3 · Is Floci EKS a usable cluster?**
Hypothesis: `aws eks create-cluster` → `aws eks update-kubeconfig` → `kubectl get nodes` works, and Alpha's own Traefik chart can be installed without colliding with k3s's bundled one.
Experiment: create a cluster through Floci, update kubeconfig, `kubectl get nodes`, `kubectl -n kube-system get all`, then `helm install` Traefik into its own namespace and see what happens to the bundled release.
Expected: one Ready node; bundled Traefik present in `kube-system`.
Changes: this is the Tier 2 gate. Failure → fall back to Option B. ~20 min.

**E4 · Does IRSA complete end to end?**
Hypothesis: a pod with an annotated ServiceAccount can assume a role via `AssumeRoleWithWebIdentity` against Floci STS and read a Secrets Manager secret.
Experiment: create an IAM role with a trust policy federated to the cluster's OIDC provider; create a secret; deploy External Secrets with `AWS_SECRETSMANAGER_ENDPOINT` and `AWS_STS_ENDPOINT` pointed at Floci and a `SecretStore` using `auth.jwt.serviceAccountRef`; confirm the Kubernetes Secret materialises with the right value.
Expected: the secret syncs; denying the role's policy makes it fail.
Changes: passing makes IRSA-over-Pod-Identity an evidence-backed recommendation and gives Tier 2 its main reason to exist. Failing means local workload identity is stubbed in both options, and the IRSA/Pod Identity decision goes back to being about production only. ~45 min. **Highest information value of the six.**

**E5 · Does the local image path work?**
Hypothesis: build → push to Floci ECR → k3s pulls by ECR URI with the registry mirror on.
Experiment: `aws ecr create-repository`, `docker push <account>.dkr.ecr.<region>.localhost:4566/order-service:sha-abc123`, deploy that exact URI into the Floci-EKS cluster.
Expected: image pulls, pod runs; a second push to the same tag is rejected by immutability.
Changes: if this works, the registry question is closed — one registry concept (ECR) local and production, immutable SHA tags both sides, and GHCR has no remaining job. Write that into the GHCR ticket as the finding. ~30 min.

**E6 · Can five people actually run it?**
Hypothesis: Tier 2 fits in a normal laptop and behaves the same on Windows and macOS.
Experiment: with everything up, record `docker stats` totals and wall-clock cold start. Have one other teammate on a different OS run E3 unchanged.
Expected: an honest number either way.
Changes: a Tier 2 that only works on one machine is a personal tool, not a team environment, and should be documented as such rather than put in the onboarding doc. ~30 min plus someone else's time.

---

## 8. Intended developer workflow

Desired shape, not a decision — the command names are a target for the onboarding doc, and the implementation follows whatever E3–E6 return.

```
git clone && cd Alpha-Pilot-4week

# Tier 1 — the daily loop
make dev-up        # compose: postgres, redis, floci(sqs), 9 services
make dev-test      # smoke: /livez and /healthz on all nine, one order through the flow
make dev-down

# Tier 2 — platform work, only if the spike passes
make platform-up        # floci up; terraform apply live/local (sqs + secrets);
                        # eks create-cluster; update-kubeconfig
make platform-images    # build 9 images, push to floci ECR as sha-<short>
make platform-deploy    # helm/argocd apply the same charts the dev overlay uses
make platform-test      # same smoke suite, through Traefik
make platform-down      # delete-cluster, floci down
```

Two properties matter more than the command names. `dev-test` and `platform-test` should run the *same* smoke script against different endpoints, so "it works locally" means the same thing in both tiers. And image tags should be `sha-<short>` pinned in a committed values file in both tiers, so synchronising environments is a reviewable git diff rather than an invisible registry mutation.

---

## 9. History, classified

**Confirmed team decisions.** Floci over LocalStack (Sep 16, restated by Ahmed to Saad Sep 20 with the 30-vs-120-services reasoning). Helm over Kustomize, ArgoCD over Flux (Sep 18 lobby). One Dockerfile per service (Sep 17, reconfirmed by Param Sep 19). One ECR repo in non-prod, prod pulling cross-account (Sep 18). Trunk-based branching (Sep 20). 3 public + 6 private subnets, single NAT (Sep 19). Dev end-to-end first, then staging, then prod (Ramla, Sep 20 transcript). Never apply from a feature branch (Saad, Sep 20).

**Current implementation.** Compose with Postgres, Redis and Floci-for-SQS. `bootstrap/` merged to `main` via PR #6. `infra/terraform/` introduced on `alpha-69`. Dockerfiles exist only on Ahmed's disk.

**Proposals, not decisions.** GHCR — raised by Siad Sep 18 with feedback explicitly deferred, re-raised by Ahmed in the Sep 20 call, now an action item with an owner. An action item to investigate is not an adopted architecture. Pod Identity replacing IRSA — decided in the Sep 18 architecture session, contradicts the README, never reconciled.

**Assumptions being treated as requirements.** "SQS is the only AWS-compatible service we currently need from Floci" — Ahmed's own Floci doc, describing what is wired up today, not a bound on what Alpha needs. "Cloud-managed services don't need to be spun up locally" — from the GHCR conversation in which the reviewer said he was holding off on considered feedback until the project was complete; it carries no standing, and this investigation finds it half right for the wrong reason (RDS and ElastiCache should indeed not run locally, because Alpha does not use them, not because managed services generally do not belong locally).

**Unresolved, and consequential.** The local/dev boundary: in the Sep 20 call Ahmed described `Terraform → Floci endpoint → local resources` with AWS reserved for later, while Ramla stated in the same call that *"Flowkey is for you just for your experimenting and local testing. Right now what we're creating this infrastructure for is just for our dev."* Saad accepted both. Two members will answer the same stakeholder question differently unless this is settled in the thread. §1 of this document is a proposed settlement. Also unresolved: IRSA vs Pod Identity, `infra/terraform/` vs the agreed `terraform/modules + live/`, environment count, and priority-level definitions.

---

## Sources

- [Floci — services overview](https://floci.io/floci/services/) · [EKS](https://floci.io/floci/services/eks/) · [RDS](https://floci.io/floci/services/rds/) · [SQS](https://floci.io/floci/services/sqs/) · [IAM](https://floci.io/floci/services/iam/) · [STS](https://floci.io/floci/services/sts/) · [Secrets Manager](https://floci.io/floci/services/secrets-manager/) · [ECR](https://floci.io/floci/services/ecr/) · [EC2](https://floci.io/floci/services/ec2/) · [Terraform](https://floci.io/floci/getting-started/terraform/) · [Docker configuration](https://floci.io/floci/configuration/docker/)
- [floci-io/floci](https://github.com/floci-io/floci)
- [codercohq/eks-v2 README](https://github.com/codercohq/eks-v2)
- [k3s — packaged components](https://docs.k3s.io/installation/packaged-components)
- [External Secrets Operator — AWS access](https://external-secrets.io/latest/provider/aws-access/) · [AWS Secrets Manager provider](https://external-secrets.io/latest/provider/aws-secrets-manager/)
- [Team Alpha Notion hub](https://app.notion.com/p/3daae71e6340802c9466f49bb2d0383e) and the [Sep 20 Sprint 2 planning transcript](https://app.notion.com/p/3e2ae71e63408094946edf37c6109f21)
- Repo inspection, read-only, 21 Sep 2026: `C:\Users\ahmed\Desktop\CoderCo\Projects\Alpha-Pilot-4week`
