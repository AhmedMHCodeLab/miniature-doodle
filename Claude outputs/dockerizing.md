# Dockerizing the EKS v2 Application

## 0. Glossary

- **Distroless** base images with no shell, no package manager, no OS userland.
- **Tag vs digest** a tag can move to different bytes later; a digest always means the same bytes.
- **`CGO_ENABLED=0`** forces a fully static Go binary with no C-library dependency.
- **Static vs dynamic linking** static bakes everything in; dynamic expects libraries on the host.
- **OCI label** metadata baked into an image, visible via `docker inspect`.
- **Build context** the files sent to Docker when a build starts, filtered by `.dockerignore`.
- **`go:embed`** bakes a file or directory into the Go binary at compile time.

## 1. Purpose and scope

**Takeaway:** how we containerized the 9 services, and how to change a Dockerfile without breaking what we deliberately built.

- Covers: api-gateway, order-service, inventory-service, payment-service, notification-service, shipping-service, dashboard-api, worker, scheduler.
- Doesn't cover: application code, Kubernetes manifests/probes, the CI/CD pipeline (not live yet), branching/ticket conventions.

## 2. Ownership model: this is our Dockerfile standard

**Takeaway:** these are choices we made for reasons specific to this app not defaults, not a copied template.

### Build and runtime

**Multi-stage builds**
- **Rule:** two stages per service `builder` compiles, the final stage runs. Only the binary crosses over.
- **Why:** nothing at runtime needs a compiler, package manager, or shell.
- **Risk:** collapsing to one stage drags the whole Alpine toolchain into production.
- **Revisit:** never no service needs the build environment at runtime.

**Go builder image (`golang:1.26-alpine`)**
- **Rule:** all 9 builder stages pin to `golang:1.26-alpine`.
- **Why:** `go.mod`'s directive is a floor, not a target. That headroom already paid off once order-service's `go.mod` moved from `go 1.22` to `go 1.24` when the AWS SDK for Go v2 required it, and the builder needed no change to cover it.
- **Risk:** a newer, still-early-cycle version risks a compiler regression for no functional gain.
- **Revisit:** a CVE advisory lands against 1.26.

**Distroless runtime (`static-debian13`)**
- **Rule:** final stage, digest-pinned, the `static` variant no libc.
- **Why:** every dependency across all 9 services is pure Go; nothing needs cgo, so we get the smallest image and smallest CVE surface. Confirmed again with the AWS SDK: order-service's outbox/SQS work runs on `CGO_ENABLED=0` with no changes needed.
- **Risk:** swapping to a shelled base reopens the attack surface this closes and roughly 20x's image size.
- **Revisit:** a service needs to shell out or write to disk at startup none do today.

**`CGO_ENABLED=0`**
- **Rule:** explicit on every `go build` line.
- **Why:** Alpine's builder disables cgo only by accident (no gcc installed) this makes the static link intentional.
- **Risk:** remove it and a future `apk add build-base` silently re-enables cgo; the binary crashes in distroless with no libc to link against.
- **Revisit:** a service genuinely needs cgo none do.

**`/app` binary path**
- **Rule:** builder writes to `/app`, runtime copies to `/app`, CMD runs `/app` same path everywhere.
- **Why:** one path means no copy-paste mismatch between services; early drafts had three different conventions.
- **Risk:** a path change without updating both sides fails the build loudly annoying, not silent.
- **Revisit:** never the value is consistency, not the specific path.

**Build flags (`-trimpath -ldflags="-s -w"`)**
- **Rule:** on every `go build` line, no exceptions.
- **Why:** strips local paths and debug symbols, ~25-30% smaller binary free, since distroless has no shell or debugger to use them anyway.
- **Risk:** none pure efficiency, not correctness.
- **Revisit:** a service needs Delve debugging in-container build a separate `Dockerfile.dev`, don't relax production.

**`.dockerignore`**
- **Rule:** 3 lines `Dockerfile`, `.dockerignore`, `*.md` identical across all 9.
- **Why:** the build context is each service's own subdirectory; there's nothing else in it to exclude.
- **Risk:** an empty file (where these started) lets the Dockerfile and markdown into the context harmless today, a real leak risk the day a `.env` lands next to source.
- **Revisit:** a service's directory gains a file type that shouldn't reach the build context.

### Security and operations

**Non-root user**
- **Rule:** `USER nonroot:nonroot`, after `COPY --from=builder`, before `EXPOSE`.
- **Why:** Kubernetes' `runAsNonRoot: true` refuses to start a container running as UID 0.
- **Risk:** drop it and the container defaults to root works locally, fails to schedule once that policy is set.
- **Revisit:** never, for this app.

**No Docker `HEALTHCHECK`**
- **Rule:** none of the 9 Dockerfiles have one.
- **Why:** Kubernetes ignores it pod-spec liveness/readiness probes are what actually gate traffic in EKS.
- **Risk:** none either way leaving it out costs nothing in production.
- **Revisit:** local `docker compose` health visibility becomes something the team wants day-to-day.

**Exec-form CMD (`CMD ["/app"]`)**
- **Rule:** every Dockerfile, never shell form.
- **Why:** exec form makes the binary PID 1, so it receives SIGTERM directly every service's graceful shutdown depends on this.
- **Risk:** shell form puts a shell between Kubernetes and the app; `terminationGracePeriodSeconds` stops meaning anything, pods get hard-killed mid-request.
- **Revisit:** never no scenario where shell form is better here.

**Port documentation (`EXPOSE`)**
- **Rule:** matches the service's actual `PORT`/`HEALTH_PORT` default, verified against source.
- **Why:** Kubernetes ignores it, but humans read it first when writing Helm values or debugging.
- **Risk:** a wrong port costs someone real time chasing a "connection refused" that isn't one.
- **Revisit:** any time a service's listening port changes in code.

### Metadata and maintenance

**OCI labels (4 static)**
- **Rule:** `image.source`, `.title`, `.description`, `.base.name` on every service no dynamic labels.
- **Why:** one shared ECR repo holds all 9 images; labels are how anyone tells them apart. Dynamic labels need a CI build-arg we don't have yet.
- **Risk:** nothing functional the cost is anyone's ability to identify an image without pulling it.
- **Revisit:** the CI pipeline exists add `created`/`revision` then, sourced from the real build.

**Runtime digest pinning**
- **Rule:** `static-debian13@sha256:<digest>` tag for readability, digest for what's actually pulled.
- **Why:** locks in the exact bytes that were tested; the runtime image doesn't change often, so the pin won't go stale fast.
- **Risk:** none from pinning the risk runs the other direction (see the builder row).
- **Revisit:** on the update cadence below, or if the pinned image might stop getting security fixes.

**Builder stays on a floating tag**
- **Rule:** `golang:1.26-alpine`, no digest.
- **Why:** the builder changes far more often than the runtime; pinning it without automated updates means someone hand-edits 9 Dockerfiles on a schedule nobody keeps.
- **Risk:** pinning without automation freezes the team on whatever digest is current, bugs and CVEs included.
- **Revisit now active:** Jawad installed Renovate on the repo (confirmed). It runs every Monday at 6 AM and watches Terraform, Go modules, GitHub Actions, Dockerfiles, and Docker Compose for updates, auto-raising PRs. The condition this row was waiting on is met pinning the builder by digest is the next Dockerfile ticket, not a deferred one.

## 3. Before vs now

**Takeaway:** three services started with build and runtime collapsed into one image; all 9 are now hardened to the same standard.

| | Before (3 of 9 services) | Now (all 9) |
|---|---|---|
| Runtime image | `golang:alpine` (same as builder) | `distroless/static-debian13`, digest-pinned |
| Size, uncompressed | ~800MB | ~14.7–16.4MB |
| Size, compressed | ~270MB | ~15MB locally verify pushed size in ECR |
| User | root | `nonroot:nonroot` |
| CGO | implicit, worked by accident | `CGO_ENABLED=0` explicit, all 9 |
| Build flags | none | `-trimpath -ldflags="-s -w"`, all 9 |

Operational impact:
- Runtime images fell from ~270MB compressed to roughly ~15MB locally; verify final pushed size in ECR.
- Scan surface dropped from "Go toolchain + Alpine packages + musl" to essentially the binary alone.
- Faster cold pulls on Karpenter scale-up see the Decision evidence appendix for the estimate and its caveats.
- ECR storage stays inside the free tier at current push volume; without the size cut, a lifecycle policy would already be needed.
- Runtime moved from `static-debian12` to `static-debian13` ahead of debian12's September 2026 EOL, pinned by digest at the same time.

Full numbers, formulas, and the migration detail: Decision evidence appendix, at the end of this document.

## 4. Dockerfile standard

**Takeaway:** every service follows the same two-stage shape copy this, fill in the placeholders, don't improvise.

```dockerfile
# --- Builder ---
FROM golang:1.26-alpine AS builder
WORKDIR /build

# go.mod/go.sum copied and downloaded before source this layer only
# re-runs when dependencies actually change, not on every code edit.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /app .

# --- Runtime ---
FROM gcr.io/distroless/static-debian13@sha256:<current-digest>

LABEL org.opencontainers.image.source="https://github.com/Jawwad78/Alpha-Pilot-4week" \
      org.opencontainers.image.title="<service-name>" \
      org.opencontainers.image.description="<one-line service purpose>" \
      org.opencontainers.image.base.name="gcr.io/distroless/static-debian13"

COPY --from=builder /app /app
USER nonroot:nonroot
EXPOSE <port>
CMD ["/app"]
```

- Worker's one deviation: `COPY go.mod ./` only, no `go.sum` zero external dependencies today. Order-service already had a `go.sum`, so when it picked up the AWS SDK for its SQS/outbox work, no Dockerfile line changed only `go.sum` gained entries. That's the pattern to expect: only a currently-dependency-free service needs its `COPY` line touched.

## 5. Service inventory

**Takeaway:** nine services, nine ports; worker and scheduler are health-only and unreachable from the host by default.

| Service | Port | Role | Notes |
|---|---|---|---|
| api-gateway | 8080 | Reverse proxy + JWT auth, external entry point | Only service touching Redis (rate limiting) |
| order-service | 8081 | Order CRUD, lifecycle | Now emitting events through the transactional outbox see the order-events guide |
| inventory-service | 8082 | Stock, reservations, catalog | |
| payment-service | 8083 | Charge/refund/status | |
| notification-service | 8084 | Email/event notifications | |
| shipping-service | 8085 | Shipments, tracking, carriers | |
| dashboard-api | 8086 | Aggregated views, serves the frontend | `go:embed static` bakes `static/index.html` in at compile time `.dockerignore` must not exclude `static/` |
| worker | 8090, health only | Async job / SQS consumer | Not published in `docker-compose.yml`; not yet consuming waiting on reserve/charge/status-change idempotency |
| scheduler | 8091, health only | Cron-style DB jobs | Not published in `docker-compose.yml` |

## 6. Local development workflow

**Takeaway:** five commands cover build, run, check, and teardown.

```bash
docker compose build --no-cache
```

```bash
docker compose up -d
sleep 15   # Postgres + migrations need a few seconds
```

```bash
# Health checks only reaches 8080–8086, see the validation checklist below
for port in 8080 8081 8082 8083 8084 8085 8086; do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$port/healthz)
  echo "Port $port: $code"
done
# expect 200 on all 7
```

```bash
curl -s http://localhost:8086/ | head -5
# expect HTML from the embedded static/index.html
```

```bash
docker compose down -v
```

## 7. Validation before opening a PR

**Takeaway:** six checks are already confirmed working; three are not run those yourself before trusting them.

| Check | Command | Status |
|---|---|---|
| Hadolint | `for f in services/*/Dockerfile; do hadolint "$f"; done` | Manual not wired into pre-commit yet |
| No-cache rebuild | `docker compose build --no-cache` | Confirmed (9/9) |
| Non-root user | `docker inspect <image> --format '{{.Config.User}}'` → `nonroot:nonroot` | Confirmed (9/9) |
| Labels | `docker inspect <image> --format '{{index .Config.Labels "org.opencontainers.image.base.name"}}'` → `gcr.io/distroless/static-debian13` | Confirmed (9/9) |
| Health checks 8080–8086 | see the local workflow commands above | Confirmed (7/7) |
| Dashboard embed | `curl http://localhost:8086/` | Confirmed |
| Static-linking check | `docker build --target builder -t builder-test <svc>/` then `docker run --rm builder-test sh -c "file /app"` → "statically linked" | **Not yet run** |
| Worker/scheduler health | add a temporary `ports:` override, curl, remove it | **Not yet run** no port mapping, no shell to curl from inside |
| Real compressed size in ECR | check after a real push | **Not yet measured** the numbers above are estimates |

## 8. Change scenarios: what I do when requirements change

### 1. A service adds AWS SDK/SQS calls
- **Trigger:** a service starts making SQS (or other AWS) calls.
- **Inspect:** whether it's worker (zero deps today) or a service that already has a `go.sum`. Order-service already went through this no Dockerfile change was needed once it had a `go.sum`.
- **Change:** worker only `COPY go.mod ./` → `COPY go.mod go.sum ./`. Nothing else.
- **Avoid:** setting `CGO_ENABLED=1` "just in case," or hunting for AWS tooling in the base image neither is needed. Order-service's outbox/SQS work confirmed this in practice.
- **Validate:** `docker compose build --no-cache <svc>`, confirm user/labels unchanged, then a real SQS call against Floci.

### 2. A service requires file writes or temp files
- **Trigger:** a service needs local disk state, even temporarily.
- **Inspect:** why every service today is stateless; this breaks that assumption.
- **Change:** likely nothing in the Dockerfile distroless can write unless `readOnlyRootFilesystem` is set, which it isn't, for this reason.
- **Avoid:** adding a default writable directory without checking whether the data needs to survive a restart it won't, without a real volume.
- **Validate:** build and run locally, confirm the app creates its own paths there's no shell to do it for it.

### 3. A service adds a cgo-dependent library
- **Trigger:** a dependency needs a C library with no pure-Go alternative.
- **Inspect:** confirm there's really no pure-Go option this is the one change that breaks the base-image choice outright.
- **Change:** `CGO_ENABLED=0` → `1`, and the runtime can no longer be `distroless/static` needs `distroless/base` at minimum.
- **Avoid:** flipping `CGO_ENABLED=1` and leaving the runtime on `static` it'll build, then fail at startup with an unreadable error.
- **Validate:** build with `CGO_ENABLED=1`, check what the binary actually links against. Bring it to the team before merging always.

### 4. A service needs a new port or health endpoint
- **Trigger:** a new listening port or health check is added.
- **Inspect:** the actual `PORT`/`HEALTH_PORT` default in the Go source don't guess or copy a neighbor.
- **Change:** `EXPOSE <port>`, plus the compose port mapping if it needs host reachability.
- **Avoid:** reusing a port already assigned elsewhere check the service inventory table first.
- **Validate:** `docker inspect <image> --format '{{json .Config.ExposedPorts}}'`, confirm the health check returns 200.

### 5. Dashboard adds new embedded static assets
- **Trigger:** new files added under dashboard-api's embedded static directory.
- **Inspect:** that they land inside whatever path `//go:embed static` covers.
- **Change:** usually nothing `go:embed` is compile-time Go, not Dockerfile logic.
- **Avoid:** adding a runtime `COPY` for the new assets they're already baked into the binary.
- **Validate:** rebuild, curl the new path, confirm it's served from the binary.

### 6. The runtime base-image digest needs updating
- **Trigger:** a security patch or new `static-debian13` build is published.
- **Inspect:** confirm there's an actual reason this was deliberately pinned, not a "just because" change.
- **Change:** the `@sha256:...` in all 9 Dockerfiles; `image.base.name` stays the same string.
- **Avoid:** hand-typing a digest from an unverified source pull it yourself using the update steps below.
- **Validate:** full `docker compose build --no-cache` plus every check in the validation table above this touches all 9 at once.

### 7. A developer wants to use Alpine or a shell in production
- **Trigger:** someone asks to swap the runtime base for something with a shell.
- **Inspect:** what's actually needed usually "I want to exec in and debug," a symptom of missing observability.
- **Change:** none this is a "don't," not a "how to."
- **Avoid:** swapping the runtime base image. That reopens the attack surface and size cost this design closes.
- **Validate:** if `kubectl logs` isn't enough, raise the observability gap instead, or build a separate `Dockerfile.dev` that never ships to a real environment.

### 8. A build becomes slow or image size grows unexpectedly
- **Trigger:** `docker compose build` takes noticeably longer, or an image grows past the ~15MB baseline.
- **Inspect:** which stage and which service time the build, compare size against the ~14.7-16.4MB baseline above.
- **Change:** possibly nothing check for a new dependency (`go.sum` diff) before touching the Dockerfile.
- **Avoid:** reaching for BuildKit cache mounts first evaluated and passed on already (see known limitations below); marginal payoff at this build volume.
- **Validate:** compare before/after size and build time; confirm `-trimpath`/`-ldflags="-s -w"` weren't dropped in a merge.

## 9. Image update and maintenance policy

**Takeaway:** runtime digest updates follow a fixed process; the builder can now be pinned too, now that Renovate is confirmed active.

```bash
docker pull gcr.io/distroless/static-debian13
docker inspect gcr.io/distroless/static-debian13 --format='{{index .RepoDigests 0}}'
# update the @sha256:... in all 9 Dockerfiles, then:
docker compose build --no-cache
# run the validation checklist before merging
```

- Renovate status: installed and active confirmed by Jawad. Runs every Monday 6 AM, watches Terraform, Go modules, GitHub Actions, Dockerfiles, and Docker Compose, auto-raises PRs.
- With that confirmed, the builder image can move from a floating tag to a digest pin in a follow-up PR that was the one blocker on this, and it's cleared.

## 10. Known limitations and deferred improvements

- Builder digest pinning no longer blocked (Renovate is active); next ticket, not deferred.
- CI build/scan pipeline draft only, not live. Every check in the validation table above is manual until it exists.
- Dynamic OCI labels (`created`/`revision`/`version`) need CI build-arg injection.
- BuildKit cache mounts evaluated, passed on for now. Marginal payoff at 9 small services, ~2 min total build time.
- Multi-platform builds not evaluated.
- Kubernetes `securityContext`/probes deployment-layer work, separate from this doc.

## 11. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Binary won't start, no useful error | Not statically linked check `CGO_ENABLED=0` applied |
| `COPY` path mismatch at build | Builder output and runtime `COPY --from=builder` don't both say `/app` |
| Container runs as root | Missing `USER nonroot:nonroot`, or placed before `COPY --from=builder` |
| Wrong port / health check fails | `EXPOSE` or compose mapping doesn't match the service's `PORT`/`HEALTH_PORT` |
| Dashboard blank or 404 | `static/` wasn't in the build context, or `.dockerignore` excludes it |
| Image way bigger than expected (>100MB) | Runtime stage is a golang image, not distroless |
| Digest pull fails | Digest is wrong or deleted upstream re-pull per the update steps above, don't guess |

## 12. Decision evidence appendix

**Early state, in detail.** Three services (order-service, shipping-service, worker) had builder and runtime collapsed into one `golang:alpine` stage full toolchain and shell shipped to what would be production, running as root. We caught this and corrected it to match the other 6.

**Image size, measured.** After the full hardening pass, sizes landed at worker smallest (~14.7MB) and api-gateway largest (~16.4MB), uncompressed roughly a 50x reduction against the three services that started on the Alpine runtime. The debian12→13 migration should sit in the same band; nobody has re-run the size check against the new digest yet.

**Karpenter pull-time estimate.** A new node with nothing cached needs a cold pull for every scheduled pod. Estimate, not benchmarked: a 270MB compressed image takes ~15-20s to pull on a 1Gbps link vs under a second for the distroless equivalent roughly the difference between a scale-out finishing in 30s vs 90s if all 9 images needed a cold pull.

**ECR cost math.** Verified against AWS's current pricing page: private storage $0.10/GB-month, cross-region transfer $0.09/GB, same-region transfer to EC2/Fargate/ECS free, 500MB/month free for new accounts for 12 months.

If all 9 had shipped on the Alpine runtime: one full image set ≈ 270MB × 9 ≈ 2.4GB, about $0.24/month for a single version. The real cost is tag accumulation CI pushes a new tag per merge, and without a lifecycle policy that adds up. At ~40 pushes across a 4-week sprint: ~40 × 2.4GB ≈ 96GB ≈ $9.60/month sitting in ECR, against a $200 total cap covering everything else. On distroless, the same 40 pushes ≈ 40 × (9 × ~15MB) ≈ 5.4GB inside the free tier.

This doesn't decide the sprint's budget either way, but it's the difference between needing an ECR lifecycle policy soon and being able to defer that ticket. It's a rough estimate off base-layer compressed-size figures, not a measurement of the real pushed images worth a five-minute check against actual ECR once the PR merges.