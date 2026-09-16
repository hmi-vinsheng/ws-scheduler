#!/usr/bin/env bash
#
# Builds and deploys the job poller to Azure.
#
#   ./deploy.sh                      deploy to the default app
#   APP=Cron RG=Cron_group ./deploy.sh
#   FUNC_NAME=JobPoll ./deploy.sh    deploy under a different function name
#
# Requires the Azure CLI and a login:
#   curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash     # Debian/Ubuntu/WSL
#   az login
#
# The function's source of truth is JobPoll/. The folder name inside the zip decides the
# function's name in Azure, and it is deployed as TimerTrigger1 so the admin URL, Test/Run
# and the existing Application Insights queries keep working. Set FUNC_NAME to change it.
set -euo pipefail

APP="${APP:-mhc-job-poll}"
RG="${RG:-Cron_group}"
FUNC_NAME="${FUNC_NAME:-TimerTrigger1}"

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
mkdir -p "$STAGE/pkg/$FUNC_NAME"
cp JobPoll/index.js      "$STAGE/pkg/$FUNC_NAME/index.js"
cp JobPoll/function.json "$STAGE/pkg/$FUNC_NAME/function.json"
cp host.json             "$STAGE/pkg/host.json"
# local.settings.json holds credentials and the host ignores it in Azure; test/ has no
# business in wwwroot. Neither is copied, so neither can leak.
( cd "$STAGE/pkg" && zip -qr ../deploy.zip . )
unzip -l "$STAGE/deploy.zip" | sed 's/^/    /'

echo "==> deploying to $APP ($RG) as function '$FUNC_NAME'"
az functionapp deployment source config-zip \
    --resource-group "$RG" --name "$APP" --src "$STAGE/deploy.zip"

echo
echo "==> done. Verify with:"
echo "    az webapp log tail -g $RG -n $APP"
echo "  expect: The next 5 occurrences of the schedule ... one minute apart"
echo "  then:   [jobpoll] SUMMARY ok=N | jobsStarted=0 | ...ms total"
