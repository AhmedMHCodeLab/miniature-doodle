# ADR 0008: New orders and charges carry an Idempotency-Key

**Status:** Accepted on 7 Oct for orders (ALPHA-81) and 8 Oct for charges (ALPHA-119).
**Decision in one line:** `POST /orders` requires an `Idempotency-Key`, and the worker sends one on every `/charge`; the same key with the same request returns the first answer, so a retry never makes a second order or a second try at the card.

## Context

A stakeholder asked how a double submit is prevented, including someone calling the API directly. Payments were already safe (one completed charge per order, ADR 0002), but placing an order was not: if the reply to `POST /orders` was lost, the client could only send it again, and that made a second order.

## Options

| Option | What it is | Result |
|---|---|---|
| **A. Client sends an `Idempotency-Key` (chosen)** | The Stripe pattern, also an IETF draft. The client makes a random key per order and reuses it on a retry. | Exact: a retry is recognised even if the basket is the same as a real second order. |
| B. Treat "same customer, same basket, within N seconds" as a duplicate | No client change | Blocks a customer who really wants two of the same order, and still misses a retry after N seconds. |
| C. Disable the button in the page only | Front-end only | Does nothing for direct API calls or a lost reply. |

## Decision

- The header is required. Missing: 400. Over 255 characters: 400.
- The key is scoped to the customer and stored in `idempotency_keys` with a SHA-256 of the request (items, currency, notes, shipping address).
- The key is claimed inside the same transaction as the order. Two identical requests at the same moment make one order; the second waits and then gets the first one's answer.
- Same key, same request: 200 with the first order and `Idempotent-Replayed: true`. Same key, different request: 422.
- A failed attempt (bad product, inventory down) saves nothing, so the same key can be used again.
- Keys are deleted after 24 hours by the scheduler, as Stripe does. A retry after that is a new order.
- The dashboard makes one key per order and reuses it only when the first try got no clear answer.

**Charges.** A stakeholder also asked what happens if a customer pays twice. One completed charge per order was already a database rule (ADR 0002), but a declined charge could be sent again by a retry and be approved the second time.

- The worker sends `Idempotency-Key: charge-order-<id>`, the same on every retry of that order.
- payment-service saves the status code and body of the first answer in `payment_idempotency_keys`, inside the same transaction as the payment, and replays it for the same key: a decline stays a decline.
- Same key, different charge (another order, amount, currency or customer): 422.
- Calls without a key work as before. `/charge` is also closed to the outside at the gateway.
- Charge keys are kept 14 days, as long as a message can wait in the DLQ, so a redriven charge still gets its first answer.

## Consequences

- Breaking change for clients: any caller of `POST /orders` must send the header. The dashboard does.
- Replays are answered before pricing, so they work while inventory is down.
- The request hash leaves out the address when there is none, so keys stored before addresses existed still match.

## How we know it works

order-service: 8 tests (same key twice, 10 at once repeated 20 times, different request, missing and long key, inventory down, failed attempt, keys per customer) plus 1 for addresses. payment-service: 5 tests (a decline stays a decline on retry, a success is replayed, a key reused for another charge, 10 at once with one key make one payment, no key still works); removing the key handling makes 4 of them fail. worker: 1 test that every retry of a charge carries `charge-order-42`. The smoke test sends the same key twice through the public URL and checks it gets the same order.

## Revisit when

A second client (a shop front, a mobile app) starts placing orders: it must generate keys the same way.

## References

[Stripe: idempotent requests](https://docs.stripe.com/api/idempotent_requests), [IETF draft: The Idempotency-Key HTTP Header Field](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
