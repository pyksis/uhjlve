'use strict';

const LOCAL_ORIGIN = 'http://127.0.0.1:8142';
const ERROR_MESSAGES = {
  'browser-verification-required': '灰机 API 要求浏览器验证；请点击右下角的“打开验证页”，完成后再重试',
  'browser-relay-timeout': '灰机 API 请求超时；请保持这个灰机窗口打开后重试',
  'browser-relay-busy': '正在等待其他灰机请求完成，请稍后重试',
  'upstream-network': '暂时无法连接灰机 API，请检查网络后重试',
  'upstream-invalid-response': '灰机 API 返回了网页而非数据；请打开验证页检查',
  'upstream-http': '灰机 API 暂时返回错误，请稍后重试'
};

async function localResponse(url, init) {
  const response = await fetch(url, Object.assign({ cache: 'no-store', credentials: 'omit' }, init));
  const headers = {};
  response.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
  return { ok: response.ok, status: response.status, statusText: response.statusText, headers, body: await response.text() };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !['huiji-local-ve-fetch', 'huiji-local-api-next', 'huiji-local-api-complete'].includes(message.type)) return false;
  const senderUrl = sender.url || sender.tab && sender.tab.url || '';
  if (!sender.tab || sender.frameId !== 0 || !senderUrl.startsWith('https://unimage.huijiwiki.com/')) {
    sendResponse({ ok: false, status: 403, statusText: 'Forbidden sender' });
    return false;
  }

  async function processMessage() {
    if (message.type !== 'huiji-local-ve-fetch') {
      if (!/^[a-f0-9]{64}$/.test(message.session || '')) throw new Error('Invalid relay session');
      const route = message.type === 'huiji-local-api-next' ? '/_bridge/next' : '/_bridge/complete';
      return localResponse(LOCAL_ORIGIN + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: message.session, id: message.id, response: message.response })
      });
    }
    const request = message.request || {};
    const path = String(request.path || '');
    const url = new URL(path, LOCAL_ORIGIN);
    if (!path.startsWith('/') || path.startsWith('//') || url.origin !== LOCAL_ORIGIN ||
        !(url.pathname === '/_version' || ['/_bridge/status', '/_bridge/next', '/_bridge/complete'].includes(url.pathname) || url.pathname.startsWith('/unimage.huijiwiki.com/v3/'))) {
      throw new Error('Invalid local Parsoid path');
    }
    const method = request.method === 'POST' ? 'POST' : 'GET';
    const headers = {};
    ['Accept', 'Accept-Language', 'Content-Type', 'If-Match'].forEach((name) => {
      if (request.headers && request.headers[name]) headers[name] = String(request.headers[name]);
    });
    const result = await localResponse(LOCAL_ORIGIN + path, { method, headers, body: method === 'POST' ? String(request.body || '') : undefined });
    if (!result.ok && result.status >= 500 && !url.pathname.startsWith('/_bridge/')) {
      try {
        const health = JSON.parse((await localResponse(LOCAL_ORIGIN + '/_bridge/status')).body);
        const error = health.lastError;
        if (error && Date.now() - error.time < 45000) {
          result.errorCode = error.code;
          result.statusText = ERROR_MESSAGES[error.code] || error.message;
        }
      } catch (ignore) {}
    }
    return result;
  }

  processMessage().then(sendResponse).catch((error) => {
    sendResponse({ ok: false, status: 0, statusText: error && error.message ? error.message : String(error), body: '' });
  });
  return true;
});
