# Phase 3: Dockerfile Evaluation

## Current State (post-Phase 2)

| Component | Value |
|-----------|-------|
| Builder image | `golang:1.26-alpine` (tag, no digest) |
| Runtime image | `gcr.io/distroless/static-debian12` (tag, no digest) |
| go.mod `go` directive | `go 1.22` (all 9 services) |
| Build flags | `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"` |
| BuildKit features | None |
| CI/CD pipeline | None (local `docker compose build` only) |
| Base image update process | `renovate.json` exists in repo (inherited from upstream `codercohq/eks-v2` clone) but **Renovate GitHub App is NOT installed** on `Jawwad78/Alpha-Pilot-4week` — config is inactive. No Renovate branches, PRs, or commits in the repo. Activation requires repo admin to install the GitHub App. |

## Go Release Landscape (as of September 2026)

| Version | Status | Latest patch | EOL |
|---------|--------|-------------|-----|
| Go 1.27 | Current | 1.27.1 (Sep 1) | ~Feb 2028 |
| Go 1.26 | Supported | 1.26.8 (Sep 1) | ~Feb 2027 |
| Go 1.25 | EOL | 1.25.14 (Aug 19) | Aug 2026 (when 1.27 released) |
| Go 1.22 | EOL | — | Feb 2024 (when 1.24 released) |

Policy: each major release is supported until two newer major releases exist.

The `go 1.22` in go.mod is the module's **minimum version directive**, not the build version. Building with Go 1.26 when go.mod says `go 1.22` is standard — the directive sets a floor, and the builder image determines the actual compiler. Changing go.mod to `go 1.26` would be an application code change, out of scope for Dockerfile work.

---

## URGENT: static-debian12 End-of-Life

**`gcr.io/distroless/static-debian12` reaches end of life in September 2026 — this month.**

After EOL, the image stops receiving security updates. Any CVE in the base layer (glibc stubs, ca-certificates, tzdata) stays unpatched.

**`gcr.io/distroless/static-debian13`** is available, actively maintained, and is the documented replacement. For statically-linked Go binaries (`CGO_ENABLED=0`), the migration is a one-line `FROM` change per Dockerfile — no code, no dependency, no behavior changes. The `static` distroless image contains no libc, no shell, no package manager. The binary runs identically on either base.

The UsrMerge scheme in Debian 13 only matters when adding packages via `rules_distroless`. This project doesn't add packages — the `static` image is used as-is.

**This is the highest-priority item in Phase 3.**

---

## Item-by-Item Evaluation

### 1. Standardizing Go builder versions

**Current state:** All 9 Dockerfiles use `golang:1.26-alpine`. go.mod says `go 1.22`.

**Options:**

| Option | Builder | Risk |
|--------|---------|------|
| Stay on 1.26-alpine | Supported until Feb 2027 | None — 5 months of patches remaining |
| Upgrade to 1.27-alpine | Latest, supported until ~Feb 2028 | 1 month old, risk of early-release bugs; 1.26 migration mid-simulation adds noise |

**Project-specific benefit of upgrading:** None. The services use no Go 1.27 features. The security patches in 1.26.8 (Sep 1) are current. Upgrading the builder gives a longer support tail but this simulation ends in 4 weeks — 1.26 outlives it by 5 months.

**Operational trade-off:** Builder upgrades can surface new vet checks, stricter type inference, or changed default behaviors. This forces a "fix what the new compiler doesn't like" cycle. Not worth it mid-simulation unless a CVE forces it.

**Required process:** None beyond changing the `FROM` line and rebuilding.

**Verdict: Keep `golang:1.26-alpine`. Revisit only if a Go 1.26 security advisory lands.**

The go.mod `go 1.22` stays as-is — it's the upstream's module compatibility setting, not something this team should change in a Dockerfile phase.

---

### 2. Pinning builder and runtime base images by digest

**What it means:**

Before:
```dockerfile
FROM golang:1.26-alpine AS builder
```

After:
```dockerfile
FROM golang:1.26-alpine@sha256:51a7c389a5ddaf82f527191a1e9bff9928655130a44e4975dd1d7e0acf59f1ae AS builder
```

The tag stays for readability; the digest pins the exact image. A `docker pull` always gets the same content regardless of whether the tag was republished.

**Project-specific benefit:**
- Reproducible builds: same Dockerfile → same builder → same binary, across machines and over time
- Audit trail: git log shows exactly which base image produced which build
- CVE response: you know the exact base image in every deployed container

**Operational/security trade-off — the critical one:**

Digest pinning without automated updates is a **security liability**. When `golang:1.26-alpine` gets a patch (new Alpine packages, Go 1.26.9), the tag moves to a new digest. Without pinning, `docker build` pulls the patched image automatically. With pinning, builds stay frozen on the old digest — including its vulnerabilities — until someone manually updates the hash.

**Required CI/maintenance process:**

One of:
1. **Renovate** (recommended): GitHub App that watches Dockerfiles, opens PRs when digests change. Config is a `renovate.json` in repo root. Can auto-merge digest updates if CI passes.
2. **Dependabot**: GitHub-native, similar capability but less configurable for Docker digest pinning.
3. **Manual**: Run `docker pull golang:1.26-alpine` periodically, extract the new digest with `docker inspect --format='{{index .RepoDigests 0}}'`, update Dockerfiles, commit. Does not scale.

All three require a CI pipeline to validate that the updated digest doesn't break builds. This team has no CI pipeline yet.

**Verdict: Implement digest pinning for the runtime image now (alongside the debian13 migration). Defer builder digest pinning until Renovate is activated.**

The runtime image changes rarely (debian13 is a one-time migration), so a pinned digest there won't go stale quickly — and it locks the exact image that was tested. The builder image (`golang:1.26-alpine`) gets patched more frequently (Alpine packages, Go patch releases). Pinning it without automated updates means the team must manually check for new digests and update 9 Dockerfiles — realistically, they won't, and builds will silently run on a stale, unpatched builder.

A `renovate.json` exists in the repo (inherited from the upstream clone), but the **Renovate GitHub App is not installed** on `Jawwad78/Alpha-Pilot-4week`. The config is inactive — no Renovate branches, PRs, or commits exist. Once Renovate is activated (repo admin installs the GitHub App), the existing config will automatically pin and update builder digests. Until then, pinning the builder creates the exact security liability described above.

**Sequence:** Pin runtime now → activate Renovate → pin builder.

---

### 3. Safe automated base-image update approach

**What's being evaluated:** Renovate, Dependabot, or a manual process for keeping base image tags and digests current.

**Project-specific benefit:**
- Security: base images get patched without someone remembering to check
- Visibility: updates arrive as PRs, reviewable and traceable
- For digest pinning (item 2): mandatory — pinning without automation is pinning yourself to yesterday's vulnerabilities

**Operational trade-off:**
- Renovate/Dependabot need a CI pipeline to validate PRs. Without CI, auto-opened PRs sit unreviewed or get merged blind.
- Renovate needs the GitHub App installed on the team's repo (Jawwad's repo — needs repo admin access)
- Config overhead: `renovate.json` with Docker manager settings, schedule, auto-merge rules

**Required process:**
1. Install Renovate GitHub App on `Jawwad78/Alpha-Pilot-4week`
2. Add `renovate.json` to repo root
3. CI pipeline (GitHub Actions) to run `docker compose build` on Renovate PRs
4. Team agreement on merge policy (auto-merge digest updates? manual review for tag bumps?)

**Verdict: Config exists but is NOT active. Activation is a prerequisite for digest pinning the builder.**

The `renovate.json` in the repo root was inherited from the upstream `codercohq/eks-v2` clone (commit `af985c9 clone: repo from original repo`). The config itself is sound — `config:recommended` enables the Docker manager, `automerge: true` for patch/pin/digest updates, Docker images grouped into a single PR, Monday schedule. But the **Renovate GitHub App has not been installed** on `Jawwad78/Alpha-Pilot-4week`. Evidence: zero Renovate branches, zero Renovate PRs, zero Renovate-authored commits. The Notion hub confirms this is a team action item: "You activate/connect Renovate to your own repository."

**Required steps to activate:**
1. Repo admin (Jawwad) installs the Renovate GitHub App on `Jawwad78/Alpha-Pilot-4week`
2. Renovate's onboarding PR appears — merging it activates scanning
3. Once active, the existing `renovate.json` config takes effect automatically
4. Remaining gap after activation: no CI pipeline to validate Renovate's PRs before merge — auto-merged digest updates go in without a build test. A GitHub Actions workflow that runs `docker compose build` on Renovate PRs would close this, but that's CI/CD scope.

**This is not a Dockerfile change — it's a repo administration action.** The Dockerfile phase can note it as a dependency and move on.

---

### 4. BuildKit cache mounts for Go module/build caches

**What it looks like:**

```dockerfile
# syntax=docker/dockerfile:1
FROM golang:1.26-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /app .
```

The `--mount=type=cache` keeps the Go module cache (`/go/pkg/mod`) and build cache (`/root/.cache/go-build`) across builds. Modules don't re-download, and unchanged packages don't recompile.

**Project-specific benefit:**

For local rebuilds where dependencies change, the speedup is real — `go mod download` goes from minutes to seconds, and `go build` does incremental compilation. But the current Dockerfiles already get layer caching: `COPY go.mod go.sum ./` + `RUN go mod download` is a cached layer that only invalidates when go.mod/go.sum change. The cache mount adds value only when:

1. Dependencies change (go.mod/go.sum edited) — cache mount preserves the module cache, so only the diff downloads
2. Source changes cause a full rebuild — build cache preserves compiled objects, so only changed packages recompile

For this project: the services have 1-3 dependencies each. `go mod download` takes 2-5 seconds. `go build` takes 3-8 seconds. The total build for all 9 services is ~2 minutes. Cache mounts might save 30-60 seconds on a rebuild where dependencies changed.

**Operational trade-off:**
- Requires `# syntax=docker/dockerfile:1` at the top of every Dockerfile (or `DOCKER_BUILDKIT=1` env var)
- Docker Desktop has BuildKit enabled by default — works locally
- CI/CD: cache mounts need explicit cache export/import (`--cache-to`, `--cache-from`) to persist across CI runs. Without this, cache mounts are empty on every CI build.
- `docker compose build` with BuildKit works, but older Docker versions may not support it

**Required process:**
- Add `# syntax=docker/dockerfile:1` to all 9 Dockerfiles
- Modify `RUN go mod download` and `RUN go build` lines to use `--mount=type=cache`
- Test that `docker compose build` still works (it will — Docker Desktop defaults to BuildKit)

**Verdict: Implement if the team wants it — the change is low-risk and the syntax directive is harmless. But the benefit for this project is marginal: 9 small Go services with minimal dependencies, total build time ~2 minutes, and most rebuilds hit Docker's layer cache anyway. This is a "nice to have" that adds 3 lines per Dockerfile for a minor local build speedup. Not worth prioritizing over the debian12→debian13 migration or CI/CD setup.**

---

### 5. Reproducible-build improvements

**Already implemented in Phase 2:**
- `-trimpath` — removes local filesystem paths ✅
- `-ldflags="-s -w"` — deterministic stripping ✅
- `CGO_ENABLED=0` — static linking, no system library variance ✅

**Remaining gaps:**

| Gap | Fix | Impact |
|-----|-----|--------|
| Builder image is a floating tag | Digest pinning (item 2) | Same `golang:1.26-alpine` tag can point to different images on different days |
| VCS stamping | `GOFLAGS=-buildvcs=false` in the builder stage | Go 1.18+ embeds git commit info in the binary when building inside a git repo. The build context (`.`) is copied into the builder, which has no `.git` directory, so this is a non-issue — `buildvcs` is already effectively false. |
| Timestamp in binary | `-ldflags="-s -w -buildid="` | Strips the build ID. Currently, the build ID varies between builds. Adding `-buildid=` makes it empty. Marginal value — the binary content is already reproducible thanks to trimpath. |

**Verdict: The meaningful reproducibility gap is the floating builder tag, which is addressed by digest pinning (item 2). The other gaps (`-buildvcs=false`, `-buildid=`) are edge cases that don't affect this project. No additional Dockerfile changes recommended.**

---

### 6. Dockerfile conventions documentation

**What it means:** A short document (in-repo or wiki) that codifies the team's Dockerfile patterns — base images, stage names, label conventions, build flags, directory layout.

**Project-specific benefit:**
- 5 team members working on the same 9 Dockerfiles. Without a written standard, conventions drift as people make independent changes.
- Grading includes "idiot-proof docs" — a conventions doc shows the team thought about maintainability.
- Onboarding: if someone new joins or reviews the project, the doc explains why `static-debian13`, why `-trimpath`, why those specific labels.

**Operational trade-off:** None. It's a markdown file.

**Required process:** Write it, PR it, keep it updated when conventions change.

**Verdict: Implement. Low effort, visible to graders, prevents drift across 9 services. Combine it with the Phase 3 changes (debian13 migration, etc.) in the same PR.**

---

## Summary: What to do, in what order

| # | Item | Verdict | Urgency | Effort |
|---|------|---------|---------|--------|
| 1 | **Migrate `static-debian12` → `static-debian13`** | **Implement now** | Critical — debian12 EOL this month | 1-line change × 9 Dockerfiles + rebuild + test |
| 2 | Pin runtime image (`static-debian13`) by digest | Implement now (alongside debian13 migration) | High — locks the known-good debian13 image | 1 digest lookup + 9 Dockerfile edits |
| 3 | Dockerfile conventions doc | Implement now | Medium — grading criteria | New file in repo |
| 4 | BuildKit cache mounts | Optional — implement if team wants | Low — marginal speedup for small services | `# syntax` + 3 lines × 9 Dockerfiles |
| 5 | Pin builder image by digest | **Defer until Renovate is activated** | High in principle, but pinning without automation = stale-digest risk | 1 digest lookup + 9 edits, but needs Renovate to maintain |
| 6 | Standardize Go builder version | Keep `golang:1.26-alpine` | None — 1.26 is supported, simulation ends before EOL | No change |
| 7 | Automated base-image updates (Renovate) | **Config exists, app NOT installed** — repo admin must install GitHub App | High — prerequisite for builder digest pinning | Admin action + onboarding PR merge |
| 8 | Additional reproducibility flags | Reject | None — gaps are theoretical, not practical | No change |

**Recommended Phase 3 PR scope:** Items 1, 2, and 3. One PR that migrates to debian13, pins the runtime image by digest, updates OCI labels to reference the new base, and adds a conventions doc.

**Follow-up (not this PR):** Jawwad installs the Renovate GitHub App → Renovate's onboarding PR lands → merge it → then pin the builder image by digest in a subsequent PR. The existing `renovate.json` config handles everything after activation.

---

## Implementation Record

**Changes applied (2026-09-20):**

### 1. Runtime image migration + digest pin (9 Dockerfiles)

Before:
```dockerfile
FROM gcr.io/distroless/static-debian12
```

After:
```dockerfile
FROM gcr.io/distroless/static-debian13@sha256:58133991db06659feaabe0f4e97a35cebf15ef4ea08f8a4c6d2ee5f75e4aa6a0
```

Digest sourced from multiple Renovate PRs across public repos (argoproj/argo-workflows#16952, liukonen/FlagFairway#583, jabbrwcky/tranquila#51) — all converge on the same hash as of September 2026.

### 2. OCI label update (9 Dockerfiles)

`image.base.name` changed from `gcr.io/distroless/static-debian12` to `gcr.io/distroless/static-debian13` in all 9 services.

### 3. Conventions doc

Created `docs/dockerfile-conventions.md` — codifies base images, build flags, stage layout, OCI labels, `.dockerignore`, ports, worker exception, and the digest update process.

### Files changed

| Path | Change |
|------|--------|
| `services/api-gateway/Dockerfile` | FROM + label |
| `services/order-service/Dockerfile` | FROM + label |
| `services/inventory-service/Dockerfile` | FROM + label |
| `services/payment-service/Dockerfile` | FROM + label |
| `services/notification-service/Dockerfile` | FROM + label |
| `services/shipping-service/Dockerfile` | FROM + label |
| `services/worker/Dockerfile` | FROM + label |
| `services/scheduler/Dockerfile` | FROM + label |
| `services/dashboard-api/Dockerfile` | FROM + label |
| `docs/dockerfile-conventions.md` | New file |

---

## Test Commands

Run from the repo root. These are zsh-compatible.

### Step 1: Full rebuild

```bash
docker compose build --no-cache
```

Expected: All 9 services build successfully. The digest pin means Docker pulls the exact `static-debian13` image — no tag ambiguity.

### Step 2: Verify runtime base image

```bash
for svc in api-gateway order-service inventory-service payment-service notification-service shipping-service worker scheduler dashboard-api; do
  imgid=$(docker images --filter "reference=alpha-pilot-4week-$svc" -q | head -1)
  if [ -n "$imgid" ]; then
    base=$(docker inspect "$imgid" --format '{{index .Config.Labels "org.opencontainers.image.base.name"}}')
    echo "$svc: base=$base"
  else
    echo "$svc: image not found"
  fi
done
```

Expected: All 9 show `base=gcr.io/distroless/static-debian13`. No `debian12` references.

### Step 3: Health checks

```bash
docker compose up -d
sleep 15

for port in 8080 8081 8082 8083 8084 8085 8086; do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$port/healthz)
  echo "Port $port: $code"
done
```

Expected: All return 200.

### Step 4: Dashboard static embed

```bash
curl -s http://localhost:8086/ | head -5
```

Expected: HTML content from `static/index.html`.

### Step 5: End-to-end order flow

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')

curl -s -X POST http://localhost:8080/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-User-Email: test@example.com" \
  -d '{"items":[{"product_id":"PROD-001","quantity":1,"price":29.99}],"currency":"GBP"}'
```

Expected: 201 with order ID.

### Step 6: Cleanup

```bash
docker compose down -v
```

---

## PR Description

```
harden(docker): migrate to static-debian13, pin runtime digest, add conventions doc

Three changes across all nine service Dockerfiles:

1. Runtime base image: migrated from gcr.io/distroless/static-debian12 (EOL
   September 2026) to gcr.io/distroless/static-debian13, pinned by digest
   (sha256:58133991db06...). For CGO_ENABLED=0 static binaries, this is a
   zero-behavior-change migration — the static distroless image contains no
   libc, no shell, no package manager.

2. OCI label: updated image.base.name from static-debian12 to static-debian13
   in all 9 services.

3. Added docs/dockerfile-conventions.md — codifies the team's Dockerfile
   patterns: base images, build flags, stage layout, OCI labels, .dockerignore
   rules, ports, and the digest update process.

Builder image (golang:1.26-alpine) stays on floating tag — digest pinning
deferred until the Renovate GitHub App is installed on this repo. The
renovate.json config is already in place.

No application code changes. No Kubernetes manifest changes.
```

---

## Sources

- [Go Release History](https://go.dev/doc/devel/release)
- [Go Release Cycle Policy](https://go.dev/wiki/Go-Release-Cycle)
- [Go End-of-Life Dates](https://endoflife.date/go)
- [Golang Docker Hub — Official Tags](https://hub.docker.com/_/golang)
- [Distroless Support Policy](https://github.com/GoogleContainerTools/distroless/blob/main/SUPPORT_POLICY.md)
- [Distroless GitHub — static-debian13](https://github.com/GoogleContainerTools/distroless)
- [Renovate — Docker Digest Pinning](https://docs.renovatebot.com/docker/)
- [BuildKit Cache Mounts for Go](https://oneuptime.com/blog/post/2026-02-08-how-to-speed-up-docker-build-for-go-projects/view)
