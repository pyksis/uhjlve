'use strict';

// Keep the original edit base in RAM, as RESTBase normally does. Never reuse
// rendered HTML to open a page: templates must still be expanded afresh.
function createSnapshots(options) {
  options = options || {};
  const ttl = options.ttl || 30 * 60 * 1000;
  const limit = options.limit || 32 * 1024 * 1024;
  const now = options.now || Date.now;
  const entries = new Map();
  let bytes = 0;
  function remove(key) { const old = entries.get(key); if (old) { bytes -= old.bytes; entries.delete(key); } }
  return {
    put(key, source, html) {
      const size = Buffer.byteLength(source) + Buffer.byteLength(html);
      remove(key);
      if (size > limit) return;
      while (bytes + size > limit || entries.size >= 32) remove(entries.keys().next().value);
      entries.set(key, { source, html, bytes: size, expires: now() + ttl });
      bytes += size;
    },
    get(key) {
      const item = entries.get(key);
      if (!item) return null;
      if (item.expires <= now()) { remove(key); return null; }
      entries.delete(key); entries.set(key, item);
      return { source: item.source, html: item.html };
    }
  };
}
module.exports = { createSnapshots };
