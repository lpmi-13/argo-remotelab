(function initialize() {
  // The first authenticated Argo page is replaced after login. Starting its
  // countdown there would consume the briefing before the visible page loads.
  if (window.ArgoCoachBootstrap?.authPending) {
    addEventListener('argo-coach:auth-failed', initialize, {once: true});
    return;
  }
  const config = JSON.parse(sessionStorage.getItem('argo-coach:handoff') || 'null');
  if (!config?.session || !config?.token) return;
  const service = '/coach/learning';
  const sessionPath = `/api/sessions/${encodeURIComponent(config.session)}`;
  const startedKey = `argo-coach:started:${config.session}`;
  const initialViewKey = `argo-coach:initial-view:${config.session}`;
  const seqKey = `argo-coach:sequence:${config.session}`;
  const collapsedKey = `argo-coach:collapsed:${config.session}`;
  const demoPatchKey = `argo-coach:demo-patch:${config.session}`;
  const demoFixKey = `argo-coach:demo-fix-started:${config.session}`;
  const demoNarrationKey = `argo-coach:demo-narration:${config.session}`;
  let sequence = Number(sessionStorage.getItem(seqKey) || 0);
  let view = JSON.parse(sessionStorage.getItem(initialViewKey) || 'null');
  if (view?.session_id !== config.session) view = null;
  let message = '';
  let error = false;
  let briefOpen = !sessionStorage.getItem(startedKey);
  let noteOpen = false;
  let collapsed = sessionStorage.getItem(collapsedKey) === 'true';
  let nativeOverlayOpen = false;
  let autoCollapsed = false;
  let hintVisible = false;
  let demoBusy = false;
  let demoFixStarted = sessionStorage.getItem(demoFixKey) === 'true';
  let demoStopped = false;
  let demoTimer = null;
  let demoCountdown = null;
  let demoCountdownTicker = null;
  const briefDuration = 15000;
  let briefRemaining = briefDuration;
  let briefDeadline = null;
  let briefTimer = null;
  let briefTicker = null;
  let pointerTimer = null;
  let demoPatch = JSON.parse(sessionStorage.getItem(demoPatchKey) || 'null');
  let demoNarration = JSON.parse(sessionStorage.getItem(demoNarrationKey) || 'null');
  let recentLearning = null;
  let evidenceMapOpen = false;
  let terminalOpen = false;
  let terminalMinimized = false;
  let checkInOpen = false;
  let sending = Promise.resolve();
  let stream = null;
  let lastStreamMessage = 0;
  let pollTimer = null;
  let reconnectTimer = null;

  const host = document.createElement('div');
  host.id = 'argocd-coach-host';
  document.documentElement.append(host);
  const shadow = host.attachShadow({mode: 'open'});
  for (const file of ['ui/tokens.css', 'ui/coach.css']) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/coach/assets/${file}`;
    shadow.append(link);
  }
  const root = document.createElement('div');
  shadow.append(root);
  const dockRoot = document.createElement('div');
  shadow.append(dockRoot);
  const pointer = document.createElement('div');
  pointer.className = 'coach-pointer';
  pointer.setAttribute('aria-hidden', 'true');
  pointer.innerHTML = '<svg viewBox="0 0 32 40" focusable="false"><path d="M3 2v29l7-7 5 13 6-3-5-12 11-1Z"/></svg><span>Coach</span>';
  shadow.append(pointer);
  window.ArgoCoachTheme?.followTheme(host);

  const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const statusClass = value => String(value || 'unknown').toLowerCase();
  const ready = () => ['READY', 'INVESTIGATING', 'FIXED'].includes(view?.state);
  const stepClock = new window.GuidedStepClock({
    isPaused: () => document.hidden || briefOpen || noteOpen || collapsed ||
      !view || !['READY', 'INVESTIGATING', 'FIXED'].includes(view.state),
    isQuiet: () => !shadow.activeElement?.matches('input, textarea'),
    onDue: stepId => {
      if (stepId === currentStepId()) { checkInOpen = true; render(); }
    },
  });

  function currentStepId() {
    if (view?.mode !== 'guided' || view.feedback || recentLearning) return null;
    if (view.next_check) return `check:${view.next_check.id}`;
    if (!view.fixed && view.scenario.level !== 1) return `fix:${view.scenario.id}`;
    return null;
  }

  function syncClock() {
    const stepId = currentStepId();
    if (stepClock.stepId === stepId) return;
    checkInOpen = false;
    if (!stepId) { stepClock.stop(); return; }
    stepClock.start(stepId, stepId.startsWith('fix:') ? 90 : 45);
  }

  async function request(path, options = {}) {
    const response = await fetch(service + path, {
      ...options,
      headers: {'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json', ...options.headers},
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Learning service returned ${response.status}`);
    return data;
  }

  function say(value, isError = false) {
    message = value;
    error = isError;
    render();
  }

  function sendAction(type, details = {}) {
    sequence += 1;
    sessionStorage.setItem(seqKey, String(sequence));
    const action = {protocol_version: 2, sequence, type, actor: view?.mode === 'demonstration' ? 'tutorial' : 'learner',
      observed_at: new Date().toISOString(), details};
    sending = sending.catch(() => {}).then(async () => {
      const result = await request(sessionPath + '/actions', {method: 'POST', body: JSON.stringify(action)});
      if (result.evaluation?.message) {
        message = result.evaluation.message;
        error = !result.evaluation.correct;
      }
      if (type === 'evidence_check_answered' && result.evaluation?.correct && view?.mode === 'guided') {
        recentLearning = {answer: details.answer, explanation: result.evaluation.message};
        message = '';
      }
      if (result.session) applyView(result.session, true);
      else render();
      if (view?.scenario.level === 1 && view.feedback?.fixed) {
        localStorage.setItem('argo-coach:orientation-complete', 'true');
      }
    }).catch(reason => say(reason.message, true));
    return sending;
  }

  const observer = new window.ArgoActionObserver(sendAction);

  // Guided learners need an unobstructed Argo drawer. During a demonstration,
  // keep the explanation visible beside the drawer so the evidence and its
  // meaning can be read together.
  function updateNativeOverlay() {
    const open = Array.from(document.querySelectorAll(
      '.popup-overlay, .sliding-panel, .application-deployment-history'))
      .some(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
      });
    if (open === nativeOverlayOpen) return;
    nativeOverlayOpen = open;
    host.toggleAttribute('data-native-overlay', open && view?.mode === 'demonstration');
    if (view?.mode === 'demonstration') return;
    if (open && !collapsed) {
      collapsed = true;
      autoCollapsed = true;
      render();
    } else if (!open && autoCollapsed) {
      autoCollapsed = false;
      collapsed = false;
      render();
    }
  }
  const nativeOverlayObserver = new MutationObserver(updateNativeOverlay);
  nativeOverlayObserver.observe(document.body, {childList: true, subtree: true,
    attributes: true, attributeFilter: ['class', 'style', 'aria-hidden']});
  updateNativeOverlay();

  function applyView(nextView, preserveMessage = false) {
    // HTTP and WebSocket responses can finish out of order during preparation.
    if (view?.run_updated_at && nextView.run_updated_at &&
        Date.parse(nextView.run_updated_at) < Date.parse(view.run_updated_at)) return;
    if (!view && !preserveMessage) { message = ''; error = false; }
    view = nextView;
    if (view.feedback || ['FAILED', 'ABORTED'].includes(view.state)) {
      clearDemoCountdown();
      clearBriefCountdown();
    }
    render();
    scheduleDemo();
  }

  function clearBriefCountdown() {
    clearTimeout(briefTimer);
    clearInterval(briefTicker);
    briefTimer = null;
    briefTicker = null;
    briefDeadline = null;
    briefRemaining = briefDuration;
  }

  function pauseBriefCountdown() {
    if (briefDeadline !== null) briefRemaining = Math.max(0, briefDeadline - performance.now());
    clearTimeout(briefTimer);
    clearInterval(briefTicker);
    briefTimer = null;
    briefTicker = null;
    briefDeadline = null;
  }

  function updateBriefCountdown() {
    const progress = root.querySelector('[data-brief-progress]');
    if (!progress) return;
    const waiting = !ready();
    const remaining = briefDeadline === null ? briefRemaining : Math.max(0, briefDeadline - performance.now());
    progress.classList.toggle('working', waiting);
    progress.querySelector('[data-brief-label]').textContent = waiting
      ? 'Preparing the lab. The countdown starts when it is ready.'
      : 'Demonstration starts automatically in';
    progress.querySelector('[data-brief-seconds]').hidden = waiting;
    progress.querySelector('[data-brief-seconds]').textContent = `${Math.ceil(remaining / 1000)}s`;
    progress.querySelector('[data-brief-fill]').style.width = `${100 * (1 - remaining / briefDuration)}%`;
    const bar = progress.querySelector('[role="progressbar"]');
    if (waiting) {
      bar.removeAttribute('aria-valuenow');
      bar.setAttribute('aria-valuetext', 'Preparing the lab');
    } else {
      bar.setAttribute('aria-valuenow', String(Math.round(100 * (1 - remaining / briefDuration))));
      bar.setAttribute('aria-valuetext', `${Math.ceil(remaining / 1000)} seconds until demonstration starts`);
    }
  }

  function startBriefCountdown() {
    if (!briefOpen || view?.mode !== 'demonstration' || !ready() || view.feedback ||
        demoStopped || document.hidden || briefDeadline !== null || sessionStorage.getItem(startedKey)) return;
    briefDeadline = performance.now() + briefRemaining;
    briefTimer = setTimeout(beginInvestigation, briefRemaining);
    briefTicker = setInterval(updateBriefCountdown, 100);
    updateBriefCountdown();
  }

  function beginInvestigation() {
    if (!ready()) return;
    clearBriefCountdown();
    briefOpen = false;
    sessionStorage.setItem(startedKey, 'true');
    render();
    scheduleDemo(500);
  }

  function clearDemoCountdown() {
    demoCountdown = null;
    clearInterval(demoCountdownTicker);
    demoCountdownTicker = null;
    updateDemoCountdown();
  }

  function updateDemoCountdown() {
    const timer = root.querySelector('[data-demo-timer]');
    if (!timer) return;
    const working = !demoCountdown && demoBusy && !demoStopped && !view?.feedback;
    timer.hidden = !demoCountdown && !working;
    timer.classList.toggle('working', working);
    timer.querySelector('[data-demo-label]').textContent = working ? 'Coach is working…' : 'Next action in';
    timer.querySelector('[data-demo-time]').hidden = working;
    if (!demoCountdown) return;
    const remaining = Math.max(0, demoCountdown.deadline - performance.now());
    timer.querySelector('[data-demo-seconds]').textContent = (remaining / 1000).toFixed(1);
    timer.querySelector('[data-demo-fill]').style.width = `${100 * (1 - remaining / demoCountdown.duration)}%`;
  }

  function startDemoCountdown(duration) {
    clearInterval(demoCountdownTicker);
    demoCountdown = {duration, deadline: performance.now() + duration};
    updateDemoCountdown();
    demoCountdownTicker = setInterval(updateDemoCountdown, 100);
  }

  async function demoWait(duration) {
    startDemoCountdown(duration);
    const countdown = demoCountdown;
    await sleep(duration);
    if (demoCountdown === countdown) clearDemoCountdown();
  }

  function demoTimerMarkup() {
    return `<div class="demo-timer" data-demo-timer role="timer" aria-label="Time until the next demonstration action" hidden>
      <span data-demo-label>Next action in</span> <span data-demo-time><strong data-demo-seconds>0.0</strong>s</span>
      <div class="demo-timer-track"><span data-demo-fill></span></div></div>`;
  }

  function scheduleDemo(delay = 750) {
    if (demoTimer || demoBusy || demoStopped || briefOpen || view?.mode !== 'demonstration' ||
        view.feedback || !['READY', 'INVESTIGATING', 'FIXED'].includes(view.state)) return;
    startDemoCountdown(delay);
    const countdown = demoCountdown;
    demoTimer = setTimeout(() => {
      demoTimer = null;
      if (demoCountdown === countdown) clearDemoCountdown();
      driveDemo();
    }, delay);
  }

  async function refresh() {
    try {
      applyView(await request(sessionPath));
    } catch (reason) {
      say(reason.message, true);
    }
  }

  function startPolling() {
    if (!pollTimer) pollTimer = setInterval(refresh, 4000);
  }

  function connectStream() {
    if (!window.WebSocket || stream || view?.feedback) return;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${location.host}${service}${sessionPath}/stream`;
    try { stream = new WebSocket(url, ['argo-coach', `token.${config.token}`]); }
    catch (_) { startPolling(); return; }
    const socket = stream;
    socket.onopen = () => {
      lastStreamMessage = Date.now();
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    };
    socket.onmessage = event => {
      lastStreamMessage = Date.now();
      try { applyView(JSON.parse(event.data)); }
      catch (_) { /* The next update or HTTP fallback will recover. */ }
    };
    socket.onclose = () => {
      if (stream === socket) stream = null;
      if (view?.feedback) return;
      startPolling();
      if (!reconnectTimer) reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectStream();
      }, 5000);
    };
    socket.onerror = () => socket.close();
  }

  function badge(label) {
    return `<span class="badge ${statusClass(label)}">${escape(label || 'Unknown')}</span>`;
  }

  function setDemoNarration(id, phase) {
    demoNarration = {id, phase};
    sessionStorage.setItem(demoNarrationKey, JSON.stringify(demoNarration));
    message = '';
    render();
  }

  function narrateClick(check, detail, reason) {
    if (view?.mode !== 'demonstration') return;
    demoNarration = {id: check.id, phase: 'doing', detail, detailReason: reason};
    sessionStorage.setItem(demoNarrationKey, JSON.stringify(demoNarration));
    render();
  }

  function targetList() {
    if (view.mode !== 'guided') return '';
    const visited = view.targets.filter(target => target.visited).length;
    return `<details class="evidence-map" ${evidenceMapOpen ? 'open' : ''}><summary>Evidence map · ${visited} of ${view.targets.length} places visited</summary>
      <ul class="target-list">${view.targets.map(target =>
        `<li class="${target.visited ? 'visited' : ''}"><span class="state">${target.visited ? '✓' : '○'}</span><span>${escape(target.where)}</span></li>`).join('')}</ul></details>`;
  }

  function checkCard() {
    const check = view.next_check;
    if (view.mode === 'challenge') return '';
    if (!check) {
      if (!view.fixed && view.scenario.level !== 1) {
        if (view.mode === 'demonstration') {
          const phase = demoNarration?.id === `fix:${view.scenario.id}` ? demoNarration.phase : 'what';
          const content = phase === 'why'
            ? `<p class="step-eyebrow">Why I’m doing it</p><p>${escape(view.repair?.reason)}</p>`
            : phase === 'doing'
              ? `<p class="step-eyebrow">Doing it now</p><p>${escape(view.repair?.action)}</p>`
              : `<p class="step-eyebrow">What I’ll do next</p><p>${escape(view.repair?.action)}</p>`;
          return `<div class="card step-card demo-step"><strong>Repair the source</strong>${content}</div>`;
        }
        return `<div class="card step-card"><p class="step-eyebrow">What to do next</p><strong>${escape(view.repair?.action)}</strong>
          <p class="step-eyebrow">Why this repair matters</p><p>${escape(view.repair?.reason)}</p>
          <p class="small muted">After Argo is Healthy and Synced, verify the deployed revision in History.</p>
          ${view.fix_paths.length ? `<p class="small muted">Likely source: ${view.fix_paths.map(path => `<code>${escape(path)}</code>`).join(' ')}</p>` : ''}</div>`;
      }
      return `<div class="card"><strong>Evidence gathered</strong><p>Write a short incident note to finish the run.</p></div>`;
    }
    const ready = check.available;
    if (view.mode === 'demonstration') {
      const phase = demoNarration?.id === check.id ? demoNarration.phase : 'what';
      const content = phase === 'why'
        ? `<p class="step-eyebrow">Why I’m doing it</p><p>${escape(check.reason)}</p>`
        : phase === 'doing'
          ? `<p class="step-eyebrow">Doing it now</p><p>${escape(demoNarration?.detail || check.action)}</p>
             ${demoNarration?.detailReason ? `<p class="small muted">${escape(demoNarration.detailReason)}</p>` : ''}`
          : phase === 'learning'
            ? `<p class="step-eyebrow">What we learned</p><p><strong>${escape(check.demonstration_answer)}</strong> ${escape(check.learning)}</p>`
            : `<p class="step-eyebrow">What I’ll do next</p><p>${escape(check.action)}</p>`;
      return `<div class="card step-card demo-step"><p class="step-count">Evidence step ${view.checks_passed + 1} of ${view.checks_total}</p>${content}</div>`;
    }
    return `<div class="card step-card"><p class="step-count">Evidence step ${view.checks_passed + 1} of ${view.checks_total}</p>
      <p class="step-eyebrow">What to inspect next</p><strong>${escape(check.action)}</strong>
      <p class="step-eyebrow">Why this view</p><p>${escape(check.reason)}</p>
      ${ready ? `<form id="check-form"><label for="check-answer">What did you find? ${escape(check.question)}</label><input id="check-answer" autocomplete="off" required><div class="actions"><button class="primary" type="submit">Check evidence</button></div></form>`
        : `<div class="actions"><button class="secondary" data-action="show-location">Show me where</button></div>`}
      ${hintVisible ? `<p class="message">${escape(check.hint)}</p>` : ''}
    </div>`;
  }

  function learningCard() {
    if (!recentLearning) return '';
    return `<div class="card step-card learning-card" role="status"><p class="step-eyebrow">What we learned</p>
      <strong>${escape(recentLearning.answer)}</strong><p>${escape(recentLearning.explanation)}</p>
      <div class="actions"><button class="primary" data-action="continue-step">Continue investigation</button></div></div>`;
  }

  function demoPatchCard() {
    if (view.mode !== 'demonstration' || !demoPatch?.diff) return '';
    return `<div class="card demo-patch"><strong>Source change made by the coach</strong>
      <p class="small">This is the exact change Argo CD is reconciling.</p>
      <pre aria-label="Demonstration source diff">${escape(demoPatch.diff)}</pre></div>`;
  }

  function checkInCard() {
    if (!checkInOpen || view.mode !== 'guided') return '';
    const task = view.next_check ? `finding the answer in ${view.next_check.where}` : 'fixing the deployment';
    return `<div class="card check-in" role="status"><strong>How is ${escape(task)} going?</strong>
      <p class="small muted">Take your time. You can keep exploring or ask the coach for help.</p>
      <div class="actions"><button class="secondary" data-action="checkin-continue">Keep going</button>
      <button class="secondary" data-action="checkin-hint">Give me a hint</button>
      <button class="secondary" data-action="checkin-show">Show me where</button></div></div>`;
  }

  function debrief() {
    const feedback = view.feedback;
    if (!feedback) return '';
    const breakdown = feedback.breakdown || {};
    const replay = new URLSearchParams({scenario: view.scenario.id, mode: view.mode, environment: view.environment});
    const sameSeed = new URLSearchParams(replay);
    if (view.seed != null) sameSeed.set('seed', String(view.seed));
    const lessHelp = new URLSearchParams(replay);
    lessHelp.set('mode', view.mode === 'demonstration' ? 'guided' : 'challenge');
    return `<div class="debrief-content"><h2 id="debrief-title">Debrief${feedback.total == null ? '' : ` · ${escape(feedback.total)} / 100`}</h2>
      <p>${escape(feedback.message)}</p>
      ${feedback.trigger_revision ? `<p class="small">Triggering revision: <code>${escape(feedback.trigger_revision)}</code></p>` : ''}
      ${feedback.deployed_revision ? `<p class="small">Deployed revision: <code>${escape(feedback.deployed_revision)}</code> · See History and Rollback in Argo CD.</p>` : ''}
      ${feedback.fix_commit?.sha ? `<p class="small">Fix commit: ${view.mode === 'demonstration'
        ? `<code>${escape(feedback.fix_commit.sha)}</code> · ${escape(feedback.fix_commit.message || '')}`
        : `<a href="/gitea/remotelab/django-app/commit/${encodeURIComponent(feedback.fix_commit.sha)}">${escape(feedback.fix_commit.message || feedback.fix_commit.sha)}</a>`}</p>` : ''}
      ${feedback.total == null ? '' : `<p class="small">Remediation ${escape(breakdown.remediation)}/35 · Console evidence ${escape(breakdown.console_evidence)}/25 · Diagnosis ${escape(breakdown.diagnosis)}/20 · Practice ${escape(breakdown.operational_practice)}/10 · Efficiency ${escape(breakdown.efficiency)}/10</p>`}
      <h3>Where the evidence was</h3><ul class="target-list">${feedback.evidence_map.map(target =>
        `<li class="${target.visited ? 'visited' : ''}"><span class="state">${target.visited ? '✓' : '○'}</span><span>${escape(target.where)}${target.fact ? `<br><small class="muted">${escape(target.fact)}</small>` : ''}</span></li>`).join('')}</ul>
      <h3>Operating habits</h3><ul>${(feedback.practice_notes || []).map(note => `<li>${escape(note)}</li>`).join('')}</ul>
      <div class="actions"><a class="secondary" href="/?${escape(sameSeed)}">Replay same key</a>
        <a class="secondary" href="/?${escape(replay)}">New key</a>
        ${view.mode !== 'challenge' && view.scenario.level !== 1 ? `<a class="secondary" href="/?${escape(lessHelp)}">Less help</a>` : ''}
        ${view.scenario.level < 5 ? `<a class="secondary" href="/?next_level=${view.scenario.level + 1}">Next level</a>` : ''}</div></div>`;
  }

  function noteForm() {
    return `<div class="modal-wrap"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="note-title">
      <div class="mark">Coach</div><h2 id="note-title">Incident note</h2>
      <p class="muted">Summarize what you found in Argo CD and how the deployment was fixed.</p>
      <form id="note-form">
      ${[['resource', 'Failing resource'], ['evidence', 'Decisive console evidence'], ['revision', 'Triggering or deployed revision'], ['cause', 'Root cause'], ['fix', 'Fix made']].map(([id, label]) =>
        `<div class="form-row"><label for="note-${id}">${label}</label><textarea id="note-${id}" name="${id}" required>${escape(view.note_draft?.[id] || '')}</textarea></div>`).join('')}
      <div class="actions"><button class="primary" type="submit">Submit note</button><button class="secondary" type="button" data-action="close-note">Keep investigating</button></div>
      </form></div></div>`;
  }

  function briefing() {
    const incident = view.briefing || {source: 'Investigation brief', headline: view.scenario.title,
      summary: view.brief, impact: '', objective: view.brief};
    const started = sessionStorage.getItem(startedKey) === 'true';
    const autoStart = view.mode === 'demonstration' && !started;
    return `<div class="modal-wrap"><div class="modal incident-briefing" role="dialog" aria-modal="true" aria-labelledby="brief-title" tabindex="-1">
      <div class="brief-header"><span class="brief-source">${escape(incident.source)}</span><span class="brief-mode">${escape(view.mode)}</span></div>
      <div class="brief-body"><p class="step-eyebrow">${view.scenario.level === 1 ? 'Practice request' : 'Incoming incident'}</p>
      <h2 id="brief-title">${escape(incident.headline)}</h2>
      <p class="brief-context">${escape(view.environment)} environment · Argo CD investigation</p>
      <section class="brief-section"><h3>What we know</h3><p>${escape(incident.summary)}</p></section>
      <section class="brief-section"><h3>Why it matters</h3><p>${escape(incident.impact)}</p></section>
      <section class="brief-section brief-objective"><h3>What we need to establish in Argo CD</h3><p>${escape(incident.objective)}</p></section></div>
      ${autoStart ? `<div class="brief-progress" data-brief-progress>
        <div class="brief-progress-copy"><span data-brief-label></span><strong data-brief-seconds></strong></div>
        <div class="brief-progress-track" role="progressbar" aria-label="Automatic demonstration start" aria-valuemin="0" aria-valuemax="100"><span data-brief-fill></span></div>
      </div>` : !ready() ? '<p class="brief-waiting">Preparing the lab. The investigation can begin when it is ready.</p>' : ''}
      <div class="brief-footer">${autoStart ? '<button class="secondary" data-action="stop">Stop</button>' : ''}
        <button class="primary" data-action="begin" ${ready() ? '' : 'disabled'}>${started ? 'Return to investigation' : autoStart ? 'Start now' : 'Begin investigation'}</button></div>
    </div></div>`;
  }

  function render() {
    if (!view) {
      root.innerHTML = error && message ? `<div class="modal-wrap"><div class="modal" role="alert">
        <h2>Could not load the learning session</h2><p>${escape(message)}</p>
        <button class="secondary" data-action="retry-session">Retry</button></div></div>` : '';
      return;
    }
    host.toggleAttribute('data-debrief', Boolean(view.feedback));
    if (view.mode === 'demonstration' && autoCollapsed) {
      collapsed = false;
      autoCollapsed = false;
    } else if (view.mode !== 'demonstration' && nativeOverlayOpen && !collapsed) {
      collapsed = true;
      autoCollapsed = true;
    }
    if (root.querySelector('.evidence-map')) evidenceMapOpen = root.querySelector('.evidence-map').open;
    host.toggleAttribute('data-native-overlay', nativeOverlayOpen && view.mode === 'demonstration');
    if (view.mode === 'demonstration' && (view.feedback || demoPatch?.diff ||
        (!view.next_check && view.scenario.level !== 1))) {
      // Show the source change and debrief even if Argo's resource or History
      // drawer previously collapsed the coach.
      collapsed = false;
      autoCollapsed = false;
      if (view.feedback) pointer.removeAttribute('data-visible');
    }
    syncClock();
    const preparing = !['READY', 'INVESTIGATING', 'FIXED', 'COMPLETED', 'FAILED', 'ABORTED'].includes(view.state);
    if (view.feedback) {
      root.innerHTML = `<div class="modal-wrap"><div class="modal debrief-modal" role="dialog" aria-modal="true" aria-labelledby="debrief-title">${debrief()}</div></div>`;
      return;
    }
    if (briefOpen && !['FAILED', 'ABORTED', 'COMPLETED'].includes(view.state)) {
      const oldBrief = root.querySelector('.incident-briefing');
      const scrollTop = oldBrief?.scrollTop || 0;
      const focusedInside = oldBrief?.contains(shadow.activeElement);
      const focusedAction = focusedInside ? shadow.activeElement?.dataset.action : null;
      root.innerHTML = briefing();
      const newBrief = root.querySelector('.incident-briefing');
      newBrief.scrollTop = scrollTop;
      if (focusedAction) root.querySelector(`[data-action="${focusedAction}"]:not(:disabled)`)?.focus({preventScroll: true});
      else if (!oldBrief || focusedInside) newBrief.focus({preventScroll: true});
      if (!ready()) pauseBriefCountdown();
      startBriefCountdown();
      updateBriefCountdown();
      return;
    }
    const body = preparing ? `<p>Preparing the environment and waiting for Argo CD to show the incident…</p>`
      : view.state === 'FAILED' ? `<p class="message error">${escape(view.run_error || 'The run could not start.')}</p>`
      : view.state === 'ABORTED' ? '<p>The run was stopped.</p><a class="secondary" href="/">Return to missions</a>'
      : `${view.mode === 'demonstration' ? `<p class="driving">${view.feedback ? '✦ Demonstration complete' : '✦ Coach is driving'}</p>` : ''}
         <h2>${escape(view.briefing?.headline || view.scenario.title)}</h2>
         <div class="status">${badge(view.health)} ${badge(view.sync)} ${badge(view.fixed ? 'Fixed' : view.state)}</div>
         ${view.alert ? `<div class="message error" role="alert">${escape(view.alert.message)}</div>` : ''}
         ${checkInCard()} ${demoPatchCard()} ${recentLearning ? learningCard() : checkCard()} ${targetList()}
         ${view.feedback || view.mode === 'demonstration' || recentLearning ? '' : view.mode === 'challenge' ? `<div class="actions"><button class="secondary" data-action="incident-info">Incident info</button>
           <button class="secondary" data-action="hint">Hint (assistance recorded)</button><button class="primary" data-action="note">Write incident note</button></div>` :
           `<div class="actions"><button class="secondary" data-action="incident-info">Incident info</button><button class="secondary" data-action="hint">Hint</button>
             <button class="secondary" data-action="show-location">Show me</button>
             ${view.fixed && view.scenario.level !== 1 && !view.feedback ? '<button class="primary" data-action="note">Write incident note</button>' : ''}</div>`}
         <div class="actions">${view.fix_surface !== 'none' && view.mode !== 'demonstration' && !recentLearning ? '<button class="secondary" data-action="gitea">View Git source</button>' : ''}
           <button class="secondary" data-action="terminal">${!terminalOpen ? 'Open terminal' : terminalMinimized ? 'Restore terminal' : 'Minimize terminal'}</button></div>`;
    const previousValues = new Map(Array.from(root.querySelectorAll('input, textarea')).map(element => [element.id, element.value]));
    const active = shadow.activeElement?.id;
    root.innerHTML = `<aside class="panel" ${collapsed ? 'data-collapsed' : ''} aria-label="Argo CD Coach">
      <div class="header"><span class="mark">Coach</span><span class="title">${escape(view.application)}</span>
      ${view.mode === 'demonstration' && !['ABORTED', 'COMPLETED', 'FAILED'].includes(view.state) ? '<button class="secondary stop-button" data-action="stop" aria-label="Stop demonstration">Stop</button>' : ''}
      <button class="icon-button" data-action="collapse" aria-label="${collapsed ? 'Expand' : 'Collapse'} coach">${collapsed ? '▣' : '−'}</button></div>
      ${collapsed ? '' : `<div class="body">${body}${message ? `<div class="message ${error ? 'error' : ''}" role="status">${escape(message)}</div>` : ''}${view.mode === 'demonstration' ? demoTimerMarkup() : ''}</div>
      <div class="footer">${view.mode === 'challenge' ? 'The deployment and incident note determine completion.' : `${view.checks_passed} of ${view.checks_total} evidence checks complete.`}</div>`}
    </aside>${noteOpen ? noteForm() : ''}`;
    for (const [id, value] of previousValues) {
      const element = root.querySelector(`#${id}`);
      if (element) element.value = value;
    }
    if (active) root.querySelector(`#${active}`)?.focus();
    else if (noteOpen) root.querySelector('#note-resource')?.focus();
    updateDemoCountdown();
  }

  function renderDock() {
    if (!terminalOpen) { dockRoot.innerHTML = ''; return; }
    let dock = dockRoot.querySelector('.terminal-dock');
    if (!dock) {
      dockRoot.innerHTML = `<div class="terminal-dock">
        <button class="terminal-resize" type="button" aria-label="Resize terminal" title="Drag to resize terminal" tabindex="0"></button>
        <div class="header"><span class="mark">Coach</span><span class="title">Lab terminal</span>
          <button class="icon-button" data-action="minimize-terminal" aria-label="Minimize terminal">−</button>
          <button class="icon-button" data-action="close-terminal" aria-label="Close terminal">×</button></div>
        <iframe title="Lab terminal" src="/terminal/"></iframe></div>`;
      dock = dockRoot.querySelector('.terminal-dock');
    }
    dock.toggleAttribute('data-minimized', terminalMinimized);
    const minimize = dock.querySelector('[data-action="minimize-terminal"]');
    minimize.textContent = terminalMinimized ? '▣' : '−';
    minimize.setAttribute('aria-label', terminalMinimized ? 'Restore terminal' : 'Minimize terminal');
  }

  function resizeTerminal(width, height) {
    const dock = dockRoot.querySelector('.terminal-dock');
    if (!dock) return;
    dock.style.width = `${Math.max(Math.min(320, innerWidth - 24), Math.min(width, innerWidth - 24))}px`;
    dock.style.height = `${Math.max(Math.min(180, innerHeight - 24), Math.min(height, innerHeight - 24))}px`;
  }

  function visible(element) {
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  }

  function candidate(text) {
    const phrase = text.toLowerCase();
    return Array.from(document.querySelectorAll('button, a, [role="tab"], [role="button"], [title]'))
      .find(element => visible(element) && [element.textContent, element.getAttribute('title'), element.getAttribute('aria-label')]
        .some(value => (value || '').trim().toLowerCase().includes(phrase)));
  }

  function spotlight(element) {
    const bounds = element.getBoundingClientRect();
    const frame = document.createElement('div');
    frame.className = 'spotlight';
    Object.assign(frame.style, {left: `${bounds.left - 4}px`, top: `${bounds.top - 4}px`,
      width: `${bounds.width + 8}px`, height: `${bounds.height + 8}px`});
    root.append(frame);
    setTimeout(() => frame.remove(), 5000);
  }

  // Scroll the nearest drawer or page first, then its parents. Native smooth
  // scrolling can still be in flight when the cursor moves, especially in
  // Argo's History drawer, so each animation is awaited before pointing.
  function scrollContainers(element) {
    const containers = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent === document.body || parent === document.documentElement) continue;
      const style = getComputedStyle(parent);
      if ((parent.scrollHeight > parent.clientHeight + 2 && !['visible', 'clip'].includes(style.overflowY)) ||
          (parent.scrollWidth > parent.clientWidth + 2 && !['visible', 'clip'].includes(style.overflowX))) {
        containers.push(parent);
      }
    }
    if (document.scrollingElement) containers.push(document.scrollingElement);
    return containers;
  }

  function cubicBezier(progress) {
    // The same (.2, .8, .2, 1) curve used for cursor movement.
    const coordinate = (t, first, second) =>
      3 * (1 - t) ** 2 * t * first + 3 * (1 - t) * t ** 2 * second + t ** 3;
    let low = 0;
    let high = 1;
    for (let index = 0; index < 12; index += 1) {
      const middle = (low + high) / 2;
      if (coordinate(middle, .2, .2) < progress) low = middle;
      else high = middle;
    }
    return coordinate((low + high) / 2, .8, 1);
  }

  async function scrollToTarget(element) {
    for (const container of scrollContainers(element)) {
      if (!element.isConnected || demoStopped) return false;
      const viewport = container === document.scrollingElement;
      const frame = viewport ? {top: 0, left: 0, width: innerWidth, height: innerHeight} : container.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      const startX = container.scrollLeft;
      const startY = container.scrollTop;
      const targetX = Math.max(0, Math.min(container.scrollWidth - container.clientWidth,
        startX + bounds.left + Math.min(bounds.width, frame.width / 2) / 2 - frame.left - frame.width / 2));
      const targetY = Math.max(0, Math.min(container.scrollHeight - container.clientHeight,
        startY + bounds.top + Math.min(bounds.height, frame.height / 2) / 2 - frame.top - frame.height / 2));
      const distance = Math.hypot(targetX - startX, targetY - startY);
      if (distance < 2) continue;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        container.scrollLeft = targetX;
        container.scrollTop = targetY;
        continue;
      }
      const duration = Math.min(1100, Math.max(450, 420 + distance * .24));
      await new Promise(resolve => {
        const started = performance.now();
        const frameStep = now => {
          if (!element.isConnected || demoStopped) { resolve(); return; }
          const progress = Math.min(1, (now - started) / duration);
          const eased = cubicBezier(progress);
          container.scrollLeft = startX + (targetX - startX) * eased;
          container.scrollTop = startY + (targetY - startY) * eased;
          if (progress < 1) requestAnimationFrame(frameStep);
          else resolve();
        };
        requestAnimationFrame(frameStep);
      });
    }
    await new Promise(resolve => requestAnimationFrame(resolve));
    return element.isConnected && !demoStopped;
  }

  async function pointAt(element, click = false) {
    if (!element?.isConnected || !visible(element) || demoStopped) return false;
    if (!await scrollToTarget(element)) return false;
    const bounds = element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return false;
    spotlight(element);
    if (!pointer.style.left) {
      const panel = root.querySelector('.panel')?.getBoundingClientRect();
      pointer.style.left = `${panel?.left ?? window.innerWidth - 80}px`;
      pointer.style.top = `${panel?.top ?? 80}px`;
    }
    pointer.dataset.visible = 'true';
    pointer.removeAttribute('data-click');
    clearTimeout(pointerTimer);
    await new Promise(resolve => requestAnimationFrame(resolve));
    pointer.style.left = `${Math.round(bounds.left + Math.min(bounds.width / 2, 80))}px`;
    pointer.style.top = `${Math.round(bounds.top + Math.min(bounds.height / 2, 25))}px`;
    await sleep(900);
    if (demoStopped || !element.isConnected) return false;
    if (click) {
      pointer.dataset.click = 'true';
      await sleep(180);
      element.click();
    }
    pointerTimer = setTimeout(() => { pointer.removeAttribute('data-visible'); }, click ? 1200 : 2700);
    return true;
  }

  function evidenceElement(check) {
    const exact = text => Array.from(document.querySelectorAll('body *')).find(element =>
      element.childElementCount === 0 && element.textContent?.trim() === text && visible(element));
    const selectors = {
      'app.operation': '.application-operation-state__message',
      'app.conditions': '.application-conditions',
      'app.tree': '.application-resource-tree__node-title',
      'resource.events': '.application-node-info',
      'resource.logs': '.application-node-info',
      'resource.manifest': '.application-node-info__manifest--raw',
    };
    const history = check.target === 'app.history' && document.querySelector('.application-deployment-history');
    const revision = String(check.demonstration_answer || '').toLowerCase();
    const historyRevision = history && revision && Array.from(history.querySelectorAll('*')).find(element => {
      if (element.childElementCount || !visible(element)) return false;
      const text = element.textContent?.trim().toLowerCase() || '';
      return text.includes(revision) || (text.length >= 7 && revision.startsWith(text));
    });
    return (check.target === 'apps.list' ? exact(view.application) : null) ||
      (check.target === 'app.header' ? exact(view.health || '') : null) ||
      (check.target === 'app.tree' ? exact(check.demonstration_answer || '') : null) ||
      historyRevision || history ||
      (check.target === 'settings.repos' ? candidate('gitea.applications.svc.cluster.local') : null) ||
      document.querySelector(selectors[check.target] || '.__argo_coach_no_match__') ||
      candidate(({'app.history': 'History', 'app.operation': 'Sync Status',
        'resource.manifest': 'Desired'}[check.target]) || check.target.split('.')[1]);
  }

  async function activate(element, demonstration) {
    if (demonstration) return pointAt(element, true);
    if (!await scrollToTarget(element)) return false;
    element.click();
    return true;
  }

  async function resourceNode(target) {
    const token = localStorage.getItem('argocd.token');
    const response = await fetch(`/argocd/api/v1/applications/${encodeURIComponent(view.application)}/resource-tree?appNamespace=argocd`,
      {headers: token ? {Authorization: `Bearer ${token}`} : {}});
    if (!response.ok) throw new Error(`Argo CD resource tree returned ${response.status}`);
    const tree = await response.json();
    const kind = target === 'resource.logs' ? 'Job' : target === 'resource.events' ? 'Pod' : 'Deployment';
    const nodes = (tree.nodes || []).filter(node => node.kind === kind);
    const node = nodes.find(item => item.health?.status && item.health.status !== 'Healthy') || nodes[0];
    return node ? {id: [node.group || '', node.kind, node.namespace || '', node.name].join('/') + '/0',
      name: node.name} : null;
  }

  async function showLocation(demonstration = false) {
    const check = view?.next_check;
    if (!check) { say('Open the affected Application and verify its health and deployed revision.'); return; }
    const target = check.target;
    if (target === 'apps.list' || target === 'apps.filter') {
      if (!location.pathname.endsWith('/applications')) {
        narrateClick(check, 'Open Applications.', 'The cards show environment and current status before we choose a release.');
        location.href = '/argocd/applications';
      }
      else if (demonstration) {
        narrateClick(check, `Read the ${view.environment} Application card.`, 'Its environment label scopes every later observation.');
        const card = evidenceElement({...check, target: 'apps.list'});
        if (card) await pointAt(card);
        observer.fromURL(location.href);
      } else say(check.hint);
      return;
    }
    if (target === 'settings.repos') {
      if (!/\/argocd\/settings\/repos(?:itories)?\/?$/.test(location.pathname)) {
        narrateClick(check, 'Open Settings → Repositories.', 'The connected repository entry is a control case for the failing source URL.');
        location.href = '/argocd/settings/repos';
      } else if (demonstration) {
        narrateClick(check, 'Read the connected Gitea repository URL.', 'Its transport can be compared with the one named in Conditions.');
        const entry = evidenceElement(check);
        if (entry) await pointAt(entry);
        observer.fromURL(location.href);
      } else say(check.hint);
      return;
    }
    if (!location.pathname.includes(`/applications/argocd/${encodeURIComponent(view.application)}`)) {
      const cardLabel = Array.from(document.querySelectorAll('body *')).find(element =>
        element.childElementCount === 0 && element.textContent?.trim() === view.application && visible(element));
      narrateClick(check, `Open ${view.application}.`, 'The Application page limits the evidence to this release.');
      if (cardLabel) { await activate(cardLabel, demonstration); return; }
      location.href = `/argocd/applications/argocd/${encodeURIComponent(view.application)}`;
      return;
    }
    const url = new URL(location.href);
    const panel = {'app.history': ['rollback', '0'], 'app.conditions': ['conditions', 'true'],
      'app.operation': ['operation', 'true']};
    if (panel[target]) {
      const [name, value] = panel[target];
      if (url.searchParams.get(name) !== value) {
        const label = {'app.history': 'History and Rollback', 'app.conditions': 'Conditions',
          'app.operation': 'Sync Status'}[target];
        narrateClick(check, `Open ${label}.`, check.reason);
        const control = demonstration && candidate(label);
        if (control) { await activate(control, true); return; }
        url.searchParams.set(name, value); location.href = url.href; return;
      }
    }
    const appView = {'app.tree': 'tree', 'app.network': 'network', 'app.list': 'list', 'app.pods': 'pods'}[target];
    if (appView && url.searchParams.get('view')?.toLowerCase() !== appView) {
      narrateClick(check, `Switch to the ${appView} view.`, check.reason);
      const control = demonstration && candidate(appView);
      if (control) { await activate(control, true); return; }
      url.searchParams.set('view', appView);
      location.href = url.href;
      return;
    }
    if (target === 'app.diff') {
      narrateClick(check, 'Open Diff.', 'Compare the desired resource against the live one before changing or pruning it.');
      const control = demonstration && candidate('Diff');
      if (control) { await activate(control, true); return; }
      url.searchParams.set('node', `argoproj.io/Application/argocd/${view.application}/0`);
      url.searchParams.set('tab', 'diff');
      location.href = url.href;
      return;
    }
    if (target.startsWith('resource.')) {
      try {
        // Argo normalizes the Application URL while its tree is mounting.
        // Navigating to a node before that mount can be overwritten by a
        // later `?resource=` replaceState from Argo itself.
        for (let attempt = 0; attempt < 20 &&
             !document.querySelector('.application-resource-tree__node-title'); attempt += 1) {
          await sleep(250);
        }
        const node = await resourceNode(target);
        if (node) {
          const title = Array.from(document.querySelectorAll('.application-resource-tree__node-title'))
            .find(element => element.textContent?.trim() === node.name);
          if (title) {
            narrateClick(check, `Open ${node.name} in the Application tree.`, 'This is the resource whose own evidence can explain the Application status.');
            await activate(title, demonstration);
            if (target === 'resource.summary') return;
            const label = {'resource.events': 'Events', 'resource.logs': 'Logs',
              'resource.manifest': 'Manifest'}[target];
            for (let attempt = 0; attempt < 20; attempt += 1) {
              const tab = candidate(label) || Array.from(document.querySelectorAll('body *'))
                .find(element => element.childElementCount === 0 &&
                  element.textContent?.trim().toLowerCase() === label.toLowerCase() && visible(element));
              if (tab) {
                narrateClick(check, `Select ${label} in the resource drawer.`, check.reason);
                await activate(tab, demonstration);
                return;
              }
              await sleep(250);
            }
          }
          url.searchParams.set('node', node.id);
          url.searchParams.set('tab', ({'resource.events': 'events', 'resource.logs': 'logs',
            'resource.manifest': 'manifest', 'resource.summary': 'summary'})[target]);
          location.href = url.href;
          return;
        }
      } catch (_) { /* Keep the on-screen pointer when the tree is unavailable. */ }
    }
    const labels = {"app.history": 'History', "app.conditions": 'Conditions', "app.operation": 'Sync Status',
      "app.diff": 'Diff', "resource.events": 'Events', "resource.logs": 'Logs',
      "resource.manifest": 'Desired', "app.tree": 'Tree'};
    const element = candidate(labels[target] || target.split('.')[1]);
    if (element) {
      if (demonstration) {
        narrateClick(check, `Read ${check.where}.`, check.reason);
        await pointAt(element);
      }
      else { await scrollToTarget(element); spotlight(element); say(check.hint); }
    }
    else say(check.hint || `Open ${check.where} in the Argo CD console.`);
  }

  async function answerCheck(answer) {
    const check = view?.next_check;
    if (!check) return;
    await sendAction('evidence_check_answered', {check_id: check.id, answer});
    hintVisible = false;
    await refresh();
  }

  async function submitNote(values) {
    try {
      const feedback = await request(sessionPath + '/note', {method: 'POST', body: JSON.stringify(values)});
      noteOpen = false;
      view.feedback = feedback;
    if (view.scenario.level === 1 && feedback.fixed) localStorage.setItem('argo-coach:orientation-complete', 'true');
      say(feedback.message);
      await refresh();
    } catch (reason) { say(reason.message, true); }
  }

  async function driveDemo() {
    if (demoBusy || demoStopped || briefOpen || !view || !['READY', 'INVESTIGATING', 'FIXED'].includes(view.state) || view.feedback) return;
    demoBusy = true;
    try {
      const check = view.next_check;
      if (check) {
        if (demoNarration?.id !== check.id) {
          setDemoNarration(check.id, 'what');
          await demoWait(2600);
          if (demoStopped || view.next_check?.id !== check.id) return;
          setDemoNarration(check.id, 'why');
          await demoWait(3600);
          if (demoStopped || view.next_check?.id !== check.id) return;
        }
        if (!check.available) {
          setDemoNarration(check.id, 'doing');
          await demoWait(700);
          if (demoStopped) return;
          await showLocation(true);
          await sending;
          if (!demoStopped) await refresh();
        } else if (check.demonstration_answer) {
          setDemoNarration(check.id, 'doing');
          await demoWait(700);
          if (demoStopped) return;
          const element = evidenceElement(check);
          if (element) await pointAt(element);
          if (demoStopped) return;
          setDemoNarration(check.id, 'learning');
          await demoWait(4400);
          if (demoStopped || view.next_check?.id !== check.id) return;
          await answerCheck(check.demonstration_answer);
        }
      } else if (!view.fixed && view.scenario.level !== 1 && !demoFixStarted) {
        demoFixStarted = true;
        sessionStorage.setItem(demoFixKey, 'true');
        const fixStep = `fix:${view.scenario.id}`;
        setDemoNarration(fixStep, 'what');
        await demoWait(2600);
        if (demoStopped) return;
        setDemoNarration(fixStep, 'why');
        await demoWait(3600);
        if (demoStopped) return;
        setDemoNarration(fixStep, 'doing');
        await demoWait(700);
        if (demoStopped) return;
        let result;
        try { result = await request(sessionPath + '/demonstrate-fix', {method: 'POST', body: '{}'}); }
        catch (reason) {
          demoFixStarted = false;
          sessionStorage.removeItem(demoFixKey);
          throw reason;
        }
        if (demoStopped) return;
        demoPatch = {commit: result.commit || '', diff: result.diff || ''};
        sessionStorage.setItem(demoPatchKey, JSON.stringify(demoPatch));
        render();
        await demoWait(6000);
        if (!demoStopped) await refresh();
      } else if (view.fixed && view.checks_passed >= view.checks_total) {
        say('Argo CD shows the fixed revision. The coach is writing the incident note.');
        await demoWait(3500);
        if (demoStopped) return;
        const note = view.demonstration_note || {};
        await submitNote({resource: note.resource || view.application, evidence: note.evidence || 'Healthy and Synced',
          revision: note.revision || view.revision, cause: note.cause || 'No incident', fix: note.fix || 'No fix needed'});
      } else await refresh();
    } catch (reason) { say(reason.message, true); }
    finally { demoBusy = false; scheduleDemo(1600); }
  }

  root.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'retry-session') refresh();
    else if (action === 'begin') beginInvestigation();
    else if (action === 'continue-step') { recentLearning = null; render(); scheduleDemo(500); }
    else if (action.startsWith('checkin-')) {
      const choice = action.slice('checkin-'.length);
      checkInOpen = false;
      if (choice === 'continue') stepClock.keepGoing();
      else stepClock.helped();
      sendAction('check_in_answered', {step: stepClock.stepId, choice, active_seconds: stepClock.seconds});
      if (choice === 'hint') {
        hintVisible = true;
        sendAction('hint_requested', {target: view.next_check?.target});
        say(view.next_check?.hint || 'Check the Application condition, resource events, diff and deployed revision.');
      } else if (choice === 'show') {
        sendAction('step_demonstrated', {target: view.next_check?.target});
        showLocation();
      } else render();
    }
    else if (action === 'stop') {
      demoStopped = true;
      briefOpen = false;
      clearBriefCountdown();
      clearTimeout(demoTimer);
      demoTimer = null;
      clearDemoCountdown();
      clearTimeout(pointerTimer);
      pointer.removeAttribute('data-visible');
      request(`/api/runs/${encodeURIComponent(view.run_id)}`, {method: 'DELETE'})
        .then(() => refresh()).catch(reason => say(reason.message, true));
      say('Stopping the demonstration…');
    }
    else if (action === 'collapse') {
      collapsed = !collapsed;
      autoCollapsed = false;
      sessionStorage.setItem(collapsedKey, String(collapsed));
      render();
    }
    else if (action === 'hint') {
      hintVisible = true;
      sendAction('hint_requested', {target: view.next_check?.target});
      say(view.next_check?.hint || 'Check the Application condition, resource events, diff and deployed revision.');
    }
    else if (action === 'show-location') { sendAction('step_demonstrated', {target: view.next_check?.target}); showLocation(); }
    else if (action === 'note') { noteOpen = true; render(); }
    else if (action === 'close-note') { noteOpen = false; render(); }
    else if (action === 'incident-info') { briefOpen = true; render(); }
    else if (action === 'terminal') {
      if (!terminalOpen) terminalOpen = true;
      else terminalMinimized = !terminalMinimized;
      renderDock(); render();
    }
    else if (action === 'gitea') {
      const path = view.fix_paths?.[0] || '';
      const destination = `/gitea/remotelab/django-app/src/branch/main/${path}`;
      if (sessionStorage.getItem('argo-coach:gitea-authenticated') === 'true') {
        location.href = destination;
      } else {
        request('/api/auth/gitea').then(() => {
          sessionStorage.setItem('argo-coach:gitea-authenticated', 'true');
          location.href = destination;
        }).catch(reason => say(reason.message, true));
      }
    }
  });
  dockRoot.addEventListener('click', event => {
    if (event.target.closest('[data-action="close-terminal"]')) {
      terminalOpen = false;
      terminalMinimized = false;
      renderDock(); render();
    } else if (event.target.closest('[data-action="minimize-terminal"]')) {
      terminalMinimized = !terminalMinimized;
      renderDock(); render();
    }
  });
  dockRoot.addEventListener('pointerdown', event => {
    const handle = event.target.closest('.terminal-resize');
    if (!handle || terminalMinimized) return;
    const dock = dockRoot.querySelector('.terminal-dock');
    const start = dock.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    handle.setPointerCapture(event.pointerId);
    dock.toggleAttribute('data-resizing', true);
    const move = update => resizeTerminal(start.width + startX - update.clientX, start.height + startY - update.clientY);
    const finish = () => {
      dock.removeAttribute('data-resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  });
  dockRoot.addEventListener('keydown', event => {
    if (!event.target.matches('.terminal-resize')) return;
    const steps = {ArrowLeft: [20, 0], ArrowRight: [-20, 0], ArrowUp: [0, 20], ArrowDown: [0, -20]};
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    const bounds = dockRoot.querySelector('.terminal-dock').getBoundingClientRect();
    resizeTerminal(bounds.width + step[0], bounds.height + step[1]);
  });
  root.addEventListener('submit', event => {
    event.preventDefault();
    if (event.target.id === 'check-form') answerCheck(root.querySelector('#check-answer')?.value || '');
    else if (event.target.id === 'note-form') submitNote(Object.fromEntries(new FormData(event.target)));
  });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && noteOpen) { noteOpen = false; render(); }
  });
  addEventListener('pointerdown', () => stepClock.input(), {passive: true});
  addEventListener('keydown', () => stepClock.input(), {passive: true});
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseBriefCountdown();
    else startBriefCountdown();
    updateBriefCountdown();
  });

  render();
  refresh();
  startPolling();
  connectStream();
  // A WebSocket can remain open while a view update is lost during a page
  // navigation. Reconcile from HTTP after a quiet period instead of leaving
  // the evidence map stale until another action occurs.
  setInterval(() => {
    if (!document.hidden && !view?.feedback && stream?.readyState === WebSocket.OPEN &&
        Date.now() - lastStreamMessage > 12000) refresh();
  }, 12000);
})();
