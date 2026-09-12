# Business Rules

Scope: rules actually implemented in Phase 1, Phase 2, and Phase 3 (orders). Rules described in the
original brief that still have no code behind them (the bundle promotion, real payment provider
integration) are listed at the end as **not yet implemented**, so nobody mistakes their absence for
a bug.

## 1. Money

- Always integer minor units (e.g. piastres for EGP: 1 EGP = 100 minor units). Never a float.
- Every price-bearing row also carries an explicit `currency` (ISO 4217-ish string, default
  `"EGP"`). Multi-currency is not implemented; the column exists so it isn't a breaking schema
  change later.
- The only price a customer ever pays is `ProductVariant.price`. `Product.basePrice` is a display
  hint only and is never read by any pricing calculation.

## 2. Product publication state machine

```
DRAFT      → PUBLISHED   (requires ≥ 1 active ProductVariant)
DRAFT      → ARCHIVED
PUBLISHED  → ARCHIVED
ARCHIVED   → DRAFT
```

All other transitions (including no-op requests to the current status, which are treated as a
successful no-op) are rejected with `409 INVALID_STATE_TRANSITION`. There is deliberately no
`ARCHIVED → PUBLISHED` direct path — an archived listing must pass back through `DRAFT` so a staff
member consciously reviews it (price still correct? variants still valid?) before it goes live
again. This is a product decision, documented here so it isn't "fixed" by accident later.

Publishing requires at least one variant with `isActive = true`. Rationale: a published product
with zero purchasable variants would be a dead end for a shopper. This does **not** check stock
levels — a variant can be published with `onHand = 0`; it will simply show as unavailable
(`isAvailable: false`) rather than blocking publication, since availability is expected to change
after publishing without needing a status round-trip.

Implementation: `ProductsService.transitionStatus`, `src/modules/catalog/products/products.service.ts`.

## 3. Compatibility and purchasability

Only variants that were **explicitly created** by staff are purchasable. The system never
generates every possible (product × phone model × case type) combination and assumes it's valid —
each combination is a deliberate admin action (`POST /api/v1/admin/products/:id/variants`).

Public catalog endpoints only ever return `isActive: true` variants of `PUBLISHED` products.
`isActive: false` lets staff hide a specific combination (e.g. a discontinued model fit) without
deleting historical data.

## 4. Availability

```
isAvailable = variant.isActive
              AND (
                variant.stockItem is not null
                  ? variant.stockItem.onHand - variant.stockItem.reserved > 0
                  : variant.isUnlimitedStock
              )
```

A variant with no linked `StockItem` is available **only if** a staff member explicitly set
`isUnlimitedStock: true` on it - never assumed just because `stockItemId` is absent. This is a
deliberate correctness requirement, not the original MVP shortcut: an earlier version of this rule
treated "no `StockItem`" as "always available," which silently granted unlimited availability to
any variant staff simply hadn't linked stock to yet. `isUnlimitedStock` defaults to `false`, so a
newly created stockless variant is unavailable until deliberately opted in
(`POST/PATCH .../variants` with `isUnlimitedStock: true`) - see docs/DECISIONS.md.

This exact formula is enforced independently in three places that must all agree:
`ProductsService`/`product-response.mapper.ts` (public catalog), `CartPricingService` (cart/
checkout pricing and the `isAvailable` flag order creation checks), and
`CartService.assertSoftAvailability` (the functional gate on adding/updating/replacing a cart line
- this one previously had its own, separate "no StockItem → always allow" bypass that did not even
consult `isUnlimitedStock`; fixed alongside the other two). `reserved` is a real,
actively-maintained counter as of Phase 2 (see `docs/DATA_MODEL.md` §4).

`VariantsService` additionally rejects (`400`) setting `isUnlimitedStock: true` at the same time as
`stockItemId` - the two are mutually exclusive ways of being available with no ambiguity about
which one governs.

## 5. Stock adjustment

`PATCH /api/v1/admin/stock-items/:id/adjust` applies a signed integer delta to `onHand` via a
single conditional SQL `UPDATE ... WHERE "onHand" + $delta >= 0`. If the resulting value would be
negative, the update matches zero rows and the endpoint returns `400` — the counter is left
unchanged. This is safe under concurrent requests (see the inventory e2e test,
`test/inventory.e2e-spec.ts`, which fires 20 concurrent decrements against a stock of 10 and asserts
exactly 10 succeed and the final count is exactly 0).

This is a manual counter adjustment for staff corrections (recounts, damage, manual restock) with a
required `reason` string recorded in the audit log — it is **not** the reservation/consumption
system checkout will use in Phase 3 (see §10 below and docs/DECISIONS.md for the distinction). It
now also writes a `StockMovement` row in the same transaction (`reason: "manual_adjustment"`).

## 6. Duplicate prevention

| Constraint | Enforced at | Surfaced as |
|---|---|---|
| Product slug uniqueness | DB unique index | `409 PRODUCT_SLUG_TAKEN` |
| Variant SKU uniqueness (global) | DB unique index | `409 VARIANT_SKU_TAKEN` |
| One variant per (product, phoneModel, caseType) | DB unique index (NULLs excluded, see DATA_MODEL.md) | `409 VARIANT_COMBINATION_EXISTS` |
| Taxonomy slug uniqueness (brand/model/case type/collection) | DB unique index | `409 <ENTITY>_SLUG_TAKEN` |
| Staff email uniqueness | DB unique index | `409 STAFF_EMAIL_TAKEN` |
| Stock item SKU uniqueness | DB unique index | `409 STOCK_ITEM_SKU_TAKEN` |

All of these are enforced by a real database constraint, not just an application-level check —
the application check exists only to turn a raw Postgres `23505` error into a clean, stable error
code (see `src/common/utils/prisma-error.util.ts` for how the specific violated constraint is
identified).

## 7. Variant pricing validation

`compareAtPrice`, if provided, must be strictly greater than `price`. Enforced in
`VariantsService` on both create and update (using the *effective* price/compareAtPrice after
merging a partial update with the existing row, so a `PATCH` that only changes one of the two
fields is still validated against the resulting pair).

## 8. Roles and permissions

| Role | Can do |
|---|---|
| `OWNER_ADMIN` | Everything, including staff management and audit log access |
| `CATALOG_MANAGER` | All catalog CRUD (products, variants, taxonomy, media, stock) — cannot manage staff or read the audit log |
| `ORDER_OPERATOR` | Order management (Phase 3): list/view orders, change fulfillment status. Cannot change payment status (`OWNER_ADMIN` only - see §20) and has no catalog/staff access |

An `OWNER_ADMIN` cannot deactivate their own account or change their own role
(`StaffService.update`), to prevent accidental self-lockout. There is currently no check preventing
the *last* `OWNER_ADMIN` account from being deactivated by a *different* `OWNER_ADMIN` — with only
one admin role in the system today, this is a real gap to close before production use, not a
tested/guaranteed safety net.

## 10. Stock reservation lifecycle (Phase 2)

```
              reserve()                consume()
  (none)  ──────────────►  ACTIVE  ──────────────►  CONSUMED
                              │
                              │ release()
                              ▼
                     RELEASED / EXPIRED
```

- `reserve(stockItemId, quantity, ttlMinutes?)` increments `StockItem.reserved` via one conditional
  `UPDATE ... WHERE "onHand" - reserved >= $quantity`, so it can never over-reserve under
  concurrency (verified with 8 concurrent reservation attempts against a stock of 5 in
  `test/reservations.e2e-spec.ts`, mirroring the stock-adjustment concurrency test). Default TTL is
  15 minutes (`DEFAULT_RESERVATION_TTL_MINUTES`).
- `release(reservationId, status?)` decrements `reserved` back down; `onHand` is untouched.
  Idempotent — releasing an already-released/expired/consumed reservation is a no-op.
- `consume(reservationId)` decrements both `onHand` and `reserved`, and writes a `StockMovement`.
  Only valid from `ACTIVE`; consuming a non-active reservation is a `409 INVALID_STATE_TRANSITION`.
- Expired holds are swept both **lazily** (`reserve()` first releases any expired `ACTIVE`
  reservations on the *same* stock item, so a hold that outlived its TTL never blocks a new
  legitimate reservation just because no background sweep has run) and **on a schedule**:
  `releaseAllExpired()` sweeps every stock item at once, called every minute by
  `OrderExpiryScheduler` (Phase 3, see §21) and also exposed as a manual admin trigger
  (`POST /admin/stock-reservations/sweep-expired` and `POST /admin/orders/sweep-expired`).
- **`reserve`/`consume` are now called from a real checkout flow.** `OrdersService.createOrder`
  calls `reserveManyInTransaction` at order creation; `updatePaymentStatus` calls
  `consumeManyInTransaction` on the transition to `PAID`. See §18-20.

## 11. Guest cart

- A cart is created via `POST /api/v1/cart`, which returns an opaque `token`. Every other cart
  endpoint requires that token in an `X-Cart-Token` header; a cart's database `id` alone grants no
  access (`CartTokenGuard`).
- Adding an already-in-cart variant merges quantities into the existing line rather than creating a
  duplicate (`@@unique([cartId, variantId])` + upsert in `CartService.addItem`).
- **Adding to a cart never reserves stock.** The availability check at add/update time
  (`CartService.assertSoftAvailability`) is informative only — it reads the live
  `onHand - reserved` at that moment and rejects (`409 INSUFFICIENT_STOCK`) if the requested
  quantity exceeds it, but holds nothing. Stock can still run out before checkout; order creation
  (§18) is the actual source of truth and calls `ReservationsService.reserve` for real.
- A per-item quantity is capped at 20 (`MAX_CART_ITEM_QUANTITY`), enforced both per-request and
  cumulatively when merging with an existing line.
- A cart line's variant can be atomically replaced (`PATCH /cart/items/:itemId/variant`) without a
  separate remove+add round trip - see §14.
- Every cart read recomputes totals from the *current* variant price - a cart has no persisted
  total and is not a price guarantee (see docs/DATA_MODEL.md §8). `POST /checkout/quote` (§17) is
  the closest thing to a lock-in preview, and is still non-binding until `POST /orders` succeeds.
- An item whose product/variant has become unpublished/inactive/out-of-stock since it was added is
  **not** silently removed from the cart - it stays, flagged `isAvailable: false` with an
  `unavailableReason`, and is excluded from `subtotal`/`total`. This mirrors the brief's instruction
  to preserve cart contents rather than silently dropping items, extended here from checkout-time to
  every cart read.

## 12. Coupons

- Two types: `FIXED` (integer minor units off) and `PERCENTAGE` (1-100, whole points).
- A coupon's discount is computed against the subtotal of **available** cart items only, and is
  **always rounded down** to the nearest minor unit — e.g. 10% of 999 is 99, not 100. This keeps
  `subtotal - discountTotal` exact with nothing fractional to allocate, which matters once Phase 3
  needs to reverse a discount on a partial refund.
- A coupon is rejected (`400 COUPON_NOT_APPLICABLE`, via `applyCoupon`) if: inactive, not yet
  started, expired, subtotal below `minSpend`, or `usageCount` has already reached `usageLimit`.
- **Cart-time validation is provisional; order creation is where `usageLimit` is finally,
  atomically enforced** (Phase 3, see §19). A coupon that becomes invalid *after* being applied to a
  cart (e.g. it expires, or its limit is reached by someone else's checkout) is not silently
  dropped: the cart keeps `couponId` set but `CartPricingService` re-validates on every read and
  surfaces `couponWarning` with `discountTotal: 0` instead, and `OrdersService.createOrder`
  independently re-validates and re-enforces the limit under a concurrency-safe conditional update
  at the moment of checkout, not trusting the cart's last-read state.
- Per the brief's own caution: without a verified guest identity strategy, "one use per customer"
  cannot be reliably enforced for anonymous shoppers. No such limit is implemented; only the global
  `usageLimit` (across all customers) exists.

## 14. Atomic cart variant replacement (Phase 3)

`PATCH /api/v1/cart/items/:itemId/variant` (`CartService.replaceItemVariant`) changes an existing
cart line's variant as a single atomic operation, not a client-side remove+add:

- Validates the new variant (exists, published product, active) and re-checks soft stock
  availability for the *target* quantity **before** writing anything.
- If the cart already has a line for the new variant, the two lines are merged (quantities summed,
  capped at `MAX_CART_ITEM_QUANTITY`) and the old line is deleted; otherwise the existing line is
  updated in place to point at the new variant.
- The whole mutation runs inside one `prisma.$transaction` - if validation fails (unavailable
  variant, insufficient stock), the original line is **left completely untouched**; there is no
  window where the cart has neither the old nor the new variant.

## 15. Cart mutation requires an ACTIVE cart

Every cart-mutating operation (`addItem`, `updateItemQuantity`, `replaceItemVariant`, `removeItem`,
`applyCoupon`, `removeCoupon`) rejects with `409 CART_NOT_ACTIVE` if the cart's status is not
`ACTIVE` - in practice this means a cart that has already been converted into an order
(`status: ORDERED`, see §18). `CartTokenGuard` itself only checks that the token maps to *some*
existing cart (not that it's active) - this split exists specifically so an idempotent order-creation
retry (same idempotency key, same cart, cart now `ORDERED`) can still reach `OrdersService` and get
its short-circuited response, instead of being rejected at the guard before `OrdersService` ever
runs (see docs/DECISIONS.md for the bug this fixed).

## 16. Shipping (Phase 3)

- Shipping is configured by staff as `ShippingZone` (a named set of countries) → one or more
  `ShippingRate`s under it (price, optional free-shipping threshold, estimated delivery days).
  `OWNER_ADMIN`/`CATALOG_MANAGER` manage zones/rates; there is no public write access.
- A destination country with no active rate under any active zone is **unsupported**: both the
  storefront rate list (`GET /shipping-options?country=`) and checkout/order creation reject it
  (`409 SHIPPING_RATE_NOT_AVAILABLE`) rather than silently falling back to a default price.
- **Free-shipping threshold basis: the post-discount total.** `computeShippingPrice(rate,
  basisAmount)` compares `basisAmount` (which callers always pass as `subtotal - discountTotal`,
  i.e. *after* any coupon) against `freeShippingThreshold`. This is an explicit choice, not an
  accident: a coupon that drops the payable amount below the threshold should also drop free
  shipping, since "free shipping over X" is a promise about what the customer actually pays.
- All shipping prices in seed data and examples are marked "(demo)" - see docs/DECISIONS.md. No
  code path invents a production price or delivery estimate; every number shown to a customer comes
  from a `ShippingRate` row an admin created.

## 17. Checkout quote

`POST /api/v1/checkout/quote` (`CheckoutService.quote`) is a **read-only** preview: given a cart
token, destination country, and a `shippingRateId`, it returns the same live-priced item breakdown
as the cart (`items`, `subtotal`, `discountTotal`, `coupon`/`couponWarning`) plus `shippingTotal` and
`total`, and an `issues` array listing any cart line that is currently unavailable (out of stock,
unpublished) without failing the whole quote - the customer can still see a total for what *is*
available. It performs no writes and reserves nothing; it exists so the client can show an accurate
total (including shipping) before the customer commits to placing an order, and so
`POST /orders`'s `expectedTotal` field has something authoritative to have been shown to the
customer moments earlier.

## 18. Order creation (checkout)

`POST /api/v1/orders` (`OrdersService.createOrder`) converts an `ACTIVE` guest cart into an `Order`.
Every check re-validates against **live** state, never anything the client sent or cached:

1. **Idempotency.** The client supplies an `idempotencyKey`. If an order already exists for that
   key: same request body (compared by hash) → return the existing order unchanged (`201`, safe to
   retry after a dropped connection); different body → `409 IDEMPOTENCY_KEY_REUSED`.
2. **Cart state.** The cart must exist and be `ACTIVE`. A cart already converted to an order
   (`status: ORDERED`) is rejected with `409 CART_ALREADY_ORDERED` - this is what stops a customer
   (or a buggy client retry with a *new* idempotency key) from double-checking-out the same cart.
3. **Non-empty, fully available.** An empty cart is `400`. Any unavailable line (stock ran out,
   product unpublished since it was added) rejects the whole order with
   `409 ITEMS_UNAVAILABLE` and the offending items in `details` - checkout does not silently drop
   unavailable lines and charge for the rest.
4. **Shipping.** The destination/rate pair is re-resolved server-side (§16); an unsupported
   destination is rejected the same way the quote endpoint rejects it.
5. **Price agreement.** The server recomputes `subtotal + discount + shipping` and compares it to
   the client-supplied `expectedTotal` (which should be whatever `POST /checkout/quote` last
   returned). A mismatch - prices changed between quote and checkout - is `409 PRICE_CHANGED` with
   the fresh totals in `details`, so the client can re-confirm rather than the order silently going
   through at a different total than what the customer saw.
6. **Everything else - coupon usage, stock reservation, order+snapshot rows, marking the cart
   `ORDERED` - happens in one database transaction** (§19-20): either the customer gets a
   fully-formed order with its stock genuinely held, or nothing happens at all.

Guest identity is just the fields on the order itself (`customerFullName`, `customerPhone`,
`customerEmail?`, shipping address) - there is no guest account. `customerPhone` is normalized
(Arabic-Indic digits → Western digits, Egypt-specific format validation, see
`src/common/utils/phone.util.ts`) before being stored; the normalization rule for countries other
than Egypt is documented as a known limitation directly in that file, not silently assumed correct.

## 19. Coupon usage: reserved at order creation, released only if unpaid and cancelled

**Decision: `Coupon.usageCount` is a *reservation* against the limit, made at order creation, not at
payment.** The atomic conditional UPDATE (`WHERE "usageLimit" IS NULL OR "usageCount" <
"usageLimit"`) runs inside the same transaction that creates the order - so two concurrent checkouts
racing for the last use of a `usageLimit: 1` coupon can never both succeed (one gets
`409 COUPON_USAGE_LIMIT_REACHED`), regardless of whether either order is ever paid.

Release rule: if an order is cancelled **and** its `paymentStatus` never reached `PAID`, its
coupon's `usageCount` is decremented back (`couponUsageReleased` flags this so it can only ever
happen once per order, whether the cancellation came from a staff action or the automatic expiry
sweep - see §21). If an order had already been marked `PAID` before cancellation, its coupon usage
is **not** released - payment having been confirmed means the coupon did its job; a post-payment
cancellation is a refund/return concern, not proof the coupon slot was never really used.

## 20. Order status: two independent state machines

`fulfillmentStatus` and `paymentStatus` are deliberately separate columns, each with its own
transition table enforced in `OrdersService` (`FULFILLMENT_TRANSITIONS`, `PAYMENT_TRANSITIONS`) -
there is no code path that writes either column outside `updateFulfillmentStatus`/
`updatePaymentStatus`, so "enforce transitions via dedicated operations only" holds structurally, not
just by convention.

```
Fulfillment:  PENDING → CONFIRMED → PREPARING → SHIPPED → DELIVERED
                 │           │           │
                 └────────── CANCELLED ──┘        (no path out of CANCELLED;
                                                    no path back once SHIPPED)

Payment:      UNPAID → PENDING ─┐
                 │              ├─→ PAID → PARTIALLY_REFUNDED → REFUNDED
                 └──→ FAILED ───┘             (FAILED can retry to PENDING/PAID)
```

Side effects tied to specific transitions:

- **→ CONFIRMED**: pins the order's active reservation(s) against the TTL expiry sweep (§10 in
  DATA_MODEL.md, §21 below).
- **→ CANCELLED**: releases any still-`ACTIVE` reservation for the order, and releases coupon usage
  per §19.
- **→ PAID**: atomically *consumes* every `ACTIVE` reservation for the order (real stock decrement).
  If any reservation is no longer `ACTIVE` at that moment (already expired/released - a race between
  a late payment confirmation and the expiry sweep), the whole transaction, including the
  `paymentStatus` write, rolls back - an order is never marked `PAID` while failing to actually hold
  the stock it's being paid for.
- **A `CANCELLED` order can never be moved to any `paymentStatus` other than what it already had** -
  `updatePaymentStatus` explicitly rejects (`409 INVALID_STATE_TRANSITION`) any attempt to change
  payment status on a cancelled order. Without this, marking a cancelled order `PAID` would "succeed"
  vacuously (there are no reservations left to consume) while implying stock was held for it, which
  was never true.

`PATCH /admin/orders/:id/fulfillment-status` is `OWNER_ADMIN`/`ORDER_OPERATOR`.
`PATCH /admin/orders/:id/payment-status` is `OWNER_ADMIN` only (a financial action) - see the
updated roles table in §8's spirit; `ORDER_OPERATOR` can move an order through fulfillment but
cannot mark anything paid or refunded.

## 21. Reservation expiry is automatic, bounded, and safe under downtime

A `@nestjs/schedule` `@Interval(60_000)` job (`OrderExpiryScheduler`, disabled under
`NODE_ENV=test`) calls `OrderExpiryService.sweepAndCancel` every minute:

1. `ReservationsService.releaseAllExpired(limit=200)` atomically releases every `ACTIVE`
   reservation whose `expiresAt` has passed (bounded per tick so one sweep can't run unboundedly
   long on a large backlog), using the same guarded conditional UPDATE as every other reservation
   state change - so a reservation is released **at most once** even if two sweep ticks somehow
   overlap (guarded against directly by an `isRunning` reentrancy flag on the scheduler, and
   defensively by the UPDATE's own `WHERE status = 'ACTIVE'` guard).
2. For every distinct order that had a reservation just released, `OrdersService.cancelDueToExpiry`
   is called - but it only actually cancels an order that is *still* `PENDING`/`UNPAID`. An order
   that was `CONFIRMED` (§20) never has an `ACTIVE` reservation matching `releaseAllExpired`'s query
   in the first place: confirming sets its reservation(s)' `expiresAt` to `NULL` ("does not expire"
   - see `docs/DATA_MODEL.md` §10), and the sweep's own filter (`expiresAt IS NOT NULL AND expiresAt
   < now()`) cannot match `NULL` by construction. `cancelDueToExpiry`'s own status re-check is still
   a second, independent line of defense, not the only one, against a confirmed/paid order ever
   losing its stock or status to an unrelated abandoned-cart timeout.
3. **Recovery after downtime requires no special handling.** Expiry is judged purely from the
   `expiresAt` timestamp already in the database, never an in-memory timer - if the process was down
   when a reservation's TTL passed, the very next tick (or a manual trigger,
   `POST /admin/orders/sweep-expired`) picks it up exactly as if it had run on time.

## 22. Payment scope: two confirmed manual methods, no payment gateway

No online payment gateway is integrated, and none is planned without a further decision - see
docs/DECISIONS.md. What IS confirmed and implemented: the customer picks exactly one of two manual
payment methods (`Order.paymentMethod`) at checkout:

- **`CASH_ON_DELIVERY`** - no proof required at order time. Behaves exactly as orders always have:
  `paymentStatus` starts `UNPAID`, and only an explicit `PATCH /admin/orders/:id/payment-status`
  action ever marks it `PAID` (e.g. once the courier collects payment on delivery).
- **`INSTAPAY_MANUAL`** - the customer transfers via InstaPay and uploads a screenshot as proof
  (§25). `paymentStatus` also starts, and stays, `UNPAID` - uploading a screenshot **never** marks
  anything `PAID` by itself; see §25 for exactly what changes.

`PAYMENT_METHOD` (env var) still gates whether `POST /orders` is reachable at all, independent of
which manual method the customer picks:

- `none` - `POST /orders` returns `503`, explicitly, rather than silently accepting an order nobody
  could pay for through either method.
- `manual` - the confirmed, production-valid setting: both manual methods above are accepted, no
  payment gateway involved.
- `mock_dev_only` - behaves like `manual`, kept for dev/test convenience; refused at startup if
  `NODE_ENV=production`, so a real deployment can never be left on the "simulation" name by mistake.

In every case, `OrdersService.createOrder` and every other order operation are fully implemented
and tested regardless of this gate (see `test/orders.e2e-spec.ts`) - the gate only affects the
public HTTP endpoint. There is still no code path anywhere that marks an order `PAID` from an
unauthenticated client request, a redirect, or the act of uploading a screenshot - `PATCH
/admin/orders/:id/payment-status` requires staff auth (`OWNER_ADMIN`) in every environment.

## 23. Not yet implemented (do not treat as working)

- **The "choose two eligible cases for a fixed total" bundle promotion**, and any coupon/bundle
  stacking policy - only a single, optional coupon per cart/order exists. Deliberately deferred; see
  docs/DECISIONS.md for the exact list of business decisions needed before it can be built.
- **A real online payment gateway** (card processing, webhooks, automatic capture, refund
  processing) - no provider is selected, and the two confirmed methods (§22) are both manual/
  offline by design. See docs/DECISIONS.md.
- **Automatic receipt verification** (OCR, amount/reference matching) - every InstaPay screenshot is
  reviewed by a human admin; see §25.

## 24. Sensitive credentials never appear in server logs

Guest order tracking (`GET /orders/track/:trackingToken`, §18) authenticates purely by the token in
the URL path - so the request URL itself is a credential and must never be written to a server log
verbatim, or anyone with log read access could use it to look up (and, since tracking returns full
order/address/phone details, read) that guest's order. `src/common/utils/log-redaction.util.ts`
replaces this segment with `[REDACTED]` before `LoggingInterceptor` (every request, success or
error) or `AllExceptionsFilter` (5xx errors) writes a log line - see docs/DECISIONS.md. The JSON
error response's own `path` field is deliberately left un-redacted: it only ever echoes the
request back to the same caller who sent it, which is not a log.

## 25. InstaPay manual payment: screenshot upload, review, and the confirmed customer flow

Confirmed flow (see docs/DECISIONS.md): the customer enters their details, picks
`CASH_ON_DELIVERY` or `INSTAPAY_MANUAL`. For InstaPay, the frontend shows transfer instructions and
the exact server-calculated total (from `POST /checkout/quote`) *before* the customer uploads
anything - the amount is never re-typed or client-supplied.

1. **Upload before submission.** `POST /cart/receipts` (cart-token guarded, cart must be `ACTIVE`)
   accepts one JPEG/PNG/WebP image (`RECEIPT_MAX_FILE_SIZE_BYTES`, default 5MB), decodes it with
   `sharp` to confirm it is a real image of that type and to read its true dimensions (never trusting
   the declared `Content-Type` or filename extension alone), stores it under a generated filename in
   a directory that is never registered as a public static route (`RECEIPT_LOCAL_DIR`, separate from
   `MEDIA_LOCAL_DIR`), and returns only an opaque `receiptId` - never a filesystem path. The upload is
   unattached (`orderId: null`) until an order claims it.
2. **Order creation.** `POST /orders` with `paymentMethod: "INSTAPAY_MANUAL"` requires `receiptId`
   (rejected with `400` if missing, and rejected if supplied alongside `CASH_ON_DELIVERY`).
   `OrdersService.createOrder` verifies the receipt belongs to this exact cart, is not expired, and
   is not already attached to a different order, then atomically claims it (`orderId: null` in the
   `WHERE` clause of the claiming `UPDATE`, the same conditional-UPDATE-race-guard pattern used
   everywhere else in this codebase) inside the same transaction that creates the order - so either
   the order and the attachment both commit, or neither does. `receiptId` is part of the hashed
   idempotency payload (§18), so retrying with the same key and the same receipt returns the original
   order rather than attempting to reclaim an already-attached receipt.
3. **Never auto-paid.** Attaching a receipt does not touch `Order.paymentStatus` at all - it stays
   `UNPAID` ("awaiting verification" is this exact state: `paymentMethod: INSTAPAY_MANUAL` +
   `paymentStatus: UNPAID` + a receipt with `status: PENDING_REVIEW`). Only the existing
   `PATCH /admin/orders/:id/payment-status {status: "PAID"}` (`OWNER_ADMIN` only, §20) ever marks it
   paid - the same action already used for cash orders. No new payment status was needed.
4. **Reservation deadline.** An `INSTAPAY_MANUAL` order's stock reservation uses
   `INSTAPAY_REVIEW_DEADLINE_MINUTES` (default 1440 = 24h) instead of `RESERVATION_TTL_MINUTES`
   (default 15) - long enough to cover the transfer-and-review window, not the short
   abandoned-checkout window cash orders use. Everything else about expiry (§21) is unchanged: if
   the deadline passes with no admin action, the same sweep releases the reservation and cancels the
   order, exactly as it would for any other `PENDING`/`UNPAID` order.
5. **Rejection.** `PATCH /admin/orders/:id/receipts/:receiptId/reject {reason}` (`OWNER_ADMIN` only,
   audited) sets that specific receipt's own `status` to `REJECTED` - a field on `PaymentReceipt`,
   deliberately separate from `Order.paymentStatus`, which does not change. Only a receipt currently
   `PENDING_REVIEW` can be rejected.
6. **Replacement.** `POST /cart/receipts/replace` (cart-token guarded) uploads and attaches a new
   receipt to the cart's existing order in one step - only allowed when that order is
   `INSTAPAY_MANUAL`, not `CANCELLED`, not yet `PAID`, and its most recent receipt is `REJECTED`.
   The original (rejected) receipt row is kept, not overwritten, so staff can see the full history.
   Replacement **never touches the stock reservation** - it does not extend, reset, or otherwise
   affect `expiresAt`, so repeated rejected uploads cannot be used to indefinitely hold stock.
7. **Late payment after cancellation.** If a transfer is discovered for an order that already
   expired/was cancelled, `PATCH /admin/orders/:id/flag-late-payment {note}` (`OWNER_ADMIN`, audited)
   records `latePaymentFlaggedAt`/`latePaymentNote` for manual reconciliation. It deliberately does
   **not** change `fulfillmentStatus` or `paymentStatus`, and does not re-reserve stock - restoring
   fulfillment automatically after the fact was explicitly out of scope; a human decides what to do
   (refund, or fulfil out-of-band if stock genuinely still allows it).

## 26. Receipt access: private storage, no access from an id alone

A receipt image is never served by the public product-media pipeline (`/uploads`, `MediaAsset`) -
it lives under a separate, non-public directory (`RECEIPT_LOCAL_DIR`) with no static route at all.
The only ways to read the bytes back are `GET /cart/receipts/:receiptId/file` (must present the
exact cart token that owns it) and `GET /admin/receipts/:receiptId/file` (must be authenticated
staff with `OWNER_ADMIN` or `ORDER_OPERATOR`) - **a receipt id or an order number alone grants
nothing** in either case; both endpoints re-check ownership/role on every request, the same
principle already applied to guest order tracking (§18) and cart access (docs/DECISIONS.md).
Uploads are also rate-limited (10/min per route) and capped per cart
(`RECEIPT_MAX_PENDING_PER_CART`, default 5 unattached uploads) independent of the account-wide
throttle default (120/min, see `app.module.ts`).

Unattached uploads expire after `RECEIPT_UNATTACHED_RETENTION_MINUTES` (default 120) - long enough
to survive a checkout retry - and are deleted by a scheduled sweep
(`ReceiptCleanupScheduler`, same `@Interval` pattern as the order-expiry sweep, §21).
**An attached receipt's `expiresAt` is cleared the moment it is attached**, so the cleanup query
(`orderId IS NULL AND expiresAt < now()`) can never match an attached receipt, by construction -
there is no code path that deletes a receipt still referenced by an order.
