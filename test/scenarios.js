/**
 * Asserts what index.js logs, and at which level, for every response the app can
 * give -- against a real HTTP server on localhost, not a mocked http module, so
 * the request building, the Authorization header and the timeout are all real.
 *
 * The levels are the point of these assertions. A routine idle poll must stay
 * verbose (roughly 4,300 lines a day per target that nobody should have to read),
 * an unreachable target must be warn and not error (DR is unreachable by design,
 * every minute, and must not page anyone), and a misconfigured target must be
 * error.
 *
 * Usage:  node test/scenarios.js          (~2s)
 *         node test/scenarios.js --slow   (adds the 25s timeout case)
 */
const http = require('http');
const path = require('path');

const withSlow = process.argv.indexOf('--slow') >= 0;
const { jobPoll } = require(path.join(__dirname, '..', 'src', 'index.js'));

let sawAuth = null;

const server = http.createServer((req, res) => {
    sawAuth = req.headers.authorization || null;
    const mode = (req.url || '').split('/')[1] || 'ok';
    const send = function (status, body, type) {
        res.writeHead(status, { 'Content-Type': type || 'application/json' });
        res.end(body);
    };
    if (mode === 'started') return send(202, JSON.stringify({ node: 'FAKEBOX01', status: '2 started', detail: '[clinic-check, push-event]' }));
    if (mode === 'busy') return send(429, JSON.stringify({ status: 'in flight' }));
    if (mode === '401') return send(401, JSON.stringify({ error: 'no' }));
    if (mode === '404') return send(404, '<html>404</html>', 'text/html');
    if (mode === '500') return send(500, JSON.stringify({ error: 'boom' }));
    if (mode === 'html') return send(202, '<html>Tomcat error</html>', 'text/html');
    if (mode === 'slow') return setTimeout(function () { send(202, JSON.stringify({ node: 'X', status: '0 started', detail: '[]' })); }, 30000);
    return send(202, JSON.stringify({ node: 'FAKEBOX01', status: '0 started', detail: '[]' }));
});

let port;
let failures = 0;
let checks = 0;

function capture() {
    const lines = [];
    const push = function (level) { return function (m) { lines.push({ level: level, msg: String(m) }); }; };
    return {
        lines: lines,
        // v4 context: log() is still the info-level function, but the severity helpers
        // hang off context itself rather than off log.
        context: {
            invocationId: 'test',
            log:   push('info'),
            trace: push('verbose'),
            debug: push('verbose'),
            info:  push('info'),
            warn:  push('warn'),
            error: push('error')
        }
    };
}

function url(mode) { return `http://localhost:${port}/${mode}/ws-cj/job/due`; }

async function run(name, targets, env, pastDue) {
    process.env.JOB_POLL_TARGETS = JSON.stringify(targets);
    process.env.JOB_POLL_USER = 'u';
    process.env.JOB_POLL_PASSWORD = 'p';
    delete process.env.JOB_POLL_BASIC;
    Object.keys(env || {}).forEach(function (k) {
        if (env[k] === null) delete process.env[k]; else process.env[k] = env[k];
    });

    const c = capture();
    let threw = null;
    try {
        // v4 argument order: (trigger, context)
        await jobPoll({ isPastDue: !!pastDue }, c.context);
    } catch (e) {
        threw = e;
    }
    return { name: name, lines: c.lines, threw: threw };
}

function expect(result, level, needle) {
    checks++;
    const hit = result.lines.some(function (l) { return l.level === level && l.msg.indexOf(needle) >= 0; });
    if (!hit) {
        failures++;
        console.log(`  FAIL  ${result.name}: no ${level} line containing "${needle}"`);
        result.lines.forEach(function (l) { console.log(`        [${l.level}] ${l.msg}`); });
    } else {
        console.log(`  ok    ${result.name}: ${level} "${needle}"`);
    }
}

function expectNo(result, level, needle) {
    checks++;
    const hit = result.lines.some(function (l) { return l.level === level && l.msg.indexOf(needle) >= 0; });
    if (hit) {
        failures++;
        console.log(`  FAIL  ${result.name}: unexpected ${level} line containing "${needle}"`);
        result.lines.forEach(function (l) { console.log(`        [${l.level}] ${l.msg}`); });
    } else {
        console.log(`  ok    ${result.name}: no ${level} "${needle}"`);
    }
}

async function main() {
    await new Promise(function (r) { server.listen(0, r); });
    port = server.address().port;
    console.log(`fake app on :${port}\n`);

    let r;

    r = await run('nothing due', [{ name: 't', url: url('ok') }]);
    expect(r, 'verbose', 'idle, nothing due on node=FAKEBOX01');
    expect(r, 'info', 'SUMMARY ok=1 | jobsStarted=0');
    expectNo(r, 'info', 'JOBS ');              // no JOBS line on a quiet minute
    expectNo(r, 'error', 'ATTENTION');

    r = await run('jobs started', [{ name: 't', url: url('started') }]);
    expect(r, 'info', 'STARTED 2 on node=FAKEBOX01 [clinic-check, push-event]');
    expect(r, 'info', 'SUMMARY ok=1 | jobsStarted=2');
    expect(r, 'info', 'JOBS t=[clinic-check, push-event]');
    // the credential really goes on the wire
    checks++;
    if (sawAuth !== 'Basic ' + Buffer.from('u:p').toString('base64')) {
        failures++; console.log(`  FAIL  auth header was ${sawAuth}`);
    } else { console.log('  ok    auth header sent as Basic base64(u:p)'); }

    r = await run('poll in flight', [{ name: 't', url: url('busy') }]);
    expect(r, 'info', 'BUSY, a previous poll is still in flight');
    expect(r, 'info', "lastStatus='RUNNING'");
    expectNo(r, 'error', 'ATTENTION');          // 429 is normal, not a human problem

    r = await run('bad credential', [{ name: 't', url: url('401') }]);
    expect(r, 'error', '401 UNAUTHORIZED');
    expect(r, 'error', 'not allowlisted in verifyRequestAuthorize');
    expect(r, 'error', 'ATTENTION 1 target(s) misconfigured');

    r = await run('wrong context path', [{ name: 't', url: url('404') }]);
    expect(r, 'error', '404 NOT FOUND');
    expect(r, 'error', 'ATTENTION 1 target(s) misconfigured');

    r = await run('app error', [{ name: 't', url: url('500') }]);
    expect(r, 'error', 'HTTP 500');
    expect(r, 'error', 'ATTENTION 1 target(s) misconfigured');

    r = await run('html body', [{ name: 't', url: url('html') }]);
    expect(r, 'verbose', 'nothing due on node=?');   // unparseable, but no crash
    expect(r, 'info', 'SUMMARY ok=1');

    // Nothing is listening on this port.
    r = await run('unreachable', [{ name: 'dr', url: 'http://localhost:1/x/ws-cj/job/due' }]);
    expect(r, 'warn', 'NOT POLLED');
    expect(r, 'info', 'SUMMARY unreachable=1');
    expectNo(r, 'error', 'ATTENTION');          // DR must never page anyone
    checks++;
    if (r.threw) { failures++; console.log('  FAIL  unreachable target failed the invocation'); }
    else { console.log('  ok    unreachable target did not fail the invocation'); }

    r = await run('mixed', [
        { name: 'mhc', url: url('started') },
        { name: 'ge', url: url('ok') },
        { name: 'dr', url: 'http://localhost:1/x' }
    ]);
    expect(r, 'info', 'jobsStarted=2');
    expect(r, 'info', 'ok=2');
    expect(r, 'info', 'unreachable=1');
    expectNo(r, 'error', 'ATTENTION');

    // 192.0.2.1 is RFC 5737 TEST-NET -- routed nowhere, so packets are silently dropped.
    // This is exactly what a firewall DROP (an IP allowlist) looks like to the client, and
    // it must be distinguishable in the log from an app that connected and then stalled.
    r = await run('packets dropped', [{ name: 'blocked', url: 'http://192.0.2.1/mhc/ws-cj/job/due' }]);
    expect(r, 'warn', 'could not connect after');
    expect(r, 'warn', 'packets are being dropped (firewall or IP allowlist?)');
    expect(r, 'info', 'SUMMARY timeout=1');
    expectNo(r, 'error', 'ATTENTION');
    expectNo(r, 'warn', 'connected but no response');

    r = await run('past due', [{ name: 't', url: url('ok') }], null, true);
    expect(r, 'warn', 'invocation is PAST DUE');

    r = await run('no targets', [{ name: 't', url: url('ok') }], { JOB_POLL_TARGETS: null });
    expect(r, 'error', 'CONFIGURATION ERROR');
    expect(r, 'error', 'JOB_POLL_TARGETS is not set');
    checks++;
    if (!r.threw) { failures++; console.log('  FAIL  missing config did not fail the invocation'); }
    else { console.log('  ok    missing config failed the invocation'); }

    process.env.JOB_POLL_TARGETS = 'not json';
    r = await run('bad json', [{ name: 't', url: url('ok') }], { JOB_POLL_TARGETS: 'not json' });
    expect(r, 'error', 'is not valid JSON');

    r = await run('no credential', [{ name: 't', url: url('ok') }],
        { JOB_POLL_USER: null, JOB_POLL_PASSWORD: null, JOB_POLL_BASIC: null });
    expect(r, 'error', 'No credential');
    checks++;
    if (!r.threw) { failures++; console.log('  FAIL  missing credential did not fail the invocation'); }
    else { console.log('  ok    missing credential failed the invocation'); }

    if (withSlow) {
        console.log('\n  (waiting 25s for the request timeout...)');
        // Connects, then the app says nothing -- a stalled database. timeoutMs governs.
        r = await run('connected then silent', [{ name: 't', url: url('slow') }]);
        expect(r, 'warn', 'NOT POLLED');
        expect(r, 'warn', 'connected but no response after 25');
        expect(r, 'warn', "lastStatus='RUNNING'");
        expect(r, 'info', 'SUMMARY timeout=1');
        expectNo(r, 'error', 'ATTENTION');
    } else {
        console.log('\n  (skipping the 25s timeout case; pass --slow to include it)');
    }

    server.close();
    console.log(`\n${checks - failures}/${checks} checks passed`);
    process.exit(failures ? 1 : 0);
}

main();
