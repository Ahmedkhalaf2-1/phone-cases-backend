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

**Status: RESOLVED for manual methods; still no online gateway.** Cash-on-delivery was explicitly
called out as needing confirmation before enabling - it is now confirmed, alongside a second manual
method: InstaPay bank transfer with a customer-uploaded screenshot, verified by a human admin (see
decision #29 and `docs/BUSINESS_RULES.md` §22/§25 for the full implementation). No online payment
gateway (card processing, automatic capture, webhooks) is selected or integrated, and none is
planned without a further decision - this remains explicitly out of scope, not a silent gap.

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
**pinning**: on the transition to `CONFIRMED`, every `ACTIVE` reservation is taken out of reach of
the expiry sweep in the same transaction as the status change.

**Superseded by #25 below.** The first version of this fix pinned by setting `expiresAt` to a fixed
point 100 years in the future — a workaround that happened to work (the sweep's `expiresAt < now()`
check would never match it in practice) but modeled "does not expire" as a magic timestamp instead
of an explicit state, which a later verification pass flagged as exactly the kind of undocumented
hack that shouldn't ship. #25 replaces it with `expiresAt: NULL` as the real, explicit
"never expires" value. The correctness property this section describes (the sweep's own query can
never match a confirmed order's reservation, with no separate "is this order confirmed?" branch
needed) still holds — only the mechanism changed.

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

**Superseded by #42-43.** All five questions above are now answered as CONFIGURATION (not hardcoded
business rules): eligible variants are an explicit per-bundle list; the price is one fixed total
plus explicit optional per-variant surcharges; repeatability is an explicit flag; premium variants
are explicitly opted in with a surcharge rather than excluded; coupon stacking is an explicit
per-bundle boolean. A real bundle still cannot go live until an owner actually fills in these values
and enables it (see #43) - this entry is kept for history, not because the gap is still open.

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

## Phase 4 — targeted verification pass findings

A follow-up review was asked to verify four specific requirements directly against the code (not
inferred from documentation or the existing test count): whether the 100-year reservation-expiry
value had been replaced with an explicit lifecycle; whether a stockless variant was still
purchasable indefinitely without an explicit administrative choice; whether order creation still
required reconfirmation on a changed quote; and whether guest tracking tokens were redacted from
logs including request URLs. All four gaps below were real, found by reading the actual
implementation, and fixed with regression tests before this commit.

### 25. Replaced the 100-year reservation-expiry value with an explicit `expiresAt: NULL` state

Confirmed present in code (`orders.service.ts`'s `PINNED_RESERVATION_EXPIRY()`, adding 100 years to
`new Date()`) - this was flagged in #19 above as a workaround, not a design, and the verification
pass treated it as a real outstanding item rather than something the earlier "verified live" note
excused. `StockReservation.expiresAt` is now `DateTime?` (migration
`20260912044837_phase4_explicit_stock_and_reservation_lifecycle`, applied to both dev and test
databases, no data reset - existing non-null `expiresAt` values were left untouched by the
migration). `NULL` is the explicit "does not expire" state:
`ReservationsService.pinActiveForOrderInTransaction` sets it on the transition to `CONFIRMED`
(replacing the inline far-future-date `updateMany` that used to live in `OrdersService`), and
`releaseAllExpired`/the lazy per-stock-item sweep both filter `expiresAt: { not: null, lt: new
Date() }`, so a pinned reservation can never match by construction - no behavior change from #19's
correctness property, only the mechanism. Verified: a new e2e test in
`test/reservations.e2e-spec.ts` (`pinActiveForOrderInTransaction sets expiresAt to null...`) creates
an already-expired reservation, pins it, and confirms `releaseAllExpired()` leaves it untouched;
`test/orders.e2e-spec.ts`'s existing CONFIRMED-protection test now asserts `expiresAt` is `null`
directly (previously asserted a far-future year, which no longer applies); and a live run against
the dev database (`psql` query against `stock_reservations.expiresAt` immediately after confirming
a real order) showed the column genuinely `NULL`, not a future date.

### 26. `ProductVariant.isUnlimitedStock`: the missing explicit administrative choice for stockless variants

Confirmed present in code before this fix: `product-response.mapper.ts`'s `isVariantAvailable`
returned `true` unconditionally whenever `!variant.stockItem`, `CartPricingService`'s `hasStock`
did the same, and - the most consequential of the three, since it's a functional gate rather than a
display flag - `CartService.assertSoftAvailability` took `if (!stockItem) return;`, meaning a
stockless variant could be added to a cart in **any quantity**, with no limit at all, regardless of
what the catalog display claimed. None of the three consulted anything resembling an explicit
opt-in; "no `StockItem` linked" was silently read as "unlimited," exactly what this verification
pass was asked to confirm was not the case. Fixed by adding `ProductVariant.isUnlimitedStock
Boolean @default(false)` (same migration as #25) and updating all three call sites to require it
when `stockItemId` is null. `VariantsService` also now rejects (`400`) setting `isUnlimitedStock:
true` together with a `stockItemId`, so the two flags can never contradict each other.

**Preserving existing data without silently granting unlimited stock:** the migration adds the
column with `DEFAULT false` for every existing row (no variant needed deleting, resetting, or
guessed-at reclassification) - which means every pre-existing stockless variant (the demo seed
catalog included) became correctly "not purchasable" the moment this shipped, until explicitly
opted back in. Seed data (`prisma/seed.ts`) was updated to set `isUnlimitedStock: true` explicitly
on its demo variants, as the deliberate administrative choice a real admin would make for a
catalog of untracked/demo items - not a code-level default reinstating the old behavior. Several
existing e2e test fixtures (`test/cart.e2e-spec.ts`, `test/checkout.e2e-spec.ts`,
`test/orders.e2e-spec.ts`, `test/catalog.e2e-spec.ts`) that create stockless variants purely to test
unrelated cart/checkout/order mechanics were updated the same way, each with a comment explaining
why. A new dedicated file, `test/stock-availability.e2e-spec.ts`, covers the feature itself
end-to-end: the database default is `false`; the admin API rejects the contradictory combination; a
non-opted-in stockless variant is unavailable in the public catalog AND rejected when added to a
cart (`409 INSUFFICIENT_STOCK`); an explicitly opted-in one is available and can be fully checked
out into an order with zero stock reservations created (correctly - there is nothing to reserve).

### 27. Order-creation reconfirmation on a changed quote: verified already correct, no change needed

`OrdersService.createOrder` already compares the server-recomputed
`subtotal + discountTotal + shippingTotal` against the client-supplied `expectedTotal` and rejects
a mismatch with `409 PRICE_CHANGED` plus the fresh totals (unchanged by this verification pass -
see `docs/BUSINESS_RULES.md` §18 point 5). Re-ran
`test/orders.e2e-spec.ts`'s `rejects a mismatched expectedTotal with PRICE_CHANGED...` test in
isolation to confirm it still passes against current code, rather than trusting its presence in the
file as proof - it does.

### 28. Guest tracking tokens were being written to server logs via the raw request URL

Confirmed present in code before this fix: `LoggingInterceptor` logged
`` `${request.method} ${request.originalUrl} ...` `` on **every** request (both the success and
error branches), and `AllExceptionsFilter` logged `request.url` unredacted on 5xx errors. Since
`GET /orders/track/:trackingToken` puts the tracking credential directly in the URL path (not a
header or body field, which were already covered by `LoggingInterceptor`'s existing
`REDACTED_KEYS` body-field redaction), every single guest tracking request - including ordinary
successful ones - wrote that guest's bearer credential to server logs in plaintext. Anyone with log
read access could have used a logged token to look up (and read the full address/phone/items of)
that guest's order, without ever needing to compromise the guest directly.

Fixed with `src/common/utils/log-redaction.util.ts`'s `redactSensitiveUrl`, an explicit allowlist of
sensitive route patterns (currently just `/orders/track/:token`) rather than a generic
"long-random-looking segment" heuristic - a heuristic would also catch plain UUIDs (order ids,
product ids) that are genuinely useful in logs for debugging, and an explicit list is easy to
extend the day a new route puts a credential in its path. Wired into both `LoggingInterceptor` (both
branches) and `AllExceptionsFilter`'s error-log line; the JSON error response's own `path` field is
deliberately left un-redacted, since it only echoes the request back to the same caller who sent it
and is not a log. Verified: unit tests for `redactSensitiveUrl` itself and for `LoggingInterceptor`
(spying on `Logger.prototype.log`/`warn` to assert the raw token never appears in what's actually
logged, not just that the pure function works in isolation); and a live check against a running
instance - created a real order, hit its tracking endpoint, then `grep`-ed the live server log file
for the raw token (zero matches) and confirmed the actual log line read
`GET /api/v1/orders/track/[REDACTED] 200 ...`.

## InstaPay manual payment (screenshot upload)

### 29. Payment method is now a per-order field, not just an environment gate

`PAYMENT_METHOD` (env var) previously only gated *whether* `POST /orders` was reachable at all - it
said nothing about *how* a given order gets paid, because no method beyond "eventually, somehow" was
confirmed. That decision is now made: every order carries an explicit `paymentMethod`
(`CASH_ON_DELIVERY` or `INSTAPAY_MANUAL`), required on every `POST /orders` request, no default.
`PAYMENT_METHOD` keeps its original job (production on/off switch for public order acceptance) and
gained one new valid value, `manual` - the real production setting once these two methods are what a
deployment actually offers - alongside `none` (fully disabled) and `mock_dev_only` (dev/test
simulation, refused outside development/test, functionally identical to `manual`). Existing rows
predating this field got `paymentMethod: CASH_ON_DELIVERY` as a migration-level default (see #26
below for the reasoning pattern) - never silently reclassified as InstaPay, which would imply a
screenshot requirement retroactively.

### 30. `PaymentReceipt.orderId` is nullable and NOT unique, on purpose

A receipt starts unattached (`orderId: null`, bound only to the cart) so it can be uploaded *before*
the order exists, and validated for retry-safety independent of whatever the order-creation
transaction does or doesn't do. It is not `@unique` on `orderId` because a rejected receipt is never
deleted or overwritten - a replacement upload is a **new row**, already attached to the same order,
so the full history (original + every replacement, each with its own `status`/`rejectionReason`/
`reviewedAt`) stays visible to staff. `Order.receipts` is a list for exactly this reason; UIs should
treat the most recently created one as "current."

### 31. Reused `PaymentStatus.UNPAID` for "awaiting verification" - no new payment status needed

The brief allowed adding an explicit awaiting-verification payment status "if necessary." It wasn't:
`paymentStatus: UNPAID` + `paymentMethod: INSTAPAY_MANUAL` + a `PaymentReceipt` with
`status: PENDING_REVIEW` already describes "awaiting verification" precisely, without touching the
existing `PaymentStatus` enum or its transition table (`docs/BUSINESS_RULES.md` §20) at all. Proof
submission (`ReceiptStatus`) and payment confirmation (`PaymentStatus`) are consequently two
completely independent fields by construction, not merely "in practice" - there is no code path
where writing one also writes the other. `cancelDueToExpiry`'s existing `paymentStatus === UNPAID`
condition (§21) therefore also needed no change: an unverified, expired InstaPay order is cancelled
by the exact same check that already covered cash orders.

### 32. Receipt storage reuses `MEDIA_STORAGE_DRIVER`, not a second config knob

Public product media (`MediaStorageDriver`) and private payment receipts
(`ReceiptStorageDriver`) are separate interfaces/implementations (different directories, and a
receipt driver has no public `url` - only `read()`, gated by ownership/role checks) but are selected
by the *same* `MEDIA_STORAGE_DRIVER` env var rather than a second one. One knob to reason about, and
it stays honest: if S3 isn't wired up yet for public media, it isn't wired up for receipts either
(`UnavailableReceiptStorageService` fails loudly, mirroring `UnavailableMediaStorageService`) -
there's no scenario where one half of "storage" works and the other silently doesn't.

### 33. A raw `MulterError` never actually reaches the exception filter - found while testing the size limit

The size-limit test for receipt uploads expected `400 FILE_TOO_LARGE` (matching a `MulterError`
branch added to `AllExceptionsFilter` defensively) and got `413` instead. Investigation: NestJS's
`FileInterceptor` (used by both the receipt and the pre-existing media upload routes) already
converts a `MulterError` with code `LIMIT_FILE_SIZE` into its own `PayloadTooLargeException` before
any custom filter logic runs - the defensive `MulterError` branch is unreachable through that path
(kept anyway, as a fallback for any future multer usage that bypasses `FileInterceptor`) but harmless
either way. Rather than force a mismatched status code, `AllExceptionsFilter`'s `STATUS_CODE_MAP`
gained one entry (`413 -> 'FILE_TOO_LARGE'`), so the *existing*, correct NestJS behavior now also
produces a clean, stable error code instead of falling through to the generic `HTTP_ERROR`. This is
a one-line, targeted fix required for the receipt size-limit requirement to have a clean API
contract - it was not previously exercised by any test (`MediaAdminController`'s upload endpoint has
the same underlying behavior and benefits from the same fix, at no extra cost).

## Phase 5 — checkout/order concurrency correctness, storefront fixes, CMS, bundles, refunds

A focused pass against a specific list of suspected concurrency/correctness findings, followed by
three previously-deferred features (CMS content, bundle promotions, manual refunds/returns).

### 34. Idempotency scoping: cart ownership and payload hash checked on both the lookup AND the P2002 fallback path

**Confirmed present.** `OrdersService.createOrder`'s initial `idempotencyKey` lookup returned
whatever order had that key, without checking it belonged to the calling cart or that the request
body actually matched. The `P2002` unique-constraint fallback (two simultaneous requests racing to
insert the same key) had the identical gap on the losing request's path. Fixed by applying the same
two checks (`existingByKey.cartId !== cartId`, `existingByKey.idempotencyRequestHash !==
requestHash`) on both paths: a genuine same-cart-same-payload retry returns the original order; a
key reused for a different payload or a different cart gets `409 IDEMPOTENCY_KEY_REUSED` either way.
Verified in `test/order-concurrency.e2e-spec.ts` ("rejects a key already used by a different cart,
even with an identical payload").

**A related, deliberate non-change:** the task description raised whether the quote contract
(`expectedTotal`) sufficiently identifies what the customer actually agreed to, suggesting a
cart-contents "fingerprint" might be needed. Once every price/stock/coupon input moved to being
read fresh INSIDE the transaction (see #35 below) rather than from a pre-transaction snapshot, the
only remaining staleness risk is a coincidental total match with *different* cart contents - and
since only the cart's own owner (the holder of its token) can ever modify it, that scenario is
self-inflicted, not a fraud or cross-customer risk. No separate fingerprint field was added; adding
one would be complexity without a corresponding closed risk.

### 35. Order-level `reservationDeadline`, deliberately decoupled from any one `StockReservation.expiresAt`

**Root cause of several separate findings:** the expiry sweep only ever looked at
`StockReservation` rows, so (a) an order made entirely of `isUnlimitedStock` items had nothing
driving its cancellation at all, and (b) "was this order's stock reservation released" and "should
this order be cancelled" were the same question by accident, not by design - correct only as long as
every order had exactly the reservations its payment-method policy implied, which stopped being true
the moment COD needed a different policy (#36) than InstaPay.

**Fix:** added `Order.reservationDeadline DateTime?` (migration
`20260912104720_order_level_expiry_deadline`), set once at order creation from the same
`ttlMinutes` value used for stock reservations, but tracked as its own field rather than derived.
`OrdersService.cancelExpiredOrders` selects `PENDING`/`UNPAID` orders whose `reservationDeadline`
has passed and cancels each one (atomically, guarded, releasing its own reservations and coupon
usage) independent of whether it has any `StockReservation` rows at all. `OrderExpiryService.sweepAndCancel`
now runs both sweeps (reservation release, order cancellation) and returns both counts.

### 36. Payment-method-specific expiry policy: COD gets no default deadline; reviewed COD stock-consumption timing, found already correct

`RESERVATION_TTL_MINUTES` (a single, one-size-fits-all default) was removed entirely.
`ttlMinutes`/`reservationDeadline` are now computed per order from its `paymentMethod`:
`INSTAPAY_MANUAL` always uses `INSTAPAY_REVIEW_DEADLINE_MINUTES` (unchanged, default 24h);
`CASH_ON_DELIVERY` uses the new, optional `COD_EXPIRY_MINUTES` (unset by default, meaning "never
auto-expire" - `null` and "unset" are handled distinctly from "use the old default," since a naive
`??` would have silently reinstated a short default TTL for COD). A submitted COD order represents a
real commitment a courier will act on; auto-cancelling it just because staff haven't confirmed it
yet would be actively wrong.

**Reviewed separately, found already correct, no change made:** whether COD stock is consumed too
early (before cash is actually collected). The existing design already consumes stock only at the
explicit `PAID` action, exactly like InstaPay - `updateFulfillmentStatus` never checks
`paymentStatus` for COD, so a COD order can reach `PREPARING`/`SHIPPED` while still `UNPAID` (dispatch
never depends on having already collected cash), and the atomic `ACTIVE -> CONSUMED` reservation
guard already ensures stock is consumed exactly once regardless of which payment method triggered
it. Redesigning this to consume stock at `CONFIRMED` instead was considered and rejected: it would
be a larger, riskier behavior change with unclear coupon-interaction side effects, requested nowhere
in the actual findings list, and the property the findings actually asked for ("dispatch must not
depend on having collected cash," "stock consumed exactly once") already held.

### 37. Reservation release now re-checks expiration atomically; sweep counts report only real transitions

**Confirmed present:** `releaseAllExpired` selected candidate reservations, then released all of
them without re-checking that each one was still actually expired (or still `ACTIVE`) at release
time - a reservation pinned to `expiresAt: NULL` by a concurrent `CONFIRMED` transition, in the gap
between selection and release, could still be released anyway, silently undoing the pinning
guarantee from #25 in Phase 4. Fixed with a new `releaseIfStillExpired(reservationId)` that performs
its own single-row conditional `UPDATE ... WHERE status = 'ACTIVE' AND expiresAt IS NOT NULL AND
expiresAt < now()` and returns `null` (no-op) if it loses that race; `releaseAllExpired` and the
lazy per-stock-item sweep both now call it per-candidate and only count an actual transition,
instead of assuming every selected candidate was released. This is also what makes the sweep-count
report accurate ("report only actual transitions in sweep counts") - verified in
`test/order-concurrency.e2e-spec.ts`'s CONFIRMED-vs-CANCELLED concurrency race, which asserts the
loser's reservation state is exactly what the winning transition implies, never a mix of both.

### 38. Guarded conditional updates replace plain `update` for order/payment/receipt state transitions

**Confirmed present:** `updateFulfillmentStatus`, `updatePaymentStatus`, and receipt
accept/reject all previously ended with a plain `tx.<model>.update(...)`, which unconditionally
overwrites whatever the row's current state is - safe only if nothing else could have changed it
between this transaction's read and its write, which concurrent staff actions or a concurrent expiry
sweep can violate. All three now end with a conditional `updateMany({where: {id, <field>:
<expectedCurrentValue>}, ...})` and check `result.count`, throwing `409 ORDER_STATE_CHANGED` (or,
for receipts, a specific `INVALID_STATE_TRANSITION`/`NO_PENDING_RECEIPT`) on a lost race rather than
silently clobbering a concurrent change. Two new, more precise error codes were introduced where the
old ones were too generic for what was actually happening:

- **`STOCK_RESERVATION_LOST`** (409) - confirming or marking an order paid when its tracked-stock
  reservation has expired/been released (and was never consumed) is refused with this specific code
  instead of a misleadingly generic `INVALID_STATE_TRANSITION`, via a new
  `loadReservationTriage`/`assertStockCommitmentNotLost` pair that distinguishes "genuinely
  unlimited-stock order" (`hasAny: false`) from "lost commitment" (`hasAny: true, active: [],
  hasConsumed: false`) from "already consumed" (fine, proceed).
- **`PAYMENT_NOT_CONFIRMED`** (409) - an unpaid `INSTAPAY_MANUAL` order can no longer reach
  `PREPARING`; `CASH_ON_DELIVERY` is unaffected (§20/§28) - closing the specific finding "prevent
  unpaid InstaPay orders from reaching preparation/shipping."
- Marking an order `PAID` now also atomically accepts its pending InstaPay receipt in the same
  transaction (`acceptPendingReceiptInTransaction`), refusing (`NO_PENDING_RECEIPT`, 409) if there is
  none currently `PENDING_REVIEW` - a paid order can no longer retain a stale pending receipt, and a
  receipt already `ACCEPTED` can no longer be rejected (`rejectReceipt` is now itself a guarded
  conditional update keyed on `status: PENDING_REVIEW`).

### 39. `?availableOnly=false` was silently read as `true` - a two-layer bug

**Confirmed present, root-caused precisely** (not just patched until the symptom went away): the
naive JS bug is well known (`Boolean("false") === true`), but the first fix attempt
(`@Transform(({value}) => ...)`) still failed for `"false"`. An empirical debug script proved why:
the global `ValidationPipe`'s `enableImplicitConversion: true` runs class-transformer's own implicit
type coercion (driven by the property's reflected `boolean` type) BEFORE a custom `@Transform`
callback ever sees `value` - by the time the callback ran, `"false"` had already been coerced to
`true`, with no way to recover the original string from the already-corrupted value. The working
fix reads `obj[key]` (the untouched source object class-transformer is converting *from*) inside the
`@Transform` callback instead of the `value` parameter. Also fixed in the same pass: the filter's
`stockItemId: null` branch previously treated ANY variant with no linked stock item as available,
ignoring `isUnlimitedStock` entirely (contradicting §4), and it compared only `onHand` (a stale
in-code comment claimed "`reserved` is always 0"), not `onHand - reserved`.

### 40. Public variant/cart thumbnails, and shared-stock aggregation in the cart's soft check

Two separate, previously-undetected gaps in already-shipped code:

- **Public variant media was never queried at all.** Three separate Prisma queries in
  `products.service.ts` each independently built an incomplete variant-`include` shape
  (`phoneModel`/`caseType`/`stockItem` only) - consolidated into one shared
  `PRODUCT_VARIANT_RELATIONS_INCLUDE` constant (now including `media`) used everywhere, closing the
  gap in one place instead of three, and `product-response.mapper.ts` now exposes a `thumbnail`
  field with the same variant-then-product-primary-image fallback already used by the cart.
- **`CartService.assertSoftAvailability`'s informative add/update check only ever looked at the ONE
  cart line being mutated**, not other lines sharing the same `StockItem` (e.g. two different
  print-on-demand designs on the same blank) - so two individually-"fine" additions could together
  silently exceed real availability, only to be correctly (but confusingly, post-hoc) caught at
  checkout. Fixed to sum quantities across all of a cart's lines pointing at the same `StockItem`,
  matching the aggregation checkout already enforced atomically.

### 41. Refresh-token rotation made atomic

**Confirmed present:** `AuthService.refresh` read the token, checked it, then issued a new pair and
revoked the old one as separate, non-transactional steps - two concurrent refresh calls using the
same still-valid token could both pass the initial check and both successfully mint a new session.
Fixed: the old token's revocation is now the actual concurrency gate, via a conditional `updateMany({
where: {id, revokedAt: null}, ...})` inside a transaction that only mints the new pair
(`issueTokenPair`, now transaction-client-aware) after that guard wins; the loser gets `401`.
Verified in `test/auth.e2e-spec.ts` by racing two refresh calls on the same token and confirming
exactly one succeeds and its new token pair actually works on a follow-up request.

### 42. Homepage/page content: a small structured CMS, not a page builder

Deliberately modeled as a fixed, typed shape (`HomepageSection` with an enum `type`, bilingual
title/body, one optional media attachment, one optional link; `Page` with a slug and bilingual
title/body) rather than a general-purpose block/component page-builder. A page builder would be a
much larger, more speculative surface (arbitrary nested content blocks, a rendering contract the
frontend would need to interpret generically) for a requirement that only ever asked for "homepage
banners/sections" and "informational pages" - the same "don't build ahead of an actual requirement"
principle already applied to shipping zones in #17. `HomepageSection.mediaAssetId` reuses the
existing `MediaAsset`/`onDelete: Restrict` pattern rather than inventing a parallel media system, so
safe-delete-while-referenced (§ media rules) came for free.

### 43. Two-item bundle promotion: design and the deterministic grouping algorithm

Answers the five questions left open in #17/#23, each as an explicit configuration field on
`BundlePromotion`/`BundleEligibleVariant` rather than a hardcoded rule (see docs/BUSINESS_RULES.md
§31) - "require complete configuration before activation" (checked in `BundlesService`, enforced
even when only *some* fields change on an update, not just when `isEnabled` itself flips) is what
keeps an incompletely-configured bundle from ever going live.

**The grouping algorithm**, needed because the business rules delegate "define deterministic
grouping when several eligible units exist" to the implementation: eligible units are bucketed by
phone model (or a single bucket when `requireDifferentPhoneModels` is off); each round, the two
largest remaining buckets are paired (ties broken by bucket key, then by the earliest-added unit
within a bucket) - the standard greedy strategy for maximizing the number of cross-category pairs,
which maximizes total customer savings for a given cart. This is an implementation choice, not a
business one, and is unit-tested directly (`bundle-pricing.util.spec.ts`, 11 cases) independent of
any HTTP/DB plumbing. If a specific pairing would ever produce a negative discount (a
misconfiguration - `fixedTotal` plus surcharges exceeding the two units' normal combined price),
bundling for that promotion stops entirely for that cart rather than ever charging more than normal
pricing would.

**Order-item splitting for exact refund snapshots:** because a single cart line's units can end up
partially bundled (some units in one bundle instance, some in another, some not bundled at all when
a repeatable bundle doesn't perfectly divide a line's quantity), order creation groups the final
draft lines by `(original cart line, bundle instance)` pair rather than assuming one `OrderItem` per
cart line - a line whose quantity was only partially consumed by bundling becomes more than one
`OrderItem` row, each with its own exact `bundleDiscount` and `bundleInstanceId`. `BundleInstance`
rows are created before the corresponding `OrderItem` rows (in the same transaction) specifically so
each instance's real database id is known deterministically by array index, with no ambiguous
after-the-fact matching of newly-created rows back to instances (a real risk when two draft lines
can have identical `variantId`/`quantity`/`unitPrice` tuples).

### 44. Manual refund/return administration; a genuine, unrelated bug fixed along the way

Modeled as two independent record types (`Refund` for money, `OrderItemReturn` for physical
goods) rather than one combined entity, because they are not always 1:1 in reality (a goodwill
refund needs no physical return; a physical return doesn't automatically justify one) - see
docs/BUSINESS_RULES.md §32. `Order.paymentStatus`'s `PARTIALLY_REFUNDED`/`REFUNDED` states are now
reachable ONLY through `RefundsService.recordRefund` (the generic `PATCH .../payment-status`
endpoint explicitly refuses both as a target) precisely so "close generic status-update paths that
bypass these financial records" holds by construction, not by convention. The over-refund cap uses a
`SELECT ... FOR UPDATE` row lock on the order for the transaction's duration rather than a
conditional `updateMany`, because the actual invariant being protected
(`sum(refunds.amount) <= order.total`) is a multi-row aggregate check, not a single-field
compare-and-swap - the established `updateMany`-with-count pattern used everywhere else in this
codebase doesn't fit an aggregate guard, so row-level locking (still plain PostgreSQL, no new
infrastructure) was used instead. The idempotency-key check is deliberately evaluated BEFORE the
payment-status-transition check, not after: a retried request for a refund that has already fully
processed (and may have already moved the order past `PAID`/`PARTIALLY_REFUNDED` to `REFUNDED`) must
still replay as a no-op, not fail as if it were a brand-new, now-illegal request.

**A genuine, pre-existing bug found and fixed while building this feature, unrelated to refunds
themselves:** `StockItemsService.adjust` accepted a staff-supplied `reason` in its DTO, recorded it
in the audit log, but wrote a hardcoded literal (`'manual_adjustment'`) into the `StockMovement.reason`
column itself - the actual durable stock-ledger row never retained the real reason a staff member
gave (e.g. "restocked after inspection - unopened return"), only the audit log did. This directly
matters for §32's "restocking must be an explicit authorized action with a stock movement and
reason" - fixed to persist `dto.reason` onto the movement row, verified in
`test/refunds.e2e-spec.ts`'s restocking test, which asserts the movement's own `reason` field.

## Phase 5.1 — four findings from a static review of commit `eed8ea8`

All four confirmed as real against the current code, not disproved. Fixed with focused regression
tests, no unrelated modules touched.

### 45. Discount stacking order, and `allocateDiscount`'s per-line over-allocation bug

Confirmed present in `CartPricingService.buildView`: the coupon was computed on the raw subtotal,
independent of the bundle discount, so `subtotal - discountTotal - bundleDiscountTotal` could go
negative once stacking was allowed. Fixed by computing bundle discounts first and the coupon
against `subtotal - bundleDiscountTotal` - see docs/BUSINESS_RULES.md §33 for the exact formula and
why it needs no special case for non-stacking bundles.

A SECOND, independent bug surfaced while verifying the fix couldn't go negative per LINE, not just
in aggregate: `allocateDiscount`'s "remainder always to the last line" rule could give one line a
discount larger than its own subtotal whenever several other lines' flooring losses accumulated onto
it (`allocateDiscount([1, 1, 1], 2)` returned `[0, 0, 2]` - a 100%+ discount on the third line). This
is a pre-existing bug, unrelated to bundles, that happened to never surface before because coupon
discounts were previously always allocated across whole cart lines at their full subtotal, rarely
producing the 3+-line, small-remainder conditions needed to trigger it. Rewritten to distribute the
flooring remainder to whichever lines still have headroom rather than dumping it all on one line -
proven to never exceed any line's own subtotal whenever the total discount doesn't exceed the sum of
subtotals (which the function now also defensively caps). `OrdersService.createOrder` was also
changed to allocate each line's coupon share against `lineSubtotal - bundleDiscount` (what's
actually left eligible for that line), not its raw subtotal - the two fixes together are what
guarantee every order line's `lineTotal` stays non-negative. One pre-existing test
(`allocateDiscount([333,333,333], 10)`) asserted the OLD last-line-remainder value and was updated
to the new (still-summing-to-10, now-safe) distribution.

### 46. Cross-bundle unit reuse

Confirmed present: `computeBundleInstances` looped over each active bundle independently, rebuilding
its eligible-unit pool from the raw `lines` array every time - so two overlapping active bundles
could each claim the same physical unit. Fixed with a `remainingQuantityByLine` count shared across
the whole call, decremented as units are claimed - see docs/BUSINESS_RULES.md §34. Also fixed, found
while implementing this: `BundlesService.loadActiveForPricing` had no `orderBy` at all, so the order
bundles were evaluated in (which decides who wins a contested unit) was not actually guaranteed
deterministic by Postgres - added `orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]`.

### 47. Order-row locking

Confirmed present and root-caused precisely: `updateFulfillmentStatus`/`updatePaymentStatus` each
validated against a pre-transaction read and guarded only their own column on write, so two
concurrent operations touching DIFFERENT columns of the same order could both commit from mutually
stale assumptions - most concretely reproducible on an `isUnlimitedStock` order, which has no
`StockReservation` row to incidentally serialize the two operations the way a tracked-stock order's
consume/release contention accidentally did. Fixed by adding `OrdersService.lockOrderForUpdate`
(`SELECT ... FOR UPDATE`) as the first statement in every order-status-mutating transaction
(`updateFulfillmentStatus`, `updatePaymentStatus`, `cancelDueToExpiry`), matching the lock-first
pattern `RefundsService.recordRefund` already used - see docs/BUSINESS_RULES.md §35 for the exact
before/after behavior and the one pre-existing test whose expectation changed because it was
asserting an artifact of the bug (an arbitrary "only one request can ever succeed") rather than
correct state-machine semantics (CONFIRMED -> CANCELLED is a real, valid sequence).

**Verified with controlled synchronization, not `Promise.all`:** `test/order-concurrency.e2e-spec.ts`
adds a `raceOrderLockedOperations` test helper that spies on `lockOrderForUpdate` to deterministically
pause the FIRST of two operations right after it acquires the real Postgres row lock, confirms the
SECOND operation genuinely blocks (via a timeout-based "still pending" check) rather than merely
finishing fast, then releases the first and asserts the second's outcome against the now-fresh state.
Every other call to `lockOrderForUpdate` (the second operation's own) falls through to the real
implementation, so the actual serialization is enforced by Postgres itself, not test-side mocking. A
real bug in the FIRST version of this helper - constructing but never awaiting/`.then`-ing a
supertest request left it undispatched, since supertest only actually sends the HTTP call once
something drives its thenable, causing a genuine deadlock (the lock-acquired signal the rest of the
helper waits on would never fire) - was found via the resulting test timeout and fixed by attaching a
synchronous no-op `.catch()` immediately after obtaining the promise, forcing dispatch.

### 48. Full stock commitment check, aggregated per stock item

Confirmed present: `assertStockCommitmentNotLost` only checked "are there zero active reservations
and none consumed" - an order requiring two different stock items where one reservation was still
ACTIVE but the other had EXPIRED incorrectly passed, since `active.length > 0` was true. Fixed by
aggregating `loadReservationTriage`'s reservations by `stockItemId`: required quantity is the sum of
every reservation ever created against that stock item for the order (stable, snapshotted at
checkout - never re-derived from a variant's current, possibly-reassigned `stockItemId`), covered
quantity is the sum of only ACTIVE/CONSUMED ones, and the order is only intact when every required
stock item's coverage meets its requirement. No new persisted data or migration needed -
`StockReservation` already recorded `stockItemId` and `quantity` per row, which is all the check
needs. See docs/BUSINESS_RULES.md §37.
