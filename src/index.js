const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Drives the MHC application's scheduled jobs.
 *
 * Every minute this POSTs /<tenant>/ws-cj/job/due to each app instance. The instance reads
 * job_schedule in that tenant's own database and runs whatever is outstanding, so this
 * function holds no schedule of its own -- it is a heartbeat. Changing when a job runs is
 * an UPDATE against job_schedule; this function is deployed once and left alone.
 *
 * Targets come from the JOB_POLL_TARGETS app setting, so adding a tenant or an app server
 * is a configuration change with no redeploy.
 *
 * Uses only Node core modules (http/https) rather than fetch or axios, so it runs on any
 * Node version the Function App happens to be on and can be pasted straight into the
 * portal editor with no npm install.
 */

/** Per-request timeout. Must stay well under functionTimeout. */
const REQUEST_TIMEOUT_MS = 25000;

/**
 * Prefix on every line, so Application Insights can be filtered to just this function:
 *
 *   traces | where message startswith "[jobpoll]"
 *   traces | where message contains "STARTED"        -- nights when something ran
 *   traces | where message contains "NOT POLLED"     -- unreachable instances
 */
const TAG = '[jobpoll]';

/** host and path only -- never log the Authorization header or query string. */
function safeUrl(raw) {
    try {
        const u = new URL(raw);
        return `${u.host}${u.pathname}`;
    } catch (e) {
        return '(unparseable url)';
    }
}

/**
 * Pulls the interesting fields out of the app's response so log lines can name the node
 * and the jobs rather than echoing raw JSON. Falls back to the raw body if it is not the
 * shape we expect -- a misrouted call could return an HTML error page.
 *
 * The app answers:  {"node":"APPSVR01","status":"1 started","detail":"[clinic-check]"}
 */
function describe(body) {
    try {
        const j = JSON.parse(body);
        const started = parseInt(String(j.status || '').match(/^(\d+)/) ? RegExp.$1 : '0', 10) || 0;
        // detail arrives as "[a, b]" -- strip the brackets to get usable names
        const names = String(j.detail || '')
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map(function (n) { return n.trim(); })
            .filter(Boolean);
        return { node: j.node || '?', started: started, names: names, raw: body };
    } catch (e) {
        return { node: '?', started: 0, names: [], raw: body };
    }
}

/**
 * POST with no body. Resolves with {status, body}; rejects only on a transport failure.
 *
 * Two different failures both surface as a timeout, and telling them apart is most of the
 * diagnosis, so the error says which:
 *
 *   no TCP handshake   packets are being dropped -- a firewall silently discarding them,
 *                      which is what an IP allowlist looks like from the outside. Node
 *                      abandons the connect attempt at roughly 5s regardless of the value
 *                      passed here, so this fails fast and timeoutMs never governs it.
 *   connected, silent  the handshake succeeded and the app then said nothing. A stalled
 *                      database or a hung request thread. This is what timeoutMs caps.
 *
 * Left entirely alone, a dropped-packet connect sits in SYN retry for ~135s -- longer than
 * the 2 minute functionTimeout -- so the cap matters even though it rarely fires.
 */
function post(rawUrl, authHeader, timeoutMs) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        let connected = false;
        let url;
        try {
            url = new URL(rawUrl);
        } catch (e) {
            reject(new Error(`bad url: ${rawUrl}`));
            return;
        }

        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(
            {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: { Authorization: authHeader, 'Content-Length': 0 }
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                // Cap what we keep: the app's response is small, but a misrouted call
                // could return an HTML error page and there is no reason to hold it.
                res.on('data', (chunk) => {
                    if (body.length < 500) body += chunk;
                });
                res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 300) }));
            }
        );

        // Report what actually happened rather than the configured cap: the two differ,
        // because a dropped connect aborts well before timeoutMs.
        req.on('socket', (socket) => {
            // A socket taken from the agent's keep-alive pool is already connected and
            // will never emit 'connect', so checking the flag alone would report a stalled
            // app as a dropped packet -- the exact confusion this is here to prevent.
            if (!socket.connecting) { connected = true; return; }
            socket.on('connect', () => { connected = true; });
        });
        req.setTimeout(timeoutMs, () => {
            const waited = Date.now() - startedAt;
            const why = connected
                ? `connected but no response after ${waited}ms -- the app is not answering ` +
                  `(stalled database? check job_schedule for a row on lastStatus='RUNNING')`
                : `could not connect after ${waited}ms -- no TCP handshake, packets are ` +
                  `being dropped (firewall or IP allowlist?)`;
            req.destroy(Object.assign(new Error(why), { timedOut: true }));
        });
        req.on('error', reject);
        req.end();
    });
}

function readTargets() {
    const raw = process.env.JOB_POLL_TARGETS;
    if (!raw || !raw.trim()) {
        throw new Error(
            'JOB_POLL_TARGETS is not set. Expected a JSON array, e.g. ' +
            '[{"name":"mhc@appsvr01","url":"http://appsvr01:8080/mhc/ws-cj/job/due"}]'
        );
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(`JOB_POLL_TARGETS is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('JOB_POLL_TARGETS must be a non-empty JSON array');
    }

    return parsed.map(function (t, i) {
        if (!t || !t.url) throw new Error(`JOB_POLL_TARGETS[${i}] has no url`);
        return { url: t.url, name: t.name || t.url };
    });
}

function authHeader() {
    const token = process.env.JOB_POLL_BASIC;
    if (token && token.trim()) return `Basic ${token.trim()}`;

    const user = process.env.JOB_POLL_USER;
    const pass = process.env.JOB_POLL_PASSWORD;
    if (user && pass) {
        return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
    }
    throw new Error(
        'No credential. Set JOB_POLL_BASIC to the base64 of user:password ' +
        '(ideally a Key Vault reference), or JOB_POLL_USER and JOB_POLL_PASSWORD.'
    );
}

/**
 * Polls one instance. Never rejects: a failure against one target must not stop the others
 * and must not fail the invocation, because an Azure retry cannot help -- the application's
 * due check asks "is there an outstanding occurrence within the grace period" rather than
 * "is this the exact minute", so the next successful poll picks the job up.
 */
async function pollOne(target, header, context) {
    const started = Date.now();
    try {
        const res = await post(target.url, header, REQUEST_TIMEOUT_MS);
        const ms = Date.now() - started;

        if (res.status === 202) {
            const d = describe(res.body);

            if (d.started > 0) {
                // Something actually ran. This is the line worth keeping, so it goes to
                // info and names the jobs.
                context.log(
                    `${TAG} ${target.name}: STARTED ${d.started} on node=${d.node} ` +
                    `[${d.names.join(', ')}] (${ms}ms)`
                );
            } else {
                // 99% of polls land here -- nothing was due. Verbose so App Insights is
                // not 6,000 lines a day of "nothing happened"; raise host.json logLevel
                // to Trace when you need to see them.
                context.log.verbose(
                    `${TAG} ${target.name}: idle, nothing due on node=${d.node} (${ms}ms)`
                );
            }
            return {
                target: target.name, outcome: 'ok', node: d.node,
                started: d.started, names: d.names, ms: ms
            };
        }
        if (res.status === 429) {
            // A previous poll on that instance has not returned, almost always a stalled
            // database. The app is deliberately refusing to stack up blocked request
            // threads. Normal, not an error -- but notable, so info rather than verbose.
            context.log(
                `${TAG} ${target.name}: BUSY, a previous poll is still in flight -- ` +
                `check job_schedule for a row stuck on lastStatus='RUNNING' (${ms}ms)`
            );
            return { target: target.name, outcome: 'in-flight', ms: ms };
        }
        if (res.status === 401) {
            context.log.error(
                `${TAG} ${target.name}: 401 UNAUTHORIZED. Either JOB_POLL_BASIC is wrong, or ` +
                `this function's outbound IP is not allowlisted in verifyRequestAuthorize. ` +
                `url=${safeUrl(target.url)} (${ms}ms)`
            );
            return { target: target.name, outcome: 'unauthorized', ms: ms };
        }
        if (res.status === 404) {
            context.log.error(
                `${TAG} ${target.name}: 404 NOT FOUND. The tenant context path is probably ` +
                `wrong, or that tenant is not deployed on this box. url=${safeUrl(target.url)} (${ms}ms)`
            );
            return { target: target.name, outcome: 'not-found', ms: ms };
        }

        context.log.error(
            `${TAG} ${target.name}: HTTP ${res.status} url=${safeUrl(target.url)} ` +
            `body=${res.body} (${ms}ms)`
        );
        return { target: target.name, outcome: 'http-error', status: res.status, ms: ms };
    } catch (e) {
        const ms = Date.now() - started;
        // A warning, not an error: DR instances are unreachable by design, every minute.
        // Alert on a stale job_schedule.lastRunAt instead -- that catches an unreachable
        // box AND a dead function, which this log cannot.
        context.log.warn(
            `${TAG} ${target.name}: NOT POLLED -- ${e.message}. ` +
            `url=${safeUrl(target.url)} (${ms}ms)`
        );
        return { target: target.name, outcome: e.timedOut ? 'timeout' : 'unreachable', ms: ms };
    }
}

module.exports = async function (context, myTimer) {
    const runStarted = Date.now();

    if (myTimer && myTimer.isPastDue) {
        // The previous invocation was missed. Nothing to do differently: the app runs an
        // outstanding occurrence within its grace period regardless.
        context.log.warn(
            `${TAG} invocation is PAST DUE -- a previous poll was missed. ` +
            `If this repeats, check the Function App is not being scaled to zero.`
        );
    }

    let targets;
    let header;
    try {
        targets = readTargets();
        header = authHeader();
    } catch (e) {
        // Configuration is broken, so nothing can be polled. This one DOES throw, so the
        // invocation is marked failed and surfaces in Application Insights -- unlike a
        // per-target failure, a human has to fix this.
        context.log.error(`${TAG} CONFIGURATION ERROR: ${e.message}`);
        throw e;
    }

    context.log.verbose(
        `${TAG} polling ${targets.length} target(s) on schedule ` +
        `"${process.env.JOB_POLL_SCHEDULE || '(unset)'}": ` +
        targets.map(function (t) { return t.name; }).join(', ')
    );

    // In parallel: one slow or unreachable instance must not delay the others, and the
    // whole run has to finish inside a minute.
    const results = await Promise.all(
        targets.map(function (t) {
            return pollOne(t, header, context);
        })
    );

    const totalMs = Date.now() - runStarted;
    const slowest = results.reduce(function (a, b) {
        return (b.ms || 0) > (a.ms || 0) ? b : a;
    }, results[0]);

    const tally = {};
    results.forEach(function (r) {
        tally[r.outcome] = (tally[r.outcome] || 0) + 1;
    });
    const summary = Object.keys(tally)
        .map(function (k) { return `${k}=${tally[k]}`; })
        .join(' ');

    const ran = results.filter(function (r) { return r.started > 0; });
    const jobCount = ran.reduce(function (n, r) { return n + r.started; }, 0);

    // One info line per invocation. This is the aliveness signal and the thing to alert
    // on the absence of, so it stays at info even on a quiet minute.
    context.log(
        `${TAG} SUMMARY ${summary} | jobsStarted=${jobCount} | ` +
        `${totalMs}ms total, slowest ${slowest ? slowest.target + ' ' + slowest.ms + 'ms' : 'n/a'}`
    );

    if (jobCount > 0) {
        // The line to look for when asking "what ran last night".
        const detail = ran
            .map(function (r) { return `${r.target}=[${r.names.join(', ')}]`; })
            .join(' ');
        context.log(`${TAG} JOBS ${detail}`);
    }

    const broken = results.filter(function (r) {
        return r.outcome === 'unauthorized' || r.outcome === 'not-found' ||
               r.outcome === 'http-error';
    });
    if (broken.length) {
        // Distinct from "unreachable", which is expected for DR. These need a human.
        context.log.error(
            `${TAG} ATTENTION ${broken.length} target(s) misconfigured or failing: ` +
            broken.map(function (r) { return `${r.target} (${r.outcome})`; }).join(', ')
        );
    }

    if (totalMs > 45000) {
        // A run this slow risks overlapping the next minute's invocation.
        context.log.warn(
            `${TAG} run took ${totalMs}ms, close to the polling interval -- ` +
            `check for slow or unreachable targets`
        );
    }
};
