## Description

Closes the last gaps in the order flow so the app is safe to run end to end.

- Placing the same order twice now makes one order (Idempotency-Key on `POST /orders`).
- The gateway only forwards public routes. Internal ones (charge, refund, reserve, restock, send email) get 404.
- The dashboard shows API data as text, so a product or order can't run code in the admin's browser.
- The dashboard Confirm button that skipped payment is gone.
- The carrier webhook only accepts `in_transit` and `delivered`.
- The scheduler cancels abandoned orders through order-service, so refund and restock happen.
- Expired stock holds are given back once, and an order whose hold expired mid-payment takes the stock again or is cancelled and refunded.
- Cancelling an order emails the customer.
- Old rows are cleaned up (events 90 days, sent outbox 7 days, notifications 90 days, idempotency keys 24 hours).
- Time checks use the database clock, so the server's time zone doesn't matter.

## Ticket Link

Ticket: [ALPHA-81](https://pilot-program.coderco.io/production-simulation/browse/ALPHA-81/)

## Screenshots / Evidence

Smoke test (`go run "Claude outputs/smoke/main.go"`), one real order flow through the public URL:

- Dev before this PR: 8 fails (duplicate order on retry, no cancel email, 6 internal routes reachable).
- Local with this PR: all steps pass.
- Unit tests pass for order, scheduler, inventory, worker, shipping, notification and gateway.

## Checklist

- [x] Tests passing locally
- [x] noted in description: `POST /orders` now needs an `Idempotency-Key` header (the dashboard sends one)
