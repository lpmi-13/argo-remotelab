import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const coach = await readFile(new URL('../argocd-coach/src/coach.js', import.meta.url), 'utf8');
const bootstrap = await readFile(new URL('../argocd-coach/src/argocd-bootstrap.js', import.meta.url), 'utf8');
const launcher = await readFile(new URL('../lab-launcher/index.html', import.meta.url), 'utf8');
const preparationPage = await readFile(new URL('../lab-launcher/preparing.html', import.meta.url), 'utf8');
const styles = new Map(await Promise.all(['tokens.css', 'coach.css'].map(async name =>
  [name, await readFile(new URL(`../argocd-coach/src/ui/${name}`, import.meta.url), 'utf8')])));

function session(mode) {
  return {
    session_id: 'session-1', run_id: 'run-1', mode, state: 'READY',
    scenario: {id: 'console-history', title: 'Read the release history', level: 1},
    application: 'shop-web-prod', environment: 'prod', brief: 'Read the release history.',
    briefing: {source: 'Lab', headline: 'Read the release history',
      summary: 'The team wants to confirm the deployed shop version.'},
    checks_passed: 0, checks_total: 1, fixed: true, health: 'Healthy', sync: 'Synced',
    fix_surface: 'none', fix_paths: [], targets: [], note_draft: null, feedback: null,
    next_check: mode === 'demonstration' ? {id: 'revision', target: 'app.history', where: 'History and Rollback',
      action: 'Read the deployed revision.', reason: 'History shows the deployed commit.',
      learning: 'This commit is deployed.', demo: {
        what: 'Open shop-web-prod → History and Rollback; read the latest revision.',
        why: 'History records the Git commit Argo actually deployed.',
      },
      demonstration_answer: 'abc1234', available: true} : null,
  };
}

async function fixture(mode, history = false, applicationCard = false, fixSurface = 'none') {
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width: 1200, height: 750}});
  let view = {...session(mode), fix_surface: fixSurface};
  if (applicationCard) view = {...view,
    scenario: {id: 'console-orientation', title: 'Find the deployed revision', level: 1},
    checks_total: 3,
    next_check: {id: 'application', target: 'apps.list', where: 'Applications list',
      action: 'Find the application.', reason: 'Confirm the environment.',
      demo: {what: 'Find and click shop-web-prod in Applications.',
        why: 'Its name and environment label identify the release we need to verify.'},
      demonstration_answer: 'shop-web-prod', available: true},
  };
  let sessionFailure = null;
  const actions = [];
  await page.addInitScript(({applicationCard}) => {
    if (location.pathname.startsWith('/argocd/') && !sessionStorage.getItem('argo-coach:handoff')) {
      sessionStorage.setItem('argo-coach:handoff', JSON.stringify({session: 'session-1', token: 'test-token'}));
    }
    window.WebSocket = undefined;
    window.GuidedStepClock = class {
      stepId = null;
      start(id) { this.stepId = id; }
      stop() { this.stepId = null; }
      input() {}
    };
    window.ArgoActionObserver = class {
      constructor(emit) { this.emit = emit; this.seen = new Set(); this.fromURL(); }
      fromURL() {
        if (!applicationCard) return;
        const detail = location.pathname.includes('/applications/argocd/shop-web-prod');
        const target = detail ? 'app.header' : 'apps.list';
        if (this.seen.has(target)) return;
        this.seen.add(target);
        this.emit('target_visited', {target, ...(detail ? {application: 'shop-web-prod'} : {})});
      }
    };
    window.ArgoCoachTheme = {followTheme() {}};
  }, {applicationCard});
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: launcher});
    if (url.pathname === '/coach/learning/api/catalog') return route.fulfill({json: {scenarios: [
      {id: 'console-history', title: 'Read the release history', level: 1, brief: 'Find the revision.'},
    ]}});
    if (url.pathname === '/argocd/applications') {
      const cardMarkup = applicationCard ? '<a id="application-card" href="/argocd/applications/argocd/shop-web-prod" onclick="sessionStorage.setItem(\'application-clicked\', \'true\')"><span>shop-web-prod</span></a>' : '';
      const historyMarkup = history ? `<div style="height: 920px"></div>
        <div id="history-scroll" style="height: 240px; overflow: auto; width: 600px; margin-left: 550px; border: 1px solid">
          <div class="application-deployment-history" style="height: 950px">
            <div style="height: 680px"></div><span id="revision">abc1234</span>
          </div></div><div style="height: 600px"></div>` : '';
      return route.fulfill({contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${cardMarkup}${historyMarkup}
        <script src="/coach/assets/coach.js"></script></body></html>`});
    }
    if (url.pathname === '/argocd/applications/argocd/shop-web-prod' && applicationCard) {
      return route.fulfill({contentType: 'text/html', body: '<!doctype html><html><body><div id="app-detail">shop-web-prod · Healthy</div><script src="/coach/assets/coach.js"></script></body></html>'});
    }
    if (url.pathname === '/coach/assets/coach.js') return route.fulfill({contentType: 'text/javascript', body: coach});
    if (url.pathname.startsWith('/coach/assets/ui/')) return route.fulfill({contentType: 'text/css',
      body: styles.get(url.pathname.split('/').at(-1)) || ''});
    if (url.pathname === '/terminal/') return route.fulfill({contentType: 'text/html', body: '<p>Persistent shell</p>'});
    if (url.pathname === '/coach/learning/api/sessions/session-1/actions') {
      const action = route.request().postDataJSON();
      actions.push(action);
      if (applicationCard && action.type === 'target_visited' && action.details.target === 'app.header') {
        view = {...view, checks_passed: 1, next_check: {
          id: 'health', target: 'app.header', where: 'Application header',
          action: 'Read Health.', reason: 'The header shows current health.',
          demo: {what: 'Read Health in the Application header.',
            why: 'The header reports the current health of this workload.'},
          demonstration_answer: 'Healthy', available: true,
        }};
      }
      return route.fulfill({json: {session: view, evaluation: {accepted: true}}});
    }
    if (url.pathname === '/coach/learning/api/sessions/session-1') {
      if (sessionFailure) return route.fulfill({status: sessionFailure.status, json: {error: sessionFailure.error}});
      if (route.request().method() === 'POST') return route.fulfill({json: {session: view, evaluation: {correct: true}}});
      return route.fulfill({json: view});
    }
    return route.fulfill({status: 404, body: ''});
  });
  await page.goto('http://lab.test/argocd/applications');
  await page.locator('#argocd-coach-host .incident-briefing').waitFor();
  return {browser, page, actions, setView(next) { view = next; },
    setSessionFailure(status, error) { sessionFailure = {status, error}; }};
}

test('an expired session returns to missions while other errors stay visible', {timeout: 15000}, async () => {
  const {browser, page, setSessionFailure} = await fixture('demonstration');
  try {
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    setSessionFailure(503, 'learning service unavailable');
    await page.reload();
    await page.locator('#argocd-coach-host [role="alert"]').waitFor();
    assert.match(await page.locator('#argocd-coach-host [role="alert"]').innerText(), /learning service unavailable/);
    assert.equal(new URL(page.url()).pathname, '/argocd/applications');

    await page.evaluate(cached => sessionStorage.setItem('argo-coach:initial-view:session-1', JSON.stringify(cached)),
      session('demonstration'));
    setSessionFailure(404, 'session not found');
    await page.reload();
    await page.waitForURL('http://lab.test/');
    await page.locator('#scenario option[value="console-history"]').waitFor({state: 'attached'});
    assert.equal(await page.locator('h1').innerText(), 'Learn the Argo CD console');
    assert.deepEqual(await page.evaluate(() => [
      sessionStorage.getItem('argo-coach:handoff'),
      sessionStorage.getItem('argo-coach:initial-view:session-1'),
      sessionStorage.getItem('argo-coach:started:session-1'),
    ]), [null, null, null]);
  } finally { await browser.close(); }
});

test('first demo step clicks the Application after one countdown', {timeout: 30000}, async () => {
  for (const trigger of ['advance', 'timeout']) {
    const {browser, page} = await fixture('demonstration', false, true);
    try {
      await page.clock.install();
      await page.locator('#argocd-coach-host [data-action="begin"]').click();
      assert.deepEqual(await page.locator('#argocd-coach-host .demo-explanation p').allTextContents(),
        ['Find and click shop-web-prod in Applications.',
          'Its name and environment label identify the release we need to verify.']);
      assert.equal(await page.locator('#argocd-coach-host .step-count').textContent(), 'Step 1 of 3');
      assert.equal(new URL(page.url()).pathname, '/argocd/applications');
      if (trigger === 'advance') await page.locator('#argocd-coach-host [data-action="advance"]').click();
      else {
        await page.clock.runFor(14900);
        assert.equal(new URL(page.url()).pathname, '/argocd/applications');
        await page.clock.runFor(100);
      }
      const acting = page.locator('#argocd-coach-host .panel[data-doing]');
      await acting.waitFor();
      assert.equal(await acting.locator('.demo-explanation span').first().textContent(), 'Doing');
      assert.equal(await acting.locator('[data-demo-timer]').isVisible(), false);
      assert.equal(await acting.locator('.demo-step').evaluate(element =>
        getComputedStyle(element).borderLeftColor), 'rgb(224, 162, 0)');
      await page.clock.runFor(100);
      await page.locator('#argocd-coach-host .coach-pointer[data-visible]').waitFor();
      await page.clock.runFor(2200);
      await page.waitForURL('**/argocd/applications/argocd/shop-web-prod');
      await page.locator('#app-detail').waitFor();
      await page.waitForFunction(() => document.querySelector('#argocd-coach-host')?.shadowRoot
        .querySelector('.step-count')?.textContent === 'Step 2 of 3');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('application-clicked')), 'true');
      assert.equal((await page.locator('#argocd-coach-host .demo-explanation p').first().textContent()),
        'Read Health in the Application header.');
    } finally { await browser.close(); }
  }
});

test('demo action starts cursor movement without a Doing countdown', {timeout: 45000}, async () => {
  const {browser, page} = await fixture('demonstration', true);
  try {
    assert.equal(await page.locator('#argocd-coach-host .panel').count(), 0);
    assert.equal(await page.locator('#argocd-coach-host').innerText().then(text => text.includes('Connecting to the learning session')), false);
    const briefing = page.locator('#argocd-coach-host .incident-briefing');
    assert.equal(await briefing.locator('.brief-summary').textContent(),
      'The team wants to confirm the deployed shop version.');
    assert.equal(await briefing.locator('.brief-section, .brief-objective').count(), 0);
    assert.ok((await briefing.boundingBox()).height < 430, 'the opening briefing should stay compact');
    await page.clock.install();
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    await page.locator('#argocd-coach-host [data-demo-timer]:visible').waitFor();
    const panel = page.locator('#argocd-coach-host .panel');
    assert.equal(await panel.locator('.header .mark, .header .title').count(), 0);
    assert.equal(await panel.locator('.badge, .status, .footer').count(), 0);
    assert.deepEqual(await panel.locator('.demo-explanation span').allTextContents(), ['Next', 'Why']);
    assert.deepEqual(await panel.locator('.demo-explanation p').allTextContents(),
      ['Open shop-web-prod → History and Rollback; read the latest revision.',
        'History records the Git commit Argo actually deployed.']);
    assert.equal(await panel.locator('.demo-step').evaluate(element => getComputedStyle(element).borderWidth), '0px');
    const first = Number(await page.locator('#argocd-coach-host [data-demo-seconds]').innerText());
    assert.ok(first >= 14.5, `first action starts in ${first}s`);
    await page.clock.runFor(500);
    const second = Number(await page.locator('#argocd-coach-host [data-demo-seconds]').innerText());
    assert.ok(second < first, 'countdown should decrease while a demo beat is waiting');
    assert.equal(await page.locator('#argocd-coach-host [data-action="argocd"]').count(), 0);
    await page.clock.runFor(15000);
    assert.deepEqual(await panel.locator('.demo-explanation span').allTextContents(), ['Doing', 'Why']);
    assert.equal(await panel.getAttribute('data-doing'), '');
    assert.equal(await panel.locator('[data-demo-timer]').isVisible(), false);
    assert.equal(await panel.locator('.demo-step').evaluate(element =>
      getComputedStyle(element).borderLeftColor), 'rgb(224, 162, 0)');
    for (let attempt = 0; attempt < 12 &&
         !await page.locator('#argocd-coach-host .coach-pointer[data-visible]').isVisible(); attempt += 1) {
      await page.clock.runFor(500);
    }
    await page.locator('#argocd-coach-host .coach-pointer[data-visible]').waitFor();
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
    for (let attempt = 0; attempt < 12 &&
         (await panel.locator('.demo-explanation span').first().textContent()) !== 'Found'; attempt += 1) {
      await page.clock.runFor(500);
    }
    assert.deepEqual(await panel.locator('.demo-explanation span').allTextContents(), ['Found', 'Why']);
    assert.deepEqual(await panel.locator('.demo-explanation p').allTextContents(),
      ['abc1234', 'History records the Git commit Argo actually deployed.']);
    assert.equal(await panel.getAttribute('data-doing'), null);
    assert.ok(Number(await page.locator('#argocd-coach-host [data-demo-seconds]').innerText()) >= 14.5);
  } finally { await browser.close(); }
});

test('Advance skips reading beats while Doing has no timer', {timeout: 15000}, async () => {
  const {browser, page, actions} = await fixture('demonstration', true);
  try {
    await page.clock.install();
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    const advance = page.locator('#argocd-coach-host [data-action="advance"]');
    await advance.click();
    const phase = page.locator('#argocd-coach-host .demo-explanation span').first();
    assert.equal(await phase.textContent(), 'Doing');
    assert.equal(await page.locator('#argocd-coach-host [data-demo-timer]').isVisible(), false);
    assert.equal(await advance.isVisible(), false);
    for (let attempt = 0; attempt < 12 && await phase.textContent() !== 'Found'; attempt += 1) {
      await page.clock.runFor(500);
    }
    assert.equal(await phase.textContent(), 'Found');
    assert.ok(Number(await page.locator('#argocd-coach-host [data-demo-seconds]').innerText()) >= 14.5);
    const answered = page.waitForResponse(response => response.url().endsWith('/actions') &&
      response.request().postDataJSON()?.type === 'evidence_check_answered');
    await advance.click();
    await answered;
    assert.ok(actions.some(action => action.type === 'evidence_check_answered'));
    await page.locator('#argocd-coach-host [data-action="stop"]').click();
    assert.equal(await advance.isVisible(), false);
  } finally { await browser.close(); }
});

test('launcher keeps Argo CD closed until the scenario is ready, then starts the briefing countdown', {timeout: 30000}, async () => {
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage();
  const preparing = {...session('demonstration'), state: 'RESETTING',
    run_updated_at: '2026-10-05T12:00:00Z'};
  const ready = {...preparing, state: 'READY', run_updated_at: '2026-10-05T12:00:01Z'};
  let releaseSession;
  const heldSession = new Promise(resolve => { releaseSession = resolve; });
  let runReads = 0;
  let argoRequests = 0;
  let authRequests = 0;
  let runState = 'RESETTING';
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
      if (url.pathname === '/preparing.html') return route.fulfill({contentType: 'text/html', body: preparationPage});
      if (url.pathname === '/coach/learning/api/catalog') return route.fulfill({json: {scenarios: [
        {id: 'console-history', title: 'Read the release history', level: 1, brief: 'Find the revision.'},
      ]}});
      if (url.pathname === '/coach/learning/api/runs' && route.request().method() === 'POST') {
        return route.fulfill({json: {run: {id: 'run-1'},
          session: {...preparing, connection_token: 'test-token'}}});
      }
      if (url.pathname === '/coach/learning/api/runs/run-1') {
        runReads += 1;
        return route.fulfill({json: {id: 'run-1', state: runState,
          updated_at: runState === 'READY' ? ready.run_updated_at : preparing.run_updated_at}});
      }
      if (url.pathname === '/argocd/applications') {
        argoRequests += 1;
        return route.fulfill({contentType: 'text/html', body:
          '<!doctype html><html><head><script src="/coach/assets/argocd-bootstrap.js"></script>' +
          '<script defer src="/coach/assets/coach.js"></script></head><body><main>Argo CD</main></body></html>'});
      }
      if (url.pathname === '/coach/assets/argocd-bootstrap.js') return route.fulfill({contentType: 'text/javascript', body: bootstrap});
      if (url.pathname === '/coach/assets/coach.js') return route.fulfill({contentType: 'text/javascript', body: coach});
      if (url.pathname.startsWith('/coach/assets/ui/')) return route.fulfill({contentType: 'text/css',
        body: styles.get(url.pathname.split('/').at(-1)) || ''});
      if (url.pathname === '/coach/learning/api/auth/argocd') {
        authRequests += 1;
        return route.fulfill({json: {authenticated: true}});
      }
      if (url.pathname === '/coach/learning/api/sessions/session-1') {
        await heldSession;
        return route.fulfill({json: preparing});
      }
      return route.fulfill({status: 404, body: ''});
    });

    await page.goto('http://lab.test/');
    await page.locator('#scenario option[value="console-history"]').waitFor({state: 'attached'});
    await page.locator('#start').click();
    await page.waitForURL('**/preparing.html');
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Restoring'));
    assert.match(await page.locator('h1').innerText(), /Scenario is loading/);
    assert.ok(await page.locator('.swimmer').count() >= 10);
    assert.equal(argoRequests, 0, 'Argo CD must not load during preparation');
    assert.equal(authRequests, 0, 'Argo CD sign-in waits until readiness');
    assert.ok(runReads >= 1);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Restoring'));
    assert.equal(argoRequests, 0, 'refreshing preparation must not reveal Argo CD');

    await page.clock.install();
    runState = 'READY';
    await page.clock.runFor(2100);
    await page.locator('#argocd-coach-host .incident-briefing').waitFor();
    assert.equal(new URL(page.url()).pathname, '/argocd/applications');
    assert.equal(argoRequests, 1);
    assert.equal(authRequests, 1);
    assert.ok(runReads >= 2);
    assert.equal(await page.locator('#argocd-coach-host .panel').count(), 0);
    assert.equal(await page.locator('#argocd-coach-host [data-action="begin"]').isEnabled(), true);
    await page.setViewportSize({width: 1200, height: 300});
    const brief = page.locator('#argocd-coach-host .incident-briefing');
    await brief.evaluate(element => { element.scrollTop = 80; });
    const scrollBefore = await brief.evaluate(element => element.scrollTop);
    assert.ok(scrollBefore > 0, 'briefing should scroll on a short viewport');
    await page.waitForFunction(() => Boolean(window.coachStream));
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

test('failed preparation stays on the loading page and offers a return to missions', {timeout: 15000}, async () => {
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage();
  let argoRequests = 0;
  try {
    await page.addInitScript(() => sessionStorage.setItem('argo-coach:preparing', JSON.stringify({
      run_id: 'run-1', session_id: 'session-1', token: 'test-token', mode: 'guided', title: 'Shop incident',
    })));
    await page.route('**/*', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/preparing.html') return route.fulfill({contentType: 'text/html', body: preparationPage});
      if (path === '/coach/learning/api/runs/run-1') return route.fulfill({json: {
        id: 'run-1', state: 'FAILED', error: 'Baseline did not recover',
      }});
      if (path.startsWith('/argocd/')) argoRequests += 1;
      return route.fulfill({status: 404, body: ''});
    });
    await page.goto('http://lab.test/preparing.html');
    await page.locator('#return:visible').waitFor();
    assert.match(await page.locator('#status').innerText(), /Baseline did not recover/);
    assert.equal(new URL(page.url()).pathname, '/preparing.html');
    assert.equal(argoRequests, 0);
  } finally { await browser.close(); }
});

test('terminal button follows the mission repair surface and mode', {timeout: 30000}, async () => {
  const fixturePage = await fixture('guided');
  const {browser, page} = fixturePage;
  try {
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    const cases = [
      ['guided', 'none', false],
      ['guided', 'argo', false],
      ['guided', 'git', true],
      ['guided', 'argo-and-git', true],
      ['guided', 'terminal', true],
      ['challenge', 'argo', false],
      ['challenge', 'git', true],
      ['demonstration', 'git', false],
      ['demonstration', 'terminal', false],
    ];
    for (const [mode, fixSurface, expected] of cases) {
      fixturePage.setView({...session(mode), fix_surface: fixSurface});
      await page.reload();
      await page.locator('#argocd-coach-host .panel').waitFor();
      assert.equal(await page.locator('#argocd-coach-host [data-action="terminal"]').count(),
        Number(expected), `${mode} / ${fixSurface}`);
    }
  } finally { await browser.close(); }
});

test('terminal minimizes without remounting, resizes, and debrief is centered', {timeout: 15000}, async () => {
  const fixturePage = await fixture('guided', false, false, 'git');
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
      message: 'Run complete.', total: 100, breakdown: {},
      debrief_steps: [
        {action: 'We opened shop-web-prod.', finding: 'It is the prod release.'},
        {action: 'We opened History and Rollback.', finding: 'Argo deployed revision abc1234.'},
      ],
    }});
    await page.reload();
    await page.locator('#argocd-coach-host .debrief-modal').waitFor();
    assert.equal(await page.locator('#argocd-coach-host .panel').count(), 0);
    assert.deepEqual(await page.locator('#argocd-coach-host .debrief-steps li').allTextContents(), [
      'We opened shop-web-prod.It is the prod release.',
      'We opened History and Rollback.Argo deployed revision abc1234.',
    ]);
    assert.equal(await page.locator('#argocd-coach-host .debrief-content h3').count(), 0);
    assert.equal(await page.locator('#argocd-coach-host .debrief-steps li').first()
      .evaluate(element => getComputedStyle(element).borderWidth), '0px');
    assert.equal(await page.locator('#argocd-coach-host a[href^="/?scenario="]').count(), 2);
    const modal = await page.locator('#argocd-coach-host .debrief-modal').boundingBox();
    assert.ok(Math.abs(modal.x + modal.width / 2 - 600) < 2, JSON.stringify(modal));
    assert.ok(Math.abs(modal.y + modal.height / 2 - 375) < 2, JSON.stringify(modal));
  } finally { await browser.close(); }
});
