# Run of show

Main route: about 19 to 20 minutes of talking, which leaves room for transitions and one or two interruptions inside a 20-minute slot. Slide numbers match the footer of each slide.

## Before you start (10 minutes before)

1. Open the dev URL `https://dashboard.dev.eksv2.naimaosmann.com` in the browser you will share. Dev uses a Let's Encrypt staging certificate, so accept the browser warning now, not live.
2. Check it shows the **Kit Room** page (purple Team Alpha bar, "Kit out day one."). If it shows the older dark "Order Platform" page, the redesign is not deployed: use slides 6 and 7 instead of the live demo.
3. Check the Kit page lists products with stock (27 inch Monitor, Mechanical Keyboard, USB-C Hub, Wireless Mouse). Seeding is on in dev (`SEED_DEMO_PRODUCTS: "true"`).
4. Place one throwaway order to warm the path. It should reach Confirmed in about 5 seconds.
5. Have two windows ready: the deck (presenter view) and the browser at the Kit page. Light theme, browser zoom 110 to 125% so the back row can read it.
6. If dev is down, do not rebuild it before the session. The fallback is slides 6 and 7.

## Timings

| Slide | Section | What | Time | Running |
|---|---|---|---|---|
| 1 | Act I · Set the scene | Title: one order, followed all the way down | 0:30 | 0:30 |
| 2 | | Context: what Kit Room is, who uses it, the journey | 1:00 | 1:30 |
| 3 | | Starting line: the two stubs, what we built | 0:45 | 2:15 |
| 4 | | Goals and constraints: $200, cost first, five aims | 1:15 | 3:30 |
| 5 | Act II · Show the product | Demo cue, then switch to the browser | 3:00 | 6:30 |
| 6, 7 | | Demo frames. Skip if the live demo worked | 0:00 to 1:15 | 6:30 |
| 8 | | Operator's view, bridge to the engineering | 0:20 | 6:50 |
| 9 | Act III · The engineering | Architecture overview | 2:00 | 8:50 |
| 10 | | End to end 1: accepting an order | 1:15 | 10:05 |
| 11 | | End to end 2: processing it | 1:15 | 11:20 |
| 12 | | Why retries are safe, with evidence | 1:15 | 12:35 |
| 13 | | Decision 1: SQS behind an outbox | 0:55 | 13:30 |
| 14 | | Decision 2: Postgres in cluster for dev, RDS beyond | 0:55 | 14:25 |
| 15 | | Decision 3: CI builds, Git decides, ArgoCD deploys | 0:55 | 15:20 |
| 16 | | Decision 4: one NAT gateway | 0:55 | 16:15 |
| 17 | | Decision 5: no long-lived AWS keys | 0:55 | 17:10 |
| 18 | Act IV · Engineering judgment | What we have proven, and what we have not | 1:00 | 18:10 |
| 19 | | Limits and next steps | 0:45 | 18:55 |
| 20 | | Close: engineered for the order that goes wrong | 0:30 | 19:25 |
| 21 to 28 | Appendix | Only in Q&A | | |

If the live demo did not run and you used slides 6 and 7, you are about 1 minute over. Recover it by taking decisions 2 and 4 at 30 seconds each.

## The live demo (slide 5, about 3 minutes)

Say first: "One journey: an operations person kits out a new starter. Watch what happens between the clicks."

| Step | Do | Point at and say |
|---|---|---|
| 1 | On the **Kit** page, click **Add to kit** on 27 inch Monitor, Mechanical Keyboard and USB-C Hub. Press **+** once on the monitor. | The plan drawing fills in. "Prices and stock come live from inventory. The browser never sets a price." |
| 2 | Type a note: `New starter, Platform team`. Click **Place order**. | The docket shows **Placed** and "Queued for the fulfilment worker". "That 201 came back before any work started. The order and its event are saved together." |
| 3 | Wait about 5 seconds. Do not click anything. | Status turns **Confirmed**; Units available drops. "A background worker read the event from SQS, reserved stock, charged the card and confirmed it." |
| 4 | Click **Track order**. In the side panel click **Start processing**, then **Mark shipped**. | The shipment with a Royal Mail tracking number, and two emails. "Each email is sent once, even if an event is replayed." |
| 5 | Switch back to the deck (slide 8 if you skip 6 and 7). | "Now let's see what happened underneath." |

**If the card is declined.** The simulated provider declines about 1 in 10 charges. The order turns **Cancelled** and the stock comes back. Say: "That's the failure path, live: stock released, order cancelled, customer emailed. Same machinery." Then place the kit again.

**If an order stays pending for more than 30 seconds.** Do not debug live. Say "the worker is behind; this is why the queue exists", switch to slide 6 and carry on. Afterwards: `kubectl -n order-platform logs deploy/worker`.

**If the page will not load.** Go to slide 6: "Dev is torn down when idle to save cost. These frames come from the same build, captured on 13 Oct."

## Section boundaries for handing over between presenters

Each section stands on its own, so a question can be answered and the next presenter can pick up cleanly.

| Section | Slides | Hand-over line |
|---|---|---|
| A. Scene | 1 to 4 | "Let's see the product do its job." |
| B. Product | 5 to 8 | "Let's lift the lid." |
| C. Architecture and flow | 9 to 12 | "Five decisions sit behind this." |
| D. Decisions | 13 to 17 | "So what can we stand behind?" |
| E. Judgment and close | 18 to 20 | Questions |

Decisions split cleanly if two people share section D: 13 and 14 (application and data), 15 to 17 (delivery, network, identity).

## Getting back on track after an interruption

- Answer from the matching appendix slide: pipeline A1, secrets A2, scaling A3, failures A4, storage A5, environments A6, security A7, cost A8.
- Then return with one sentence that names where you are: "Back to order 3: it's been accepted, now the worker picks it up" (slide 11), or "That was decision 3 of 5" (slide 15).
- If more than 3 minutes go to questions mid-talk, switch to the short path from wherever you are (see `short-path.md`).
