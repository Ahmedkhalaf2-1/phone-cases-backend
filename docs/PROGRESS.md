# Progress

## Status: Phase 1, Phase 2, and Phase 3 (Orders) fully implemented and tested. Phase 4 underway.

Phase 2's two previously-deferred items (shipping, atomic cart variant replacement) are now done -
the only Phase 2/3 item still deliberately not built is the bundle promotion (see
docs/DECISIONS.md #23). Real payment provider integration remains out of scope pending a business
decision (docs/DECISIONS.md #22); the order pipeline itself is complete and tested independent of
that decision.

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
- The bundle promotion — see docs/DECISIONS.md #23.
- S3/production media storage — stubbed to fail loudly (`503`), not implemented (Phase 4).
- No "last remaining OWNER_ADMIN can't be deactivated by another admin" safeguard — only
  self-lockout is prevented today.
- Search is plain PostgreSQL `ILIKE`, not a dedicated search index — adequate at MVP scale per the
  brief's own guidance to start with Postgres and only add more if measured need justifies it.

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

## Next milestone: Phase 4

With Phases 1-3 complete, Phase 4 work proceeds on items that do not depend on the still-open
payment-provider decision:

1. Security review of the order/payment/coupon/reservation surfaces added in Phase 3 (the areas
   with the most concurrency and authorization-sensitive logic in the codebase so far).
2. Production media storage (S3) - currently a stub that fails loudly (`503`).
3. Operational readiness: deployment documentation, and re-confirming the scheduled expiry job's
   behavior under a real process manager (not just `nohup`/manual boot).
4. The bundle promotion, once the business decisions in docs/DECISIONS.md #23 are answered.
5. Real payment provider integration, once a provider (or a confirmed COD-only decision) is chosen -
   docs/DECISIONS.md #22.
