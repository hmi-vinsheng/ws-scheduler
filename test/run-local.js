/**
 * Runs JobPoll/index.js once, right now, with a fake Azure context.
 *
 * This is the fastest way to test: no Functions Core Tools, no storage account,
 * no waiting for a timer to fire. The handler is a plain async function, so it
 * can just be called.
 *
 * Config comes from local.settings.json (Values) if present, then the real
 * environment, then --target. Anything already set in the environment wins, so
 * you can override one value without editing the file.
 *
 * Usage:
 *   node test/run-local.js
 *   node test/run-local.js --target http://localhost:8099/started/ws-cj/job/due
 *   node test/run-local.js --past-due          # simulate a missed invocation
 *   node test/run-local.js --verbose           # show context.log.verbose lines
 */
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
function flag(name) { return args.indexOf(name) >= 0; }
function opt(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }

// 1. local.settings.json, the same file `func start` reads.
const settingsPath = path.join(__dirname, '..', 'local.settings.json');
if (fs.existsSync(settingsPath)) {
    const values = (JSON.parse(fs.readFileSync(settingsPath, 'utf8')).Values) || {};
    Object.keys(values).forEach(function (k) {
        if (process.env[k] === undefined) process.env[k] = values[k];
    });
    console.log(`loaded ${settingsPath}`);
} else {
    console.log(`no local.settings.json (copy local.settings.json.example if you want one)`);
}

// 2. --target overrides JOB_POLL_TARGETS with a single URL.
const target = opt('--target');
if (target) {
    process.env.JOB_POLL_TARGETS = JSON.stringify([{ name: 'cli', url: target }]);
}

// 3. A credential must exist or the handler throws by design. Supply a dummy
//    for local runs so the config check is not what you are testing.
if (!process.env.JOB_POLL_BASIC && !(process.env.JOB_POLL_USER && process.env.JOB_POLL_PASSWORD)) {
    process.env.JOB_POLL_USER = 'local';
    process.env.JOB_POLL_PASSWORD = 'local';
    console.log('no credential configured; using local/local');
}

const showVerbose = flag('--verbose');
const counts = { info: 0, verbose: 0, warn: 0, error: 0 };

function line(level, msg) {
    counts[level]++;
    if (level === 'verbose' && !showVerbose) return;
    console.log(`  [${level.padEnd(7)}] ${msg}`);
}

// The shape the Functions v3 host passes in. Only the log family is used.
const context = {
    invocationId: 'local-' + Date.now(),
    log: Object.assign(function (m) { line('info', m); }, {
        verbose: function (m) { line('verbose', m); },
        info: function (m) { line('info', m); },
        warn: function (m) { line('warn', m); },
        error: function (m) { line('error', m); }
    })
};

const myTimer = { isPastDue: flag('--past-due'), scheduleStatus: {} };

const handler = require(path.join(__dirname, '..', 'JobPoll', 'index.js'));

console.log(`\ntargets: ${process.env.JOB_POLL_TARGETS}`);
console.log('--- run ---');

handler(context, myTimer).then(
    function () {
        console.log('--- done ---');
        console.log(`levels: info=${counts.info} verbose=${counts.verbose} warn=${counts.warn} error=${counts.error}`);
        if (!showVerbose && counts.verbose) console.log(`(${counts.verbose} verbose line(s) hidden; pass --verbose)`);
        process.exit(0);
    },
    function (e) {
        // The handler throws only on a configuration error, which is the correct
        // behaviour -- the invocation should be marked failed.
        console.log('--- THREW (expected only for a config error) ---');
        console.log(e.message);
        process.exit(1);
    }
);
