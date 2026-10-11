# ADR 0004: Encrypt the order events queue with SSE-SQS

**Status:** Accepted, 29 Sep (ALPHA-54).
**Decision in one line:** both queues use SQS-managed encryption (SSE-SQS), with no KMS key of our own.

## Context

**What's in the messages.** Order event messages carry the order details and the customer's email. They carry no card data, because payment-service's `/charge` takes no card details.

**What the stakeholders asked for (24 Sep).**

- PCI DSS: don't store card details.
- Security, reliability and scale in balance, without optimising one and ignoring the others.

**The budget.** AWS spend has a $200 cap for the whole simulation, and it's the #1 graded priority.

**What SQS offers.** Three ways to encrypt at rest ([AWS docs](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-server-side-encryption.html)). All three encrypt only the message body. Queue names, message IDs, timestamps and message attributes are never encrypted.

**The team's existing pattern on main:**

- AWS-owned keys (AES256) for the Terraform state bucket and ECR;
- our own KMS keys, with rotation, one per purpose, for EKS secrets and Secrets Manager.

**How it came up.** The first SQS module guide (26 Sep) proposed SSE-SQS. Checkov then flagged `CKV2_AWS_73` ("use a customer-managed key"), and we looked at reusing the Secrets Manager key instead. We compared the options below during the ALPHA-54 design session on 29 Sep.

## Options

| Option | What it is | Cost | What it adds |
|---|---|---|---|
| **A. SSE-SQS (chosen)** | SQS encrypts with a key AWS owns and manages | Free ([AWS](https://aws.amazon.com/about-aws/whats-new/2021/11/amazon-sqs-server-side-encryption-keys-sse/)) | Nothing. No KMS permissions, no key to manage. We can't see or control the key. |
| B. SSE-KMS with the AWS managed key (`alias/aws/sqs`) | A KMS key AWS creates in our account for SQS | No monthly fee, but every KMS call is billed ([KMS pricing](https://aws.amazon.com/kms/pricing/)) | Both pod roles need KMS permissions. Key use shows in CloudTrail. We can't change the key's policy. |
| C. SSE-KMS with our own key (new, or the Secrets Manager one) | A key we control | $1 a month per new key, plus calls. Our estimate is about 27,000 calls a month for one sender and one reader, with SQS reusing a data key for 5 minutes. That's just over the 20,000 free, so a few cents | Full control: key policy, rotation, audit, revoke. Both pod roles need KMS permissions. If KMS refuses a call, sends and receives fail. Reusing the Secrets Manager key would tie the two modules together. |

## Decision

**A. SSE-SQS on both queues.**

- The messages hold no card data.
- Encryption at rest is covered for free.
- B and C would add KMS permissions to two roles, plus a new way for sending and receiving to fail. That buys control over the key, and nothing we run today uses that control.
- It follows the team's rule for data that doesn't need key control, as with the state bucket and ECR.

## Consequences

- No cost, no KMS permissions, and no key to rotate.
- Message metadata stays readable, so customer data must never go in message attributes.
- Checkov flags `CKV2_AWS_73` (no customer-managed key) on both queues. That's this decision. CI runs checkov in soft-fail mode, so it doesn't block.
- We can't show who used the key, or revoke it. If an audit asks for that, we need option B or C.
- Switching later means setting a KMS key on the existing queues. The queues aren't recreated, but both pod roles need KMS permissions first.

## How we know it works

On Floci the queues report `SqsManagedSseEnabled: true`, and checkov's encryption check (`CKV_AWS_27`) passes on both queues.

## Revisit when

- An audit or a stakeholder asks for customer-managed keys, or for a record of who used the key.
- Messages start carrying more sensitive data.

## Sources

- AWS: [SQS server-side encryption](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-server-side-encryption.html), [SSE-SQS announcement](https://aws.amazon.com/about-aws/whats-new/2021/11/amazon-sqs-server-side-encryption-keys-sse/), [KMS pricing](https://aws.amazon.com/kms/pricing/)
- Inside the project: the stakeholder assumptions (24 Sep), the encryption settings in the `eks`, `secrets-manager` and bootstrap Terraform, and the SQS module guide.
