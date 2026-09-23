'use strict';

const LOCAL_ORIGIN = 'http://127.0.0.1:8142';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'huiji-local-ve-fetch') {
    return false;
  }
  if (!sender.tab || !sender.tab.url || !sender.tab.url.startsWith('https://unimage.huijiwiki.com/')) {
    sendResponse({ ok: false, status: 403, statusText: 'Forbidden sender' });
    return false;
  }

  const request = message.request || {};
  const path = String(request.path || '');
  if (!path.startsWith('/') || path.includes('..')) {
    sendResponse({ ok: false, status: 400, statusText: 'Invalid local path' });
    return false;
  }

  const method = request.method === 'POST' ? 'POST' : 'GET';
  const headers = {};
  const allowedHeaders = ['Accept', 'Accept-Language', 'Content-Type', 'If-Match'];
  allowedHeaders.forEach((name) => {
    if (request.headers && request.headers[name]) {
      headers[name] = String(request.headers[name]);
    }
  });

  fetch(LOCAL_ORIGIN + path, {
    method,
    headers,
    body: method === 'POST' ? String(request.body || '') : undefined,
    cache: 'no-store',
    credentials: 'omit'
  }).then(async (response) => {
    const responseHeaders = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name.toLowerCase()] = value;
    });
    sendResponse({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: await response.text()
    });
  }).catch((error) => {
    sendResponse({
      ok: false,
      status: 0,
      statusText: error && error.message ? error.message : String(error),
      body: ''
    });
  });
  return true;
});
