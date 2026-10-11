# Dockerfile Hardening Assessment EKS v2 Order Platform

**Assessed by:** Ahmed (Team Alpha, Platform Engineering)
**Date:** 2026-09-19, Sprint 1
**Scope:** All 9 service Dockerfiles in `services/*/Dockerfile`
**Source of truth:** Sep 18 architecture session, eks-v2 README, actual service source code

---

## 1. Executive Summary

These Dockerfiles are functional multi-stage builds, and whoever wrote the originals understood the general shape of a production Go Dockerfile builder stage, separate runtime stage, dependency caching. That's a real head start over writing them from scratch.

But they were clearly assembled by copying and adapting a template, and the adaptation was incomplete. The result is **three distinct problems at different severity levels**:

1. **Three services (order-service, shipping-service, worker) use `golang:1.24-alpine` as both builder AND runtime.** This means the final image ships with the full Go toolchain, a shell, a package manager, and runs as root. It's a ~800 MB image that defeats the entire purpose of multi-stage builds. This is the single most impactful finding.

2. **All nine Dockerfiles omit `CGO_ENABLED=0` in the build command.** Six of them target `distroless/static-debian12`, which contains no libc at all. If Go ever produces a dynamically-linked binary (which it can, depending on imports and environment), the container will crash at startup with a cryptic error. It works today only because the `golang:alpine` builder image lacks `gcc` by default, making cgo implicitly disabled. That's a fragile assumption that breaks the moment anyone adds a build dependency.

3. **Four out of nine EXPOSE directives point to the wrong port** clear copy-paste residue. This won't break Kubernetes (k8s ignores EXPOSE), but it will confuse every human who reads the Dockerfile to understand the service, and some tooling (docker-compose port inference, IDE integrations) does use it.

Beyond these, there are several lower-severity gaps: empty `.dockerignore` files, no image digest pinning, no build flags for smaller/reproducible binaries, no OCI labels, and inconsistent Go versions across Dockerfiles (some use 1.23, others 1.24, while all `go.mod` files declare 1.22).

**The good news:** every issue is fixable with small, targeted edits. Nothing requires rearchitecting the services or changing how they run. The assessment below walks through each finding with evidence from the actual code, explains the "why" behind each recommendation, and gives you a prioritised implementation plan.

---

## 2. Project-Context Findings

These findings come from reading all 9 `main.go` files, all 9 `go.mod` files, and `docker-compose.yml` not from generic assumptions.

### 2.1 Service Runtime Profiles

Every service falls into one of three runtime categories. This matters because the Dockerfile strategy should match the runtime profile:

**HTTP servers with Postgres (6 services):**
- order-service (8081), inventory-service (8082), payment-service (8083), notification-service (8084), shipping-service (8085), dashboard-api (8086)
- All use `database/sql` + `github.com/lib/pq` (pure Go Postgres driver)
- All run migrations on startup via `CREATE TABLE IF NOT EXISTS`
- All have graceful shutdown (SIGINT/SIGTERM, 30s context timeout)
- All log to stdout via Go's `log` package
- None write to the filesystem at runtime
- dashboard-api additionally uses `go:embed` to bake `static/index.html` into the binary at compile time

**HTTP server with Redis + JWT, no Postgres (1 service):**
- api-gateway (8080)
- Uses `github.com/go-redis/redis/v8` + `github.com/golang-jwt/jwt/v5` (both pure Go)
- Reverse proxy to downstream services
- No filesystem writes

**Background processors with health-check HTTP (2 services):**
- worker (health on 8090): SQS consumer, no primary HTTP port, polls and dispatches to other services
- scheduler (health on 8091): Runs cron-style jobs via `time.Ticker`, queries Postgres directly
- Both expose a small HTTP server just for `/livez` and `/healthz`

### 2.2 Dependency Analysis CGO Compatibility

This is critical for the distroless decision. Every external dependency across all 9 services is **pure Go**:

| Dependency | Used by | Pure Go? |
|---|---|---|
| `github.com/lib/pq` | 7 services | Yes |
| `github.com/go-redis/redis/v8` | api-gateway | Yes |
| `github.com/golang-jwt/jwt/v5` | api-gateway | Yes |
| `github.com/cespare/xxhash/v2` | api-gateway (indirect) | Yes |
| stdlib only | worker | Yes |

**Conclusion:** `CGO_ENABLED=0` is safe for every service. No service needs cgo, and distroless/static (no libc) is the correct base image for all nine.

### 2.3 Filesystem Requirements at Runtime

| Service | Reads files? | Writes files? | Needs shell? |
|---|---|---|---|
| api-gateway | No | No | No |
| order-service | No | No | No |
| inventory-service | No | No | No |
| payment-service | No | No | No |
| notification-service | No | No | No |
| shipping-service | No | No | No |
| dashboard-api | Embedded via `go:embed` (compiled in) | No | No |
| worker | No | No | No |
| scheduler | No | No | No |

**Every service is compatible with:**
- `distroless/static-debian12` (no shell, no libc, no package manager)
- `readOnlyRootFilesystem: true` in Kubernetes SecurityContext
- `allowPrivilegeEscalation: false`

### 2.4 Port Map (source of truth: the Go source code)

| Service | Actual port (from source) | Port in docker-compose |
|---|---|---|
| api-gateway | 8080 (PORT env, default "8080") | 8080:8080 |
| order-service | 8081 (PORT env, default "8081") | 8081:8081 |
| inventory-service | 8082 (PORT env, default "8082") | 8082:8082 |
| payment-service | 8083 (PORT env, default "8083") | 8083:8083 |
| notification-service | 8084 (PORT env, default "8084") | 8084:8084 |
| shipping-service | 8085 (PORT env, default "8085") | 8085:8085 |
| dashboard-api | 8086 (PORT env, default "8086") | 8086:8086 |
| worker | 8090 (HEALTH_PORT env, default "8090") | not mapped |
| scheduler | 8091 (HEALTH_PORT env, default "8091") | not mapped |

---

## 3. Checklist Assessment

Each item evaluated against the actual Dockerfiles with evidence. Verdict: ✅ pass, ⚠️ partial/inconsistent, ❌ fail.

### 3.1 Multi-stage build
**Verdict: ⚠️ Partial**

All 9 Dockerfiles use `AS builder` and a separate `FROM` for runtime. But the purpose of multi-stage is to leave build tools behind and 3 services copy the binary into `golang:1.24-alpine`, which IS a build tool image.

| Service | Builder | Runtime | Effective multi-stage? |
|---|---|---|---|
| api-gateway | golang:1.23-alpine | distroless/static-debian12 | ✅ Yes |
| order-service | golang:1.24-alpine | golang:1.24-alpine | ❌ No same image |
| inventory-service | golang:1.23-alpine | distroless/static-debian12 | ✅ Yes |
| notification-service | golang:1.23-alpine | distroless/static-debian12 | ✅ Yes |
| payment-service | golang:1.23-alpine | distroless/static-debian12 | ✅ Yes |
| shipping-service | golang:1.24-alpine | golang:1.24-alpine | ❌ No same image |
| dashboard-api | golang:1.23-alpine | distroless/static-debian12 | ✅ Yes |
| worker | golang:1.24-alpine | golang:1.24-alpine | ❌ No same image |
| scheduler | golang:1.23-alpine | distroless/static-debian12 | ✅ Yes |

**Why this matters:** The golang:alpine image is roughly 800 MB uncompressed vs ~2.5 MB for distroless/static. That's 320x larger. In EKS, this means slower image pulls on cold starts (especially on new Karpenter-provisioned nodes), more ECR storage and transfer costs, and a massively larger CVE attack surface.

### 3.2 Minimal runtime base image
**Verdict: ⚠️ (6/9 pass)**

The 6 distroless services use `gcr.io/distroless/static-debian12` the gold standard for static Go binaries. No shell, no package manager, no libc. The [official distroless Go example](https://github.com/GoogleContainerTools/distroless/blob/main/examples/go/Dockerfile) uses exactly this image.

The 3 golang-runtime services need to be switched to distroless/static-debian12.

### 3.3 Image tag pinning (SHA256 digest)
**Verdict: ❌ Fail (all 9)**

Every Dockerfile uses mutable tags:
```
FROM golang:1.23-alpine   # ← this changes underneath you
FROM gcr.io/distroless/static-debian12  # ← same
```

A tag can be re-pushed at any time. Your CI build on Monday and Tuesday can produce different images from the same Dockerfile. For reproducibility, pin to digest:
```
FROM golang:1.23-alpine@sha256:<digest>
```

**Project context note:** The team agreed on Hadolint as a pre-commit hook. Hadolint rules [DL3006](https://github.com/hadolint/hadolint/blob/master/src/Hadolint/Rule/DL3006.hs) (always tag) and [DL3007](https://github.com/hadolint/hadolint/issues/773) (don't use `:latest`) will flag untagged images, but Hadolint does NOT enforce digest pinning by default. Digest pinning is a team convention choice.

**Trade-off to understand:** Digest pinning guarantees reproducibility but means you must manually update the digest when you want a newer base image (security patches). Without automation (like Dependabot or Renovate), digests can go stale. For this project's timeline (4 weeks), pinning to a specific tag like `golang:1.23.4-alpine` (patch-level) is a reasonable middle ground. Full digest pinning is the production ideal.

### 3.4 Non-root USER
**Verdict: ⚠️ (6/9 pass)**

| Service | USER directive? | Runs as |
|---|---|---|
| api-gateway | `USER nonroot` | UID 65532 (distroless nonroot) |
| order-service | None | root (UID 0) ❌ |
| inventory-service | `USER nonroot` | UID 65532 |
| notification-service | `USER nonroot` | UID 65532 |
| payment-service | `USER nonroot` | UID 65532 |
| shipping-service | None | root (UID 0) ❌ |
| dashboard-api | `USER nonroot` | UID 65532 |
| worker | None | root (UID 0) ❌ |
| scheduler | `USER nonroot` | UID 65532 |

The 3 services using `golang:alpine` as runtime have no USER directive and will run as root. When they switch to distroless, `USER nonroot` can be added the same way.

**Why this matters for EKS:** Kubernetes `runAsNonRoot: true` in the Pod SecurityContext will refuse to start a container that runs as root. This is a standard security policy for production clusters.

### 3.5 Static binary compilation (CGO_ENABLED=0)
**Verdict: ❌ Fail (all 9)**

Every Dockerfile uses:
```dockerfile
RUN go build -o app .
```

None set `CGO_ENABLED=0`. The [official distroless Go example](https://github.com/GoogleContainerTools/distroless/blob/main/examples/go/Dockerfile) uses:
```dockerfile
RUN CGO_ENABLED=0 go build -o /go/bin/app
```

**Why it works today (accidentally):** The `golang:*-alpine` builder images use musl libc and don't ship with `gcc` by default. Without a C compiler, Go's build system implicitly disables cgo. So the resulting binary happens to be statically linked.

**Why it's fragile:** If anyone adds `RUN apk add build-base` (for example, to use a C library), cgo activates silently, the binary links against musl, and it crashes in distroless/static which has no libc at all. The error message (`exec format error` or `not found`) gives no clue about the real cause. Being explicit costs nothing and prevents a class of hard-to-debug failures.

### 3.6 Go version consistency
**Verdict: ⚠️ Inconsistent**

| File | Go version |
|---|---|
| All go.mod files | `go 1.22` |
| 6 Dockerfiles (Group A) | `golang:1.23-alpine` |
| 3 Dockerfiles (Group B) | `golang:1.24-alpine` |

This isn't broken Go is forward-compatible, so building go 1.22 code with Go 1.24 works fine. But it's inconsistent across the repo, and `golang:1.24-alpine` doesn't exist as a stable release yet (Go 1.24 is still in release candidates as of this writing). The team should standardise on one Go version for all Dockerfiles.

Also worth noting: the module paths say `ecs-v3` (e.g. `module github.com/CoderCo-Learning/ecs-v3/services/api-gateway`) while this project is `eks-v2`. Cosmetic, but signals these were carried over from a different project.

### 3.7 Build layer caching
**Verdict: ✅ Pass (all 9)**

All Dockerfiles correctly separate dependency download from source copy:
```dockerfile
COPY go.mod go.sum ./
RUN go mod download
COPY . .
```

This means a code change doesn't re-download all dependencies. The worker Dockerfile correctly omits `go.sum` since it has zero external dependencies (`COPY go.mod ./`).

### 3.8 EXPOSE matches actual port
**Verdict: ❌ Fail (4/9 wrong)**

| Service | EXPOSE in Dockerfile | Actual port (from source) | Correct? |
|---|---|---|---|
| api-gateway | 8086 | 8080 | ❌ (swapped with dashboard-api) |
| order-service | 8081 | 8081 | ✅ |
| inventory-service | 8082 | 8082 | ✅ |
| notification-service | 8084 | 8084 | ✅ |
| payment-service | 8091 | 8083 | ❌ (has scheduler's health port) |
| shipping-service | 8085 | 8085 | ✅ |
| dashboard-api | 8080 | 8086 | ❌ (swapped with api-gateway) |
| worker | 8090 | 8090 (health) | ✅ |
| scheduler | 8080 | 8091 (health) | ❌ |

The api-gateway and dashboard-api ports are **swapped**. The payment-service has the scheduler's health port. The scheduler has a generic 8080.

**Impact:** EXPOSE is documentation, not enforcement. Kubernetes doesn't read it `containerPort` in the Pod spec is what matters. But humans read Dockerfiles, and wrong EXPOSE will mislead anyone writing Helm values or debugging connectivity. The payment-service Dockerfile also has a comment saying "this application doesn't have a port since it runs in the background" that's the worker/scheduler's comment pasted into a service that very much has an HTTP port.

### 3.9 .dockerignore
**Verdict: ❌ Fail (all 9 empty files)**

Every service has a `.dockerignore` file, but they're all **0 bytes**. Without entries, `COPY . .` sends the entire build context to the Docker daemon: `.git/` history, other Dockerfiles, IDE settings, test fixtures, `go.sum` (already copied separately), the Dockerfile itself.

**Impact:** Slower builds (larger context transfer), potential leaking of sensitive files into the build layer, and wasted cache invalidation when non-source files change.

### 3.10 Build flags for size and reproducibility
**Verdict: ❌ Fail (all 9)**

Current: `go build -o app .`

Missing:
- `-trimpath`: Removes local filesystem paths from the compiled binary. Without it, the binary contains paths like `/build/main.go` which leak your build environment.
- `-ldflags='-s -w'`: Strips the symbol table (`-s`) and DWARF debug info (`-w`). Reduces binary size by 20-30% with no runtime impact.

Example: a Go binary might go from 12 MB to 8 MB. Not huge in absolute terms, but meaningful when you're building and pushing 9 images through CI.

### 3.11 OCI/LABEL metadata
**Verdict: ❌ Fail (all 9 no labels)**

No Dockerfile has any LABEL instruction. With the team's decision to use **one shared ECR repo** (all services in one repository, tagged like `service-name:sha-abc123`), labels become more important they're how you identify what a given image contains when browsing ECR.

Recommended labels (OCI standard):
```dockerfile
LABEL org.opencontainers.image.source="https://github.com/Jawwad78/Alpha-Pilot-4week"
LABEL org.opencontainers.image.description="order-service"
LABEL org.opencontainers.image.version="${VERSION}"
```

### 3.12 CMD exec form
**Verdict: ✅ Pass (all 9)**

All Dockerfiles use the exec form: `CMD ["/app"]` or `CMD ["/bin/app"]`. This is correct the binary becomes PID 1 and receives signals directly, which is essential for the graceful shutdown all services implement.

If any used shell form (`CMD /app`), signals would go to the shell process, not the app, and graceful shutdown would break.

### 3.13 Signal handling compatibility
**Verdict: ✅ Pass (all 9)**

All services register for SIGINT and SIGTERM with a 30-second shutdown timeout. Combined with the exec-form CMD, this means Kubernetes's `preStop` → SIGTERM → `terminationGracePeriodSeconds` flow will work correctly. No issues here.

### 3.14 No secrets in build
**Verdict: ✅ Pass (all 9)**

No Dockerfile bakes in secrets via ENV, ARG, or COPY. All sensitive values (DATABASE_URL, JWT_SECRET, AWS credentials) come from runtime environment variables, which is the correct pattern for EKS + External Secrets.

### 3.15 Read-only filesystem compatibility
**Verdict: ✅ Pass (all 9)**

No service writes to the local filesystem at runtime (confirmed by reading all 9 main.go files). Logs go to stdout. Migrations are SQL DDL. dashboard-api's static files are embedded at compile time. All compatible with `readOnlyRootFilesystem: true`.

### 3.16 HEALTHCHECK instruction
**Verdict: ❌ Absent (all 9) but N/A for this project**

None of the Dockerfiles include a `HEALTHCHECK` instruction. This is **fine** for an EKS deployment. Kubernetes uses its own liveness/readiness probes (configured in the Pod spec / Helm values), and Docker HEALTHCHECK is ignored by Kubernetes entirely.

The only scenario where `HEALTHCHECK` matters is local `docker-compose` development. If you want `docker-compose ps` to show health status, you'd add it. But for production on EKS, skip it it's redundant noise.

**Recommendation: No action needed.** This is an example of a checklist item that is not universally appropriate.

### 3.17 Binary output path consistency
**Verdict: ⚠️ Inconsistent (cosmetic)**

Three different patterns exist across the 9 Dockerfiles:

| Pattern | Services | Builder output | Runtime copies to |
|---|---|---|---|
| A | api-gateway, dashboard-api, order-service, shipping-service, worker | `/build/app` | `/app` |
| B | inventory-service, notification-service, scheduler | `/app` | `/bin/app` |
| C | payment-service | `/app` | `/bin/app` |

The CMD then references either `/app` or `/bin/app` accordingly, so they all work. But the inconsistency is messy and increases the chance of a copy-paste error.

**Recommendation:** Standardise on one pattern. `/bin/app` in the runtime stage is the cleanest it puts the binary where executables conventionally live and keeps the root clean.

### 3.18 WORKDIR in runtime stage
**Verdict: ⚠️ Inconsistent (cosmetic)**

Some Dockerfiles set `WORKDIR /build` in the runtime stage (api-gateway, dashboard-api, order-service, shipping-service, worker). Others don't set a runtime WORKDIR at all. Since no service reads or writes files at runtime, the WORKDIR has no effect. The `/build` name in a runtime image is confusing this isn't a build environment.

**Recommendation:** Either remove `WORKDIR` from the runtime stage entirely (the binary runs from wherever CMD points), or standardise on `WORKDIR /` for clarity.

### 3.19 Container scanning readiness
**Verdict: ⚠️ Partial**

The distroless-based images will have minimal CVE surface (essentially just the binary itself). The 3 golang-runtime images will show hundreds of CVEs from the Go toolchain, Alpine packages, and musl libc noise that wastes triage time in your scanning pipeline.

Switching all 9 to distroless is the single biggest improvement for scan hygiene.

---

## 4. Prioritised Findings

### P0 Fix before merging to main (will break production or create security issues)

**F1. Three services use golang:alpine as runtime image**
- **Services:** order-service, shipping-service, worker
- **Impact:** ~800 MB images (vs ~7 MB with distroless), ships Go compiler + shell + apk package manager, runs as root
- **Root cause:** Whoever wrote these Dockerfiles used the same golang image for both stages instead of switching to distroless
- **Fix:** Change the runtime `FROM` to `gcr.io/distroless/static-debian12`, add `USER nonroot`, adjust COPY path

**F2. No CGO_ENABLED=0 on any build command**
- **Services:** All 9
- **Impact:** Risk of dynamically-linked binary crashing in distroless/static. Currently works accidentally because Alpine golang image lacks gcc.
- **Root cause:** Not included in the template these were copied from
- **Fix:** Add `CGO_ENABLED=0` to the `go build` RUN instruction
- **Evidence:** [Official distroless Go example](https://github.com/GoogleContainerTools/distroless/blob/main/examples/go/Dockerfile) uses `RUN CGO_ENABLED=0 go build`

**F3. Three services run as root (no USER directive)**
- **Services:** order-service, shipping-service, worker (same three as F1)
- **Impact:** Fails `runAsNonRoot` PodSecurityContext; container has full root privileges if compromised
- **Fix:** Resolved automatically when switching to distroless + `USER nonroot` (part of F1 fix)

### P1 Fix before Sprint 2 (should not ship to staging without these)

**F4. EXPOSE ports wrong on 4 services**
- **Services:** api-gateway (says 8086, should be 8080), dashboard-api (says 8080, should be 8086), payment-service (says 8091, should be 8083), scheduler (says 8080, should be 8091)
- **Impact:** Misleading documentation; won't break k8s but will cause confusion when writing Helm values and debugging
- **Fix:** Correct each EXPOSE to match the actual port from the Go source code

**F5. Empty .dockerignore files (all 9)**
- **Impact:** Build context includes .git, IDE files, test fixtures slower builds, wasted cache invalidation
- **Fix:** Populate with standard Go service exclusions

**F6. No build optimisation flags (all 9)**
- **Impact:** Larger binaries (20-30% overhead), local build paths leak into binary
- **Fix:** Change build command to include `-trimpath` and `-ldflags='-s -w'`

### P2 Fix when convenient (polish for production readiness)

**F7. Inconsistent Go versions across Dockerfiles (1.23 vs 1.24)**
- **Impact:** Inconsistency; golang:1.24-alpine may not be a stable release
- **Fix:** Standardise all to `golang:1.23-alpine` (or whatever the team agrees)

**F8. No image digest pinning**
- **Impact:** Non-reproducible builds; same Dockerfile can produce different results on different days
- **Fix:** Pin to at least patch-level tags; full SHA256 digest for production ideal

**F9. No OCI LABEL metadata**
- **Impact:** Hard to identify images in shared ECR repo
- **Fix:** Add standard OCI labels (source, description, version)

**F10. Inconsistent binary paths and WORKDIR in runtime stage**
- **Impact:** Cosmetic, increases copy-paste error risk
- **Fix:** Standardise on one pattern across all Dockerfiles

---

## 5. Recommended Implementation

### Reference Dockerfile The Target State

Here is what a corrected Dockerfile looks like, using order-service as the example. I'm showing this so you understand the target not so you copy-paste it blindly. Each change is annotated with which finding it addresses.

```dockerfile
# === Builder stage ===
FROM golang:1.23-alpine AS builder
# [F7] Standardised Go version across all services
# [F8] For full production pinning, append @sha256:<digest>

WORKDIR /build

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# [F2] CGO_ENABLED=0 ensures a fully static binary (required for distroless/static)
# [F6] -trimpath removes local paths; -ldflags strips debug symbols
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /bin/app .

# === Runtime stage ===
# [F1] distroless/static: no shell, no libc, no package manager (~2.5 MB)
FROM gcr.io/distroless/static-debian12

# [F9] OCI labels for image identification in shared ECR repo
LABEL org.opencontainers.image.source="https://github.com/Jawwad78/Alpha-Pilot-4week"
LABEL org.opencontainers.image.description="order-service"

# [F10] Standardised binary location
COPY --from=builder /bin/app /bin/app

# [F3] Run as non-root (UID 65532 in distroless)
USER nonroot

# [F4] Matches actual port from order-service main.go (PORT default "8081")
EXPOSE 8081

CMD ["/bin/app"]
```

### Per-Service Diff Summary

What changes for each service relative to the reference above:

| Service | EXPOSE | Extra notes |
|---|---|---|
| api-gateway | 8080 | Has go-redis + jwt deps (both pure Go, CGO_ENABLED=0 safe) |
| order-service | 8081 | Reference example above |
| inventory-service | 8082 | Already distroless; fix build flags + EXPOSE (currently correct) |
| notification-service | 8084 | Already distroless; fix build flags + EXPOSE (currently correct) |
| payment-service | 8083 | Already distroless; fix build flags + EXPOSE (currently 8091 wrong) |
| shipping-service | 8085 | Switch to distroless; fix build flags + EXPOSE (currently correct) |
| dashboard-api | 8086 | Has `go:embed` for static/ works fine with distroless, embed is compile-time |
| worker | 8090 | Switch to distroless; health port only; copies only go.mod (no go.sum) |
| scheduler | 8091 | Already distroless; fix build flags + EXPOSE (currently 8080 wrong) |

### Recommended .dockerignore (same for all services)

```
.git
.github
.gitignore
.dockerignore
Dockerfile
README.md
*.md
.env
.env.*
.vscode
.idea
*.test
*_test.go
```

---

## 6. Explanation Why Each Change Matters

### CGO_ENABLED=0 The Invisible Landmine

Go can produce two kinds of binaries: statically linked (all code inside the binary) and dynamically linked (binary depends on external shared libraries like libc).

The `distroless/static-debian12` image contains **no shared libraries**. If your binary needs libc, it will fail with a confusing error at container startup either "not found" or "exec format error" neither of which mentions libc.

By default, Go tries to use cgo (which requires a C compiler and produces dynamically-linked binaries) for certain stdlib packages like `net` and `os/user`. On Alpine, `gcc` isn't installed in the base `golang:alpine` image, so cgo silently disables itself. Your binary ends up statically linked by accident.

Setting `CGO_ENABLED=0` makes this explicit and intentional. It costs you nothing (all your dependencies are pure Go) and protects against the scenario where someone adds `RUN apk add build-base` for any reason.

The official distroless repository's own Go example [does exactly this](https://github.com/GoogleContainerTools/distroless/blob/main/examples/go/Dockerfile). The [distroless issue #58](https://github.com/GoogleContainerTools/distroless/issues/58) was specifically filed to document this requirement.

### distroless/static vs golang:alpine as Runtime Not Just Size

| Property | distroless/static-debian12 | golang:1.24-alpine |
|---|---|---|
| Compressed size | ~1.3 MB | ~270 MB |
| Uncompressed size | ~2.5 MB | ~800 MB |
| Shell | None | /bin/sh (ash) |
| Package manager | None | apk |
| Libc | None | musl |
| CVE surface | Binary only | Go toolchain + Alpine packages + musl |
| Exec into container | Not possible (no shell) | Possible (`kubectl exec -it`) |

**Size matters on EKS with Karpenter.** When Karpenter provisions a new node to handle scale-up, every pod on that node needs its image pulled. A 270 MB compressed image takes ~15-20 seconds on a typical 1 Gbps ENA connection. A 1.3 MB image takes under a second. That's the difference between your scaling event completing in 30 seconds vs 90 seconds.

**No shell is a feature, not a bug.** If an attacker achieves remote code execution inside your container, they can't drop to a shell, install tools, or pivot. There's literally nothing to run except your binary. For debugging, `kubectl logs` and `kubectl port-forward` work fine without exec access and the team's observability stack (the README mandates it) is the proper debugging path.

### -trimpath and -ldflags='-s -w' Small Wins That Compound

`-trimpath` removes references to your local build directory from the binary. Without it, stack traces and error messages contain paths like `/build/services/order-service/main.go:142`. This leaks your build environment structure and makes builds non-reproducible (the path is embedded in the binary, so building on different machines produces different binaries even from identical source).

`-ldflags='-s -w'` strips the symbol table and DWARF debug information. Unless you're attaching a debugger to a running container (which you can't in distroless anyway), you don't need these. Typical savings: 20-30% of binary size.

For 9 services built in CI on every push, these savings add up in build time, push time, and ECR storage.

### EXPOSE Documentation That Should Be Accurate

EXPOSE doesn't publish ports. It doesn't open anything. It's metadata a machine-readable comment saying "this container listens on this port."

Kubernetes ignores it entirely; the port is set in `containerPort` in the pod spec. But humans don't ignore it. When someone writes the Helm values for a service they didn't write the code for, the first thing they check is the Dockerfile's EXPOSE. If it says 8086 and the service actually listens on 8080, they'll wire up the wrong port in the service manifest and spend time debugging "connection refused."

---

## 7. Validation Plan

### 7.1 Before committing Local checks

**Run Hadolint on every Dockerfile:**
```bash
# From repo root
for svc in services/*/Dockerfile; do
  echo "=== $svc ==="
  hadolint "$svc"
done
```
Hadolint should pass with no errors on the corrected Dockerfiles. It will flag DL3006 (always tag your base image) which the current images already satisfy.

**Build each image and verify size:**
```bash
for svc in api-gateway order-service inventory-service payment-service notification-service shipping-service dashboard-api worker scheduler; do
  docker build -t "eks-v2/$svc:test" "services/$svc/"
  docker images "eks-v2/$svc:test" --format "{{.Repository}}:{{.Tag}} {{.Size}}"
done
```
Expected: every image should be under 15 MB. If any image is over 100 MB, the runtime base image is wrong.

**Verify the binary is statically linked:**
```bash
# In the builder stage (or use docker run with the builder target)
docker build --target builder -t builder-test services/order-service/
docker run --rm builder-test sh -c "file /bin/app"
```
Should show: `ELF 64-bit LSB executable, x86-64, statically linked`

If it says `dynamically linked`, `CGO_ENABLED=0` is not being applied.

**Test that the container starts and responds:**
```bash
# Start just postgres + the service
docker compose up -d postgres order-service
sleep 5
curl -s http://localhost:8081/healthz | jq .
# Expected: {"status":"ok","service":"order-service"}
docker compose down
```

### 7.2 Verify non-root

```bash
docker run --rm eks-v2/order-service:test whoami 2>&1 || echo "(expected to fail no shell in distroless)"
# For distroless, verify via:
docker inspect eks-v2/order-service:test --format '{{.Config.User}}'
# Expected: nonroot
```

### 7.3 Verify .dockerignore works

```bash
# Create a junk file and verify it's excluded from the build context
touch services/order-service/.env.secret
docker build services/order-service/ 2>&1 | head -5
# The "Sending build context to Docker daemon" line should not include .env files
rm services/order-service/.env.secret
```

### 7.4 CI verification (after PR merge)

Once the Dockerfiles are committed and the CI pipeline (GitHub Actions OIDC → Docker build → ECR push) is running:
1. Check ECR image sizes all should be under 15 MB compressed
2. Run Trivy/Grype scan on the pushed images distroless images should show 0 or near-0 CVEs (vs hundreds for golang:alpine)
3. Deploy to dev namespace verify all pods start with `runAsNonRoot: true` in the security context

---

## 8. Implementation Plan

### Phase 1 P0 fixes (do this now, Sprint 1)
**Estimated time: 1-2 hours for all 9 Dockerfiles**

1. Fix the 3 golang-runtime Dockerfiles (order-service, shipping-service, worker):
   - Change runtime `FROM` to `gcr.io/distroless/static-debian12`
   - Add `USER nonroot`
   - Adjust COPY path to `/bin/app` and CMD to `["/bin/app"]`
   - Remove unnecessary `WORKDIR /build` in runtime stage

2. Add `CGO_ENABLED=0` to all 9 build commands

3. Fix EXPOSE on the 4 wrong services

4. Local build + test each service to verify it starts

5. One PR titled something like "Harden Dockerfiles: distroless runtime, static builds, correct ports" reviewable by the team, demonstrates you understand what changed and why.

### Phase 2 P1 fixes (early Sprint 2)
**Estimated time: 30-45 minutes**

1. Add `-trimpath -ldflags='-s -w'` to all 9 build commands
2. Populate all 9 `.dockerignore` files
3. Add OCI LABEL metadata to all 9 Dockerfiles

### Phase 3 P2 polish (when CI pipeline is running)
**Estimated time: 15-30 minutes**

1. Standardise Go version across all Dockerfiles
2. Standardise binary paths and WORKDIR
3. Consider digest pinning (or at minimum, patch-level version tags)
4. Document the team's Dockerfile conventions in the repo (a `docs/dockerfile-conventions.md` or a section in the README)

---

## Appendix: Raw Dockerfile Inventory

For reference, here is exactly what was found in each Dockerfile at the time of assessment. All Dockerfiles were read from Ahmed's local repo branch `alpha-61-floci-setup`.

| Service | Builder FROM | Runtime FROM | Build cmd | USER | EXPOSE | Binary path |
|---|---|---|---|---|---|---|
| api-gateway | golang:1.23-alpine | distroless/static-debian12 | `go build -o app .` | nonroot | 8086 ❌ | /app |
| order-service | golang:1.24-alpine | golang:1.24-alpine ❌ | `go build -o app .` | none ❌ | 8081 | /app |
| inventory-service | golang:1.23-alpine | distroless/static-debian12 | `go build -o /app .` | nonroot | 8082 | /bin/app |
| notification-service | golang:1.23-alpine | distroless/static-debian12 | `go build -o /app .` | nonroot | 8084 | /bin/app |
| payment-service | golang:1.23-alpine | distroless/static-debian12 | `go build -o /app .` | nonroot | 8091 ❌ | /bin/app |
| shipping-service | golang:1.24-alpine | golang:1.24-alpine ❌ | `go build -o app .` | none ❌ | 8085 | /app |
| dashboard-api | golang:1.23-alpine | distroless/static-debian12 | `go build -o app .` | nonroot | 8080 ❌ | /app |
| worker | golang:1.24-alpine | golang:1.24-alpine ❌ | `go build -o app .` | none ❌ | 8090 | /app |
| scheduler | golang:1.23-alpine | distroless/static-debian12 | `go build -o /app .` | nonroot | 8080 ❌ | /bin/app |

**Sources consulted:**
- [GoogleContainerTools/distroless official Go example Dockerfile](https://github.com/GoogleContainerTools/distroless/blob/main/examples/go/Dockerfile)
- [distroless issue #58 Document CGO_ENABLED=0 requirement](https://github.com/GoogleContainerTools/distroless/issues/58)
- [distroless README gcr.io registry status](https://github.com/GoogleContainerTools/distroless)
- [Hadolint DL3006/DL3007 image tagging rules](https://github.com/hadolint/hadolint)
- [Docker Multi-Stage Builds for Go (2026)](https://dev.to/young_gao/docker-multi-stage-builds-for-go-from-1gb-to-12mb-production-images-2p1h)
- [Docker EXPOSE documentation](https://dev.to/sudhz_/expose-vs-publish-in-docker-a-deeper-dive-457g)

---

## 9. Implementation Readiness

### 9.1 Confirmed Findings (verified against source code no ambiguity)

Every finding below was verified by reading the actual Dockerfile, the corresponding `main.go`, `go.mod`, and `docker-compose.yml`. None rely on assumptions or generic advice.

| Finding | Verified how | Confidence |
|---|---|---|
| F1: 3 services use golang:alpine as runtime | Read each Dockerfile's runtime `FROM` line | 100% the text is right there |
| F2: CGO_ENABLED=0 missing from all 9 | Grep'd all build commands; none set it | 100% absence confirmed |
| F3: 3 services run as root | Read each Dockerfile for USER directive; 3 have none | 100% |
| F4: 4 wrong EXPOSE ports | Cross-referenced EXPOSE against `http.ListenAndServe` in each main.go and PORT/HEALTH_PORT env defaults | 100% port values verified in source |
| F5: All .dockerignore files 0 bytes | `ls -la` on all 9 files | 100% |
| F6: No build optimization flags | Read all build commands | 100% |
| F7: Go version inconsistency (1.23 vs 1.24 in Dockerfiles, 1.22 in go.mod) | Read all Dockerfiles + all go.mod files | 100% |
| F9: No OCI labels | Read all Dockerfiles | 100% |
| F10: Inconsistent binary paths (/app vs /bin/app) | Read all COPY and CMD instructions | 100% |
| All deps pure Go (CGO_ENABLED=0 safe) | Read every go.mod lib/pq, go-redis, golang-jwt all pure Go; worker has zero deps | 100% no cgo import in any module |
| No runtime filesystem writes (distroless safe) | Read every main.go no os.Create, os.OpenFile, ioutil.WriteFile | 100% |
| dashboard-api go:embed works in distroless | embed bakes files into binary at compile time; runtime image doesn't need the source files | 100% embed is a build-time operation |

### 9.2 Findings That Need Runtime Validation

These are confirmed by code reading but should still be tested with an actual build before the PR merges. "Confirmed in code" and "confirmed it actually runs" are different things.

| What to validate | Why | Test |
|---|---|---|
| Static binary produced with CGO_ENABLED=0 | We know all deps are pure Go, but the builder image's environment could have surprises | `docker build --target builder` → `docker run --rm builder-test file /bin/app` → must show "statically linked" |
| Each distroless container starts and responds | Distroless has no shell for debugging; if anything is wrong (bad COPY path, missing env, wrong CMD), it fails silently | `docker compose up -d <service>` → `curl localhost:<port>/healthz` → 200 OK within 10 seconds |
| dashboard-api serves embedded static content | go:embed compiles the `static/` directory into the binary; should work but the embedded path must match the `go:embed` directive | `curl localhost:8086/` → returns HTML content from embedded `static/index.html` |
| worker starts without SQS (currently stubbed) | Worker's SQS consume is stubbed (returns nil), so it should start fine with no queue URL. But switching to distroless + nonroot shouldn't break the health endpoint | `curl localhost:8090/livez` → 200 OK |
| Hadolint clean pass | Hadolint is the team's agreed pre-commit hook; corrected Dockerfiles should pass with no errors or warnings | `hadolint services/*/Dockerfile` → 0 warnings |

### 9.3 Conflicts with Team Conventions or Existing Tickets

**Ticket overlap:**
- **ALPHA-18 through ALPHA-26** (9 individual "Write Dockerfile for X" tickets) are currently in Backlog, mostly unassigned. The architecture session locked Ahmed as owner ("handling for consistency"). This assessment IS the research output for those tickets it tells you what each Dockerfile needs before it's merge-ready.
- **ALPHA-56** (Research Dockerfiles approach) is already marked Done. This assessment goes deeper than that ticket's scope. Consider linking this document as a comment on ALPHA-56 for traceability.
- **Ticket proposal B8** (Docker build CI pipeline) expects container image scanning before push. The P0 fixes (switching to distroless) directly reduce scan noise do them first so the pipeline doesn't drown in golang:alpine CVEs on day one.

**Convention alignment:**
- **Hadolint** (pre-commit hook, Standup #3): all recommendations here are Hadolint-compatible. The corrected Dockerfiles should pass `hadolint` cleanly. Hadolint's DL3006 (always tag) and DL3007 (no `:latest`) are already satisfied by the current Dockerfiles. Hadolint does NOT enforce CGO_ENABLED=0, digest pinning, or label metadata those are code-review and ADR concerns.
- **One shared ECR repo** (team decision, Sep 18 lobby): this makes OCI labels (F9, P2) more important than they'd be with per-service repos, since you'll be browsing one repo with 9 differently-tagged images. Not a conflict just elevates a P2 item's practical value.
- **Semantic commits** (Sep 18 architecture session): the Dockerfile PR should follow `fix(docker): harden Dockerfiles distroless runtime, static builds, correct ports`. Module scope = `docker`, not individual service names, since it's a batch fix.

**Potential friction:**
- **Go version standardisation (F7):** `go.mod` files say `go 1.22`, Dockerfiles are split between `golang:1.23-alpine` and `golang:1.24-alpine`. Standardising the Dockerfile builder version is a P2 item and doesn't need to block Phase 1. But whoever picks a version should confirm `golang:1.24-alpine` actually exists as a stable release (Go 1.24 was released in Feb 2025, so it exists but the team should decide on one version). This is a team decision, not a unilateral call.
- **Module paths say ecs-v3:** the `go.mod` module paths reference `ecs-v3`, not `eks-v2`. Cosmetic but confusing. Renaming them is a separate PR concern don't bundle it with Dockerfile hardening.

### 9.4 Smallest Safe Phase 1 Scope

One PR. Nine Dockerfiles. Three categories of change:

**Category A the 3 broken Dockerfiles (order-service, shipping-service, worker):**
1. Change runtime `FROM golang:1.24-alpine` → `FROM gcr.io/distroless/static-debian12`
2. Add `USER nonroot` before EXPOSE
3. Add `CGO_ENABLED=0` to `go build` command
4. Correct COPY path to `/bin/app`, CMD to `["/bin/app"]`
5. Remove `WORKDIR /build` from runtime stage

**Category B the 6 existing distroless Dockerfiles:**
1. Add `CGO_ENABLED=0` to `go build` command

**Category C the 4 wrong EXPOSE values:**
1. api-gateway: `EXPOSE 8086` → `EXPOSE 8080`
2. dashboard-api: `EXPOSE 8080` → `EXPOSE 8086`
3. payment-service: `EXPOSE 8091` → `EXPOSE 8083`
4. scheduler: `EXPOSE 8080` → `EXPOSE 8091`

**What Phase 1 does NOT touch** (deferred to Phase 2):
- Build optimization flags (`-trimpath`, `-ldflags`)
- .dockerignore population
- OCI labels
- Go version standardisation
- Digest pinning
- Binary path standardisation across the 6 already-correct Dockerfiles

**Why this scope is safe:**
- Category A changes the runtime image and user measurable impact (image size drops from ~800 MB to ~7 MB), verifiable in one build
- Category B adds an explicit env var to what Go already does implicitly zero behavioural change, just removes fragility
- Category C corrects documentation metadata zero runtime impact

**Estimated time:** 1–2 hours including validation. All 9 Dockerfiles are structurally identical; the changes are mechanical once you've done the first one.

### 9.5 Exact Validation Tests Required Before Merging

Run these in order. If any step fails, stop and investigate before proceeding.

**Step 1: Hadolint (static analysis)**
```bash
for svc in api-gateway order-service inventory-service payment-service \
           notification-service shipping-service dashboard-api worker scheduler; do
  echo "=== $svc ==="
  hadolint "services/$svc/Dockerfile"
done
# Expected: 0 errors, 0 warnings for all 9
```

**Step 2: Build all 9 images**
```bash
for svc in api-gateway order-service inventory-service payment-service \
           notification-service shipping-service dashboard-api worker scheduler; do
  echo "=== Building $svc ==="
  docker build -t "eks-v2/$svc:test" "services/$svc/" || { echo "FAIL: $svc"; exit 1; }
done
# Expected: all 9 build successfully with no errors
```

**Step 3: Verify image sizes**
```bash
for svc in api-gateway order-service inventory-service payment-service \
           notification-service shipping-service dashboard-api worker scheduler; do
  docker images "eks-v2/$svc:test" --format "{{.Repository}}:{{.Tag}} {{.Size}}"
done
# Expected: every image under 15 MB
# Fail condition: any image over 100 MB means wrong runtime base image
```

**Step 4: Verify static binary (spot-check one)**
```bash
docker build --target builder -t builder-test services/order-service/
docker run --rm builder-test sh -c "file /bin/app"
# Expected: "ELF 64-bit LSB executable, x86-64, statically linked"
# If it says "dynamically linked", CGO_ENABLED=0 is not applied
```

**Step 5: Verify non-root user (all 9)**
```bash
for svc in api-gateway order-service inventory-service payment-service \
           notification-service shipping-service dashboard-api worker scheduler; do
  user=$(docker inspect "eks-v2/$svc:test" --format '{{.Config.User}}')
  echo "$svc: User=$user"
done
# Expected: all show "nonroot"
```

**Step 6: Verify EXPOSE values (all 9)**
```bash
for svc in api-gateway order-service inventory-service payment-service \
           notification-service shipping-service dashboard-api worker scheduler; do
  ports=$(docker inspect "eks-v2/$svc:test" --format '{{json .Config.ExposedPorts}}')
  echo "$svc: $ports"
done
# Expected ports:
#   api-gateway: 8080    order-service: 8081     inventory-service: 8082
#   payment-service: 8083  notification-service: 8084  shipping-service: 8085
#   dashboard-api: 8086   worker: 8090            scheduler: 8091
```

**Step 7: Smoke-test containers (requires docker-compose infra)**
```bash
# Start Postgres + Redis first
docker compose up -d postgres redis

# Test each service with Postgres
for svc in order-service inventory-service payment-service \
           notification-service shipping-service dashboard-api scheduler; do
  docker compose up -d "$svc"
  sleep 3
  port=$(docker compose port "$svc" $(docker inspect "eks-v2/$svc:test" \
    --format '{{range $p, $_ := .Config.ExposedPorts}}{{$p}}{{end}}' | cut -d/ -f1) \
    2>/dev/null | cut -d: -f2)
  curl -sf "http://localhost:$port/healthz" && echo " ✅ $svc" || echo " ❌ $svc"
  docker compose stop "$svc"
done

# Test api-gateway (needs Redis)
docker compose up -d api-gateway
sleep 3
curl -sf http://localhost:8080/healthz && echo " ✅ api-gateway" || echo " ❌ api-gateway"
docker compose stop api-gateway

# Test worker (health-only, no SQS needed since stubbed)
docker compose up -d worker
sleep 3
curl -sf http://localhost:8090/livez && echo " ✅ worker" || echo " ❌ worker"

docker compose down
```

**Step 8: Verify dashboard-api serves embedded content**
```bash
docker compose up -d postgres dashboard-api
sleep 3
curl -sf http://localhost:8086/ | head -5
# Expected: HTML content from embedded static/index.html
docker compose down
```

**All 8 steps pass = safe to open the PR.**

---

*End of assessment. This document is Ahmed's private research output when the Dockerfiles PR is raised, the PR description should be a concise summary of what changed and why, not a paste of this entire document.*
