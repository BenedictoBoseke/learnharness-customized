/* Android host adapter for the ORIGINAL LearnHarness UI.
 * Keep account credentials and provider URLs in the Node/native owners.
 * This file only passes the server's one-use, opaque browser action.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.install(root);
})(typeof window === 'object' ? window : undefined, function () {
  'use strict';
  const ACTION = /^\/api\/subscriptions\/browser\?id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const isAllowedAction = action => typeof action === 'string' && ACTION.test(action);
  function install(window) {
    if (!window || window.location?.protocol !== 'http:' || window.location.hostname !== '127.0.0.1' || !/^\d+$/.test(window.location.port)) return false;
    const host = window.AndroidHost;
    if (!host || typeof host.openSubscriptionBrowser !== 'function') return false;
    // The original browser UI defaults to an open desktop sidebar. Seed its
    // existing preference before hydration on phones; keep later user choices.
    try {
      if (window.innerWidth < 700 && window.localStorage?.getItem('lh:sidebar-open') === null)
        window.localStorage.setItem('lh:sidebar-open', '0');
    } catch { /* Storage may be unavailable until the document is committed. */ }
    const picks=new Map();
    window.addEventListener?.('lh:document-picked',event=>{const entry=picks.get(event.detail?.requestId);if(!entry)return;picks.delete(event.detail.requestId);clearTimeout(entry.timer);entry.resolve(event.detail.document||null);});
    const previous = window.lh || {};
    window.lh = Object.freeze({
      ...previous,
      platform: 'android',
      documents: Object.freeze({pick(kind="markdown"){return new Promise((resolve,reject)=>{if(typeof host.chooseMarkdownDocument!=='function'){reject(new Error('Update the Android app to link writable notes.'));return;}const requestId=window.crypto.randomUUID();const timer=setTimeout(()=>{picks.delete(requestId);reject(new Error('Document selection timed out. Choose the file again.'));},300000);picks.set(requestId,{resolve,reject,timer});try{if(host.chooseMarkdownDocument(requestId,kind)!==''){clearTimeout(timer);picks.delete(requestId);reject(new Error('Another file selection is open.'));}}catch{clearTimeout(timer);picks.delete(requestId);reject(new Error('The document picker could not open.'));}});}}),
      subscriptionTransport: 'web',
      // The original sidebar calls this unconditionally when an lh bridge
      // exists. Android cannot resize its OS window: the mobile layout owns
      // presentation, and may react to this event to reveal its drawer.
      expandWindow() {
        if (typeof window.dispatchEvent === 'function' && typeof window.CustomEvent === 'function') window.dispatchEvent(new window.CustomEvent('lh:mobile-sidebar-requested'));
      },
      async openSubscriptionBrowser(action) {
        if (!isAllowedAction(action)) throw new Error('Invalid sign-in action. Start sign-in from Providers.');
        let result;
        try { result = host.openSubscriptionBrowser(action); }
        catch { throw new Error('The sign-in browser could not be opened. Retry in Providers.'); }
        // @JavascriptInterface returns an empty string after native has
        // resolved303 and scheduled ACTION_VIEW. Nonempty/error values are
        // intentionally not echoed: they could contain an authorization URL.
        if (result !== '') throw new Error('The sign-in browser could not be opened. Retry in Providers.');
      },
    });
    window.addEventListener?.('lh:android-files', async event => {
      const paths=event.detail;
      if(!Array.isArray(paths)||!paths.length||!paths.every(p=>typeof p==='string'&&p.startsWith('/data/')&&!p.includes('\0')))return;
      try{const response=await window.fetch('/api/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'register-files',paths})});if(!response.ok)throw new Error('Attachment registration failed');}catch{return;}
      const active=window.document?.activeElement?.closest?.('[data-file-path-input]');
      const target=active||window.document?.querySelector?.('[data-file-path-default]')||window.document?.querySelector?.('[data-file-path-input]');
      if(target)target.dispatchEvent(new window.CustomEvent('lh:insert-file-paths',{detail:paths}));
    });
    return true;
  }
  return { install, isAllowedAction };
});
