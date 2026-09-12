# Phone Cases Backend

Backend API for a phone cases and accessories ecommerce storefront. Backend-first: this repository
has no frontend. See `docs/SYSTEM_PLAN.md` for architecture and phased scope, `docs/PROGRESS.md` for
current status.

## Stack

Node.js 20+, TypeScript (strict), NestJS 11, PostgreSQL 16, Prisma 7 (driver adapters), REST under
`/api/v1`, OpenAPI/Swagger, Docker Compose for local Postgres, Jest + Supertest for tests.

## Prerequisites

- Node.js 20 or newer
- Docker and Docker Compose
- npm

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy environment config and adjust if needed
cp .env.example .env

# 3. Start local Postgres (dev + test instances)
docker compose up -d postgres postgres_test

# 4. Generate the Prisma client and apply migrations to the dev database
npm run prisma:generate
npm run prisma:migrate:dev

# 5. Seed demo data (creates a bootstrap OWNER_ADMIN staff account from
#    SEED_OWNER_ADMIN_EMAIL / SEED_OWNER_ADMIN_PASSWORD in .env)
npm run seed

# 6. Start the API in watch mode
npm run start:dev
```

The API listens on `PORT` from `.env` (default `3010`, intentionally not `3000` — see
`docs/DECISIONS.md`). Once running:

- Swagger UI: `http://localhost:3010/api/docs`
- Health check: `http://localhost:3010/api/v1/health`

## Running tests

Unit tests (no database required):

```bash
npm test
```

Integration/e2e tests (require the `postgres_test` docker-compose service and its schema):

```bash
docker compose up -d postgres_test
npm run test:e2e:migrate   # apply migrations to the test database
npm run test:e2e
```

`test:e2e:migrate` only needs to be re-run after adding/changing a Prisma migration.

## Useful commands

| Command | Purpose |
|---|---|
| `npm run start:dev` | Run the API with hot reload |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run the compiled build (`node dist/main`) |
| `npm run lint` | ESLint (with `--fix`) |
| `npm run format` | Prettier |
| `npm run prisma:migrate:dev` | Create/apply a dev migration |
| `npm run prisma:migrate:deploy` | Apply pending migrations (CI/production) |
| `npm run prisma:studio` | Browse the database visually |
| `npm run seed` | Apply `prisma/seed.ts` demo data |

## Project documentation

- `docs/SYSTEM_PLAN.md` — architecture, module map, delivery phases
- `docs/DATA_MODEL.md` — entities, constraints, and the inventory-model decision
- `docs/BUSINESS_RULES.md` — pricing, state machines, validation rules actually implemented
- `docs/API.md` — API conventions (pagination, errors, auth, filtering)
- `docs/DECISIONS.md` — assumptions, tradeoffs, and open business questions
- `docs/PROGRESS.md` — what's done, what's blocked, what's next
- `docs/DEPLOYMENT.md` — running this in production: env checklist, process management, file
  storage persistence, and the current single-instance limitation on the scheduled jobs

## Notes on local ports

`docker-compose.yml` maps Postgres to host ports `5544` (dev) and `5545` (test), and the app
defaults to port `3010` — chosen to avoid clashing with services that might already be running on
the conventional `5432`/`5433`/`3000`. Adjust freely in `.env` / `docker-compose.yml` for your own
machine.
