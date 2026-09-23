'use strict';

const CHANNEL = 'huiji-local-visualeditor-v1';

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) {
    return;
  }
  const message = event.data;
  if (!message || message.channel !== CHANNEL || message.direction !== 'to-extension') {
    return;
  }

  chrome.runtime.sendMessage({
    type: 'huiji-local-ve-fetch',
    request: message.request
  }, (response) => {
    const runtimeError = chrome.runtime.lastError;
    window.postMessage({
      channel: CHANNEL,
      direction: 'to-page',
      id: message.id,
      response: runtimeError ? {
        ok: false,
        status: 0,
        statusText: runtimeError.message,
        body: ''
      } : response
    }, location.origin);
  });
});
