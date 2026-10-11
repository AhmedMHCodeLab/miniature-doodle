# Application docs

Links only. The explanations live in the repo, next to the code.

| Doc | What it answers | Covers |
|---|---|---|
| Application: start here | What the app is, what changed in Sprint 2, where to read next | Everything, one line each |
| How an order flows | What happens after an order is placed, including failures and retries | ALPHA-44, 45, 51, 77 |
| Gateway and dashboard | How requests get in, how they're limited, why the dashboard needs port 8080 | ALPHA-73, 48 |
| Run, build, test | Run the stack, watch an order, failure drills, tests, images | ALPHA-56, 61, 74 |
| Order events queue (SQS) | How the queue is set up in AWS and what the app needs from it | ALPHA-54 |
| ADR 0001 Outbox and Standard queue | Why events can't be lost | ALPHA-44 |
| ADR 0002 Safe to repeat in the database | Why retries can't double charge or double hold | ALPHA-51 |
| ADR 0003 Rate limiting in the gateway for now | Why the limiter looks like this and when it changes | ALPHA-73 |
| ADR 0004 SQS encryption | Why the queue uses SSE-SQS and not our own KMS key | ALPHA-54 |

New to the team? Read "Application: start here" first, then follow its reading path.
