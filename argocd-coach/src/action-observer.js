/* Argo CD 3.5.3 semantic observer. Network and URL state are preferred over
 * selectors. A small selector registry covers panels without either signal. */
(function () {
  const targets = new Set([
    'apps.list', 'apps.filter', 'app.header', 'app.tree', 'app.network', 'app.list',
    'app.pods', 'app.conditions', 'app.operation', 'app.history', 'app.diff',
    'resource.summary', 'resource.events', 'resource.logs', 'resource.manifest', 'settings.repos',
  ]);

  function appFromPath(pathname) {
    const api = pathname.match(/\/argocd\/api\/v1\/applications\/([^/?#]+)/);
    if (api) return decodeURIComponent(api[1]);
    // Argo UI routes include the Application namespace before its name.
    const ui = pathname.match(/\/argocd\/applications\/([^/?#]+)(?:\/([^/?#]+))?/);
    return ui ? decodeURIComponent(ui[2] || ui[1]) : null;
  }

  class ArgoActionObserver {
    constructor(emit) {
      this.emit = emit;
      this.seen = new Set();
      this.registry = {};
      this.urlListener = event => this.fromURL(event.detail.href);
      this.networkListener = event => this.fromNetwork(event.detail);
      addEventListener('argo-coach:url', this.urlListener);
      addEventListener('argo-coach:network', this.networkListener);
      addEventListener('submit', event => this.fromForm(event), true);
      fetch('/coach/assets/selectors/argocd-3.5.json').then(response => response.json())
        .then(registry => { this.registry = registry; this.scanDOM(); }).catch(() => {});
      this.mutations = new MutationObserver(() => {
        if (this.scanTimer) return;
        this.scanTimer = setTimeout(() => { this.scanTimer = null; this.scanDOM(); }, 300);
      });
      this.mutations.observe(document.body, {subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'aria-hidden', 'style']});
      this.fromURL(location.href);
    }

    stop() {
      removeEventListener('argo-coach:url', this.urlListener);
      removeEventListener('argo-coach:network', this.networkListener);
      this.mutations.disconnect();
      clearTimeout(this.scanTimer);
    }

    visit(target, application) {
      if (!targets.has(target)) return;
      const key = `${target}:${application || ''}:${location.pathname}:${location.search}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      this.emit('target_visited', {target, application});
      const semantic = {'app.diff': 'diff_viewed', 'app.history': 'history_viewed',
        'resource.events': 'events_viewed', 'resource.logs': 'logs_viewed',
        'resource.manifest': 'manifest_viewed'}[target];
      if (semantic) this.emit(semantic, {application});
    }

    fromURL(href) {
      const url = new URL(href);
      const path = url.pathname;
      if (path.includes('/gitea/')) return;
      if (/\/argocd\/settings\/repos(?:itories)?\/?$/.test(path)) {
        this.visit('settings.repos');
        return;
      }
      if (/\/argocd\/applications\/?$/.test(path)) {
        this.visit('apps.list');
        if (url.searchParams.has('q') || url.searchParams.has('search') || url.searchParams.has('project')) this.visit('apps.filter');
        return;
      }
      const application = appFromPath(path);
      if (!application) return;
      this.visit('app.header', application);
      if (url.searchParams.get('conditions') === 'true') this.visit('app.conditions', application);
      if (url.searchParams.get('operation') === 'true') this.visit('app.operation', application);
      if (url.searchParams.has('rollback')) this.visit('app.history', application);
      const view = (url.searchParams.get('view') || 'tree').toLowerCase();
      const viewTarget = {tree: 'app.tree', network: 'app.network', list: 'app.list', pods: 'app.pods',
        history: 'app.history', diff: 'app.diff'}[view];
      if (viewTarget) this.visit(viewTarget, application);
      if (/\/history\/?$/.test(path)) this.visit('app.history', application);
      if (/\/diff\/?$/.test(path)) this.visit('app.diff', application);
      const selected = url.searchParams.get('resource') || url.searchParams.get('node');
      const tab = (url.searchParams.get('tab') || '').toLowerCase();
      if (selected && (!tab || tab === 'summary')) this.visit('resource.summary', application);
      if (selected && /events?/.test(tab)) this.visit('resource.events', application);
      if (selected && /logs?/.test(tab)) this.visit('resource.logs', application);
      if (selected && /manifest|live|desired/.test(tab)) this.visit('resource.manifest', application);
      if (selected && tab === 'diff') this.visit('app.diff', application);
    }

    fromNetwork(detail) {
      const path = detail.path || '';
      const application = appFromPath(path);
      const method = detail.method;
      if (!application) return;
      if (method === 'GET') {
        if (new URLSearchParams(detail.search).has('refresh')) this.emit('refresh_requested', {application});
        // Resource details prefetch events, manifests and managed resources
        // while Summary is open. A request alone does not prove a tab visit.
        return;
      }
      if (method === 'POST' && /\/sync$/.test(path)) {
        this.emit('sync_requested', {application, ...detail.sync});
      } else if ((method === 'DELETE' || method === 'POST') && /\/operation$/.test(path)) {
        this.emit('operation_terminated', {application});
      } else if (method === 'POST' && /\/rollback$/.test(path)) {
        this.emit('rollback_requested', {application});
      } else if (method === 'DELETE' && /\/resource$/.test(path)) {
        const query = new URLSearchParams(detail.search);
        this.emit('resource_deleted', {application, name: query.get('resourceName') || query.get('name'), kind: query.get('kind')});
      } else if (method === 'POST' && /\/resource$/.test(path)) {
        this.emit('resource_updated', {application});
      } else if (method === 'POST' && /\/refresh$/.test(path)) {
        this.emit('refresh_requested', {application});
      }
    }

    fromForm(event) {
      if (!location.pathname.includes('/gitea/')) return;
      if (/\/_edit\//.test(location.pathname) || /\/_new\//.test(location.pathname)) {
        this.emit('file_edited_in_browser', {path: location.pathname});
      }
    }

    scanDOM() {
      const application = appFromPath(location.pathname);
      if (!application) return;
      for (const [target, selectors] of Object.entries(this.registry)) {
        for (const selector of selectors) {
          let element;
          try { element = document.querySelector(selector); } catch (_) { continue; }
          if (!element) continue;
          const box = element.getBoundingClientRect();
          if (box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden') {
            this.visit(target, application);
            break;
          }
        }
      }
    }
  }

  window.ArgoActionObserver = ArgoActionObserver;
})();
