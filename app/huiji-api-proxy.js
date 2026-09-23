'use strict';

var http = require('http');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var PORT = Number(process.env.HUIJI_PROXY_PORT || 8143);
var ORIGIN = 'https://unimage.huijiwiki.com';
var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 HuijiLocalVisualEditor/1.0';

function parseHeaders(raw) {
  var blocks = raw.split(/\r?\n\r?\n/).filter(function (block) {
    return /^HTTP\//.test(block);
  });
  var lines = (blocks[blocks.length - 1] || '').split(/\r?\n/);
  var statusMatch = (lines.shift() || '').match(/^HTTP\/\S+\s+(\d+)/);
  var headers = {};
  lines.forEach(function (line) {
    var colon = line.indexOf(':');
    if (colon > 0) {
      var name = line.slice(0, colon).trim().toLowerCase();
      var value = line.slice(colon + 1).trim();
      if (['content-type', 'etag', 'last-modified', 'content-language', 'cache-control', 'vary'].indexOf(name) !== -1) {
        headers[name] = value;
      }
    }
  });
  headers['access-control-allow-origin'] = '*';
  return { status: statusMatch ? Number(statusMatch[1]) : 502, headers: headers };
}

http.createServer(function (req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  if (req.url === '/_health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, target: ORIGIN }));
    return;
  }

  var headerFile = path.join(os.tmpdir(), 'huiji-ve-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.headers');
  var args = [
    '-sS', '--fail-with-body', '--max-time', '60',
    '-A', USER_AGENT,
    '-e', ORIGIN + '/wiki/%E9%A6%96%E9%A1%B5',
    '-X', req.method,
    '-D', headerFile
  ];
  if (req.headers['accept-language']) {
    args.push('-H', 'Accept-Language: ' + req.headers['accept-language']);
  }
  if (req.headers['content-type']) {
    args.push('-H', 'Content-Type: ' + req.headers['content-type']);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    args.push('--data-binary', '@-');
  }
  args.push(ORIGIN + req.url);

  var curl = childProcess.spawn('curl.exe', args, { windowsHide: true });
  var chunks = [];
  var errors = [];
  curl.stdout.on('data', function (chunk) { chunks.push(chunk); });
  curl.stderr.on('data', function (chunk) { errors.push(chunk); });
  req.pipe(curl.stdin);
  curl.on('close', function () {
    var meta;
    try {
      meta = parseHeaders(fs.readFileSync(headerFile, 'utf8'));
    } catch (e) {
      meta = { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } };
    }
    try { fs.unlinkSync(headerFile); } catch (ignore) {}
    var body = Buffer.concat(chunks);
    if (!body.length && meta.status >= 400 && errors.length) {
      body = Buffer.concat(errors);
    }
    res.writeHead(meta.status, meta.headers);
    res.end(body);
  });
  curl.on('error', function (error) {
    try { fs.unlinkSync(headerFile); } catch (ignore) {}
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(error));
  });
}).listen(PORT, '127.0.0.1', function () {
  process.stdout.write('Huiji API proxy ready on http://127.0.0.1:' + PORT + '\n');
});
