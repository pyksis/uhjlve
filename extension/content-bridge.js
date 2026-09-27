'use strict';

// Inline the policy as well: a cached 1.0.1 manifest does not inject api-policy.js.
(function (root) {
  'use strict';

  // Shared by the proxy and the isolated content script. Publishing stays in mw.Api.
  function validate(request) {
    if (!request || !['GET', 'POST'].includes(request.method)) throw new Error('Unsupported API method');
    const url = new URL(request.path, 'https://unimage.huijiwiki.com');
    if (url.origin !== 'https://unimage.huijiwiki.com' || url.pathname !== '/api.php') throw new Error('Only the wiki API is allowed');
    const params = new URLSearchParams(url.search);
    if (request.method === 'POST') {
      if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.contentType || '')) throw new Error('Only form-encoded API requests are allowed');
      new URLSearchParams(request.body || '').forEach((value, name) => params.append(name, value));
    }
    if (params.getAll('action').length !== 1 || !['query', 'parse', 'expandtemplates', 'templatedata', 'paraminfo'].includes(params.get('action'))) throw new Error('Only Parsoid read and parse actions are allowed');
    if (params.getAll('format').length !== 1 || params.get('format') !== 'json' || params.has('token') || params.has('callback') || params.has('assertuser')) throw new Error('API tokens and JSONP are not allowed');
    if (params.get('action') === 'query') {
      const meta = params.get('meta');
      const props = (params.get('prop') || '').split('|').filter(Boolean);
      if (params.getAll('meta').length > 1 || params.getAll('prop').length > 1 || (meta && meta !== 'siteinfo') || params.has('list') || params.has('generator') || props.some((prop) => !['info', 'revisions', 'imageinfo', 'videoinfo', 'pageprops'].includes(prop)) || (!meta && !props.length)) throw new Error('Only site configuration, page source and media information are allowed');
    }
    return params;
  }
  const policy = { validate };
  if (typeof module === 'object' && module.exports) module.exports = policy;
  else root.HuijiApiPolicy = policy;
}(typeof globalThis === 'object' ? globalThis : this));

const CHANNEL = 'huiji-local-visualeditor-v2';
const sessionBytes = crypto.getRandomValues(new Uint8Array(32));
const RELAY_SESSION = Array.from(sessionBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
let stopped = false;
let relayEpoch = 0;

function sendBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        if (/context invalidated/i.test(error.message)) stopped = true;
        reject(new Error(error.message));
      }
      else if (!response || (!response.ok && message.type !== 'huiji-local-ve-fetch')) reject(new Error(response && response.statusText || 'Local proxy unavailable'));
      else resolve(response);
    });
  });
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const message = event.data;
  if (!message || message.channel !== CHANNEL || message.direction !== 'to-extension') return;
  sendBackground({ type: 'huiji-local-ve-fetch', request: message.request }).then((response) => {
    window.postMessage({ channel: CHANNEL, direction: 'to-page', id: message.id, response }, location.origin);
  }).catch((error) => {
    window.postMessage({ channel: CHANNEL, direction: 'to-page', id: message.id,
      response: { ok: false, status: 0, statusText: error.message, body: '' } }, location.origin);
  });
});

async function readWikiApi(request) {
  // The isolated content script uses the page's same-origin browser connection.
  // Cookies remain in the browser; only allowlisted API response bodies are relayed.
  try { HuijiApiPolicy.validate(request); } catch (error) {
    return { status: 400, body: JSON.stringify({ error: { code: 'forbidden-api', info: error.message } }) };
  }
  const deadline = Date.now() + 25000;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(12000, Math.max(1, deadline - Date.now())));
    let result;
    try {
      const response = await fetch(new URL(request.path, location.origin).href, {
        method: request.method,
        headers: request.method === 'POST' ? { 'Content-Type': request.contentType } : undefined,
        body: request.method === 'POST' ? request.body : undefined,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal
      });
      const body = await response.text();
      if (response.headers.get('cf-mitigated') === 'challenge' || /cf-chl|challenge-platform|启用 JavaScript 和 Cookie/.test(body)) {
        return { status: 503, errorCode: 'browser-verification-required',
          message: 'The wiki API requires browser verification.',
          body: JSON.stringify({ error: { code: 'browser-verification-required', info: 'Complete wiki browser verification.' } }) };
      }
      let parsed;
      if (response.ok) {
        try { parsed = JSON.parse(body); } catch (ignore) {
          return { status: 503, errorCode: 'upstream-invalid-response',
            body: JSON.stringify({ error: { code: 'upstream-invalid-response', info: 'The wiki API returned HTML instead of JSON.' } }) };
        }
      }
      result = { status: response.status, body,
        headers: { 'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8' } };
      if (![429, 500, 502, 503, 504].includes(response.status) && !(parsed && parsed.error && parsed.error.code === 'maxlag')) return result;
      const retryAfter = Number(response.headers.get('retry-after'));
      const pause = Math.min(5000, Math.max(500 * (attempt + 1), isFinite(retryAfter) ? retryAfter * 1000 : 0));
      if (attempt < 2 && Date.now() + pause + 1000 < deadline) await new Promise((resolve) => setTimeout(resolve, pause));
      else return result;
    } catch (error) {
      result = { status: 503, errorCode: 'upstream-network',
        message: 'The wiki API connection timed out or failed.',
        body: JSON.stringify({ error: { code: 'upstream-network', info: 'The wiki API connection timed out or failed.' } }) };
      if (attempt === 2 || Date.now() + 1000 >= deadline) return result;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    } finally { clearTimeout(timer); }
  }
}

async function relayWorker() {
  const epoch = relayEpoch;
  while (!stopped && epoch === relayEpoch) {
    try {
      const poll = await sendBackground({ type: 'huiji-local-ve-fetch', request: {
        path: '/_bridge/next', method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: RELAY_SESSION })
      } });
      if (!poll.ok) throw new Error('Browser relay route is not ready');
      const job = JSON.parse(poll.body).job;
      if (job) {
        const response = await readWikiApi(job.request);
        const complete = await sendBackground({ type: 'huiji-local-ve-fetch', request: {
          path: '/_bridge/complete', method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: RELAY_SESSION, id: job.id, response })
        } });
        if (!complete.ok) throw new Error('Browser relay completion failed');
      } else await new Promise((resolve) => setTimeout(resolve, Number(JSON.parse(poll.body).retryAfter) || 300));
    } catch (error) {
      window.postMessage({ channel: CHANNEL, direction: 'relay-diagnostic',
        text: '浏览器 API 通道连接失败：' + error.message }, location.origin);
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

window.addEventListener('pagehide', () => { stopped = true; relayEpoch++; });
window.addEventListener('pageshow', (event) => {
  if (event.persisted && stopped) {
    stopped = false;
    for (let i = 0; i < 3; i++) relayWorker();
  }
});
for (let i = 0; i < 3; i++) relayWorker();
