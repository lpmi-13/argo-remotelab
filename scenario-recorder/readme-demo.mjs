import {spawn} from 'node:child_process';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const outputDir = process.env.RECORDING_DIR || path.join(here, 'artifacts');
const gifPath = process.env.README_GIF_OUTPUT || path.join(repo, 'docs/assets/console-orientation.gif');
const port = Number(process.env.LAB_PORT || 18080);
const labURL = process.env.LAB_URL?.replace(/\/$/, '') || `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: 'inherit'});
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

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
  if (process.env.LAB_URL) return null;
  if (!process.env.KUBE_CONTEXT) throw new Error('Set KUBE_CONTEXT or LAB_URL.');
  const forward = spawn('kubectl', ['--context', process.env.KUBE_CONTEXT, '-n', 'applications',
    'port-forward', 'svc/lab-gateway', `${port}:8080`], {stdio: 'ignore'});
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (forward.exitCode !== null) throw new Error('gateway port-forward exited');
    try { if ((await fetch(labURL + '/healthz')).ok) return forward; }
    catch (_) { /* Wait for the forward. */ }
    await sleep(500);
  }
  forward.kill('SIGTERM');
  throw new Error('gateway port-forward did not become ready');
}

async function readyRun(id) {
  for (let attempt = 0; attempt < 210; attempt += 1) {
    const run = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (run.state === 'READY') return;
    if (['FAILED', 'ABORTED'].includes(run.state)) throw new Error(run.error || `run ${run.state}`);
    await sleep(2000);
  }
  throw new Error('scenario did not become ready in seven minutes');
}

async function convertToGif(videoPath, start, duration) {
  const palette = path.join(outputDir, 'readme-palette.png');
  const temporaryGif = path.join(outputDir, 'readme-demo.gif');
  const input = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', start.toFixed(2),
    '-t', duration.toFixed(2), '-i', videoPath];
  const frames = 'fps=5,scale=960:-1:flags=lanczos';
  await run('ffmpeg', [...input, '-vf', `${frames},palettegen=max_colors=96:stats_mode=diff`, palette]);
  await run('ffmpeg', [...input, '-i', palette, '-lavfi',
    `${frames}[frames];[frames][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
    '-loop', '0', temporaryGif]);
  await mkdir(path.dirname(gifPath), {recursive: true});
  await rename(temporaryGif, gifPath);
}

async function main() {
  await mkdir(outputDir, {recursive: true});
  let forward;
  let browser;
  let context;
  let runID;
  try {
    forward = await forwardGateway();
    const created = await api('/api/runs', {method: 'POST', body: JSON.stringify({
      scenario: 'console-orientation', mode: 'demonstration', environment: 'prod',
      scenario_key: 'readme-demo', replace_existing: true,
    })});
    runID = created.run.id;
    await readyRun(runID);

    browser = await chromium.launch({headless: true,
      ...(process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {})});
    context = await browser.newContext({viewport: {width: 1280, height: 720},
      locale: 'en-GB', colorScheme: 'light', reducedMotion: 'reduce',
      recordVideo: {dir: outputDir, size: {width: 1280, height: 720}}});
    const videoStart = Date.now();
    const page = await context.newPage();
    const video = page.video();
    const handoff = new URLSearchParams({
      coach_session: created.session.session_id,
      coach_token: created.session.connection_token,
      coach_run: runID,
      coach_mode: 'demonstration',
    });
    await page.goto(`${labURL}/argocd/applications?${handoff}`, {waitUntil: 'domcontentloaded'});
    const begin = page.locator('#argocd-coach-host [data-action="begin"]');
    await begin.waitFor({state: 'visible', timeout: 60_000});
    await page.waitForFunction(() => {
      const button = document.querySelector('#argocd-coach-host')?.shadowRoot?.querySelector('[data-action="begin"]');
      return button && !button.disabled;
    }, null, {timeout: 60_000});
    await page.getByText('shop-web-prod', {exact: true}).first()
      .waitFor({state: 'visible', timeout: 60_000});
    const clipStart = Date.now();
    await sleep(1200);
    await begin.click();

    for (let step = 0; step < 30; step += 1) {
      await page.waitForFunction(() => {
        const root = document.querySelector('#argocd-coach-host')?.shadowRoot;
        return root?.querySelector('.debrief-modal #debrief-title') ||
          root?.querySelector('.demo-timer:not([hidden]) #demo-advance');
      }, null, {timeout: 90_000});
      if (await page.locator('#argocd-coach-host .debrief-modal #debrief-title').count()) break;
      await sleep(2200);
      const advance = page.locator('#argocd-coach-host .demo-timer:not([hidden]) #demo-advance');
      if (await advance.isVisible()) await advance.click();
    }
    await page.locator('#argocd-coach-host .debrief-modal #debrief-title')
      .waitFor({timeout: 90_000});
    const finished = await api(`/api/runs/${encodeURIComponent(runID)}`);
    if (finished.state !== 'COMPLETED') throw new Error(`demo ended in ${finished.state}`);
    await sleep(2200);
    const clipEnd = Date.now();
    await context.close();
    context = null;
    const videoPath = path.join(outputDir, 'readme-demo.webm');
    await video.saveAs(videoPath);
    await video.delete();
    const start = Math.max(0, (clipStart - videoStart) / 1000);
    const duration = (clipEnd - clipStart) / 1000;
    await writeFile(path.join(outputDir, 'readme-demo.json'), JSON.stringify({
      scenario: 'console-orientation', mode: 'demonstration',
      start_seconds: start, duration_seconds: duration, video: videoPath, gif: gifPath,
    }, null, 2));
    await convertToGif(videoPath, start, duration);
    console.log(`Saved ${gifPath} (${duration.toFixed(1)} seconds of demo)`);
  } finally {
    await context?.close();
    await browser?.close();
    if (runID) await api(`/api/runs/${encodeURIComponent(runID)}`, {method: 'DELETE'}).catch(() => {});
    forward?.kill('SIGTERM');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
