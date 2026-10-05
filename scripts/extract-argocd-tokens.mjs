#!/usr/bin/env node
// Argo 3.3 embeds its compiled CSS as string modules in main.js.
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const cssPath = option('--css');
const bundlePath = option('--bundle');
const serverURL = option('--url');
const write = args.includes('--write');
const version = readFileSync(resolve('manifests/gitops/argocd-install.version'), 'utf8').trim().split(/\s+/)[0];
const outputPath = resolve('argocd-coach/src/ui/tokens.css');
if ([cssPath, bundlePath, serverURL].filter(Boolean).length !== 1) {
  throw new Error('Pass exactly one of --css <file>, --bundle <main.js>, or --url <Argo base URL>');
}

function cssFromBundle(bundle) {
  const modules = [];
  const literals = /\.exports=((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*'))/g;
  for (const match of bundle.matchAll(literals)) {
    // The matched expression is one quoted literal, evaluated without access
    // to the host process. No downloaded JavaScript module is executed.
    const value = runInNewContext(match[1], Object.create(null), {timeout: 100});
    if (typeof value === 'string' && value.includes('{') && value.includes('}')) modules.push(value);
  }
  if (modules.length < 20) throw new Error(`Argo ${version}: no compiled CSS modules found in bundle`);
  return modules.join('\n');
}

let css = '';
if (cssPath) css = readFileSync(resolve(cssPath), 'utf8');
if (bundlePath) css = cssFromBundle(readFileSync(resolve(bundlePath), 'utf8'));
if (serverURL) {
  const base = new URL(serverURL.endsWith('/') ? serverURL : serverURL + '/');
  const page = await fetch(base).then(response => {
    if (!response.ok) throw new Error(`Argo page returned ${response.status}`);
    return response.text();
  });
  const stylesheets = [...page.matchAll(/<link[^>]+href=["']([^"']+\.css(?:\?[^"']*)?)["']/gi)]
    .map(match => new URL(match[1], base));
  const bundles = [...page.matchAll(/<script[^>]+src=["']([^"']+\.js(?:\?[^"']*)?)["']/gi)]
    .map(match => new URL(match[1], base))
    .filter(url => /\/main\.[^/]+\.js$/.test(url.pathname));
  if (!bundles.length) throw new Error(`Argo ${version}: main.js bundle not linked from the page`);
  const fetchText = async url => fetch(url).then(response => {
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.text();
  });
  css = [...await Promise.all(stylesheets.map(fetchText)),
    ...(await Promise.all(bundles.map(fetchText))).map(cssFromBundle)].join('\n');
}

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
  selectors: match[1].split(',').map(selector => selector.trim()), declarations: match[2],
}));
function property(selector, name) {
  let value = null;
  for (const rule of rules) {
    if (!rule.selectors.includes(selector)) continue;
    const match = rule.declarations.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`));
    if (match) value = match[1].trim();
  }
  return value;
}
function token(name, candidates) {
  for (const [selector, declaration] of candidates) {
    const value = property(selector, declaration);
    if (value) return value;
  }
  throw new Error(`Argo ${version}: cannot extract ${name}; checked ${JSON.stringify(candidates)}`);
}
function hex(value) {
  const color = value.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i)?.[0];
  if (!color) throw new Error(`Argo ${version}: expected hex color in ${value}`);
  return (color.length === 4 ? '#' + [...color.slice(1)].map(digit => digit + digit).join('') : color).toLowerCase();
}
function luminance(color) {
  return color.slice(1).match(/../g).map(part => parseInt(part, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
}
function contrast(first, second) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
function readable(color, surface) {
  if (contrast(color, surface) >= 4.5) return color;
  const toward = luminance(surface) > .18 ? 0 : 255;
  const channels = color.slice(1).match(/../g).map(part => parseInt(part, 16));
  for (let step = 1; step <= 20; step++) {
    const fraction = step / 20;
    const candidate = '#' + channels.map(value => Math.round(value + (toward - value) * fraction)
      .toString(16).padStart(2, '0')).join('');
    if (contrast(candidate, surface) >= 4.5) return candidate;
  }
  throw new Error(`Argo ${version}: cannot make ${color} readable on ${surface}`);
}

const status = Object.fromEntries(['Healthy', 'Progressing', 'Degraded', 'Suspended', 'Missing', 'Unknown']
  .map(name => [name.toLowerCase(), hex(token(name, [[`.applications-list__entry--health-${name}`, 'border-left-color']]))]));
const lightSurface = hex(token('light surface', [['.theme-light .popup-overlay .popup-container__body', 'background-color']]));
const darkSurface = hex(token('dark surface', [['.theme-dark .popup-overlay .popup-container__body', 'background-color']]));
const accent = hex(token('accent', [['.argo-button', 'color']]));
const sidebar = hex(token('sidebar', [['.sidebar', 'background-color']]));
const sourceMuted = hex(token('muted text', [['.theme-light .popup-overlay .popup-container__body p', 'color']]));
const statusText = surface => Object.fromEntries(Object.entries(status)
  .map(([name, value]) => [`--coach-${name}-text`, readable(value, surface)]));
const light = {
  '--coach-font': token('body font', [['body', 'font-family']]),
  '--coach-mono': token('manifest font', [['.application-node-info__manifest--raw', 'font-family']]),
  '--coach-accent': accent,
  '--coach-accent-text': readable(accent, lightSurface),
  '--coach-sidebar': sidebar,
  '--coach-page': hex(token('light page', [['.theme-light .layout', 'background-color']])),
  '--coach-surface': lightSurface,
  '--coach-border': hex(token('light border', [['.theme-light .applications-list__search', 'border']])),
  '--coach-text': hex(token('light text', [['.theme-light .applications-list__title', 'color']])),
  '--coach-muted': readable(sourceMuted, lightSurface),
  ...Object.fromEntries(Object.entries(status).map(([name, value]) => [`--coach-${name}`, value])),
  ...statusText(lightSurface),
  '--coach-radius': token('dialog radius', [['.popup-overlay .popup-container', 'border-radius']]),
  '--coach-button-radius': token('button radius', [['.argo-button', 'border-radius']]),
  '--coach-button-padding': token('button padding', [['.argo-button', 'padding']]),
  '--coach-button-size': token('button size', [['.argo-button', 'font-size']]),
  '--coach-button-weight': token('button weight', [['.argo-button', 'font-weight']]),
  '--coach-button-text': sidebar,
  '--coach-shadow': token('light shadow', [['.theme-light .popup-overlay .popup-container', 'box-shadow']]),
};
if (contrast(sidebar, accent) < 4.5) throw new Error('primary button contrast is below WCAG AA');
const dark = {
  '--coach-accent-text': readable(accent, darkSurface),
  '--coach-page': hex(token('dark page', [['.theme-dark .layout', 'background-color']])),
  '--coach-surface': darkSurface,
  '--coach-border': hex(token('dark border', [['.theme-dark .applications-list__search', 'border']])),
  '--coach-text': hex(token('dark text', [['.theme-dark .applications-list__title', 'color']])),
  '--coach-muted': hex(token('dark muted text', [['.theme-dark .popup-overlay .popup-container__body p', 'color']])),
  ...statusText(darkSurface),
  '--coach-shadow': token('dark shadow', [['.theme-dark .popup-overlay .popup-container', 'box-shadow']]),
};
const declaration = values => Object.entries(values).map(([name, value]) => `  ${name}: ${value};`).join('\n');
const generated = `/* Extracted from Argo CD ${version} compiled CSS in main.js.\n * Status colors match Argo; separate text colors meet WCAG AA. */\n:host {\n${declaration(light)}\n}\n:host([data-theme="dark"]) {\n${declaration(dark)}\n}\n`;
const committed = readFileSync(outputPath, 'utf8');
if (committed !== generated) {
  console.error(`Token diff for Argo CD ${version}:`);
  const before = committed.split('\n'), after = generated.split('\n');
  for (let index = 0; index < Math.max(before.length, after.length); index++) {
    if (before[index] !== after[index]) {
      if (before[index] !== undefined) console.error(`- ${before[index]}`);
      if (after[index] !== undefined) console.error(`+ ${after[index]}`);
    }
  }
  if (write) writeFileSync(outputPath, generated);
  else process.exitCode = 1;
}
