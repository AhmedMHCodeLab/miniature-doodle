# Dockerfile Conventions

Standards for the 9 service Dockerfiles in `services/*/Dockerfile`. Follow these patterns when editing any Dockerfile in this repo.


## Base Images

| Stage | Image | Pinning |
|-------|-------|---------|
| Builder | `golang:1.26-alpine` | Tag only (digest pinning deferred until Renovate is activated) |
| Runtime | `gcr.io/distroless/static-debian13` | Pinned by digest — do not change the `@sha256:...` without pulling the new digest from the registry |

The runtime image is `static` distroless — no libc, no shell, no package manager. All services compile with `CGO_ENABLED=0` (static linking), so no C libraries are needed at runtime.

**Do not use `debian12`.** `static-debian12` reached end of life in September 2026. All services run on `static-debian13`.

## Build Flags

```dockerfile
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /app .
```

| Flag | Purpose |
|------|---------|
| `CGO_ENABLED=0` | Static binary — no dependency on glibc or system libraries at runtime |
| `-trimpath` | Strips local filesystem paths from the binary (reproducibility, no path leakage in stack traces) |
| `-ldflags="-s -w"` | Strips symbol table (`-s`) and DWARF debug info (`-w`) — ~25-30% smaller binaries. Stack traces and panic output remain fully informative. |

Do not remove `-trimpath` or `-ldflags="-s -w"` unless you need Delve (`dlv`) debugging — and if you do, use a separate `Dockerfile.dev`, not the production Dockerfile.

## Stage Layout

```dockerfile
# Builder stage
FROM golang:1.26-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /app .

# Runtime stage
FROM gcr.io/distroless/static-debian13@sha256:<current-digest>
LABEL org.opencontainers.image.source="..." \
      org.opencontainers.image.title="<service-name>" \
      org.opencontainers.image.description="<one-line description>" \
      org.opencontainers.image.base.name="gcr.io/distroless/static-debian13"
COPY --from=builder /app /app
USER nonroot:nonroot
EXPOSE <port>
CMD ["/app"]
```

### Stage names

- Builder: `builder` (always)
- Runtime: unnamed (the final `FROM`)

### Working directories

- Builder: `/build`
- Runtime: root (`/`) — the binary is at `/app`

### User

All services run as `nonroot:nonroot`. This user exists in distroless images by default (UID 65534). The `USER` directive goes after `COPY --from=builder` and before `EXPOSE`.

## OCI Labels

Four static labels on every service, placed immediately after the runtime `FROM`:

| Label | Value | Notes |
|-------|-------|-------|
| `image.source` | `https://github.com/Jawwad78/Alpha-Pilot-4week` | Same for all 9 services (monorepo) |
| `image.title` | Service name (e.g. `api-gateway`) | Matches the directory name under `services/` |
| `image.description` | One-line service purpose | Human-readable, useful during incident response |
| `image.base.name` | `gcr.io/distroless/static-debian13` | Update when base image changes |

Dynamic labels (`image.created`, `image.revision`, `image.version`) require build-time injection and belong in the CI pipeline, not the Dockerfile.

## .dockerignore

All 9 services use the same `.dockerignore`:

```
Dockerfile
.dockerignore
*.md
```

The build context is `./services/<service-name>/` (set in `docker-compose.yml`). Each directory contains only source files, `go.mod`, `go.sum`, and optionally `static/`. The `.dockerignore` excludes the Dockerfile itself and markdown files.

**Do not exclude `static/`.** `dashboard-api` uses `//go:embed static` and needs the `static/` directory in the build context.

## Worker Exception

`worker` has no external dependencies — its `COPY` line is `COPY go.mod ./` (no `go.sum`). All other services copy both `go.mod` and `go.sum`.

## Ports

| Service | Port |
|---------|------|
| api-gateway | 8080 |
| order-service | 8081 |
| inventory-service | 8082 |
| payment-service | 8083 |
| notification-service | 8084 |
| shipping-service | 8085 |
| dashboard-api | 8086 |
| scheduler | 8091 |
| worker | 8090 |

Worker and scheduler are internal-only (no `ports:` mapping in `docker-compose.yml`).

## Updating the Runtime Digest

When a new `static-debian13` image is published (security patch, ca-certificates update):

1. Pull the new image: `docker pull gcr.io/distroless/static-debian13`
2. Get the digest: `docker inspect gcr.io/distroless/static-debian13 --format='{{index .RepoDigests 0}}'`
3. Update the `@sha256:...` in all 9 Dockerfiles
4. Rebuild: `docker compose build --no-cache`
5. Run health checks before merging

Once Renovate is activated on this repo, digest updates will arrive as automated PRs — this manual process becomes a fallback.
