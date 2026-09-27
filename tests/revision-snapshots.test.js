'use strict';

const assert = require('assert');
const http = require('http');
const { createSnapshots } = require('../app/revision-snapshots.js');
const parse = require('../runtime/parsoid/lib/parse.js');
const { DOMUtils } = require('../runtime/parsoid/lib/utils/DOMUtils.js');

let clock = 1;
const bounded = createSnapshots({ ttl: 20, limit: 12, now: () => clock });
bounded.put('a', 'aaaa', 'aa'); bounded.put('b', 'bbbb', 'bb');
assert(bounded.get('a'));
bounded.put('c', 'cccc', 'cc');
assert.equal(bounded.get('b'), null, 'Evict least recently used content at the memory limit');
clock = 22;
assert.equal(bounded.get('a'), null, 'Expired edit bases are discarded');
bounded.put('oversized', '1234567890123', '');
assert.equal(bounded.get('oversized'), null);

(async () => {
  let calls = 0;
  const sources = {
    1001: '== 原始标题 ==\n\n正文\n\n{| class="wikitable"\n| 攻击伤害 || 9\n|}\n',
    1002: '== 新修订标题 ==\n\n另一个修订的正文\n'
  };
  const server = http.createServer((req, res) => {
    calls++;
    const revision = Number(new URL(req.url, 'http://localhost').searchParams.get('revids'));
    assert(sources[revision], 'No unintended network request during conversion');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ query: { pages: { 1: { pageid: 1, ns: 0, title: '测试页面', lastrevid: 1002,
      revisions: [{ revid: revision, '*': sources[revision], contentmodel: 'wikitext', timestamp: '2026-09-27T00:00:00Z' }] } } } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const options = { fetchConfig: false, fetchTemplates: false, usePHPPreProcessor: false, useBatchAPI: false,
      mwApis: [{ prefix: 'zhwiki', domain: 'zh.wikipedia.org', uri: 'http://127.0.0.1:' + server.address().port + '/api.php' }] };
    const envOptions = { prefix: 'zhwiki', pageName: '测试页面' };
    const render = (oldid) => parse({ mode: 'wt2html', oldid, parsoidOptions: options, envOptions });
    const original = await render(1001);
    const another = await render(1002);
    await render(1001);
    assert.equal(calls, 3, 'Opening a page always fetches/expands it afresh');
    const convert = (input, oldid) => parse({ input, mode: 'selser', oldid, parsoidOptions: options, envOptions,
      selser: { oldtext: null, oldhtml: null } });
    const began = Date.now();
    assert.equal((await convert(original.html, 1001)).wt, sources[1001]);
    assert.equal((await convert(another.html, 1002)).wt, sources[1002], 'Revision keys prevent mixing edit bases');
    const edited = DOMUtils.parseHTML(original.html);
    edited.querySelector('td').textContent = '修改后的伤害';
    assert((await convert(edited.documentElement.outerHTML, 1001)).wt.includes('修改后的伤害'));
    assert.equal(calls, 3, 'Repeated save/diff conversions need no source fetch or original-page reparse');
    console.log('PASS: original revision reuse, exact round-trip, table edit, fresh opening, revision separation, expiry and memory bound; three conversions took ' + (Date.now() - began) + 'ms');
  } finally { await new Promise((resolve) => server.close(resolve)); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
