import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const coach = await readFile(new URL('../argocd-coach/src/coach.js', import.meta.url), 'utf8');
const bootstrap = await readFile(new URL('../argocd-coach/src/argocd-bootstrap.js', import.meta.url), 'utf8');
const launcher = await readFile(new URL('../lab-launcher/index.html', import.meta.url), 'utf8');
const styles = new Map(await Promise.all(['tokens.css', 'coach.css'].map(async name =>
  [name, await readFile(new URL(`../argocd-coach/src/ui/${name}`, import.meta.url), 'utf8')])));

function session(mode) {
  return {
    session_id: 'session-1', run_id: 'run-1', mode, state: 'READY',
    scenario: {id: 'console-history', title: 'Read the release history', level: 1},
    application: 'shop-web-prod', environment: 'prod', brief: 'Read the release history.',
    briefing: {source: 'Lab', headline: 'Read the release history', summary: 'Find the revision.',
      impact: 'Confirm what is deployed.', objective: 'Read History and Rollback.'},
    checks_passed: 0, checks_total: 1, fixed: true, health: 'Healthy', sync: 'Synced',
    fix_surface: 'none', fix_paths: [], targets: [], note_draft: null, feedback: null,
    next_check: mode === 'demonstration' ? {id: 'revision', target: 'app.history', where: 'History and Rollback',
      action: 'Read the deployed revision.', reason: 'History shows the deployed commit.',
      learning: 'This commit is deployed.', demonstration_answer: 'abc1234', available: true} : null,
  };
}

async function fixture(mode, history = false) {
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width: 1200, height: 750}});
  let view = session(mode);
  await page.addInitScript(() => {
    sessionStorage.setItem('argo-coach:handoff', JSON.stringify({session: 'session-1', token: 'test-token'}));
    window.WebSocket = undefined;
    window.GuidedStepClock = class {
      stepId = null;
      start(id) { this.stepId = id; }
      stop() { this.stepId = null; }
      input() {}
    };
    window.ArgoActionObserver = class { constructor() {} fromURL() {} };
    window.ArgoCoachTheme = {followTheme() {}};
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/argocd/applications') {
      const historyMarkup = history ? `<div style="height: 920px"></div>
        <div id="history-scroll" style="height: 240px; overflow: auto; width: 600px; margin-left: 550px; border: 1px solid">
          <div class="application-deployment-history" style="height: 950px">
            <div style="height: 680px"></div><span id="revision">abc1234</span>
          </div></div><div style="height: 600px"></div>` : '';
      return route.fulfill({contentType: 'text/html', body: `<!doctype html><html><body>${historyMarkup}
        <script src="/coach/assets/coach.js"></script></body></html>`});
    }
    if (url.pathname === '/coach/assets/coach.js') return route.fulfill({contentType: 'text/javascript', body: coach});
    if (url.pathname.startsWith('/coach/assets/ui/')) return route.fulfill({contentType: 'text/css',
      body: styles.get(url.pathname.split('/').at(-1)) || ''});
    if (url.pathname === '/terminal/') return route.fulfill({contentType: 'text/html', body: '<p>Persistent shell</p>'});
    if (url.pathname === '/coach/learning/api/sessions/session-1') {
      if (route.request().method() === 'POST') return route.fulfill({json: {session: view, evaluation: {correct: true}}});
      return route.fulfill({json: view});
    }
    return route.fulfill({status: 404, body: ''});
  });
  await page.goto('http://lab.test/argocd/applications');
  await page.locator('#argocd-coach-host .incident-briefing').waitFor();
  return {browser, page, setView(next) { view = next; }};
}

test('intro stands alone; demo countdown and cursor wait for nested History scrolling', {timeout: 30000}, async () => {
  const {browser, page} = await fixture('demonstration', true);
  try {
    assert.equal(await page.locator('#argocd-coach-host .panel').count(), 0);
    assert.equal(await page.locator('#argocd-coach-host').innerText().then(text => text.includes('Connecting to the learning session')), false);
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    await page.locator('#argocd-coach-host [data-demo-timer]:visible').waitFor();
    await page.waitForFunction(() => Number(document.querySelector('#argocd-coach-host').shadowRoot
      .querySelector('[data-demo-seconds]')?.textContent) > 1.5);
    const first = Number(await page.locator('#argocd-coach-host [data-demo-seconds]').innerText());
    await page.waitForTimeout(450);
    const second = Number(await page.locator('#argocd-coach-host [data-demo-seconds]').innerText());
    assert.ok(second < first, 'countdown should decrease while a demo beat is waiting');
    assert.equal(await page.locator('#argocd-coach-host [data-action="argocd"]').count(), 0);
    await page.locator('#argocd-coach-host .coach-pointer[data-visible]').waitFor({timeout: 20000});
    await page.waitForFunction(() => {
      const shadow = document.querySelector('#argocd-coach-host').shadowRoot;
      return Math.abs(parseFloat(shadow.querySelector('.coach-pointer').style.top) -
        document.querySelector('#revision').getBoundingClientRect().top) < 40;
    });
    const geometry = await page.evaluate(() => {
      const target = document.querySelector('#revision').getBoundingClientRect();
      const drawer = document.querySelector('#history-scroll');
      const drawerBox = drawer.getBoundingClientRect();
      const pointer = document.querySelector('#argocd-coach-host').shadowRoot.querySelector('.coach-pointer');
      return {targetTop: target.top, targetBottom: target.bottom, drawerTop: drawerBox.top,
        drawerBottom: drawerBox.bottom, drawerScroll: drawer.scrollTop,
        pageScroll: document.scrollingElement.scrollTop, pointerTop: parseFloat(pointer.style.top)};
    });
    assert.ok(geometry.drawerScroll > 0 && geometry.pageScroll > 0, JSON.stringify(geometry));
    assert.ok(geometry.targetTop >= geometry.drawerTop && geometry.targetBottom <= geometry.drawerBottom, JSON.stringify(geometry));
    assert.ok(geometry.targetTop >= 0 && geometry.targetBottom <= 750, JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.pointerTop - geometry.targetTop) < 40, JSON.stringify(geometry));
  } finally { await browser.close(); }
});

test('launcher shows the briefing during preparation, then counts down to the demo', {timeout: 30000}, async () => {
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage();
  const preparing = {...session('demonstration'), state: 'RESETTING',
    run_updated_at: '2026-10-05T12:00:00Z'};
  const ready = {...preparing, state: 'READY', run_updated_at: '2026-10-05T12:00:01Z'};
  let releaseSession;
  const heldSession = new Promise(resolve => { releaseSession = resolve; });
  let runReads = 0;
  try {
    await page.addInitScript(() => {
      window.GuidedStepClock = class {
        stepId = null;
        start(id) { this.stepId = id; }
        stop() { this.stepId = null; }
        input() {}
      };
      window.ArgoActionObserver = class { constructor() {} fromURL() {} };
      window.ArgoCoachTheme = {followTheme() {}};
      window.WebSocket = class {
        static OPEN = 1;
        readyState = 1;
        constructor() { window.coachStream = this; queueMicrotask(() => this.onopen?.()); }
        close() { this.readyState = 3; this.onclose?.(); }
      };
    });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: launcher});
      if (url.pathname === '/coach/learning/api/catalog') return route.fulfill({json: {scenarios: [
        {id: 'console-history', title: 'Read the release history', level: 1, brief: 'Find the revision.'},
      ]}});
      if (url.pathname === '/coach/learning/api/runs' && route.request().method() === 'POST') {
        return route.fulfill({json: {run: {id: 'run-1'},
          session: {...preparing, connection_token: 'test-token'}}});
      }
      if (url.pathname === '/coach/learning/api/runs/run-1') {
        runReads += 1;
        return route.fulfill({status: 500, json: {error: 'Launcher should not wait for READY'}});
      }
      if (url.pathname === '/argocd/applications') return route.fulfill({contentType: 'text/html', body:
        '<!doctype html><html><head><script src="/coach/assets/argocd-bootstrap.js"></script>' +
        '<script defer src="/coach/assets/coach.js"></script></head><body><main>Argo CD</main></body></html>'});
      if (url.pathname === '/coach/assets/argocd-bootstrap.js') return route.fulfill({contentType: 'text/javascript', body: bootstrap});
      if (url.pathname === '/coach/assets/coach.js') return route.fulfill({contentType: 'text/javascript', body: coach});
      if (url.pathname.startsWith('/coach/assets/ui/')) return route.fulfill({contentType: 'text/css',
        body: styles.get(url.pathname.split('/').at(-1)) || ''});
      if (url.pathname === '/coach/learning/api/auth/argocd') return route.fulfill({json: {authenticated: true}});
      if (url.pathname === '/coach/learning/api/sessions/session-1') {
        await heldSession;
        return route.fulfill({json: preparing});
      }
      return route.fulfill({status: 404, body: ''});
    });

    await page.goto('http://lab.test/');
    await page.locator('#scenario option[value="console-history"]').waitFor({state: 'attached'});
    await page.locator('#start').click();
    await page.locator('#argocd-coach-host .incident-briefing').waitFor();
    assert.equal(new URL(page.url()).pathname, '/argocd/applications');
    assert.equal(runReads, 0, 'launcher must not wait for run readiness');
    assert.equal(await page.locator('#argocd-coach-host .panel').count(), 0);
    assert.equal(await page.locator('#argocd-coach-host [data-action="begin"]').isDisabled(), true);
    assert.match(await page.locator('#argocd-coach-host [data-brief-label]').innerText(), /Preparing the lab/);
    await page.setViewportSize({width: 1200, height: 420});
    const brief = page.locator('#argocd-coach-host .incident-briefing');
    await brief.evaluate(element => { element.scrollTop = 80; });
    const scrollBefore = await brief.evaluate(element => element.scrollTop);
    assert.ok(scrollBefore > 0, 'briefing should scroll on a short viewport');
    await page.waitForFunction(() => Boolean(window.coachStream));
    await page.clock.install();
    await page.evaluate(next => window.coachStream.onmessage({data: JSON.stringify(next)}), ready);
    assert.equal(await page.locator('#argocd-coach-host [data-action="begin"]').isEnabled(), true);
    assert.equal(await brief.evaluate(element => element.scrollTop), scrollBefore,
      'a readiness update should not move the briefing back to the top');
    await page.clock.runFor(5000);
    const progress = Number(await page.locator('#argocd-coach-host [role="progressbar"]').getAttribute('aria-valuenow'));
    assert.ok(progress >= 25 && progress <= 45, `briefing progress was ${progress}%`);
    await page.evaluate(next => window.coachStream.onmessage({data: JSON.stringify(next)}),
      {...ready, state: 'UNKNOWN', run_updated_at: null});
    await page.clock.runFor(2000);
    await page.evaluate(next => window.coachStream.onmessage({data: JSON.stringify(next)}), ready);
    const resumed = Number(await page.locator('#argocd-coach-host [role="progressbar"]').getAttribute('aria-valuenow'));
    assert.ok(Math.abs(resumed - progress) <= 1, 'a temporary status outage should pause the countdown');
    releaseSession();
    await page.clock.runFor(100);
    assert.equal(await page.locator('#argocd-coach-host .incident-briefing').count(), 1,
      'an older preparation response must not hide the briefing');
    await page.clock.runFor(10100);
    await page.locator('#argocd-coach-host .panel').waitFor();
    assert.equal(await page.locator('#argocd-coach-host .incident-briefing').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('argo-coach:started:session-1')), 'true');
  } finally {
    releaseSession();
    await browser.close();
  }
});

test('terminal minimizes without remounting, resizes, and debrief is centered', {timeout: 15000}, async () => {
  const fixturePage = await fixture('guided');
  const {browser, page} = fixturePage;
  try {
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    await page.locator('#argocd-coach-host [data-action="terminal"]').click();
    await page.locator('#argocd-coach-host iframe[title="Lab terminal"]').waitFor();
    await page.evaluate(() => {
      document.querySelector('#argocd-coach-host').shadowRoot.querySelector('iframe').dataset.keep = 'yes';
    });
    const before = await page.locator('#argocd-coach-host .terminal-dock').boundingBox();
    await page.locator('#argocd-coach-host [data-action="minimize-terminal"]').click();
    assert.equal(await page.locator('#argocd-coach-host .terminal-dock[data-minimized]').count(), 1);
    await page.locator('#argocd-coach-host [data-action="minimize-terminal"]').click();
    assert.equal(await page.locator('#argocd-coach-host iframe[data-keep="yes"]').count(), 1);
    const handle = await page.locator('#argocd-coach-host .terminal-resize').boundingBox();
    await page.mouse.move(handle.x + 12, handle.y + 12);
    await page.mouse.down();
    await page.mouse.move(handle.x - 100, handle.y - 80, {steps: 8});
    await page.mouse.up();
    const after = await page.locator('#argocd-coach-host .terminal-dock').boundingBox();
    assert.ok(after.width > before.width + 70 && after.height > before.height + 50,
      JSON.stringify({before, after}));

    fixturePage.setView({...session('guided'), state: 'COMPLETED', feedback: {
      message: 'Run complete.', evidence_map: [], practice_notes: [], total: 100, breakdown: {},
    }});
    await page.reload();
    await page.locator('#argocd-coach-host .debrief-modal').waitFor();
    assert.equal(await page.locator('#argocd-coach-host .panel').count(), 0);
    const modal = await page.locator('#argocd-coach-host .debrief-modal').boundingBox();
    assert.ok(Math.abs(modal.x + modal.width / 2 - 600) < 2, JSON.stringify(modal));
    assert.ok(Math.abs(modal.y + modal.height / 2 - 375) < 2, JSON.stringify(modal));
  } finally { await browser.close(); }
});
