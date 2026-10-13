# Presenter notes

Generated from the speaker notes in the deck (src/build-deck.js). Times are for the main route; see run-of-show.md and short-path.md.

Labels: TAKEAWAY is the one thing the audience should leave with. SAY is a suggested script, not a reading text. IF ASKED and DEPTH hold detail for questions. CAREFUL marks claims to avoid. NEXT is the transition.

## Sheet 1 · One order, followed all the way down

*Title*

`[0:30]` **TAKEAWAY:** We will follow one real order from the click down to the infrastructure.

**SAY:** We are Team Alpha. In four weeks we took a nine-service order platform that CoderCo gave us as source code and ran it on Amazon EKS, on a $200 budget. Instead of touring every resource, we will follow one order, order number 3, from the browser all the way down, and stop at the decisions that mattered.

**NEXT:** First, what the product is.

## Sheet 2 · Kit Room equips new starters from one page

*Act I · Context*

`[1:00]` **TAKEAWAY:** Kit Room is an ordering tool for equipping new starters. The journey is build, place, fulfil, track.

**SAY:** The code we were given was a generic order platform. We kept its workflow and gave it one clear use: an operations team ordering monitors, keyboards and hubs for people starting next week. Two audiences use one page: whoever places the order, and the operators who run stock, payments, shipping and messages from the OPS pages.

**IF ASKED:** It is the same API flow the brief grades: create order, reserve inventory, take payment, ship, deliver. The page signs itself in as one admin user. That is a known limit, slide 19.

**NEXT:** Here is what we were actually handed.

## Sheet 3 · Out of the box, no order got past pending

*Act I · The starting line*

`[0:45]` **TAKEAWAY:** The provided code could not move an order past pending. The heart of the order flow, and everything around it, is ours.

**SAY:** Two stubs sat at the centre. Publishing an order event was a log line, and the worker that processes orders had no queue code. Out of the box every order stayed pending for ever, and there were no tests. So our job was not only Docker, Terraform and Kubernetes. We had to build the part that makes an order real, and prove it holds up under retries.

**EVIDENCE:** codercohq/eks-v2 at e19e419 (our import af985c9 is identical): order-service main.go "Students implement actual SQS SendMessage here"; worker main.go receiveSQSMessages returns nil. Ours: outbox.go, publisher.go, the worker, idempotency.go in order and payment, allowlist.go, pricing.go, retention.go, 20 test files with 168 Test functions.

**CAREFUL:** Do not claim graceful shutdown, /livez or waitForDB. Upstream added those in May.

**NEXT:** So what did done mean for us?

## Sheet 4 · Five aims, shaped by a $200 budget

*Act I · Goals and constraints*

`[1:15]` **TAKEAWAY:** Cost came first, so every choice had to earn its spend. The five aims are aims; slide 18 says which are proven.

**SAY:** Our stakeholder set the order on 14 September: cost, then security, then uptime, then features. CoderCo reimburses up to $200 of AWS per team and asked us to justify every cost. The brief also fixed many tools, so our real choices were how to use them. From that we set five aims. Read them as aims, not guarantees: at the end we will show which ones we have evidence for.

**IF ASKED (currency):** Saad said $200 at the 13 Sep orientation; some team notes say pounds. The deck uses dollars throughout.

**IF ASKED (priority):** One stakeholder nudge on 6 Oct put security first. The written order from 14 Sep is cost first.

**NEXT:** Let us see the product do its job.

## Sheet 5 · Watch one order travel

*Act II · Live demo*

`[3:00 including the live demo]` **TAKEAWAY:** One coherent journey. What matters is what happens between the clicks.

**DO (live, in the browser, full screen):** 

1. Kit page. Add 27 inch Monitor, Mechanical Keyboard, USB-C Hub. Press + once on the monitor. Point at the plan drawing and the line "Prices and stock come live from inventory".

2. Type a note: "New starter, Platform team". Press Place order. Point at "Placed" and "Queued for the fulfilment worker".

3. Wait about 5 seconds. Point at Confirmed, and at Units available dropping.

4. Track order. Start processing, then Mark shipped. Point at the shipment, tracking number and the two emails.

**IF THE CARD IS DECLINED (the simulated provider declines about 1 in 10):** say "That is the failure path, live: stock released, order cancelled, customer told." Then place the kit again.

**IF DEV IS DOWN OR SLOW:** stay in the deck and use slides 6 and 7. Say so plainly: "Dev is torn down when idle to save cost; these frames come from the same build."

**NEXT:** Here is what you just saw, frozen, so we can point at it.

## Sheet 6 · Answered at once, confirmed seconds later

*Act II · The demo, frame by frame*

`[0:45, or skip if the live demo worked]` **TAKEAWAY:** Accepting an order and processing it are separate on purpose.

**SAY:** On the left is the moment of the click: the API has replied 201 and the order is saved, but nothing is processed yet. On the right, seconds later, nobody clicked anything: the worker took the event from the queue, reserved the stock, charged the card and confirmed. Stock leaves the shelf only after the charge succeeds.

**NEXT:** The rest of the journey.

## Sheet 7 · Every later step is visible, and happens once

*Act II · The demo, frame by frame*

`[0:30, or skip]` **TAKEAWAY:** Every later step is visible and happens once.

**SAY:** Moving to processing creates the shipment. Shipped puts it in transit and emails the tracking number. Each email has a dedupe key, so if an event is replayed, no second email goes out. And there is no address model yet; the page says so rather than inventing one.

**NEXT:** The operators' side.

## Sheet 8 · The same page runs the platform

*Act II · The operator's view*

`[0:20]` **TAKEAWAY:** Nine services sit behind this one page.

**SAY:** Operators see the same platform: today's orders and where they are, and the health of every service the browser can reach. The worker and scheduler do not show a latency because nothing from outside can reach them. That is deliberate. Let us lift the lid.

**NEXT:** Architecture.

## Sheet 9 · One entry point, nine services, one queue

*Act III · Architecture*

`[2:00]` **TAKEAWAY:** One public entry point, synchronous services for reads and writes, and one queue for the work that must not be lost.

SAY, left to right: Traffic enters through Route 53 and a Network Load Balancer to Traefik, which ends TLS with a certificate from cert-manager. The API gateway is the only public service. It checks the token, applies rate limits held in Redis and only forwards routes meant for the outside. Behind it, six HTTP services share one Postgres database. The interesting path is the queue: order-service hands events to SQS through an outbox, and the worker turns each event into reserve, charge, confirm, ship and email calls. Failed messages go to a dead-letter queue. A scheduler expires stock holds and cancels abandoned orders. Underneath, ArgoCD deploys everything from Git, Karpenter adds nodes, External Secrets brings in secrets, and every AWS caller gets its own role.

**IF ASKED:** Each environment has its own VPC across three AZs; nodes and pods are in private subnets; one NAT gateway (slide 16). Postgres runs as a StatefulSet in dev; staging and prod are written for RDS but have not been deployed.

**NEXT:** Now follow order 3 through it.

## Sheet 10 · Accepting an order: all or nothing

*Act III · End to end, part 1: accept*

`[1:15]` **TAKEAWAY:** Accepting an order is all or nothing, and it answers before any slow work.

**SAY:** The browser sends the order with an idempotency key. If the request gets no clear answer, a retry sends the same key. The gateway checks the token, the rate limit and the route. order-service first asks: have I seen this key? If yes, it replays the first answer. If not, it prices every line from inventory; a price from the browser is ignored. Then one database transaction claims the key, writes the order, its history and its outbox event. All four rows exist, or none do. Only then do we reply: 201, order 3, pending. Separately, a relay sends outbox rows to SQS every second. If SQS is unreachable, the row waits; the order is already safe.

**DEPTH:** The claim on (customer, key) is the guard. Two identical requests at once: the second INSERT waits on the first transaction, then replays its order. The price we pay: if the process dies after SQS accepts but before sent_at is saved, the event goes twice, so consumers must be idempotent.

**NEXT:** What the worker does with it.

## Sheet 11 · Processing: a worker that can safely run twice

*Act III · End to end, part 2: process*

`[1:15]` **TAKEAWAY:** The worker is written so that running it twice is harmless.

**SAY:** SQS delivers at least once, so the same message can arrive twice. The worker's first move is to read the order's status: if it is already confirmed it only makes sure stock is committed, if it is cancelled it undoes anything taken. Then reserve, charge with a fixed key per order, confirm with compare-and-set, and commit stock last. Three endings: success deletes the message; a final no, out of stock or declined, cancels and also deletes, because retrying would not change the answer; an error leaves the message, SQS hands it out again after 60 seconds, and the third failure goes to the dead-letter queue.

**IF ASKED (why not FIFO):** We do not need ordering; the worker reads current state instead of trusting message order.

**IF ASKED (visibility):** A batch of 10 slow messages could outrun 60 seconds. Known limit; every step is safe to repeat, so the cost is extra work, not double charges.

**NEXT:** How do we know this works?

## Sheet 12 · We broke it first, then made retries safe

*Act III · Why retries are safe*

`[1:15]` **TAKEAWAY:** Retries are safe because every layer absorbs a repeat, and we measured the failures before fixing them.

**SAY:** A repeat can enter at four layers, and each has its own guard: the request key, the worker's status check and compare-and-set, the payment key with a unique index, and the email dedupe key. We did not assume the bugs existed. We reproduced them: 25 of 30 runs where a concurrent confirm and cancel both won, stock driven to minus 57 by concurrent releases, six payment rows for one retried charge. Each is now a test, and all 168 test functions pass with the race detector on.

**EVIDENCE:** Claude outputs/fix-evidence-log.md (23 to 24 Sep, Postgres 16 test database). Re-run on 13 Oct: every service's go test -race passes against Postgres 16, Redis and floci.

**NEXT:** Five decisions behind this.

## Sheet 13 · SQS behind a transactional outbox

*Act III · Decision 1 of 5*

`[0:55]` **TAKEAWAY:** We chose a boring queue and made it safe with an outbox, so an SQS outage makes orders late, not lost.

**SAY:** Two systems, one write: that is the problem. The outbox puts the event in the same commit as the order, and a relay delivers it. We gained a managed queue with retries and a dead-letter queue built in, at almost no cost. We gave up exactly-once delivery, which is why the last two slides mattered.

**IF ASKED:** Kafka would have meant three brokers on persistent volumes in a cluster already holding Postgres and Redis, and rewriting the producers. Payment and shipment events are still only logged; moving them onto an outbox is on our list.

**NEXT:** Where the data lives.

## Sheet 14 · Postgres in the cluster for dev, RDS beyond

*Act III · Decision 2 of 5*

`[0:55]` **TAKEAWAY:** The data model wants one relational database; where it runs is a cost and risk trade-off we made per environment.

**SAY:** An order, its stock hold, its payment and its outbox row must commit together, which is why it is one Postgres. Dev runs it as a StatefulSet on an encrypted 20 gig volume with daily snapshots: that meets the brief and costs only the disk. For staging and prod we wrote RDS: managed failover and point-in-time restore. Be clear: staging and prod were never deployed, so RDS has never run live.

**IF ASKED (the brief says RDS is not an option):** The brief's author said on 6 Oct that RDS is sensible but does not show the StatefulSet skill. That is why dev runs the StatefulSet. The RDS module enforces prod settings: Terraform refuses prod without Multi-AZ, deletion protection, a final snapshot and 7+ days of backups.

**IF ASKED (restore):** The snapshot class and schedule run on dev. A restore checked against known data is not in our records; it is next step 3.

**NEXT:** How changes reach the cluster.

## Sheet 15 · CI builds, Git decides, ArgoCD deploys

*Act III · Decision 3 of 5*

`[0:55]` **TAKEAWAY:** CI never touches the cluster. Git is the record of what runs, so one service rolls back with one revert.

**SAY:** The pipeline builds only what changed, tests it with the race detector, scans it with Trivy, pushes one image and commits its tag. ArgoCD sees the commit and syncs that one service. We gained a pipeline with no cluster keys and a rollback that is a git revert. We gave up a little speed, and we need a bot allowed to write to main.

**CAREFUL:** Do not claim zero downtime. A 30 to 60 second blip during an ArgoCD sync on 10 Oct still has no root cause. The Argo Rollouts canary (50%, then error-rate and p95 checks) landed last and has not been tried against a bad release.

**NEXT:** The cost decision.

## Sheet 16 · One NAT gateway, on purpose

*Act III · Decision 4 of 5*

`[0:55]` **TAKEAWAY:** One NAT gateway is a deliberate single point of failure, accepted because cost is priority one, and softened by the outbox.

**SAY:** Private nodes need the internet for GitHub, Let's Encrypt and public images; endpoints cannot reach those at all. Doing AWS traffic through interface endpoints would mean at least six services across three AZs, eighteen billed endpoints running every hour. So we pay for one NAT and route S3 through a free gateway endpoint. If that AZ fails, all outbound traffic stops, including SQS calls, and that is where the outbox earns its place again: orders keep being accepted and wait.

**IF ASKED:** One teammate described two NATs in an earlier review; the code has one. The Terraform is the source of truth.

**NEXT:** Credentials.

## Sheet 17 · No long-lived AWS keys anywhere

*Act III · Decision 5 of 5*

`[0:55]` **TAKEAWAY:** Nothing we ship holds an AWS key. Every caller borrows a short-lived role scoped to one job.

**SAY:** GitHub Actions signs in with OIDC to a role per environment. The trust is pinned to our organisation and repository IDs and to the GitHub Environment, so another repo or branch cannot assume it. Pull requests get a read-only plan role, and a prod apply waits for someone other than the person who started it. Inside the cluster, Pod Identity gives each workload its own role: order-service may only send to the queue, the worker may only receive and delete. IMDSv2 with a hop limit of one stops pods borrowing the node's role.

**IF ASKED (brief asked for IRSA):** Same intent, least privilege per workload. Pod Identity avoids an OIDC provider per cluster, so the role definitions work on every environment.

**NEXT:** What we can stand behind.

## Sheet 18 · What we have proven, and what we have not

*Act IV · Where we stand*

`[1:00]` **TAKEAWAY:** We separate what ran on EKS, what tests prove, and what exists only as code.

**SAY:** Left column: things we watched happen on EKS dev, with a smoke test from 8 October. Middle: things proven by tests and local drills, not by real load. Right: things that exist in code and have not run: staging, prod, RDS, load tests, a restore checked against data, and the canary against a bad release. And we do not claim zero downtime.

**WHY:** The panel can check all of this. Saying it first is stronger than being caught.

**NEXT:** The limits that matter.

## Sheet 19 · Limits that matter, and what we would do next

*Act IV · Limits and next steps*

`[0:45]` **TAKEAWAY:** We know the limits, and the next steps are ordered by risk.

**SAY:** Four limits matter most. Anyone can sign in and see every order. Database connections are the first thing that will break: seven pools allow 115 against a default limit of 100. Payment and shipment events skip the outbox. And dev Postgres lives in one AZ. Next, in order: measure before tuning with the k6 plan we wrote, add real identity, then rehearse the bad day on staging.

**NEXT:** Close.

## Sheet 20 · Engineered for the order that goes wrong

*Act IV · Close*

`[0:30]` **TAKEAWAY:** The happy path was never the hard part; we spent our time and budget on the orders that go wrong.

**SAY:** If SQS goes quiet, orders still land. If a request repeats, nothing doubles. If our repository leaked tomorrow, it would hold no AWS key. That is what five engineers built in four weeks on a $200 budget. Happy to take questions; the appendix has the detail.

**THEN:** Leave this slide up during Q&A, or jump to the appendix slide that matches the question.

## Sheet 21 · A change to payment-service, from commit to traffic

*Appendix A1 · Deployment pipeline*

Use for: "A developer pushes a change to payment-service. Walk us through it." Point at steps 1 to 6, then promote and roll back. Caveat: the canary landed last and passes by default with no traffic.

## Sheet 22 · From Secrets Manager to a pod, and what rotation does

*Appendix A2 · Secrets*

Use for: "How do secrets reach a pod? What happens when you rotate?" Key line: only the services that use a changed secret restart, one pod at a time. The gap is new connections from old pods, up to 15 minutes, for the DB password.

## Sheet 23 · What scales, on what signal, and what breaks first

*Appendix A3 · Scaling*

Use for: "What scales, on what, and what breaks first?" Say plainly that the breaking order is reasoned from configuration; the k6 tests were not run.

## Sheet 24 · What happens when things fail, and how we know

*Appendix A4 · Failure scenarios*

Use for any "what happens if" question. Read the "How we know" column honestly: drills and smoke tests versus design only.

## Sheet 25 · Dev database: storage, snapshots and restore

*Appendix A5 · Storage and restore*

Use for storage, snapshot and migration questions. Note the snapshot class uses deletionPolicy Delete (an older doc said Retain), and that Redis runs on a 1 Gi volume, smaller than the brief's 10 Gi, to save cost.

## Sheet 26 · Three environments in code, one that has run

*Appendix A6 · Environments*

Use for "Is prod running?" Answer: no. Staging and prod are fully defined and planned, never deployed; dev is the environment that has run, and it is torn down when idle to save money.

## Sheet 27 · Known gaps we would name before you do

*Appendix A7 · Security*

Use for security questions. Own each gap and give its first fix.

## Sheet 28 · Where the money goes, and what we did about it

*Appendix A8 · Cost*

Use for cost questions. Replace "about $50 by 10 Oct" with the final bill before presenting; the figure comes from the 10 Oct meeting record.
