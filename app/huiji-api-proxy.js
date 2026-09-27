'use strict';

const http = require('http');
const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('../extension/api-policy.js');

const ORIGIN = 'https://unimage.huijiwiki.com';
const VERSION = '1.0.4';
const MAX_BODY = 12 * 1024 * 1024;
const RESPONSE_HEADERS = ['content-type', 'etag', 'last-modified', 'content-language', 'cache-control', 'vary'];

function filteredHeaders(headers) {
  const result = {};
  RESPONSE_HEADERS.forEach((name) => {
    if (headers && typeof headers[name] === 'string') result[name] = headers[name];
  });
  return result;
}
function failure(code, message, status) {
  return { status: status || 503, headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ error: { code, info: message } }), errorCode: code, message };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) reject(new Error('Request body is too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function runCurl(request) {
  return new Promise((resolve) => {
    const headerFile = path.join(os.tmpdir(), 'huiji-ve-' + crypto.randomBytes(16).toString('hex') + '.headers');
    const args = ['-sS', '--connect-timeout', '5', '--max-time', '12',
      '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 HuijiLocalVisualEditor/' + VERSION,
      '-e', ORIGIN + '/wiki/%E9%A6%96%E9%A1%B5', '-X', request.method, '-D', headerFile];
    if (request.method === 'POST') args.push('-H', 'Content-Type: ' + request.contentType, '--data-binary', '@-');
    args.push(ORIGIN + request.path);
    const curl = childProcess.spawn('curl.exe', args, { windowsHide: true });
    const chunks = [];
    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      try { fs.unlinkSync(headerFile); } catch (ignore) {}
      resolve(result);
    }
    curl.stdout.on('data', (chunk) => chunks.push(chunk));
    curl.stderr.on('data', () => {});
    curl.stdin.on('error', () => {});
    curl.on('error', () => finish(failure('upstream-network', 'The wiki API connection failed.')));
    curl.on('close', (exitCode) => {
      let status = 502;
      const headers = {};
      try {
        const blocks = fs.readFileSync(headerFile, 'utf8').split(/\r?\n\r?\n/).filter((block) => /^HTTP\//.test(block));
        const lines = (blocks[blocks.length - 1] || '').split(/\r?\n/);
        const match = (lines.shift() || '').match(/^HTTP\/\S+\s+(\d+)/);
        if (match) status = Number(match[1]);
        lines.forEach((line) => {
          const colon = line.indexOf(':');
          if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        });
      } catch (ignore) {}
      if (exitCode !== 0) return finish(failure('upstream-network', 'The wiki API connection timed out or failed.'));
      finish({ status, headers: filteredHeaders(headers), body: Buffer.concat(chunks).toString('utf8') });
    });
    curl.stdin.end(request.method === 'POST' ? request.body : undefined);
  });
}

function createProxy(options) {
  options = options || {};
  const curlRequest = options.curlRequest || runCurl;
  const relayTimeout = options.relayTimeout || 28000;
  const startupWait = options.startupWait === undefined ? 150 : options.startupWait;
  // Long polls compete with conversion/completion requests for Chromium's
  // per-origin sockets. Release them quickly, including for older extensions.
  const pollTimeout = options.pollTimeout || 200;
  const sessions = new Map();
  const jobs = new Map();
  const waiters = [];
  const cache = new Map();
  const inflight = new Map();
  const counters = { browser: 0, direct: 0, retries: 0, cacheHits: 0 };
  let lastError = null;
  let directBlockedUntil = 0;

  function reply(res, status, data) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  function activeSessions() {
    const now = Date.now();
    sessions.forEach((seen, session) => { if (now - seen > 45000) sessions.delete(session); });
    return sessions.size;
  }
  function status() {
    return { ok: true, version: VERSION, target: ORIGIN, relayConnected: activeSessions() > 0,
      pendingRequests: jobs.size, lastError, counters: Object.assign({}, counters) };
  }
  function settle(job, result) {
    if (!jobs.has(job.id)) return;
    clearTimeout(job.timer);
    jobs.delete(job.id);
    job.resolve(result);
  }
  function dispatch() {
    while (waiters.length) {
      const job = Array.from(jobs.values()).find((item) => !item.session);
      if (!job) return;
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      if (waiter.res.destroyed) continue;
      job.session = waiter.session;
      clearTimeout(job.timer);
      job.timer = setTimeout(() => settle(job, failure('browser-relay-timeout', 'The wiki browser did not complete the API request.')), relayTimeout);
      reply(waiter.res, 200, { job: { id: job.id, request: job.request } });
    }
  }
  function browserRequest(request) {
    return new Promise((resolve) => {
      if (jobs.size >= 64) return resolve(failure('browser-relay-busy', 'Too many wiki requests are waiting.'));
      const job = { id: crypto.randomBytes(16).toString('hex'), request, resolve, session: null };
      job.timer = setTimeout(() => settle(job, activeSessions() ?
        failure('browser-relay-timeout', 'The wiki browser did not complete the API request.') : null), activeSessions() ? relayTimeout : startupWait);
      jobs.set(job.id, job);
      dispatch();
    });
  }
  function normalize(result) {
    if (!result) return failure('upstream-network', 'No wiki API response was received.');
    if (/cf-chl|challenge-platform|启用 JavaScript 和 Cookie/.test(result.body || '')) {
      return failure('browser-verification-required', 'Open the wiki API verification page in this browser, complete verification, then retry.');
    }
    if (result.status === 200) {
      try { JSON.parse(result.body); } catch (ignore) {
        return failure('upstream-invalid-response', 'The wiki API returned HTML instead of JSON.');
      }
    }
    result.headers = filteredHeaders(result.headers);
    return result;
  }
  async function execute(request) {
    let result;
    // Keep the 1.0.1 fast path. Once direct access is blocked, skip repeated
    // challenge requests for one minute and use the signed-in browser instead.
    if (Date.now() >= directBlockedUntil) {
      for (let attempt = 0; attempt < 2; attempt++) {
        counters.direct++;
        result = normalize(await curlRequest(request));
        if (result.errorCode === 'browser-verification-required' || ![429, 500, 502, 503, 504].includes(result.status) || attempt === 1) break;
        counters.retries++;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (result.status >= 400) directBlockedUntil = Date.now() + 60000;
    }
    if (!result || result.status >= 400) {
      const relayed = await browserRequest(request);
      if (relayed) { result = relayed; counters.browser++; }
    }
    result = normalize(result);
    if (result.status >= 400) {
      lastError = { code: result.errorCode || 'upstream-http', message: result.message || 'Wiki API HTTP ' + result.status, time: Date.now() };
      // Do not log source text, cookies or the full challenge document.
      console.warn('Wiki API request failed:', lastError.code, result.status);
    } else lastError = null;
    return result;
  }
  async function apiRequest(request, params) {
    // Cache public configuration/schema only; current source and template
    // expansion stay fresh. Coalesce simultaneous identical reads/parses.
    const cacheable = params.get('meta') === 'siteinfo' || params.get('action') === 'paraminfo';
    const sorted = new URLSearchParams(params);
    sorted.sort();
    const key = request.method + ':' + sorted.toString();
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) { counters.cacheHits++; return hit.result; }
    if (inflight.has(key)) return inflight.get(key);
    const promise = execute(request).then((result) => {
      if (cacheable && result.status === 200 && !JSON.parse(result.body).error) {
        if (cache.size >= 64) cache.delete(cache.keys().next().value);
        cache.set(key, { result, expires: Date.now() + 60 * 60 * 1000 });
      }
      return result;
    }).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Prevent arbitrary websites from commanding the signed-in browser relay.
      if (req.headers.origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin)) {
        reply(res, 403, { error: 'Forbidden web origin' });
        return;
      }
      if (req.url === '/_health' || req.url === '/relay/status') {
        reply(res, 200, status());
        return;
      }
      if (req.method === 'POST' && ['/relay/next', '/relay/complete'].includes(req.url)) {
        const data = JSON.parse(await readBody(req));
        if (!/^[a-f0-9]{64}$/.test(data.session || '')) {
          reply(res, 400, { error: 'Invalid relay session' });
          return;
        }
        if (req.url === '/relay/complete') {
          const job = jobs.get(data.id);
          if (!job || job.session !== data.session) {
            reply(res, 409, { error: 'Unknown or expired API job' });
            return;
          }
          const result = data.response;
          if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 599 ||
              typeof result.body !== 'string' || Buffer.byteLength(result.body) > MAX_BODY) {
            reply(res, 400, { error: 'Invalid API response' });
            return;
          }
          settle(job, result);
          reply(res, 200, { ok: true });
          return;
        }
        sessions.set(data.session, Date.now());
        if (waiters.filter((waiter) => waiter.session === data.session).length >= 3) {
          reply(res, 429, { error: 'Too many relay polls' });
          return;
        }
        const waiter = { session: data.session, res };
        function remove() {
          clearTimeout(waiter.timer);
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
        }
        waiter.timer = setTimeout(() => { remove(); reply(res, 200, { job: null, retryAfter: 300 }); }, pollTimeout);
        res.on('close', remove);
        waiters.push(waiter);
        dispatch();
        return;
      }
      const request = { method: req.method, path: req.url, contentType: req.headers['content-type'] || '', body: await readBody(req) };
      let params;
      try { params = policy.validate(request); } catch (error) { reply(res, 400, { error: error.message }); return; }
      const result = await apiRequest(request, params);
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (error) { reply(res, 400, { error: error.message }); }
  });
  server.on('close', () => {
    waiters.splice(0).forEach((waiter) => { clearTimeout(waiter.timer); waiter.res.end(); });
    Array.from(jobs.values()).forEach((job) => settle(job, failure('proxy-stopped', 'The local proxy stopped.')));
  });
  return server;
}

module.exports = { createProxy };
if (require.main === module) {
  const port = Number(process.env.HUIJI_PROXY_PORT || 8143);
  createProxy().listen(port, '127.0.0.1', () => console.log('Huiji API proxy ' + VERSION + ' ready on http://127.0.0.1:' + port));
}
