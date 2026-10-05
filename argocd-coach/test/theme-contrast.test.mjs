import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const css = readFileSync(new URL('../src/ui/tokens.css', import.meta.url), 'utf8');
const blocks = [...css.matchAll(/:host(?:\(\[data-theme="dark"\]\))?\s*\{([^}]*)\}/g)];
assert.equal(blocks.length, 2);
const read = block => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(match => [match[1], match[2]]));
const light = read(blocks[0][1]);
const dark = {...light, ...read(blocks[1][1])};

function luminance(hex) {
  const components = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722;
}
function ratio(first, second) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('light coach text, status and buttons meet WCAG AA', () => {
  for (const token of ['--coach-text', '--coach-muted', '--coach-accent-text', '--coach-healthy-text',
    '--coach-progressing-text', '--coach-degraded-text', '--coach-unknown-text', '--coach-missing-text']) {
    assert.ok(ratio(light[token], light['--coach-surface']) >= 4.5, token);
  }
  assert.ok(ratio(light['--coach-button-text'], light['--coach-accent']) >= 4.5);
});

test('dark coach text, status and buttons meet WCAG AA', () => {
  for (const token of ['--coach-text', '--coach-muted', '--coach-accent-text', '--coach-healthy-text',
    '--coach-progressing-text', '--coach-degraded-text', '--coach-unknown-text', '--coach-missing-text']) {
    assert.ok(ratio(dark[token], dark['--coach-surface']) >= 4.5, token);
  }
  assert.ok(ratio(dark['--coach-button-text'], dark['--coach-accent']) >= 4.5);
});

test('health colors match Argo CD 3.5.3 UI palette', () => {
  assert.equal(light['--coach-healthy'], '#18be94');
  assert.equal(light['--coach-progressing'], '#0dadea');
  assert.equal(light['--coach-degraded'], '#e96d76');
});
