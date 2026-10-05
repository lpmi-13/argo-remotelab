import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// A browser-level Guided run: read the failure in Argo, repair it in the
// docked terminal, then verify the deployed revision in Argo. Gitea serves
// Git behind the scenes; its web editor is not part of this learner route.
const contextName = process.env.KUBE_CONTEXT;
const port = Number(process.env.LAB_PORT || 18080);
const labURL = process.env.LAB_URL?.replace(/\/$/, '') || `http://127.0.0.1:${port}`;
const artifacts = process.env.RECORDING_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(route, options = {}) {
  const response = await fetch(labURL + '/coach/learning' + route, {
    ...options, headers: {'Content-Type': 'application/json', ...options.headers},
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${route}: ${body.error || response.status}`);
  return body;
}

async function until(label, check, timeout = 480_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(2500);
  }
  throw new Error(`${label} timed out`);
}

async function forwardGateway() {
  if (process.env.LAB_URL) return null;
  if (!contextName || contextName === 'default') {
    throw new Error('Set KUBE_CONTEXT to the isolated lab context or provide LAB_URL.');
  }
  const forward = spawn('kubectl', ['--context', contextName, '-n', 'applications',
    'port-forward', 'svc/lab-gateway', `${port}:8080`], {stdio: 'ignore'});
  try {
    await until('lab gateway', async () => {
      if (forward.exitCode !== null) throw new Error('gateway port-forward exited');
      try { return (await fetch(labURL + '/healthz')).ok; } catch (_) { return false; }
    }, 30_000);
    return forward;
  } catch (error) {
    forward.kill('SIGTERM');
    throw error;
  }
}

async function showCoach(page) {
  const toggle = page.locator('#argocd-coach-host button[data-action="collapse"]');
  await toggle.waitFor({timeout: 30_000});
  if ((await toggle.getAttribute('aria-label')).startsWith('Expand')) await toggle.click();
}

async function openApplication(page) {
  await page.goto(`${labURL}/argocd/applications`, {waitUntil: 'domcontentloaded'});
  const toggle = page.locator('#argocd-coach-host button[data-action="collapse"]');
  await toggle.waitFor({timeout: 30_000});
  if ((await toggle.getAttribute('aria-label')).startsWith('Collapse')) await toggle.click();
  await page.locator('body').getByText('shop-web-prod', {exact: true}).first().click();
  await page.waitForURL(/\/argocd\/applications\/.*shop-web-prod/, {timeout: 30_000});
  console.log('Opened Argo Application:', new URL(page.url()).pathname);
}

async function answer(page, question, value, passed) {
  await showCoach(page);
  await page.locator('#argocd-coach-host .card strong').filter({hasText: question})
    .waitFor({timeout: 30_000});
  await page.locator('#argocd-coach-host #check-answer').fill(value);
  await page.locator('#argocd-coach-host #check-form button[type="submit"]').click();
  await page.locator('#argocd-coach-host .footer').filter({hasText: `${passed} of 3`})
    .waitFor({timeout: 30_000});
}

async function main() {
  await mkdir(artifacts, {recursive: true});
  let forward;
  let browser;
  let page;
  let runID;
  try {
    forward = await forwardGateway();
    const created = await api('/api/runs', {method: 'POST', body: JSON.stringify({
      scenario: 'missing-configmap', mode: 'guided', environment: 'prod', seed: 0,
    })});
    runID = created.run.id;
    await until('injected failure', async () => {
      const run = await api(`/api/runs/${encodeURIComponent(runID)}`);
      if (run.state === 'FAILED') throw new Error(run.error || 'run failed');
      return run.state === 'READY' && run;
    });

    browser = await chromium.launch({headless: true});
    const context = await browser.newContext({viewport: {width: 1440, height: 900},
      ignoreHTTPSErrors: true, reducedMotion: 'reduce'});
    page = await context.newPage();
    const handoff = new URLSearchParams({coach_session: created.session.session_id,
      coach_token: created.session.connection_token, coach_run: runID, coach_mode: 'guided'});
    await page.goto(`${labURL}/argocd/applications?${handoff}`, {waitUntil: 'domcontentloaded'});
    await page.locator('#argocd-coach-host button[data-action="begin"]').click();
    await answer(page, 'Which Application matches this incident?', 'shop-web-prod', 1);

    await openApplication(page);
    await page.locator('.application-resource-tree__node-title').first().waitFor({timeout: 30_000});
    if (process.env.USE_SHOW_ME === '1') {
      await showCoach(page);
      await page.locator('#argocd-coach-host button[data-action="show-location"]').first().click();
    } else {
      const pod = await page.evaluate(async () => {
        const token = localStorage.getItem('argocd.token');
        const response = await fetch('/argocd/api/v1/applications/shop-web-prod/resource-tree?appNamespace=argocd',
          {headers: token ? {Authorization: `Bearer ${token}`} : {}});
        if (!response.ok) throw new Error(`Argo resource tree returned ${response.status}`);
        const tree = await response.json();
        const pods = (tree.nodes || []).filter(node => node.kind === 'Pod');
        const selected = pods.find(node => node.health?.status !== 'Healthy') || pods[0];
        if (!selected) throw new Error('No Pod in the Argo resource tree');
        return selected.name;
      });
      await page.locator('.application-resource-tree__node-title').filter({hasText: pod}).first().click();
      await page.waitForURL(/node=/, {timeout: 30_000});
      await page.locator('body').getByText('EVENTS', {exact: true}).first().click();
    }
    await page.waitForURL(/tab=events/, {timeout: 30_000});
    await answer(page, 'Which ConfigMap name is the pod trying to load?', 'django-app-missing-config', 2);

    // Close Argo's resource drawer so the terminal dock is easy to use.
    await page.goto(`${labURL}/argocd/applications`, {waitUntil: 'domcontentloaded'});
    await showCoach(page);
    await page.locator('#argocd-coach-host button[data-action="terminal"]').click();
    const terminal = page.frameLocator('#argocd-coach-host iframe[title="Lab terminal"]');
    const input = terminal.locator('.xterm-helper-textarea');
    await input.waitFor({timeout: 30_000});
    await input.focus();
    const command = 'git fetch --depth=1 origin refs/tags/baseline:refs/tags/baseline && ' +
      'git checkout baseline -- chart/django-app/templates/deployment.yaml && ' +
      'git add chart/django-app/templates/deployment.yaml && ' +
      "git commit -m 'fix: restore required ConfigMap reference' && git push origin main";
    await page.keyboard.type(command, {delay: 2});
    await page.keyboard.press('Enter');

    const sessionPath = `/api/sessions/${encodeURIComponent(created.session.session_id)}`;
    const headers = {Authorization: `Bearer ${created.session.connection_token}`};
    const fixed = await until('terminal Git repair', async () => {
      const session = await api(sessionPath, {headers});
      if (session.state === 'FAILED') throw new Error(session.run_error || 'run failed');
      return session.fixed && session.durable && session;
    });

    const revision = fixed.revision.slice(0, 7);
    await openApplication(page);
    const historyURL = new URL(page.url());
    historyURL.searchParams.set('rollback', '0');
    await page.goto(historyURL.toString(), {waitUntil: 'domcontentloaded'});
    const history = page.locator('.application-deployment-history').first();
    await history.waitFor({state: 'visible', timeout: 30_000});
    if (!(await history.innerText()).includes(revision)) {
      throw new Error(`Argo History did not display deployed revision ${revision}`);
    }
    await answer(page, 'Which revision is now deployed after the fix?', revision, 3);
    await showCoach(page);
    await page.locator('#argocd-coach-host button[data-action="note"]').click();
    const note = {resource: 'Deployment/django', evidence: 'django-app-missing-config',
      revision: fixed.trigger_revision, cause: 'The deployment references a ConfigMap that does not exist',
      fix: 'Restore the ConfigMap reference in git'};
    for (const [field, value] of Object.entries(note)) {
      await page.locator(`#argocd-coach-host #note-${field}`).fill(value);
    }
    await page.locator('#argocd-coach-host #note-form button[type="submit"]').click();
    const completed = await until('Guided debrief', async () => {
      const session = await api(sessionPath, {headers});
      return session.state === 'COMPLETED' && session.feedback && session;
    }, 45_000);
    if (completed.checks_passed !== 3 || !completed.feedback.durable ||
        !completed.feedback.evidence_map.some(item => item.target === 'resource.events' && item.visited) ||
        !completed.feedback.evidence_map.some(item => item.target === 'app.history' && item.visited)) {
      throw new Error('Guided debrief is missing required Argo evidence or durable repair');
    }
    console.log(`PASS: Guided Argo evidence, terminal Git push, History verification, and debrief (${revision})`);
  } catch (error) {
    if (page) console.error('Browser location at failure:', page.url());
    if (page) await page.screenshot({path: path.join(artifacts, 'guided-terminal-failure.png'),
      animations: 'disabled'}).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    if (runID) await api(`/api/runs/${encodeURIComponent(runID)}`, {method: 'DELETE'})
      .catch(error => console.error('run cleanup failed:', error.message));
    if (forward) forward.kill('SIGTERM');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
