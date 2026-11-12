import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// Plays Demonstration missions against a live lab and audits what a viewer
// sees: every page load, coach navigation, pointer target, click, typed value
// and fallback, plus console errors, failed requests and Argo popups the coach
// covers. It checks REAL_DEMO_UPDATE_PLAN.md's "Done when" list per mission.
//
// LAB_URL         gateway address (default http://127.0.0.1:18080, a port-forward)
// SCENARIOS       comma-separated mission IDs (default: every catalog mission)
// LEVEL           only missions at this level
// ENVIRONMENT     prod (default) or staging
// ADVANCE=1       click Advance at each countdown instead of waiting it out
// COACH           audit (default: working-tree coach and bootstrap, coach
//                 instrumented), local (working tree as is) or gateway (the
//                 deployed coach)
// VIEWPORT        WIDTHxHEIGHT (default 1920x930)
// LABEL           names the output folder under artifacts/demo-audit/
// CHROME_EXECUTABLE  a local Chrome instead of Playwright's Chromium
const here = path.dirname(fileURLToPath(import.meta.url));
const labURL = (process.env.LAB_URL || 'http://127.0.0.1:18080').replace(/\/$/, '');
const environment = process.env.ENVIRONMENT || 'prod';
const advance = process.env.ADVANCE === '1';
const coachMode = process.env.COACH || 'audit';
const [width, height] = (process.env.VIEWPORT || '1920x930').split('x').map(Number);
const label = process.env.LABEL || `${coachMode}-${width}x${height}${advance ? '-advance' : ''}`;
const output = path.join(here, 'artifacts', 'demo-audit', `${label}-${environment}`);

/** The working-tree coach, logging what a viewer would see it do. */
function instrumentedCoach(source) {
  const helper = `
  const auditWhere = () => location.pathname + location.search;
  const auditDescribe = el => el ? \`\${el.tagName.toLowerCase()}\${el.id ? '#' + el.id : ''}\${el.classList?.length ? '.' + Array.from(el.classList).slice(0, 2).join('.') : ''} "\${(el.textContent || el.getAttribute?.('title') || el.getAttribute?.('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 40)}"\` : 'none';
`;
  const anchor = '  /** @param {number} ms @returns {Promise<void>} */\n  const sleep';
  const replace = (text, find, insert) => {
    if (text.split(find).length !== 2) throw new Error(`instrumentation anchor not found once: ${find.slice(0, 60)}`);
    return text.replace(find, insert);
  };
  let coach = replace(source, anchor, helper + anchor);
  coach = coach.replace(/location\.href = ([^;]+);/g, (_, target) =>
    `{ console.info('[coach-nav] ' + (${target}) + ' | from ' + auditWhere()); location.href = ${target}; }`);
  for (const [signature, log] of [
    ['async function pointAt(element, click = false, highlightWith = null) {',
      "console.info('[coach-point] ' + (click ? 'click ' : 'show ') + auditDescribe(element) + ' | on ' + auditWhere());"],
    ['async function performDemoFix(fixStep, notice) {',
      "console.info('[coach-api] demonstrate-fix | on ' + auditWhere());"],
    ['async function submitNote(values) {', "console.info('[coach-api] submit-note | on ' + auditWhere());"],
    ['async function typeIntoField(selector, text) {',
      "console.info('[coach-type] field ' + selector + ' \"' + text.slice(0, 40) + '\" | on ' + auditWhere());"],
    ['async function typeIntoTerminal(text) {', "console.info('[coach-type] terminal \"' + text.slice(0, 120) + '\" | on ' + auditWhere());"],
    ['async function typeIntoArgoField(field, text) {',
      "console.info('[coach-type] argo-field \"' + text.slice(0, 80) + '\" | on ' + auditWhere());"],
  ]) coach = replace(coach, signature, `${signature}\n    ${log}`);
  return coach;
}

const appOf = pathname => pathname.startsWith('/gitea/') ? 'gitea' : pathname.startsWith('/argocd/') ? 'argocd' : 'other';

async function auditMission(page, scenario, level, surface) {
  const dir = path.join(output, scenario);
  await mkdir(dir, {recursive: true});
  const started = Date.now();
  const t = () => Math.round((Date.now() - started) / 1000);
  const problems = [];
  const seen = new Set();
  const problem = (kind, detail) => {
    const key = `${kind}:${detail}`.slice(0, 300);
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({t: t(), kind, detail: String(detail).slice(0, 400), url: page.url()});
  };
  const audit = [];
  const loads = [];
  const timeline = [];
  const listeners = {
    console: message => {
      const text = message.text();
      if (text.startsWith('[coach-')) audit.push({t: t(), text: text.slice(0, 400)});
      if (['error', 'warning'].includes(message.type()) && !text.startsWith('[coach-fallback]')) {
        problem(`console.${message.type()}`, text);
      }
    },
    pageerror: error => problem('pageerror', error.message),
    requestfailed: request => {
      const failure = request.failure()?.errorText || '';
      if (!/ERR_ABORTED/.test(failure)) problem('request.failed', `${request.method()} ${request.url()} ${failure}`);
    },
    response: response => {
      if (response.status() >= 400) problem(`http.${response.status()}`, `${response.request().method()} ${response.url()}`);
    },
    load: () => loads.push({t: t(), path: new URL(page.url()).pathname + new URL(page.url()).search}),
  };
  for (const [event, listener] of Object.entries(listeners)) page.on(event, listener);
  let shots = 0;
  const shoot = async name => {
    if (shots >= 80) return;
    shots += 1;
    await page.screenshot({path: path.join(dir, `${String(shots).padStart(2, '0')}-${name}.png`)}).catch(() => {});
  };
  let outcome = 'timed out';
  let lastPanel = '';
  let pointerDuringTyping = {samples: 0, visible: 0};
  try {
    await page.goto(labURL + '/', {waitUntil: 'domcontentloaded'});
    await page.locator(`#scenario option[value="${scenario}"]`).waitFor({state: 'attached'});
    await page.locator('#scenario').selectOption(scenario);
    await page.locator('#environment').selectOption(environment);
    await page.locator('#start').click();
    await page.waitForFunction(() => {
      const button = document.querySelector('#argocd-coach-host')?.shadowRoot?.querySelector('[data-action="begin"]');
      return button && !button.disabled;
    }, null, {timeout: 600000});
    await shoot('briefing');
    if (advance) await page.locator('#argocd-coach-host [data-action="begin"]').click();
    for (let turn = 0; turn < 2400; turn += 1) {
      let state;
      try {
        state = await page.evaluate(async () => {
          const handoff = JSON.parse(sessionStorage.getItem('argo-coach:handoff') || 'null');
          const root = document.querySelector('#argocd-coach-host')?.shadowRoot;
          const session = handoff ? await (await fetch(`/coach/learning/api/sessions/${handoff.session}`,
            {headers: {Authorization: `Bearer ${handoff.token}`}})).json() : {};
          const rect = element => {
            if (!element) return null;
            const box = element.getBoundingClientRect();
            return {x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height)};
          };
          const pointer = root?.querySelector('.coach-pointer');
          const item = title => Array.from(document.querySelectorAll('.application-status-panel__item'))
            .find(element => element.getBoundingClientRect().height > 0 && element.textContent.trim().toUpperCase().startsWith(title));
          const lastSync = item('LAST SYNC');
          return {
            url: location.href, check: session.next_check?.id, revision: session.revision, state: session.state,
            mode: session.mode,
            panelText: (root?.querySelector('.panel .body')?.innerText || '').replace(/\s+/g, ' ').trim(),
            doing: Boolean(root?.querySelector('.panel[data-doing]')),
            typing: Boolean(root?.querySelector('.spotlight[data-terminal]')),
            errors: Array.from(root?.querySelectorAll('.message.error, [role="alert"]') || []).map(el => el.textContent.trim()).filter(Boolean),
            debrief: Boolean(root?.querySelector('#debrief-title')),
            canAdvance: Boolean(root?.querySelector('.demo-timer:not([hidden]) [data-action="advance"]')),
            panel: rect(root?.querySelector('.panel')),
            pointer: pointer?.hasAttribute('data-visible') ? {x: parseInt(pointer.style.left, 10), y: parseInt(pointer.style.top, 10),
              // The pointer may rest on the coach's own controls, such as View Git source.
              onCoachControl: Boolean(root.elementFromPoint?.(parseInt(pointer.style.left, 10), parseInt(pointer.style.top, 10))
                ?.closest('.panel button, .panel a'))} : null,
            spotlights: Array.from(root?.querySelectorAll('.spotlight') || []).map(rect),
            viewport: {w: innerWidth, h: innerHeight},
            toasts: Array.from(document.querySelectorAll('.Toastify__toast')).filter(el => el.getBoundingClientRect().height > 0)
              .map(el => ({text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 200), rect: rect(el)})),
            popups: Array.from(document.querySelectorAll('.popup-container')).filter(el => el.getBoundingClientRect().height > 0).map(rect),
            notice: (root?.querySelector('.argo-notice')?.innerText || '').replace(/\s+/g, ' ').trim(),
            header: {syncOk: /\bSync OK\b/.test(lastSync?.textContent || ''), lastSync: rect(lastSync),
              error: /\b\d+\s+Errors?\b/.test(item('APP CONDITIONS')?.textContent || '')},
            drawer: Array.from(document.querySelectorAll('.popup-overlay, .sliding-panel, .application-deployment-history'))
              .some(el => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden'),
          };
        });
      } catch (error) {
        if (/Execution context was destroyed|navigation|Failed to fetch|Unexpected token/.test(error.message)) {
          await page.waitForTimeout(500);
          continue;
        }
        throw error;
      }
      for (const message of state.errors) problem('coach.error', message);
      const overlaps = (a, b) => a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      for (const toast of state.toasts) {
        problem('argo.popup', toast.text);
        if (overlaps(toast.rect, state.panel)) problem('argo.popup-covered', `${toast.text} under panel ${JSON.stringify(state.panel)}`);
        if (/must be resolved/.test(toast.text) && !state.notice) problem('argo.popup-unexplained', toast.text);
      }
      for (const popup of state.popups) if (overlaps(popup, state.panel)) problem('argo.dialog-covered', JSON.stringify(popup));
      if (state.header.syncOk && state.header.error && !state.drawer && overlaps(state.header.lastSync, state.panel)) {
        problem('argo.lastsync-covered', JSON.stringify(state.header.lastSync));
      }
      const {viewport, panel} = state;
      if (state.pointer) {
        const {x, y} = state.pointer;
        if (x < 0 || y < 0 || x > viewport.w || y > viewport.h) problem('pointer.offscreen', JSON.stringify(state.pointer));
        else if (panel && !state.pointer.onCoachControl && x >= panel.x && x <= panel.x + panel.w && y >= panel.y && y <= panel.y + panel.h) {
          problem('pointer.under-panel', `${JSON.stringify(state.pointer)} in ${JSON.stringify(panel)}`);
        }
      }
      if (state.typing) {
        pointerDuringTyping.samples += 1;
        if (state.pointer) pointerDuringTyping.visible += 1;
      }
      const panelKey = state.panelText.replace(/\d+(?:\.\d+)?\s*s\b/g, '').slice(0, 500);
      if (panelKey !== lastPanel) {
        lastPanel = panelKey;
        timeline.push({t: t(), check: state.check, state: state.state, path: new URL(state.url).pathname, text: state.panelText.slice(0, 220)});
        await shoot((state.check || state.state || 'step').replace(/[^a-z0-9-]/gi, '_'));
      }
      if (state.debrief) {
        const run = await page.evaluate(async () => {
          const handoff = JSON.parse(sessionStorage.getItem('argo-coach:handoff'));
          return (await (await fetch(`/coach/learning/api/runs/${handoff.run}`)).json()).state;
        });
        outcome = run === 'COMPLETED' ? 'completed' : `debrief with run ${run}`;
        await shoot('debrief');
        break;
      }
      if (['FAILED', 'ABORTED'].includes(state.state)) { outcome = state.state; await shoot('end'); break; }
      if (/could not open/.test(state.errors.join(' '))) { outcome = `demo stopped: ${state.errors.join(' ')}`; await shoot('stopped'); break; }
      if (advance && state.canAdvance) {
        await page.locator('#argocd-coach-host .demo-timer:not([hidden]) [data-action="advance"]')
          .click({timeout: 1000, noWaitAfter: true}).catch(() => {});
      }
      await page.waitForTimeout(1000);
    }
  } catch (error) {
    outcome = `runner error: ${error.message.slice(0, 250)}`;
    await shoot('runner-error');
  } finally {
    for (const [event, listener] of Object.entries(listeners)) page.off(event, listener);
  }

  // REAL_DEMO_UPDATE_PLAN.md "Done when". A coach navigation inside one app is
  // a URL jump; a move between apps must follow a click on a visible control.
  const navs = audit.filter(item => item.text.startsWith('[coach-nav]'));
  const jumps = navs.filter(item => {
    const [, target, from] = item.text.match(/^\[coach-nav\] (\S+) \| from (\S+)/) || [];
    if (!target) return true;
    const clicked = audit.some(other => other.t <= item.t && item.t - other.t <= 5 &&
      /^\[coach-point\] click .*"(View Git source|Return to Argo CD)"/.test(other.text));
    return appOf(new URL(target, labURL).pathname) === appOf(from) || !clicked;
  });
  const fallbacks = audit.filter(item => item.text.startsWith('[coach-fallback]')).map(item => item.text);
  const references = audit.filter(item => item.text.startsWith('[coach-api] demonstrate-fix'));
  const typed = audit.filter(item => item.text.startsWith('[coach-type]'));
  const gitRepair = ['git', 'argo-and-git', 'terminal'].includes(surface);
  const checks = {
    'no URL jumps': jumps.length === 0,
    'no reference repair': references.length === 0,
    'no fallback': fallbacks.length === 0,
    'repair typed in the terminal': !gitRepair || typed.some(item => item.text.startsWith('[coach-type] terminal')),
    'pointer visible while typing': pointerDuringTyping.samples === 0 || pointerDuringTyping.visible === pointerDuringTyping.samples,
    'pointer stays on screen': !problems.some(item => item.kind === 'pointer.offscreen'),
    'no covered Argo popup or dialog': !problems.some(item => /covered/.test(item.kind)),
  };
  return {scenario, level, environment, outcome, seconds: t(), checks, jumps, fallbacks, references: references.length,
    pointerDuringTyping, problems, timeline, loads, audit};
}

async function main() {
  await mkdir(output, {recursive: true});
  const browser = await chromium.launch({headless: true,
    ...(process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {})});
  const context = await browser.newContext({viewport: {width, height}, ignoreHTTPSErrors: true});
  const page = await context.newPage();
  // The coach's own warnings, such as [coach-fallback], are audit events.
  page.on('console', message => {
    if (message.text().startsWith('[coach-fallback]')) console.log(message.text());
  });
  if (coachMode !== 'gateway') {
    const source = await readFile(path.join(here, '..', 'argocd-coach', 'src', 'coach.js'), 'utf8');
    const coach = coachMode === 'audit' ? instrumentedCoach(source) : source;
    const css = await readFile(path.join(here, '..', 'argocd-coach', 'src', 'ui', 'coach.css'), 'utf8');
    const bootstrap = await readFile(path.join(here, '..', 'argocd-coach', 'src', 'argocd-bootstrap.js'), 'utf8');
    await context.route('**/coach/assets/coach.js', route => route.fulfill({contentType: 'text/javascript', body: coach}));
    await context.route('**/coach/assets/argocd-bootstrap.js', route => route.fulfill({contentType: 'text/javascript', body: bootstrap}));
    await context.route('**/coach/assets/ui/coach.css', route => route.fulfill({contentType: 'text/css', body: css}));
  }
  const catalog = (await (await fetch(labURL + '/coach/learning/api/catalog')).json()).scenarios;
  const wanted = process.env.SCENARIOS?.split(',').map(item => item.trim()).filter(Boolean);
  const missions = catalog.filter(item => (!wanted || wanted.includes(item.id)) &&
    (!process.env.LEVEL || Number(process.env.LEVEL) === item.level));
  if (!missions.length) throw new Error('No missions match SCENARIOS and LEVEL');
  const results = [];
  try {
    for (const mission of missions) {
      console.log(`${new Date().toISOString()} ${mission.id} …`);
      const result = await auditMission(page, mission.id, mission.level, mission.fix_surface);
      results.push(result);
      await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
      const failed = Object.entries(result.checks).filter(([, ok]) => !ok).map(([name]) => name);
      console.log(`  ${result.outcome} in ${result.seconds}s; ${failed.length ? 'FAILED: ' + failed.join(', ') : 'all checks passed'}` +
        `${result.fallbacks.length ? `; fallbacks: ${result.fallbacks.join(' ')}` : ''}`);
    }
  } finally {
    await browser.close();
  }
  const bad = results.filter(result => result.outcome !== 'completed' || Object.values(result.checks).some(ok => !ok));
  console.log(`\n${results.length - bad.length} of ${results.length} missions completed with every check; details in ${output}/results.json`);
  if (bad.length) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
