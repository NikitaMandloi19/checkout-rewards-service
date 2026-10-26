# Checkout & Rewards Service

A focused NestJS + TypeScript implementation of the checkout/rewards assignment. It uses an in-memory store so it runs without private services or database credentials. It demonstrates the core invariants within a **single Node.js process**; it is not a multi-instance production persistence solution.

## Requirements
- Node.js 20+
- npm

## Run
```bash
npm install
npm run start:dev
```
API base URL: `http://localhost:3000/api`

Run tests:
```bash
npm test
```
Build:
```bash
npm run build
```

## Seeded products
`GET /api/products` returns five seeded products. Prices are in USD; internally they are integer cents. Product 5 has only two units to make inventory conflicts easy to test.

## API
All request bodies are JSON. IDs are returned by create endpoints. Admin endpoints are marked `ADMIN`; auth is intentionally omitted.

| Method and path | Body / header | Success | Important errors |
|---|---|---|---|
| `GET /api/health` | — | `200` health status | — |
| `GET /api/products` | — | `200` product list | — |
| `POST /api/carts` | — | `201` cart (Nest default POST status) | — |
| `GET /api/carts/:id` | — | `200` cart and current prices/totals | `404 CART_NOT_FOUND` |
| `POST /api/carts/:id/items` | `{ "productId": 1, "quantity": 2 }` | `201` updated cart | `400 INVALID_QUANTITY`, `404 PRODUCT_NOT_FOUND`, `409 CART_ALREADY_CHECKED_OUT` |
| `PUT /api/carts/:id/items/:productId` | `{ "quantity": 3 }` | `200` updated cart | `400` invalid quantity, `404 CART_ITEM_NOT_FOUND` |
| `DELETE /api/carts/:id/items/:productId` | — | `200` updated cart | `404 CART_ITEM_NOT_FOUND` |
| `POST /api/carts/:id/checkout` | Header `Idempotency-Key: unique-client-key`; body `{ "couponCode": "REWARD5" }` or `{}` | `201` immutable order snapshot | `400 EMPTY_CART` / missing key, `404` missing cart/product/coupon, `409` stock conflict, redeemed coupon, or key reused for another cart |
| `GET /api/orders/:id` | — | `200` order snapshot | `404 ORDER_NOT_FOUND` |
| `POST /api/admin/coupons/generate` **ADMIN** | — | `201` coupon | `409 MILESTONE_NOT_REACHED`, `409 COUPON_ALREADY_GENERATED` |
| `GET /api/admin/report` **ADMIN** | — | `200` read-only summary | — |

Error response shape: `{ "error": { "code": "INSUFFICIENT_INVENTORY", "message": "...", "details": {} } }`.

## Quick manual test
1. `GET http://localhost:3000/api/products`
2. `POST /api/carts` with no body; copy returned `id`.
3. `POST /api/carts/cart_1/items` with `{ "productId": 5, "quantity": 2 }`.
4. `POST /api/carts/cart_1/checkout` with header `Idempotency-Key: demo-1` and body `{}`.
5. Repeat the same checkout with the same key: same order ID and `replayed: true`.
6. Try to add or checkout product 5 again from another cart: inventory conflict.
7. Create five successful orders, then call `POST /api/admin/coupons/generate`.
8. Check `GET /api/admin/report`.

Use Postman, Thunder Client, or VS Code REST Client. Remember to use the actual cart ID returned by your request, rather than assuming `cart_1` if you have restarted or created other carts.

## Semantics selected
- Checkout uses **current product price at checkout**, not the price at cart-add time. Order line prices are snapshotted when checkout succeeds.
- Cart is permanently checked out after a successful order.
- An idempotency key is global to this service and maps to one successful order. Failed checkout attempts do not reserve the key, so the client may retry after fixing the problem. Reusing the key for a different cart returns `409`.
- Coupon discount is a percentage of merchandise subtotal, applied before any taxes/shipping (neither is implemented). Percentage result rounds half-up to the nearest cent; totals cannot be negative.
- A milestone coupon is based on total successfully placed orders. Admin can generate at most one coupon for each milestone. If several milestones have passed, the newest unrewarded eligible milestone is generated first; repeated calls can generate older outstanding milestones. Coupon codes are deterministic (`REWARD5`, `REWARD10`, ...).
- Fake payment: successful validation represents payment success. No external payment calls are made.
