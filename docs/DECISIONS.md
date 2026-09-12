# Decisions and Assumptions

Chronological-ish log of non-obvious choices, the reasoning behind them, and open questions the
business owner still needs to answer. Update this file whenever a similar judgment call comes up.

## Open business decisions (blocking, but not blocking Phase 1 catalog work)

### 1. Inventory model: finished stock vs. print-on-demand

**Status: unresolved.** Section 6 of the brief describes two possible models:

- (A) Stock finished cases by design × phone model.
- (B) Print designs on shared blank cases after ordering.

These require different stock-deduction logic (one `StockItem` per variant vs. many variants
sharing one blank `StockItem`) and different reservation semantics at checkout. Per the brief's own
instruction ("If unknown, document the unresolved decision and continue catalog work"), Phase 1
proceeds with a data model that supports **either** answer (see `docs/DATA_MODEL.md` §4) but does
**not** implement reservations, movement history, or checkout-time stock consumption — those are
Phase 2 and genuinely depend on this answer. **Action needed before Phase 2 started:** confirm which
model (or a mix, per-product) applies. **Status update (Phase 3):** still unresolved as a business
question, but two related implementation ambiguities that *don't* depend on the answer are now
explicitly confirmed and documented directly on `ProductVariant.stockItemId` in
`prisma/schema.prisma`: (a) a variant with no linked `StockItem` is a deliberate "not stock-limited,
always available" business rule, not a placeholder to fix later; (b) multiple variants (including
variants of different `Product`s) may point at the same `StockItem` on purpose, with no uniqueness
constraint - this is what model (B) requires, and Phase 3's order creation aggregates such lines
into a single summed reservation per stock item (see `docs/DATA_MODEL.md` §10).

### 2. Payment provider

**Status: unresolved.** No payment integration exists. Cash-on-delivery is explicitly called out in
the brief as needing confirmation before enabling — with no provider decided yet, it stays entirely
out of scope, not merely "disabled by config." As of Phase 3, this is implemented as an explicit gate
(`PAYMENT_METHOD=none` in production) rather than a silent gap — see decision #22 below for exactly
what is and isn't blocked by it. **Action needed:** pick a provider (or confirm COD) before public
order acceptance can go live.

### 3. Should publishing require complete Arabic content?

**Status: assumption made, not enforced.** Publishing currently only requires ≥1 active variant
(see `docs/BUSINESS_RULES.md` §2). It does not check that `descriptionAr` is filled in. This seems
like the right default (a product can go live in English while Arabic copy catches up), but it's an
assumption, not a confirmed business rule — flag if wrong.

### 4. "One coupon use per anonymous shopper"

Not applicable yet (no coupons implemented), but flagging early per the brief's own warning: without
a verified identity strategy for guests, "one use per person" can only ever be approximate
(cookie/IP-based), and that limitation should be documented wherever coupons are eventually built,
not silently assumed to be reliable.

## Technical decisions

### 5. NestJS 11, not 12

At implementation time, `@nestjs/core@12.0.1` had just been published, but `@nestjs/throttler`
(latest `6.5.0`) only declared peer support up to `@nestjs/core@^11.0.0`, and using v12 would have
required `--legacy-peer-deps`. `@nestjs/swagger`, `@nestjs/jwt`, and `@nestjs/passport` all had
current v11-compatible releases with full peer-dependency support. Chose the newest fully-supported
line (v11.2.3) over blindly taking "latest" on a package whose own ecosystem hadn't caught up yet.
Revisit once `@nestjs/throttler` (and re-check the others) publish v12-compatible releases.

### 6. TypeScript pinned to 5.9.3, not the published "latest" 7.0.2

`typescript@7.0.2` (a from-scratch native/Go-based compiler port) was the npm `latest` tag at
implementation time. `ts-jest@29.4.12`'s own `peerDependencies` declare `typescript: ">=4.3 <7"` —
it explicitly does not support TS 7 yet. Since `ts-jest` is the test runner's transform, TS 7 was
not usable without breaking tests. Pinned to `5.9.3`, the newest release still inside that supported
range. Revisit once `ts-jest` (or a replacement test transform) confirms TS 7 support.

### 7. Prisma 7 driver adapters (`@prisma/adapter-pg`), not a `datasource.url` string

Prisma 7 removed `datasource.url` from `schema.prisma` entirely — the CLI now reads the connection
string from `prisma.config.ts`, and `PrismaClient` requires a driver adapter (or `accelerateUrl`)
passed to its constructor. This is a hard breaking change, not a style preference: `prisma generate`
fails validation (`P1012`) if `url` is present in the schema. See `prisma.config.ts` and
`src/prisma/prisma.service.ts`.

One subtlety worth flagging for future maintainers: the driver adapter must be constructed **after**
`ConfigModule` has loaded `.env` into `process.env` — building it at module-evaluation time (a
top-level `const adapter = new PrismaPg(...)` executed as an import side effect) reads
`process.env.DATABASE_URL` before it's populated and fails with a confusing
`SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string` error. `PrismaService` instead
builds the adapter inside its constructor from an injected `ConfigService`, which Nest only
instantiates after `ConfigModule` has already run.

Also: Prisma 7's driver-adapter error metadata shape for a unique-constraint violation (`P2002`)
differs from the classic engine's `meta.target` array — it nests the actual Postgres constraint name
under `meta.driverAdapterError.cause.constraint.index`. Code that needs to distinguish *which*
unique constraint fired (see `VariantsService`, which has two: SKU and the compound
product/model/case-type index) goes through `src/common/utils/prisma-error.util.ts` rather than
checking `meta.target` directly, so it works regardless of which shape a given Prisma version uses.

### 8. `@nestjs/config` pinned to `^4.0.4`, not `^12.0.0`

`@nestjs/config@12.0.0` (the current npm "latest" at implementation time) ships as a pure ESM
package (`"type": "module"` in its own `package.json`). Our compiled output and `ts-jest` transform
both target CommonJS (`"module": "commonjs"` in `tsconfig.json`, matching NestJS's own convention),
and Jest's CJS-mode `require()` cannot load a pure-ESM dependency directly on this Jest/Node
combination — every e2e test file failed to even load with "Must use import to load ES Module".
`@nestjs/config@4.0.4` is the newest version that still ships as CommonJS and explicitly declares
`@nestjs/common: ^10.0.0 || ^11.0.0` as a peer, matching our NestJS 11 stack.

### 9. Local dev ports moved off common defaults

Postgres (`5544`/`5545` instead of `5432`/`5433`) and the app itself (`3010` instead of `3000`) are
non-default in `docker-compose.yml` / `.env.example`, because this machine already runs unrelated
services on the usual ports (a native PostgreSQL install on `5432`, another project's containers on
`5433` and `3000`). Purely a local-dev convenience; production deployment can use whatever ports fit
its environment.

### 10. Global `ThrottlerGuard` is skipped when `NODE_ENV=test`

Rate limiting (`ThrottlerModule` + a per-route `@Throttle` on login) is a real feature meant to slow
down credential-stuffing attempts. The e2e test suite legitimately logs in far more than 5
times/minute across its scenarios; asserting *functional* behavior (role guards, catalog rules)
shouldn't be coupled to a rate-limit counter. `src/app.module.ts` conditionally skips registering
the global guard only when `NODE_ENV === 'test'` (set by `test/jest-setup-env.ts`, never by a real
deployment). An alternative — overriding the `APP_GUARD` provider from the test harness via
`TestingModuleBuilder.overrideProvider` — was tried first but did not suppress the 429s in practice
in this Nest/Throttler version combination; the env-gated registration is simpler and verified to
work.

### 11. Public catalog price/newest sorting uses a two-pass query, not a single SQL aggregation

`ProductsService.findPublicList` first fetches lightweight candidate rows (id + minimum matching
variant price) for **every** matching product, sorts/paginates that list in application memory, then
fetches full details only for the current page's ids. This avoids both a fragile raw-SQL aggregation
and genuine N+1 queries, but it does mean the first pass scans every matching product's variants
rather than letting the database do a bounded, indexed sort. Acceptable at MVP catalog sizes
(dozens to low thousands of products). If the catalog grows large enough for this to show up in
practice, revisit with either a materialized "effective price" column (maintained on variant
write) or a proper window-function query, and add the index that query needs.

### 12. Media production storage (S3) is a stub, not a real integration

`MEDIA_STORAGE_DRIVER=s3` is accepted by config validation (so the env var contract exists) but its
driver implementation (`UnavailableMediaStorageService`) always throws a clear `503`. The brief
places "production media integration" explicitly in Phase 4. Implementing S3 now, before a
provider/bucket/credentials setup exists to test against, would mean shipping unverified code —
worse than an honest "not implemented yet."

## Phase 2 decisions

### 13. Cart token stored as plaintext, not hashed

`Cart.token` is a 32-byte random value stored directly in a unique-indexed column, unlike
`RefreshToken.tokenHash` (staff sessions, hashed at rest). This is a deliberate difference in threat
model, not an oversight: a leaked staff refresh token grants admin/catalog-mutation access, while a
leaked cart token (Phase 2) grants access to an anonymous shopper's in-progress cart — no payment
data, no stored address yet, nothing more sensitive than "what someone was about to buy." If Phase 3
starts attaching customer PII (name, address, phone) to a cart/order before checkout completes,
revisit this — at that point the calculus changes and hashing (or moving to a signed, short-lived
token) becomes worth the added complexity.

### 14. Cart additions never reserve stock; only a soft, non-binding check exists

Section 6 of the brief is explicit: "Cart additions do not reserve stock by default." So
`CartService.addItem`/`updateItemQuantity` only *check* `onHand - reserved` at the moment of the
request and reject if the requested quantity exceeds it (`409 INSUFFICIENT_STOCK`) - they never call
`ReservationsService.reserve`. This means the check can be stale by the time checkout happens; that
is intentional, not a bug, and Phase 3's checkout step is required to call `reserve()` for real
before an order can be confirmed. Documented prominently in `docs/BUSINESS_RULES.md` §11 so nobody
mistakes the cart-time check for a guarantee.

### 15. `ReservationsService` is built and tested with no HTTP caller yet

Phase 2 implements the full reserve/release/consume/expire lifecycle
(`src/modules/inventory/reservations`) and tests it directly against the service (not through an
HTTP endpoint), because no checkout endpoint exists yet to call it from - that requires an `Order`
model (Phase 3). This is intentional sequencing, not an oversight: building the concurrency-safe
primitive first, independently verified, means Phase 3's checkout logic can call it with confidence
rather than needing to design and debug reservation semantics under checkout's own time pressure.

### 16. Coupon discount rounds down; `usageCount` is not atomically enforced yet

Percentage discounts are floored (`Math.floor`), never rounded to the nearest unit or up - always in
the merchant's favor, and it keeps `subtotal - discountTotal` exact with nothing fractional to
allocate later (relevant once Phase 3 needs to reverse a discount on a partial refund).

`Coupon.usageCount` exists in the schema but nothing increments it yet in Phase 2, since there is no
order-creation step to increment it *atomically* at (a naive read-then-increment from the cart
endpoints would let concurrent checkouts both slip through a `usageLimit: 1` coupon). Cart-time
coupon validation is explicitly documented as provisional; final enforcement is a Phase 3
responsibility, using the same conditional-UPDATE pattern as stock adjustment/reservation.

### 17. The bundle promotion and shipping zones were not built this pass

Both were in scope for "Phase 2 — Purchase rules" per `docs/SYSTEM_PLAN.md`, but were deliberately
deferred rather than rushed:

- The "choose two eligible cases for a fixed total" bundle promotion is the most complex, most
  business-decision-dependent piece of the pricing engine (how are groups formed past 2 items? are
  premium variants excluded by default? can it stack with a coupon?) and deserves its own focused
  pass once those questions are confirmed, not a guessed implementation bolted onto
  `CartPricingService` under time pressure.
- Shipping zones/rates have no current consumer - nothing in the app needs a shipping figure until
  Phase 3's checkout quote endpoint exists - so building the data model for it now would be building
  ahead of an actual requirement.

Both are called out explicitly in `docs/PROGRESS.md` so they read as a known gap, not a silent
scope cut.

## Phase 3 decisions

### 18. `CartTokenGuard` bug: checking cart status broke idempotent order retries

**Found via manual smoke testing, not a test.** The guard originally rejected any request where the
cart's status wasn't `ACTIVE` — reasonable-looking, but it meant that once a cart converted to
`ORDERED` (order creation succeeded), a client retrying `POST /orders` with the same idempotency key
(e.g. after a dropped connection, never having seen the `201`) would be rejected by the guard
itself, before ever reaching `OrdersService`'s idempotency short-circuit. Fixed: the guard now only
checks that the token maps to an existing cart at all; each `CartService` mutation
(`addItem`/`updateItemQuantity`/`replaceItemVariant`/`removeItem`/`applyCoupon`/`removeCoupon`)
checks `ACTIVE` itself and returns `409 CART_NOT_ACTIVE`. Verified by curl against a running
instance: idempotent retry now returns the same order; key-reuse-with-different-body still
correctly returns `409`; a mutation attempt on an ordered cart still correctly returns `409
CART_NOT_ACTIVE`.

### 19. Reservation TTL vs. confirmed orders: pinning, not a status check on the sweep

**A correctness gap found during test planning, before it shipped as a bug.** The original design
had the expiry sweep release any `ACTIVE` reservation past its `expiresAt`, full stop — with no
awareness of the order's fulfillment status. That means a `CONFIRMED`-but-unpaid order (e.g. staff
confirmed it same-day, but the customer's payment takes a few days to arrive) could silently lose
its stock hold to the same TTL meant only to reclaim abandoned, never-confirmed carts. Fixed by
**pinning**: on the transition to `CONFIRMED`, every `ACTIVE` reservation's `expiresAt` is pushed to
100 years in the future, in the same transaction as the status change (see
`docs/DATA_MODEL.md` §10, `docs/BUSINESS_RULES.md` §21). This means the expiry sweep's own query
(`status = 'ACTIVE' AND expiresAt < now()`) never even matches a confirmed order's reservation —
there's no separate "is this order confirmed?" branch needed inside the sweep itself. Verified both
in `test/orders.e2e-spec.ts` and by a live smoke test against a running instance (confirm an order,
run the manual sweep endpoint, verify `{releasedReservations: 0, cancelledOrders: 0}` and the
order/stock untouched).

One deliberate consequence: this only protects reservations whose `expiresAt` is never again reset
backward by anything else. Nothing in the codebase does that, so this is not a gap in practice — but
if a future feature ever needs to "un-confirm" an order back to `PENDING`, it would need to also
decide what `expiresAt` to restore (or re-run `reserve()` fresh), not just flip the status column.

### 20. Marking a `CANCELLED` order `PAID` is now explicitly rejected

**Found while writing the expiration-race test coverage, before it shipped.** A `PENDING`/`UNPAID`
order whose reservation expires is auto-cancelled by the sweep (§21 in BUSINESS_RULES.md), but its
`paymentStatus` stays `UNPAID` — the two state machines are intentionally independent. Without an
extra check, staff could later call `PATCH .../payment-status {status: PAID}` on that now-cancelled
order: since `paymentStatus` transitions are keyed only by the current `paymentStatus` (`UNPAID` →
`PAID` is normally allowed) and the order's reservation was already released (nothing `ACTIVE` left
to consume), the transition would "succeed" — silently marking payment received for an order that no
longer holds any stock. Fixed by rejecting any `payment-status` change on a `CANCELLED` order
outright (`409 INVALID_STATE_TRANSITION`). This is the one place fulfillment and payment status
deliberately cross-check each other; everywhere else they remain fully independent by design.

### 21. Shipping zone `countries` validation: case-insensitive input, normalized storage

**Found while re-running the full test suite after other Phase 3 fixes, before it shipped.** The
`CreateShippingZoneDto`/`UpdateShippingZoneDto` validator required each country code to already be
uppercase (`/^[A-Z]{2}$/`), while `ShippingService` separately normalizes every country code to
uppercase before persisting or comparing (`dto.countries.map(c => c.toUpperCase())`) — so the
service-level normalization was unreachable dead code; any admin typing a lowercase code (`"eg"`)
was rejected by validation before ever reaching it. Fixed the regex to accept either case
(`/^[A-Za-z]{2}$/`) and left the service's normalization as the single source of truth for the
stored/compared form.

### 22. Payment method gating (`PAYMENT_METHOD=none`/`mock_dev_only`)

No payment provider decision has been made (open decision #2). Rather than leave `POST /orders`
silently reachable and accepting orders nobody can ever pay for, or block all order-pipeline
development until that decision is made, `PAYMENT_METHOD` gates only the **public HTTP endpoint**:

- `none` (default, the only value ever valid when `NODE_ENV=production`) → `POST /orders` returns
  `503` with a clear message. `OrdersService` and every other order operation are otherwise fully
  implemented, tested (`test/orders.e2e-spec.ts`), and reachable via admin endpoints/tests — only
  the public "place an order" HTTP path is gated.
- `mock_dev_only` → unblocks the endpoint in development/test only (refused at config-validation
  startup if `NODE_ENV=production`) so the whole checkout→order→admin-confirm→admin-mark-paid
  pipeline can be exercised end-to-end without a real payment integration. This is a clearly-labeled
  simulation, not a payment method choice — no code path anywhere marks an order `PAID` except the
  `OWNER_ADMIN`-only admin endpoint; there is no client-facing "pay" action, redirect, or webhook.

**Action needed before production order acceptance:** pick a real payment provider (still open
decision #2) and either integrate it (marking `PAID` from a verified webhook/callback, not a raw
client request) or make an explicit, confirmed decision to launch cash-on-delivery-only — the brief
was explicit that COD needs its own confirmation before enabling, so it is not assumed here.

### 23. Bundle promotion: exact decisions still needed (deferred, not blocking)

The "choose two eligible cases for a fixed total" promotion remains unimplemented — it was already
deferred in Phase 2 (#17) and nothing in Phase 3's order/checkout work removes the need for these
answers before it can be built:

1. **Eligible variants** — which variants (all? a tagged subset? a specific collection?) can be
   combined into a bundle.
2. **Bundle price** — one fixed total regardless of which two eligible items are chosen, or does
   price vary by which pair (e.g. by their individual prices)?
3. **Repeatability** — can a cart contain multiple bundle instances (4 eligible items → 2 bundles),
   or is it a one-time offer per cart/order?
4. **Premium surcharges** — can a "premium" variant (higher base price) be included in a bundle with
   a surcharge on top of the fixed bundle price, or are premium variants excluded from bundles
   entirely?
5. **Coupon stacking** — can a cart-level coupon apply on top of a bundle price, and if so, against
   what base (the bundle's fixed total, or as if priced individually)?

Building any version of this without these five answers means guessing business rules under time
pressure and likely rebuilding it later — it is intentionally left as a distinct, focused piece of
future work rather than bolted onto `CartPricingService`/`OrdersService` speculatively. It does not
block any part of the standard (non-bundle) order flow, which is complete and tested independent of
it.

## Phase 4 — security review findings

### 24. Unbounded free-text fields on the public, unauthenticated order/coupon endpoints

**Found in a manual security pass at the start of Phase 4.** `CreateOrderDto` (`POST /orders`, no
auth) and `ApplyCouponDto` (`POST /cart/coupon`, cart-token only) validated string fields with only
a lower bound (`@MinLength`), never an upper one. Every one of these fields is persisted
permanently as part of an immutable order snapshot, and `idempotencyKey` specifically backs a
unique database index — so an anonymous caller could submit arbitrarily large values (up to
Express's default ~100KB JSON body cap) for `customerFullName`, `shippingAddressLine1/2`,
`idempotencyKey`, etc., bloating storage and that unique index with no legitimate purpose. Not
exploitable for injection (all values are already parameterized through Prisma), but a real
resource-abuse/hygiene gap on the most-exposed endpoint in the system. Fixed by adding sensible
`@MaxLength` bounds to every free-text field on both DTOs; re-ran the full order/cart/checkout/
shipping e2e suites afterward to confirm no legitimate value was rejected.
