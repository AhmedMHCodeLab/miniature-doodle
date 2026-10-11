# ADR 0010: The carrier webhook only accepts signed calls

**Status:** Parked (ALPHA-119). Designed and built, then left out of the sprint scope: the webhook stays unsigned and is listed as a known risk. The code is saved outside the repo.
**Decision in one line:** shipping-service accepts a webhook call only if `X-Carrier-Signature` holds the HMAC-SHA256 of the body, made with a secret shared with the carrier.

## Context

`POST /api/shipping/webhook` is public, because the carrier calls it from outside. Anyone who knew or guessed a tracking number could mark a parcel delivered, which also emails the customer.

## Options

| Option | What it is | Result |
|---|---|---|
| **A. HMAC signature of the body (chosen)** | The scheme GitHub and most carriers use: `sha256=` and the hex HMAC of the raw body | The secret never travels. A changed body fails the check. |
| B. A shared token in a header | The carrier sends the secret itself | Simpler, but the secret is in every request and the body can be changed. |
| C. Allow only the carrier's IP addresses | Network rule | Carriers change IPs, and there is no real carrier yet. |
| D. Signature plus timestamp (Stripe style) | Reject calls older than 5 minutes | Stops replays, but a replay is already harmless here (see Consequences), and each real carrier has its own scheme. Add it when one is connected. |

## Decision

- The body is read once (64 KB at most), checked, then parsed.
- No or wrong signature: 401. No secret configured: 503 for every call.
- The comparison uses `hmac.Equal`, which takes the same time however much matches.
- The secret is `CARRIER_WEBHOOK_SECRET`. It cannot be random, because the carrier must be given the same value. It comes the same way as the admin password (ADR 0009): the `CARRIER_WEBHOOK_SECRET` GitHub secret, Terraform's ephemeral variable, Secrets Manager (`eks-v2-<env>-carrier-webhook-secret`), an ExternalSecret on shipping-service. Each environment has its own value. Locally, docker compose sets `local-carrier-secret`.
- Where the check lives: in shipping-service, which owns the webhook, not in the gateway. The gateway only rate-limits the route. A caller inside the cluster that skips the gateway still has to sign.

## Consequences

- There is no timestamp in the signature, so a captured call could be sent again. That changes nothing: a shipment only moves forward, and a repeat is a no-op.
- The carrier must be given the secret out of band, and both sides change it together.
- Changing it: update the GitHub secret, raise `secret_string_wo_version` in the secrets-manager module, apply, restart shipping-service (Reloader does it when the Kubernetes secret changes), then give the carrier the new value.
- The GitHub secret `CARRIER_WEBHOOK_SECRET` must exist before any Terraform workflow runs, like `ADMIN_PASSWORD`. Apply first, then sync, or the webhook answers 503.

## How we know it works

shipping-service tests: no signature, another secret, body changed after signing, missing `sha256=`, not hex, no secret configured, and a correct call. Breaking the check makes them fail.

## Revisit when

A real carrier is connected: use its signing scheme (header name, timestamp) if it has one.

## References

[GitHub: validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [Go `crypto/hmac`](https://pkg.go.dev/crypto/hmac#Equal)
