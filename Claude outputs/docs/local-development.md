# Local Development — Team Alpha

Every developer runs the whole platform on their own machine against Floci, a local
AWS-compatible target. The same Terraform that builds our AWS environments builds the
local one; only the endpoint, credentials, backend and variables change.

Your environment is yours. Your Floci, your Terraform state, your data. Nothing you
do locally can affect anyone else.

## Install first

- Docker Desktop with Compose v2 (`docker compose version`)
- Terraform 1.16 or newer
- Python 3 (used to read Terraform output)

Run `make check` to confirm all three.

## Run it

```bash
git clone <repo> && cd Alpha-Pilot-4week
make local-up
```

That is the whole thing. It starts Floci, Postgres and Redis, applies the platform
Terraform into your Floci, writes the resulting values to `.env.local`, then builds
and starts the nine services.

First run takes a few minutes, mostly pulling images and downloading the Terraform
provider. Later runs are much faster.

## What you should see

```bash
make local-test
```

```
== infrastructure ==
  PASS  floci init hooks reported
  PASS  main queue exists
  PASS  dead-letter queue exists
  PASS  redrive policy set
  PASS  maxReceiveCount is 3
  PASS  application secret exists
== convergence ==
  PASS  terraform plan is empty (idempotent)

== application ==
  PASS  healthz on :8080 returned 200
  ... through :8091
  PASS  12 services running (expect 12)
```

The nine services are on ports 8080–8086 plus 8090 (worker) and 8091 (scheduler).
The dashboard is at http://localhost:8080.

## Known: the order flow does not reach the worker yet

`publishEvent` logs instead of sending to SQS, and `receiveSQSMessages` is a stub in
the worker. An order will be written to Postgres and you will see
`Event -> SQS: {...}` in the order-service log, and the queue will stay empty.

That is an open application ticket, not a broken environment. `make local-test`
reports it rather than failing on it.

## Working day to day

```bash
make local-down          # stop; your data and state survive
make local-up            # back up again
make tf CMD="plan"       # see what Terraform would change in your Floci
make local-reset         # destroy everything local and start clean
```

After pulling changes that touch `terraform/`, run `make local-bootstrap` to converge
your Floci and refresh `.env.local`.

## Where things live

| Path | Owns |
|---|---|
| `terraform/modules/` | what the infrastructure is — one definition, every target |
| `terraform/platform/` | how the modules compose; one root, four targets |
| `terraform/platform/backends/` | where state lives per target |
| `terraform/platform/environments/` | values per target |
| `scripts/tf.sh` | binds a target name to its endpoint, credentials, backend and variables |
| `.env` | committed local values |
| `.env.local` | generated from Terraform output — never commit, never edit |
| `docker-compose.yml` | runtime topology only |

## Common failures

**`terraform not found`** — install Terraform 1.16+, then `make check`.

**`floci did not become ready`** — Docker Desktop is not running, or port 4566 is
taken. `docker compose logs floci` will say which.

**`no such host: floci` from a service** — the app containers resolve Floci by its
Compose service name. Run the stack with `make`, not raw `docker compose`, so both
env files are loaded.

**A shell script fails inside a container on Windows** — check line endings.
`file scripts/<name>.sh` should say `ASCII text`, not `with CRLF line terminators`.
`.gitattributes` forces LF on checkout, but a file already on disk keeps whatever it
had. `sed -i 's/\r$//' scripts/<name>.sh` fixes it.

**Ports already in use** — you can only run one copy of the stack per machine.
`make local-down` in the other checkout first.

## Adding infrastructure

Write a module under `terraform/modules/<name>/` following
`terraform/modules/README.md`, then add one file `terraform/platform/<name>.tf`
that calls it and declares its outputs. One file per module means parallel work
never collides. Run `make tf CMD=plan` against your own Floci before opening the PR.
