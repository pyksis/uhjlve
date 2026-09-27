(function () {
  'use strict';

  const CHANNEL = 'huiji-local-visualeditor-v2';
  const BRIDGE_VERSION = '1.0.4';
  const DOMAIN = 'unimage.huijiwiki.com';
  const API_ROOT = '/' + DOMAIN + '/v3/';
  const HTML_ACCEPT = 'text/html; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/HTML/2.0.0"';
  const pending = new Map();
  let requestId = 0;
  let statusNode;

  function setStatus(state, text, errorCode) {
    if (!document.documentElement) {
      return;
    }
    if (!statusNode) {
      statusNode = document.createElement('div');
      statusNode.id = 'huiji-local-ve-status-v2';
      document.documentElement.appendChild(statusNode);
    }
    statusNode.dataset.state = state;
    statusNode.textContent = text;
    statusNode.title = '页面仍使用灰机官方 VisualEditor；仅 Parsoid 转换在本机运行。';
    if (errorCode === 'browser-verification-required' || errorCode === 'upstream-invalid-response') {
      const link = document.createElement('a');
      link.href = location.origin + '/api.php?action=query&meta=siteinfo&siprop=general&format=json';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '打开验证页';
      link.style.marginLeft = '8px';
      statusNode.appendChild(link);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) {
      return;
    }
    const message = event.data;
    if (!message || message.channel !== CHANNEL) {
      return;
    }
    if (message.direction === 'relay-diagnostic') {
      setStatus('error', String(message.text || '浏览器 API 通道未连接'));
      return;
    }
    if (message.direction !== 'to-page') return;
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);
    const response = message.response || {};
    if (response.ok) {
      entry.resolve(response);
    } else {
      const error = new Error(response.statusText || '本地 Parsoid 请求失败');
      error.status = response.status || 0;
      error.body = response.body || '';
      error.code = response.errorCode || 'huiji-local-parsoid';
      setStatus('error', error.message, error.code);
      entry.reject(error);
    }
  });

  function localFetch(request) {
    const operation = new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('本地 Parsoid 请求超时'));
      }, 120000);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({
        channel: CHANNEL,
        direction: 'to-extension',
        id,
        request
      }, location.origin);
    });
    return operation.catch(async (error) => {
      // A cached 1.0.1 background worker does not enrich Parsoid errors.
      if (error.status >= 500 && !request.path.startsWith('/_bridge/')) {
        try {
          const health = JSON.parse((await localFetch({ path: '/_bridge/status', method: 'GET' })).body);
          const cause = health.lastError;
          if (cause && Date.now() - cause.time < 45000) {
            error.code = cause.code;
            const messages = {
              'browser-verification-required': '灰机 API 要求浏览器验证；请点击“打开验证页”，完成后重试',
              'browser-relay-timeout': '浏览器 API 请求超时，请保持灰机窗口打开后重试',
              'upstream-network': '暂时无法连接灰机 API，请检查网络后重试'
            };
            error.message = messages[cause.code] || cause.message;
            setStatus('error', error.message, error.code);
          }
        } catch (ignore) {}
      }
      throw error;
    });
  }

  function formBody(values) {
    const params = new URLSearchParams();
    Object.keys(values).forEach((key) => {
      if (values[key] !== undefined && values[key] !== null) {
        params.set(key, String(values[key]));
      }
    });
    return params.toString();
  }

  function parsoidPath(kind, pageName, oldId) {
    return API_ROOT + kind + '/' + encodeURIComponent(pageName) +
      (oldId === undefined || oldId === null || oldId === 0 ? '' : '/' + encodeURIComponent(oldId));
  }

  function wikitextToHtml(pageName, wikitext, oldId, bodyOnly) {
    return localFetch({
      path: parsoidPath('transform/wikitext/to/html', pageName, oldId),
      method: 'POST',
      headers: {
        'Accept': HTML_ACCEPT,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
      },
      body: formBody({
        title: pageName,
        wikitext,
        body_only: bodyOnly ? 1 : 0,
        stash: 0
      })
    });
  }

  function pageToHtml(pageName, oldId) {
    return localFetch({
      path: parsoidPath('page/html', pageName, oldId) + '?redirect=false&stash=true',
      method: 'GET',
      headers: { 'Accept': HTML_ACCEPT }
    });
  }

  function htmlToWikitext(pageName, html, oldId, etag) {
    const headers = {
      'Accept': 'text/plain; charset=utf-8',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    };
    if (etag) {
      headers['If-Match'] = etag;
    }
    return localFetch({
      path: parsoidPath('transform/html/to/wikitext', pageName, oldId),
      method: 'POST',
      headers,
      body: formBody({ html, scrub_wikitext: 1 })
    }).then((response) => response.body);
  }

  function apiPromise(jqPromise) {
    return new Promise((resolve, reject) => {
      jqPromise.then(resolve, (code, data) => reject({ code, data }));
    });
  }

  function rejectionData(error) {
    if (error && error.data) {
      return error.data;
    }
    const message = error && error.message ? error.message : String(error);
    return {
      errors: [{
        code: 'huiji-local-parsoid',
        html: window.jQuery('<div>').text('本地 VisualEditor 服务失败：' + message).html()
      }]
    };
  }

  function toJqPromise(promise) {
    const deferred = window.jQuery.Deferred();
    promise.then(
      (value) => deferred.resolve(value),
      (error) => deferred.reject(error.code || 'huiji-local-parsoid', rejectionData(error))
    );
    return deferred.promise({ abort: function () {} });
  }

  function patchLoader() {
    if (!window.mw || !mw.libs || !mw.libs.ve || !mw.libs.ve.targetLoader) {
      return false;
    }
    const loader = mw.libs.ve.targetLoader;
    if (loader.huijiLocalPatched === BRIDGE_VERSION) {
      return true;
    }
    loader.huijiLocalPatched = BRIDGE_VERSION;

    loader.requestParsoidData = function (pageName, options) {
      options = options || {};
      const data = {
        action: 'visualeditor',
        paction: 'metadata',
        page: pageName,
        badetag: options.badetag,
        uselang: mw.config.get('wgUserLanguage'),
        editintro: options.editintro,
        preload: options.preload,
        preloadparams: options.preloadparams,
        formatversion: 2
      };
      if (options.oldId !== undefined) {
        data.oldid = options.oldId;
      }

      const metadata = apiPromise((new mw.Api()).get(data));
      const htmlRequest = options.wikitext !== undefined ?
        wikitextToHtml(pageName, options.wikitext, options.oldId, false) :
        pageToHtml(pageName, options.oldId);

      const request = Promise.all([
        metadata,
        htmlRequest.catch((error) => {
          if (error.status === 404) {
            return { body: '', headers: {} };
          }
          throw error;
        })
      ]).then((results) => {
        const response = results[0];
        const html = results[1];
        response.visualeditor = response.visualeditor || {};
        response.visualeditor.content = html.body;
        response.visualeditor.etag = html.headers && html.headers.etag;
        response.visualeditor.switched = options.wikitext !== undefined;
        response.visualeditor.fromEditedState = !!options.modified;
        response.veMode = 'visual';
        return response;
      });
      return toJqPromise(request);
    };

    return true;
  }

  function serializeDocument(target, doc) {
    if (typeof doc === 'string') {
      return Promise.resolve(doc);
    }
    const html = mw.libs.ve.targetSaver.getHtml(doc, target.doc);
    return htmlToWikitext(target.getPageName(), html, target.revid, target.etag);
  }

  function compareWikitext(target, wikitext) {
    if (!target.revid) {
      return Promise.resolve({ diff: '' });
    }
    return apiPromise((new mw.Api()).post({
      action: 'compare',
      fromrev: target.revid,
      totext: wikitext,
      topst: 1,
      prop: 'diff',
      formatversion: 2
    })).then((response) => ({
      diff: response.compare && (response.compare.body || response.compare['*']) || ''
    }));
  }

  function publishWikitext(target, doc, options) {
    setStatus('working', '正在转换并发布…');
    return serializeDocument(target, doc).then((wikitext) => {
      const edit = {
        action: 'edit',
        title: target.getPageName(),
        text: wikitext,
        summary: options.summary || '',
        basetimestamp: target.baseTimeStamp,
        starttimestamp: target.startTimeStamp,
        watchlist: options.watchlist || 'preferences',
        assert: mw.user.isAnon() ? 'anon' : 'user',
        assertuser: mw.user.getName() || undefined,
        formatversion: 2,
        errorformat: 'html',
        errorlang: mw.config.get('wgUserLanguage'),
        errorsuselocal: true
      };
      if (options.minor) {
        edit.minor = 1;
      }
      if (options.captchaid) {
        edit.captchaid = options.captchaid;
        edit.captchaword = options.captchaword;
      }
      if (target.section !== null && target.section !== undefined) {
        edit.section = target.section;
      }
      if (target.sectionTitle && target.sectionTitle.getValue()) {
        edit.sectiontitle = target.sectionTitle.getValue();
      }
      return apiPromise((new mw.Api()).postWithToken('csrf', edit, {
        contentType: 'multipart/form-data'
      }));
    }).then((response) => {
      if (!response.edit || response.edit.result !== 'Success') {
        throw {
          code: 'edit-failed',
          data: response
        };
      }
      target.clearDocState();
      if (target.saveDeferred) {
        target.saveDeferred.resolve();
      }
      setStatus('ready', '发布成功，正在刷新…');
      window.setTimeout(() => {
        location.href = mw.util.getUrl(target.getPageName(), { venotify: 'saved' });
      }, 80);
      return response.edit;
    });
  }

  function patchCore() {
    if (!window.ve || !ve.init || !ve.init.mw || !ve.init.mw.Target || !ve.init.mw.ArticleTarget) {
      return false;
    }
    const Target = ve.init.mw.Target;
    const ArticleTarget = ve.init.mw.ArticleTarget;
    if (ArticleTarget.prototype.huijiLocalPatched === BRIDGE_VERSION) {
      return true;
    }
    ArticleTarget.prototype.huijiLocalPatched = BRIDGE_VERSION;

    Target.prototype.parseWikitextFragment = function (wikitext, pst, doc) {
      const pageName = this.getPageName(doc);
      return toJqPromise(wikitextToHtml(pageName, wikitext, undefined, true).then((response) => ({
        visualeditor: {
          result: 'success',
          content: response.body
        }
      })));
    };

    ArticleTarget.prototype.prepareCacheKey = function () {};
    ArticleTarget.prototype.clearPreparedCacheKey = function () {};

    ArticleTarget.prototype.tryWithPreparedCacheKey = function (doc, extraData) {
      const target = this;
      const request = serializeDocument(target, doc).then((wikitext) => {
        if (extraData.paction === 'diff') {
          return compareWikitext(target, wikitext);
        }
        return { result: 'success', content: wikitext };
      });
      return toJqPromise(request);
    };

    ArticleTarget.prototype.save = function (doc, options) {
      const target = this;
      if (this.saving) {
        return this.saving;
      }
      const promise = toJqPromise(publishWikitext(target, doc, options || {}));
      this.saving = promise;
      promise.fail((code, data) => {
        setStatus('error', '发布失败；内容仍保留在编辑器中');
        target.saveFail(doc, options || {}, false, code, data);
      }).always(() => {
        target.saving = null;
      });
      return promise;
    };

    ArticleTarget.prototype.onSaveDialogPreview = function () {
      const target = this;
      if (this.saveDialog.$previewViewer.children().length) {
        this.saveDialog.swapPanel('preview');
        return;
      }
      this.emit('savePreview');
      this.saveDialog.pushPending();
      serializeDocument(this, this.getDocToSave())
        .then((wikitext) => {
          if (target.sectionTitle && target.sectionTitle.getValue()) {
            wikitext = '== ' + target.sectionTitle.getValue() + ' ==\n\n' + wikitext;
          }
          return wikitextToHtml(target.getPageName(), wikitext, target.revid, false);
        })
        .then((response) => {
          const baseDoc = target.getSurface().getModel().getDocument().getHtmlDocument();
          const previewDoc = target.constructor.static.parseDocument(response.body, 'visual');
          target.saveDialog.showPreview(previewDoc, baseDoc);
        })
        .catch((error) => {
          target.saveDialog.showPreview(window.jQuery('<div>').text('预览失败：' + error.message));
        })
        .then(() => target.bindSaveDialogClearDiff());
    };

    return true;
  }

  function tick() {
    patchLoader();
    patchCore();
  }

  const timer = window.setInterval(tick, 50);
  window.setTimeout(() => window.clearInterval(timer), 600000);
  tick();

  function checkHealth(attempt) {
    localFetch({ path: '/_version', method: 'GET' }).then((response) => {
      let version = '';
      try { version = JSON.parse(response.body).version || ''; } catch (ignore) {}
      return localFetch({ path: '/_bridge/status', method: 'GET' }).then((relay) => {
        const health = JSON.parse(relay.body);
        if (health.version !== BRIDGE_VERSION) {
          setStatus('error', '本地代理需要更新：请重新运行启动 CMD');
        } else if (health.relayConnected) {
          setStatus('ready', '本地 Parsoid ' + version + ' 已连接 · 浏览器 API 通道就绪');
        } else if ((attempt || 0) < 10) {
          setStatus('working', '正在连接灰机浏览器 API 通道…');
          window.setTimeout(() => checkHealth((attempt || 0) + 1), 500);
        } else {
          setStatus('error', '浏览器 API 通道未连接，请重新加载扩展和本页面');
        }
      });
    }).catch(() => {
      setStatus('error', '本地 VisualEditor 服务未启动');
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => checkHealth(0), { once: true });
  } else {
    checkHealth();
  }
}());
