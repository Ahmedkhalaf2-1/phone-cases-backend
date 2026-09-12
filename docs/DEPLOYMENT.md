# Deployment and Operational Readiness

Practical guidance for running this API outside a developer's machine. Nothing here is
speculative infrastructure the codebase doesn't already support - it documents how to run what
exists today (a single Node process + PostgreSQL) safely, and calls out the real limitations that
follow from that (no built-in clustering, no distributed job coordination) rather than papering
over them.

## 1. Build and start

```bash
npm ci --omit=dev          # production dependencies only
npm run build               # compiles to dist/
npm run prisma:generate     # regenerate the Prisma client against the built schema
npm run prisma:migrate:deploy   # apply pending migrations - NEVER `migrate dev` in production
npm run start:prod          # node dist/main.js
```

`prisma:migrate:deploy` (not `prisma:migrate:dev`) is the production-safe command: it applies
already-committed migrations without ever prompting, generating a new migration, or resetting
anything. Run it as a separate step before starting the app (a release/predeploy hook, or the first
command in your deploy pipeline) - the app itself does not run migrations on boot.

## 2. Required environment configuration

`src/config/env.validation.ts` fails fast (refuses to boot) on missing/invalid values, and has
extra production-only checks - see it for the authoritative list. The ones most relevant to going
live, beyond what `.env.example` already documents:

| Variable | Production requirement |
|---|---|
| `NODE_ENV` | `production` - enables the stricter startup checks below |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Real random secrets (`openssl rand -base64 48`) - boot refuses any value containing `change-me`, `replace-with`, `example`, or `dev-secret` |
| `PAYMENT_METHOD` | `manual` - the confirmed production setting (cash on delivery + InstaPay manual, see `docs/DECISIONS.md` #2/#29). `mock_dev_only` is refused at startup when `NODE_ENV=production`; `none` is valid but disables public order acceptance entirely |
| `CORS_ORIGINS` | The real storefront origin(s) - no wildcard |
| `MEDIA_STORAGE_DRIVER` | `local` is the only implemented driver today (`s3` fails loudly with `503`, not silently) - see §4 below for what this means operationally |
| `DATABASE_URL` | Points at the production PostgreSQL instance, not the dev/test one |

Do not set `PAYMENT_METHOD=mock_dev_only` in any environment a real customer can reach - it exists
only to unblock local development/e2e tests before a real deployment decision, and is enforced at
startup, not just by convention.

## 3. Process management (no built-in supervisor)

`npm run start:prod` runs one plain Node process. If it crashes (an unhandled exception outside
Nest's exception filter, an OOM kill, a host reboot), nothing restarts it on its own - this
repository does not include a process manager or container orchestration config. Run it under
something that will:

- **systemd** (bare metal / VM): a unit with `Restart=on-failure`, `WorkingDirectory` set to the
  repo root, `EnvironmentFile=/path/to/.env` (or real env vars injected by your secrets manager),
  and `ExecStart=/usr/bin/node dist/main.js`.
- **pm2**: `pm2 start dist/main.js --name phone-cases-backend` with pm2's own restart-on-crash
  behavior. Avoid pm2 **cluster mode** (multiple Node workers) for this app - see §5, the scheduled
  jobs are not safe to run more than once concurrently.
- **A container orchestrator** (Kubernetes, ECS, etc.): run **exactly one replica** until the
  scheduler limitation in §5 is addressed; wire the existing health/readiness endpoints (§6) into
  the platform's own health/readiness probes rather than a custom script.

## 4. File storage must be persistent (and is not yet S3-backed)

Two local directories hold data that exists nowhere else in the system:

- `MEDIA_LOCAL_DIR` (default `uploads/`) - public product images, served directly by the app at
  `/uploads/*`.
- `RECEIPT_LOCAL_DIR` (default `private-uploads/receipts/`) - private InstaPay payment
  screenshots, the actual evidence a customer paid. **Never** served by a public route; only
  reachable through the authenticated/ownership-checked endpoints in `docs/API.md`.

Both are stored on local disk via `MEDIA_STORAGE_DRIVER=local` - the only implemented driver today
(`docs/DECISIONS.md` #12, #32). This has two real operational consequences:

1. **These directories must live on persistent, backed-up storage** - not a container's ephemeral
   filesystem. If you run this in a container, mount a persistent volume at both paths (or
   configure `MEDIA_LOCAL_DIR`/`RECEIPT_LOCAL_DIR` to point at one that's mounted). Losing
   `private-uploads/` loses your only record of what a customer actually transferred.
2. **A multi-replica deployment needs shared storage for these paths** (e.g. a shared network
   volume), or uploads written to one instance won't be readable from another. Combined with §5,
   the current recommendation is a single instance until S3 (or another shared object store) is
   wired up - `MEDIA_STORAGE_DRIVER=s3` already exists as a config value and fails with a clear
   `503` rather than silently misbehaving, but the driver itself is not implemented (planned,
   unverified without real S3 credentials to test against - see `docs/DECISIONS.md` #12).

## 5. Scheduled jobs assume a single instance

`OrderExpiryScheduler` (reservation/order expiry, every 60s) and `ReceiptCleanupScheduler`
(unattached-upload cleanup, every 5min) are `@nestjs/schedule` `@Interval` jobs running **inside
the same Node process** as the API - there is no separate worker process and no distributed lock
between instances.

- **Correctness is not at risk if you run more than one instance**: every state change either job
  makes goes through the same atomic, conditional-UPDATE guards used everywhere else in this
  codebase (`WHERE status = 'ACTIVE'`, `WHERE orderId IS NULL`, etc. - see `docs/BUSINESS_RULES.md`
  §21/§26) - a reservation or receipt can only ever be released/deleted once, no matter how many
  processes race to try.
- **Efficiency is**: with N instances, the same sweep runs N times a minute instead of once,
  doing (bounded, cheap) redundant work each tick. Harmless at small scale, wasteful at larger
  scale.
- **Until this is addressed** (a distributed lock, or moving these two jobs to a single dedicated
  worker/external cron hitting `POST /admin/orders/sweep-expired` instead of running them
  in-process everywhere), run exactly **one** instance of this API, or accept the redundant-work
  tradeoff explicitly if you scale out for request-handling capacity. This mirrors the same
  single-shared-storage constraint in §4 - both point at "one instance for now" as the honest
  current answer, not a scaling story that hasn't been built yet.

## 6. Health, readiness, and monitoring hooks

- `GET /api/v1/health` - liveness: process is up, no dependency checks. Use for a basic
  "is it alive" probe.
- `GET /api/v1/ready` - readiness: runs `SELECT 1` against PostgreSQL, `503` if unreachable. Use
  for a load balancer / orchestrator readiness probe (don't route traffic here until it passes).
- `POST /api/v1/admin/orders/sweep-expired` and the receipt cleanup sweep (no manual-trigger
  endpoint exists for it yet - only the scheduler calls `ReceiptCleanupService` today) can be
  wired into an external monitoring/alerting flow if you want visibility into sweep activity beyond
  the application logs.
- All request logs go to **stdout** via Nest's `Logger` (see `LoggingInterceptor`) - there is no
  built-in file-based log rotation. Capture and rotate stdout at the process-manager or platform
  level (systemd journal, pm2 logs, or your container platform's log driver).

## 7. Backups

- **PostgreSQL**: standard `pg_dump`/continuous-archiving practice for the `DATABASE_URL` database
  - this holds every order, receipt metadata row, and audit log entry. Nothing here is unusual to
    this project.
- **`private-uploads/` (payment receipts)**: back this up with the same rigor as the database - a
  receipt file is the durable evidence behind a `PaymentReceipt` row; losing the file while keeping
  the row leaves a 404 where proof of payment should be, with no way to reconstruct it.
- **`uploads/` (product media)**: back up if product images are not otherwise reproducible from a
  source (e.g. a design asset library) outside this system.

## 8. What this document does not cover (out of scope for this pass)

- Reverse proxy / TLS termination configuration - assumed to be handled by whatever sits in front
  of this app (nginx, a cloud load balancer, etc.); this API itself speaks plain HTTP.
- A Dockerfile / container image - not created speculatively; the run steps in §1 work identically
  inside or outside a container, and adding one without a concrete deployment target to validate it
  against would be exactly the kind of unverified infrastructure `docs/DECISIONS.md` already argues
  against elsewhere (see #12).
- CI/CD pipeline configuration - this repository's `npm run lint` / `npm test` / `npm run test:e2e`
  are the checks a pipeline should run; wiring them into a specific CI provider is left to whoever
  owns that infrastructure.
