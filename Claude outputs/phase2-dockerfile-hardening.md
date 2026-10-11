# Phase 2: Dockerfile Hardening

## Validation Summary

**Post-Phase-1 state confirmed** — all 9 Dockerfiles re-read from local repo on 2026-09-20. Every service matched the Phase 1 output exactly. All `.dockerignore` files were empty (0 bytes).

**Constraints verified:**

| Constraint | Status |
|-----------|--------|
| Base images unchanged (`golang:1.26-alpine` + `static-debian12`) | ✅ |
| No digest pins | ✅ |
| No path redesign (`/build` → `/app`) | ✅ |
| No BuildKit features (no `# syntax=`, no `--mount`) | ✅ |
| No CI/CD changes (no build args, no dynamic labels) | ✅ |
| No application code changes | ✅ |
| No Kubernetes manifest changes | ✅ |
| `.dockerignore` does not exclude `static/` (dashboard-api `go:embed`) | ✅ |

---

## Changes Made

### 1. Build flags: `-trimpath -ldflags="-s -w"`

**Before:**
```dockerfile
RUN CGO_ENABLED=0 go build -o /app .
```

**After (all 9 services):**
```dockerfile
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /app .
```

#### `-trimpath` — recommended, no trade-off

Removes all local filesystem paths from the compiled binary. Source file references in stack traces show `module@version/file.go` instead of `/home/ahmed/Desktop/CoderCo/Projects/Alpha-Pilot-4week/services/api-gateway/main.go`.

Benefits:
- **Reproducible builds**: Two builds from the same source on different machines produce identical binaries (same inputs → same output, no path variance).
- **No local path leakage**: Build machine paths don't appear in the binary, stack traces, or panic output. Relevant for images pushed to shared ECR.
- **No downside**: Stack traces still show file names and line numbers — just relative to the module root instead of absolute. No size impact. No performance impact.

#### `-ldflags="-s -w"` — deliberate decision with documented trade-offs

`-s` strips the symbol table. `-w` strips DWARF debug information.

**What you gain:**
- Binary size reduction of ~25-30% at the binary level. Total image size (as reported by Docker Desktop, uncompressed) is ~14-16MB — this includes the distroless base layer, attestation manifests, and image metadata on top of the stripped binary. The binary itself is smaller with `-s -w`, but the base image is the floor.

**What you lose:**
- **No `dlv` (Delve) debugging**: Cannot attach a debugger to the running binary. In practice, distroless has no shell and no tools — you can't attach `dlv` to a distroless container anyway. Debugging happens locally against the source, not inside the container.
- **No DWARF info for profiling**: `go tool pprof` still works for CPU and memory profiling (runtime profiling is unaffected), but DWARF-based tools like `objdump` lose symbolic info.
- **Stack traces keep function names and file:line**: Go's runtime panic/stack output uses its own metadata, not DWARF. `goroutine 1 [running]: main.handleHealth(...)` and `main.go:84` still appear in panic output. This is the info that matters for production debugging.

**Decision**: Add both flags. The runtime is distroless — there's no shell to exec into, no debugger to attach. Production debugging for these services means reading logs and panic stack traces, both of which remain fully informative with `-s -w`. The ~25-30% binary size reduction is a free win. If a service ever needs `dlv` attach (e.g., in a dev-mode Dockerfile), that would be a separate build target, not a reason to carry debug symbols in production images.

### 2. OCI labels (static)

**Added to all 9 services** (after the runtime `FROM`):

```dockerfile
LABEL org.opencontainers.image.source="https://github.com/Jawwad78/Alpha-Pilot-4week" \
      org.opencontainers.image.title="<service-name>" \
      org.opencontainers.image.description="<one-line description>" \
      org.opencontainers.image.base.name="gcr.io/distroless/static-debian12"
```

#### Label choices

| Label | Value | Rationale |
|-------|-------|-----------|
| `image.source` | GitHub repo URL | Links image back to source code. Required by GitHub Container Registry, useful for any registry. Shared across all 9 services (monorepo). |
| `image.title` | Service name | Identifies which service an image is when all 9 live in the same ECR account. `docker inspect` shows it. |
| `image.description` | One-line service purpose | Human-readable context when inspecting images. Useful during incident response ("what does this service do?"). |
| `image.base.name` | `gcr.io/distroless/static-debian12` | Records which base image was used. Useful for security scanning — scanners can check if the base has known CVEs. |

#### Labels deliberately NOT added (Phase 3)

| Label | Why deferred |
|-------|-------------|
| `image.created` | Requires build-time injection (`--label` or `--build-arg`). That's a CI/CD change. |
| `image.revision` | Requires `git rev-parse HEAD` at build time. CI/CD change. |
| `image.version` | Requires tagging strategy. CI/CD change. |
| `image.vendor` | No agreed team/org name yet for these images. |
| `image.licenses` | Repo has no LICENSE file currently. |

### 3. `.dockerignore` files

**Before:** All 9 empty (0 bytes).

**After (all 9 identical):**
```
Dockerfile
.dockerignore
*.md
```

#### Why these three patterns

The build context for each service is `./services/<service-name>/` (set by `docker-compose.yml`'s `build: ./services/<name>`). Each service directory contains only:

| File | Needed by build? | Excluded? |
|------|-----------------|-----------|
| `main.go` | Yes — the source | No |
| `go.mod` | Yes — module definition | No |
| `go.sum` | Yes — dependency checksums | No |
| `static/` (dashboard-api only) | Yes — `//go:embed static` | No |
| `Dockerfile` | No — Docker reads it separately, not from the context | Yes |
| `.dockerignore` | No — Docker reads it separately | Yes |
| `*.md` | No — no Go build needs markdown | Yes |

The `.git`, `.github`, `images/`, `scripts/`, and other repo-root directories are NOT in the build context — they live at the repo root, and the build context is the service subdirectory. So there's nothing else to exclude.

The `*.md` pattern is future-proofing: when README files are added per-service (common practice), they won't leak into the build context.

#### dashboard-api safety check

`//go:embed static` in `main.go` (line 19) requires the `static/` directory to be present in the build context. The `.dockerignore` does NOT exclude `static/` — verified. The `*.md` pattern would match a `.md` file inside `static/`, but `static/` currently contains only `index.html` (22KB), and Go's embed directive reads from the built filesystem, not the Docker context, so the only requirement is that `static/` is present when `go build` runs in the builder stage.

---

## Per-Service Diffs

### Standard pattern (8 services)

Applied to: api-gateway, order-service, inventory-service, payment-service, notification-service, shipping-service, scheduler, dashboard-api.

```diff
 FROM golang:1.26-alpine AS builder
 WORKDIR /build
 COPY go.mod go.sum ./
 RUN go mod download
 COPY . .
-RUN CGO_ENABLED=0 go build -o /app .
+RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /app .

 FROM gcr.io/distroless/static-debian12
+LABEL org.opencontainers.image.source="https://github.com/Jawwad78/Alpha-Pilot-4week" \
+      org.opencontainers.image.title="<service-name>" \
+      org.opencontainers.image.description="<service description>" \
+      org.opencontainers.image.base.name="gcr.io/distroless/static-debian12"
 COPY --from=builder /app /app
 USER nonroot:nonroot
 EXPOSE <port>
 CMD ["/app"]
```

### Worker variant

```diff
 FROM golang:1.26-alpine AS builder
 WORKDIR /build
 COPY go.mod ./
 RUN go mod download
 COPY . .
-RUN CGO_ENABLED=0 go build -o /app .
+RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /app .

 FROM gcr.io/distroless/static-debian12
+LABEL org.opencontainers.image.source="https://github.com/Jawwad78/Alpha-Pilot-4week" \
+      org.opencontainers.image.title="worker" \
+      org.opencontainers.image.description="Background worker — async job processing and SQS consumer stub" \
+      org.opencontainers.image.base.name="gcr.io/distroless/static-debian12"
 COPY --from=builder /app /app
 USER nonroot:nonroot
 EXPOSE 8090
 CMD ["/app"]
```

Only difference from the standard: `COPY go.mod ./` (no go.sum — worker has zero external dependencies).

### OCI label values per service

| Service | `image.title` | `image.description` |
|---------|--------------|-------------------|
| api-gateway | `api-gateway` | API gateway — reverse proxy and JWT auth for the order platform |
| order-service | `order-service` | Order management service — CRUD operations and order lifecycle |
| inventory-service | `inventory-service` | Inventory management — stock levels, reservations, and product catalog |
| payment-service | `payment-service` | Payment processing — charge, refund, and payment status tracking |
| notification-service | `notification-service` | Notification dispatch — email and event notifications for order lifecycle |
| shipping-service | `shipping-service` | Shipping management — shipment creation, tracking, and carrier assignment |
| worker | `worker` | Background worker — async job processing and SQS consumer stub |
| scheduler | `scheduler` | Scheduled jobs — cron-driven database maintenance and order cleanup |
| dashboard-api | `dashboard-api` | Dashboard API — aggregated order, revenue, inventory, and shipping views |

---

## Test Commands and Expected Results

Run all commands from the repo root on a machine with Docker.

### Step 1: Full rebuild

```bash
docker compose build --no-cache
```

Expected: All 9 services build successfully. The `--no-cache` is important — cached layers from Phase 1 would skip the new build flags.

### Step 2: Image size comparison

```bash
echo "=== Image sizes ==="
for svc in api-gateway order-service inventory-service payment-service notification-service shipping-service worker scheduler dashboard-api; do
  imgid=$(docker images --filter "reference=alpha-pilot-4week-$svc" -q | head -1)
  if [ -n "$imgid" ]; then
    size=$(docker image inspect "$imgid" --format '{{.Size}}')
    echo "$svc: $((size / 1048576))MB ($size bytes)"
  else
    echo "$svc: image not found"
  fi
done
```

Expected: ~14-16MB per image (uncompressed). Worker is smallest (~14.7MB, fewer dependencies), api-gateway largest (~16.4MB). The binary itself is ~25-30% smaller from `-s -w`, but the distroless base layer and image metadata set the floor.

### Step 3: Verify labels

```bash
for svc in api-gateway order-service inventory-service payment-service notification-service shipping-service worker scheduler dashboard-api; do
  imgid=$(docker images --filter "reference=alpha-pilot-4week-$svc" -q | head -1)
  if [ -n "$imgid" ]; then
    title=$(docker inspect "$imgid" --format '{{index .Config.Labels "org.opencontainers.image.title"}}')
    source=$(docker inspect "$imgid" --format '{{index .Config.Labels "org.opencontainers.image.source"}}')
    base=$(docker inspect "$imgid" --format '{{index .Config.Labels "org.opencontainers.image.base.name"}}')
    echo "$svc: title=$title source=$source base=$base"
  else
    echo "$svc: image not found"
  fi
done
```

Expected: Each service shows its own name as `title`, `https://github.com/Jawwad78/Alpha-Pilot-4week` as `source`, and `gcr.io/distroless/static-debian12` as `base.name`.

### Step 4: Verify trimpath (no local paths in binary)

```bash
cid=$(docker compose ps -q api-gateway)
docker cp "$cid":/app /tmp/app-binary
strings /tmp/app-binary | grep '/home\|/Users\|C:\\' && echo "FAIL: local paths found" || echo "PASS: no local paths"
rm /tmp/app-binary
```

Expected: `PASS: no local paths`. The grep excludes `/build` (false-positives from Go stdlib strings like `go/build`, `strings/builder.go`, `cryptobyte/builder.go`). The check targets actual local filesystem prefixes — `/home`, `/Users`, `C:\` — which `-trimpath` strips.

### Step 5: Health checks (same as Phase 1)

```bash
docker compose up -d
sleep 15

for port in 8080 8081 8082 8083 8084 8085 8086; do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$port/healthz)
  echo "Port $port: $code"
done
```

Expected: All return 200. Worker (8090) and scheduler (8091) don't have `ports:` mapping in docker-compose.yml — not exposed externally.

### Step 6: Dashboard static files still served

```bash
curl -s http://localhost:8086/ | head -5
```

Expected: HTML content from `static/index.html`. Confirms `//go:embed static` still works with the new build flags and `.dockerignore`.

### Step 7: End-to-end order flow (same as Phase 1)

```bash
# Authenticate — extract token with sed (zsh-compatible, grep -o pipelines break in zsh)
TOKEN=$(curl -s -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')

# Create order
curl -s -X POST http://localhost:8080/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-User-Email: test@example.com" \
  -d '{"items":[{"product_id":"PROD-001","quantity":1,"price":29.99}],"currency":"GBP"}'
```

Expected: 201 with order ID. Confirms no functional regression from build flag changes.

### Step 8: Cleanup

```bash
docker compose down -v
```

---

## PR Description

```
harden(docker): add build optimizations, OCI labels, and .dockerignore to all services

Three changes across all nine service Dockerfiles:

1. Build flags: added -trimpath (reproducible builds, no local path leakage)
   and -ldflags="-s -w" (strip symbol table and DWARF debug info, ~25-30%
   smaller binaries). Stack traces and panic output remain fully informative —
   Go runtime metadata is separate from DWARF. Distroless has no shell or
   debugger to attach, so stripped symbols cost nothing in practice.

2. OCI labels: added static org.opencontainers.image.source, .title,
   .description, and .base.name to each service. Identifies images in shared
   ECR and links them back to source. Dynamic labels (created, revision,
   version) deferred to CI/CD pipeline setup.

3. .dockerignore: populated all 9 previously-empty files with Dockerfile,
   .dockerignore, and *.md exclusions. Build context is each service's
   subdirectory (already minimal). dashboard-api's static/ directory is NOT
   excluded — required by //go:embed static.

No base-image changes, no path changes, no BuildKit features, no CI/CD changes.
No application code changes. No Kubernetes manifest changes.
```

---

## Deferred to Phase 3

| Item | Reason |
|------|--------|
| Dynamic OCI labels (`image.created`, `image.revision`, `image.version`) | Requires `--build-arg` or `--label` at build time — CI/CD pipeline change |
| Base image digest pinning (`golang:1.26-alpine@sha256:...`) | Requires digest lookup and update strategy (Renovate or manual) |
| BuildKit cache mounts (`--mount=type=cache,target=/go/pkg/mod`) | BuildKit-specific feature, out of scope |
| Multi-platform builds (`--platform linux/amd64,linux/arm64`) | CI/CD and registry change |
| `HEALTHCHECK` instruction | Kubernetes probes handle health checking; Docker HEALTHCHECK adds complexity without benefit in EKS |
| `.trivyignore` / scanner config | Security scanning is a separate workstream |
| `COPY --link` (BuildKit) | Requires `# syntax=docker/dockerfile:1` directive — BuildKit feature |