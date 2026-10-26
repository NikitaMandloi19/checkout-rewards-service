# Decisions

## Scope and time spent
This is a timeboxed reference implementation intended to be run locally and discussed. Approximate initial implementation time: about 3–4 hours; update this value to your actual time before submission. The implementation is deliberately in-memory to keep setup repeatable and focus on invariants. It is not durable across process restarts.

## Invariants
1. Inventory never becomes negative.
2. A cart can produce at most one successful order.
3. A successful idempotent retry returns the original order and never changes stock twice.
4. Only a successful checkout consumes a coupon.
5. A coupon can be redeemed by at most one order.
6. Order line descriptions, quantities, unit prices and totals are immutable snapshots.
7. Report totals are derived from successful orders and reading the report has no side effects.
8. All monetary calculations use integer cents.

## Decision: Serialize state-changing operations in one process
**Context:** Concurrent checkout requests may race for the last inventory unit or the same coupon.

**Options considered:** Uncoordinated in-memory mutations; a mutex; database transactions with row locks/conditional updates.

**Choice:** A single asynchronous mutex serializes each mutation, and validation occurs before checkout mutations.

**Why:** It is easy to inspect and test in a small assignment and makes competing operations deterministic inside one Node process.

**Consequences:** This is not safe across multiple Node processes or replicas, and a process crash loses all data. Production should use PostgreSQL transactions, row-level locks or conditional inventory updates (`UPDATE products SET inventory = inventory - $qty WHERE id = $id AND inventory >= $qty`), unique constraints and transaction-scoped idempotency. Do not claim the in-memory mutex is distributed locking.

## Decision: Idempotency key is required for checkout
**Context:** A client may time out after checkout succeeds and retry.

**Options considered:** Infer duplicate requests from cart ID; optional idempotency; mandatory client-provided key.

**Choice:** Require `Idempotency-Key`; store successful key-to-order mapping. Reusing a key for a different cart conflicts. Failed requests do not consume the key.

**Why:** It separates network retries from new checkout attempts and permits retry after fixing an inventory or coupon error.

**Consequences:** This demo's map is volatile. In production persist the key, request/cart association and order ID in the same DB transaction, protected by a unique index. Decide whether mismatched payloads need a request hash.

## Decision: Price policy and order snapshots
**Context:** Product price can change between adding an item and checkout.

**Options considered:** Lock cart-time price; reject cart if price changed; use checkout-time price.

**Choice:** Cart display shows current price, checkout validates and uses current price, and order line items snapshot name, unit price, quantity and line total.

**Why:** It avoids silently honoring stale prices while keeping historical orders explainable.

**Consequences:** A customer may see a changed total at checkout; a production UI should surface the refreshed total before confirmation.

## Decision: Integer-cent money and rounding
**Context:** Binary floating-point can create inaccurate currency arithmetic.

**Options considered:** Floating point; decimal library; integer minor units.

**Choice:** Prices and totals are integer cents. Percentage discounts round half-up to the nearest cent using integer arithmetic; discount is capped at subtotal.

**Why:** It is deterministic for the supported USD currency and avoids float drift.

**Consequences:** Currency-specific minor-unit rules would be needed for currencies that do not use two decimal places. Taxes, shipping and refunds are out of scope.

## Decision: Coupon milestone and redemption semantics
**Context:** The prompt does not specify how milestones, coupon expiration, or multiple eligible milestones behave.

**Options considered:** Generate automatically during checkout; generate only on admin request; one coupon per milestone or many; FIFO versus latest eligible milestone.

**Choice:** Admin explicitly generates one coupon per eligible milestone. Milestones are based on successfully placed orders (5, 10, ...). Codes are deterministic, coupons never expire in this demo, and newest eligible unrewarded milestone is selected first. A failed checkout never consumes a coupon.

**Why:** It makes generation auditable and lets tests verify duplicate generation and redemption races.

**Consequences:** There is no expiration, customer eligibility, coupon stacking or cancellation/reversal workflow. If orders are refunded in production, define whether milestones are recalculated (recommended: no; treat placement as an immutable event).

## Decision: Fake payment boundary
**Context:** No real payment integration is required, but order creation must have a clear success point.

**Options considered:** Directly call an external provider; implement a payment interface and fake; omit payment state entirely.

**Choice:** A successful checkout is treated as payment success. No external provider is called.

**Why:** It avoids credentials and external dependencies within the timebox.

**Consequences:** A real payment provider requires a payment state machine, provider idempotency keys, webhook handling, and careful handling of the database/payment dual-write problem (often an outbox/saga or authorize-then-capture workflow).

## Decision: Error model
**Context:** API clients need to distinguish validation failures, missing resources, and conflicts.

**Options considered:** Generic 400 for all failures; framework defaults; stable machine-readable error codes.

**Choice:** Return `{ error: { code, message, details? } }`, using 400 for invalid input, 404 for missing resources and 409 for state conflicts.

**Why:** Clients can branch on `code` without parsing English messages.

**Consequences:** A production service should add request IDs, structured logs, and consistent validation error formatting.

## Decision: In-memory storage versus database
**Context:** The assignment permits an in-memory service if overlap invariants are demonstrated.

**Options considered:** PostgreSQL + TypeORM immediately; embedded database; in-memory maps plus serialized mutations.

**Choice:** In-memory maps and mutex for zero-credential setup, with concurrency tests.

**Why:** This keeps the deliverable easy to run and allows time to focus on checkout/coupon failure paths.

**Consequences:** Restart loses products' modified inventory, carts, orders, keys and coupons. Production version should persist products, carts, cart items, orders, order items, coupons, idempotency records and order events in PostgreSQL. Use a transaction for checkout; lock stock rows in stable product-ID order; enforce unique idempotency keys and unique coupon milestone; lock/conditionally update coupon status; derive reports from order snapshots or a reporting projection.

## Implemented versus deferred
**Implemented:** Seed data; cart lifecycle; input validation; checkout; order snapshots; current-price policy; idempotent successful retry; single-process serialization; inventory conflict; coupon milestone generation and one-time redemption; integer-cent arithmetic; report; focused tests.

**Deferred:** Persistent DB and migrations; authentication/authorization; real payment; taxes/shipping/refunds; coupon expiry and customer targeting; cart expiration; rate limits; observability; API versioning; OpenAPI generation; multi-currency; distributed concurrency; durable outbox.

## How it evolves for multiple instances and production scale
Use PostgreSQL as the source of truth. Start checkout with a transaction, acquire row locks or perform conditional stock decrements, validate/lock coupon rows, insert order/order lines and idempotency record, mark cart checked out, and commit. Add DB constraints as a last line of defense. Use stable lock ordering to reduce deadlocks and retry serialization/deadlock failures with bounded retries. Store prices as integer minor units or `NUMERIC` with explicit rounding. Keep report reads read-only; if traffic demands it, build a projection/materialized view and reconcile it against immutable order rows. Use Redis only for cache/rate limiting—not as the sole source of truth for inventory or coupon redemption.

## AI usage
AI assistance was used to help outline domain invariants, API routes, edge cases and test scenarios. The generated design was reviewed and deliberately constrained to a single-process mutex implementation because it is transparent and repeatable for this timebox. I would not accept a claim that this mutex protects multiple replicas; production requires database-enforced atomicity and uniqueness. Before submission, I will run the tests, inspect failures, and update this section with one concrete example of a suggestion I changed or rejected based on testing or code review.

## If given two more hours
1. Replace the in-memory store with PostgreSQL and TypeORM entities/migrations.
2. Add concurrent integration tests against the actual database and verify stock/coupon constraints under transaction contention.
3. Add an OpenAPI document and a Postman/REST Client collection.
4. Add payload-hash checking for idempotency key reuse and improve validation error consistency.
5. Add report reconciliation tests and logging/request IDs.
