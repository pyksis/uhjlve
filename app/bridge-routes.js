'use strict';

// Keep browser traffic on the already permitted Parsoid port (8142).
// This middleware runs before Express consumes POST bodies.
const http = require('http');
const routes = { '/_bridge/status': ['GET', '/relay/status'], '/_bridge/next': ['POST', '/relay/next'], '/_bridge/complete': ['POST', '/relay/complete'] };

module.exports = function bridgeRoutes(req, res, next) {
  const route = routes[req.url];
  if (!route) return next();
  if (req.method !== route[0] || (req.headers.origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin))) {
    res.statusCode = 403;
    res.end('Forbidden browser relay request');
    return;
  }
  const upstream = http.request({ hostname: '127.0.0.1', port: Number(process.env.HUIJI_PROXY_PORT || 8143),
    path: route[1], method: req.method,
    headers: { 'Content-Type': req.headers['content-type'] || 'application/json' } }, (reply) => {
    if (res.destroyed) { reply.destroy(); return; }
    res.writeHead(reply.statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    reply.pipe(res);
  });
  upstream.setTimeout(20000, () => upstream.destroy(new Error('Browser relay proxy timed out')));
  upstream.on('error', () => {
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'local-proxy-unavailable', info: 'Restart the local editor services.' } }));
    } else if (!res.destroyed) res.end();
  });
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
  req.pipe(upstream);
};
