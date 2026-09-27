'use strict';

// Deterministic integration tests: real local HTTP broker + actual extension scripts in VM.
// The wiki responses are simulated; no account cookies or remote edits are used.
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createProxy } = require('../app/huiji-api-proxy.js');
const policy = require('../extension/api-policy.js');
const bridgeRoutes = require('../app/bridge-routes.js');

function request(url, method, data, extraHeaders, agent) {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data);
    const req = http.request(url, { method: method || 'GET', agent,
      headers: Object.assign(body === undefined ? {} : { 'Content-Type': typeof data === 'string' ? 'application/x-www-form-urlencoded' : 'application/json' }, extraHeaders) }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function launch(options) {
  const server = createProxy(Object.assign({ startupWait: 10, pollTimeout: 25 }, options));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const api = '/api.php?action=query&prop=revisions&titles=武器&format=json';

function checkPolicy() {
  assert.equal(policy.validate({ method: 'GET', path: api }).get('action'), 'query');
  for (const query of [
    'action=edit&format=json', 'action=query&meta=tokens&format=json', 'action=query&meta=userinfo&format=json',
    'action=query&prop=revisions&format=json&token=abc', 'action=query&prop=revisions&format=json&callback=f',
    'action=query&prop=revisions&format=json&action=edit', 'action=query&list=allusers&format=json',
    'action=query&prop=revisions&format=json&meta=siteinfo&meta=tokens'
  ]) assert.throws(() => policy.validate({ method: 'GET', path: '/api.php?' + query }));
  assert.throws(() => policy.validate({ method: 'GET', path: 'https://evil.test/api.php?action=query&meta=siteinfo&format=json' }));
  assert.throws(() => policy.validate({ method: 'POST', path: '/api.php?format=json',
    contentType: 'application/x-www-form-urlencoded', body: 'action=query&prop=revisions&action=edit' }));
}
async function checkDirectFallback() {
  let calls = 0;
  const server = await launch({ curlRequest: async () => {
    calls++;
    return calls === 1 ? { status: 502, body: '{}' } : { status: 200, body: '{"query":{"general":{}}}' };
  } });
  try {
    const url = server.base + '/api.php?action=query&meta=siteinfo&format=json';
    assert.equal((await request(url)).status, 200);
    assert.equal((await request(url)).status, 200);
    assert.equal(calls, 2);
    assert.equal(JSON.parse((await request(server.base + '/_health')).body).counters.cacheHits, 1);
    const schema = server.base + '/api.php?action=paraminfo&modules=query&format=json';
    await request(schema); await request(schema);
    assert.equal(calls, 3, 'Public API schema is reused instead of refetched per conversion');
    const blocked = await request(server.base + api, 'GET', undefined, { Origin: 'https://evil.test' });
    assert.equal(blocked.status, 403);
    assert.equal((await request(server.base + '/api.php?action=edit&format=json')).status, 400);
  } finally { await new Promise((resolve) => server.server.close(resolve)); }

  let challengeCalls = 0;
  const challenged = await launch({ curlRequest: async () => {
    challengeCalls++;
    return { status: 403, body: '<html>cf-chl challenge-platform</html>' };
  } });
  try {
    const result = await request(challenged.base + api);
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.body).error.code, 'browser-verification-required');
    assert.equal(challengeCalls, 1, 'Do not repeatedly hammer a challenge');
  } finally { await new Promise((resolve) => challenged.server.close(resolve)); }
}
async function checkBrowserRelay() {
  let directCalls = 0;
  const local = await launch({ curlRequest: async () => { directCalls++; return { status: 403, body: '<html>cf-chl challenge-platform</html>' }; } });
  const savedProxyPort = process.env.HUIJI_PROXY_PORT;
  process.env.HUIJI_PROXY_PORT = String(local.server.address().port);
  const bridge = http.createServer((req, res) => bridgeRoutes(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const bridgeBase = 'http://127.0.0.1:' + bridge.address().port;
  let messageListener;
  let parsoidStatus = 500;
  const wikiCalls = [];
  let expansionFailures = 1;
  let challenge = false;
  let expansionBody;
  function fakeResponse(result) {
    return { ok: result.status >= 200 && result.status < 300, status: result.status,
      statusText: result.status === 500 ? 'Internal Server Error' : 'Response',
      headers: { get: (name) => (result.headers || {})[name], forEach: (callback) => Object.keys(result.headers || {}).forEach((name) => callback(result.headers[name], name)) },
      text: async () => result.body };
  }
  const bgContext = vm.createContext({
    URL, Date, fetch: async (url, init) => {
      if (url.startsWith('http://127.0.0.1:8142/_bridge/')) {
        return fakeResponse(await request(url.replace('http://127.0.0.1:8142', bridgeBase), init && init.method, init && init.body,
          init && init.headers));
      }
      return fakeResponse({ status: parsoidStatus, body: 'Template Fetch failure', headers: { 'content-type': 'text/plain' } });
    },
    chrome: { runtime: { onMessage: { addListener: (listener) => { messageListener = listener; } } } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), bgContext);
  const events = {};
  const pageMessages = [];
  const context = vm.createContext({
    URL, URLSearchParams, Date, Uint8Array,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    setTimeout, clearTimeout,
    crypto: { getRandomValues: (array) => crypto.randomFillSync(array) },
    location: { origin: 'https://unimage.huijiwiki.com' },
    window: { addEventListener: (name, handler) => { events[name] = handler; }, postMessage: (message) => pageMessages.push(message) },
    chrome: { runtime: { sendMessage: (message, callback) => {
      messageListener(message, { frameId: 0, tab: { url: 'https://unimage.huijiwiki.com/wiki/武器' } }, callback);
    } } },
    fetch: async (url, init) => {
      assert.equal(new URL(url).origin, 'https://unimage.huijiwiki.com');
      assert.equal(init.credentials, 'same-origin');
      wikiCalls.push(url);
      if (challenge) return fakeResponse({ status: 403, body: '<html>challenge-platform</html>', headers: { 'cf-mitigated': 'challenge' } });
      if (init.method === 'POST') {
        expansionBody = init.body;
        if (expansionFailures-- > 0) return fakeResponse({ status: 502, body: '{}' });
      }
      return fakeResponse({ status: 200, body: '{"query":{"pages":{"1":{"revisions":[{"*":"正文"}]}}}}',
        headers: { 'content-type': 'application/json', 'set-cookie': 'DO_NOT_RELAY' } });
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/api-policy.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/content-bridge.js'), 'utf8'), context);
  try {
    await wait(40);
    const health = JSON.parse((await request(local.base + '/_health')).body);
    assert.equal(health.relayConnected, true);
    const result = await request(local.base + encodeURI(api));
    assert.equal(result.status, 200);
    assert(result.body.includes('正文'));
    assert.equal(result.headers['set-cookie'], undefined);
    const config = local.base + '/api.php?action=query&meta=siteinfo&format=json';
    const before = wikiCalls.length;
    await Promise.all([request(config), request(config)]);
    assert.equal(wikiCalls.length - before, 1, 'Concurrent configuration requests coalesce');
    const body = new URLSearchParams({ action: 'expandtemplates', format: 'json', text: '{{武器|说明=管道|值}}' }).toString();
    assert.equal((await request(local.base + '/api.php', 'POST', body)).status, 200);
    assert.equal(expansionBody, body, 'POST body survives retries unchanged');
    assert.equal(expansionFailures, -1);

    challenge = true;
    const failed = await request(local.base + encodeURI(api));
    assert.equal(failed.status, 503);
    const fromBg = await new Promise((resolve) => messageListener({
      type: 'huiji-local-ve-fetch', request: { path: '/unimage.huijiwiki.com/v3/page/html/武器' }
    }, { frameId: 0, tab: { url: 'https://unimage.huijiwiki.com/wiki/武器' } }, resolve));
    assert.equal(fromBg.errorCode, 'browser-verification-required');
    assert(fromBg.statusText.includes('验证'));
    parsoidStatus = 404;
    events.message({ source: context.window, origin: 'https://unimage.huijiwiki.com',
      data: { channel: 'huiji-local-visualeditor-v2', direction: 'to-extension', id: 7,
        request: { path: '/unimage.huijiwiki.com/v3/page/html/不存在' } } });
    await wait(30);
    assert.equal(pageMessages.find((message) => message.id === 7).response.status, 404);

    challenge = false;
    assert.equal((await request(local.base + encodeURI(api))).status, 200);
    assert.equal(directCalls, 1, 'Probe direct access once, then skip repeated Cloudflare challenges');
  } finally {
    vm.runInContext('stopped = true;', context);
    await wait(60);
    await new Promise((resolve) => bridge.close(resolve));
    await new Promise((resolve) => local.server.close(resolve));
    if (savedProxyPort === undefined) delete process.env.HUIJI_PROXY_PORT;
    else process.env.HUIJI_PROXY_PORT = savedProxyPort;
  }
}
async function checkOwnershipAndTimeout() {
  const local = await launch({ relayTimeout: 60, pollTimeout: 40, curlRequest: async () => ({ status: 403, body: 'cf-chl' }) });
  try {
    const session = 'a'.repeat(64);
    const poll = request(local.base + '/relay/next', 'POST', { session });
    await wait(5);
    const apiCall = request(local.base + encodeURI(api));
    const job = JSON.parse((await poll).body).job;
    const fakeCompletion = await request(local.base + '/relay/complete', 'POST', {
      session: 'b'.repeat(64), id: job.id, response: { status: 200, body: '{}' }
    });
    assert.equal(fakeCompletion.status, 409);
    assert.equal((await apiCall).status, 503, 'An abandoned browser request times out');
  } finally { await new Promise((resolve) => local.server.close(resolve)); }
}

async function checkFastPathAndFreshSource() {
  let calls = 0;
  const local = await launch({ startupWait: 1500, curlRequest: async () => {
    const generation = ++calls;
    await wait(20);
    return { status: 200, body: JSON.stringify({ generation }) };
  } });
  try {
    const started = Date.now();
    const results = await Promise.all([request(local.base + encodeURI(api)), request(local.base + encodeURI(api))]);
    assert.equal(calls, 1, 'Identical concurrent source requests share one network request');
    assert.equal(results[0].body, results[1].body);
    assert(Date.now() - started < 500, 'Healthy direct access must not wait for a browser relay');
    assert.equal(JSON.parse((await request(local.base + encodeURI(api))).body).generation, 2,
      'A later source request sees updated content, not a stale page cache');
  } finally { await new Promise((resolve) => local.server.close(resolve)); }
}

async function checkSocketContention() {
  const server = createProxy();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const agent = new http.Agent({ maxSockets: 2, keepAlive: true });
  try {
    const session = 'c'.repeat(64);
    const polls = [request(base + '/relay/next', 'POST', { session }, undefined, agent),
      request(base + '/relay/next', 'POST', { session }, undefined, agent)];
    await wait(20);
    const started = Date.now();
    assert.equal((await request(base + '/_health', 'GET', undefined, undefined, agent)).status, 200);
    const elapsed = Date.now() - started;
    assert(elapsed < 1000, 'Idle relay polls must promptly release sockets needed by conversion/completion');
    assert.equal(JSON.parse((await polls[0]).body).retryAfter, 300);
    await polls[1];
    console.log('Socket contention check: queued request completed in ' + elapsed + 'ms (old polling held connections for 15000ms)');
  } finally { agent.destroy(); await new Promise((resolve) => server.close(resolve)); }
}

(async () => {
  checkPolicy();
  await checkDirectFallback();
  await checkBrowserRelay();
  await checkOwnershipAndTimeout();
  await checkFastPathAndFreshSource();
  await checkSocketContention();
  console.log('PASS: API allowlist, relay ownership/concurrency, session transport, POST retry, configuration cache, challenge diagnostics, 404 preservation and abandoned-request timeout');
})().catch((error) => { console.error(error); process.exitCode = 1; });
