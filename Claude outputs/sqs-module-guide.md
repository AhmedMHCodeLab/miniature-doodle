# SQS module (ALPHA-54): what to build, and why

Written 26 Sep for Ahmed, updated 28 Sep. Checked against `main` (PRs #23, #31, #32, #33 all merged), the pod identity PR (#36), the Terraform AWS provider docs, the AWS SQS docs and the stakeholder notes.

**The short version.**

- The module creates two queues: `eks-v2-dev-order-events`, and `eks-v2-dev-order-events-dlq` next to it. That's all the app needs.
- Five settings carry the design:
  - Standard queue (not FIFO).
  - Visibility timeout of at least 60 seconds.
  - `maxReceiveCount` 3.
  - DLQ keeps messages longer than the main queue.
  - Encryption at rest switched on in code.
- It must output the queue **URL** as well as the ARNs. The app is configured with the URL (`SQS_QUEUE_URL`), and IAM policies need the ARN.
- Cost is close to zero if you avoid two traps: a customer managed KMS key, and an SQS VPC endpoint.
- The riskiest thing about this ticket is drift. The local Floci script disagreed with the app once. Since #33 merged it matches (60 s, 3 tries), and Terraform must match both.
- Jawwad's pod identity PR (#36) is waiting for your `queue_arn` output. It currently gives order-service and the worker one shared SQS role. That's worth a review comment (section 8).

Stop here if you only need the shape. The rest explains each concept, maps it to the stakeholder requirements, and tells you what to look for in the docs.

---

## 1. The ticket as it stands

ALPHA-54 "Create SQS queues and DLQ". Yours now, carried into Sprint 3, still Todo. It needs story points like every Sprint 3 ticket.

Deliverables on the ticket today:

- `order-events` queue in Terraform.
- DLQ in Terraform.
- Redrive policy with `maxReceiveCount: 3`, "matching the local Floci configuration".
- Outputs: ARN of the queue, ARN of the DLQ.

What's missing or risky in that list:

1. **No queue URL output.** The app reads `SQS_QUEUE_URL`. The ARN is only for IAM.
2. **"Matching Floci" was a moving target.** Until #33 merged, `scripts/floci-init.sh` had no visibility timeout (so 30 seconds). It now sets 60 and 3 tries, the same as the worker expects.
3. **No word on encryption, retention or who consumes the outputs.** Those are where the stakeholder requirements bite.

---

## 2. How the app actually uses the queue

This is the contract the module has to satisfy. All of it is from the code.

| Who | What it does | Where |
|---|---|---|
| order-service | Saves each event in `order_outbox` in the same transaction as the order. A relay sends up to 10 unsent events per second, one `SendMessage` call each. | `outbox.go`, `publisher.go` (#23, merged) |
| worker | `ReceiveMessage` with `WaitTimeSeconds: 20` and `MaxNumberOfMessages: 10`. Handles the messages one by one, then `DeleteMessage` for each one handled. | `services/worker/main.go` (#33) |
| payment-service, shipping-service | Read `SQS_QUEUE_URL` but only log their events. They make no SQS calls. | `publishEvent` in each |
| Nobody | Reads the DLQ. A person redrives it. | |

**Settings the app relies on:**

- `SQS_QUEUE_URL`: the full queue URL.
- `AWS_REGION`: must match the queue's region. The provider uses `eu-west-2`.
- `AWS_ENDPOINT_URL`: set only on laptops (Floci). On EKS it must not be set.
- Credentials come from the SDK's default chain. The SDK in use (aws-sdk-go-v2 v1.47, config v1.33) is far newer than the minimum AWS lists for EKS Pod Identity (release 2023-11-14).

**The message itself:**

```json
{"id":"order-service-42","type":"order.created","timestamp":"...",
 "payload":{"order_id":42,"customer_id":"sara@example.com",
            "items":[{"product_id":"mug-1","quantity":2,"price":10}],
            "total":20,"currency":"GBP"}}
```

A few hundred bytes. No card data. It does contain the customer's email, which matters for retention (section 4).

**Worst-case time for one message** (this sets the visibility timeout):

- 5 HTTP calls with a 10 second timeout each: status check, reserve, charge, confirm, commit.
- Plus the delete, with a 5 second timeout.
- About 55 seconds in total. The docs still say 40, from before the status check was added; that needs updating.

**Messages per order:** usually 2 (`order.created`, then `order.status_changed` when the worker confirms or cancels). Each is sent once, received and deleted by the worker.

---

## 3. The concepts, each tied to our app

### Standard queue and "at least once"

A Standard queue can deliver the same message more than once, and not always in order. AWS stores messages on multiple servers, which is why it's durable, and also why duplicates happen.

**For us:** we chose Standard on purpose (ADR 0001) and made every worker step safe to repeat (ADR 0002, ALPHA-51, plus the status check in #33). FIFO would still hand the worker duplicates after a crash, and one stuck message blocks its whole group.

**Look for in docs:** "at-least-once delivery".

### Visibility timeout

When the worker receives a message, the message stays in the queue but is hidden from other consumers for the visibility timeout. If it isn't deleted in time, it becomes visible again and someone else can take it. AWS: "Start by setting the visibility timeout to match the maximum time your application typically needs to process and delete a message." The default is 30 seconds and the maximum is 12 hours.

**For us:**

- One message can take about 55 seconds, so 30 would cause duplicate work under slow conditions. 60 covers one message.
- The visibility timeout is also the **retry delay**. A failed message comes back only after it expires.

**Param's point on #33.** All 10 messages in a batch start their clock at the same moment, but the worker handles them one after another. If services are slow, the later ones can reappear before the worker reaches them.

- That's safe (every step is safe to repeat) but wasted work.
- Each extra receive counts toward the 3 tries.
- It needs services to be badly slow, so we treat it as a known limit and watch it in the load tests (ALPHA-80).

**Look for in docs:** "visibility timeout", `ChangeMessageVisibility` (AWS's answer for long or uneven work: extend the timeout while still working).

### Long polling

With short polling, `ReceiveMessage` answers straight away, often empty, and only samples some SQS servers. With long polling it waits up to 20 seconds for a message and checks all servers. Every empty answer is still a billed request.

**For us:**

- The worker asks for 20 seconds on every call, and the per-call value wins over the queue setting.
- Setting `receive_wait_time_seconds = 20` on the queue as well only protects any other client (a CLI, a future service) from short polling.
- One idle worker makes about 4,320 requests a day with long polling, against about 17,280 polling every 5 seconds.

**Look for in docs:** "short and long polling", `ReceiveMessageWaitTimeSeconds` vs `WaitTimeSeconds`.

### Dead letter queue and maxReceiveCount

AWS: "The `maxReceiveCount` is the number of times a consumer can receive a message from a source queue before it is moved to a dead-letter queue." Set it "high enough to allow for sufficient retries".

**For us:**

- 3 tries with a 60 second timeout means a message that keeps failing reaches the DLQ after about 3 minutes.
- That is well before a hold expires (15 minutes) and before the scheduler cancels an abandoned order (30 minutes).
- So an operator sees the problem in the DLQ while the order can still be saved.
- A business "no" (out of stock, card declined) never reaches the DLQ. The worker cancels and deletes it.

**Look for in docs:** "dead-letter queues", "redrive policy".

### Retention, and why the DLQ keeps messages longer

By default a message lives 4 days (minimum 1 minute, maximum 14 days). For Standard queues, AWS keeps the **original** enqueue time when a message moves to the DLQ, and recommends: "always set the retention period of a dead-letter queue to be longer than the retention period of the original queue."

**For us:**

- A message that spent 3 days failing in the main queue would otherwise expire in the DLQ almost at once.
- Main queue at 4 days covers a worker outage over a long weekend.
- DLQ at 14 days gives time to notice, fix and redrive.

**Look for in docs:** "message retention period", "enqueue timestamp".

### Redrive and the redrive allow policy

- **Redrive** moves DLQ messages back to the source queue, either with "Start DLQ redrive" in the console or the `StartMessageMoveTask` API. Local runs use the same API against Floci.
- **The redrive allow policy** sits on the DLQ and says which source queues may use it. The default allows any queue. `byQueue` limits it to ours.

**For us:** a redrive is safe because every step is safe to repeat. The person doing it needs `sqs:StartMessageMoveTask`, `sqs:ReceiveMessage`, `sqs:DeleteMessage` and `sqs:GetQueueAttributes` on the DLQ, and `sqs:SendMessage` on the destination. Those go on a human role, not on a pod.

**Look for in docs:** "dead-letter queue redrive", `redrive_allow_policy`.

### Encryption

Three options:

- **SSE-SQS.** SQS-owned keys, and AWS: "When you create a new queue, it will be encrypted by SSE-SQS by default", "at no additional charge".
- **SSE-KMS with the AWS managed key.** Uses KMS, so KMS charges apply.
- **SSE-KMS with our own key.** Money-wise it's pennies: $1 a month for a new key (nothing extra if we reuse the secrets-manager key), plus about 27,000 KMS calls a month for our two roles, a bit over the free 20,000. The real cost is permissions: order-service then needs `kms:GenerateDataKey` and `kms:Decrypt`, the worker needs `kms:Decrypt`, and so does whoever redrives the DLQ.

In transit, the SDK uses HTTPS. AWS also suggests a queue policy that denies any request where `aws:SecureTransport` is false.

**For us:** SSE-SQS meets "encrypted at rest" for free with nothing to manage. Set `sqs_managed_sse_enabled = true` explicitly. The provider only tracks drift on it when it's in the config, so writing it down makes the choice visible and reviewable.

**Checkov will complain.** Check `CKV2_AWS_73` wants our own KMS key, so it fails on SSE-SQS. Checkov runs as a warning in CI (it doesn't block the PR), but leave a skip comment with the reason on each queue so it reads as a decision, not a miss:

`#checkov:skip=CKV2_AWS_73:SSE-SQS chosen; no card data in messages, keeps KMS out of pod permissions`

One more thing SSE covers: only the message body is encrypted, not message attributes. Our email sits in the body, so we're fine. Just never move personal data into attributes.

**Look for in docs:** "encryption at rest", "SSE-SQS", "key management", "security best practices".

### Size and billing

- The max message size is 1 MiB. The provider default for `max_message_size` is 256 KiB.
- Billing counts every 64 KB chunk as one request.
- 1 million requests a month are free per account.
- The third-party pricing breakdown I found quotes $0.40 per million Standard requests after that, for us-east-1. Confirm eu-west-2 on the AWS pricing page.
- Data transfer to and from SQS in the same region is free.

**For us:** our messages are far under 64 KB, so one message is one request. Leave `max_message_size` at the default.

---

## 4. Stakeholder requirements, and what each one means here

| Requirement (source) | What it asks of the queue | How the module meets it |
|---|---|---|
| **Zero data loss** (Saad, 14 Sep) | No event may disappear | The outbox keeps every event in Postgres even while SQS is down (app side). The queue keeps messages 4 days, and failures go to a DLQ kept for 14 days instead of being dropped. A DLQ alarm makes sure someone notices. |
| **Cost is the #1 priority** | Justify every paid part | Standard queue, SSE-SQS (free), long polling, no VPC endpoint, no customer managed key. See section 7. |
| **PCI DSS, don't store card data** | Sensitive data protected | No card data in messages (checked in the payload). Encrypted at rest (SSE-SQS) and in transit (HTTPS; optional deny-non-TLS policy). Least-privilege access per service. |
| **GDPR-style retention limits** | Personal data not kept longer than needed | Messages hold the customer's email, so retention is capped: 4 days main, 14 days DLQ, both written in code. The outbox table has its own cleanup item (hardening 17). |
| **Audits possible** | Show who changed what | CloudTrail logs queue management events (create, delete, set attributes) by default. Per-message calls are data events: off by default, and extra cost if switched on. Terraform plus PR review is the change record. |
| **Burst traffic, Black Friday** | Absorb spikes | Queue backlog is unlimited. Orders are accepted by order-service even if the worker falls behind. We scale by adding workers. The in-flight limit (about 120,000 for Standard) is far above our numbers. One app-side limit for the load tests (ALPHA-80): the outbox relay sends at most about 10 events a second per order-service copy, and our Black Friday guess is about 20, so we'd need 2 or more copies. |
| **Least privilege, no long-lived keys** (project requirements) | Per-workload roles | order-service gets `sqs:SendMessage` only; worker gets `sqs:ReceiveMessage` and `sqs:DeleteMessage` only; both scoped to the queue ARN (ALPHA-65). No static keys in pods. |
| **Multi-AZ / DR** | Survive an AZ loss | SQS is a regional service on redundant infrastructure. There's nothing to configure. |
| **Investigate and recover from failures** (project requirements) | See problems, fix them | DLQ plus redrive runbook plus alarms on DLQ depth and oldest message age. |
| **Draft SLO: 99% of events on the queue within 5 s** | Fast hand-off | Handled by the relay (1 second tick). Keep `delay_seconds` at 0. |

---

## 5. Every setting: value, reason, provider argument

Provider resource: `aws_sqs_queue`. Defaults are from the provider docs.

| Setting | Main queue | DLQ | Default if left out | Why |
|---|---|---|---|---|
| `name` | `"${var.project_name}-${var.environment}-order-events"` | same with `-dlq` | random name | Same pattern as the secrets-manager module. One pair per environment, so dev workers never take prod orders. Max 80 characters. |
| `fifo_queue` | false | false | false | ADR 0001. |
| `visibility_timeout_seconds` | 60 | leave default | 30 | Longer than the slowest single message (about 55 s). Also the retry delay. |
| `message_retention_seconds` | 345600 (4 days) | 1209600 (14 days) | 345600 | DLQ longer than source, per AWS. Bounded for PII. |
| `receive_wait_time_seconds` | 20 | 20 | 0 | Long polling for any client that forgets to ask. |
| `delay_seconds` | 0 | 0 | 0 | Don't slow the hand-off. |
| `max_message_size` | leave default | leave default | 262144 | Our messages are tiny. |
| `sqs_managed_sse_enabled` | true | true | not set (AWS encrypts new queues by default) | Make encryption explicit and tracked. |
| `kms_master_key_id` | not set | not set | | Only if you choose SSE-KMS (section 9). |
| Redrive policy | `maxReceiveCount` 3, target the DLQ | | | Separate resource, see below. |
| Redrive allow policy | | `byQueue`, only the main queue | allow all | Stops other queues using our DLQ. |
| `policy` | optional deny-non-TLS | optional deny-non-TLS | none | AWS best practice; if you add it, include `Version = "2012-10-17"` or the apply hangs (provider warning). |
| `tags` | none needed | none needed | | The provider's `default_tags` already add Project, Environment, ManagedBy. |

**Why the redrive settings are separate resources.** The main queue's redrive policy needs the DLQ's ARN, and the DLQ's allow policy needs the main queue's ARN. Put both inline on `aws_sqs_queue` and Terraform has a cycle. The provider docs point to `aws_sqs_queue_redrive_policy` and `aws_sqs_queue_redrive_allow_policy` for this. Also from the provider docs: in `jsonencode`, `maxReceiveCount` must be a number (`3`), not a string (`"3"`).

---

## 6. The module shape

Location: `infra/terraform/modules/sqs/`, wired into `infra/terraform/main.tf`, with root outputs.

File names: the IaC Standards page says `variables.tf`, `outputs.tf`, `versions.tf`, but the existing modules use `variable.tf`, `output.tf`, `version.tf`. Match whatever the team settles on and don't add a third style.

```hcl
# modules/sqs/main.tf (sketch)
resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name}-dlq"
  message_retention_seconds = var.dlq_retention_seconds # 14 days
  receive_wait_time_seconds = 20
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "this" {
  name                       = var.name
  visibility_timeout_seconds = var.visibility_timeout_seconds # 60
  message_retention_seconds  = var.retention_seconds          # 4 days
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
}

resource "aws_sqs_queue_redrive_policy" "this" {
  queue_url = aws_sqs_queue.this.id
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count # 3, a number
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.this.arn]
  })
}
```

Optional deny-non-TLS policy (one per queue):

```hcl
resource "aws_sqs_queue_policy" "this_tls_only" {
  queue_url = aws_sqs_queue.this.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "sqs:*"
      Resource  = aws_sqs_queue.this.arn
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}
```

**Inputs:** `name`, `visibility_timeout_seconds` (60), `retention_seconds` (345600), `dlq_retention_seconds` (1209600), `max_receive_count` (3). A validation that `dlq_retention_seconds > retention_seconds` puts the AWS rule in code.

**Outputs:**

| Output | Value | Who uses it |
|---|---|---|
| `queue_url` | `aws_sqs_queue.this.url` | The Helm values or ConfigMap that set `SQS_QUEUE_URL` for order-service and the worker |
| `queue_arn` | `aws_sqs_queue.this.arn` | Pod Identity policies (ALPHA-65) |
| `dlq_url` | `aws_sqs_queue.dlq.url` | Runbook, redrive commands |
| `dlq_arn` | `aws_sqs_queue.dlq.arn` | Redrive permissions for the human role, alarms |

Note: `id` and `url` are both the queue URL on this resource. Only `arn` is the ARN.

---

## 7. Cost

| Item | Cost | Decision |
|---|---|---|
| Queues themselves | Free | |
| Requests | First 1M a month free per account | Idle: about 4,320 receives a day per worker, so about 130,000 a month each. Busy: about 6 requests per order (2 sends, 2 deletes, shared receives). Even 10,000 orders a day is about 1.8M a month, well under $1 at the quoted rate. |
| SSE-SQS | Free | Use it. |
| Customer managed KMS key | Pennies (see Encryption), plus KMS permissions on three roles | Skip unless the team wants key control (section 9). |
| SQS VPC interface endpoint | Billed per hour per AZ plus per GB; about $0.01 an hour per AZ in the US examples, so roughly $20+ a month across 3 AZs | Skip. Our traffic is kilobytes; the existing NAT gateway charges per GB processed, so it costs cents. |
| CloudWatch SQS metrics | Basic metrics come with SQS | Alarms are billed per alarm; keep it to two. |
| CloudTrail data events for SQS | Extra, per event | Leave off. Management events are enough for the audit story. |

---

## 8. What other tickets need from this

- **ALPHA-65 Pod Identity (Jawwad, PR #36 in review).** What it should get:
  - order-service: `sqs:SendMessage` on `queue_arn`.
  - worker: `sqs:ReceiveMessage` and `sqs:DeleteMessage` on `queue_arn`.
  - No `GetQueueUrl` needed, because the URL is passed in.
  - No KMS actions with SSE-SQS.

  What PR #36 has today: one shared role for both, which also allows `ChangeMessageVisibility` (the worker never calls it), a placeholder service account called `sqs`, and `sqs_queue_arn` defaulting to `"N/A"`. It's his PR, so a short review comment:

  > Thanks Jawwad. On the SQS part: order-service only needs SendMessage and the worker only needs Receive/Delete, so can we split it into two roles, one association each? Least privilege is graded. The SQS module will output `queue_arn`, so `sqs_queue_arn` can take `module.sqs.queue_arn` instead of the "N/A" default.
- **EKS manifests.** For each pod:
  - Set `SQS_QUEUE_URL` and `AWS_REGION`.
  - Do not set `AWS_ENDPOINT_URL`.
  - Do not set `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY`. AWS warns that credentials earlier in the SDK chain (environment variables come first) win over Pod Identity. Leftover test keys from compose would silently break auth.
- **IRSA vs Pod Identity.** The eks-v2 README prescribes IRSA; the team chose Pod Identity (ALPHA-38, ALPHA-65). The SDK supports both. This module doesn't care.
- **Local dev.** Compose still creates the queue with `floci-init.sh`. It matches today, but two definitions of one queue can drift again; it already happened once. Either apply this module to Floci through the local Terraform harness (`infra/terraform/local`), or keep a line in the PR that says "floci-init.sh matches: 60 s, maxReceiveCount 3".
- **Hardening item 24** in the App hardening plan is exactly this ticket. Mark it covered when it ships.

---

## 9. Trade-offs to decide (both sides)

**Visibility timeout: 60 or 90.**

- *60:* covers one slow message, and failures retry after a minute, so the DLQ is reached in about 3 minutes.
- *90:* more headroom for Param's batch case, but retries are slower (about 4.5 minutes to the DLQ).
- The design today is sized to one message and accepts the batch edge. 60 is consistent with the app; keep it unless the load tests say otherwise.

**Retention: 4 and 14 days, or shorter.**

- *Longer:* survives a long outage and gives time to redrive (zero data loss).
- *Shorter:* holds customer emails for less time (retention limits).
- 4 and 14 follow AWS guidance and the default. Write the reason in the PR so the audit story is explicit.

**Encryption: SSE-SQS or a customer managed key.**

- *SSE-SQS:* free, nothing to manage, meets "encrypted at rest".
- *Customer managed key:* key control and a CloudTrail record of every key use, which is stronger evidence for PCI. It costs money, adds `kms:*` permissions to both pods, and needs a key policy.
- The secrets-manager module already created a KMS key that could be reused. That costs nothing extra, but it couples the two modules.
- Money isn't really the deciding factor either way. SSE-SQS keeps permissions simpler; our own key is the stronger PCI answer. SSE-SQS plus the checkov skip is the lighter choice. Your call.

**Deny-non-TLS queue policy.**

- *For:* AWS best practice, zero cost, good compliance evidence.
- *Against:* one more resource. It needs the `Version` line. It may behave differently on Floci (plain HTTP) if the module is applied locally.
- Cheap enough to add.

**Name: settled.** `eks-v2-dev-order-events`. The secrets-manager module on `main` already names things `${project_name}-${environment}-...`, and staging and prod will share this account later. Locally it stays `order-events`, which is fine because the app gets the URL.

---

## 10. How to check it works

Locally, free:

1. `./scripts/floci-local-test.sh -target=module.sqs`, then apply.
2. `aws sqs get-queue-attributes --queue-url <url> --attribute-names All` against Floci. Check `VisibilityTimeout`, `MessageRetentionPeriod` and `RedrivePolicy`.
3. Apply again. It should say 0 to add, change or destroy.

In AWS, after the reviewed apply:

1. Same `get-queue-attributes` call. Also confirm `SqsManagedSseEnabled` is `true` on both queues.
2. **Prove the DLQ path.** Send one test message. Receive it 4 times with `--visibility-timeout 0` and don't delete it. It should appear in the DLQ (check `ApproximateNumberOfMessages` on the DLQ). Then redrive it back and delete it. This is cheap and proves the setting that matters.
3. Put the `terraform plan` output in the PR. That's the team habit on other infra tickets (ALPHA-65 lists it), not a written rule for this one.

---

## 11. Gotchas

- The provider default visibility timeout is 30 s. Leave the argument out and the worker's slow cases duplicate work.
- `maxReceiveCount` as a string in `jsonencode`: the provider docs call this out.
- Queue policy without `Version = "2012-10-17"`: the apply hangs until it times out.
- Setting a DLQ's retention equal to or shorter than the main queue's: old failures expire as soon as they land.
- Outputting only `arn`: the app can't use it.
- A queue someone made in the console: import it (`terraform import aws_sqs_queue.x <queue url>`) rather than creating a second one.
- DLQ metrics: AWS says `NumberOfMessagesSent` doesn't count messages moved there automatically. Alarm on `ApproximateNumberOfMessagesVisible` instead.

---

## 12. Monitoring worth having

| Alarm | Metric | Why |
|---|---|---|
| DLQ not empty | `ApproximateNumberOfMessagesVisible` on the DLQ above 0 | A message failed 3 times. Someone must look (hardening item 23). |
| Worker stuck | `ApproximateAgeOfOldestMessage` on the main queue above, say, 300 s | The worker is down or far behind. |

Nice to watch, no alarm needed:

- `NumberOfEmptyReceives` shows idle polling cost.
- `ApproximateNumberOfMessagesNotVisible` shows messages being worked on right now.

---

## 13. Questions to expect in the stakeholder Q&A

- *"What happens to orders if SQS goes down?"* They're still accepted. Events wait in the outbox and are sent when SQS returns. Drill done on 24 Sep.
- *"What if the worker is down over a weekend?"* Messages wait up to 4 days. Nothing is lost, and orders confirm when it's back.
- *"Can a customer be charged twice?"* No. Every step is safe to repeat, enforced in the database.
- *"Why not FIFO?"* It still gives duplicates to the worker after a crash, one stuck message blocks its group, and it needs a rename, group IDs and a different rate. ADR 0001.
- *"Is card data in the queue?"* No. Only order ID, email, items, total and currency. Encrypted at rest and in transit.
- *"What does it cost?"* Within the free tier at our volume. The two things we chose not to pay for are a VPC endpoint and our own KMS key, and we can explain why.

---

## Reading list (what to look for in each)

Terraform provider:

- [aws_sqs_queue](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue): argument defaults, `id` vs `url` vs `arn`, the `Version` warning on policies.
- [aws_sqs_queue_redrive_policy](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue_redrive_policy): example with the DLQ allow policy.
- [aws_sqs_queue_redrive_allow_policy](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue_redrive_allow_policy)
- [aws_sqs_queue_policy](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue_policy): only if you add the TLS rule.

AWS SQS developer guide:

- [Visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html): sizing, `ChangeMessageVisibility`, in-flight limit.
- [Short and long polling](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-short-and-long-polling.html): per-call value vs queue attribute.
- [Dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html): `maxReceiveCount`, the retention rule, allow policy.
- [DLQ redrive](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-dead-letter-queue-redrive.html): permissions for the person doing it.
- [Encryption at rest](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-server-side-encryption.html) and [SSE-SQS by default](https://aws.amazon.com/about-aws/whats-new/2022/10/amazon-sqs-announces-server-side-encryption-ssq-managed-sse-sqs-default/)
- [Key management](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-key-management.html): only if considering a KMS key.
- [Security best practices](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-security-best-practices.html): least privilege, TLS, VPC endpoints.
- [Message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html) and [queue quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-queues.html)
- [CloudWatch metrics](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html): the DLQ metric note.
- [CloudTrail logging](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-logging-using-cloudtrail.html): management vs data events.

Elsewhere:

- [SQS pricing](https://aws.amazon.com/sqs/pricing/): free tier and the 64 KB rule. Check the eu-west-2 rate.
- [EKS Pod Identity minimum SDK versions](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-minimum-sdk.html): the credential chain warning.
- [PrivateLink pricing](https://aws.amazon.com/privatelink/pricing/) and [NAT gateway pricing](https://aws.amazon.com/vpc/pricing/): the endpoint vs NAT comparison.
- Our own: ADR 0001 (queue type), ADR 0002 (safe to repeat), How an order flows (rules 8 to 10), App hardening plan items 19, 23 and 24.
