'use strict';

// Read-only round-trip against the running local services. Never publishes.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DOMUtils } = require('../runtime/parsoid/lib/utils/DOMUtils.js');
const base = 'http://127.0.0.1:8142/unimage.huijiwiki.com/v3/';

function request(url, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: body === undefined ? 'GET' : 'POST',
      headers: Object.assign({}, headers, body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const result = { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') };
        if (result.status !== 200) reject(new Error('Local conversion returned ' + result.status + ': ' + result.body.slice(0, 250)));
        else resolve(result);
      });
    });
    req.setTimeout(90000, () => req.destroy(new Error('Local conversion timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  const title = process.argv[2] || '武器';
  const revision = process.argv[3] || '2069';
  const suffix = encodeURIComponent(title) + '/' + encodeURIComponent(revision);
  const apiPath = new URLSearchParams({ action: 'query', prop: 'revisions', revids: revision,
    rvprop: 'content', rvslots: 'main', format: 'json', formatversion: '2' });
  const sourceResponse = await request('http://127.0.0.1:8143/api.php?' + apiPath);
  const page = JSON.parse(sourceResponse.body).query.pages[0];
  assert.equal(page.title, title);
  const source = page.revisions[0].slots.main.content;
  assert.equal(typeof source, 'string');
  const rendered = await request(base + 'page/html/' + suffix, undefined, { Accept: 'text/html; profile="https://www.mediawiki.org/wiki/Specs/HTML/2.0.0"' });
  const convert = (html) => request(base + 'transform/html/to/wikitext/' + suffix,
    new URLSearchParams({ html, scrub_wikitext: '1' }).toString(), { Accept: 'text/plain', 'If-Match': rendered.headers.etag });
  const unchanged = await convert(rendered.body);
  assert.equal(unchanged.body, source, 'Unchanged page preserves the entire original source exactly');
  const doc = DOMUtils.parseHTML(rendered.body);
  const marker = 'LOCAL_SERIALIZER_TEST_DO_NOT_PUBLISH';
  const paragraph = doc.createElement('p');
  paragraph.textContent = marker;
  doc.body.appendChild(paragraph);
  const edited = await convert(doc.documentElement.outerHTML);
  assert(edited.body.includes(marker), 'New visual text is serialized');
  assert(edited.body.includes(source.trim()), 'Unchanged original source is preserved');
  const logDir = path.join(__dirname, '../logs');
  fs.writeFileSync(path.join(logDir, 'serializer-roundtrip.html'), rendered.body);
  fs.writeFileSync(path.join(logDir, 'serializer-roundtrip.wikitext'), unchanged.body);
  console.log('PASS: ' + title + ' revision ' + revision + ' exact source round-trip and appended visual text; no wiki changes submitted');
})().catch((error) => { console.error(error); process.exitCode = 1; });
