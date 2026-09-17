#!/usr/bin/env bash
#
# Builds and deploys the job poller to Azure.
#
#   ./deploy.sh                      deploy to the default app
#   APP=Cron RG=Cron_group ./deploy.sh
#
# Requires the Azure CLI and a login:
#   curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash     # Debian/Ubuntu/WSL
#   az login
#
# v4 programming model: there is no function.json and the folder name means nothing. The
# function's name comes from the app.timer('JobPoll', ...) call in src/index.js, so this
# script just ships the project as-is.
#
# node_modules IS deployed: the v4 model needs @azure/functions at runtime, unlike v3 which
# had no dependencies at all.
set -euo pipefail

APP="${APP:-mhc-job-poll}"
RG="${RG:-Cron_group}"

cd "$(dirname "$0")"

# nvm defines node as a shell function in the interactive shell only, so a script started
# from cron, CI or another shell will not find it on PATH.
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi
command -v node >/dev/null 2>&1 || { echo "node not found on PATH" >&2; exit 1; }
command -v az   >/dev/null 2>&1 || {
    echo "az not found. Install it and log in:" >&2
    echo "  curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash && az login" >&2
    exit 1; }

# Tests first. They run against a real HTTP server and cover every response branch, so a
# failure here means the thing being deployed is broken -- do not ship it.
echo "==> tests"
node test/scenarios.js

echo
echo "==> packaging"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/pkg"
cp -r src          "$STAGE/pkg/src"
cp host.json       "$STAGE/pkg/host.json"
cp package.json    "$STAGE/pkg/package.json"
# Runtime dependencies only -- devDependencies have no business in wwwroot.
( cd "$STAGE/pkg" && npm install --omit=dev --no-audit --no-fund --silent )
# local.settings.json holds credentials and the host ignores it in Azure; test/ has no
# business in wwwroot. Neither is copied, so neither can leak.
( cd "$STAGE/pkg" && zip -qr ../deploy.zip . )
unzip -l "$STAGE/deploy.zip" | sed 's/^/    /'

echo "==> deploying to $APP ($RG)"
az functionapp deployment source config-zip \
    --resource-group "$RG" --name "$APP" --src "$STAGE/deploy.zip"

echo
echo "==> done. Verify with:"
echo "    az webapp log tail -g $RG -n $APP"
echo "  expect: The next 5 occurrences of the schedule ... one minute apart"
echo "  then:   [jobpoll] SUMMARY ok=N | jobsStarted=0 | ...ms total"
