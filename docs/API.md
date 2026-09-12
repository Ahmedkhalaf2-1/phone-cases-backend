# API Conventions

## Base URL and versioning

All routes are served under `/api/v1/...` (global prefix `api` + URI versioning `v1`, see
`src/main.ts`). There is currently only one version.

Interactive OpenAPI documentation is served at **`/api/docs`** (Swagger UI) whenever the app is
running, generated directly from controller/DTO decorators — it is always in sync with the code.
The raw OpenAPI JSON is available at `/api/docs-json` (Swagger UI's own convention).

## Route groups

| Prefix | Audience | Auth |
|---|---|---|
| `/api/v1/auth/*` | Staff | Public (login/refresh/logout) or Bearer JWT (`/me`) |
| `/api/v1/admin/*` | Staff | Bearer JWT + role check |
| `/api/v1/cart/*` | Guest shopper | Opaque `X-Cart-Token` header (except creating a cart) |
| everything else (`/api/v1/products`, `/api/v1/collections`, ...) | Public storefront | None |

There are no webhook routes yet (Phase 4 will add `/api/v1/webhooks/*`, deliberately kept out of
both the public and admin prefixes).

## Auth

- `POST /api/v1/auth/login` → `{ accessToken, refreshToken, expiresIn, staff }`. Rate-limited to
  5 requests/minute per client (see `@Throttle` on `AuthController.login`).
- `POST /api/v1/auth/refresh` → rotates the refresh token (old one is revoked, reuse returns 401).
- `POST /api/v1/auth/logout` → revokes the given refresh token. `204 No Content`.
- `GET /api/v1/auth/me` → current staff identity. Requires `Authorization: Bearer <accessToken>`.

Send the access token as `Authorization: Bearer <token>` on every admin request. Access tokens are
short-lived (`JWT_ACCESS_EXPIRES_IN`, default 15m); refresh before it expires using the refresh
token (`JWT_REFRESH_EXPIRES_IN`, default 7d).

## Pagination

Any list endpoint accepts `page` (default 1) and `pageSize` (default 20, max 100 — see
`MAX_PAGE_SIZE` in `src/common/dto/pagination-query.dto.ts`) and responds with:

```json
{
  "items": [ ... ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 42, "totalPages": 3 }
}
```

Requesting a `pageSize` above the max is a `400 VALIDATION_ERROR`, not a silent clamp — the client
should know its request was rejected rather than get a smaller page than expected.

## Filtering and sorting (public product listing)

`GET /api/v1/products` accepts:

| Query param | Meaning |
|---|---|
| `collection` | collection slug |
| `phoneModel` | phone model slug |
| `caseType` | case type slug |
| `priceMin`, `priceMax` | integer minor units, inclusive |
| `availableOnly` | `true` to only return products with at least one currently available variant |
| `q` | free-text search across English/Arabic name and description (case-insensitive substring) |
| `sort` | `newest` (default), `price_asc`, `price_desc` |
| `locale` | `en` (default) or `ar` — controls which language fields are returned |
| `page`, `pageSize` | pagination |

Sorting/filtering is implemented with plain PostgreSQL queries (`ILIKE`, indexed equality/range
filters) per the instruction to start with PostgreSQL capabilities rather than reaching for a
separate search service. See `docs/DECISIONS.md` for the two-pass query strategy used to sort by
effective price without a full SQL aggregation, and its scaling limitation.

## Admin variants: explicit stock configuration (Phase 4)

`POST/PATCH /api/v1/admin/products/:productId/variants(/:variantId)` accept an `isUnlimitedStock`
boolean (default `false`) alongside the existing `stockItemId`. A variant with **neither** set is
not purchasable anywhere (public catalog, cart, checkout) - a stockless variant is never assumed
available; `isUnlimitedStock: true` is the explicit opt-in required for that (a plain accessory, a
made-to-order item). Setting `isUnlimitedStock: true` together with a `stockItemId` is rejected
(`400`) - the two are mutually exclusive. See `docs/BUSINESS_RULES.md` §4 and docs/DECISIONS.md #26.

## Locale and bilingual responses

Every public read endpoint accepts `?locale=en|ar` (default `en`). The response contains a single
localized `name`/`description` string, not both languages — the fallback rule (Arabic missing →
English) is documented in `docs/DATA_MODEL.md`. Admin endpoints always return both `nameEn`/`nameAr`
(and `descriptionEn`/`descriptionAr`) so staff can edit either.

## Errors

Every error response has this shape:

```json
{
  "statusCode": 409,
  "code": "VARIANT_SKU_TAKEN",
  "message": "SKU \"SPACE-IP15-SLIM\" is already in use",
  "correlationId": "abc123",
  "timestamp": "2026-09-11T22:40:26.713Z",
  "path": "/api/v1/admin/products/.../variants"
}
```

`code` is stable and safe to branch on programmatically; `message` is for humans/logs and may
change wording. See `src/common/exceptions/app.exception.ts` for how domain errors are raised, and
`src/common/filters/all-exceptions.filter.ts` for how every thrown error (including generic
NestJS/Prisma errors) is normalized into this shape.

Validation errors (`400 VALIDATION_ERROR`) additionally include a `details` array with one message
per failing field, generated by `class-validator`.

## Correlation IDs

Every response carries an `x-request-id` header (generated if the client didn't send one) that
also appears as `correlationId` in error bodies and in server logs — use it when reporting an issue.

## Cart (Phase 2)

- `POST /api/v1/cart` — creates a cart, no body. Returns `{ token, cart }`. The `token` is shown
  **only here** — store it client-side (see docs/DECISIONS.md for the cookie/storage note) and send
  it as `X-Cart-Token` on every other cart request. There is no way to recover a lost token.
- `GET /api/v1/cart` — current cart with live-recomputed totals.
- `POST /api/v1/cart/items` — `{ variantId, quantity }`. Adding an already-present variant merges
  quantities. Rejects (`409`) an unpublished/inactive variant or a quantity beyond what's currently
  available - this check is informative only and does not reserve anything (see
  docs/BUSINESS_RULES.md §11).
- `PATCH /api/v1/cart/items/:itemId` — `{ quantity }`; `quantity: 0` removes the item.
- `DELETE /api/v1/cart/items/:itemId` — removes the item.
- `POST /api/v1/cart/coupon` — `{ code }`. `400 COUPON_NOT_APPLICABLE` if the coupon is inactive,
  outside its validity window, below minimum spend, or past its usage limit.
- `DELETE /api/v1/cart/coupon` — removes the currently applied coupon.

All cart responses share this shape:

```json
{
  "id": "…",
  "currency": "EGP",
  "items": [
    {
      "id": "…", "variantId": "…", "sku": "SPACE-IP15-SHOCK",
      "productSlug": "space", "productName": "Space",
      "phoneModel": { "slug": "iphone-15", "name": "iPhone 15", "brand": "Apple" },
      "caseType": { "slug": "shock-resistant", "name": "Shock-Resistant" },
      "thumbnail": { "url": "https://.../case.jpg", "altText": "iPhone 15 shock-resistant case" },
      "unitPrice": 45000, "quantity": 2, "lineSubtotal": 90000,
      "isAvailable": true,
      "bundleDiscount": 0
    }
  ],
  "subtotal": 90000,
  "discountTotal": 9000,
  "bundleDiscountTotal": 0,
  "total": 81000,
  "coupon": { "code": "WELCOME10", "type": "PERCENTAGE", "value": 10 },
  "couponWarning": null
}
```

`subtotal`/`total` only ever include `isAvailable: true` items. An unavailable item stays in the
response (with `unavailableReason`) rather than being silently dropped. `couponWarning` is present
only when an applied coupon has since become invalid - the discount is `0` in that case, but the
coupon stays attached until the client explicitly removes it. `thumbnail` falls back to the parent
product's primary image when the variant has none of its own, and is `null` only if neither has any
media. `bundleDiscountTotal`/per-item `bundleDiscount` reflect any active, enabled bundle promotion
that currently applies to this cart's contents - see "Bundle promotions" below; both are `0` when no
bundle applies, so this is a fully backward-compatible addition.

- `PATCH /api/v1/cart/items/:itemId/variant` — `{ newVariantId }`. Atomically replaces a line's
  variant, merging into an existing line for the target variant if one exists. Fails (`400`/`409`)
  without touching the original line if the new variant is unavailable or insufficient in stock.

## Admin coupons and stock reservations (Phase 2)

- `POST /api/v1/admin/coupons`, `GET /api/v1/admin/coupons`, `GET /api/v1/admin/coupons/:id`,
  `PATCH /api/v1/admin/coupons/:id` — standard admin CRUD, `CATALOG_MANAGER` or above.
- `GET /api/v1/admin/stock-items/:id/movements` — the append-only ledger of `onHand` changes.
- `GET /api/v1/admin/stock-items/:id/reservations` — active/released/expired/consumed holds.
- `POST /api/v1/admin/stock-reservations/sweep-expired` — manually releases every expired `ACTIVE`
  reservation; returns `{ released: <count> }`. A scheduled job also runs this every minute since
  Phase 3 (see below).

## Shipping (Phase 3)

- `GET /api/v1/shipping-options?country=EG&locale=en` — public. Returns the active rates covering
  that country: `[{ id, name, price, currency, freeShippingThreshold, estimatedDaysMin,
  estimatedDaysMax }]`. An unrecognized/uncovered country returns an empty array, not an error.
- `POST /api/v1/admin/shipping-zones`, `GET .../shipping-zones`, `GET .../shipping-zones/:zoneId`,
  `PATCH .../shipping-zones/:zoneId` — `OWNER_ADMIN`/`CATALOG_MANAGER`. A zone body is
  `{ nameEn, nameAr, countries: string[], displayOrder?, isActive? }`; country codes are
  case-insensitive on input, stored uppercase.
- `POST .../shipping-zones/:zoneId/rates`, `GET .../shipping-zones/:zoneId/rates`,
  `PATCH .../shipping-zones/:zoneId/rates/:rateId` — same roles. A rate body is
  `{ nameEn, nameAr, price, freeShippingThreshold?, estimatedDaysMin?, estimatedDaysMax?,
  isActive? }`. All prices are integer minor units.

## Checkout quote (Phase 3)

`POST /api/v1/checkout/quote` — guest cart token required, no auth. Body:
`{ country: "EG", shippingRateId }`. Read-only; reserves nothing. Response:

```json
{
  "items": [ { "...": "same shape as GET /cart items", "isAvailable": true } ],
  "subtotal": 90000,
  "discountTotal": 9000,
  "bundleDiscountTotal": 0,
  "shippingTotal": 5000,
  "total": 86000,
  "currency": "EGP",
  "coupon": { "code": "WELCOME10", "type": "PERCENTAGE", "value": 10 },
  "couponWarning": null,
  "issues": []
}
```

`409 SHIPPING_RATE_NOT_AVAILABLE` if `shippingRateId` doesn't cover `country` or isn't active.
`issues` lists any cart line that is currently unavailable (with a reason) without failing the quote.

## Orders (Phase 3)

- `POST /api/v1/orders` — guest cart token required. Body:

  ```json
  {
    "idempotencyKey": "client-generated-string-min-8-chars",
    "customerFullName": "...", "customerEmail": "optional@example.com",
    "customerPhone": "01012345678",
    "shippingCountry": "EG", "shippingCity": "...", "shippingAddressLine1": "...",
    "shippingAddressLine2": "optional", "shippingPostalCode": "optional",
    "shippingRateId": "uuid-from-shipping-options",
    "expectedTotal": 86000,
    "paymentMethod": "CASH_ON_DELIVERY",
    "receiptId": "required only when paymentMethod is INSTAPAY_MANUAL - from POST /cart/receipts"
  }
  ```

  Returns the guest order view (`201`) — `orderNumber`, `trackingToken`, both status fields,
  `paymentMethod`, `receipts` (id/status/rejectionReason/createdAt only - no file data), totals
  (including `bundleDiscountTotal`), `shippingAddress`, and the immutable `items` snapshot (each with
  its own `lineDiscount` and `bundleDiscount`). Error codes: `409 IDEMPOTENCY_KEY_REUSED`
  (same key, different body, OR a different cart replaying somebody else's key), `409
  CART_ALREADY_ORDERED` (a concurrent checkout attempt on the same cart already won), `400` (empty
  cart, missing/misplaced `receiptId`), `409 ITEMS_UNAVAILABLE` (with `details.items`), `409
  SHIPPING_RATE_NOT_AVAILABLE`, `409 PRICE_CHANGED` (with fresh totals in `details`), `409
  COUPON_USAGE_LIMIT_REACHED`, `409 COUPON_NOT_APPLICABLE`, `404 RECEIPT_NOT_FOUND` (wrong cart or
  doesn't exist), `409 RECEIPT_ALREADY_ATTACHED`, `410 RECEIPT_EXPIRED`. **Returns `503`** if
  `PAYMENT_METHOD=none` (see docs/DECISIONS.md) — the endpoint is intentionally unreachable until an
  operator sets `manual`.
- `GET /api/v1/orders/track/:trackingToken` — public, no cart token needed (the tracking token
  itself is the credential). Returns the same guest order view. `404` for any token that doesn't
  match an order — including a guessed/incorrect one, never leaking whether a *similar* token
  exists.

## Payment receipts / InstaPay manual (Phase 4)

Guest-facing, all authenticated by the cart token (`X-Cart-Token`), never by receiptId/order number
alone — see docs/BUSINESS_RULES.md §25-26.

- `POST /api/v1/cart/receipts` — `multipart/form-data`, field name `file`. Cart must be `ACTIVE`.
  Accepts JPEG/PNG/WebP up to `RECEIPT_MAX_FILE_SIZE_BYTES` (default 5MB); the actual file content
  is decoded to confirm it's a real image, not just trusting the extension/Content-Type. Returns
  `{ receiptId }` (`201`). Rate-limited (10/min). Errors: `400` (unreadable/unsupported/wrong-type
  file), `413 FILE_TOO_LARGE`, `409 CART_NOT_ACTIVE`, `409 TOO_MANY_PENDING_RECEIPTS` (cap:
  `RECEIPT_MAX_PENDING_PER_CART`, default 5).
- `POST /api/v1/cart/receipts/replace` — same file constraints, but uploads AND attaches a
  replacement directly to the cart's existing order in one step. Only allowed when that order is
  `INSTAPAY_MANUAL`, not cancelled, not yet paid, and its most recent receipt was rejected. Returns
  `{ receiptId }` (`201`). Errors: `409 REPLACEMENT_NOT_APPLICABLE` (not an InstaPay order), `409
  REPLACEMENT_NOT_ALLOWED` (current receipt isn't rejected), `409 ORDER_CANCELLED`, `409
  ORDER_ALREADY_PAID`.
- `GET /api/v1/cart/receipts/:receiptId/file` — streams the image (`Content-Type` set, `Cache-
  Control: private, no-store`). `404` if the receipt doesn't belong to this cart.

## Admin orders (Phase 3, extended in Phase 4)

- `GET /api/v1/admin/orders?fulfillmentStatus=&paymentStatus=&page=&pageSize=` —
  `OWNER_ADMIN`/`ORDER_OPERATOR`. Paginated, full order + snapshot detail, including `receipts`.
- `GET /api/v1/admin/orders/:id` — same roles.
- `PATCH /api/v1/admin/orders/:id/fulfillment-status` — `{ status }`, `OWNER_ADMIN`/
  `ORDER_OPERATOR`. `409 INVALID_STATE_TRANSITION` if not allowed from the current status; `409
  PAYMENT_NOT_CONFIRMED` moving an unpaid `INSTAPAY_MANUAL` order to `PREPARING`; `409
  STOCK_RESERVATION_LOST` confirming an order whose tracked-stock reservation has expired/been
  released; `409 ORDER_STATE_CHANGED` if a concurrent request changed the order first (retry after
  reloading).
- `PATCH /api/v1/admin/orders/:id/payment-status` — `{ status }`, **`OWNER_ADMIN` only** (financial
  action). Same transition-error shape, plus `409 STOCK_RESERVATION_LOST` and `409
  ORDER_STATE_CHANGED` as above; also `409` if the order is `CANCELLED`. The one and only way an
  order (cash or InstaPay) is ever marked `PAID` - doing so also atomically accepts that order's
  pending InstaPay receipt, if any (`409 NO_PENDING_RECEIPT` if there isn't one currently pending).
  **Refuses (`400 USE_REFUNDS_ENDPOINT`) `PARTIALLY_REFUNDED`/`REFUNDED` as a target** - use
  `POST /api/v1/admin/orders/:id/refunds` instead (see "Refunds and returns" below).
- `PATCH /api/v1/admin/orders/:id/receipts/:receiptId/reject` — `{ reason }`, **`OWNER_ADMIN`
  only**. Marks that receipt `REJECTED` (audited); does not change the order's payment status. `409
  INVALID_STATE_TRANSITION` if the receipt isn't currently `PENDING_REVIEW`.
- `PATCH /api/v1/admin/orders/:id/flag-late-payment` — `{ note }`, **`OWNER_ADMIN` only**. Only
  valid on a `CANCELLED` order; records a manual-reconciliation note without restoring fulfillment
  or payment status. `409` otherwise.
- `GET /api/v1/admin/receipts/:receiptId/file` — `OWNER_ADMIN`/`ORDER_OPERATOR`. Streams any
  receipt's image, gated by role only (no ownership check needed for staff).
- `POST /api/v1/admin/orders/sweep-expired` — `OWNER_ADMIN`/`ORDER_OPERATOR`. Manually triggers the
  same expiry sweep the scheduler runs every minute; returns
  `{ releasedReservations: <count>, cancelledOrders: <count> }`.

## Refunds and returns (Phase 5)

Staff-only; there is no customer-facing endpoint. See docs/BUSINESS_RULES.md §32.

- `POST /api/v1/admin/orders/:id/refunds` — **`OWNER_ADMIN` only**. Body:
  `{ amount, currency, reason, idempotencyKey }` (`amount` is a positive integer in minor units,
  `idempotencyKey` min length 8 - a retry with the same key is a safe no-op, returning the original
  refund). Records the refund and derives the order's `paymentStatus`
  (`PARTIALLY_REFUNDED` if the running total is still below `Order.total`, `REFUNDED` once it
  reaches it). Errors: `409 INVALID_STATE_TRANSITION` (order isn't `PAID`/`PARTIALLY_REFUNDED`),
  `400` (currency mismatch), `409 REFUND_EXCEEDS_PAID_AMOUNT`, `409 IDEMPOTENCY_KEY_REUSED` (same
  key, different order).
- `GET /api/v1/admin/orders/:id/refunds` — `OWNER_ADMIN`/`ORDER_OPERATOR`. Lists refunds for the
  order, newest first.
- `POST /api/v1/admin/orders/:orderId/items/:itemId/returns` — `OWNER_ADMIN`/`ORDER_OPERATOR`. Body:
  `{ quantity, reason }`. Records a returned quantity for one order line; does **not** touch
  `StockItem.onHand`. Errors: `404` (item doesn't exist or doesn't belong to `:orderId`), `409
  RETURN_EXCEEDS_PURCHASED_QUANTITY`.
- `GET /api/v1/admin/orders/:orderId/items/:itemId/returns` — same roles. Lists returns for that
  line, newest first.
- **Restocking a returned unit is a separate call** to the pre-existing
  `PATCH /api/v1/admin/stock-items/:id/adjust` (`{ delta, reason }`) - deliberately not automatic;
  see docs/BUSINESS_RULES.md §32.

## Bundle promotions (Phase 5)

Admin configuration only - there is no public "browse bundles" endpoint; a bundle's effect is
visible entirely through `bundleDiscountTotal`/`bundleDiscount` in the cart, checkout quote, and
order responses above. See docs/BUSINESS_RULES.md §31.

- `POST /api/v1/admin/bundles` — `OWNER_ADMIN`/`CATALOG_MANAGER`. Body:
  ```json
  {
    "name": "Two-model case bundle",
    "fixedTotal": 50000, "currency": "EGP",
    "requireDifferentPhoneModels": true, "isRepeatable": true, "allowCouponStacking": false,
    "isEnabled": false, "startsAt": "optional-ISO-8601", "expiresAt": "optional-ISO-8601",
    "eligibleVariants": [ { "variantId": "uuid", "surchargeAmount": 0 } ]
  }
  ```
  `400` if `isEnabled: true` is requested but `fixedTotal`/`currency` are unset, fewer than two
  eligible variants are given, or (when `requireDifferentPhoneModels`) they don't span at least two
  distinct phone models.
- `GET /api/v1/admin/bundles`, `GET /api/v1/admin/bundles/:id` — same roles.
- `PATCH /api/v1/admin/bundles/:id` — same roles and body shape (all fields optional); passing
  `eligibleVariants` fully replaces the existing list. The activation check above is re-run using the
  merged effective state whenever the result would be `isEnabled: true`, even if `isEnabled` itself
  wasn't part of this particular request.
- `DELETE /api/v1/admin/bundles/:id` — same roles, `204`. `400` if the bundle has ever been applied
  to a real order (disable it instead - its `BundleInstance` history must survive for refunds).

## Content: homepage sections and pages (Phase 5)

A small structured CMS - see docs/BUSINESS_RULES.md §30.

- `POST /api/v1/admin/homepage-sections` — `OWNER_ADMIN`/`CATALOG_MANAGER`. Body:
  `{ type?, titleEn?, titleAr?, bodyEn?, bodyAr?, mediaAssetId?, linkUrl?, isEnabled?, displayOrder? }`.
  `404` if `mediaAssetId` doesn't reference an existing `MediaAsset`.
- `GET /api/v1/admin/homepage-sections`, `GET .../homepage-sections/:id`,
  `PATCH .../homepage-sections/:id`, `DELETE .../homepage-sections/:id` (`204`) — same roles.
- `GET /api/v1/homepage-sections?locale=en` — **public**. Returns only `isEnabled: true` sections,
  ordered, with localized `title`/`body` and resolved `media` (`{ url, altText }` or `null`).
- `POST /api/v1/admin/pages` — `OWNER_ADMIN`/`CATALOG_MANAGER`. Body:
  `{ slug, titleEn, titleAr, bodyEn, bodyAr }`. `409 PAGE_SLUG_TAKEN` on a duplicate slug.
- `GET /api/v1/admin/pages`, `GET .../pages/:id`, `PATCH .../pages/:id` — same roles.
- `PATCH /api/v1/admin/pages/:id/status` — `{ status: "DRAFT" | "PUBLISHED" }`, same roles.
- `GET /api/v1/pages?locale=en` — **public**. Lists only `PUBLISHED` pages: `[{ slug, title }]`.
- `GET /api/v1/pages/:slug?locale=en` — **public**. `404` for a `DRAFT` page or a slug that doesn't
  exist - indistinguishable from the outside, exactly like an unpublished `Product`. Returns
  `{ slug, title, body, publishedAt }`.

## Health

- `GET /api/v1/health` — liveness, always `{ "status": "ok" }` once the process is up.
- `GET /api/v1/ready` — readiness, runs `SELECT 1` against Postgres; `503` if the database is
  unreachable.

## Media

- `POST /api/v1/admin/media/upload` — `multipart/form-data`, field name `file`, optional
  `altTextEn`/`altTextAr`. Validates MIME type against an allowlist (JPEG/PNG/WebP/GIF) and decodes
  the file with `sharp` to reject corrupt/mislabeled files, not just trust the declared
  `Content-Type`. Max size is `MEDIA_MAX_FILE_SIZE_BYTES` (default 5 MB).
- `GET /api/v1/admin/media` — list all uploaded assets.
- `DELETE /api/v1/admin/media/:id` — refuses (`400`) if the asset is still attached to any
  product/variant.
- `POST /api/v1/admin/media/products/:productId` / `.../variants/:variantId` — attach an existing
  asset (`{ mediaAssetId, displayOrder?, isPrimary? }`).
- `DELETE /api/v1/admin/media/products/:productId/:mediaAssetId` / the variant equivalent — detach
  (does not delete the underlying asset).

In development, uploaded files are served from `/uploads/<key>` on the same origin (local disk
storage, see `MEDIA_STORAGE_DRIVER=local`). Production object storage (S3-compatible) is a Phase 4
item — setting `MEDIA_STORAGE_DRIVER=s3` today returns a `503` explaining that it isn't implemented
yet, rather than silently behaving like local storage or failing with an unrelated error.
