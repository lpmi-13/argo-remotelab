/* Runs in <head> before the Argo bundle. It consumes the launcher handoff and
 * reports only semantic network and URL events; no response bodies or secrets
 * are copied into learning actions. */
(function bootstrap() {
  const key = 'argo-coach:handoff';
  const launch = new URL(location.href);
  const fields = ['coach_session', 'coach_token', 'coach_run', 'coach_mode'];
  if (fields.every(field => launch.searchParams.has(field))) {
    const config = Object.fromEntries(fields.map(field => [field.slice(6), launch.searchParams.get(field)]));
    sessionStorage.setItem(key, JSON.stringify(config));
    for (const field of fields) launch.searchParams.delete(field);
    if (launch.pathname.startsWith('/argocd/')) {
      sessionStorage.setItem('argo-coach:argocd-landing', launch.pathname + launch.search + launch.hash);
    }
    history.replaceState(history.state, '', launch.href);
  }
  const activeHandoff = sessionStorage.getItem(key);

  if (activeHandoff && location.pathname.startsWith('/argocd/') && !sessionStorage.getItem('argo-coach:argocd-authenticated')) {
    document.documentElement.style.visibility = 'hidden';
    fetch('/coach/learning/api/auth/argocd', {credentials: 'same-origin'})
      .then(response => response.json().then(data => {
        if (!response.ok || !data.authenticated) throw new Error(data.error || 'Argo CD login failed');
        sessionStorage.setItem('argo-coach:argocd-authenticated', 'true');
        location.replace(sessionStorage.getItem('argo-coach:argocd-landing') || '/argocd/applications');
      }))
      .catch(() => { document.documentElement.style.visibility = ''; });
  }
  if (activeHandoff && location.pathname.startsWith('/gitea/') && !sessionStorage.getItem('argo-coach:gitea-authenticated')) {
    document.documentElement.style.visibility = 'hidden';
    fetch('/coach/learning/api/auth/gitea', {credentials: 'same-origin'})
      .then(response => response.json().then(data => {
        if (!response.ok || !data.authenticated) throw new Error(data.error || 'Gitea login failed');
        sessionStorage.setItem('argo-coach:gitea-authenticated', 'true');
        location.reload();
      }))
      .catch(() => { document.documentElement.style.visibility = ''; });
  }

  function send(kind, details) {
    dispatchEvent(new CustomEvent('argo-coach:' + kind, {detail: details}));
  }

  function observeRequest(method, input, body) {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href); }
    catch (_) { return; }
    if (url.origin !== location.origin || !url.pathname.includes('/api/v1/')) return;
    const detail = {method: String(method || 'GET').toUpperCase(), path: url.pathname, search: url.search};
    // Sync options are safe to observe; manifests, credentials and arbitrary
    // request bodies are deliberately ignored.
    if (detail.method === 'POST' && /\/sync$/.test(detail.path) && typeof body === 'string') {
      try {
        const options = JSON.parse(body);
        detail.sync = {prune: Boolean(options.prune), dryRun: Boolean(options.dryRun),
          resources: Array.isArray(options.resources) ? options.resources.map(item => ({kind: item.kind, name: item.name})) : []};
      } catch (_) { /* Keep the semantic endpoint event. */ }
    }
    send('network', detail);
  }

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (input, init) {
      observeRequest(init?.method || input?.method || 'GET', input, init?.body);
      return originalFetch.apply(this, arguments);
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__argoCoachRequest = {method, url};
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__argoCoachRequest) observeRequest(this.__argoCoachRequest.method, this.__argoCoachRequest.url, body);
    return originalSend.apply(this, arguments);
  };

  if (window.EventSource) {
    const OriginalEventSource = window.EventSource;
    window.EventSource = function (url, options) {
      observeRequest('GET', url);
      return new OriginalEventSource(url, options);
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
  }

  function announceURL() { send('url', {href: location.href}); }
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    history[name] = function () {
      const result = original.apply(this, arguments);
      announceURL();
      return result;
    };
  }
  addEventListener('popstate', announceURL);
  addEventListener('hashchange', announceURL);
  document.addEventListener('DOMContentLoaded', announceURL, {once: true});
  window.ArgoCoachBootstrap = {handoffKey: key};
})();
