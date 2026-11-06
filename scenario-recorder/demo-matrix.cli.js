async (page) => {
  const baseURL = await page.evaluate(() => location.origin);
  const catalog = await page.evaluate(async () => {
    const response = await fetch('/coach/learning/api/catalog');
    if (!response.ok) throw new Error(`catalog returned ${response.status}`);
    const data = await response.json();
    return data.scenarios.map(({id, level}) => [id, level]);
  });
  const selection = await page.evaluate(() => Object.fromEntries(new URL(location.href).searchParams));
  const environment = selection.environment || 'prod';
  const autoplay = selection.autoplay === '1';
  if (!['prod', 'staging'].includes(environment)) throw new Error(`Unknown environment ${environment}`);
  const scenarios = catalog.filter(([id, level]) =>
    (!selection.scenario || selection.scenario === id) &&
    (!selection.level || Number(selection.level) === level));
  if (!scenarios.length) throw new Error(`No missions match ${JSON.stringify(selection)}`);
  const results = [];
  for (const [scenario, level] of scenarios) {
    const observations = [];
    let gitSourceSeen = false;
    let gitCommit = '';
    let outcome = 'timed out';
    try {
      await page.goto(baseURL + '/', {waitUntil: 'domcontentloaded'});
      await page.locator(`#scenario option[value="${scenario}"]`).waitFor({state: 'attached'});
      await page.locator('#scenario').selectOption(scenario);
      await page.locator('#environment').selectOption(environment);
      await page.locator('#start').click();
      await page.waitForFunction(() => {
        const button = document.querySelector('#argocd-coach-host')?.shadowRoot?.querySelector('[data-action="begin"]');
        return button && !button.disabled;
      }, null, {timeout: 600000});
      if (!autoplay) await page.locator('#argocd-coach-host [data-action="begin"]').click();
      for (let turn = 0; turn < 600; turn += 1) {
        let state;
        try {
          state = await page.evaluate(async () => {
            const handoff = JSON.parse(sessionStorage.getItem('argo-coach:handoff') || 'null');
            const root = document.querySelector('#argocd-coach-host')?.shadowRoot;
            const response = await fetch(`/coach/learning/api/sessions/${handoff.session}`, {
              headers: {Authorization: `Bearer ${handoff.token}`},
            });
            const session = await response.json();
            const advance = root?.querySelector('[data-action="advance"]');
            return {
              url: location.href,
              check: session.next_check?.id,
              available: session.next_check?.available,
              revision: session.revision,
              state: session.state,
              message: root?.querySelector('.message.error[role="status"]')?.textContent,
              debrief: Boolean(root?.querySelector('#debrief-title')),
              canAdvance: Boolean(advance && advance.getBoundingClientRect().width > 0 &&
                advance.getBoundingClientRect().height > 0),
            };
          });
        } catch (error) {
          if (/Execution context was destroyed|navigation/.test(error.message)) {
            await page.waitForTimeout(500);
            continue;
          }
          throw error;
        }
        if (/\/gitea\/remotelab\/django-app\/src\/commit\/[0-9a-f]{40}\//.test(state.url)) gitSourceSeen = true;
        const commitView = state.url.match(/\/gitea\/remotelab\/django-app\/commit\/([0-9a-f]{40})(?:[?#]|$)/);
        if (commitView) gitCommit = commitView[1];
        if (observations.at(-1)?.check !== state.check || state.message || state.debrief) {
          observations.push({check: state.check, available: state.available,
            state: state.state, message: state.message, url: state.url});
        }
        if (state.debrief) {
          const runState = await page.evaluate(async () => {
            const handoff = JSON.parse(sessionStorage.getItem('argo-coach:handoff'));
            const response = await fetch(`/coach/learning/api/runs/${handoff.run}`);
            return (await response.json()).state;
          });
          outcome = runState === 'COMPLETED' ? 'completed' : `debrief with run ${runState}`;
          if (scenario === 'missing-configmap' && outcome === 'completed' &&
              (!gitSourceSeen || !gitCommit || gitCommit !== state.revision)) {
            outcome = `Git demonstration incomplete: source=${gitSourceSeen}, commit=${gitCommit}, deployed=${state.revision}`;
          }
          break;
        }
        if (state.message) { outcome = 'demo error'; break; }
        if (state.state === 'FAILED' || state.state === 'ABORTED') {
          outcome = state.state;
          break;
        }
        if (state.canAdvance && !autoplay) {
          await page.locator('#argocd-coach-host [data-action="advance"]').click({timeout: 1000, noWaitAfter: true})
            .catch(() => {});
        }
        await page.waitForTimeout(1000);
      }
    } catch (error) {
      outcome = `runner error: ${error.message.slice(0, 250)}`;
    }
    results.push({scenario, level, environment, outcome,
      checks: [...new Set(observations.map(item => item.check).filter(Boolean))],
      last: observations.at(-1)});
  }
  if (results.some(result => result.outcome !== 'completed')) {
    throw new Error(`Demo matrix failed: ${JSON.stringify(results)}`);
  }
  return results;
}
