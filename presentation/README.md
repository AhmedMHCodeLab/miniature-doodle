# Kit Room: final demo deck

Team Alpha's 20-minute final demo for the CoderCo Production Engineering Simulation. The deck follows one real order from the click to the infrastructure, then explains five engineering decisions and says plainly what is proven and what is not. Nothing in this folder is used by the application or the deployment.

| File | What it is |
|---|---|
| `kit-room-final-demo.pptx` | The editable deck: 20 main slides and 8 appendix slides (A1 to A8), with speaker notes on every slide |
| `kit-room-final-demo.pdf` | The same deck as a PDF with fonts embedded. Use it if PowerPoint or the fonts are not available |
| `run-of-show.md` | Timings, the exact live-demo steps, fallbacks, and section boundaries for sharing the talk |
| `short-path.md` | A 10-minute route and a 5-minute emergency route |
| `presenter-notes.md` | Every slide's takeaway, suggested script, detail for questions and transition. Generated from the deck's own notes |
| `qa-appendix.md` | Likely panel questions with evidence-based answers and file references |
| `assets/screenshots/` | Real screenshots of the current build, used in the deck and as a demo fallback |
| `assets/fonts/` | Manrope, Inter and JetBrains Mono (SIL Open Font License) |
| `src/build-deck.js` | The script that builds the deck and `presenter-notes.md` |

## Before you present

These are the things only the team can confirm. Each one changes a claim in the deck.

- [ ] **Fonts.** Install the six files in `assets/fonts/` on the presenting machine before opening the `.pptx`, or PowerPoint will substitute other fonts and some text may reflow. The PDF needs nothing installed.
- [ ] **Dev environment.** Open `https://dashboard.dev.eksv2.naimaosmann.com`. If it is down, present the demo from slides 6 and 7 (see `run-of-show.md`).
- [ ] **Deployed build.** The screenshots and slide 2 show the Kit Room redesign from commit `4b1c5da` (13 Oct). Check dev shows the same page. If it shows the older dark "Order Platform" page, use slides 6 and 7 instead of the live demo.
- [ ] **Final AWS spend.** Slide A8 and its notes say "about $50 recorded by 10 Oct", the latest figure in the meeting records. Replace it with the final bill if you have one.
- [ ] **Restore drill.** Slides 14, 18 and A5 say a restore checked against known data is not recorded. If someone did one, change those three slides and say what was checked.
- [ ] **Presenters.** Assign sections A to E (`run-of-show.md`). Each section stands on its own.
- [ ] **Team repo matches this one.** The deck describes this repository at `4b1c5da`. If the team repository's `main` differs (for example the Argo Rollouts canary on slide 15 and A1, which arrived in the 13 Oct sync), adjust those slides.

## How the facts were checked

The code was treated as the source of truth, then compared against the docs and the meeting record.

- **Code.** Every technical claim was checked against the files named in `qa-appendix.md`.
- **Run.** All nine services were built and run locally on 13 Oct against Postgres 16, Redis and floci (local SQS). Every service's `go test -race` suite passed (168 test functions), the team's smoke test passed end to end, and the screenshots come from that run.
- **The brief.** The upstream application is `codercohq/eks-v2`. The team's first import matches its `HEAD` exactly, which is how slide 3 separates what CoderCo provided from what the team built. The `codercohq/prod-eng-challenge` repository was not accessible from this session.
- **Meeting record.** Notion transcripts and the Known limitations page were used for decisions that changed over time, and for what was and was not demonstrated: staging and prod never deployed, load tests never run, no recorded data-level restore, an unexplained blip during the 10 Oct sync. The deck states these rather than glossing over them.

### Where the repository's docs disagree with the code

The deck follows the code. These docs are out of date and may come up if a panel member has read them.

| Topic | Docs say | Code says |
|---|---|---|
| Postgres placement | `ARCHITECTURE.md`: StatefulSet in dev **and staging**, RDS in prod | StatefulSet in **dev only**; staging and prod use RDS (`kubernetes/platform/apps/templates/postgres.yaml`, `infra/terraform/environments/staging/main.tf`) |
| Deployment strategy | README and `ARCHITECTURE.md`: rolling update | Argo Rollouts canary, 50% then Prometheus analysis, for every service except the scheduler (`kubernetes/charts/microservice/templates/deployment.yaml`) |
| Redis volume | `ARCHITECTURE.md`: 10 Gi | 1 Gi (`kubernetes/platform/redis/statefulset.yaml`) |
| Snapshot class | `ARCHITECTURE.md`: `deletionPolicy: Retain` | `Delete` (`kubernetes/platform/manifests/volumesnapshotclass-ebs.yaml`) |
| HPA range | `ARCHITECTURE.md`: 2 to 5 pods | Chart default 2 to 5; dev overrides to 1 to 3 (gateway 2 to 3) |
| Architecture image | `images/architecture.png`: two NAT gateways, VPC endpoints, `app.jawwad.org` | One NAT gateway and one S3 gateway endpoint (`infra/terraform/modules/vpc/main.tf`); dashboard host `dashboard.dev.eksv2.naimaosmann.com` |
| Dashboard design | `services/dashboard-api/DESIGN.MD`: navy and coral, Archivo | The page uses CoderCo purple `#6C00FF`, Manrope, Inter and JetBrains Mono |
| Link | `services/README.md` links `DESIGN.md` | The file is `DESIGN.MD` (breaks on case-sensitive hosts) |

## Editing and rebuilding

Edit the `.pptx` directly for small changes. It uses a theme and four layouts (paper, plum, plum without footer, appendix), so colours and fonts can be changed in one place.

To rebuild from source instead, install `pptxgenjs` and `sharp` somewhere and point `NODE_PATH` at them:

```bash
cd presentation/src
npm install --prefix /tmp/deck-deps pptxgenjs@3.12.0 sharp
NODE_PATH=/tmp/deck-deps/node_modules node build-deck.js
```

This rewrites `kit-room-final-demo.pptx` and `presenter-notes.md`. Then run the post-processor and the strict schema check:

```bash
python3 interactions.py ../kit-room-final-demo.pptx interactions.json   # repairs multi-run paragraphs, adds motion
python3 check_xml.py ../kit-room-final-demo.pptx <path-to>/pml.xsd       # ECMA-376 PresentationML schema
```

`interactions.json` lists per-slide transitions and click builds; an empty `{"slides": []}` only repairs the markup. Export the PDF from PowerPoint (File, Export, PDF) or with LibreOffice: `soffice --headless --convert-to pdf kit-room-final-demo.pptx`.
