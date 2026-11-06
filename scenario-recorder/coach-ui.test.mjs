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

const launchBrowser = () => chromium.launch({headless: true,
  ...(process.env.CHROME_EXECUTABLE ? {executablePath: process.env.CHROME_EXECUTABLE} : {})});

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
  const browser = await launchBrowser();
  const page = await browser.newPage({viewport: {width: 1200, height: 750}});
  let view = {...session(mode), fix_surface: fixSurface};
  if (applicationCard) view = {...view,
    scenario: {id: 'console-orientation', title: 'Find the deployed revision', level: 1},
    checks_total: 2,
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
  const historyMarkup = `<div style="height: 920px"></div>
    <div id="history-scroll" ${history === 'closed' ? 'hidden' : ''} style="height: 240px; overflow: auto; width: 600px; margin-left: 550px; border: 1px solid">
      <div class="application-deployment-history" style="height: 950px">
        <div style="height: 680px"></div><span id="revision-label">Revision:</span> <span id="revision">abc1234</span>
      </div></div><div style="height: 600px"></div>`;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: launcher});
    if (url.pathname === '/coach/learning/api/catalog') return route.fulfill({json: {scenarios: [
      {id: 'console-history', title: 'Read the release history', level: 1, brief: 'Find the revision.'},
    ]}});
    if (url.pathname === '/argocd/applications') {
      const cardMarkup = applicationCard ? '<a id="application-card" href="/argocd/applications/argocd/shop-web-prod" onclick="sessionStorage.setItem(\'application-clicked\', \'true\')"><span>shop-web-prod</span></a>' : '';
      return route.fulfill({contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${cardMarkup}
        <script src="/coach/assets/coach.js"></script></body></html>`});
    }
    if (url.pathname === '/argocd/applications/argocd/shop-web-prod' && (applicationCard || history)) {
      const button = history === 'closed' ? '<button onclick="history.replaceState(null, \'\', \'?rollback=0\'); document.querySelector(\'#history-scroll\').hidden = false">History and Rollback</button>' : '';
      return route.fulfill({contentType: 'text/html', body: `<!doctype html><html><body><div id="app-detail">shop-web-prod · Healthy</div>${button}${history ? historyMarkup : ''}<script src="/coach/assets/coach.js"></script></body></html>`});
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
          id: 'revision', target: 'app.history', where: 'History and Rollback',
          action: 'Read the deployed revision.', reason: 'History shows the deployed commit.',
          demo: {what: 'Open shop-web-prod → History and Rollback; find Revision in the newest entry.',
            look: 'Look for Revision in the newest History entry.',
            why: 'History records the Git commit Argo actually deployed.'},
          demonstration_answer: 'abc1234', available: false,
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
  await page.goto(history ? 'http://lab.test/argocd/applications/argocd/shop-web-prod' :
    'http://lab.test/argocd/applications');
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

test('first demo step clicks the Application after one countdown', {timeout: 45000}, async () => {
  for (const trigger of ['advance', 'timeout']) {
    const {browser, page} = await fixture('demonstration', false, true);
    try {
      await page.clock.install();
      await page.locator('#argocd-coach-host [data-action="begin"]').click();
      assert.deepEqual(await page.locator('#argocd-coach-host .demo-explanation p').allTextContents(),
        ['Find and click shop-web-prod in Applications.',
          'Its name and environment label identify the release we need to verify.']);
      assert.equal(await page.locator('#argocd-coach-host .step-count').textContent(), 'Step 1 of 2');
      assert.equal(new URL(page.url()).pathname, '/argocd/applications');
      if (trigger === 'advance') await page.locator('#argocd-coach-host [data-action="advance"]').click();
      else {
        await page.clock.runFor(14900);
        assert.equal(new URL(page.url()).pathname, '/argocd/applications');
        await page.clock.runFor(500);
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
        .querySelector('.step-count')?.textContent === 'Step 2 of 2');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('application-clicked')), 'true');
      assert.equal((await page.locator('#argocd-coach-host .demo-explanation p').first().textContent()),
        'Open shop-web-prod → History and Rollback; find Revision in the newest entry.');
    } finally { await browser.close(); }
  }
});

test('first mission names Revision before highlighting its value', {timeout: 30000}, async () => {
  const fixturePage = await fixture('demonstration', 'closed');
  const {browser, page, actions} = fixturePage;
  try {
    const current = session('demonstration');
    fixturePage.setView({...current,
      scenario: {id: 'console-orientation', title: 'Find the deployed revision', level: 1},
      checks_passed: 1, checks_total: 2,
      next_check: {...current.next_check, demo: {
        what: 'Open shop-web-prod → History and Rollback; find Revision in the newest entry.',
        look: 'Look for Revision in the newest History entry.',
        why: 'History records the Git commit Argo actually deployed.',
      }},
    });
    await page.reload();
    await page.clock.install();
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    await page.locator('#argocd-coach-host [data-action="advance"]').click();

    const phase = page.locator('#argocd-coach-host .demo-explanation span').first();
    for (let attempt = 0; attempt < 12 && await phase.textContent() !== 'Look'; attempt += 1) {
      await page.clock.runFor(500);
    }
    assert.equal(await phase.textContent(), 'Look');
    assert.equal(await page.locator('#argocd-coach-host .demo-explanation p').first().textContent(),
      'Look for Revision in the newest History entry.');
    assert.equal(await page.locator('#argocd-coach-host .coach-pointer[data-visible]').count(), 0);
    assert.equal(await page.locator('#argocd-coach-host .spotlight').count(), 0);
    assert.ok(Number(await page.locator('#argocd-coach-host [data-demo-seconds]').innerText()) <= 4);
    await page.clock.runFor(3500);
    assert.equal(await phase.textContent(), 'Look');
    assert.equal(actions.some(action => action.type === 'evidence_check_answered'), false);

    for (let attempt = 0; attempt < 14 && await phase.textContent() !== 'Found'; attempt += 1) {
      await page.clock.runFor(500);
    }
    assert.equal(await phase.textContent(), 'Found');
    assert.equal(await page.locator('#argocd-coach-host .demo-explanation p').first().textContent(),
      'Revision: abc1234');
    const geometry = await page.evaluate(() => {
      const label = document.querySelector('#revision-label').getBoundingClientRect();
      const revision = document.querySelector('#revision').getBoundingClientRect();
      const highlight = document.querySelector('#argocd-coach-host').shadowRoot
        .querySelector('.spotlight').getBoundingClientRect();
      return {label: {left: label.left, top: label.top, right: label.right, bottom: label.bottom},
        revision: {left: revision.left, top: revision.top, right: revision.right, bottom: revision.bottom},
        highlight: {left: highlight.left, top: highlight.top, right: highlight.right, bottom: highlight.bottom}};
    });
    for (const target of [geometry.label, geometry.revision]) {
      assert.ok(geometry.highlight.left <= target.left && geometry.highlight.top <= target.top &&
        geometry.highlight.right >= target.right && geometry.highlight.bottom >= target.bottom,
      JSON.stringify(geometry));
    }
    assert.ok(Number(await page.locator('#argocd-coach-host [data-demo-seconds]').innerText()) >= 14.5);
    assert.equal(actions.some(action => action.type === 'evidence_check_answered'), false);
  } finally { await browser.close(); }
});

for (const [name, desiredInitially, selectedNode, duplicateName = false] of [
  ['Live already selected', false, true],
  ['Desired already selected', true, true],
  ['different resource selected', false, false],
  ['Service and Deployment share a name', false, false, true],
]) {
  test(`resource demo skips no-op clicks when ${name}`, {timeout: 30000}, async () => {
    const fixturePage = await fixture('demonstration');
    const {browser, page} = fixturePage;
    const expectLook = name === 'Live already selected';
    let current = {...session('demonstration'),
      scenario: {id: 'console-resources', title: 'Read a resource', level: 1},
      checks_passed: 1, checks_total: 2,
      next_check: {id: 'readiness-path', target: 'resource.manifest', where: 'Desired manifest',
        action: 'Read the readiness path.', reason: 'Desired shows the path Argo applies.',
        demo: {what: 'Open Deployment/django → Manifest → Desired; read readinessProbe.httpGet.path.',
          ...(expectLook ? {look: 'Look for readinessProbe.httpGet.path in the Desired manifest.'} : {}),
          why: 'Desired shows the probe path Argo will apply.'},
        demonstration_answer: '/api/health/', available: desiredInitially}};
    fixturePage.setView(current);
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/argocd/applications/argocd/shop-web-prod') {
        const nodeMarkup = duplicateName ? `
          <div class="application-resource-tree__node-title" onclick="tabClicks.service++; history.replaceState(null, '', '?view=tree&node=%2FService%2Fapplications%2Fdjango%2F0')">django</div>
          <div class="application-resource-tree__node-title" onclick="tabClicks.node++; history.replaceState(null, '', '?view=tree&node=%2FDeployment%2Fapplications%2Fdjango%2F0')">django</div>` : `
          <div class="application-resource-tree__node-title" onclick="tabClicks.node++; history.replaceState(null, '', '?view=tree&node=%2FDeployment%2Fapplications%2Fdjango%2F0&tab=manifest')">django</div>`;
        return route.fulfill({contentType: 'text/html', body: `<!doctype html><html><body>
          <script>window.tabClicks = {node: 0, service: 0, live: 0, desired: 0};</script>
          ${nodeMarkup}
          <div class="application-node-info">
            <button role="tab" id="live" class="${!desiredInitially ? 'tabs__tab--selected' : ''}" onclick="tabClicks.live++">Live Manifest</button>
            <button role="tab" id="desired" class="${desiredInitially ? 'tabs__tab--selected' : ''}" onclick="tabClicks.desired++; this.classList.add('tabs__tab--selected'); document.querySelector('#live').classList.remove('tabs__tab--selected'); document.querySelector('#raw').textContent = '/api/health/'">Desired Manifest</button>
            <pre id="raw" class="application-node-info__manifest--raw">${desiredInitially ? '/api/health/' : '/api/live/'}</pre>
          </div><script src="/coach/assets/coach.js"></script></body></html>`});
      }
      if (url.pathname === '/argocd/api/v1/applications/shop-web-prod/resource-tree') {
        return route.fulfill({json: {nodes: [{group: '', kind: 'Deployment', namespace: 'applications', name: 'django'}]}});
      }
      if (url.pathname === '/coach/learning/api/sessions/session-1/actions') {
        const action = route.request().postDataJSON();
        if (action.type === 'target_visited' && action.details.target === 'resource.manifest') {
          current = {...current, next_check: {...current.next_check, available: true}};
          fixturePage.setView(current);
        }
        return route.fulfill({json: {session: current, evaluation: {accepted: true}}});
      }
      return route.fallback();
    });
    try {
      const node = selectedNode ? '%2FDeployment%2Fapplications%2Fdjango%2F0' :
        '%2FService%2Fapplications%2Fdjango%2F0';
      await page.goto(`http://lab.test/argocd/applications/argocd/shop-web-prod?view=tree&node=${node}&tab=manifest`);
      await page.locator('#argocd-coach-host [data-action="begin"]').click();
      await page.locator('#argocd-coach-host [data-action="advance"]').click();
      if (desiredInitially) assert.equal(await page.locator('#argocd-coach-host .panel[data-doing]').count(), 0);
      if (expectLook) {
        await page.locator('#argocd-coach-host .demo-explanation span').first().filter({hasText: 'Look'}).waitFor();
        assert.equal(await page.locator('#argocd-coach-host .demo-explanation p').first().textContent(),
          'Look for readinessProbe.httpGet.path in the Desired manifest.');
        await page.locator('#argocd-coach-host [data-action="advance"]').click();
      }
      await page.locator('#argocd-coach-host .demo-explanation span').first().filter({hasText: 'Found'}).waitFor();
      assert.deepEqual(await page.evaluate(() => window.tabClicks),
        {node: selectedNode || duplicateName ? 0 : 1, service: 0,
          live: 0, desired: desiredInitially ? 0 : 1});
      assert.equal(new URL(page.url()).searchParams.get('node'), '/Deployment/applications/django/0');
      assert.equal(await page.locator('#argocd-coach-host .demo-explanation p').first().textContent(), '/api/health/');
    } finally { await browser.close(); }
  });
}

test('condition cue points to the matching error before reporting its value', {timeout: 20000}, async () => {
  const fixturePage = await fixture('demonstration');
  const {browser, page, actions} = fixturePage;
  fixturePage.setView({...session('demonstration'),
    scenario: {id: 'sops-global-mac-mismatch', title: 'SOPS global MAC mismatch', level: 4},
    checks_passed: 1, checks_total: 2,
    next_check: {id: 'cause', target: 'app.conditions', where: 'Conditions',
      demo: {what: 'Open shop-web-prod → Conditions; read the SOPS integrity field in the error.',
        look: 'Look for the integrity field named in the Conditions error.',
        why: 'Conditions names the field that failed validation.'},
      demonstration_answer: 'sops.mac', available: true},
  });
  await page.route('**/argocd/applications/argocd/shop-web-prod', route =>
    route.fulfill({contentType: 'text/html', body: `<!doctype html><html><body>
      <section class="application-conditions" style="width: 700px; padding: 30px">
        <p>Manifest generation failed</p><span id="integrity-error">sops.mac integrity check failed</span>
      </section><script src="/coach/assets/coach.js"></script></body></html>`}));
  try {
    await page.goto('http://lab.test/argocd/applications/argocd/shop-web-prod');
    await page.clock.install();
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    await page.locator('#argocd-coach-host [data-action="advance"]').click();
    const phase = page.locator('#argocd-coach-host .demo-explanation span').first();
    await phase.filter({hasText: 'Look'}).waitFor();
    assert.equal(await page.locator('#argocd-coach-host .demo-explanation p').first().textContent(),
      'Look for the integrity field named in the Conditions error.');
    assert.equal(actions.some(action => action.type === 'evidence_check_answered'), false);
    for (let attempt = 0; attempt < 14 && await phase.textContent() !== 'Found'; attempt += 1) {
      await page.clock.runFor(500);
    }
    assert.equal(await phase.textContent(), 'Found');
    assert.equal(await page.locator('#argocd-coach-host .demo-explanation p').first().textContent(), 'sops.mac');
    const widths = await page.evaluate(() => ({
      condition: document.querySelector('.application-conditions').getBoundingClientRect().width,
      highlight: document.querySelector('#argocd-coach-host').shadowRoot
        .querySelector('.spotlight').getBoundingClientRect().width,
    }));
    assert.ok(widths.highlight < widths.condition / 2, JSON.stringify(widths));
    assert.equal(actions.some(action => action.type === 'evidence_check_answered'), false);
  } finally { await browser.close(); }
});

test('demo stops after one ineffective Desired Manifest click', {timeout: 15000}, async () => {
  const fixturePage = await fixture('demonstration');
  const {browser, page} = fixturePage;
  fixturePage.setView({...session('demonstration'),
    scenario: {id: 'console-resources', title: 'Read a resource', level: 1},
    next_check: {id: 'readiness-path', target: 'resource.manifest', where: 'Desired manifest',
      demonstration_answer: '/api/health/', available: false}});
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/argocd/applications/argocd/shop-web-prod') {
      return route.fulfill({contentType: 'text/html', body: `<!doctype html><html><body>
        <script>window.desiredClicks = 0;</script>
        <div class="application-resource-tree__node-title">django</div>
        <div class="application-node-info">
          <button class="tabs__tab--selected">Live Manifest</button>
          <button onclick="desiredClicks++">Desired Manifest</button>
          <pre class="application-node-info__manifest--raw">/api/live/</pre>
        </div><script src="/coach/assets/coach.js"></script></body></html>`});
    }
    if (url.pathname === '/argocd/api/v1/applications/shop-web-prod/resource-tree') {
      return route.fulfill({json: {nodes: [{group: '', kind: 'Deployment', namespace: 'applications', name: 'django'}]}});
    }
    return route.fallback();
  });
  try {
    await page.goto('http://lab.test/argocd/applications/argocd/shop-web-prod?view=tree&node=%2FDeployment%2Fapplications%2Fdjango%2F0&tab=manifest');
    await page.clock.install();
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    await page.locator('#argocd-coach-host [data-action="advance"]').click();
    const failure = page.locator('#argocd-coach-host [role="status"]')
      .filter({hasText: /could not open Desired Manifest/});
    for (let attempt = 0; attempt < 20 && !await failure.isVisible(); attempt += 1) {
      await page.clock.runFor(500);
    }
    await failure.waitFor();
    assert.equal(await page.evaluate(() => window.desiredClicks), 1);
    assert.equal(await page.locator('#argocd-coach-host [data-action="advance"]').isVisible(), false);
  } finally { await browser.close(); }
});

test('demo stops after one ineffective History click', {timeout: 15000}, async () => {
  const {browser, page} = await fixture('demonstration');
  await page.route('**/argocd/applications/argocd/shop-web-prod', route =>
    route.fulfill({contentType: 'text/html', body: `<!doctype html><html><body>
      <script>window.historyClicks = 0;</script>
      <button onclick="historyClicks++">History and Rollback</button>
      <script src="/coach/assets/coach.js"></script></body></html>`}));
  try {
    await page.goto('http://lab.test/argocd/applications/argocd/shop-web-prod');
    await page.clock.install();
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    await page.locator('#argocd-coach-host [data-action="advance"]').click();
    const failure = page.locator('#argocd-coach-host [role="status"]')
      .filter({hasText: /could not open History and Rollback/});
    for (let attempt = 0; attempt < 20 && !await failure.isVisible(); attempt += 1) {
      await page.clock.runFor(500);
    }
    await failure.waitFor();
    assert.equal(await page.evaluate(() => window.historyClicks), 1);
    assert.equal(await page.locator('#argocd-coach-host [data-action="advance"]').isVisible(), false);
  } finally { await browser.close(); }
});

test('unhealthy release demo reads Health before naming its status', {timeout: 15000}, async () => {
  const fixturePage = await fixture('demonstration', true);
  const {browser, page} = fixturePage;
  fixturePage.setView({...session('demonstration'),
    scenario: {id: 'console-unhealthy-version', title: 'Find the release still serving', level: 1},
    health: 'Progressing', fixed: false, checks_passed: 1, checks_total: 4,
    next_check: {id: 'health', target: 'app.header', where: 'Application details header',
      demonstration_answer: 'Progressing', available: true,
      learning: 'Argo reports Progressing health. The rollout has not become ready; inspect both Pods in Tree.',
      demo: {what: 'Open shop-web-prod; read Health in the Application header.',
        look: 'Look for Health in the Application header.',
        why: 'The health badge shows whether the rollout is ready; compare Pods after reading it.'}},
  });
  await page.route('**/argocd/applications/argocd/shop-web-prod**', route =>
    route.fulfill({contentType: 'text/html', body: `<!doctype html><html><body>
      <span id="health">Progressing</span><script src="/coach/assets/coach.js"></script></body></html>`}));
  try {
    await page.goto('http://lab.test/argocd/applications/argocd/shop-web-prod?view=tree');
    await page.clock.install();
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    const panel = page.locator('#argocd-coach-host .demo-step');
    assert.doesNotMatch(await panel.innerText(), /Progressing/);
    await page.locator('#argocd-coach-host [data-action="advance"]').click();
    const phase = panel.locator('.demo-explanation span').first();
    for (let attempt = 0; attempt < 12 && await phase.textContent() !== 'Look'; attempt += 1)
      await page.clock.runFor(500);
    assert.equal(await phase.textContent(), 'Look');
    assert.doesNotMatch(await panel.innerText(), /Progressing/);
    for (let attempt = 0; attempt < 16 && await phase.textContent() !== 'Found'; attempt += 1)
      await page.clock.runFor(500);
    assert.equal(await phase.textContent(), 'Found');
    assert.equal(await panel.locator('.demo-explanation p').first().textContent(), 'Progressing');
    assert.match(await panel.locator('.demo-explanation p').last().textContent(), /rollout has not become ready/);
    const frame = await page.locator('#argocd-coach-host .spotlight').last().boundingBox();
    const health = await page.locator('#health').boundingBox();
    assert.ok(frame.y <= health.y && frame.y + frame.height >= health.y + health.height);
  } finally { await browser.close(); }
});

test('unhealthy release demo compares the ready and unready Pods', {timeout: 15000}, async () => {
  const fixturePage = await fixture('demonstration', true);
  const {browser, page} = fixturePage;
  fixturePage.setView({...session('demonstration'),
    scenario: {id: 'console-unhealthy-version', title: 'Find the release still serving', level: 1},
    health: 'Progressing', fixed: false, checks_passed: 2, checks_total: 4,
    next_check: {id: 'ready-pod', target: 'app.tree', where: 'Application resource tree',
      demonstration_answer: '1', available: true,
      learning: 'One Pod is Healthy and the new Pod is unready. The Service keeps routing to the older ready Pod.',
      demo: {what: 'Open Tree; compare the Pods under Deployment/django.',
        look: 'Look for health indicators on the Pods under Deployment/django.',
        why: 'Pod health shows which replicas can receive Service/django traffic.'}},
  });
  await page.route('**/argocd/api/v1/applications/shop-web-prod/resource-tree**', route =>
    route.fulfill({json: {nodes: [
      {kind: 'Pod', name: 'django-migrate-job-aaaaa', health: {status: 'Healthy'}},
      {kind: 'Pod', name: 'django-7654321abc-ccccc', health: {status: 'Progressing'}},
      {kind: 'Pod', name: 'django-123456789a-bbbbb', health: {status: 'Healthy'}},
    ]}}));
  await page.route('**/argocd/applications/argocd/shop-web-prod**', route =>
    route.fulfill({contentType: 'text/html', body: `<!doctype html><html><body>
      <span id="job-pod" class="application-resource-tree__node-title" style="position:absolute;left:500px;top:180px">django-migrate-job-aaaaa</span>
      <span id="new-pod" class="application-resource-tree__node-title" style="position:absolute;left:500px;top:250px">django-7654321abc-ccccc</span>
      <span id="old-pod" class="application-resource-tree__node-title" style="position:absolute;left:500px;top:320px">django-123456789a-bbbbb</span>
      <script src="/coach/assets/coach.js"></script></body></html>`}));
  try {
    await page.goto('http://lab.test/argocd/applications/argocd/shop-web-prod?view=tree');
    await page.clock.install();
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    assert.doesNotMatch(await page.locator('#argocd-coach-host .demo-step').innerText(), /One Pod is Healthy|new Pod is unready/);
    await page.locator('#argocd-coach-host [data-action="advance"]').click();
    const phase = page.locator('#argocd-coach-host .demo-explanation span').first();
    for (let attempt = 0; attempt < 16 && await phase.textContent() !== 'Found'; attempt += 1)
      await page.clock.runFor(500);
    assert.equal(await phase.textContent(), 'Found');
    assert.equal(await page.locator('#argocd-coach-host .demo-explanation p').first().textContent(),
      'One Healthy Pod; the new Pod is unready.');
    assert.match(await page.locator('#argocd-coach-host .demo-explanation p').last().textContent(), /Service keeps routing/);
    const frame = await page.locator('#argocd-coach-host .spotlight').last().boundingBox();
    for (const id of ['new-pod', 'old-pod']) {
      const pod = await page.locator('#' + id).boundingBox();
      assert.ok(frame.y <= pod.y && frame.y + frame.height >= pod.y + pod.height);
    }
  } finally { await browser.close(); }
});

test('unhealthy release demo distinguishes the newest sync from the serving revision', {timeout: 15000}, async () => {
  const fixturePage = await fixture('demonstration', true);
  const {browser, page} = fixturePage;
  fixturePage.setView({...session('demonstration'),
    scenario: {id: 'console-unhealthy-version', title: 'Find the release still serving', level: 1},
    health: 'Progressing', revision: 'e4a0e601234567890abcdef1234567890abcdef1',
    fixed: false, checks_passed: 3, checks_total: 4,
    next_check: {id: 'revision', target: 'app.history', where: 'History and Rollback',
      demonstration_answer: '0179d2d1234567890abcdef1234567890abcdef1', available: true,
      learning: 'The top entry records Argo applying e4a0e60, but its new Pod is unready. Service/django still routes to the older Healthy Pod, so the second distinct revision, 0179d2d, is serving.',
      demo: {what: 'Open History and Rollback; compare the newest and previous distinct Revision entries.',
        look: 'Look for Revision and Deployed At in the newest entry, then compare the next distinct entry.',
        why: 'Deployed At records Argo applying a revision; Pod readiness tells you whether it serves traffic.'}},
  });
  await page.route('**/argocd/applications/argocd/shop-web-prod**', route =>
    route.fulfill({contentType: 'text/html', body: `<!doctype html><html><body>
      <div class="application-deployment-history" style="margin:100px 0 0 470px;width:500px">
        <div style="height:110px"><span>Revision:</span> <span id="unready-revision">e4a0e60</span></div>
        <div style="height:110px"><span>Revision:</span> <span id="serving-revision">0179d2d</span></div>
      </div><script src="/coach/assets/coach.js"></script></body></html>`}));
  try {
    await page.goto('http://lab.test/argocd/applications/argocd/shop-web-prod?view=tree&rollback=0');
    await page.clock.install();
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    assert.doesNotMatch(await page.locator('#argocd-coach-host .demo-step').innerText(), /e4a0e60|0179d2d/);
    await page.locator('#argocd-coach-host [data-action="advance"]').click();
    await page.clock.runFor(2000);
    const phase = page.locator('#argocd-coach-host .demo-explanation span').first();
    assert.equal(await phase.textContent(), 'Look');
    assert.match(await page.locator('#argocd-coach-host .demo-explanation p').first().textContent(), /Deployed At/);
    assert.doesNotMatch(await page.locator('#argocd-coach-host .demo-step').innerText(), /e4a0e60|0179d2d/);
    const topHighlight = await page.locator('#argocd-coach-host .spotlight').last().boundingBox();
    const serving = await page.locator('#serving-revision').boundingBox();
    const unready = await page.locator('#unready-revision').boundingBox();
    assert.ok(Math.abs(topHighlight.y + topHighlight.height / 2 - (unready.y + unready.height / 2)) < 20);
    for (let attempt = 0; attempt < 16 && await phase.textContent() !== 'Found'; attempt += 1)
      await page.clock.runFor(500);
    assert.equal(await phase.textContent(), 'Found');
    assert.equal(await page.locator('#argocd-coach-host .demo-explanation p').first().textContent(),
      'Serving revision: 0179d2d');
    assert.match(await page.locator('#argocd-coach-host .demo-explanation p').last().textContent(), /top entry records Argo applying e4a0e60/);
    const highlighted = await page.locator('#argocd-coach-host .spotlight').last().boundingBox();
    const highlightedCenter = highlighted.y + highlighted.height / 2;
    assert.ok(Math.abs(highlightedCenter - (serving.y + serving.height / 2)) < 20);
    assert.ok(Math.abs(highlightedCenter - (unready.y + unready.height / 2)) > 50);
  } finally { await browser.close(); }
});

test('already-open History goes straight to evidence without Doing', {timeout: 45000}, async () => {
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
    assert.deepEqual(await panel.locator('.demo-explanation span').allTextContents(), ['Next', 'Why']);
    assert.equal(await panel.getAttribute('data-doing'), null);
    assert.equal(await panel.locator('[data-demo-timer]').isVisible(), false);
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
      ['abc1234', 'This commit is deployed.']);
    assert.equal(await panel.getAttribute('data-doing'), null);
    assert.ok(Number(await page.locator('#argocd-coach-host [data-demo-seconds]').innerText()) >= 14.5);
  } finally { await browser.close(); }
});

test('Advance skips reading beats while Doing has no timer', {timeout: 15000}, async () => {
  const {browser, page, actions} = await fixture('demonstration', 'closed');
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

test('demo pause holds the current reading beat and survives a page reload', {timeout: 20000}, async () => {
  const {browser, page} = await fixture('demonstration', true);
  try {
    await page.clock.install();
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    await page.clock.runFor(4000);
    await page.locator('#argocd-coach-host .panel [data-action="pause-demo"]').click();
    const remaining = Number(await page.locator('#argocd-coach-host [data-demo-seconds]').innerText());
    await page.clock.runFor(20000);
    assert.equal(await page.locator('#argocd-coach-host .demo-explanation span').first().textContent(), 'Next');
    assert.ok(Math.abs(Number(await page.locator('#argocd-coach-host [data-demo-seconds]').innerText()) - remaining) < 0.2);
    assert.equal(await page.locator('#argocd-coach-host [data-action="advance"]').isDisabled(), true);

    await page.reload();
    await page.locator('#argocd-coach-host .panel [data-action="pause-demo"]').waitFor();
    assert.equal(await page.locator('#argocd-coach-host .panel [data-action="pause-demo"]').textContent(), 'Resume');
    await page.clock.runFor(20000);
    assert.equal(await page.locator('#argocd-coach-host .demo-explanation span').first().textContent(), 'Next');
    await page.locator('#argocd-coach-host .panel [data-action="pause-demo"]').click();
    assert.equal(await page.locator('#argocd-coach-host [data-action="advance"]').isDisabled(), false);
    await page.locator('#argocd-coach-host [data-action="advance"]').click();
    for (let attempt = 0; attempt < 16 &&
         await page.locator('#argocd-coach-host .demo-explanation span').first().textContent() !== 'Found'; attempt += 1) {
      await page.clock.runFor(500);
    }
    assert.equal(await page.locator('#argocd-coach-host .demo-explanation span').first().textContent(), 'Found');
  } finally { await browser.close(); }
});

test('hiding the tab freezes the demo countdown until it is visible again', {timeout: 15000}, async () => {
  const {browser, page} = await fixture('demonstration', true);
  try {
    await page.clock.install();
    await page.locator('#argocd-coach-host [data-action="begin"]').click();
    await page.clock.runFor(3000);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable: true, value: true});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const remaining = Number(await page.locator('#argocd-coach-host [data-demo-seconds]').innerText());
    await page.clock.runFor(20000);
    assert.ok(Math.abs(Number(await page.locator('#argocd-coach-host [data-demo-seconds]').innerText()) - remaining) < 0.2);
    assert.equal(await page.locator('#argocd-coach-host .demo-explanation span').first().textContent(), 'Next');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable: true, value: false});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(remaining * 1000 + 100);
    for (let attempt = 0; attempt < 16 &&
         await page.locator('#argocd-coach-host .demo-explanation span').first().textContent() !== 'Found'; attempt += 1) {
      await page.clock.runFor(500);
    }
    assert.equal(await page.locator('#argocd-coach-host .demo-explanation span').first().textContent(), 'Found');
  } finally { await browser.close(); }
});

test('launcher keeps Argo CD closed until the scenario is ready, then starts the briefing countdown', {timeout: 30000}, async () => {
  const browser = await launchBrowser();
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
  const browser = await launchBrowser();
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
      message: 'Run complete.', total: null, fixed: true, durable: true,
      assistance: {hints: 1, show_me: 0},
      practice_notes: ['No unsafe operation was observed.'],
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
    assert.equal(await page.locator('#argocd-coach-host .debrief-outcome').textContent(), 'Release evidence verified.');
    assert.match(await page.locator('#argocd-coach-host .debrief-practice').innerText(), /No unsafe operation/);
    assert.equal(await page.locator('#argocd-coach-host .debrief-assistance').textContent(),
      'Help used: 1 hint · 0 demonstrations');
    assert.equal(await page.locator('#argocd-coach-host .debrief-steps li').first()
      .evaluate(element => getComputedStyle(element).borderWidth), '0px');
    assert.equal(await page.locator('#argocd-coach-host [data-action="replay"]').count(), 1);
    assert.equal(await page.locator('#argocd-coach-host a[href^="/?scenario="]').count(), 0);
    const modal = await page.locator('#argocd-coach-host .debrief-modal').boundingBox();
    assert.ok(Math.abs(modal.x + modal.width / 2 - 600) < 2, JSON.stringify(modal));
    assert.ok(Math.abs(modal.y + modal.height / 2 - 375) < 2, JSON.stringify(modal));
  } finally { await browser.close(); }
});

test('replay starts the same mission in every mode with a fresh key', {timeout: 30000}, async () => {
  for (const mode of ['demonstration', 'guided', 'challenge']) {
    const fixturePage = await fixture(mode);
    const {browser, page} = fixturePage;
    try {
      const completed = {...session(mode),
        scenario: {id: 'missing-configmap', title: 'Shop pods won\'t start', level: 2},
        environment: 'staging', seed: 111, state: 'COMPLETED',
        feedback: {total: 82, fixed: true, durable: true, debrief_steps: []}};
      fixturePage.setView(completed);
      const requests = [];
      await page.route('**/coach/learning/api/runs', route => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({status: 202, json: {run: {id: 'run-2'}, session: {
          ...completed, session_id: 'session-2', run_id: 'run-2', seed: 222,
          state: 'CREATED', feedback: null, connection_token: 'new-token',
        }}});
      });
      await page.route('**/coach/learning/api/runs/run-2', route => route.fulfill({json: {
        id: 'run-2', state: 'RESETTING', updated_at: '2026-10-05T12:00:01Z',
      }}));
      await page.route('**/preparing.html', route => route.fulfill({contentType: 'text/html', body: preparationPage}));
      await page.reload();
      const replay = page.locator('#argocd-coach-host [data-action="replay"]');
      await replay.waitFor();
      assert.equal(await replay.textContent(), 'Replay with new key');
      await replay.click();
      await page.waitForURL('http://lab.test/preparing.html');
      assert.deepEqual(requests, [{
        scenario: 'missing-configmap', mode, environment: 'staging', replace_existing: true,
      }]);
      assert.equal(await page.locator('#mission-name').textContent(), 'Shop pods won\'t start');
      assert.deepEqual(await page.evaluate(() => ({
        pending: JSON.parse(sessionStorage.getItem('argo-coach:preparing')),
        initial: JSON.parse(sessionStorage.getItem('argo-coach:initial-view:session-2')),
        oldHandoff: sessionStorage.getItem('argo-coach:handoff'),
        oldView: sessionStorage.getItem('argo-coach:initial-view:session-1'),
      })), {
        pending: {run_id: 'run-2', session_id: 'session-2', token: 'new-token', mode,
          title: 'Shop pods won\'t start'},
        initial: {...completed, session_id: 'session-2', run_id: 'run-2', seed: 222,
          state: 'CREATED', feedback: null},
        oldHandoff: null, oldView: null,
      });
    } finally { await browser.close(); }
  }
});

test('replay failure stays on the debrief and allows another attempt', {timeout: 15000}, async () => {
  const fixturePage = await fixture('guided');
  const {browser, page} = fixturePage;
  try {
    fixturePage.setView({...session('guided'), state: 'COMPLETED',
      feedback: {total: null, fixed: true, durable: true, debrief_steps: []}});
    await page.route('**/coach/learning/api/runs', route => route.fulfill({
      status: 503, json: {error: 'Lab temporarily unavailable'},
    }));
    await page.reload();
    const replay = page.locator('#argocd-coach-host [data-action="replay"]');
    await replay.click();
    await page.locator('#argocd-coach-host .debrief-modal [role="alert"]').waitFor();
    assert.equal(await page.locator('#argocd-coach-host .debrief-modal [role="alert"]').textContent(),
      'Lab temporarily unavailable');
    assert.equal(await replay.isEnabled(), true);
    assert.equal(new URL(page.url()).pathname, '/argocd/applications');
  } finally { await browser.close(); }
});

test('debrief advances to the next scenario before moving to the next level', {timeout: 15000}, async () => {
  const fixturePage = await fixture('guided');
  const {browser, page} = fixturePage;
  const feedback = {total: null, fixed: true, durable: true, debrief_steps: []};
  const nextLink = page.locator('#argocd-coach-host a', {hasText: 'Next scenario'});
  try {
    await page.route('**/coach/learning/api/catalog', route => route.fulfill({json: {
      levels: [{level: 1, title: 'Console orientation'}, {level: 2, title: 'Read the tree, fix in git'}],
      scenarios: [
        {id: 'console-orientation', title: 'Find the deployed revision', level: 1, brief: 'Find the release.'},
        {id: 'console-unhealthy-version', title: 'Check an unhealthy release', level: 1, brief: 'Find the version.'},
        {id: 'console-history', title: 'Read the release history', level: 1, brief: 'Find the revision.'},
        {id: 'missing-configmap', title: 'Missing ConfigMap', level: 2, brief: 'Repair the deployment.'},
      ],
    }}));

    for (const {current, level, following, nextLevel} of [
      {current: 'console-orientation', level: 1, following: 'console-unhealthy-version', nextLevel: 1},
      {current: 'console-history', level: 1, following: 'missing-configmap', nextLevel: 2},
    ]) {
      fixturePage.setView({...session('guided'), scenario: {id: current, title: current, level},
        state: 'COMPLETED', next_scenario: following, feedback});
      await page.reload();
      await nextLink.waitFor();
      assert.equal(await nextLink.getAttribute('href'),
        `/?scenario=${following}&mode=guided&environment=prod`);
      await nextLink.click();
      await page.waitForURL(`http://lab.test/?scenario=${following}&mode=guided&environment=prod`);
      assert.equal(await page.locator('#scenario').inputValue(), following);
      assert.equal(await page.locator('.curriculum-level.is-open').getAttribute('data-level'), String(nextLevel));
      await page.goto('http://lab.test/argocd/applications');
    }

    fixturePage.setView({...session('guided'), scenario: {id: 'repo-auth', title: 'Repository authentication', level: 5},
      state: 'COMPLETED', next_scenario: null, feedback});
    await page.reload();
    await page.locator('#argocd-coach-host .debrief-modal').waitFor();
    assert.equal(await nextLink.count(), 0);
  } finally { await browser.close(); }
});

test('challenge debrief reveals score components and the reference finding', {timeout: 15000}, async () => {
  const fixturePage = await fixture('challenge');
  const {browser, page} = fixturePage;
  try {
    fixturePage.setView({...session('challenge'),
      scenario: {id: 'missing-configmap', title: 'Shop pods are failing to start', level: 2},
      state: 'COMPLETED', feedback: {
      total: 82, fixed: true, durable: false,
      breakdown: {remediation: 20, console_evidence: 23, diagnosis: 19, operational_practice: 10, efficiency: 10},
      truth: {cause: 'A missing ConfigMap', evidence: 'CreateContainerConfigError', fix: 'Restore the reference in Git'},
      practice_notes: ['The fix is not reflected in the deployed Git revision.'],
      debrief_steps: [],
    }});
    await page.reload();
    await page.locator('#argocd-coach-host .debrief-modal').waitFor();
    assert.match(await page.locator('#argocd-coach-host .debrief-outcome').textContent(), /repair is not in the deployed Git revision/);
    const score = page.locator('#argocd-coach-host .debrief-detail').first();
    await score.locator('summary').click();
    assert.match(await score.innerText(), /Remediation\s+20 \/ 35/);
    const reference = page.locator('#argocd-coach-host .debrief-detail').nth(1);
    await reference.locator('summary').click();
    assert.match(await reference.innerText(), /Cause\s+A missing ConfigMap/);
    assert.match(await page.locator('#argocd-coach-host .debrief-practice').innerText(), /not reflected/);
  } finally { await browser.close(); }
});

test('unhealthy Level 1 mission ends with an evidence debrief', {timeout: 15000}, async () => {
  const fixturePage = await fixture('demonstration');
  const {browser, page} = fixturePage;
  try {
    fixturePage.setView({...session('demonstration'),
      scenario: {id: 'console-unhealthy-version', title: 'Check an unhealthy release', level: 1},
      state: 'COMPLETED', fixed: false, health: 'Progressing', feedback: {
        total: null, fixed: false, durable: false,
        debrief_steps: [{action: 'We read the Application header.', finding: 'Argo reports Progressing health.'}],
      }});
    await page.reload();
    await page.locator('#argocd-coach-host .debrief-modal').waitFor();
    assert.equal(await page.locator('#argocd-coach-host .debrief-outcome').textContent(),
      'Unhealthy release evidence verified.');
    assert.match(await page.locator('#argocd-coach-host .debrief-steps').innerText(),
      /We read the Application header\.\s+Argo reports Progressing health\./);
  } finally { await browser.close(); }
});
