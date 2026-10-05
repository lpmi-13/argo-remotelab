import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('coach follows Argo wrapper theme changes over a stale preference', () => {
  let argoTheme = 'light';
  let notifyMutation;
  const wrapper = {classList: {contains: name => name === `theme-${argoTheme}`}};
  const body = {className: '', dataset: {}, querySelector: () => wrapper};
  const root = {className: '', dataset: {}};
  const document = {documentElement: root, body, querySelector: () => body};
  const window = {};
  class MutationObserver {
    constructor(callback) { notifyMutation = callback; }
    observe() {}
    disconnect() {}
  }
  runInNewContext(readFileSync(new URL('../src/ui/theme.js', import.meta.url), 'utf8'), {
    document, window, MutationObserver,
    localStorage: {getItem: () => '"dark"'},
    matchMedia: () => ({matches: true, addEventListener() {}}),
    getComputedStyle: () => ({fontFamily: 'Arial', getPropertyValue: () => ''}),
  });
  const host = {dataset: {}, style: {setProperty() {}}};
  window.ArgoCoachTheme.followTheme(host);
  assert.equal(host.dataset.theme, 'light');
  argoTheme = 'dark';
  notifyMutation();
  assert.equal(host.dataset.theme, 'dark');
});

test('Gitea coach uses Argo view preferences on the shared origin', () => {
  const body = {className: '', dataset: {}, querySelector: () => null};
  const document = {documentElement: {className: '', dataset: {}}, body, querySelector: () => body};
  const window = {};
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  }
  runInNewContext(readFileSync(new URL('../src/ui/theme.js', import.meta.url), 'utf8'), {
    document, window, MutationObserver,
    localStorage: {getItem: key => key === 'view_preferences' ? '{"version":5,"theme":"dark"}' : null},
    matchMedia: () => ({matches: false, addEventListener() {}}),
    getComputedStyle: () => ({fontFamily: 'Arial', getPropertyValue: () => ''}),
  });
  const host = {dataset: {}, style: {setProperty() {}}};
  window.ArgoCoachTheme.followTheme(host);
  assert.equal(host.dataset.theme, 'dark');
});
