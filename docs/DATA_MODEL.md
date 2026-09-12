# Data Model

Full source of truth is `prisma/schema.prisma`. This document explains the *why* behind it.

## 1. Product vs. Variant

A **Product** is a design/concept (e.g. "Space"). A **ProductVariant** is the purchasable SKU —
a specific combination of product, phone model, and case type (e.g. "Space + iPhone 15 +
Shock-Resistant"), with its own price, availability, and stock link.

This split exists because:

- The business sells the *same artwork* across many phone models and case types.
- Price, availability, and stock genuinely differ per combination.
- Only explicitly created combinations should be purchasable — we never generate the full
  cross-product of models × case types and assume they all make sense (e.g. a design might not
  fit a particular model's camera cutout, or a case type might not exist for a given model yet).

`ProductVariant.phoneModelId` and `ProductVariant.caseTypeId` are **nullable** so a plain
accessory (a charging cable, a screen protector with no phone-model dependency) can exist as its
own product+variant without inventing placeholder taxonomy rows. This is deliberate: the schema
does not (yet) have a generic "options" framework, per the instructions to avoid building one
prematurely. When a real need for accessory-specific options (e.g. color, length) shows up, extend
`ProductVariant` or add a narrowly-scoped table for that one need — don't generalize speculatively.

### Duplicate-combination prevention

```prisma
@@unique([productId, phoneModelId, caseTypeId], name: "uniq_product_model_case")
```

Postgres treats `NULL` as distinct for uniqueness purposes. This means the constraint fully
prevents duplicate (product, model, case type) combinations for phone cases, but does **not**
constrain rows where `phoneModelId` and/or `caseTypeId` are null (plain accessories). Those are
disambiguated by SKU uniqueness alone. If the business later needs multiple no-phone-model
variants of the same accessory (e.g. two colors), add an explicit discriminator column at that
point rather than relying on this constraint.

### Effective price

`ProductVariant.price` is the single, unambiguous source of truth for what a customer pays. It is
always present and always in integer minor units. `Product.basePrice` is optional and is only a
list-page reference/"starting at" hint — it is never used for a transaction. `compareAtPrice` on a
variant, if set, must be strictly greater than `price` (enforced in `VariantsService`) so it can
only represent a genuine "was" price, never a discount computed the other way around.

## 2. Taxonomy: PhoneBrand → PhoneModel, CaseType, Collection

- `PhoneBrand` → `PhoneModel` is a simple one-to-many (Apple → iPhone 15, iPhone 15 Pro, ...).
- `CaseType` is independent of brand/model (Shock-Resistant, Slim, ...).
- `Collection` is a merchandising grouping (e.g. "New Arrivals") attached to `Product` via the
  `ProductCollection` join table, independent of the model/case-type taxonomy.

All taxonomy tables share the same shape: `slug` (unique, public-routable identifier),
`nameEn`/`nameAr`, `displayOrder`, `isActive`. `isActive: false` hides a row from public listing
endpoints without deleting it (so historical references — once orders exist in Phase 3 — remain
intact).

## 3. Bilingual fields

Customer-facing text (`nameEn`/`nameAr`, `descriptionEn`/`descriptionAr`) is stored as **separate
columns**, not a JSON blob keyed by locale. This was chosen over a generic i18n table because:

- The set of supported languages (English, Arabic) is fixed and small for this MVP.
- Separate columns are directly indexable/searchable (`ILIKE` on `nameEn` or `nameAr`) and require
  no joins.
- A generic translations table would be premature generalization for two fixed languages.

**Write-time rule:** `nameEn` (and `descriptionEn` where present) is required; `nameAr` is required
on entities customers browse directly (products, taxonomy) but optional on secondary fields
(`descriptionAr`, `altTextAr`) so a draft can be created before translation work is done — bilingual
entry is deliberately not a barrier to creating a draft product; it *is* required to be meaningful
before publishing decisions, but the schema does not currently hard-block publishing on missing
Arabic descriptions (only on having zero active variants). If the business wants publish to require
Arabic content, that is a one-line addition to `ProductsService.transitionStatus` — flagged here as
an open product decision, not implemented speculatively.

**Read-time fallback rule** (`src/common/i18n/localized-field.ts`): given a requested locale, return
the matching language column; if Arabic was requested but is blank/missing, fall back to English.
English is therefore always a safe non-null read. This logic is centralized in one function
(`pickLocalized`) so behavior is consistent across every public controller.

**Stable identity:** every entity has a UUID primary key independent of any translated label, and a
separate `slug` for public routing. Renaming a product's display name never changes its `id` or
`slug` (changing the `slug` itself is a deliberate, separate admin action with its own uniqueness
check).

## 4. Inventory (unresolved business decision — see docs/DECISIONS.md)

The business model is not yet confirmed to be either:

- **(A) Stock finished cases** by design × model, or
- **(B) Print-on-demand** onto shared blank cases after ordering.

The schema is built to support either without rework:

```
StockItem (physical counter: sku, onHand, reserved)
  ↑ 0..n
ProductVariant.stockItemId
```

- Model (A): each variant gets its **own** `StockItem` (1:1 in practice).
- Model (B): many design variants (different `Product`s, same phone model + case shape) can point
  at the **same** blank `StockItem`, and printing happens after the order is placed.

`ProductVariant.stockItemId` is nullable — a variant with no linked stock item is treated as
"not stock-tracked" (always available) rather than "always out of stock". This is a deliberate MVP
simplification: it lets catalog work proceed before the inventory model is confirmed, without
implying false scarcity.

**What Phase 1 implements:** `StockItemsService.adjust` performs a single conditional
`UPDATE ... WHERE "onHand" + $delta >= 0` (raw SQL, see that file) so concurrent adjustments can
never drive the counter negative — a read-then-write check would not be safe here. It also now
records a `StockMovement` row in the same transaction (see below).

**What Phase 2 adds:** `StockReservation` and `StockMovement` (`src/modules/inventory/reservations`).

`StockReservation` is a soft, time-limited hold against a stock item's *available* quantity
(`onHand - reserved`) — created by `ReservationsService.reserve`, which increments `reserved` via
the same atomic-conditional-UPDATE pattern (`WHERE "onHand" - reserved >= $quantity`), never a
read-then-write. A reservation is later either:

- **released** (`RELEASED` or `EXPIRED` status) — decrements `reserved` back down, `onHand`
  untouched; or
- **consumed** (`CONSUMED` status) — decrements both `onHand` and `reserved` together, and writes a
  `StockMovement` row (`reason: "reservation_consumed"`) in the same transaction.

Expired reservations are swept lazily: every `reserve()` call first releases any expired `ACTIVE`
reservations on *that specific stock item*, so a stale hold from a background job that hasn't run
yet never blocks a legitimate new reservation. `ReservationsService.releaseAllExpired()` sweeps
*every* stock item's expired reservations at once — exposed today as a manual admin endpoint
(`POST /admin/stock-reservations/sweep-expired`); Phase 4 will call the same method from a cron.

`StockMovement` is an append-only ledger of every `onHand` change (manual adjustments, reservation
consumption, and eventually restocks/returns), each with a `reason`, an optional
`referenceType`/`referenceId` pointing at what caused it, and the acting staff member if any.

**Not yet wired up:** no HTTP endpoint calls `reserve`/`consume` yet — that requires a checkout flow
and an `Order` model, both Phase 3. `ReservationsService` is built and tested (see
`test/reservations.e2e-spec.ts`) ready for Phase 3 to call.

## 5. Media

`MediaAsset` is the physical file record (storage key, URL, mime type, size, dimensions, alt text,
uploader). `ProductMedia` and `VariantMedia` are join tables carrying `displayOrder` and
`isPrimary`, so the same uploaded asset could in principle be attached to multiple
products/variants without duplication.

Deleting a `MediaAsset` that is still referenced by a `ProductMedia`/`VariantMedia` row is blocked
at the database level (`onDelete: Restrict` on those join tables' `mediaAssetId` FK) — the API
surfaces this as a 400 asking the caller to detach it first (`MediaService.delete`).

## 6. Product publication states

```
DRAFT ---publish---> PUBLISHED ---archive---> ARCHIVED
  ^                                                |
  |------------------ reactivate (to DRAFT) -------|
```

See `docs/BUSINESS_RULES.md` for the full transition table and the rationale for forcing
`ARCHIVED → DRAFT` before re-publishing.

Published-product public endpoints (`GET /api/v1/products`, `GET /api/v1/products/:slug`) only
ever query `status = PUBLISHED` and never select `internalNotes`. Admin endpoints return all
statuses and include `internalNotes`.

## 7. Audit log

`AuditLog` is append-only from the application's point of view — no code path updates or deletes a
row. Every sensitive admin mutation (catalog changes, staff changes, stock adjustments, login)
writes one row via `AuditLogService.record`, which swallows its own failures (logs them) rather than
letting an audit-log write failure roll back the primary operation it's attached to.

## 8. Cart and Coupon (Phase 2)

`Cart` is looked up by its opaque `token` (a 32-byte random value), never by `id` alone — see
docs/DECISIONS.md for why the token is stored as plaintext here rather than hashed like a staff
`RefreshToken`. `CartItem` has a `@@unique([cartId, variantId])` constraint: adding an
already-in-cart variant again merges quantities (`CartService.addItem`) rather than creating a
second line for it.

A cart's total is **never stored** — it is recomputed from the live `ProductVariant.price` (and the
attached `Coupon`, if any) on every read by `CartPricingService.buildView`, which is a pure function
over already-loaded Prisma data (no DB calls of its own), making it directly unit-testable
(`cart-pricing.service.spec.ts`). This also means a cart's displayed total always reflects *today's*
prices — there is no persisted snapshot yet, because nothing has been purchased yet. Order snapshots
(Phase 3) are a different, deliberately immutable concept — see docs/BUSINESS_RULES.md.

`Coupon.value` is overloaded by `type`: integer minor units for `FIXED`, whole percentage points
(1-100) for `PERCENTAGE` — validated in `CouponsService`. `Coupon.usageCount` is incremented nowhere
yet in Phase 2 (there is no order-creation step to increment it atomically at) — see
docs/BUSINESS_RULES.md for why cart-time coupon validation is explicitly provisional.

`Cart.couponId` references `Coupon` with `onDelete: SetNull` — deleting a coupon a cart currently
references never breaks that cart; it just stops applying (and `CartPricingService` also
independently re-validates the coupon's date/spend/usage rules on every read, surfacing a
`couponWarning` rather than silently dropping the discount if it has become invalid since it was
applied).

## 9. Shipping (Phase 3)

`ShippingZone` (bilingual name, `countries: String[]`, `isActive`) groups the countries the store
ships to. `ShippingRate` belongs to exactly one zone and carries `price`, an optional
`freeShippingThreshold`, and estimated delivery days — all **demo values**, entered through the
admin API or seed data, never invented by application code (see `docs/DECISIONS.md`). A country not
covered by any active rate of any active zone is an unsupported destination: `ShippingService`
rejects it (`409 SHIPPING_RATE_NOT_AVAILABLE`) rather than silently picking a default rate.

Country codes are normalized to uppercase in `ShippingService` (`create`/`update`), and DTO
validation only checks the 2-letter *shape* case-insensitively — so admin input can be typed in
either case and is stored/compared consistently.

## 10. Orders (Phase 3)

`Order` is the immutable record of a completed checkout; `OrderItem` is its immutable per-line
snapshot. Every field a customer or staff member might need to see *as it was at the moment of
purchase* is copied onto these two tables at creation time — bilingual product/variant/case-type/
phone-model names, unit price, per-line discount, shipping rate name, coupon code — specifically so
that later catalog edits (a product rename, a price change, a coupon being deleted) can never alter
a placed order's numbers or displayed text. `OrdersService.createOrder` writes these snapshot
fields directly from the *live* catalog/cart state at the instant the order is created; nothing
about an `Order`/`OrderItem` row is ever recomputed from current catalog data afterward.

Two independent status columns, each with its own state machine (see `docs/BUSINESS_RULES.md`):
`fulfillmentStatus` (PENDING → CONFIRMED → PREPARING → SHIPPED → DELIVERED, with CANCELLED reachable
from the first three) and `paymentStatus` (UNPAID → PENDING/PAID/FAILED → PARTIALLY_REFUNDED →
REFUNDED). They are deliberately never merged into one enum — a shipped-but-unpaid order and a
paid-but-not-yet-shipped order are both real, valid states.

`Order.idempotencyKey` (client-generated, unique) plus `idempotencyRequestHash` (a SHA-256 of the
normalized request body, excluding the key itself) implement retry-safe order creation: replaying
the same key with the same body returns the original order; the same key with a *different* body is
rejected (`409 IDEMPOTENCY_KEY_REUSED`) rather than silently creating a second order or silently
returning the first order's data for a different request.

`Order.trackingToken` (32 random bytes, unique, plaintext-at-rest like `Cart.token` - see
docs/DECISIONS.md §13 for the threat-model reasoning) is the sole credential for guest order
tracking (`GET /orders/track/:trackingToken`) — deliberately not the sequential `sequenceNumber` or
the row `id`, so tracking one order never lets a guest enumerate or guess another customer's order.

### Stock reservation aggregation at order creation

Multiple `OrderItem`s (and the `CartItem`s they were created from) can point at variants that share
the same `StockItem` (see §4 - either two variants of the same design, or entirely different
designs printed on the same blank). `OrdersService.createOrder` groups cart lines by
`stockItemId` and calls `ReservationsService.reserveManyInTransaction` with the **summed** quantity
per stock item, producing exactly one `StockReservation` row per distinct stock item for that order
— not one per cart line. This matters for both correctness (the atomic reservation guard checks
availability once against the true combined demand) and for cancellation/consumption (releasing or
consuming an order's stock touches one row per stock item, not one per line).

### Reservation pinning on CONFIRMED

A `StockReservation`'s `expiresAt` is set at creation to `now + RESERVATION_TTL_MINUTES` (protecting
against an abandoned, never-confirmed order tying up stock forever). Once staff move an order's
`fulfillmentStatus` to `CONFIRMED`, `OrdersService.updateFulfillmentStatus` pushes every one of that
order's `ACTIVE` reservations' `expiresAt` out to a fixed point 100 years in the future, in the same
transaction as the status change. This takes the reservation out of reach of the TTL-based expiry
sweep entirely - only an explicit `consume()` (payment) or `release()` (cancellation) can resolve it
from then on. See `docs/BUSINESS_RULES.md` for why this exists and what it does *not* protect
against.
