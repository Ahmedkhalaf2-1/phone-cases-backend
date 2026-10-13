#!/usr/bin/env bash
# Deploys the backend on the VPS: pull, install, build, migrate, (re)start with PM2.
#
# Order matters and is deliberate:
#   1. build BEFORE touching the database, so a broken build never migrates;
#   2. migrate BEFORE restarting, so the new code never boots on an old schema;
#   3. a failed step stops everything - PM2 keeps serving the previous build.
#
# Migrations are applied with `prisma migrate deploy` (never `migrate dev`):
# it only applies already-committed migrations and never resets anything.
#
# Environment overrides:
#   APP_NAME=contrast-backend   PM2 process name (default below)
#   SKIP_MIGRATE=1              skip the migration step entirely
set -Eeuo pipefail

APP_NAME="${APP_NAME:-contrast-backend}"

cd "$(dirname "$(readlink -f "$0")")"
trap 'echo "✗ Deploy failed (line $LINENO). The running app was not restarted." >&2' ERR

step() { printf '\n==> %s\n' "$*"; }

step "Checking prerequisites"
for tool in git node npm npx pm2 curl; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done
node -e 'if (parseInt(process.versions.node, 10) < 20) { console.error("Node >= 20 required, found " + process.versions.node); process.exit(1) }'

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example and fill in real production values." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "There are uncommitted changes to tracked files on this server. Commit or discard them first:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

PREVIOUS_COMMIT="$(git rev-parse --short HEAD)"

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  echo "Detached HEAD: check out a branch (e.g. main) before deploying." >&2
  exit 1
fi

step "Updating code from origin/${BRANCH}"
git fetch origin
echo "Latest on origin/${BRANCH}:"
git log --oneline --decorate -3 "origin/${BRANCH}"
# Fast-forward only: if this server has its own commits the merge is refused
# instead of silently creating a merge commit on the production box.
if ! git merge --ff-only "origin/${BRANCH}"; then
  echo "Cannot fast-forward ${BRANCH} to origin/${BRANCH} (the server has local commits)." >&2
  echo "Resolve that by hand (git log origin/${BRANCH}..HEAD) and re-run." >&2
  exit 1
fi
CURRENT_COMMIT="$(git rev-parse --short HEAD)"
git log -1 --oneline
echo "Deploying ${CURRENT_COMMIT} (was ${PREVIOUS_COMMIT})"

step "Installing dependencies"
# Dev dependencies (Nest CLI, TypeScript, Prisma CLI) are needed to build and migrate.
npm ci

step "Generating the Prisma client"
npx prisma generate

step "Building"
npm run build

step "Database migrations"
if [[ "${SKIP_MIGRATE:-0}" == "1" ]]; then
  echo "SKIP_MIGRATE=1 - skipping. Make sure the schema is already up to date."
else
  echo "Back up PostgreSQL before schema changes (see docs/DEPLOYMENT.md §7)."
  # Lists applied/pending migrations. Nothing is changed by this command.
  npx prisma migrate status || true
  # No-op when nothing is pending; additive otherwise. If it fails the script
  # stops here, BEFORE the app is restarted.
  npx prisma migrate deploy
fi

step "Starting / restarting $APP_NAME"
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  # Existing process: a plain restart, exactly like doing it by hand.
  pm2 restart "$APP_NAME" --update-env
else
  # First deploy only: create the process from ecosystem.config.js.
  pm2 start ecosystem.config.js --only "$APP_NAME"
fi
pm2 save
sleep 3
pm2 status "$APP_NAME"

step "Health check"
PORT="$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2- | tr -d "\"' ")"
PORT="${PORT:-3000}"
BASE="http://127.0.0.1:${PORT}/api/v1"
for attempt in $(seq 1 30); do
  # /ready also checks the database connection.
  if curl -fsS -o /dev/null "${BASE}/ready"; then
    echo "✓ ${APP_NAME} is up and ready on port ${PORT} (commit ${CURRENT_COMMIT})."
    exit 0
  fi
  sleep 2
done

echo "✗ ${APP_NAME} did not become ready. Recent logs:" >&2
pm2 logs "$APP_NAME" --lines 40 --nostream >&2 || true
echo >&2
echo "To roll back the code:  git reset --hard ${PREVIOUS_COMMIT} && ./deploy-backend.sh" >&2
echo "(Applied migrations are additive and are not reverted automatically.)" >&2
exit 1
