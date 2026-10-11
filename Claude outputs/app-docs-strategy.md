# Application documentation strategy (plan)

Status: plan only, 25 Sep 2026. No repo files or Plane pages change from this.
Scope: the application-side work Ahmed did in Sprints 1-2 (ALPHA-61, 56, 44, 51, 45, 77, 73, 48, 74, plus the plans behind 78 and 80).

## 1. The documentation goal

A new teammate should be able to open one page and, in about 30 minutes, know how the order platform fits together, how an order moves from "placed" to "confirmed", what changed in Sprint 2 and why, and which rules must not be broken. The reasoning behind each important choice (the problem, the options, what we picked and what it costs) has to survive without Ahmed in the room. We get there with four topic docs, three short decision records and one Plane index page, not one doc per ticket. Every doc tells its story in the first 5-10 lines and puts the depth underneath.

## 2. What the application work actually contains

| Engineering theme | Related work | Durable knowledge | Why the team needs it |
|---|---|---|---|
| Application shape | Repo README (9 services), ALPHA-48 routing, compose ports | 9 Go services, one Postgres, Redis (rate limiter), one SQS queue + DLQ. The gateway (8080) is the only real entry point; 8081-8086 are published locally for debugging only. | Everyone needs this map before anything else makes sense. |
| Order lifecycle (event-driven flow) | ALPHA-44 outbox/publisher, ALPHA-45 worker, ALPHA-77 stock commit | Order + event saved in one transaction to relay sends to SQS to worker runs reserve to charge to confirm to commit stock. Business "no" vs technical failure. DLQ after 3 receives. | This is the core of the platform, and none of it ran before Sprint 2. |
| Correctness under retries | ALPHA-51 (reserve/release, payment, status CAS pending), the event `id` from ALPHA-44, delete-after-handled from ALPHA-45, commit-once from ALPHA-77 | SQS delivers at least once. Every step the worker calls is safe to repeat, enforced by the database (unique partial indexes, guarded UPDATEs). | These invariants are the easiest thing for a future change to break silently. |
| Edge: gateway and dashboard | ALPHA-73 rate limiting, ALPHA-48 dashboard routing | How requests are identified and limited (user / IP / sensitive), fail-open, trusted proxies. The dashboard only works through the gateway, refreshes every 30 s and logs in before fetching. | Explains 429s, "why is the dashboard empty on 8086", and what changes when Traefik arrives. |
| Container images | ALPHA-56 (PR #15) | Multi-stage builds: `golang:1.26-alpine` builder, static binary, distroless runtime pinned by digest, runs as nonroot. | Anyone adding a service or debugging a container needs the conventions. |
| Local environment | ALPHA-61 (Floci, PR #3), `floci-init.sh`, local visibility timeout 60 s | Floci stands in for AWS locally. `AWS_ENDPOINT_URL` is set only locally, never on EKS. | Daily development and every drill in the other docs depend on it. |
| Testing approach | Tests shipped with 44/51/45/77/73/48 | Tests sit beside the code; integration tests skip without `TEST_DATABASE_URL` / `AWS_ENDPOINT_URL` / Redis; concurrency tests need a warm pool; CI does not run `go test`. | Stops people trusting a green run that skipped everything. |
| Capacity and DB connections | ALPHA-74 (PR #24), ALPHA-80 (planned) | Pool sizes sum to 115 against `max_connections` 100. Waits came from hot-row lock time (570/600 waited on one product, 0 when spread), not connection count. Decision still pending. | It stops the team jumping to PgBouncer without evidence. |
| Cost choices | Worker long polling, relay polls Postgres | Every SQS request is billed, including empty receives. A 20 s long poll makes 4,320 idle receives per day vs 17,280 for a 5 s short poll. | Spend is the #1 graded priority. |
| Known limits | Hardening backlog, ALPHA-78 | What is deliberately not safe yet (auth stub, client pricing, scheduler must run 1 replica, refund not idempotent, ...). | New engineers must not assume these are solved. |
| Work history | Scope splits, PR merge order, evidence log | Who did what when, and the before/after runs. | Useful to reviewers now. Not onboarding material. |

## 3. Knowledge classification

| Theme | Class | Why |
|---|---|---|
| Application shape | SYSTEM KNOWLEDGE | Describes how the system is, and stays true until the architecture changes. |
| Order lifecycle | SYSTEM KNOWLEDGE + CONTRACT + DECISION | Behaviour; the event envelope and endpoint responses are contracts other code relies on; the outbox and Standard queue are hard-to-reverse choices. |
| Correctness under retries | DECISION + CONTRACT (invariants) | The approach (DB-enforced, Idempotency-Key deferred) is a decision; the rules ("one completed charge per order") are contracts. |
| Edge: gateway and dashboard | SYSTEM KNOWLEDGE + DECISION | The limiter design is explicitly interim and will be superseded when Traefik is in, so it needs a status. |
| Container images | PROCEDURE + DECISION | "How to add a Dockerfile", plus choices (distroless, nonroot) whose alternatives aren't recorded yet. |
| Local environment | PROCEDURE | How to run and inspect things. |
| Testing approach | PROCEDURE | How to run the tests and what a skip means. |
| Capacity | DECISION (pending) | Not decided yet. Document the finding, not a conclusion. |
| Cost choices | DECISION (small) | Belongs next to the behaviour it explains, not in its own doc. |
| Known limits | Mixed | Items still to do are work management; constraints you must respect today (scheduler 1 replica) are system knowledge. |
| Work history | TICKET HISTORY | Stays in Plane tickets and PRs. |

## 4. Proposed artifact set

Paths assume the repo is chosen (see section 5). `docs/app/` leaves room for the infra docs the team already plans.

| Artifact | Purpose | Audience | Contains | Does not contain | Source of truth | Why it exists |
|---|---|---|---|---|---|---|
| R1 `docs/app/README.md`: Start here | Orientation and reading path | Everyone, especially new joiners | What the app does, service map + one diagram, what changed in Sprint 2 (one table), how to see an order in 5 minutes (link), known limits, glossary | Reasoning (links to it), ticket history | Repo | Without it the other docs are a scavenger hunt. |
| R2 `docs/app/order-flow.md`: How an order flows | Explain the core flow and its safety rules | Anyone touching order, inventory, payment or the worker | Sequence, failure paths, "rules that must stay true", event and endpoint contracts, cost note, verification | Setup commands (R4), full ADR reasoning (links) | Repo | Collapses 44 + 45 + 51 + 77 into one story. |
| R3 `docs/app/gateway-and-dashboard.md` | Explain how requests enter and are limited | Anyone touching the gateway, dashboard or Traefik | Routing table, identity and limits, fail-open, dashboard behaviour, what changes with Traefik | Redis internals beyond what matters | Repo | Collapses 73 + 48. It's the doc you need when "429" or "empty dashboard" shows up. |
| R4 `docs/app/run-build-test.md` | Do things: run, inspect, test, build | Engineers at a keyboard | Compose, the 8080 rule, Floci, queue/DLQ inspection and redrive, DB queries, running tests, image conventions | Why the system works this way (R2/R3) | Repo | Keeps the explanation docs free of commands. |
| R5 `docs/app/adr/0001-0003` | Keep full reasoning for hard-to-reverse choices, with a status | Reviewers, future changers | 0001 outbox + Standard queue (exists, Proposed). 0002 correctness via database constraints (Idempotency-Key deferred). 0003 interim gateway rate limiting (to be superseded by Traefik). | Small decisions (those stay in R2/R3) | Repo | These three will change status later; ADRs handle that. |
| P1 Plane page "Application docs" | Entry point from the work tracker | Team, Saad, graders | Links to R1-R5, one line each, plus which tickets they cover | Any explanation | Plane (links only) | Plane is where the team looks during a sprint; Saad asked for uncluttered pages. |

Deliberately left out:
- No capacity doc until ALPHA-80 decides something.
- No evidence-log doc: numbers go only where they justify a decision.
- No per-ticket pages.
- No Floci Terraform-testing doc in the app set. That's infra, so it waits for the infra docs.

## 5. Repo vs Plane decision

Verified from Saad (24 Sep):
- He asked "Why isn't this in a README in the Docker folder?", then said "either way works, it's preference."
- Don't clutter the Plane pages section.
- Rough notes go in one place.
- His test: "if I add a new team member, what are they going to read?"
- A document must be able to say what it's for in simple words.
- "The thought process can't be siloed."
- Consistent numbering.
- Write it yourself (he said this about tickets, descriptions and PRs).
- A running app takes priority over docs.
- A teammate (likely Naima; the transcript doesn't label speakers) said official docs will later go in a repo docs folder.

Our recommendation below follows docs-as-code: documentation written with the same tools and workflows as the code, including version control and code review ([Write the Docs](https://www.writethedocs.org/guide/docs-as-code/)). Nygard's ADR proposal also keeps decision records in the project repository ([Nygard 2011](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)).

| Knowledge | Repo | Plane | Both / Link | Reason |
|---|:-:|:-:|:-:|---|
| Service map, order flow, gateway behaviour | yes | | Plane links | Changes with the code. Reviewed in the same PRs. |
| Contracts (event envelope, endpoint responses, invariants) | yes | | | Must change in the same commit as the code that breaks them. |
| Decision records | yes | | Tickets link to the ADR | Findable next to the code, with a status. |
| Run / test / debug procedures | yes | | | Commands rot unless they're versioned. |
| Known limits you must respect today | yes (one short section per doc) | | Links to tickets | Part of how the system behaves right now. |
| Hardening items still to do | | yes | | That's work to schedule, not system knowledge. |
| Ticket acceptance, status, scope splits, before/after runs | | yes | PR ↔ ticket links | Work history. |
| Docs index | | yes (P1) | to repo | Entry point from where the team works. |
| Rough notes | | yes (one page) | | Saad's "one place" rule. |

Ambiguous cases:
- **Evidence numbers.** A number that justifies a decision (minus 57 reserved, 5 completed charges out of 6) goes in the repo next to that decision. The rest stays in tickets and PRs.
- **Hardening backlog.** The items belong in Plane. The rule "fix first, then harden" and each doc's "not safe yet" list belong in the repo.
- **If the team picks Plane for everything.** The same artifact set still works as Plane pages. We'd lose review-by-PR and versioning, and contracts would drift from code.

Treat this as a proposal to agree with Naima as captain.

## 6. Document architecture

R1 Start here (orientation; no decision section):
```
What this app is + what changed (5-8 lines)
↓ Service map (diagram): one line per service
↓ The order journey in 6 steps (links to R2)
↓ What changed in Sprint 2 (table: problem to fix to PR to doc)
↓ See it work in 5 minutes (link to R4)
↓ Not safe yet (6-8 bullets, links to tickets)
↓ Reading path + glossary
```

R2 How an order flows (explanation, with a reference section at the bottom):
```
TL;DR (5-8 lines)
↓ Current behaviour: the sequence (diagram), happy path with Sara's order 42
↓ When things go wrong: out of stock / card declined / service down to retries to DLQ to redrive
↓ Rules that must stay true (invariants, 6-8 bullets)
↓ Why it's built this way: 2-3 lines per choice, linking ADR-0001/0002; long polling cost note
↓ Trade-offs we accepted (at-least-once, ~1 s delay, outbox growth, manual redrive)
↓ Verification: what the tests prove, which failures were drilled live
↓ Reference: event envelope, endpoint response codes, reservation and order states, where the code lives
```

R3 Gateway and dashboard:
```
TL;DR
↓ Routing: what goes where (table), why the dashboard only works on 8080
↓ Who you are to the limiter: user / IP / sensitive, limits, 429 + Retry-After, fail-open
↓ Dashboard behaviour: login before fetch, 30 s refresh and why
↓ Rules that must stay true (trusted proxies only, metrics port never routed)
↓ Why + alternatives (summary; full reasoning in ADR-0003)
↓ What changes when Traefik arrives
↓ Verification + configuration reference (env vars, metric names)
```

R4 Run, build, test (how-to; no "why" beyond one line):
```
TL;DR: the 5 commands most people need
↓ Run the stack; open 8080, not 8086
↓ Place an order and watch it move (DB + queue checks)
↓ Failure drills: stop Floci, stop payment, DLQ redrive
↓ Run the tests (env vars; what a skip means; warm-pool note)
↓ Build images (conventions + adding a new service)
↓ Troubleshooting table (symptom to cause to fix)
```

R5 ADRs: Nygard's shape (Title, Status, Context, Decision, Consequences, one to two pages) plus Options and Verification, which is what ADR-0001 already has ([Nygard 2011](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)).

The split mirrors Diátaxis, which separates explanation, how-to, reference and tutorial content because they serve different needs ([diataxis.fr](https://diataxis.fr/)):
- R2 and R3 are explanation, each with a reference tail.
- R4 is how-to.
- R1 is the map.

## 7. First 5-10 lines (drafts to rewrite in Ahmed's voice)

R1 Start here:
> **What this is:** the application side of the EKS v2 order platform: 9 Go services behind one gateway, sharing one Postgres, with SQS carrying order events.
> **What changed in Sprint 2:** orders used to stay `pending` forever, because events were only logged and the worker never read the queue. Now an order placed through the gateway gets its stock held, gets charged and is confirmed, and its stock is committed, all visible on the dashboard.
> **The rule behind it:** fix first, harden later. What's not safe yet is listed at the bottom.
> **Start with:** How an order flows (15 min). To see it working, Run, build, test section  "Place an order" (5 min).

R2 How an order flows:
> Covers everything after an order is placed, until it's confirmed or cancelled.
> - order-service saves the order and its event in one transaction (the outbox). A loop sends the event to SQS within about a second, so SQS being down never loses an order.
> - The worker reads the queue and runs reserve to charge to confirm to commit stock.
> - Out of stock or card declined is a final answer: undo, cancel, delete the message. A 5xx or timeout gets retried: SQS redelivers, and after 3 tries the message goes to the DLQ.
> - SQS can deliver the same message twice, so every step is safe to repeat. The database enforces this, not the caller.
> Stop here for the shape. Below: the diagram, failure paths, and the rules you must not break.

R3 Gateway and dashboard:
> Covers how requests get in and how they're limited.
> - Everything goes through api-gateway on 8080. The dashboard page is served there too, because it calls `/api` and `/auth` on whatever host served it. On 8086 those calls 404.
> - Limits: 120/min per logged-in user, 60/min per IP when not logged in, 20/min per IP on login/register/webhook. Over the limit you get 429 and `Retry-After`. If Redis is down, requests are allowed through.
> - This is an interim design: per-IP limits move to Traefik later (ADR-0003).
> - All dashboard tabs share one login, and therefore one limit, so the dashboard refreshes every 30 s.

R4 Run, build, test:
> How to run the stack, watch an order move, break things on purpose and run the tests.
> Most people need only: `docker compose up -d --build`, open `http://localhost:8080`, place an order, check it's `confirmed` within ~5 s.
> Tests skip (they don't fail) when their database, Floci or Redis isn't set, so read the output for "SKIP".

ADR-0002 (opening pattern for all three):
> **Status:** Accepted for Sprint 2; Idempotency-Key replay deferred to hardening.
> **Decision:** the worker's calls are made safe to repeat by database constraints: one active reservation per order and product, one completed charge per order, and status changes that only apply from the expected state. Callers don't need to send a key.
> **Why:** SQS delivers at least once, and we reproduced the damage: 6 charges for one order produced 5 completed payments, and 20 overlapping releases took `reserved` to minus 57.

## 8. Onboarding path

| Time | Read | Should now understand |
|---|---|---|
| 5 min | R1 top + service map | What the 9 services are, that the gateway is the front door, that orders flow through SQS and the worker, what Sprint 2 fixed |
| 15 min | R2 to the end of "Rules that must stay true" | The full order lifecycle, the three failure outcomes, why duplicates are harmless, what not to break |
| 30 min | R4 "Place an order" (hands-on) + R3 TL;DR and routing | Can run the stack, watch an order confirm, explain 8080 vs 8086 and why a 429 happens |
| Deeper | ADR-0001/2/3, R2 reference section, tests beside the code | The alternatives and trade-offs, exact contracts, how each rule is tested |

Every doc ends with "Next:" pointing to the following step, so the path is followed rather than searched for.

## 9. Inventory of existing application work

| Work | Theme | Knowledge type | Change | Why | Alternatives | Decision | Trade-offs | Invariant | Verification | Artifact |
|---|---|---|---|---|---|---|---|---|---|---|
| ALPHA-61 Floci (PR #3) | Local env | PROCEDURE + DECISION | LocalStack replaced by Floci in compose; `floci-init.sh` creates queue + DLQ (`maxReceiveCount` 3) | Zero-cost local AWS for the whole team | LocalStack (previous). Reason for leaving: NEEDS VERIFICATION | Floci | Emulation ≠ AWS behaviour | `AWS_ENDPOINT_URL` set only locally, never on EKS | Redelivery to DLQ verified 23 Sep | R4 |
| ALPHA-56 Dockerfiles x9 (PR #15) | Images | DECISION + PROCEDURE | Multi-stage; `golang:1.26-alpine`; `CGO_ENABLED=0 -trimpath -ldflags "-s -w"`; distroless static pinned by digest; `USER nonroot`; OCI labels; `.dockerignore` | Repo brief requires multi-stage builds and image scanning | ALTERNATIVES: NEEDS VERIFICATION (likely in the Plane page "Dockerizing application services") | Distroless + nonroot | No shell in the runtime image | Images run as nonroot, static binary | Builds locally; CI Trivy scan configured but `ci.yaml` currently fails to parse | R4 |
| ALPHA-44 outbox + publisher (PR #23) | Order flow | SYSTEM + DECISION + CONTRACT | Event written to `order_outbox` in the order's transaction; relay sends to SQS every 1 s; `FOR UPDATE SKIP LOCKED` | Zero data loss; before, `publishEvent` only logged | A1 direct send + log, A2 direct send + 500, A3 outbox; Standard vs FIFO | Outbox + Standard queue | At-least-once, ~1 s delay, table growth (email in payload), Go 1.24 | Order and event saved together; every event has a unique `id` | 8 tests (3 mutation-checked, `-race`); live SQS-outage drill | R2 + ADR-0001 |
| ALPHA-51 reserve/release (`9d1e7f7`) | Correctness | DECISION + CONTRACT | Unique partial index: one active reservation per (order, product); repeat returns the existing hold (200); release claims rows with `UPDATE ... RETURNING` | Duplicates are normal on SQS; 20 releases to `reserved` minus 57 | ALTERNATIVES: NEEDS VERIFICATION | Enforced in the DB | Migration fails if duplicates already exist | One active hold per order/product; `reserved` never double-decremented | 5 tests, 20 runs `-race`; live 201 then 200 | R2 + ADR-0002 |
| ALPHA-51 payment (`040887a`) | Correctness | DECISION + CONTRACT | Partial unique index (refund rows excluded); same details to 200 `already_paid`, different to 409; `method=refund` rejected on `/charge` | 6 charges to 5 completed | A: DB safety net; B: `Idempotency-Key` replay (Stripe/IETF) | A now, B deferred to hardening | No exact replay of failed attempts | At most one completed charge per order | 6 tests; mutation to 20 charges without the index; live 201/200/409 | R2 + ADR-0002 |
| ALPHA-51 status compare-and-set (pending) | Correctness | DECISION (planned) | Not implemented; waits for #23 | Confirm + cancel both succeeded 25/30 | NEEDS VERIFICATION after implementation | `WHERE status = <current>` (planned) |: | One transition wins | Not yet | R2 |
| ALPHA-45 worker (PR #33) | Order flow | SYSTEM + DECISION | Long poll (20 s, 10 msgs); delete only after handled; decline / out of stock = final; 5xx/timeout = keep message; local visibility timeout 60 s | Worker never read the queue | Short poll (original 5 s loop) vs long poll; declines through the retry loop (rejected: a decline isn't a technical failure) | Long poll; business "no" is final | Stuck messages need a manual DLQ redrive | Delete after handling; visibility timeout > worst-case handler (~40 s) | 8 tests + real-SQS test; live: out of stock, outage to 3 tries to DLQ to redrive to decline | R2 |
| ALPHA-77 stock commit (PR #32) | Order flow / correctness | SYSTEM + CONTRACT | `POST /commit`: active to committed, `stock` and `reserved` drop in one transaction; scheduler expires only active holds; reserve treats committed as done | Sold items came back on sale after 15 min | ALTERNATIVES: NEEDS VERIFICATION | New reservation state `committed` | Expiry/commit race at the 15-min mark (hardening) | Committed holds never expire; commit twice changes nothing | 9 tests; live stock 5 to 3 | R2 |
| ALPHA-73 rate limiting (PR #25) | Edge | SYSTEM + DECISION | Keys: JWT `sub` (120/min), IP for anonymous (60/min), sensitive paths (20/min); atomic Lua; 429 + `Retry-After`; fail open; `TRUSTED_PROXY_CIDRS`; metric | `ip:port` key meant nothing was limited; login unlimited | Gateway-only vs Traefik edge; fixed window vs token bucket; fail open vs closed | Interim: gateway, fixed window, fail open | Double burst at the window edge; shared-IP logins; dashboard shares one bucket | Limit on real identity; `X-Forwarded-For` trusted only from listed proxies | 10 tests `-race` vs real Redis; 22 logins to 20x200 + 2x429 | R3 + ADR-0003 |
| ALPHA-48 dashboard routing (PR #29) | Edge | SYSTEM + DECISION | Gateway serves `/`, forwards `/dashboard/*` keeping the path; token on 3 calls; login before the first fetch, hourly re-login; refresh 30 s | Page uses same-origin paths; 8086 to 404; first load 6x401 | Own dashboard identity (hardening) vs slower refresh (now) | 30 s refresh + login-first | Data up to 30 s stale | Dashboard served only via the gateway | 5 routing tests; browser stub 7/7 to 0/7 rejected; live order 8 confirmed | R3 |
| ALPHA-74 pool visibility (PR #24) | Capacity | SYSTEM | `PGAPPNAME` per service; inventory `go_sql_*` on :9090 (host 9092) | Pools sum to 115 vs `max_connections` 100 | `/debug` JSON vs Prometheus | Prometheus on a separate port |: | Metrics port never routed by the gateway | Hot vs spread test: ~570/600 waited vs 0 | R4 (short) + R1 limits line |
| Capacity plan (ALPHA-80) | Capacity | DECISION (pending) | Not run yet | Choose pools / budget / PgBouncer from evidence | Pool budget, PgBouncer, no change | Pending |: |: |: | Not documented yet; the Plane ticket links the draft |
| SQS long polling cost | Cost | DECISION | 20 s wait | All SQS requests billed | 5 s short poll | Long poll |: |: | AWS pricing docs; 17,280 vs 4,320 idle receives/day | R2 (one paragraph) |
| Tests shipped with the fixes | Testing | PROCEDURE | Go tests beside the code; integration tests skip without env vars | Package-level access; keep CI green without DBs | `test/` folder (not how Go works for unit tests) | Beside the code | CI doesn't run `go test` |: |: | R4 |
| Hardening backlog | Known limits | Work + constraints | Grouped list with evidence | Fix first, harden later |: |: |: | Scheduler: 1 replica only, until fixed |: | Items to Plane; constraints to R1/R2/R3 |
| Scope splits, PR order, evidence log | History | TICKET HISTORY |: |: |: |: |: |: |: | Plane / PRs only |

## 10. Missing information

Critical (block the final docs):
1. **What's actually on main.** The docs must describe merged code, so wait for #23 to #31 to #32 to #33 plus #25 and #29. #31 also still needs its compare-and-set commit.
2. **Repo vs Plane.** Agree it with Naima as captain. Everything else in this plan depends on it.
3. **Reserve/release and stock-commit alternatives.** Either recover what was actually considered or write "not recorded". Don't invent them.

Useful:
4. **Dockerfile alternatives.** The reasons for distroless and digest pinning are likely in the existing Plane page; confirm before moving them.
5. **Why LocalStack was dropped.** The team's stated reason is zero-cost local AWS; confirm whether anything else drove it.
6. **Dockerfile source label.** `org.opencontainers.image.source` points at `Jawwad78/Alpha-Pilot-4week`, not the org repo. Check whether that's intended.
7. **SQS on EKS.** The Terraform SQS module doesn't exist yet. Its visibility timeout and DLQ retention have to match what R2 states.

Optional:
8. **Capacity numbers.** Only once ALPHA-80 has run.

## 11. Fresh-eyes review

New engineer:
- **"Seven things to read; where do I start?"** R1 is the only entry point. Everything else is reached from it, and every doc ends with "Next:".
- **"Outbox, idempotent, visibility timeout. I don't know these."** Define each term in plain words where it first appears, and keep a glossary in R1.
- **"Is this what's live, or what's in a PR?"** Put a "Describes: main as of `<commit>`" line under each title.
- **"I want to see it, not read about it."** Link R4's 5-minute order walkthrough from the top of R1, not the bottom.
- **"What must I not break?"** The same heading, "Rules that must stay true", in the same place in R2 and R3.

Staff engineer:
- **ADRs and topic docs will repeat each other.** Keep full reasoning only in the ADRs. Topic docs get 2-3 lines plus a link. Small decisions (30 s refresh, long poll, 200/409) live only in the topic doc.
- **Three ADRs are enough.** Only choices that are hard to reverse, or already scheduled to be superseded, get one; the Status field handles supersession.
- **Unsupported alternatives are a credibility risk in the stakeholder Q&A.** Write "not recorded" rather than reconstructing them.
- **Floci Terraform testing is infra, not app.** Remove it from R4; it goes to the infra docs later.
- **R2 could become the 20-page doc we're avoiding.** Contracts go in a reference tail. If any section runs past one screen, move its detail down a layer.
- **Docs will drift.** Change docs in the same PR as the behaviour they describe (docs-as-code). A "Describes: main as of" line makes drift visible.
- **P1 could turn into a second copy.** It holds links and one-line summaries only, never explanations.

Revised strategy: R1-R4 and ADR-0001-0003 in the repo, plus P1 as a links-only page in Plane. Floci Terraform testing moves out to the infra docs. Alternatives nobody recorded are written as "not recorded". Each doc carries a "Describes: main as of" line.

## 12. Final documentation strategy

```
Existing work to Knowledge inventory (section 9) to Group into 4 themes to Durable vs history (section 3)
to Source of truth (section 5) to R1-R4 + 3 ADRs + P1 to Cross-link tickets ↔ ADRs/docs to New-joiner read test
```

1. **First:** settle the critical gaps.
   - Agree repo vs Plane with Naima.
   - Get the merge chain onto main, with compare-and-set in #31.
   - Recover or mark the missing alternatives.
2. **Second:** write R1 and R2, plus ADR-0002. Move ADR-0001 in as it is. These carry most of the value.
3. **Third:** write R3 with ADR-0003, then R4.
   - Add P1 and the ticket ↔ doc links.
   - Run the review: a teammate who didn't work on the app reads only the first 10 lines of each doc, then does the 30-minute path. Fix whatever they get stuck on.

Sources: [NN/g, inverted pyramid](https://www.nngroup.com/articles/inverted-pyramid/) (most important information first), [Diátaxis](https://diataxis.fr/), [Nygard, Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions), [Write the Docs, Docs as Code](https://www.writethedocs.org/guide/docs-as-code/)
