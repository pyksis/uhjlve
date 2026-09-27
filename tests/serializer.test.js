'use strict';

const assert = require('assert');
const { WTSUtils } = require('../runtime/parsoid/lib/html2wt/WTSUtils.js');
const { DOMUtils } = require('../runtime/parsoid/lib/utils/DOMUtils.js');
const { DOMDataUtils } = require('../runtime/parsoid/lib/utils/DOMDataUtils.js');
const { SerializerState } = require('../runtime/parsoid/lib/html2wt/SerializerState.js');
const { buildSep } = require('../runtime/parsoid/lib/html2wt/separators.js');

// Source ranges can overlap after visual edits to nested/table content. The
// serializer deliberately returns null for these gaps; they must be rebuilt.
const doc = DOMUtils.parseHTML('<div><b>kept text</b></div>');
DOMDataUtils.setDocBag(doc);
const parent = doc.body.firstChild;
const child = parent.firstChild;
DOMDataUtils.getDataParsoid(parent).dsr = [0, 12, 6, 0];
DOMDataUtils.getDataParsoid(child).dsr = [2, 10, 3, 4];
const state = {
  env: { page: { src: '<div>text</div>' }, log: () => {} },
  selserMode: true, inModifiedContent: false,
  sep: { lastSourceNode: parent, src: '\n', constraints: { min: 1, max: 2 } },
  getOrigSrc: SerializerState.prototype.getOrigSrc
};
assert.equal(state.getOrigSrc(6, 2), null);
assert.equal(buildSep(state, child), '\n');
assert.equal(WTSUtils.isValidSep(null), false);
assert.equal(WTSUtils.isValidSep(undefined), false);
assert.equal(WTSUtils.isValidSep(0), false);
assert(WTSUtils.isValidSep(' \n<!--preserve comment-->'));
assert(WTSUtils.isValidSep(''));
assert(!WTSUtils.isValidSep('content'));
const parse = require('../runtime/parsoid/lib/parse.js');
const options = {
  fetchConfig: false, fetchTemplates: false, usePHPPreProcessor: false,
  useBatchAPI: false,
  mwApis: [{ prefix: 'zhwiki', domain: 'zh.wikipedia.org', uri: 'http://127.0.0.1:9/api.php' }]
};
const envOptions = { prefix: 'zhwiki', pageName: '测试页面' };
const source = '== 标题 ==\n\n正文与[[标签/源生|源生]]，[https://example.com 外部链接]。\n\n* 第一项\n* 第二项\n\n{| class="wikitable"\n! 属性 !! 数值\n|-\n| 伤害 || 9\n|}\n\n{{武器模板|名称=体肉|伤害=9}}\n<!--保留原始注释-->\n';

(async () => {
  const original = await parse({ input: source, mode: 'wt2html', parsoidOptions: options, envOptions });
  const convert = (input) => parse({ input, mode: 'selser', parsoidOptions: options, envOptions,
    selser: { oldtext: source, oldhtml: original.html } });
  assert.equal((await convert(original.html)).wt, source, 'Exact source round-trip including templates, tables, lists, links and comments');
  const edited = DOMUtils.parseHTML(original.html);
  const cell = edited.querySelector('td');
  cell.textContent = '攻击伤害';
  const output = (await convert(edited.documentElement.outerHTML)).wt;
  assert(output.includes('攻击伤害'), 'Visual table edit survives conversion');
  assert(!output.includes('| 伤害 ||'), 'Replaced table text is removed');
  for (const preserved of ['== 标题 ==', '[[标签/源生|源生]]', '[https://example.com 外部链接]', '* 第一项\n* 第二项', '{{武器模板|名称=体肉|伤害=9}}', '<!--保留原始注释-->']) {
    assert(output.includes(preserved), 'Preserve untouched source: ' + preserved);
  }
  console.log('PASS: overlapping-source separator recovery; exact source round-trip; visual table edit; unchanged templates, headings, links, lists and comments');
})().catch((error) => { console.error(error); process.exitCode = 1; });
