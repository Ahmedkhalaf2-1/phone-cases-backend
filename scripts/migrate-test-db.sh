#!/usr/bin/env bash
# Applies existing Prisma migrations to the e2e test database
# (TEST_DATABASE_URL in .env, the docker-compose "postgres_test" service by
# default). Run before `npm run test:e2e` whenever migrations have changed.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env file found. Copy .env.example to .env first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo "TEST_DATABASE_URL is not set in .env" >&2
  exit 1
fi

DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
