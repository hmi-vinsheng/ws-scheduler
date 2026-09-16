# Setting up the job poller from scratch

Everything below was run to build the live `mhc-job-poll` app. Copy-paste it in order and
you get an identical one.

You need: an Azure subscription you are Owner on, and about ten minutes.

## 0. Tools, once per machine

    pipx install azure-cli
    az login --use-device-code

`pipx` installs to your home directory, so no `sudo` -- which matters on a locked-down work
laptop. The official `curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash` works too if
you have root.

`--use-device-code` matters in WSL: plain `az login` tries to open a Linux browser that is
not there. It prints a code, you paste it into a browser on Windows.

Check you landed in the right place:

    az account show --query "{sub:name, id:id}" -o table

## 1. Register the storage provider

    az provider register -n Microsoft.Storage --wait

**Do this first.** A subscription that has never created a storage account has this
provider unregistered, and every storage command then fails with:

    (SubscriptionNotFound) Subscription <guid> was not found.

which sends you hunting for a login or subscription problem that does not exist. One time
per subscription, then never again.

## 2. Create the resources

    RG=Cron_group
    LOC=southeastasia
    APP=mhc-job-poll
    STORAGE=mhccronstore$RANDOM      # 3-24 chars, lowercase and digits, globally unique

    az group create -n $RG -l $LOC

    az storage account create -n $STORAGE -g $RG -l $LOC --sku Standard_LRS

    az functionapp create -n $APP -g $RG -s $STORAGE \
      --consumption-plan-location $LOC \
      --runtime node --runtime-version 24 --functions-version 4

Three things that will bite you:

- **The app name is globally unique across all of Azure**, not just your subscription.
  `Cron` is taken. A deleted app also holds its name for a while, so you cannot immediately
  reuse one you just removed.
- **Node 20 is end-of-life** (April 2026) and `functionapp create` refuses it outright. Use
  24. The handler is plain CommonJS with core modules, so the version does not matter to it.
- **Creating the storage account here is what sets `AzureWebJobsStorage` correctly.** Skip
  it, or point at a dead account, and the timer fails at startup with
  `Could not create BlobContainerClient for ScheduleMonitor` -- the handler never runs, and
  the invocation fails in 0ms.

Application Insights is created automatically and wired up. You need it: Function Apps log
there, not to the filesystem, so `az webapp log tail` shows nothing useful.

## 3. Configure it

    az functionapp config appsettings set -n $APP -g $RG --settings \
      'JOB_POLL_TARGETS=[{"name":"uat","url":"https://www-uat-33.mhcasia.net/mhc/ws-cj/job/due"}]' \
      'JOB_POLL_USER=<user>' \
      'JOB_POLL_PASSWORD=<password>'

An app setting **is** `process.env` inside the function -- that is the whole mechanism.
`JOB_POLL_TARGETS` must be one line of JSON; in the portal you paste it raw, but in
`local.settings.json` the inner quotes need escaping, because there it is JSON inside JSON.

Setting these restarts the app. That is fine, and it is required -- the value is not live
until it has.

## 4. Deploy

    ./deploy.sh

Runs the tests, packages, and zip-deploys. It refuses to deploy if a test fails.

Override the target without editing anything:

    APP=other-app RG=other-rg ./deploy.sh

## 5. Check it works

Trigger it immediately rather than waiting for the next minute:

    KEY=$(az functionapp keys list -n $APP -g $RG --query masterKey -o tsv)
    curl -X POST "https://$APP.azurewebsites.net/admin/functions/TimerTrigger1" \
      -H "x-functions-key: $KEY" -H "Content-Type: application/json" -d '{"input":""}'

A `202` means accepted, not that the poll succeeded -- read the logs for that. Give
Application Insights a couple of minutes; `requests` appear before `traces` do.

    az monitor app-insights query --app $APP -g $RG --analytics-query \
      "traces | where timestamp > ago(30m) | where message startswith '[jobpoll]' \
       | project timestamp, message | order by timestamp asc" \
      --query "tables[0].rows" -o tsv

Healthy output, once a minute:

    [jobpoll] SUMMARY ok=1 | jobsStarted=0 | 60ms total, slowest uat 60ms

And on a night when something is due:

    [jobpoll] uat: STARTED 1 on node=MHCPDC-UWA-C10 [clinic-check] (60ms)
    [jobpoll] JOBS uat=[clinic-check]

Confirm the schedule was registered as you meant:

    az functionapp function list -n $APP -g $RG \
      --query "[].{name:name, schedule:config.bindings[0].schedule, useMonitor:config.bindings[0].useMonitor}" -o table

## Reading a failure

The log line names the layer, so you do not have to guess:

| Line | Layer | Fix |
|---|---|---|
| `CONFIGURATION ERROR` | app settings | a setting is missing or malformed |
| `could not connect after ~5000ms` | network | firewall dropping packets -- allowlist the outbound IPs |
| `connected but no response after 25000ms` | the app | stalled database; check `job_schedule` for a row on `lastStatus='RUNNING'` |
| `401 UNAUTHORIZED` | credential | wrong password, or the IP is not allowed in `verifyRequestAuthorize` |
| `404 NOT FOUND` | URL | wrong tenant context path |
| nothing logged at all, `Duration=0ms` | the host | `AzureWebJobsStorage` -- see step 2 |

The distinction between the two timeouts is the useful one: **a dropped connect aborts at
about 5 seconds and never reaches 25**, because Node abandons the attempt regardless of the
configured cap. Five seconds means the packets are not arriving; twenty-five means they are
and the app went quiet.

If the network one shows up, get the outbound addresses and have them allowlisted:

    az functionapp show -n $APP -g $RG --query possibleOutboundIpAddresses -o tsv

Use `possibleOutboundIpAddresses`, not `outboundIpAddresses`. The second is only what is in
use right now; the app moves within the first set when it scales, and allowlisting only the
active few produces a maddening "works sometimes" pattern.

## Things worth not relearning

- **Log stream lies.** It drops connections and prints `No new trace in the past 1 min(s)`
  while the function is running fine. Trust **Monitor -> Invocations** or the query above.
- **The Integration UI rewrites `function.json`** and can drop properties it does not know
  about, including `useMonitor`. Edit `function.json` directly, or deploy with `deploy.sh`.
- **The folder name inside the zip becomes the function name in Azure.** Only that one
  folder is deployed, so an `index.js` that `require`s a sibling folder fails with
  `Cannot find module`.
- **Portal edits to `function.json` do not always reload the host.** Restart after one.
