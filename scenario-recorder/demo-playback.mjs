import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = process.env.RECORDING_DIR || path.join(here, 'artifacts');
const contextName = process.env.KUBE_CONTEXT;
const port = Number(process.env.LAB_PORT || 18080);
const labURL = process.env.LAB_URL?.replace(/\/$/, '') || `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(route, options = {}) {
  const response = await fetch(labURL + '/coach/learning' + route, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${route}: ${body.error || response.status}`);
  return body;
}

async function forwardGateway() {
  if (process.env.LAB_URL) return null;
  if (!contextName) throw new Error('Set KUBE_CONTEXT to the isolated lab context or provide LAB_URL.');
  const forward = spawn('kubectl', ['--context', contextName, '-n', 'applications', 'port-forward',
    'svc/lab-gateway', `${port}:8080`], {stdio: 'ignore'});
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (forward.exitCode !== null) throw new Error('gateway port-forward exited');
    try { if ((await fetch(labURL + '/healthz')).ok) return forward; }
    catch (_) { /* Wait for port-forward. */ }
    await sleep(500);
  }
  forward.kill('SIGTERM');
  throw new Error('gateway port-forward did not become ready');
}

async function launch(page, scenario = 'console-orientation') {
  await page.goto(labURL + '/', {waitUntil: 'domcontentloaded'});
  await page.locator(`#scenario option[value="${scenario}"]`).waitFor({state: 'attached'});
  const mode = await page.locator('#mode').inputValue();
  if (mode !== 'demonstration') throw new Error(`launcher default is ${mode}`);
  await page.locator('#scenario').selectOption(scenario);
  await page.locator('#start').click();
  await page.waitForFunction(() => {
    const handoff = JSON.parse(sessionStorage.getItem('argo-coach:handoff') || 'null');
    return location.pathname.startsWith('/argocd/') && handoff?.run &&
      document.querySelector('#argocd-coach-host')?.shadowRoot?.querySelector('[data-action="begin"]');
  }, null, {timeout: 8 * 60_000});
  await page.waitForFunction(() => {
    const button = document.querySelector('#argocd-coach-host')?.shadowRoot?.querySelector('[data-action="begin"]');
    return button && !button.disabled;
  }, null, {timeout: 8 * 60_000});
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('argo-coach:handoff')).run);
}

async function waitForDebrief(page, timeout) {
  try {
    await page.locator('#argocd-coach-host .debrief-modal #debrief-title')
      .waitFor({timeout});
  } catch (error) {
    const snapshot = await page.evaluate(async () => {
      const handoff = JSON.parse(sessionStorage.getItem('argo-coach:handoff') || 'null');
      const response = await fetch(`/coach/learning/api/sessions/${handoff.session}`, {
        headers: {Authorization: `Bearer ${handoff.token}`},
      });
      const session = await response.json();
      const panel = document.querySelector('#argocd-coach-host')?.shadowRoot?.querySelector('.panel');
      return {url: location.href, panelCollapsed: panel?.hasAttribute('data-collapsed'),
        panelText: panel?.textContent?.slice(0, 500), state: session.state,
        checksPassed: session.checks_passed, nextCheck: session.next_check?.id,
        feedback: Boolean(session.feedback)};
    });
    console.error('demo stalled:', snapshot);
    await page.screenshot({path: path.join(outputDir, 'demo-stalled.png')});
    throw error;
  }
}

async function verifyIncidentDemo(page, scenario, runID) {
  await page.locator('#argocd-coach-host [data-action="begin"]').click();
  await page.locator('#argocd-coach-host .demo-patch pre').waitFor({timeout: 20 * 60_000});
  await page.screenshot({path: path.join(outputDir, 'demo-incident-patch.png')});
  console.log(`${scenario} source patch visible`);
  await waitForDebrief(page, 20 * 60_000);
  const incident = await api('/api/runs/' + encodeURIComponent(runID));
  if (incident.state !== 'COMPLETED') throw new Error(`incident demo ended in ${incident.state}`);
  await page.screenshot({path: path.join(outputDir, 'demo-incident-debrief.png')});
  console.log(`${scenario} demonstration auto-completed after the source fix`);
}

async function main() {
  await mkdir(outputDir, {recursive: true});
  let forward;
  let browser;
  let runID;
  let firstRun;
  try {
    forward = await forwardGateway();
    browser = await chromium.launch({headless: true});
    const context = await browser.newContext({viewport: {width: 1440, height: 900},
      locale: 'en-GB', reducedMotion: 'reduce'});
    let page = await context.newPage();
    if (process.env.DEMO_ONLY_SCENARIO) {
      const scenario = process.env.DEMO_ONLY_SCENARIO;
      runID = await launch(page, scenario);
      await verifyIncidentDemo(page, scenario, runID);
      return;
    }
    firstRun = await launch(page);
    console.log(`first run ready: ${firstRun}`);
    await page.close();

    page = await context.newPage();
    runID = await launch(page);
    if (runID === firstRun) throw new Error('launcher reused the closed-tab run');
    const replaced = await api('/api/runs/' + encodeURIComponent(firstRun));
    if (replaced.state !== 'ABORTED') throw new Error(`old run is ${replaced.state}`);
    console.log(`closed-tab run replaced: ${runID}`);

    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    await page.locator('#argocd-coach-host .coach-pointer[data-visible]').waitFor({timeout: 2 * 60_000});
    await page.screenshot({path: path.join(outputDir, 'demo-cursor.png')});
    console.log('coach pointer visible');
    await page.locator('#argocd-coach-host .coach-pointer[data-click]').waitFor({timeout: 2 * 60_000});
    await page.screenshot({path: path.join(outputDir, 'demo-click.png')});
    console.log('coach pointer cued an Argo click');
    await waitForDebrief(page, 20 * 60_000);
    const finished = await api('/api/runs/' + encodeURIComponent(runID));
    if (finished.state !== 'COMPLETED') throw new Error(`demo ended in ${finished.state}`);
    await page.screenshot({path: path.join(outputDir, 'demo-debrief.png')});
    console.log('demonstration auto-completed with no step clicks');

    if (process.env.DEMO_INCIDENT) {
      const scenario = process.env.DEMO_INCIDENT;
      runID = await launch(page, scenario);
      await verifyIncidentDemo(page, scenario, runID);
    }
  } finally {
    for (const id of [runID, firstRun]) {
      if (!id) continue;
      try {
        const run = await api('/api/runs/' + encodeURIComponent(id));
        if (!['COMPLETED', 'ABORTED', 'FAILED'].includes(run.state)) {
          await api('/api/runs/' + encodeURIComponent(id), {method: 'DELETE'});
        }
      } catch (_) { /* Keep the original failure. */ }
    }
    await browser?.close();
    forward?.kill('SIGTERM');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
