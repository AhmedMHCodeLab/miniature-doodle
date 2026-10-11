# Phase 1: Dockerfile Implementation

## Verification Summary

### Assessment claims verified ✅

| Claim | Source | Result |
|-------|--------|--------|
| All services are pure Go, net/http stdlib | All 9 main.go files | ✅ Confirmed |
| go.mod declares `go 1.22` | All 9 go.mod files | ✅ Confirmed |
| Module paths say `ecs-v3` not `eks-v2` | All 9 go.mod files | ✅ Confirmed |
| worker has no external deps (no go.sum) | services/worker/ | ✅ Confirmed only file is go.mod |
| dashboard-api serves static HTML | main.go line 19-20, 53-54 | ✅ `//go:embed static` baked into binary at compile time |
| All services use graceful shutdown | All 9 main.go files | ✅ SIGINT/SIGTERM, 30s timeout |
| COPY path bug in 6 distroless Dockerfiles | Staged Dockerfiles | ✅ Binary built to `/go/bin/app`, COPY references `/app` or `/build/app` |
| 3 services missing distroless/CGO_ENABLED=0 | order-service, shipping-service, worker | ✅ Use `golang:1.24-alpine` as runtime |
| dashboard-api EXPOSE wrong | Staged Dockerfile | ✅ Shows 8080, should be 8086 |

### Go version resolved

- **go.mod**: all 9 services declare `go 1.22`
- **Existing Dockerfiles**: mixed `golang:1.23-alpine` (6 services) and `golang:1.24-alpine` (3 services)
- **Current supported Go**: 1.26 (latest: 1.26.8) and 1.27 (latest: 1.27.1). Go 1.24 and 1.23 are EOL.
- **Decision**: Standardize on `golang:1.26-alpine` latest supported version with full patch coverage. The `go 1.22` directive in go.mod sets minimum language version; building with 1.26 is fully compatible.

### Distroless base image verified ✅

- `gcr.io/distroless/static-debian12` includes CA certificates and timezone data
- `nonroot` tag sets UID 65532
- `static-debian13` is now available but debian12 is the stable, widely-used variant no reason to change
- No service makes outbound HTTPS calls currently, so CA certs are not strictly needed yet but come free with `static-debian12`

### TLS CA certificate requirements verified ✅

**None of the 9 services currently need CA certificates.** Full audit:

| Service | Outbound HTTP | Details |
|---------|--------------|---------|
| api-gateway | Plain HTTP only | Reverse proxy to internal services via `http://` |
| order-service | None | PostgreSQL TCP only; `publishEvent()` is a log stub |
| inventory-service | None | PostgreSQL TCP only |
| payment-service | None | PostgreSQL TCP only; payment is simulated |
| notification-service | None | PostgreSQL TCP only; notifications are simulated |
| shipping-service | None | PostgreSQL TCP only; tracking generated locally |
| worker | Stub only | `http.Client` created but never used; all handlers are TODO comments |
| scheduler | None | PostgreSQL TCP only; cron jobs query DB directly |
| dashboard-api | None | PostgreSQL TCP only; reads and serves data |

**Future need**: When AWS SDK is added for SQS (worker + publishEvent stubs), those services WILL need CA certs. `static-debian12` already includes them, so no change needed later.

### Build and test blocker noted

Cannot run `docker compose build` through the Cowork bridge the sandboxed Linux VM has no Docker daemon. Ahmed must run the test commands on his Windows machine with Docker Desktop. Test matrix below.

---

## Per-Service Diffs

### 1. api-gateway COPY path fix

**Port**: 8080 ✅ (unchanged)

```diff
 FROM golang:1.26-alpine AS builder
 WORKDIR /build
 COPY go.mod go.sum ./
 RUN go mod download
 COPY . .
-RUN CGO_ENABLED=0 go build -o /go/bin/app
+RUN CGO_ENABLED=0 go build -o /app .

 FROM gcr.io/distroless/static-debian12
-WORKDIR /build
-COPY --from=builder /build/app /app
-USER nonroot
+COPY --from=builder /app /app
+USER nonroot:nonroot
 EXPOSE 8080
 CMD ["/app"]
```

Changes: Fixed COPY path (binary built to `/go/bin/app` but COPY read from `/build/app`). Simplified by building directly to `/app`. Removed unnecessary `WORKDIR /build` in runtime. Added `:nonroot` group.

### 2. order-service full distroless conversion

**Port**: 8081 ✅ (unchanged)

```diff
-FROM golang:1.24-alpine AS builder
+FROM golang:1.26-alpine AS builder
 WORKDIR /build
 COPY go.mod go.sum ./
 RUN go mod download
 COPY . .
-RUN go build -o app .
+RUN CGO_ENABLED=0 go build -o /app .

-FROM golang:1.24-alpine
-WORKDIR /build
-COPY --from=builder /build/app /app
+FROM gcr.io/distroless/static-debian12
+COPY --from=builder /app /app
+USER nonroot:nonroot
 EXPOSE 8081
 CMD ["/app"]
```

Changes: Replaced `golang:1.24-alpine` runtime with `gcr.io/distroless/static-debian12`. Added `CGO_ENABLED=0` for static binary. Added `USER nonroot:nonroot`. Updated builder to `golang:1.26-alpine`.

### 3. inventory-service COPY path fix

**Port**: 8082 ✅ (unchanged)

```diff
 FROM golang:1.26-alpine AS builder
 WORKDIR /build
 COPY go.mod go.sum ./
 RUN go mod download
 COPY . .
-RUN CGO_ENABLED=0 go build -o /go/bin/app
+RUN CGO_ENABLED=0 go build -o /app .

 FROM gcr.io/distroless/static-debian12
-COPY --from=builder /app /bin/app
-USER nonroot
+COPY --from=builder /app /app
+USER nonroot:nonroot
 EXPOSE 8082
-CMD ["/bin/app"]
+CMD ["/app"]
```

Changes: Fixed COPY source path. Unified binary location to `/app`. Added `:nonroot` group.

### 4. payment-service COPY path fix

**Port**: 8083 ✅ (unchanged)

Same pattern as inventory-service. Fixed COPY path, unified binary to `/app`, added `:nonroot` group.

### 5. notification-service COPY path fix

**Port**: 8084 ✅ (unchanged)

Same pattern as inventory-service.

### 6. shipping-service full distroless conversion

**Port**: 8085 ✅ (unchanged)

```diff
-FROM golang:1.24-alpine AS builder
+FROM golang:1.26-alpine AS builder
 WORKDIR /build
 COPY go.mod go.sum ./
 RUN go mod download
 COPY . .
-RUN go build -o app .
+RUN CGO_ENABLED=0 go build -o /app .

-FROM golang:1.24-alpine
-WORKDIR /build
-COPY --from=builder /build/app /app
+FROM gcr.io/distroless/static-debian12
+COPY --from=builder /app /app
+USER nonroot:nonroot
 EXPOSE 8085
 CMD ["/app"]
```

Same conversion pattern as order-service.

### 7. worker full distroless conversion + no go.sum

**Port**: 8090 ✅ (unchanged)

```diff
-FROM golang:1.24-alpine AS builder
+FROM golang:1.26-alpine AS builder
 WORKDIR /build
 COPY go.mod ./
 RUN go mod download
 COPY . .
-RUN go build -o app .
+RUN CGO_ENABLED=0 go build -o /app .

-FROM golang:1.24-alpine
-WORKDIR /build
-COPY --from=builder /build/app /app
+FROM gcr.io/distroless/static-debian12
+COPY --from=builder /app /app
+USER nonroot:nonroot
 EXPOSE 8090
 CMD ["/app"]
```

Note: worker has zero external dependencies only `COPY go.mod ./` (no go.sum file exists).

### 8. scheduler COPY path fix

**Port**: 8091 ✅ (unchanged)

Same pattern as inventory-service. Fixed COPY path, unified binary to `/app`, added `:nonroot` group.

### 9. dashboard-api COPY path fix + EXPOSE port fix

**Port**: 8086 (was 8080 **FIXED**)

```diff
 FROM golang:1.26-alpine AS builder
 WORKDIR /build
 COPY go.mod go.sum ./
 RUN go mod download
 COPY . .
-RUN CGO_ENABLED=0 go build -o /go/bin/app
+RUN CGO_ENABLED=0 go build -o /app .

 FROM gcr.io/distroless/static-debian12
-COPY --from=builder /app /bin/app
-USER nonroot
-EXPOSE 8080
-CMD ["/bin/app"]
+COPY --from=builder /app /app
+USER nonroot:nonroot
+EXPOSE 8086
+CMD ["/app"]
```

Changes: Fixed EXPOSE from 8080 to 8086. Fixed COPY path. Note: `//go:embed static` bakes the `static/` directory into the binary at compile time no separate COPY needed for static files in the runtime stage.

---

## EXPOSE Port Summary

| Service | Port | Source |
|---------|------|--------|
| api-gateway | 8080 | `getEnv("PORT", "8080")` |
| order-service | 8081 | `getEnv("PORT", "8081")` |
| inventory-service | 8082 | `getEnv("PORT", "8082")` |
| payment-service | 8083 | `getEnv("PORT", "8083")` |
| notification-service | 8084 | `getEnv("PORT", "8084")` |
| shipping-service | 8085 | `getEnv("PORT", "8085")` |
| dashboard-api | 8086 | `getEnv("PORT", "8086")` |
| worker | 8090 | `getEnv("HEALTH_PORT", "8090")` |
| scheduler | 8091 | `getEnv("HEALTH_PORT", "8091")` |

---

## PR Description

```
fix(docker): standardize all Dockerfiles on distroless with correct build paths

Three categories of fix across all nine services:

1. COPY path bug (6 services): binary built to /go/bin/app but COPY
   referenced /app or /build/app. Unified build output to /app.

2. Missing distroless runtime (order-service, shipping-service, worker):
   replaced golang:1.24-alpine runtime with gcr.io/distroless/static-debian12,
   added CGO_ENABLED=0 for static binary, added USER nonroot:nonroot.

3. dashboard-api EXPOSE port: was 8080, corrected to 8086 to match the
   service's actual listening port.

All services now use:
- golang:1.26-alpine builder (current supported Go)
- gcr.io/distroless/static-debian12 runtime (~2MB)
- CGO_ENABLED=0 static binary
- USER nonroot:nonroot (UID 65532)
- Correct EXPOSE matching each service's default port

No application code changes. No Kubernetes manifest changes.
```

---

## Test Matrix

Run all commands from the repo root on a machine with Docker.

### Step 1: Full build (all 9 services)

```bash
docker compose build
```

Expected: all 9 services build successfully. Each produces a multi-stage image with distroless runtime.

### Step 2: Verify image sizes

```bash
docker compose build 2>/dev/null
for svc in api-gateway order-service inventory-service payment-service notification-service shipping-service worker scheduler dashboard-api; do
  echo "$svc: $(docker images --format '{{.Size}}' "${PWD##*/}-$svc" 2>/dev/null || docker images --format '{{.Size}}' "$svc" 2>/dev/null)"
done
```

Expected: each image should be ~10-20MB (binary + ~2MB distroless base). If any image is >100MB, it's using the wrong runtime stage.

### Step 3: Verify runtime user

```bash
for svc in api-gateway order-service inventory-service payment-service notification-service shipping-service worker scheduler dashboard-api; do
  uid=$(docker inspect --format '{{.Config.User}}' "${PWD##*/}-$svc" 2>/dev/null || docker inspect --format '{{.Config.User}}' "$svc" 2>/dev/null)
  echo "$svc: USER=$uid"
done
```

Expected: every service shows `USER=nonroot:nonroot`

### Step 4: Full integration test

```bash
docker compose up -d
sleep 15  # wait for postgres + services to start

# Health checks
for port in 8080 8081 8082 8083 8084 8085 8086 8090 8091; do
  status=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$port/healthz 2>/dev/null || curl -s -o /dev/null -w "%{http_code}" http://localhost:$port/livez 2>/dev/null)
  echo "Port $port: $status"
done
```

Expected: ports 8080-8086 return 200 on `/healthz`. Ports 8090, 8091 return 200 on `/healthz` or `/livez`.

### Step 5: Dashboard-api static files

```bash
curl -s http://localhost:8086/ | head -5
```

Expected: returns HTML content (the embedded `static/index.html`).

### Step 6: End-to-end order flow

```bash
# Create order
curl -s -X POST http://localhost:8080/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -H "X-User-Email: test@example.com" \
  -d '{"items":[{"product_id":"PROD-001","quantity":1,"price":29.99}],"currency":"GBP"}'

# List orders
curl -s http://localhost:8080/orders \
  -H "Authorization: Bearer test" \
  -H "X-User-Email: test@example.com"
```

Expected: order creation returns 201 with order ID; list returns the created order.

### Step 7: Cleanup

```bash
docker compose down -v
```

---

## Deviations from Assessment

| Item | Assessment said | Actual | Impact |
|------|----------------|--------|--------|
| Go builder version | Not specified | `golang:1.26-alpine` (current supported) | Existing Dockerfiles used EOL 1.23/1.24 upgraded |
| dashboard-api static files | "Must be copied into runtime image" | `//go:embed static` bakes them into the binary | No COPY needed simpler Dockerfile |
| Build verification | "Build and test locally" | Cannot build through Cowork bridge (no Docker in VM) | Test matrix provided for Ahmed to run |
| `static-debian13` | Not mentioned | Now available but debian12 is stable | No change revisit when debian12 goes EOL |

## Blockers

1. **Build test blocked**: The Cowork bridge's Linux VM has no Docker daemon. Ahmed needs to run `docker compose build` and the test matrix on his Windows machine with Docker Desktop. The Dockerfiles are written to his local folder and ready to test.

2. **No blockers in the Dockerfiles themselves**: All 9 are clean, consistent, and follow the same pattern. The only service-specific variation is worker (no go.sum file).
