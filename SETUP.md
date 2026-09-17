# Setting up from scratch

Creating the Azure resources and deploying, using only the **Azure Functions extension for
VS Code**. No Azure CLI, no Core Tools, no `npm install -g`.

You need: an Azure subscription you are Owner on, and about ten minutes.

## 0. Once per machine

Install the **Azure Functions** extension (`ms-azuretools.vscode-azurefunctions`) -- it is
already listed in `.vscode/extensions.json`, so VS Code will offer it when you open this
folder. Then sign in: **Azure icon in the sidebar -> Sign in to Azure**.

## 1. Register the storage provider

**This is the one thing the extension cannot do for you**, and skipping it produces a
thoroughly misleading error:

    (SubscriptionNotFound) Subscription <guid> was not found.

which sends you hunting for a login problem that does not exist. A subscription that has
never created a storage account has the provider unregistered. Fix it once, in the portal:

**Subscription -> Settings -> Resource providers -> search `Microsoft.Storage` -> Register**

Never again after that.

## 2. Create the Function App

**Azure sidebar -> Resources -> `+` -> Create Function App in Azure... (Advanced)**

The advanced flow is worth it -- the quick one picks defaults you would have to undo:

| Prompt | Answer |
|---|---|
| Name | `ws-scheduler` -- **globally unique across all of Azure**, not just your subscription |
| Runtime | Node.js 24 (20 is end-of-life and is refused) |
| OS | Linux |
| Plan | Consumption |
| Resource group | `Cron_group` (or create one) |
| Storage account | **create new** -- this is what sets `AzureWebJobsStorage` |
| Application Insights | **create new** -- without it the Monitor tab is blank |
| Region | Southeast Asia |

Creating the storage account here is what avoids `Could not create BlobContainerClient for
ScheduleMonitor`: the timer keeps its state in a blob, and with no storage the handler never
runs at all -- the invocation fails in 0ms.

A deleted app holds its name for a while, so you cannot immediately reuse one you just
removed.

## 3. Configure it

**Azure sidebar -> your app -> Application Settings -> right-click -> Add New Setting**,
once per setting:

    JOB_POLL_TARGETS     [{"name":"uat","url":"https://<host>/mhc/ws-cj/job/due"}]
    JOB_POLL_USER        <user>
    JOB_POLL_PASSWORD    <password>

An app setting **is** `process.env` inside the function -- that is the whole mechanism.

`JOB_POLL_TARGETS` must be **one line** of JSON. Paste it raw here; in
`local.settings.json` the inner quotes need escaping, because there it is JSON inside JSON.
That inconsistency is the portal's, not ours.

Prefer `JOB_POLL_BASIC` with a Key Vault reference for anything but a test:

    JOB_POLL_BASIC = @Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/ws2-basic/)

The code prefers it over user/password. It needs a managed identity with **Get** on the
secret -- and grant that BEFORE setting the value, because a failed resolution is cached for
up to 24 hours and only a restart clears it.

## 4. Deploy

Run the tests first -- nothing in the deploy path does it for you:

    node test/scenarios.js

Then in the **Azure** sidebar, under **Resources -> Function App**, right-click
**`ws-scheduler`** and choose **Deploy to Function App...**

![Deploy to Function App in the Azure sidebar](setup_guide_image/Screenshot%201.jpg)

Confirm the overwrite prompt:

![Confirm the deployment](setup_guide_image/Screenshot%202.png)

"Cannot be undone" means the previous *deployment* is replaced -- the app settings, the
storage account and the `job_schedule` table are all untouched. The credentials warning is
about `JOB_POLL_PASSWORD` living as an app setting; the Key Vault reference in step 3 is the
answer to it.

The preDeployTask then runs, and may report an error:

![preDeployTask warning](setup_guide_image/Screenshot%203.png)

That is the deprecated `--production` flag, not a real failure. npm 10 prints
`npm warn config production Use --omit=dev instead.` to **stderr**, and VS Code treats any
stderr from a task as an error -- while the task itself exits 0 and does its job.
`.vscode/tasks.json` now uses `npm prune --omit=dev`, which is silent, so this dialog should
not appear. If it does, **Deploy Anyway** is safe: the task only strips devDependencies, and
this project has none.

The extension runs `npm install` and ships the folder. `local.settings.json` and `test/` are
excluded by `.funcignore`: the first holds credentials, and neither belongs in `wwwroot`.

Deploying does **not** push app settings. A new setting has to be added in step 3 as well,
or the next run reports `CONFIGURATION ERROR`.

## 5. Check it works

**Azure sidebar -> your app -> Functions -> JobPoll -> right-click -> Execute Function Now**

This fires the timer immediately instead of waiting for the next minute. Then
**right-click -> Start Streaming Logs**.

Healthy output, once a minute:

    [jobpoll] SUMMARY ok=1 | jobsStarted=0 | 60ms total, slowest uat 60ms

And on a night when something is due:

    [jobpoll] uat: STARTED 1 on node=MHCPDC-UWA-C10 [clinic-check] (60ms)
    [jobpoll] JOBS uat=[clinic-check]

Streaming logs drop connections and can print "No new trace in the past 1 min(s)" while the
function is running perfectly well. For the authoritative record use the portal's
**Monitor -> Invocations**, or query Application Insights.

## Reading a failure

The log line names the layer, so you do not have to guess:

| Line | Layer | Fix |
|---|---|---|
| `CONFIGURATION ERROR` | app settings | a setting is missing or malformed |
| `could not connect after ~5000ms` | network | packets dropped -- allowlist the outbound IPs |
| `connected but no response after 25000ms` | the app | stalled database; check `job_schedule` for a row on `lastStatus='RUNNING'` |
| `401 UNAUTHORIZED` | credential | wrong password, or the IP is not allowed in `verifyRequestAuthorize` |
| `404 NOT FOUND` | URL | wrong tenant context path |
| nothing logged at all, `Duration=0ms` | the host | `AzureWebJobsStorage` -- see step 2 |

The distinction between the two timeouts is the useful one: **a dropped connect aborts at
about 5 seconds and never reaches 25**, because Node abandons the attempt regardless of the
configured cap. Five seconds means the packets are not arriving; twenty-five means they are
and the app went quiet.

For the network case you need the app's outbound addresses. The extension does not show
them: **portal -> your app -> Settings -> Properties**, and copy **both** *Outbound IP
addresses* **and** *Additional Outbound IP addresses*. The second list is the one that
catches you -- allowlist only the first and it works until the app moves, which looks
exactly like an intermittent fault.

## Things worth not relearning

- **Log streaming lies.** It drops connections and reports silence while the function runs.
  Trust **Monitor -> Invocations**.
- **The function name comes from `app.timer('JobPoll', ...)`** in `src/index.js`, not from
  the folder. Under the v3 model it was the folder name, which is why moving files used to
  rename the function.
- **There is no `function.json` under v4.** The schedule and `useMonitor` are in that same
  `app.timer` call, so the portal's Integration UI cannot silently rewrite them -- which is
  what used to drop `useMonitor` and bring the ScheduleMonitor failure back.
- **Node 20 is end-of-life** (April 2026); creation is refused. Use 24.
