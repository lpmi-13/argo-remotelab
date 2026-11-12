import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/argocd-bootstrap.js', import.meta.url), 'utf8');

/** Runs the bootstrap over a fake fetch and XHR whose answers the test controls. */
function bootstrapHarness() {
  const events = [];
  const pending = [];
  class FakeXHR {
    constructor() { this.listeners = {}; this.status = 0; }
    open() {}
    send() { pending.push(this); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    answer(status) { this.status = status; this.listeners.loadend?.(); }
  }
  const storage = new Map();
  const window = {
    location: new URL('https://lab.example/argocd/applications/argocd/shop-web-prod'),
    sessionStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    history: {state: null, replaceState() {}, pushState() {}},
    document: {documentElement: {style: {}}, addEventListener() {}},
    addEventListener() {},
    dispatchEvent: event => events.push({type: event.type, detail: event.detail}),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    Event: class { constructor(type) { this.type = type; } },
    URL, XMLHttpRequest: FakeXHR,
    fetch: () => new Promise((resolve, reject) => pending.push({resolve, reject})),
  };
  window.window = window;
  vm.runInNewContext(source, window);
  const network = () => events.filter(event => event.type === 'argo-coach:network').map(event => event.detail);
  return {window, pending, network};
}

const syncPath = '/argocd/api/v1/applications/shop-web-prod/sync';
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a sync is reported after Argo CD answers, with whether it was accepted', async () => {
  const {window, pending, network} = bootstrapHarness();
  const body = JSON.stringify({prune: true, resources: [{kind: 'Deployment', name: 'django-web', namespace: 'applications'}]});
  window.fetch(syncPath, {method: 'POST', body});
  await settle();
  assert.equal(network().length, 0, 'the sync is not reported before Argo CD answers');
  pending.shift().resolve({ok: true});
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(network())), [{method: 'POST', path: syncPath, search: '',
    sync: {prune: true, dryRun: false, resources: [{kind: 'Deployment', name: 'django-web'}], accepted: true}}]);

  window.fetch(syncPath, {method: 'POST', body: '{}'});
  pending.shift().resolve({ok: false});
  await settle();
  assert.equal(network()[1].sync.accepted, false, 'Argo CD refused the sync');
});

test('an XHR sync is reported when it ends; other requests are reported at once', async () => {
  const {window, pending, network} = bootstrapHarness();
  const request = new window.XMLHttpRequest();
  request.open('POST', syncPath);
  request.send('{"prune":false}');
  assert.equal(network().length, 0);
  pending.shift().answer(400);
  assert.equal(network()[0].sync.accepted, false);

  const terminate = new window.XMLHttpRequest();
  terminate.open('DELETE', '/argocd/api/v1/applications/shop-web-prod/operation');
  terminate.send();
  assert.equal(network()[1].path, '/argocd/api/v1/applications/shop-web-prod/operation', 'reported before any answer');
});
