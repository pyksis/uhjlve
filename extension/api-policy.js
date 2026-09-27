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
