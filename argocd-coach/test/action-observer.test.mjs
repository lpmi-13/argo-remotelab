import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/action-observer.js', import.meta.url), 'utf8');

function observerHarness() {
  const actions = [];
  const context = {
    window: {}, URL, URLSearchParams, setTimeout, clearTimeout,
    location: new URL('https://lab.example/argocd/applications'),
    document: {body: {}, querySelector: () => null},
    fetch: () => new Promise(() => {}),
    addEventListener: () => {}, removeEventListener: () => {},
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({visibility: 'visible'}),
  };
  vm.runInNewContext(source, context);
  const observer = new context.window.ArgoActionObserver((type, details) => actions.push({type, details}));
  const navigate = path => {
    context.location = new URL(path, context.location.origin);
    observer.fromURL(context.location.href);
  };
  return {actions, observer, navigate};
}

test('Argo 3.5 panel and resource URLs identify actual information targets', () => {
  const {actions, navigate} = observerHarness();
  const app = '/argocd/applications/argocd/shop-web-prod';
  navigate(`${app}?conditions=true`);
  navigate(`${app}?operation=true`);
  navigate(`${app}?rollback=0`);
  navigate(`${app}?node=apps%2FDeployment%2Fapplications%2Fdjango%2F0&tab=events`);
  navigate(`${app}?node=apps%2FDeployment%2Fapplications%2Fdjango%2F0&tab=manifest`);
  navigate(`${app}?node=argoproj.io%2FApplication%2Fargocd%2Fshop-web-prod%2F0&tab=diff`);
  const visited = actions.filter(action => action.type === 'target_visited').map(action => action.details.target);
  for (const target of ['app.conditions', 'app.operation', 'app.history', 'resource.events', 'resource.manifest', 'app.diff']) {
    assert.ok(visited.includes(target), target);
  }
  assert.ok(actions.filter(action => action.type === 'target_visited').every(action =>
    ['shop-web-prod', undefined].includes(action.details.application)));
});

test('prefetched resource requests do not count as reading tabs', () => {
  const {actions, observer, navigate} = observerHarness();
  navigate('/argocd/applications/argocd/shop-web-prod?node=apps%2FDeployment%2Fapplications%2Fdjango%2F0');
  actions.length = 0;
  const prefix = '/argocd/api/v1/applications/shop-web-prod';
  observer.fromNetwork({method: 'GET', path: `${prefix}/events`, search: '?resourceName=django'});
  observer.fromNetwork({method: 'GET', path: `${prefix}/resource`, search: '?resourceName=django'});
  observer.fromNetwork({method: 'GET', path: `${prefix}/managed-resources`, search: '?resourceName=django'});
  assert.equal(actions.filter(action => action.type === 'target_visited').length, 0);
  observer.fromNetwork({method: 'POST', path: `${prefix}/resource`, search: '?resourceName=django'});
  assert.equal(actions[0].type, 'resource_updated');
});
