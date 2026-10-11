# Point 2 — Five Developers, One Repo, Isolated Local State

**Written:** 21 Sep 2026. **Status:** design only. Nothing implemented, no repo or git state modified.
**Builds on:** Point 1 as established — one Terraform definition, target selected by endpoint / credentials / backend / variables.

Evidence labels: **[Docs]** verified from official documentation · **[Repo]** verified in our working tree today · **[Exp]** experiment required · **[Assume]** reasoned, unverified.

---

## 1. Current state — what stops five developers sharing one experience

**[Repo]** The README's entire local-development section is:

```
## Local Development
docker compose up --build
```

That command fails for every teammate, because no Dockerfile has ever been committed on any branch in the repository's history. Ahmed's nine are untracked on his disk.

**[Repo]** `scripts/floci-init.sh` creates `order-events` and `order-events-dlq` with the redrive policy. `docker-compose.yml` hardcodes `SQS_QUEUE_URL: http://floci:4566/000000000000/order-events`. Under Point 1, Terraform owns that queue. Three mechanisms, one resource.

**[Repo]** `.gitignore` contains `.terraform.lock.hcl` and `*.tfvars`. **[Docs]** HashiCorp: *"You should include this file in your version control repository so that you can discuss potential changes to your external dependencies via code review."* Without it, *"different machines could end up with different provider versions."* Ignoring `*.tfvars` also means the per-target variable files Point 1 depends on cannot be committed. Both directly defeat reproducibility.

**[Repo]** Floci runs with no `FLOCI_STORAGE_MODE` set. **[Docs]** The default is `memory` — *"Data does not survive container restart."* So every queue, secret and IAM role a developer creates evaporates on recreate, silently.

**[Repo]** Region is stated three times and disagrees with itself: `AWS_REGION: us-east-1` in the compose anchor, `eu-west-2` in `bootstrap/variable.tf` and `infra/terraform/`, and Floci's own default `FLOCI_DEFAULT_REGION=us-east-1`. The two queues created this morning are in `us-east-1`.

**[Repo]** Two Terraform layouts exist: `bootstrap/` on `main` (merged PR #6) and `infra/terraform/` on `alpha-69`, against the Sep 18 session's agreed `terraform/ → modules/ + live/`. The local target has nowhere to live until that is settled.

**[Repo]** Postgres credentials appear twice inside one file — once under the `postgres` service as `POSTGRES_*`, once inside `x-database-env` as a DSN. `JWT_SECRET: local-dev-secret` is hardcoded. Neither is fatal; both are places a developer can end up out of sync with themselves.

**[Repo]** No Makefile, no `.env`, no verification script, no reset path. Everything is typed by hand, which is exactly the "works on my machine" surface.

---

## 2. Evidence that shapes the design

**Terraform backends. [Docs]** A backend block *"cannot refer to named values (like input variables, locals, or data source attributes)."* Partial configuration is the sanctioned answer: omit arguments and supply them at init with `-backend-config=PATH` or `-backend-config="KEY=VALUE"`. `bucket`, `key`, `region`, `encrypt`, `use_lockfile` and credentials are all suppliable this way. Changing backend configuration triggers reinitialization and Terraform offers to migrate state.

**Workspaces. [Docs]** *"Workspaces are not appropriate for system decomposition or deployments requiring separate credentials and access controls."* They isolate state files within one backend and one credential set. Five developers pointing at five different Floci instances with different endpoints is precisely the case the documentation warns against.

**Lock file. [Docs]** Commit it. It pins provider versions only, not modules; `terraform init` creates or updates it; `-upgrade` moves it.

**AWS provider endpoints. [Docs]** Precedence: provider `endpoints` block → `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS` → `AWS_ENDPOINT_URL_<SERVICE>` → `AWS_ENDPOINT_URL` → shared config service settings → shared config base → AWS default. So `AWS_ENDPOINT_URL` alone redirects every service with nothing in the `.tf` files. The S3 **backend** takes `AWS_ENDPOINT_URL_S3` and a `use_path_style` argument of its own.

**Compose variable precedence. [Docs]** Highest to lowest: `docker compose run -e` → `environment`/`env_file` with a value interpolated from the shell or an env file → static `environment` → `env_file` attribute → image `ENV`. Interpolated values beat static ones, which is what lets a generated env file override a compose default without editing the compose file.

**Compose project name. [Docs]** `-p` → `COMPOSE_PROJECT_NAME` → top-level `name:` → directory name. *"Compose uses a project name to isolate environments from each other."*

**Floci storage. [Docs]** `memory` (default, *"Data does not survive container restart"*, intended for unit tests and CI), `persistent` (*"Synchronous disk write on every change"*), `hybrid` (*"In-memory reads, async flush to disk"*, recommended for *"General local development"*), `wal`. Path via `FLOCI_STORAGE_PERSISTENT_PATH`, default `./data`. Docker-backed services (RDS, ECR, EKS, OpenSearch, MSK) use named Docker volumes labelled `floci=true`, which *"survive resource deletion"* unless `FLOCI_STORAGE_PRUNE_VOLUMES_ON_DELETE=true`.

**Floci compose guidance. [Docs]** The documented persistence shape mounts a named volume at `/app/data` with `FLOCI_STORAGE_MODE` and `FLOCI_STORAGE_PERSISTENT_PATH` set. For container-backed services it also mounts `/var/run/docker.sock` and sets `FLOCI_SERVICES_DOCKER_NETWORK` to the compose network name. No healthcheck is documented — **[Repo]** though the image evidently ships one, since our container reported `(healthy)` without compose defining it.

**Floci identity defaults. [Docs]** `FLOCI_DEFAULT_REGION=us-east-1`, `FLOCI_DEFAULT_ACCOUNT_ID=000000000000`, `FLOCI_BASE_URL=http://localhost:4566`, `FLOCI_HOSTNAME` overrides only the hostname in returned URLs. `FLOCI_INIT_HOOKS_SHELL_EXECUTABLE=/bin/sh`, timeout 30s.

**Floci S3. [Docs]** Path-style *"always functional"*. Versioning, object lock, bucket policies (under `FLOCI_SERVICES_S3_ENFORCE_AUTH`), encryption all present. The service page says only that `x-amz-object-if-match` is validated for annotation operations, but the project CHANGELOG carries a v1.5.18 entry — *"make `PutObject` atomic on conditional puts"* ([#1329](https://github.com/floci-io/floci/pull/1329)) — so conditional `PutObject` exists and was hardened well before the `2.1.0-compat` image we run. That is the primitive Terraform's `use_lockfile` depends on. **[Exp]** Whether the backend's specific `If-None-Match` flow succeeds end to end is still a one-command test, but the odds are now good rather than unknown.

**Floci scope. [Docs]** The project README states 84 AWS services (the docs site says 150+, which appears to count API surfaces rather than services) and describes hybrid mode as an async flush *"every 5 seconds"*. It confirms *"Terraform can provision AWS-shaped resources locally through Floci using the standard HashiCorp AWS provider"* and says nothing at all about using Floci S3 to hold Terraform state — so that arrangement is ours to validate, not a documented pattern.

**Floci ECR. [Docs]** Real `registry:2` backend, `docker push`/`pull` work, URIs of the form `<account>.dkr.ecr.<region>.localhost:4566/<repo>`, loopback trusted as insecure automatically, tag immutability enforced.

---

## 3. Options that actually matter

### 3.1 Terraform state isolation

**A — local backend per developer.** State file on disk, gitignored. Zero chicken-and-egg, perfect isolation. Costs: the backend block differs from every AWS environment, and state lifetime becomes independent of Floci's lifetime. With Floci in `memory` mode that produces the worst failure in this whole design — a state file that confidently describes queues that no longer exist. The next apply either errors or silently recreates, and the developer has no idea why.

**B — S3 backend against that developer's own Floci.** One backend block for every target, differing only in `-backend-config`. State lives inside the same Floci instance as the resources it describes, so their lifetimes are coupled: reset Floci and the state goes with it, atomically. Costs: a bootstrap step must create the bucket before `terraform init`, and `use_lockfile` depends on the conditional-write unknown.

**C — workspaces.** Rejected on the documentation. Workspaces share one backend and one credential set; five developers have neither.

The locking objection to B dissolves on inspection. Locking exists to arbitrate concurrent writers. A developer's private Floci has exactly one writer, so `use_lockfile=false` locally is correct rather than a workaround — and `use_lockfile` is **[Docs]** suppliable via `-backend-config`, so it is a backend setting, not an infrastructure difference.

**Decision: B.** Coupled lifetimes are worth more than a saved bootstrap step, and one backend block across all four targets is the clean expression of Point 1.

### 3.2 The bootstrap chicken-and-egg

The same shape production already uses, which is the point.

**[Repo]** `bootstrap/` is already parameterised — `state_bucket_name`, `project_name`, `environment`, `github_org`, `github_repo`, `aws_region`, all with defaults — and creates the state bucket, the ECR repository and the GitHub OIDC provider. **[Notion, confirmed decision]** Sep 18: *"Bootstrap (S3 state, ECR, OIDC) applied manually before pipelines."*

So: `terraform/bootstrap` runs with a **local** backend, creating the state bucket inside that developer's Floci. Then `terraform/live/local` initialises its S3 backend against that bucket. Production does the identical two-phase dance; `alpha-69` is Ramla migrating bootstrap's own state into the bucket it created.

No `count = var.is_local` is needed anywhere. The GitHub OIDC provider applies locally too — **[Docs]** Floci IAM implements `CreateOpenIDConnectProvider` — it is simply inert. Inert is better than conditional.

### 3.3 Floci persistence policy

| Event | What survives | Mechanism |
|---|---|---|
| `docker compose restart floci` | everything | `hybrid` mode + `/app/data` volume |
| `docker compose down` | everything | named volume outlives the container |
| Docker daemon / host restart | everything | same |
| `make local-reset` | nothing | `down -v` removes the volume, plus pruning `floci=true` volumes |

`hybrid` is the documented recommendation for general local development and avoids a synchronous disk write on every SQS call.

**[Exp]** One thing to confirm: whether Floci's ECR/EKS Docker volumes are removed by `docker compose down -v`, since they are created by Floci rather than by compose and are labelled `floci=true`. If not, reset needs an explicit `docker volume ls -f label=floci=true` prune, and that belongs in the reset script rather than in a developer's head.

### 3.4 Configuration injection

Terraform is the producer; everything downstream consumes its outputs.

```
terraform apply  →  terraform output -json  →  scripts/local-env.sh  →  .env.local (gitignored)
                                                                            ↓
                                                        docker compose --env-file .env --env-file .env.local
```

**[Docs]** Interpolated values outrank static `environment` entries, so `SQS_QUEUE_URL: ${SQS_QUEUE_URL}` in the compose file resolves from the generated file with no edit to the compose file itself. `.env` is the committed template holding stable local values; `.env.local` is generated and never committed.

The subtlety worth naming: Terraform runs on the host and reaches Floci at `localhost:4566`, while the application containers need `floci:4566`. **[Docs]** `FLOCI_HOSTNAME` rewrites only the hostname in returned URLs, so `aws_sqs_queue.main.url` comes back as `http://floci:4566/...` even though the API call went to localhost. The endpoint Terraform talks to and the URL Terraform records are deliberately different, and that is what makes one output serve both.

### 3.5 Compose isolation

Five developers on five machines cannot collide. The only real collision is one developer running two checkouts at once, and that collides on host ports 4566, 5432, 6379 and 8080–8086 regardless of project name — so a per-developer or per-branch project name solves nothing that matters.

`COMPOSE_PROJECT_NAME=alpha` fixed in the committed `.env`, one stack at a time, documented. **[Docs]** It also has to be deterministic because `FLOCI_SERVICES_DOCKER_NETWORK` must name the compose network, so it is interpolated as `${COMPOSE_PROJECT_NAME}_default` rather than hardcoded.

### 3.6 Where local should deliberately differ from non-prod

`eks-v2-dev-tf-state` in `eu-west-2` is shared team infrastructure holding the dev environment's real state. Local state is per-developer and disposable. Same backend *type*, different bucket, different lifecycle, different blast radius. A local bucket named `alpha-local-tfstate` inside each developer's Floci is the right arrangement, and pointing local at the dev bucket would be actively wrong.

Region is the opposite call: set `FLOCI_DEFAULT_REGION=eu-west-2` so local ARNs carry the same region as production. That difference buys nothing, so remove it.

---

## 4. Decision

One infrastructure definition in `terraform/modules/`. Four thin compositions in `terraform/live/{local,dev,staging,prod}`, each declaring `backend "s3" {}` as a partial configuration and differing only in which modules it composes and what it is initialised with.

Local composes the modules that have meaning locally — SQS, Secrets Manager, IAM, ECR, and later EKS — and simply does not call Karpenter or VPC. That is the mechanism that keeps `count = var.is_local` out of module bodies: the difference lives in composition, never inside a module. The infrastructure is still defined exactly once, which is what Point 1 protects.

This keeps the Sep 18 `modules/` + `live/` decision intact. The alternative — a single root module driven purely by `-var-file` — is a purer reading of "same Terraform" but forces conditionals the moment two environments legitimately differ, and it contradicts a confirmed team decision for no gain.

Target selection, in full:

```
                terraform/modules/          (defined once)
                        │
        ┌───────────┬───┴───────┬───────────┐
    live/local   live/dev   live/staging  live/prod
        │
        ├─ AWS_ENDPOINT_URL=http://localhost:4566
        ├─ AWS_ACCESS_KEY_ID=test / AWS_SECRET_ACCESS_KEY=test
        ├─ -backend-config=backends/local.hcl   (Floci S3, use_lockfile=false)
        └─ -var-file=environments/local.tfvars
```

---

## 5. Developer contract

```
make local-up          start everything, end to end
make local-bootstrap   converge infrastructure only (idempotent)
make local-test        verify
make local-down        stop, keep state
make local-reset       destroy everything local
```

| Command | Does | Owns |
|---|---|---|
| `local-up` | starts floci + postgres + redis, waits for `/_floci/init`, calls `local-bootstrap`, then starts the nine services with the generated env | containers, named volumes |
| `local-bootstrap` | `terraform -chdir=terraform/bootstrap apply` (local state, creates the Floci state bucket + ECR), then `terraform -chdir=terraform/live/local init -backend-config=...` and `apply -var-file=...`, then regenerates `.env.local` from outputs | Terraform state, all Floci-side AWS resources, `.env.local` |
| `local-test` | `scripts/verify-infra.sh` then `scripts/verify-app.sh`, reported separately | nothing |
| `local-down` | `docker compose down` | stops containers; volumes and state survive |
| `local-reset` | `docker compose down -v`, prune `label=floci=true` volumes, delete `.env.local`, `.terraform/` and local state | returns to a clean clone |

Idempotence: `local-bootstrap` run twice is two Terraform applies, and the second is a no-op by construction. **[Exp]** That is the claim E2 has to prove.

`local-test` splits deliberately. `verify-infra.sh` asserts the queues exist with the right redrive policy, the secret exists, the ECR repository exists, and a second `terraform plan` is empty. `verify-app.sh` asserts the nine containers are up and `/healthz` returns 200. Neither asserts an order reaching the worker, because **[Repo]** `publishEvent` logs and `receiveSQSMessages` is a stub. The workflow must not fail red for an application ticket nobody has started.

---

## 6. Proposed structure

```
Alpha-Pilot-4week/
├── Makefile                          the only interface a developer needs
├── docker-compose.yml                Floci + Postgres + Redis + 9 services
├── .env                              COMMITTED template — project name, region, ports,
│                                     local Postgres creds, Floci settings
├── .env.local                        GENERATED from terraform output — gitignored
├── .gitattributes                    + *.sh text eol=lf
├── .gitignore                        - .terraform.lock.hcl   - *.tfvars (blanket)
│                                     + .env.local  + Claude outputs/
│
├── docs/
│   ├── local-development.md          install → run → expect → verify → reset
│   └── dockerfile-conventions.md
│
├── scripts/
│   ├── local-bootstrap.sh            the two-phase Terraform run
│   ├── local-env.sh                  terraform output -json → .env.local
│   ├── verify-infra.sh               infrastructure assertions
│   ├── verify-app.sh                 application assertions
│   └── reset-local.sh                volumes, state, generated files
│
├── services/<nine>/
│   ├── Dockerfile
│   └── .dockerignore
│
└── terraform/
    ├── bootstrap/                    state bucket + ECR + OIDC, local state, both targets
    │   ├── main.tf  providers.tf  variables.tf  outputs.tf  versions.tf  README.md
    │   └── policies/*.json
    ├── modules/                      THE definition — written once
    │   ├── sqs/  secrets/  identity/  vpc/  eks/  karpenter/  observability/
    ├── environments/
    │   ├── local.tfvars  dev.tfvars  staging.tfvars  prod.tfvars
    ├── backends/
    │   ├── local.hcl                 Floci S3, use_lockfile=false, use_path_style=true
    │   └── dev.hcl  staging.hcl  prod.hcl
    └── live/
        ├── local/   main.tf  backend.tf  outputs.tf      ← composes the local-meaningful modules
        ├── dev/  staging/  prod/
```

Ownership in one line each. `terraform/modules` owns what infrastructure *is*. `terraform/live/<target>` owns what a target *composes*. `backends/` and `environments/` own target inputs. `.env` owns stable local values a human chose; `.env.local` owns values Terraform produced. `docker-compose.yml` owns runtime topology and nothing else. `scripts/` owns sequencing. The Makefile owns the vocabulary.

---

## 7. Keep, move, replace, remove, new

| | Item | Rationale |
|---|---|---|
| **KEEP** | nine Dockerfiles + `.dockerignore` | **[Repo]** built in 20.6s, 15.2–16.9MB, seven services green |
| **KEEP** | `docs/dockerfile-conventions.md`, `scripts/test-dockerfiles.sh` | the canonical convention and its check |
| **KEEP** | `bootstrap/` resource definitions | already parameterised; serves both targets unchanged |
| **KEEP** | `docker-compose.yml` topology, anchors, service graph | correct; only its hardcoded values change |
| **MOVE** | `bootstrap/` → `terraform/bootstrap/` | Sep 18 agreed a single `terraform/` tree |
| **MOVE** | `infra/terraform/` (alpha-69) → `terraform/live/dev/` | same reason; raise with Ramla, do not do unilaterally |
| **REPLACE** | hardcoded `SQS_QUEUE_URL` → `${SQS_QUEUE_URL}` from `.env.local` | Terraform becomes the single source |
| **REPLACE** | hardcoded Postgres creds in two places → `${POSTGRES_*}` from `.env` | one source inside one file |
| **REPLACE** | `AWS_REGION: us-east-1` → `${AWS_REGION}` with `FLOCI_DEFAULT_REGION=eu-west-2` | removes a difference that buys nothing |
| **REPLACE** | README's `docker compose up --build` → `make local-up` + link | the current instruction cannot work |
| **REMOVE** | `scripts/floci-init.sh` | Terraform owns the queues. This is the direct casualty of Point 1, and it is on `alpha-61`. |
| **REMOVE** | `.terraform.lock.hcl` from `.gitignore` | **[Docs]** it must be committed |
| **REMOVE** | blanket `*.tfvars` from `.gitignore` | target inputs must ship; keep secrets out by naming, e.g. `*.auto.tfvars` ignored, `terraform/environments/*.tfvars` committed |
| **NEW** | `Makefile`, `.env`, `scripts/local-*.sh`, `scripts/verify-*.sh` | the workflow itself |
| **NEW** | `terraform/{modules,live,backends,environments}` | the Point 1 structure |
| **NEW** | Floci persistence config in compose — volume, `FLOCI_STORAGE_MODE=hybrid`, docker socket, `FLOCI_SERVICES_DOCKER_NETWORK` | **[Docs]** default `memory` loses everything on recreate |
| **NEW** | publish `8090:8090` and `8091:8091` | **[Repo]** worker and scheduler health are currently unreachable; distroless has no shell to exec |

The `floci-init.sh` removal deserves a sentence of its own. It works, it was this morning's win, and it is on your open branch. Under Point 1 it is a shell script creating infrastructure that Terraform is about to own, which is the exact duplication the principle exists to prevent. If you would rather land `alpha-61` as-is and remove the script in the follow-up ticket, that is a reasonable sequencing call — it just needs to be the stated plan rather than an accident.

---

## 8. Implementation sequence

Smallest useful order, each step verifiable before the next.

**Step 1 — land what is proven.** Dockerfiles on their own branch off a freshly fetched `main`, with `.gitignore` updated for `Claude outputs/`. Separately, `alpha-61` rebased and raised. Two tickets, two PRs. Nothing here depends on the rest of this design.

**Step 2 — prove the target switch before building around it.** In a scratch directory outside the repo: a provider block with no `skip_*` flags, `AWS_ENDPOINT_URL` exported, one `aws_sqs_queue` with a DLQ and one `aws_secretsmanager_secret`. Apply, verify out-of-band with the CLI, apply again and require `0 to add, 0 to change, 0 to destroy`. This answers three questions at once — whether the provider block can be identical across targets, whether the provider version converges against Floci, and whether E2's idempotency claim holds.

**Step 3 — prove the backend.** Same scratch directory. Create a bucket in Floci S3, then `terraform init -backend-config` with `AWS_ENDPOINT_URL_S3` set. Run it once with `use_lockfile=false`, which is the configuration we intend, and once with `use_lockfile=true` purely to see whether Floci's conditional `PutObject` satisfies the backend — the CHANGELOG says the primitive is there, and knowing it works keeps local and dev one setting apart instead of one mechanism apart. If the backend cannot initialise at all, local falls back to a local backend and §3.1's coupled-lifetime argument is lost, which is worth knowing before the tree is built rather than after.

**Step 4 — the repository skeleton.** `terraform/` tree, `modules/sqs` and `modules/secrets` only, `live/local`, `backends/local.hcl`, `environments/local.tfvars`, committed lock file. Nothing for dev, staging or prod yet; those follow the team's layout decision.

**Step 5 — the workflow.** Makefile, `.env`, the four scripts, compose changes for persistence and generated values. `make local-reset && make local-up && make local-test` from a clean clone is the acceptance test.

**Step 6 — a teammate runs it cold.** Param or Jawad, different machine, following `docs/local-development.md` and nothing else. Whatever they hit is the real backlog. Without this the design is a hypothesis.

**Step 7 — the layout conversation.** `infra/terraform/` versus `terraform/live/` has to be settled in the thread with Ramla and Naima before dev, staging and prod roots are written. Step 4 deliberately touches only `live/local/`, so it cannot collide with her branch while the question is open.

---

## Sources

- Terraform: [backend configuration](https://developer.hashicorp.com/terraform/language/backend) · [S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3) · [workspaces](https://developer.hashicorp.com/terraform/language/state/workspaces) · [dependency lock file](https://developer.hashicorp.com/terraform/language/files/dependency-lock)
- AWS provider: [custom service endpoints](https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/main/website/docs/guides/custom-service-endpoints.html.markdown)
- Docker: [environment variable precedence](https://docs.docker.com/compose/how-tos/environment-variables/envvars-precedence/) · [project name](https://docs.docker.com/compose/how-tos/project-name/)
- Floci: [storage modes](https://floci.io/floci/configuration/storage/) · [environment variables](https://floci.io/floci/configuration/environment-variables/) · [Docker Compose](https://floci.io/floci/configuration/docker-compose/) · [Terraform](https://floci.io/floci/getting-started/terraform/) · [S3](https://floci.io/floci/services/s3/) · [ECR](https://floci.io/floci/services/ecr/) · [EKS](https://floci.io/floci/services/eks/)
- Repo inspection, read-only, 21 Sep 2026, and the Sep 18 architecture session and Sep 20 Sprint 2 planning transcript in the [Team Alpha Notion hub](https://app.notion.com/p/3daae71e6340802c9466f49bb2d0383e)
