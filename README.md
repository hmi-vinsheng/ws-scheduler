# WS-Scheduler

Timer-triggered Azure Function that drives the MHC application's scheduled jobs.

Deployed as the Azure Function App **`mhc-job-poll`** (resource group `Cron_group`,
Southeast Asia). The repo name and the app name differ deliberately -- `deploy.sh` targets
the app, and both are overridable with `APP=` / `RG=`.

Every minute it POSTs `/<tenant>/ws-cj/job/due` to each app instance. The instance reads
`job_schedule` in that tenant's own database and runs whatever is outstanding — so this
function holds **no schedule of its own**. It is a heartbeat.

Changing when a job runs is an `UPDATE` against `job_schedule`; this function is deployed
once and left alone. See `docs/adr/0003-external-scheduler-for-cronjobs.md` in the
`mhc-mh-devops-2` repo for why the trigger lives outside the application.

## Setting up from scratch

See **[SETUP.md](SETUP.md)** -- creating the Azure resources, the three gotchas that cost an
afternoon (unregistered storage provider, Node 20 EOL, globally-unique app names), and how
to read a failure back to the layer it came from.

## Programming model

Written for the **v3 model** — `module.exports = async function (context, myTimer)` with a
`function.json` per folder — to match the existing `Cron` Function App. v3 and v4
(`app.timer(...)`) cannot coexist in one app, so do not mix them.

**No dependencies.** It uses only Node's `http`/`https` core modules, so there is no
`npm install`, it runs on any Node version the Function App is on, and the two files can be
pasted straight into the portal editor.

## Testing

Four levels, cheapest first. Levels 1 and 2 need nothing but Node — no Azure, no
storage account, no Tomcat, no database.

### 1. Assert every branch (~2s)

    node test/scenarios.js
    node test/scenarios.js --slow     # adds the 25s request-timeout case

Starts a real HTTP server on a random port and drives the handler against it, so the
request building, the `Authorization` header and the timeout are all exercised for
real rather than mocked. 35 checks: nothing due, jobs started, 429, 401, 404, 500, an
HTML error page, unreachable, a mixed run, past due, and each configuration error.

The assertions are mostly about **log levels**, which is the part easy to break:

- a routine idle poll must stay `verbose` (~4,300 lines a day per target otherwise)
- an unreachable target must be `warn`, never `error` — DR is unreachable by design,
  every minute, and must not page anyone
- a misconfigured target must be `error` and must appear in `ATTENTION`
- a config error must **throw**, so the invocation is marked failed
- a per-target failure must **not** throw — one bad box cannot stop the others

### 2. Run it once, by hand

    node test/run-local.js                                                   # uses local.settings.json
    node test/run-local.js --target http://localhost:8099/ok/ws-cj/job/due
    node test/run-local.js --past-due
    node test/run-local.js --verbose                                         # show verbose lines

Calls the handler directly with a fake `context`. No timer to wait for. Reads
`local.settings.json` the same way `func start` does, and anything already in the
environment wins, so you can override one value without editing the file.

To exercise responses you cannot easily produce for real, run the stand-in app in
another terminal:

    node test/fake-app.js 8099

The path picks the response — `/ok`, `/started`, `/busy`, `/401`, `/404`, `/500`,
`/html`, `/slow`.

### 3. Against the real application

Point it at a box running the app. This is the end-to-end test that matters, because
it is the only one that proves the credential, the network path and the tenant context
path are all right:

    node test/run-local.js --target http://localhost:8080/mhc/ws-cj/job/due --verbose

with a real credential in the environment:

    JOB_POLL_USER=<user> JOB_POLL_PASSWORD=<pw> node test/run-local.js --target ...

To make it actually start something, enable one harmless row first:

    UPDATE job_schedule SET enabled = 'Y', cronExpr = '0 * * * * ?' WHERE jobName = 'clinic-check';

You should get `STARTED 1 on node=<hostname> [clinic-check]`, and the row should show
`lastRunBy='SCHEDULER'` with a fresh `lastRunAt`. Set `enabled` back to `'N'` after.

### 4. In Azure

Once deployed, **Code + Test -> Test/Run -> Run** fires the timer immediately instead of
waiting for the next minute, and the log pane shows the output live. Or from the CLI:

    curl -X POST "https://<app>.azurewebsites.net/admin/functions/JobPoll" \
      -H "x-functions-key: <master key>" \
      -H "Content-Type: application/json" -d '{"input":""}'

If the invocation fails in **0ms** with `Could not create BlobContainerClient for
ScheduleMonitor`, the handler never ran: that is `AzureWebJobsStorage`, not this code.

### Known-good output

A quiet minute, which is almost every minute:

    [jobpoll] SUMMARY ok=4 | jobsStarted=0 | 63ms total, slowest ge@appsvr01 41ms

A night when something ran:

    [jobpoll] mhc@appsvr01: STARTED 2 on node=APPSVR01 [payment-batch, sftp-audit] (118ms)
    [jobpoll] SUMMARY ok=4 | jobsStarted=2 | 141ms total, slowest mhc@appsvr01 118ms
    [jobpoll] JOBS mhc@appsvr01=[payment-batch, sftp-audit]

## Deploy

    ./deploy.sh

Runs the test suite, packages `JobPoll/` plus `host.json`, and zip-deploys to Azure. It
refuses to deploy if a test fails, so a broken build cannot reach the Function App.

Override the target with environment variables:

    APP=Cron RG=Cron_group ./deploy.sh
    FUNC_NAME=JobPoll ./deploy.sh

**Prerequisites** -- the Azure CLI and a login, once per machine:

    curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash     # Debian/Ubuntu/WSL
    az login

Azure Functions Core Tools (`func`) is *not* needed. The script uses
`az functionapp deployment source config-zip`, which is one dependency instead of two.

### What gets deployed

    host.json
    TimerTrigger1/function.json      the timer binding
    TimerTrigger1/index.js           the handler

The **folder name inside the zip becomes the function name in Azure**. It is deployed as
`TimerTrigger1` so the admin URL, portal Test/Run and existing Application Insights queries
keep working; set `FUNC_NAME` to change it.

`local.settings.json` and `test/` are never packaged -- the first holds credentials, and
neither belongs in `wwwroot`.

### Without the CLI

Portal -> Function App -> **Advanced Tools -> Go** -> **Tools -> Zip Push Deploy**, then drag
the zip in. Nothing to install, and no credentials beyond being signed in to the portal.

Pasting into **Code + Test** works too, but put the code in the function's *own* `index.js`.
A file that `require`s another folder will fail with `Cannot find module`, because only the
one function folder is deployed.

## Change the schedule to once a minute

The existing `TimerTrigger1` is `0 */5 * * * *`, i.e. every 5 minutes. That is too slow: a
job due at 20:30 could be polled at 20:32 and, while the grace window would still run it,
5-minute gaps leave a lot of room for drift. `function.json` here reads the schedule from
an app setting so it can be changed without a redeploy:

    JOB_POLL_SCHEDULE = 0 * * * * *        once a minute, on the minute

NCRONTAB is 6 fields — `second minute hour day month day-of-week`. Every 30 seconds would
be `*/30 * * * * *`, worth it only if invocations are actually being lost.

## App settings

| Setting | Required | Notes |
|---|---|---|
| `JOB_POLL_TARGETS` | yes | JSON array of `{name, url}` — one per (tenant x app server) that exists |
| `JOB_POLL_BASIC` | yes* | base64 of `user:password` for `verifyRequestAuthorize`. Use a Key Vault reference |
| `JOB_POLL_USER` / `JOB_POLL_PASSWORD` | * | alternative to `JOB_POLL_BASIC`, convenient locally |
| `JOB_POLL_SCHEDULE` | no | NCRONTAB, defaults to `0 * * * * *` (once a minute). `*/30 * * * * *` for every 30s |

`JOB_POLL_TARGETS` must be **one line** — an app setting is a string, so paste the JSON
with no line breaks. This is the value, exactly as it goes in the portal:

    [{"name":"mhc@appsvr01","url":"http://appsvr01:8080/mhc/ws-cj/job/due"},{"name":"mhc@appsvr02","url":"http://appsvr02:8080/mhc/ws-cj/job/due"},{"name":"mhc@appsvr03","url":"http://appsvr03:8080/mhc/ws-cj/job/due"},{"name":"ge@appsvr01","url":"http://appsvr01:8080/ge/ws-cj/job/due"}]

which is this, wrapped only for reading:

    [
      {"name":"mhc@appsvr01","url":"http://appsvr01:8080/mhc/ws-cj/job/due"},
      {"name":"mhc@appsvr02","url":"http://appsvr02:8080/mhc/ws-cj/job/due"},
      {"name":"mhc@appsvr03","url":"http://appsvr03:8080/mhc/ws-cj/job/due"},
      {"name":"ge@appsvr01", "url":"http://appsvr01:8080/ge/ws-cj/job/due"}
    ]

And the credential:

    JOB_POLL_BASIC = @Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/ws2-basic/)

Setting an app setting **restarts the Function App**, which is fine — but the value is not
live until it has.

To just get the function running end to end, one target and a plain credential are enough:

    JOB_POLL_TARGETS = [{"name":"test","url":"http://<host>:8080/mhc/ws-cj/job/due"}]
    JOB_POLL_USER    = <user>
    JOB_POLL_PASSWORD = <password>

Targets are configuration, not code: adding a tenant or an app server is an app-setting
change with no redeploy.

## DR

Create the DR targets and **leave them out of `JOB_POLL_TARGETS` until failover**. That is
the only thing stopping DR from running jobs against its own database, because prod and DR
have separate databases and nothing in the application can coordinate the two sites.

Adding them back is the failover switch — no restart, no change on any app box.

## Logging

Every line is prefixed `[jobpoll]`, so Application Insights can be filtered to just this
function:

    traces | where message startswith "[jobpoll]"
    traces | where message contains "STARTED"      -- what actually ran
    traces | where message contains "ATTENTION"    -- misconfigured targets, needs a human
    traces | where message contains "NOT POLLED"   -- unreachable, expected for DR
    traces | where message contains "SUMMARY"      -- one line per invocation

| Line | Level | When |
|---|---|---|
| `polling N target(s) on schedule "..."` | verbose | every invocation |
| `<target>: idle, nothing due on node=X` | **verbose** | ~99% of polls. Kept out of info so App Insights is not thousands of "nothing happened" lines a day |
| `<target>: STARTED n on node=X [job, job]` | info | a job actually ran, named |
| `<target>: BUSY, a previous poll is still in flight` | info | 429 — the app refusing to stack up blocked threads |
| `<target>: NOT POLLED -- <reason>` | warn | unreachable or timed out. **Expected for DR** |
| `<target>: 401 UNAUTHORIZED ...` | error | credential or IP allowlist |
| `<target>: 404 NOT FOUND ...` | error | wrong tenant context path, or that tenant is not on that box |
| `SUMMARY ok=2 unreachable=1 \| jobsStarted=0 \| 24ms total, slowest ...` | info | one per invocation — the aliveness signal |
| `JOBS <target>=[job, job]` | info | only when something ran |
| `ATTENTION n target(s) misconfigured or failing` | error | 401 / 404 / 5xx. Deliberately **excludes** unreachable, so DR does not page anyone |
| `run took Nms, close to the polling interval` | warn | the run risks overlapping the next minute |
| `CONFIGURATION ERROR: ...` | error + **throws** | bad `JOB_POLL_TARGETS` or missing credential |

To see the idle lines while debugging, raise the level in `host.json`:

    "logging": { "logLevel": { "default": "Trace" } }

The Authorization header is never logged, and URLs are logged host+path only.

## Responses

| Status | Meaning | Logged as |
|---|---|---|
| `202` | accepted; the app runs the job on a background thread | info, with the body |
| `429` | a previous poll on that instance has not returned (stalled database). **Normal** | info |
| `401` | wrong credential, or this function's outbound IP is not allowlisted in `verifyRequestAuthorize` | error |
| timeout / refused | that instance was not polled this minute | warn |
| bad configuration | throws, so the invocation fails and surfaces in Application Insights | error |

A failed target never fails the invocation: an Azure retry cannot help, because the
application's due check asks "is there an outstanding occurrence within the grace period"
rather than "is this the exact minute". The next successful poll picks the job up.

**Unreachable is a warning, not an error**, because DR instances are unreachable by design.
Alert instead on a stale `job_schedule.lastRunAt` — that catches an unreachable box *and* a
dead function, which these logs cannot:

    SELECT jobName, cronExpr, lastRunAt FROM job_schedule
     WHERE enabled = 'Y' AND (lastRunAt IS NULL OR lastRunAt < DATEADD(day, -2, GETDATE()));

## Notes

- Timer triggers are **singleton** — even if the Function App scales out, a blob lease means
  only one instance runs the timer. No duplicate polling from Azure's side.
- The function needs a **network path into the data centre** (VNet integration plus VPN or
  ExpressRoute) to reach `appsvr01:8080`. This is the real prerequisite.
- A Premium plan with a NAT gateway gives a predictable outbound IP, which makes the
  `verifyRequestAuthorize` allowlist far easier than Consumption's shared ranges.
