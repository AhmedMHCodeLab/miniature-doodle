# ADR 0007: Order prices come from inventory

**Status:** Accepted on 6 Oct (ALPHA-50, merged into ALPHA-81, PR #63).
**Decision in one line:** order-service asks inventory for each item's price when the order is placed and ignores any price in the request.

## Context

`POST /orders` took the price of each item from the request body. Anyone with a token could buy a 199 GBP monitor for 0.01 GBP, and the charge, the ledger and the revenue figures would all follow that number.

## Options

| Option | What it is | Result |
|---|---|---|
| **A. Price at order time (chosen)** | order-service calls `GET /products/<id>` on inventory for each item, uses that price, rounds the total to the penny | The order and every later step see the real price. Orders can't be placed while inventory is down. |
| B. Check the price in the worker at reserve time | Accept the order as sent, compare the price when the worker holds the stock | The wrong total is saved first and shown on the dashboard until the worker catches it. Cancelling then needs a reason the customer understands. |
| C. Signed prices from a catalogue call | The client sends back a price token it got earlier | More moving parts than this app needs. |

## Decision

A. order-service is the only place a total is worked out, and it uses inventory's price. Unknown product: 422. Not enough stock: 409. Inventory unreachable: 503, so the client retries.

## Consequences

- A request can no longer set a price. The `price` field in the request is ignored, not rejected, so old clients keep working.
- Placing an order depends on inventory being up. A retry with the same `Idempotency-Key` is answered from what was stored, before pricing, so a retry after a success still works while inventory is down (ADR 0008).
- Amounts are added up as floats in Go and rounded to the penny before they are saved. Postgres stores them as `DECIMAL`.

## How we know it works

order-service pricing tests: a request price of 0.01 is replaced by the inventory price, an unknown product and short stock are refused, inventory down or erroring gives 503, repeated lines are counted together, and 239.96999999999997 rounds to 239.97.

## Revisit when

Prices change while orders are in flight often enough that customers complain, or discounts and vouchers arrive.

## References

[OWASP Web Security Testing Guide: business logic data validation](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/01-Test_Business_Logic_Data_Validation)
