import {spawn} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import selectors from '../argocd-coach/selectors/argocd-3.5.json' with {type: 'json'};

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = process.env.RECORDING_DIR || path.join(here, 'artifacts');
const contextName = process.env.KUBE_CONTEXT;
const port = Number(process.env.LAB_PORT || 18080);
const externalURL = process.env.LAB_URL?.replace(/\/$/, '');
const labURL = externalURL || `http://127.0.0.1:${port}`;
const viewport = {width: 1440, height: 900};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(route, options = {}) {
  const response = await fetch(labURL + '/coach/learning' + route, {
    ...options,
    headers: {'Content-Type': 'application/json', ...options.headers},
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${route}: ${body.error || response.status}`);
  return body;
}

async function forwardGateway() {
  if (externalURL) return null;
  if (!contextName) throw new Error('Set KUBE_CONTEXT to an isolated lab context or provide LAB_URL.');
  const process = spawn('kubectl', ['--context', contextName, '-n', 'applications', 'port-forward',
    'svc/lab-gateway', `${port}:8080`], {stdio: 'ignore'});
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (process.exitCode !== null) throw new Error('gateway port-forward exited');
      try {
        const response = await fetch(labURL + '/healthz');
        if (response.ok) return process;
      } catch (_) { /* Wait for the port-forward to bind. */ }
      await sleep(500);
    }
    throw new Error('gateway port-forward did not become ready');
  } catch (error) {
    process.kill('SIGTERM');
    throw error;
  }
}

async function readyRun(id) {
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    const run = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (run.state === 'READY') return run;
    if (run.state === 'FAILED') throw new Error(run.error || 'run failed');
    await sleep(2000);
  }
  throw new Error('run did not become READY');
}

async function coachReady(page, theme) {
  await page.waitForFunction(expected => {
    const host = document.querySelector('#argocd-coach-host');
    return host?.dataset.theme === expected && Boolean(host.shadowRoot?.querySelector('aside.panel .body h2'));
  }, theme, {timeout: 30_000});
}

async function setCoachCollapsed(page, expected) {
  const button = page.locator('#argocd-coach-host button[data-action="collapse"]');
  await button.waitFor({timeout: 30_000});
  const collapsed = (await button.getAttribute('aria-label')).startsWith('Expand');
  if (collapsed !== expected) await button.click();
  await page.locator(expected ? '#argocd-coach-host aside.panel[data-collapsed]' :
    '#argocd-coach-host aside.panel:not([data-collapsed])').waitFor({timeout: 30_000});
}

async function capturePanel(page, destination) {
  const bounds = await page.locator('#argocd-coach-host aside.panel').boundingBox();
  if (!bounds) throw new Error('coach panel is not visible');
  await page.screenshot({path: destination, clip: bounds, animations: 'disabled'});
}

async function assertTheme(page, expected) {
  await page.waitForFunction(theme => {
    const wrapper = document.querySelector('.theme-dark, .theme-light');
    const coach = document.querySelector('#argocd-coach-host');
    return wrapper?.classList.contains(`theme-${theme}`) && coach?.dataset.theme === theme;
  }, expected, {timeout: 30_000});
}

async function comparePanel(page, theme) {
  const name = `argocd-3.5.3-panel-${theme}.png`;
  const actual = path.join(outputDir, `panel-${theme}.png`);
  const baseline = path.join(here, 'baselines', name);
  if (process.env.UPDATE_BASELINES === '1') {
    await writeFile(baseline, await readFile(actual));
    return;
  }
  let expected;
  try {
    expected = await readFile(baseline);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`No Argo CD 3.5.3 panel baseline at ${baseline}; review the captured panel and rerun with UPDATE_BASELINES=1`);
    }
    throw error;
  }
  const images = {
    expected: expected.toString('base64'),
    actual: (await readFile(actual)).toString('base64'),
  };
  const result = await page.evaluate(async ({expected, actual}) => {
    async function decode(base64) {
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      return createImageBitmap(new Blob([bytes], {type: 'image/png'}));
    }
    function pixels(bitmap) {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', {willReadFrequently: true});
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    }
    const reference = await decode(expected);
    const captured = await decode(actual);
    if (reference.width !== captured.width || reference.height !== captured.height) {
      return {reason: 'dimensions', expected: [reference.width, reference.height],
        actual: [captured.width, captured.height]};
    }
    const first = pixels(reference);
    const second = pixels(captured);
    let changed = 0;
    let absoluteError = 0;
    for (let index = 0; index < first.length; index += 4) {
      const delta = Math.max(Math.abs(first[index] - second[index]),
        Math.abs(first[index + 1] - second[index + 1]),
        Math.abs(first[index + 2] - second[index + 2]));
      if (delta > 24) changed += 1;
      absoluteError += delta;
    }
    const count = first.length / 4;
    return {changedFraction: changed / count, meanDelta: absoluteError / count};
  }, images);
  if (result.reason || result.changedFraction > 0.02 || result.meanDelta > 3) {
    throw new Error(`${theme} coach panel differs from ${baseline}: ${JSON.stringify(result)}`);
  }
  console.log(`${theme} panel visual check: ${(result.changedFraction * 100).toFixed(2)}% changed pixels`);
}

async function main() {
  await mkdir(outputDir, {recursive: true});
  const startedAt = new Date().toISOString();
  let forward = null;
  let browser = null;
  let context = null;
  let page = null;
  let runID = null;
  let video = null;
  const artifacts = [];
  const errors = [];
  try {
    forward = await forwardGateway();
    const created = await api('/api/runs', {method: 'POST', body: JSON.stringify({
      scenario: 'console-orientation', mode: 'guided', environment: 'prod',
      scenario_key: 'visual-argocd-3.5',
    })});
    runID = created.run.id;
    await readyRun(runID);

    browser = await chromium.launch({headless: true});
    context = await browser.newContext({viewport, locale: 'en-GB', timezoneId: 'UTC',
      colorScheme: 'light', reducedMotion: 'reduce', ignoreHTTPSErrors: true,
      recordVideo: {dir: outputDir, size: viewport}});
    await context.addInitScript(() => {
      window.__labWebSockets = [];
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          window.__labWebSockets.push(this);
        }
      };
      window.__labEventSources = [];
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(...args) {
          super(...args);
          window.__labEventSources.push(this.url);
        }
      };
    });
    page = await context.newPage();
    video = page.video();
    page.on('pageerror', error => errors.push(error.message));
    const handoff = new URLSearchParams({
      coach_session: created.session.session_id,
      coach_token: created.session.connection_token,
      coach_run: runID,
      coach_mode: 'guided',
    });
    await page.goto(`${labURL}/argocd/applications?${handoff}`, {waitUntil: 'domcontentloaded'});
    await coachReady(page, 'light');
    await page.locator('#argocd-coach-host button[data-action="begin"]').click();
    await page.getByText('shop-web-prod', {exact: true}).first().waitFor({timeout: 30_000});
    await page.locator('#argocd-coach-host .target-list li.visited').first().waitFor({timeout: 30_000});
    await capturePanel(page, path.join(outputDir, 'panel-light.png'));
    artifacts.push('panel-light.png');
    await page.screenshot({path: path.join(outputDir, 'applications-light.png'), animations: 'disabled'});
    artifacts.push('applications-light.png');

    const historySelector = selectors['app.history'].join(',');
    await setCoachCollapsed(page, true);
    await page.locator('body').getByText('shop-web-prod', {exact: true}).first().click();
    await page.waitForURL(/\/argocd\/applications\/.*shop-web-prod/, {timeout: 30_000});
    const argoStreams = await page.evaluate(() => window.__labEventSources.filter(url =>
      url.includes('/api/v1/')));
    console.log(`Argo EventSource subscriptions on Application details: ${argoStreams.length}`);
    const historyURL = new URL(page.url());
    historyURL.searchParams.set('rollback', '0');
    await page.goto(historyURL.toString(), {waitUntil: 'domcontentloaded'});
    await page.locator(historySelector).first().waitFor({state: 'visible', timeout: 30_000});
    await assertTheme(page, 'light');
    await setCoachCollapsed(page, false);
    for (const target of ['Application details header and summary', 'History and Rollback']) {
      await page.locator('#argocd-coach-host .target-list li.visited').filter({hasText: target})
        .waitFor({timeout: 30_000});
    }
    await page.screenshot({path: path.join(outputDir, 'history-light.png'), animations: 'disabled'});
    artifacts.push('history-light.png');

    await page.goto(`${labURL}/argocd/settings/appearance`, {waitUntil: 'domcontentloaded'});
    await page.getByText('Theme', {exact: true}).waitFor({state: 'visible'});
    await setCoachCollapsed(page, true);
    await page.locator('.appearance-list__panel .select__value').click();
    await page.locator('.appearance-list__panel .select__option').filter({hasText: /Dark/}).click();
    await page.waitForFunction(() => Boolean(document.querySelector('.theme-dark')));
    await page.goto(historyURL.toString(), {waitUntil: 'domcontentloaded'});
    await page.locator(historySelector).first().waitFor({state: 'visible', timeout: 30_000});
    await setCoachCollapsed(page, false);
    await coachReady(page, 'dark');
    await assertTheme(page, 'dark');
    await capturePanel(page, path.join(outputDir, 'panel-dark.png'));
    artifacts.push('panel-dark.png');
    await page.screenshot({path: path.join(outputDir, 'history-dark.png'), animations: 'disabled'});
    artifacts.push('history-dark.png');
    await comparePanel(page, 'light');
    await comparePanel(page, 'dark');
    const priorSockets = await page.evaluate(() => window.__labWebSockets.filter(socket =>
      socket.url.includes('/coach/learning/') && socket.url.endsWith('/stream')).length);
    await page.evaluate(() => {
      const socket = window.__labWebSockets.findLast(item =>
        item.url.includes('/coach/learning/') && item.url.endsWith('/stream') && item.readyState === WebSocket.OPEN);
      if (!socket) throw new Error('learning WebSocket is not open');
      socket.close(1000, 'recorder reconnect check');
    });
    await page.waitForFunction(count => {
      const sockets = window.__labWebSockets.filter(socket =>
        socket.url.includes('/coach/learning/') && socket.url.endsWith('/stream'));
      return sockets.length > count && sockets.at(-1).readyState === WebSocket.OPEN;
    },
    priorSockets, {timeout: 30_000});
    const sessionPath = `/api/sessions/${encodeURIComponent(created.session.session_id)}`;
    const sessionAuth = {Authorization: `Bearer ${created.session.connection_token}`};
    const session = await api(sessionPath, {headers: sessionAuth});
    const shortRevision = session.revision.slice(0, 7);
    if (!shortRevision || !(await page.locator(historySelector).first().innerText()).includes(shortRevision)) {
      throw new Error(`History does not display the deployed revision ${shortRevision}`);
    }
    for (const [question, answer] of [
      ['Which Application matches the briefing?', 'shop-web-prod'],
      ['What health status does the application header show?', 'Healthy'],
      ['Which Git revision is deployed?', shortRevision],
    ]) {
      await page.locator('#argocd-coach-host .card strong').filter({hasText: question})
        .waitFor({timeout: 30_000});
      await page.locator('#argocd-coach-host #check-answer').fill(answer);
      await page.locator('#argocd-coach-host #check-form button[type="submit"]').click();
    }
    await page.locator('#argocd-coach-host .debrief-modal #debrief-title').waitFor({timeout: 30_000});
    const completed = await api(sessionPath, {headers: sessionAuth});
    if (completed.state !== 'COMPLETED' || completed.checks_passed !== 3) {
      throw new Error(`Guided orientation did not complete: ${JSON.stringify(completed)}`);
    }
    if (errors.some(error => /coach|websocket/i.test(error))) {
      throw new Error('coach page error: ' + errors.join('; '));
    }
    console.log(`PASS: Argo list, History, both themes, visual baselines, and Guided orientation (${runID})`);
  } catch (error) {
    if (page) {
      const state = await page.evaluate(async () => {
        const response = await fetch('/argocd/api/v1/applications').catch(() => null);
        return {path: location.pathname, authHandoffComplete: sessionStorage.getItem('argo-coach:argocd-authenticated') === 'true',
          argoAPIStatus: response?.status, coachPresent: Boolean(document.querySelector('#argocd-coach-host'))};
      }).catch(() => ({}));
      console.error('browser state:', state);
      const failure = path.join(outputDir, 'failure.png');
      await page.screenshot({path: failure, animations: 'disabled'}).catch(() => {});
      artifacts.push('failure.png');
    }
    throw error;
  } finally {
    if (context) await context.close();
    if (video) {
      await video.saveAs(path.join(outputDir, 'reference.webm')).catch(() => {});
      await video.delete().catch(() => {});
      artifacts.push('reference.webm');
    }
    if (browser) await browser.close();
    if (runID) await api(`/api/runs/${encodeURIComponent(runID)}`, {method: 'DELETE'}).catch(error => {
      console.error('run cleanup failed:', error.message);
    });
    if (forward) forward.kill('SIGTERM');
    await writeFile(path.join(outputDir, 'recording.json'), JSON.stringify({
      argo_version: '3.5.3', playwright_version: '1.63.0', started_at: startedAt,
      completed_at: new Date().toISOString(), run_id: runID,
      viewport, artifacts, page_errors: errors,
    }, null, 2));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
