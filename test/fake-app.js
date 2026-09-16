/**
 * Stands in for the MHC application so every branch of index.js can be exercised
 * without Tomcat, a database, or a network path to appsvr01.
 *
 * The path decides the response, so one server covers all cases:
 *
 *   /ok/ws-cj/job/due       202  nothing was due          -> verbose "idle"
 *   /started/ws-cj/job/due  202  two jobs started         -> info "STARTED"
 *   /busy/ws-cj/job/due     429  poll already in flight   -> info "BUSY"
 *   /401/ws-cj/job/due      401  bad credential           -> error "UNAUTHORIZED"
 *   /404/ws-cj/job/due      404  wrong context path       -> error "NOT FOUND"
 *   /500/ws-cj/job/due      500  app blew up              -> error "HTTP 500"
 *   /html/ws-cj/job/due     202  an HTML error page       -> info, unparseable body
 *   /slow/ws-cj/job/due     202  after 30s (> the 25s cap) -> warn "NOT POLLED"
 *
 * Usage:  node test/fake-app.js [port]      (default 8099)
 */
const http = require('http');

const PORT = parseInt(process.argv[2] || '8099', 10);

function json(res, status, body) {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
}

const server = http.createServer((req, res) => {
    const mode = (req.url || '').split('/')[1] || 'ok';
    // Prove the function actually sends the credential.
    const auth = req.headers.authorization ? 'present' : 'MISSING';
    console.log(`[fake-app] ${req.method} ${req.url} auth=${auth}`);

    switch (mode) {
        case 'started':
            return json(res, 202, {
                node: 'FAKEBOX01', status: '2 started',
                detail: '[clinic-check, push-event]'
            });
        case 'busy':
            return json(res, 429, { node: 'FAKEBOX01', status: 'poll in flight', detail: '[]' });
        case '401':
            return json(res, 401, { error: 'unauthorized' });
        case '404':
            res.writeHead(404, { 'Content-Type': 'text/html' });
            return res.end('<html><body>404 Not Found</body></html>');
        case '500':
            return json(res, 500, { error: 'boom' });
        case 'html':
            res.writeHead(202, { 'Content-Type': 'text/html' });
            return res.end('<html><body>Tomcat error page</body></html>');
        case 'slow':
            return setTimeout(function () {
                json(res, 202, { node: 'FAKEBOX01', status: '0 started', detail: '[]' });
            }, 30000);
        default:
            return json(res, 202, { node: 'FAKEBOX01', status: '0 started', detail: '[]' });
    }
});

server.listen(PORT, function () {
    console.log(`[fake-app] listening on http://localhost:${PORT}`);
    console.log(`[fake-app] try: JOB_POLL_TARGETS='[{"name":"t","url":"http://localhost:${PORT}/started/ws-cj/job/due"}]' node test/run-local.js`);
});
