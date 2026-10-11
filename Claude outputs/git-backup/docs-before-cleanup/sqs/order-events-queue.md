# Order events queue (SQS)

Describes: `main` as of 3 Oct (`e300366`). The module merged in PR #40 (ALPHA-54). Not yet applied to AWS.

This page covers the SQS queue that carries order events in AWS: what the app needs from it, how it's set up, and how we got to this design.

- One queue, `eks-v2-dev-order-events`, plus a dead letter queue (DLQ), `eks-v2-dev-order-events-dlq`. Terraform builds both, in `infra/terraform/modules/sqs`.
- order-service sends events to the queue. The worker reads them and deletes each one once it's handled.
- If the worker fails the same message 3 times, SQS moves it to the DLQ. It waits there until someone redrives it.
- Every setting comes from the app's code, the stakeholder assumptions or the $200 AWS budget. The settings match Floci's, so a laptop test behaves like AWS.

Stop here if you only need the shape. Below: what drove the design, what the app needs, each setting, and the decisions we made along the way.

---

## 1. What shaped this design

| Driver | Where it comes from | What it means for the queue |
|---|---|---|
| No lost orders | Stakeholders asked for zero data loss (ADR 0001) | Failed messages go to a DLQ instead of disappearing, and the DLQ keeps them for 14 days, long enough to fix the cause and redrive them. |
| Black Friday bursts | Stakeholders: 1,000 users, with big spikes on Black Friday. Our capacity model assumes a 10x peak | The queue absorbs the spike and the worker catches up. The limit sits upstream: the outbox relay sends about 10 events a second per order-service replica, so peak traffic needs 2 or more replicas (ALPHA-80). |
| PCI DSS and security | Stakeholder requirement: store no card data, keep security, reliability and scale in balance | Messages hold no card data. The body is encrypted at rest (ADR 0004). Each service gets only the SQS actions it uses, and pods carry no AWS keys. |
| AWS spend, the #1 graded priority | $200 cap for the whole simulation | Long polling keeps one idle worker at about 130,000 requests a month, inside the 1 million free. Encryption is free. No VPC endpoint (about $22 a month across 3 AZs). |
| Free local testing | Team decision to test Terraform and the app on Floci first | Tries and visibility timeout match `scripts/floci-init.sh`, so what passes locally behaves the same in AWS. |

---

## 2. What the app needs from AWS

| Service | Env vars | What it does with SQS | AWS permissions it needs |
|---|---|---|---|
| order-service | `SQS_QUEUE_URL`, `AWS_REGION` | Sends events (the relay only) | `sqs:SendMessage` on the queue |
| worker | `SQS_QUEUE_URL`, `AWS_REGION` | Receives and deletes | `sqs:ReceiveMessage`, `sqs:DeleteMessage` on the queue |
| All other services | none | Nothing | none |

- **Where the permissions come from.** EKS Pod Identity gives each pod its role (ALPHA-65, PR #36). There are no AWS keys in the pods.
- **Never set these on EKS.** Don't set `AWS_ENDPOINT_URL`, because events would go to Floci instead of AWS. Don't set `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` either. The Go SDK uses keys it finds in env vars before any other source, so they would win over Pod Identity.
- **If `SQS_QUEUE_URL` is missing.** The worker refuses to start. order-service starts anyway and only logs a warning, and events pile up in `order_outbox` until the URL is set. After a deploy, check this first.
- **Where the URL comes from.** It starts as the Terraform output `sqs_queue_url` and goes into the Helm values `deploy/envs/dev/order-service.yaml` and `worker.yaml`. For now someone copies it in by hand once. ALPHA-99 makes CI write it after every apply.

---

## 3. The settings

| Setting | Main queue | DLQ | In one line |
|---|---|---|---|
| Visibility timeout | 60 s | 30 s (default) | Longer than the worker's worst case for one message, about 55 s. Nothing reads the DLQ directly. |
| Long polling wait | 20 s | 0 (default) | Matches the worker's `WaitTimeSeconds`. Fewer empty, billed requests. |
| Tries before the DLQ | 3 | n/a | Set in the app's starter code (`localstack-init`), and `floci-init.sh` kept it. A stuck message reaches the DLQ in about 3 minutes. |
| How long messages are kept | 4 days (AWS default) | 14 days (the maximum) | The DLQ must keep messages longer than the main queue. |
| Encryption | SSE-SQS | SSE-SQS | Free, using an AWS-owned key (ADR 0004). |
| Who may use the DLQ | n/a | Only the main queue | No other queue can send its failures here. |

The redrive policy and the redrive allow policy are their own Terraform resources, as the provider docs recommend. Each rule points at the other queue, so keeping them out of the queue blocks avoids a dependency loop.

---

## 4. How we got here

| Decision | Where we started | What we considered | What we chose, and why |
|---|---|---|---|
| Queue type | A Standard queue in the starter code | FIFO | Standard. FIFO still delivers duplicates after a crash, and one stuck message blocks its whole group. ADR 0001. |
| Visibility timeout | No value in the starter code, so the AWS default of 30 s | 30 s; 60 s; 10 minutes | **60 s.** AWS says to match the longest time a message takes. Ours is 5 calls with a 10 s timeout plus a 5 s delete, about 55 s. We rejected 10 minutes: a stuck message would take about 30 minutes to reach the DLQ, after its stock hold expires (15 min) and the scheduler cancels the order (30 min). |
| Batch size and wait | Starter code (commit `af985c9`): 10 messages per call, 20 s wait | Smaller batches; a short poll | **Kept both.** With a 20 s wait, one idle worker makes 4,320 requests a day instead of 17,280 with a 5 s poll. The batch can overrun 60 s, which we accepted (section 5). |
| Tries before the DLQ | 3, from the starter `localstack-init` | Nothing else raised | **Kept 3.** Terraform and Floci must agree. |
| Retention | AWS defaults: 4 days on both | 14 days on both | **4 days main, 14 days DLQ.** A message keeps its original arrival time when it moves, so an equal retention can delete it soon after it lands. It's capped because messages hold the customer's email. |
| Encryption | Nothing set | SSE-SQS; AWS managed KMS key; our own KMS key | **SSE-SQS.** Free, no KMS permissions, matches the state bucket and ECR. ADR 0004. |
| Permissions | PR #36 had one shared role with send, receive, delete and change-visibility | One shared role; one role per service | **One role per service,** raised as a review comment on PR #36 and split before it merged. order-service only sends. The worker receives and deletes. Nothing calls change-visibility. |
| Private network path | Traffic goes out through the NAT gateway | An SQS interface VPC endpoint | **No endpoint.** At $0.01 an hour per AZ it costs about $22 a month across 3 AZs, far more than our SQS traffic. |
| Getting the URL to the pods | Placeholder URLs in the Helm values (ALPHA-90) | Root output + Helm values; the app looks up the URL by name (`GetQueueUrl`); Terraform writes onto ArgoCD's cluster secret (the EKS Blueprints "GitOps Bridge"); External Secrets | **Root output `sqs_queue_url`, with CI writing it into the values (ALPHA-99).** `GetQueueUrl` needs a code change in two services and a new permission. The GitOps Bridge needs Terraform to talk to the cluster while ArgoCD is still being built. External Secrets stores a value that isn't secret, for $0.40 a month. |

---

## 5. What we accepted

- **A batch can overrun the timeout.** The worker takes up to 10 messages per call and handles them one after another, but 60 s is sized for one message. A slow batch can run past it, and SQS then hands a message out twice. That's safe because every step is safe to repeat (ADR 0002). We watch for it in the load tests (ALPHA-80). If it shows up, the fix AWS recommends is a heartbeat: the worker extends the timeout while it works (`ChangeMessageVisibility`).
- **DLQ redrive is manual.** Follow the [DLQ runbook](dlq-runbook.md). A CloudWatch alarm fires when any message is in the DLQ.
- **No policy forcing TLS on the queue yet.** That's hardening. The SDK uses HTTPS anyway.
- **Message metadata isn't encrypted.** SSE-SQS leaves message IDs, timestamps and attributes readable (ADR 0004). Don't put customer data in message attributes.

---

## 6. Rules that must stay true

1. The visibility timeout stays longer than the slowest message: 60 s today, against about 55 s. If you add a worker call or raise a client timeout, raise this too.
2. The number of tries before the DLQ is the same in Terraform and in `scripts/floci-init.sh`: 3.
3. The DLQ keeps messages longer than the main queue does.
4. order-service and the worker have `SQS_QUEUE_URL` set. No pod on EKS has `AWS_ENDPOINT_URL` or AWS keys.
5. Only order-service sends, and only the worker receives and deletes.

---

## 7. How we know it works

Applied to Floci locally on 29 Sep with `-target=module.sqs`:

- **Main queue:** `VisibilityTimeout` 60, `ReceiveMessageWaitTimeSeconds` 20, `MessageRetentionPeriod` 345600, `maxReceiveCount` 3, `SqsManagedSseEnabled` true.
- **DLQ:** `MessageRetentionPeriod` 1209600, and a `RedriveAllowPolicy` that names only the main queue.
- **A second plan:** "No changes", so applying again changes nothing.
- **Checkov:** the encryption check (`CKV_AWS_27`) passes. `CKV2_AWS_73` (no customer-managed key) fails on purpose, as ADR 0004 explains, and CI runs checkov in soft-fail mode.

Not yet applied to AWS. After the apply, run the check below against the real queue.

---

## 8. Reference

### Names and outputs

| Terraform output | Value in dev | Used by |
|---|---|---|
| `module.sqs.queue_url` (root: `sqs_queue_url`) | `https://sqs.eu-west-2.amazonaws.com/<account>/eks-v2-dev-order-events` | Helm values, as `SQS_QUEUE_URL` |
| `module.sqs.queue_arn` | `arn:aws:sqs:eu-west-2:<account>:eks-v2-dev-order-events` | Pod identity permissions |
| `module.sqs.dlq_arn` | `arn:aws:sqs:eu-west-2:<account>:eks-v2-dev-order-events-dlq` | DLQ redrive (`--source-arn`) |

### Check the settings

```bash
aws sqs get-queue-attributes --attribute-names All \
  --queue-url "$(terraform -chdir=infra/terraform output -raw sqs_queue_url)"
```

### Where the code lives

| What | Where |
|---|---|
| Queues and redrive rules | `infra/terraform/modules/sqs/main.tf` |
| Module wiring and the URL output | `infra/terraform/main.tf`, `infra/terraform/output.tf` |
| Local queue and DLQ | `scripts/floci-init.sh` |
| Sending | `services/order-service/publisher.go` |
| Receiving and deleting | `services/worker/main.go` |

### Sources

AWS and Terraform docs we designed against:

- SQS: [visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html), [dead letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html), [server-side encryption](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-server-side-encryption.html), [pricing](https://aws.amazon.com/sqs/pricing/)
- [AWS SDK for Go v2: where credentials are looked up](https://docs.aws.amazon.com/sdk-for-go/v2/developer-guide/configure-gosdk.html)
- [PrivateLink pricing](https://aws.amazon.com/privatelink/pricing/), for the VPC endpoint cost
- Terraform AWS provider: [`aws_sqs_queue`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue), [`aws_sqs_queue_redrive_policy`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue_redrive_policy), [`aws_sqs_queue_redrive_allow_policy`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue_redrive_allow_policy)
- [Checkov: skipping a check inline](https://www.checkov.io/2.Basics/Suppressing%20and%20Skipping%20Policies.html)
- URL options: [`GetQueueUrl`](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_GetQueueUrl.html), [EKS Blueprints GitOps Bridge](https://aws-ia.github.io/terraform-aws-eks-blueprints/patterns/gitops/gitops-getting-started-argocd/), [External Secrets and Parameter Store](https://external-secrets.io/latest/provider/aws-parameter-store/)

Inside the project:

- the stakeholder assumptions (24 Sep);
- ADR 0001 and ADR 0002;
- the starter code (commit `af985c9`);
- `scripts/floci-init.sh`;
- the worker's timeouts in `services/worker/main.go`;
- the PR #36 review.

Next: ADR 0004 for the encryption choice, or How an order flows for what the worker does with each message.
