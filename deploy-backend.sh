#!/usr/bin/env bash
# Deploys the backend on the VPS: fetch+merge origin/main, install, build, migrate, (re)start with PM2.
#
# Order matters and is deliberate:
#   1. build BEFORE touching the database, so a broken build never migrates;
#   2. migrate BEFORE restarting, so the new code never boots on an old schema;
#   3. a failed step stops everything - PM2 keeps serving the previous build.
#
# Migrations are applied with `prisma migrate deploy` (never `migrate dev`):
# it only applies already-committed migrations and never resets anything.
#
# Code source: ALWAYS origin/main, regardless of which local branch is checked
# out. The server may sit on its own local branch (e.g. `vps`) that has no
# remote counterpart; that branch is only the place origin/main gets merged
# INTO. The script never checks out, resets, force-moves or pushes branches,
# and never touches untracked files (e.g. a server-only reset.ts).
#
# Environment overrides:
#   APP_NAME=contrast-backend   PM2 process name (default below)
#   DEPLOY_REMOTE=origin        remote to fetch from
#   DEPLOY_BRANCH=main          remote branch to deploy
#   SKIP_MIGRATE=1              skip the migration step entirely
set -Eeuo pipefail

APP_NAME="${APP_NAME:-contrast-backend}"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-origin}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
SOURCE_REF="${DEPLOY_REMOTE}/${DEPLOY_BRANCH}"
export GIT_MERGE_AUTOEDIT=no

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

# Tracked changes (staged or not) could be overwritten by the merge: refuse.
# Untracked files (reset.ts, uploads, ...) are deliberately ignored here.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "There are uncommitted changes to tracked files on this server. Commit or discard them first:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

LOCAL_BRANCH="$(git branch --show-current)"
if [[ -z "$LOCAL_BRANCH" ]]; then
  echo "Detached HEAD: check out the server's branch (e.g. vps) before deploying." >&2
  exit 1
fi
if [[ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ]]; then
  echo "A merge is already in progress on this server. Finish or abort it (git merge --abort) first." >&2
  exit 1
fi

PREVIOUS_COMMIT="$(git rev-parse --short HEAD)"

step "Updating code: ${SOURCE_REF} -> local branch '${LOCAL_BRANCH}'"
git fetch "$DEPLOY_REMOTE"
if ! git rev-parse --verify --quiet "refs/remotes/${SOURCE_REF}" >/dev/null; then
  echo "${SOURCE_REF} does not exist after fetching. Check DEPLOY_REMOTE / DEPLOY_BRANCH." >&2
  exit 1
fi
echo "Latest on ${SOURCE_REF}:"
git log --oneline --decorate -3 "$SOURCE_REF"

LOCAL_ONLY="$(git rev-list --count "${SOURCE_REF}..HEAD")"
if git merge-base --is-ancestor "$SOURCE_REF" HEAD; then
  echo "'${LOCAL_BRANCH}' already contains ${SOURCE_REF}; nothing to merge."
elif git merge-base --is-ancestor HEAD "$SOURCE_REF"; then
  echo "Fast-forwarding '${LOCAL_BRANCH}' to ${SOURCE_REF}."
  git merge --ff-only "$SOURCE_REF"
else
  # The server branch has commits of its own (${LOCAL_ONLY} not on ${SOURCE_REF}),
  # so a fast-forward is impossible - and will stay impossible. This is the
  # normal state for the server branch: record a regular merge commit, exactly
  # like the manual `git merge origin/main`. It is local only; nothing is pushed.
  echo "'${LOCAL_BRANCH}' has ${LOCAL_ONLY} commit(s) not on ${SOURCE_REF}; merging (merge commit)."
  if ! git merge --no-edit "$SOURCE_REF"; then
    # Conflicts, or an untracked file that the merge would overwrite. Put the
    # tree back exactly as it was; the running app has not been touched.
    git merge --abort 2>/dev/null || true
    echo "Merge of ${SOURCE_REF} into '${LOCAL_BRANCH}' was refused and rolled back." >&2
    echo "Nothing changed on this server. Resolve it by hand (git merge ${SOURCE_REF}) and re-run." >&2
    exit 1
  fi
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
echo "Previous commit was ${PREVIOUS_COMMIT}. This script never resets or force-moves branches;" >&2
echo "if you need to go back, do it deliberately by hand, then rebuild and restart." >&2
echo "(Applied migrations are additive and are not reverted automatically.)" >&2
exit 1
