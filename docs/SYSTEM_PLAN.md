# System Plan

## 1. Purpose

Backend for an ecommerce storefront selling phone cases and related accessories, inspired by the
business functionality of incase1.com but independently designed. This document describes the
architecture, scope, and delivery phases. It is a living document — update it as decisions change.

The business owner supplies product photography, artwork, and marketing content. This codebase is
responsible for software, data modeling, media storage/serving, and business logic — not for
generating creative content.

## 2. Architecture

**Style:** modular monolith. One deployable Nest application, organized into modules with clear
boundaries (`src/modules/*`), each owning its own controllers/services/DTOs. Modules talk to each
other through injected services, not by reaching into each other's Prisma queries directly, except
where a shared read (e.g. "does this product exist") is cheap and obviously safe to inline.

**Why not microservices:** the team is small, the domain is one cohesive storefront, and the
instructions explicitly ask to avoid unnecessary infrastructure. A modular monolith gives clean
seams for a future split (e.g. extracting payments) without paying the operational cost now.

**Stack:**

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 20+ (LTS) | Required by NestJS 11/Prisma 7 tooling |
| Language | TypeScript 5.9, strict mode | Type safety across DTOs/Prisma models |
| Framework | NestJS 11 | Modular DI, guards/pipes/interceptors, mature ecosystem |
| Database | PostgreSQL 16 | Relational integrity, transactions, JSON columns, mature |
| ORM | Prisma 7 (driver adapters, `@prisma/adapter-pg`) | Type-safe queries, migrations, transactions |
| API style | REST under `/api/v1` | Simple, cacheable, matches instructions |
| Docs | `@nestjs/swagger` (OpenAPI) | Generated from decorators, always in sync with code |
| Auth | JWT access tokens + opaque rotating refresh tokens | Stateless verification, revocable sessions |
| Media (dev) | Local filesystem, served via Express static | Zero infra for local development |
| Media (prod) | Pluggable driver interface, S3 implementation deferred to Phase 4 | Avoid unverified cloud deps before they're needed |
| Local infra | Docker Compose (Postgres dev + test instances) | Reproducible, isolated from host Postgres |
| Tests | Jest + Supertest against a real Postgres test database | Integration-level confidence for transactional logic |

**Why NestJS 11, not 12:** at the time of writing, `@nestjs/throttler`, `@nestjs/passport`,
`@nestjs/jwt` and `@nestjs/swagger` had not yet published versions compatible with `@nestjs/core@12`.
Using v12 would have required `--legacy-peer-deps` or dropping rate limiting. v11 is the newest line
with full first-party ecosystem support. See `docs/DECISIONS.md`.

**Why Prisma 7 driver adapters:** Prisma 7 removed the `datasource.url` field from `schema.prisma` —
the connection string is now supplied to `PrismaClient` via a driver adapter (`@prisma/adapter-pg`)
at runtime, and to the Prisma CLI via `prisma.config.ts`. See `src/prisma/prisma.service.ts` and
`prisma.config.ts`.

## 3. Module map (Phase 1)

```
src/
  config/            env validation (class-validator based)
  common/            cross-cutting: guards, decorators, filters, interceptors, DTOs, i18n helpers
  prisma/            PrismaService (global module)
  modules/
    auth/            staff login/refresh/logout, JWT strategy
    staff/           staff account CRUD (OWNER_ADMIN only)
    audit-log/       append-only sensitive-action log + admin read endpoint
    catalog/
      phone-brands/  taxonomy: brand
      phone-models/  taxonomy: model (belongs to a brand)
      case-types/    taxonomy: case type
      collections/   merchandising groupings of products
      products/      the sellable "design" entity; admin CRUD + public read
      variants/      purchasable SKU (product × phone model × case type)
      media/         upload, storage driver abstraction, product/variant attachment
    inventory/
      stock-items/   physical stock counter (Phase 1: CRUD + atomic adjust only)
    promotions/
      coupons/       fixed/percentage discount codes
      bundles/       configurable two-item bundle promotions (Phase 5)
    content/
      homepage-sections/  homepage banners/sections (Phase 5)
      pages/              slug-based informational pages (Phase 5)
    orders/
      refunds/       manual refund + item-return administration (Phase 5)
    health/          liveness/readiness probes
```

Public routes: no prefix beyond `/api/v1` (e.g. `/api/v1/products`).
Admin routes: `/api/v1/admin/...`, guarded by `JwtAuthGuard` + `RolesGuard`.
Webhook routes: none yet (Phase 4, payments).

## 4. Delivery phases

- **Phase 1 — Foundation and catalog** (this delivery): repo setup, config validation, Postgres +
  Prisma + migrations, staff auth (JWT access + rotating refresh), RBAC, full catalog domain
  (brands/models/case types/collections/products/variants/media), public catalog browsing/search/
  filter/sort/pagination, audit log, basic stock counters, seed data, OpenAPI docs, integration
  tests.
- **Phase 2 — Purchase rules**: reservations and stock movement history, guest carts, pricing
  engine, coupons, shipping rate quotation. (The bundle/"choose N" promotion originally scoped here
  was deferred to Phase 5, once the business decisions it needed were answered as configuration.)
- **Phase 3 — Orders**: checkout revalidation and quotes, idempotent order creation, immutable
  order snapshots, fulfillment/payment status machines, admin order operations, secure guest order
  tracking.
- **Phase 4 — Payments and operational readiness**: manual payment methods (cash on delivery,
  InstaPay manual with staff-verified screenshots) implemented; a real online payment gateway
  remains out of scope by decision, not a gap. Security review, deployment docs.
- **Phase 5 — Checkout/order correctness hardening, CMS, bundle promotions, manual refunds**: closed
  a specific list of concurrency/correctness findings across checkout, order status transitions,
  reservation expiry, receipt review, and refresh-token rotation; fixed a public-catalog boolean
  query bug and two storefront-media gaps; delivered the previously-deferred bundle promotion
  (disabled until an owner configures real values), a small structured CMS (homepage sections +
  informational pages), and minimal staff-only manual refund/return administration. See
  `docs/PROGRESS.md`, `docs/DECISIONS.md` #34-44, and `docs/BUSINESS_RULES.md` §27-32.
- **Phase 6 — Optional extensions**: customer accounts, wishlists, moderated reviews, back-in-stock
  notifications, personalization. Explicitly out of scope until the core purchase flow is solid.

Do not present a phase's endpoints as complete before that phase has been implemented and tested.

## 5. Cross-cutting conventions

- All money is stored as **integer minor units** (e.g. piastres for EGP) with an explicit
  `currency` column. No floating-point arithmetic for money, anywhere.
- All list endpoints are paginated (`page`, `pageSize`, bounded by `MAX_PAGE_SIZE`) and return a
  `{ items, meta }` envelope.
- All error responses share one shape: `{ statusCode, code, message, correlationId, timestamp, path }`.
  `code` is a stable machine-readable string; `message` is human-readable.
- Every request gets an `x-request-id` (generated if the client didn't send one), echoed in the
  response header and in the error body's `correlationId`, and included in structured logs.
- Bilingual content (`nameEn`/`nameAr`, `descriptionEn`/`descriptionAr`) is stored as separate
  columns, not a JSON blob — see `docs/DATA_MODEL.md` for the fallback rule.
