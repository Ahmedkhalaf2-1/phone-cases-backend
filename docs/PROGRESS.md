# Progress

## Status: Phases 1-3 complete. Phase 4 (manual payment) complete. Phase 5 (correctness hardening, CMS, bundles, refunds) complete. Phase 5.1 (static-review follow-up) complete.

## Phase 5.1 — four findings from a static review of commit `eed8ea8`

All four confirmed real against the current code and fixed, with regression tests run against real
Postgres. Full detail in docs/DECISIONS.md #45-48 and docs/BUSINESS_RULES.md §33-37.

1. **Discount stacking could exceed the merchandise subtotal**, and `allocateDiscount` could
   over-allocate a single line beyond its own subtotal (a pre-existing, unrelated bug surfaced while
   fixing the first issue). Fixed: bundle discounts apply first, coupon computed on what's left;
   `allocateDiscount` now distributes its flooring remainder to lines with headroom instead of
   dumping it on the last line. Verified: `subtotal 20000, bundle 10000, 75% coupon -> total 2500`
   exactly, per-line `lineTotal >= 0` on every created order. Tests:
   `src/modules/orders/order-pricing.util.spec.ts`, `test/discount-stacking.e2e-spec.ts`.
2. **Overlapping active bundles could double-claim the same physical unit.** Fixed with a
   quantity-remaining count shared across every bundle processed in one pricing call, plus an
   explicit, deterministic bundle-ordering (`createdAt` then `id` ascending) that was previously
   unguaranteed by the database. Tests: `bundle-pricing.util.spec.ts`,
   `test/discount-stacking.e2e-spec.ts`.
3. **Order status mutations were not serialized against each other.** Payment confirmation,
   cancellation, and expiry each validated against a pre-transaction snapshot and guarded only their
   own column on write - concretely broken for `isUnlimitedStock` orders, which have no
   `StockReservation` row to incidentally serialize the operations. Fixed with an explicit
   `SELECT ... FOR UPDATE` order-row lock acquired first in every one of these transactions. Verified
   with a `raceOrderLockedOperations` test helper that deterministically controls which operation
   wins the lock and proves the other genuinely blocks (not just finishes fast) - 3 new scenarios in
   `test/order-concurrency.e2e-spec.ts`, plus one pre-existing test corrected (it was asserting an
   artifact of the bug, not real state-machine semantics).
4. **Simultaneous identical checkout retries could fail with `CART_ALREADY_ORDERED`** instead of
   returning the winning request's own order. Fixed by recognizing a matching cart+key+payload order
   when the atomic cart claim is lost, and the same recovery for the InstaPay receipt
   pre-validation race. Tests: 3 new scenarios in `test/order-concurrency.e2e-spec.ts` (COD,
   InstaPay with a shared receipt, and same-key-different-payload).
5. **The stock commitment check could be masked by one healthy reservation.** An order needing two
   different stock items, where only one still had coverage, incorrectly passed confirmation/payment.
   Fixed by aggregating required vs. covered quantity per `stockItemId` across all of an order's
   reservations, rather than just checking "is at least one reservation still active". No migration
   needed - `StockReservation` already had everything the check needs. Tests: 6 scenarios in the new
   `test/stock-commitment.e2e-spec.ts`.

**Verification performed:** `npx tsc --noEmit` clean; `npm run lint` clean; `npx nest build` clean;
full e2e suite (`npx jest --config ./test/jest-e2e.json --runInBand`) - **16 suites, 178 tests, all
passing**; full unit suite - 9 suites, 63 tests, all passing. No unrelated modules were touched.

Phase 2's two previously-deferred items (shipping, atomic cart variant replacement) are done. The
payment-provider question is resolved for **manual** payment (cash on delivery + InstaPay bank
transfer with an uploaded, admin-verified screenshot) - a real online payment gateway remains
explicitly out of scope, not a silent gap (docs/DECISIONS.md #2, #22). The bundle promotion,
previously deferred pending business decisions (docs/DECISIONS.md #17/#23), is now implemented as
Phase 5 work (docs/DECISIONS.md #43) - see the Phase 5 section below.

## Phase 5 — checkout/order concurrency correctness, storefront fixes, CMS, bundles, refunds

A focused correctness pass against a specific list of suspected findings, followed by three
previously-deferred features. Full detail in docs/DECISIONS.md #34-44 and docs/BUSINESS_RULES.md
§27-32; this section summarizes what changed and how it was verified.

**Checkout/order concurrency correctness** (all confirmed as real, pre-existing gaps and fixed):

- Idempotency now checks cart ownership and request-payload hash on both the initial lookup and the
  concurrent-insert (`P2002`) fallback path - a key reused by a different cart or a different
  payload is rejected, never silently handed someone else's order.
- Order creation atomically claims its cart (`UPDATE ... WHERE status = 'ACTIVE'`) as the actual
  concurrency gate, then re-reads and revalidates cart/price/stock/shipping/coupon state fresh
  INSIDE the transaction - never from a pre-transaction snapshot.
- A new `Order.reservationDeadline` field (migration `20260912104720_order_level_expiry_deadline`)
  drives auto-cancellation independent of any one `StockReservation` - so an order made entirely of
  `isUnlimitedStock` items is still correctly auto-cancelled, and `CASH_ON_DELIVERY` orders get NO
  default deadline (a submitted COD order is real and must not silently expire) unless an operator
  opts in via the new `COD_EXPIRY_MINUTES`. `RESERVATION_TTL_MINUTES` was removed (superseded).
- Reservation release now re-checks expiration atomically at release time
  (`releaseIfStillExpired`), so a reservation pinned by a concurrent `CONFIRMED` transition can never
  still be released; sweep counts now report only genuine transitions.
- Order/payment status transitions and receipt accept/reject are all now guarded conditional updates
  (`updateMany` + checked row count), returning `409 ORDER_STATE_CHANGED` on a lost race instead of
  silently overwriting a concurrent change. Two new, more precise error codes:
  `STOCK_RESERVATION_LOST` (confirming/paying an order whose tracked stock commitment disappeared)
  and `PAYMENT_NOT_CONFIRMED` (an unpaid InstaPay order can no longer reach `PREPARING`). Marking an
  order `PAID` now also atomically accepts its pending InstaPay receipt in the same transaction.
- Refresh-token rotation is now atomic (conditional `UPDATE ... WHERE revokedAt IS NULL` as the
  concurrency gate) - two concurrent refreshes of the same token can no longer both succeed.
- **Storefront fixes**: `?availableOnly=false` was silently read as `true` (a two-layer bug - naive
  JS boolean coercion, compounded by the global `ValidationPipe`'s implicit conversion running
  before any custom `@Transform` saw the original string) - fixed and covered by
  `test/catalog.e2e-spec.ts`. Public variant media was never queried at all (three separate,
  independently-incomplete Prisma includes) - consolidated and now exposed as a `thumbnail` field
  with product-image fallback, matching the same fix applied to cart-line thumbnails. Cart
  add/update availability checks now aggregate quantities across cart lines sharing a `StockItem`,
  matching what checkout already enforced atomically.
- **Reviewed and confirmed already correct, no change made**: COD stock-consumption timing (stock
  is already consumed only at the explicit `PAID` action, for both payment methods) and the
  order-creation price-reconfirmation contract (`expectedTotal`/`PRICE_CHANGED`, already sufficient
  once revalidation moved inside the transaction - no separate cart-content fingerprint was added;
  see docs/DECISIONS.md #34 for why).
- **Tests**: `test/order-concurrency.e2e-spec.ts` (new, 10 tests - idempotency/cart-ownership races,
  concurrent CONFIRMED-vs-CANCELLED races, COD/InstaPay deadline behavior, receipt
  accept/reject-then-pay consistency, lost-reservation manual-review requirement), one new test in
  `test/auth.e2e-spec.ts` (concurrent refresh race), `test/orders.e2e-spec.ts` updated for the new
  deadline/error-code behavior, new coverage in `test/cart.e2e-spec.ts` (shared-stock aggregation)
  and `test/catalog.e2e-spec.ts` (`availableOnly` parsing, accessory variants with no fabricated
  taxonomy).

**Homepage content and informational pages** (small, structured CMS - docs/BUSINESS_RULES.md §30):

- `HomepageSection` (typed `BANNER`/`PROMO_STRIP`, bilingual, optional media/link, `displayOrder`,
  `isEnabled` defaulting to `false`) and `Page` (unique slug, bilingual, `DRAFT`/`PUBLISHED`) - full
  admin CRUD plus public published/enabled-only read endpoints. Media deletion safety came for free
  by reusing the existing `MediaAsset`/`onDelete: Restrict` pattern. Seed data is explicitly marked
  `[DEMO CONTENT]`/`(demo)`, never presented as real policy. Migration
  `20260912114025_homepage_and_pages_cms`. Tests: `test/content.e2e-spec.ts` (10 tests).

**Two-item bundle promotions** (docs/BUSINESS_RULES.md §31, docs/DECISIONS.md #43):

- `BundlePromotion`/`BundleEligibleVariant`/`BundleInstance` - every one of the five business
  decisions previously blocking this (docs/DECISIONS.md #17/#23) is now explicit configuration:
  eligible variants, fixed total + per-variant surcharges, repeatability, coupon-stacking policy,
  validity dates. Refuses to enable a bundle until it is completely configured (real
  fixed total/currency, ≥2 eligible variants spanning ≥2 phone models when required). A pure,
  independently unit-tested `computeBundleInstances` function (11 tests,
  `bundle-pricing.util.spec.ts`) deterministically groups eligible units (largest-bucket-first
  pairing across phone models) and allocates each instance's discount exactly across its two units -
  the identical function is called from the cart view, the checkout quote, and order creation, so
  what a customer sees is exactly what they are charged. A bundle can never increase the payable
  total; misconfigured pairings are simply skipped. Order creation persists one `BundleInstance` row
  per applied pairing and splits a cart line across more than one `OrderItem` when only part of its
  quantity was bundled, so refunds have an exact record to work from. Migration
  `20260912115034_bundle_promotions`. Tests: `test/bundles.e2e-spec.ts` (8 tests, covering
  activation-readiness validation, cart/order pricing, coupon-stacking policy, and the
  never-increase-total guarantee).

**Minimal manual refund/return administration** (docs/BUSINESS_RULES.md §32, docs/DECISIONS.md #44):

- `Refund` (amount, currency, reason, staff actor, idempotency key) and `OrderItemReturn` (returned
  quantity, reason, staff actor) - two independent records, since a refund and a physical return are
  not always 1:1. `POST /admin/orders/:id/refunds` is now the ONLY path that can move
  `Order.paymentStatus` to `PARTIALLY_REFUNDED`/`REFUNDED` - the generic payment-status endpoint
  explicitly refuses both as a target (`400 USE_REFUNDS_ENDPOINT`), so the over-refund cap
  (`sum(refunds) <= order.total`, enforced under a `SELECT ... FOR UPDATE` row lock on the order)
  can never be bypassed. Restocking a returned item is a separate, explicit call to the pre-existing
  stock-adjustment endpoint - recording a return never touches `onHand` itself. **A genuine,
  unrelated bug found and fixed along the way**: `StockItemsService.adjust` was writing a hardcoded
  `'manual_adjustment'` literal into the `StockMovement.reason` column instead of the staff-supplied
  reason, which only ever reached the audit log - now fixed to persist the real reason onto the
  ledger row itself. Migration `20260912121743_manual_refunds_and_returns`. Tests:
  `test/refunds.e2e-spec.ts` (11 tests).

**Verification performed for this phase**: `npx tsc --noEmit` clean; `npm run lint` clean (zero
errors after two small, targeted fixes - one real `no-unsafe-assignment` in the new order-item
bundle-grouping code, one ESLint config gap for `no-unsafe-call` in e2e specs, consistent with the
existing supertest-body exemption already documented there); `npx nest build` clean; the full e2e
suite (`npx jest --config ./test/jest-e2e.json --runInBand`) - **14 suites, 160 tests, all passing**
- run once at the end given the number of cross-module changes, per the instruction not to repeat
the whole suite after every edit; the full unit suite (`npx jest --config ./package.json`) - 9
suites, 58 tests, all passing.

## Phase 4 — InstaPay manual payment and receipt uploads

Confirmed customer flow implemented end-to-end (see docs/BUSINESS_RULES.md §22/§25-26 for the full
rules, docs/DECISIONS.md #29-33 for the design choices):

- `Order.paymentMethod` (`CASH_ON_DELIVERY` | `INSTAPAY_MANUAL`) is now required on every order.
  Cash orders are unchanged. InstaPay orders require a `receiptId` referencing a screenshot already
  uploaded on the same cart.
- **Private receipt uploads**: `POST /cart/receipts` (cart-token guarded, `ACTIVE` cart only) -
  JPEG/PNG/WebP, size-limited and configurable (default 5MB), content/dimensions validated by
  actually decoding the file (`sharp`), stored under a generated filename in a directory that is
  never served publicly (separate from product-media `/uploads`). Rate-limited (10/min) and capped
  per cart (5 unattached uploads by default).
  Reused the existing local-storage-driver pattern (`MediaStorageDriver`) for a new, private-only
  `ReceiptStorageDriver`, and the same `MEDIA_STORAGE_DRIVER` config knob to select it.
- **Atomic attachment**: order creation validates receipt ownership (belongs to this cart, not
  expired, not already used by another order) and attaches it inside the *same* transaction as order
  creation and stock reservation, via the same conditional-UPDATE race-guard pattern used everywhere
  else in this codebase (coupon usage, stock reservations). `receiptId` is part of the hashed
  idempotency payload, so a retried request with the same key never double-attaches.
- **Never auto-paid**: uploading or attaching a screenshot never changes `paymentStatus`. The
  existing `PATCH /admin/orders/:id/payment-status` action (`OWNER_ADMIN` only) remains the one and
  only way an order is ever marked `PAID` - reused as-is, no new payment status was needed.
  "Awaiting verification" is simply `UNPAID` + a `PENDING_REVIEW` receipt.
  A new, distinct, audited admin action (`PATCH .../receipts/:receiptId/reject`) handles rejection
  without touching payment status; the owning guest can then submit replacement proof
  (`POST /cart/receipts/replace`), which never extends the stock reservation deadline.
- **InstaPay-appropriate reservation deadline**: a new `INSTAPAY_REVIEW_DEADLINE_MINUTES` (default
  24h) replaces the short default `RESERVATION_TTL_MINUTES` for InstaPay orders specifically, so a
  customer doesn't lose their stock hold mid-review. The existing expiry sweep (`docs/BUSINESS_RULES.md`
  §21) needed zero changes to also cover this correctly.
- **Late payment after cancellation**: a new, audited `flagLatePayment` admin action records a
  manual-reconciliation note on an already-cancelled order without restoring its status or stock -
  a human decides what to do next, exactly as required.
- **Access control**: a receipt's image is reachable only via
  `GET /cart/receipts/:id/file` (cart-token ownership check) or
  `GET /admin/receipts/:id/file` (staff role check) - never by id or order number alone, and never
  through the public product-media pipeline. Verified live against a running instance: the file is
  genuinely absent from the public `/uploads` static route (`404`), unauthenticated access is
  rejected (`401`), a foreign cart token is rejected (`404`), and the owning cart succeeds (`200`).
- **Cleanup**: unattached uploads expire (default 2h retention, configurable) and are swept by a
  new scheduled job (same `@Interval` pattern as the order-expiry sweep) - an attached receipt's
  `expiresAt` is cleared the moment it's attached, so it can never match the cleanup query, by
  construction. Verified with a dedicated test that an expired unattached upload is deleted while an
  attached one (and its file) survives the same sweep.
- **A genuine bug found and fixed while testing this feature**: NestJS's `FileInterceptor` already
  converts an oversized-file `MulterError` into its own `PayloadTooLargeException` (413) before any
  custom exception-filter logic runs - `AllExceptionsFilter`'s status-code map gained one entry
  (413 → `FILE_TOO_LARGE`) so this already-correct behavior also produces a clean, stable error code
  instead of the generic fallback. This also improves the pre-existing (untested) media-upload
  endpoint's behavior for the same case, at no extra cost.
- **Tests**: `test/payment-receipts.e2e-spec.ts` (25 tests) - valid InstaPay order with attached
  screenshot, cash order with none, missing/invalid/oversized/foreign-cart receipt rejection,
  unauthorized access (wrong cart, no auth, wrong staff role), upload never marks PAID, idempotent
  retry creates no duplicate order or attachment, cleanup preserves attached files, rejection and
  replacement flows (including the reservation-deadline-not-extended check), and late-payment
  reconciliation flagging. Existing order tests updated for the now-required `paymentMethod` field.
- No payment gateway, OCR/automatic verification, or customer notifications were added - explicitly
  out of scope for this pass (see docs/BUSINESS_RULES.md §23).

## Phase 4 — targeted verification pass (4 real gaps found and fixed)

A follow-up review verified four specific requirements directly against the running code rather
than trusting documentation or the existing test count. All four had a real, confirmed gap:

1. **Reservation expiry lifecycle** - the "100 years in the future" pinning value was a workaround,
   not an explicit lifecycle state. Replaced with `expiresAt: NULL` ("does not expire") - a real
   schema change (`StockReservation.expiresAt` is now nullable), not a renamed constant.
2. **Unlimited stock was implicit, not an explicit administrative choice** - a variant with no
   `StockItem` was silently treated as always available in three separate places (public catalog,
   cart pricing, and - the functional gate that actually let unlimited quantities into a cart -
   `CartService.assertSoftAvailability`, which is worse than the display-only bugs since it had no
   limit at all). Added `ProductVariant.isUnlimitedStock` (`@default(false)`, migration preserves
   all existing data, no row silently reclassified as unlimited) and fixed all three call sites.
3. **Order-creation reconfirmation on a changed quote** - checked and confirmed already correct
   (`PRICE_CHANGED`, `docs/BUSINESS_RULES.md` §18); no change needed.
4. **Guest tracking tokens were being written to server logs** - via the raw request URL, on every
   single tracking request (success or error). Fixed with an explicit URL-redaction utility, wired
   into both the request logger and the exception filter.

See `docs/DECISIONS.md` #25-28 for the full detail on each (what was found, how it was fixed, and
exactly how each fix was verified - unit tests, e2e tests, and live checks against a running
instance for the two most safety-critical items). Migration:
`20260912044837_phase4_explicit_stock_and_reservation_lifecycle`.

## Phase 3 — Orders — what's done

- **Shipping**: `ShippingZone`/`ShippingRate` admin CRUD, public rate lookup by country, a pure
  `computeShippingPrice(rate, basisAmount)` function with the free-shipping threshold explicitly
  keyed to the **post-discount** total. Unsupported destinations are rejected, never defaulted.
- **Atomic cart variant replacement**: `PATCH /cart/items/:itemId/variant` — validates and
  merges-or-moves in one transaction; the original line survives untouched if anything fails.
- **Checkout quote**: `POST /checkout/quote` — read-only preview of items/discount/shipping/total/
  currency/issues, used by the client before committing to `POST /orders`.
- **Order creation**: `POST /orders` — idempotent (retry-safe, rejects key-reuse-with-different-body),
  fully re-validates cart/stock/price/shipping/coupon against live state, aggregates cart lines that
  share a `StockItem` into one reservation, and does everything (coupon usage increment, order +
  immutable snapshot rows, stock reservation, marking the cart `ORDERED`) inside a single database
  transaction.
- **Order status**: two independent state machines (`fulfillmentStatus`, `paymentStatus`), each with
  an enforced transition table, admin-only mutation endpoints, and side effects on specific
  transitions (reservation pinning on `CONFIRMED`, reservation consumption + real stock decrement on
  `PAID`, reservation release + conditional coupon-usage release on `CANCELLED`).
- **Automatic reservation expiry**: a `@nestjs/schedule` job sweeps expired reservations every
  minute and auto-cancels any order that never progressed past `PENDING`/`UNPAID` - bounded,
  reentrancy-guarded, and correct after downtime (judged from a stored timestamp, not an in-memory
  timer). A confirmed order's reservation is pinned out of the sweep's reach entirely (see
  docs/DECISIONS.md #19) - not merely re-checked and spared at cancel time.
- **Secure guest order tracking**: `GET /orders/track/:trackingToken` - a random 32-byte token, not
  the sequential order number or row id, so tracking one order can never be used to enumerate
  others.
- **Payment scope kept deliberately incomplete**: `PAYMENT_METHOD` env gate (`none` in production,
  `mock_dev_only` in dev/test only) controls whether the public `POST /orders` endpoint is reachable
  at all; no payment provider is selected or integrated, and no code path marks an order `PAID`
  except an `OWNER_ADMIN`-only admin action. See docs/DECISIONS.md #22.
- **Two real bugs found and fixed via manual smoke-testing before they could ship**: `CartTokenGuard`
  was rejecting idempotent order retries (docs/DECISIONS.md #18), and marking a cancelled order
  "paid" was silently possible (docs/DECISIONS.md #20).
- **Tests**: `test/orders.e2e-spec.ts` (22 tests) - idempotency, price-changed/items-unavailable/
  cart-already-ordered rejection, shared-stock-aggregation into one reservation, concurrent-checkout
  race for the last unit of shared stock, concurrent coupon-usage-limit race, immutable snapshot
  survives a later product rename, fulfillment/payment transition enforcement, the
  confirm-pins-against-expiry behavior verified against a real sweep call, a genuinely-expired
  PENDING order being auto-cancelled with coupon usage released, admin role authorization per
  endpoint, secure guest tracking (correct token vs. a guessed one), and the `PAYMENT_METHOD=none`
  gate (built as its own isolated app instance via `jest.resetModules()`, since `ConfigModule`'s
  env validation is captured once at first import of `app.module.ts`). Plus `test/shipping.e2e-spec.ts`
  (6 tests) and `test/checkout.e2e-spec.ts` (4 tests).

## Phase 2 — what's done

- **Inventory reservations and movement history**: `StockReservation` (soft, time-limited hold
  against a stock item's available quantity) and `StockMovement` (append-only ledger of every
  onHand change, including the Phase 1 manual-adjustment endpoint, now retrofitted to write one).
  `ReservationsService` provides `reserve`/`release`/`consume`/`releaseAllExpired`, all built on the
  same atomic-conditional-UPDATE pattern as Phase 1's stock adjustment — verified safe under
  concurrent reservation attempts in `test/reservations.e2e-spec.ts`. Not yet wired to any checkout
  endpoint (there isn't one - that's Phase 3); it's ready for Phase 3 to call.
- **Guest cart**: opaque-token-based cart (`POST /api/v1/cart` issues the token; every other cart
  route requires it via the `X-Cart-Token` header, enforced by `CartTokenGuard`). Add/update/remove
  items, live-recalculated totals on every read, soft (non-binding) availability checks at
  add-time. Cart additions deliberately do **not** reserve stock (see docs/BUSINESS_RULES.md).
- **Server-side pricing engine**: `CartPricingService` computes line/subtotal/discount/total purely
  from the live variant price and an optional coupon - a client can never influence price. Coupon
  discount rounding (always down, in the merchant's favor) is a pure, directly unit-tested function.
- **Coupons**: `FIXED`/`PERCENTAGE` types, validity window, minimum spend, usage limit. Admin CRUD.
  Cart-time validation is explicitly provisional (documented) - atomic `usageCount` enforcement
  belongs at order creation (Phase 3), which doesn't exist yet.
- **Admin visibility**: `GET /admin/stock-items/:id/movements`, `GET /admin/stock-items/:id/reservations`,
  and a manual `POST /admin/stock-reservations/sweep-expired` (Phase 4 will add a cron calling the
  same service method on a timer).
- **Tests**: `test/cart.e2e-spec.ts` (access control, item add/merge/update/remove, insufficient-stock
  rejection, unpublished-variant rejection, coupon apply/reject/remove), `test/reservations.e2e-spec.ts`
  (reserve/release/consume lifecycle, idempotent release, invalid-transition rejection, expired-lazy-
  sweep-on-same-item, cross-item `releaseAllExpired`, concurrent reservation safety), and a pure unit
  test suite for the discount/coupon-validity functions.

## Phase 2 — deliberately not yet done (documented, not silently dropped)

- **The "choose two eligible cases for a fixed total" bundle promotion** - the single-coupon pricing
  engine does not yet support bundle-style promotions. This is the most speculative/complex piece of
  the pricing engine and remains deferred rather than rushed; `CartPricingService.buildView` is the
  place to extend once the five business decisions in docs/DECISIONS.md #23 are answered. This is
  the only originally-scoped Phase 2/3 item still not implemented.

Shipping zones/rates, the checkout quote endpoint, atomic cart variant replacement, and wiring
`ReservationsService` into a real checkout flow were all completed in Phase 3 - see the Phase 3
section above.

## Phase 1 — what's done

- **Repository foundation**: NestJS 11 + TypeScript strict + Prisma 7 (driver adapters) +
  PostgreSQL 16, Docker Compose for local dev/test databases, validated environment configuration
  (`src/config/env.validation.ts`, fails fast on missing/invalid env vars), global exception filter
  with stable error codes, request-id correlation, redacted request logging, Helmet, CORS allowlist,
  rate limiting on login.
- **Staff auth**: JWT access tokens (15m default) + opaque rotating refresh tokens (7d default,
  hashed at rest, single-use — reuse of a rotated token is rejected), login/refresh/logout/me
  endpoints, role-based guards (`OWNER_ADMIN`, `CATALOG_MANAGER`, `ORDER_OPERATOR`).
- **Staff management**: admin CRUD (`OWNER_ADMIN` only), self-lockout prevention (can't deactivate
  or re-role your own account).
- **Catalog domain**: phone brands, phone models, case types, collections, products, variants —
  full admin CRUD plus public read endpoints, all wired through Prisma with real DB constraints
  (unique slugs/SKUs, the product+model+case-type uniqueness rule, FK integrity).
- **Product lifecycle**: DRAFT/PUBLISHED/ARCHIVED with an explicit, tested transition table;
  publishing requires ≥1 active variant.
- **Public storefront API**: browse/search/filter (collection, phone model, case type, price range,
  availability)/sort (newest, price asc/desc)/paginate products; bilingual (en/ar) responses with a
  documented fallback rule; effective per-variant pricing and compatibility info so a frontend never
  has to duplicate pricing logic.
- **Media**: upload with MIME allowlist + real image decoding validation (not just trusting
  `Content-Type`), local disk storage driver (dev), pluggable storage interface for a future S3
  driver, attach/detach to products and variants, safe-delete (blocked while referenced).
- **Inventory (partial, by design)**: `StockItem` counters with a concurrency-safe atomic
  adjustment endpoint (raw conditional `UPDATE` — verified under 20 concurrent requests in
  `test/inventory.e2e-spec.ts`). Reservations and movement history are explicitly Phase 2 — see
  `docs/DECISIONS.md`.
- **Audit log**: append-only log of sensitive admin actions (catalog changes, staff changes, stock
  adjustments, logins), with an admin-only read endpoint.
- **OpenAPI docs**: full Swagger UI at `/api/docs`, generated from decorators.
- **Seed data**: bootstrap `OWNER_ADMIN` account, sample brands/models/case types/collection, one
  published product with multiple variants, one draft product (to demonstrate visibility rules).
- **Tests**: integration tests against a real Postgres test database covering — unauthenticated
  admin access is rejected; role guard enforcement; draft products hidden from public
  endpoints/visible to staff; publish requires an active variant; invalid status transitions
  rejected; duplicate slug/SKU/combination conflicts return distinct error codes; compareAtPrice
  validation; phone-model filtering; refresh-token rotation and reuse rejection; logout revocation;
  deactivated-staff lockout; self-lockout prevention; concurrent stock adjustments never oversell.

## Verified manually (in addition to automated tests)

Full request/response cycle exercised by hand against a running instance: login, admin product +
variant creation, public product listing/detail with bilingual output, role-guard denial, media
upload (valid and invalid files) with static file serving, stock item creation/adjustment, audit
log listing. Phase 3, against a fresh `nest build` + `node dist/main.js` boot on the dev database
(not just under Jest): full guest checkout → order creation → admin login → confirm → manual
expiry-sweep trigger, confirming the confirmed order's reservation and status were untouched by the
sweep (`{releasedReservations: 0, cancelledOrders: 0}`). See the session transcript for exact
requests/responses if needed.

## Known gaps / explicitly out of scope

- Real payment provider integration — see Phase 3 section and docs/DECISIONS.md #22.
- S3/production media storage — stubbed to fail loudly (`503`), not implemented (Phase 4).
- No "last remaining OWNER_ADMIN can't be deactivated by another admin" safeguard — only
  self-lockout is prevented today.
- Search is plain PostgreSQL `ILIKE`, not a dedicated search index — adequate at MVP scale per the
  brief's own guidance to start with Postgres and only add more if measured need justifies it.
- No customer-facing refund/return request flow — Phase 5's refund/return administration (§ above)
  is staff-only, initiated entirely from the admin side.
- Automatic receipt verification (OCR, amount/reference matching) — every InstaPay screenshot is
  still reviewed by a human admin; see docs/BUSINESS_RULES.md §25.

## Environment/tooling notes worth knowing before continuing this project

- The host machine had other projects' Postgres/Docker services already using the default ports —
  this repo's `docker-compose.yml` and `.env.example` intentionally use `5544`/`5545`/`3010`
  instead of `5432`/`5433`/`3000`. Not a code requirement, just this environment.
- Prisma 7's incremental TypeScript build cache (`tsconfig.build.tsbuildinfo`) is now configured to
  live under `dist/` (`tsBuildInfoFile` in `tsconfig.json`) specifically so `rm -rf dist` always
  fully resets it — a stale root-level tsbuildinfo file previously caused `nest build` to silently
  report success while emitting nothing.
- See `docs/DECISIONS.md` for why specific package versions are pinned (NestJS 11 not 12,
  TypeScript 5.9 not 7, `@nestjs/config` 4.x not 12.x) — these aren't arbitrary and shouldn't be
  "corrected" to latest without re-checking the ecosystem compatibility notes there.

## Phase 4 status

1. **Security review** - done, twice: a manual pass over the order/payment/coupon/reservation
   surfaces found and fixed 4 real gaps (docs/DECISIONS.md #25-28), and a second pass over the new
   receipt-upload surface (multipart handling, private storage, file streaming) found and fixed one
   more (a missing-file upload returning `500` instead of `400`) - see docs/DECISIONS.md.
2. **Production media storage (S3)** - still a stub that fails loudly (`503`), for both public media
   and (as of the receipts work) private receipts too. Not implemented without real S3 credentials
   to verify against - see docs/DECISIONS.md #12. **Still open.**
3. **Operational readiness** - `docs/DEPLOYMENT.md` now covers the production env checklist,
   process-management options, file-storage persistence requirements, backups, and health/readiness
   endpoints. It also documents a real architectural limitation surfaced by this review: the two
   `@nestjs/schedule` interval jobs (order expiry, receipt cleanup) assume a single running
   instance - correctness is never at risk (every state change goes through the same atomic
   conditional-UPDATE guards used everywhere else), but a multi-instance deployment would run each
   sweep redundantly on every instance. Recommended: one instance until a distributed-lock or
   external-cron approach is built. **Documented; the distributed-scheduling work itself is a
   separate, not-yet-started item.**
4. **Bundle promotion** - the five business decisions in docs/DECISIONS.md #23 are now answered as
   explicit configuration and the feature is implemented (Phase 5, docs/DECISIONS.md #43). **Done.**
5. **Payment provider** - resolved for manual payment (cash on delivery + InstaPay manual with an
   admin-verified screenshot, docs/DECISIONS.md #2/#29-33). A real online payment gateway remains
   out of scope, not a silent gap. **Manual methods done; gateway integration still open.**

## Focused follow-up to 751ab8d

- Locked order reservations before coverage checks, keeping standalone/lazy expiry from
  releasing stock between validation and confirmation/payment.
- Restricted cancellation coupon release to UNPAID/PENDING/FAILED; refunded orders retain usage.
- No migrations or API changes. Verification: Prisma client generation, `tsc --noEmit`,
  `nest build`, and `git diff --check` passed. No tests added or run, as requested by the owner;
  runtime concurrency behavior was not independently exercised in this follow-up.

## Next milestone

With Phase 5's correctness hardening, CMS, bundle promotions, and manual refund/return
administration now complete (see the Phase 5 section above), the remaining open items are either
blocked by an infrastructure dependency this environment can't provide (S3 credentials to test a
real driver against) or by a business decision not yet made (a real payment gateway - the two
manual methods are complete and are the confirmed, final scope unless that decision changes). The
next concrete, unblocked engineering item is the distributed-scheduling work implied by Phase 4 §3
above, if/when this deployment needs more than one instance.
