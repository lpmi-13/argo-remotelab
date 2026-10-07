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
  const demoAttemptsKey = `argo-coach:demo-attempts:${config.session}`;
  let sequence = Number(sessionStorage.getItem(seqKey) || 0);
  let view = JSON.parse(sessionStorage.getItem(initialViewKey) || 'null');
  if (view?.session_id !== config.session) view = null;
  let message = '';
  let error = false;
  let redirecting = false;
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
  let demoAdvance = null;
  let demoWaitResolve = null;
  let restoreAdvanceFocus = false;
  let demoCountdown = null;
  let demoCountdownTicker = null;
  const demoAdvanceDelay = 15000;
  const briefDuration = demoAdvanceDelay;
  let briefRemaining = briefDuration;
  let briefDeadline = null;
  let briefTimer = null;
  let briefTicker = null;
  let pointerTimer = null;
  let demoPatch = JSON.parse(sessionStorage.getItem(demoPatchKey) || 'null');
  let demoNarration = JSON.parse(sessionStorage.getItem(demoNarrationKey) || 'null');
  let demoAttempts = JSON.parse(sessionStorage.getItem(demoAttemptsKey) || 'null');
  let recentLearning = null;
  let evidenceMapOpen = false;
  let demoPatchOpen = false;
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
  const ready = () => ['READY', 'INVESTIGATING', 'FIXED'].includes(view?.state);
  function demoStepId() {
    if (view?.next_check) return view.next_check.id;
    if (view && !view.fixed && view.scenario.level !== 1) return `fix:${view.scenario.id}`;
    return null;
  }
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

  function returnToMissions() {
    if (redirecting) return;
    redirecting = true;
    demoStopped = true;
    cancelDemoDelay();
    clearBriefCountdown();
    clearInterval(pollTimer);
    clearTimeout(reconnectTimer);
    if (stream) { stream.onclose = null; stream.close(); stream = null; }
    for (const key of ['argo-coach:handoff', 'argo-coach:argocd-landing', startedKey, initialViewKey,
      seqKey, collapsedKey, demoPatchKey, demoFixKey, demoNarrationKey, demoAttemptsKey]) sessionStorage.removeItem(key);
    location.replace('/');
  }

  async function request(path, options = {}) {
    const response = await fetch(service + path, {
      ...options,
      headers: {'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json', ...options.headers},
    });
    const data = await response.json();
    if (response.status === 404 && data.error === 'session not found' &&
        (path === sessionPath || path.startsWith(sessionPath + '/'))) returnToMissions();
    if (!response.ok) throw new Error(data.error || `Learning service returned ${response.status}`);
    return data;
  }

  function say(value, isError = false) {
    if (redirecting) return;
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
      demoStopped = true;
      cancelDemoDelay();
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
    scheduleDemo();
  }

  function clearDemoCountdown() {
    demoCountdown = null;
    clearInterval(demoCountdownTicker);
    demoCountdownTicker = null;
    updateDemoCountdown();
  }

  function cancelDemoDelay() {
    clearTimeout(demoTimer);
    demoTimer = null;
    demoAdvance = null;
    restoreAdvanceFocus = false;
    const resolve = demoWaitResolve;
    demoWaitResolve = null;
    clearDemoCountdown();
    resolve?.();
  }

  function updateDemoCountdown() {
    const timer = root.querySelector('[data-demo-timer]');
    if (!timer) return;
    timer.hidden = !demoCountdown;
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

  function startDemoDelay(onComplete) {
    startDemoCountdown(demoAdvanceDelay);
    if (restoreAdvanceFocus) root.querySelector('#demo-advance')?.focus();
    restoreAdvanceFocus = false;
    const countdown = demoCountdown;
    const finish = () => {
      if (demoAdvance !== finish) return;
      restoreAdvanceFocus = shadow.activeElement?.id === 'demo-advance';
      demoAdvance = null;
      clearTimeout(demoTimer);
      demoTimer = null;
      if (demoCountdown === countdown) clearDemoCountdown();
      onComplete();
    };
    demoAdvance = finish;
    demoTimer = setTimeout(finish, demoAdvanceDelay);
  }

  function demoWait() {
    return new Promise(resolve => {
      demoWaitResolve = resolve;
      startDemoDelay(() => { demoWaitResolve = null; resolve(); });
    });
  }

  function demoTimerMarkup() {
    return `<div class="demo-timer" data-demo-timer hidden>
      <div class="demo-timer-top"><span role="timer" aria-label="Time until the next demonstration action">
        <span data-demo-label>Next action in</span> <span data-demo-time><strong data-demo-seconds>0.0</strong>s</span></span>
        <button id="demo-advance" class="secondary demo-advance" type="button" data-action="advance" aria-label="Advance demonstration now">Advance</button></div>
      <div class="demo-timer-track"><span data-demo-fill></span></div></div>`;
  }

  function scheduleDemo() {
    if (demoAdvance || demoBusy || demoStopped || briefOpen || view?.mode !== 'demonstration' ||
        view.feedback || !['READY', 'INVESTIGATING', 'FIXED'].includes(view.state)) return;
    const stepId = demoStepId();
    if (stepId && demoNarration?.id === stepId && demoNarration.phase === 'doing') {
      void driveDemo();
    } else startDemoDelay(driveDemo);
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

  function setDemoNarration(id, phase) {
    demoNarration = {id, phase};
    sessionStorage.setItem(demoNarrationKey, JSON.stringify(demoNarration));
    message = '';
    render();
  }

  function narrateClick(check, detail, reason) {
    if (view?.mode !== 'demonstration') return;
    demoNarration = {id: check.id, phase: 'doing', detail, detailReason: reason || check.demo?.why};
    sessionStorage.setItem(demoNarrationKey, JSON.stringify(demoNarration));
    render();
  }

  function demoExplanation(what, why, label = 'Doing') {
    return `<div class="demo-explanation">
      <div><span>${label}</span><p>${escape(what)}</p></div>
      <div><span>Why</span><p>${escape(why)}</p></div>
    </div>`;
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
          return `<section class="step-card demo-step"><p class="step-count">Repair</p>
            ${demoExplanation(phase === 'learning' ? 'Source change committed. Argo CD is applying it.' :
              view.repair?.demo?.what || view.repair?.action,
              view.repair?.demo?.why || view.repair?.reason,
              phase === 'doing' ? 'Doing' : phase === 'learning' ? 'Sent' : 'Next')}</section>`;
        }
        return `<div class="card step-card"><p class="step-eyebrow">What to do next</p><strong>${escape(view.repair?.action)}</strong>
          <p class="step-eyebrow">Why this repair matters</p><p>${escape(view.repair?.reason)}</p>
          <p class="small muted">After Argo is Healthy and Synced, verify the deployed revision in History.</p>
          ${view.fix_paths.length ? `<p class="small muted">Likely source: ${view.fix_paths.map(path => `<code>${escape(path)}</code>`).join(' ')}</p>` : ''}</div>`;
      }
      return `<p class="muted">Evidence gathered. Write a short incident note to finish the run.</p>`;
    }
    const ready = check.available;
    if (view.mode === 'demonstration') {
      const narration = demoNarration?.id === check.id ? demoNarration : null;
      const found = narration?.phase === 'learning';
      const what = found ? check.demonstration_answer : narration?.phase === 'doing'
        ? narration.detail || check.demo?.what || check.action : check.demo?.what || check.action;
      const why = narration?.phase === 'doing' && narration.detailReason
        ? narration.detailReason : check.demo?.why || check.reason;
      return `<section class="step-card demo-step"><p class="step-count">Step ${view.checks_passed + 1} of ${view.checks_total}</p>
        ${demoExplanation(what, why, found ? 'Found' : narration?.phase === 'doing' ? 'Doing' : 'Next')}</section>`;
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
    return `<details class="demo-patch" ${demoPatchOpen ? 'open' : ''}><summary>Source change</summary>
      <p class="small muted">Argo CD is applying this change.</p>
      <pre aria-label="Demonstration source diff">${escape(demoPatch.diff)}</pre></details>`;
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
    const steps = feedback.debrief_steps || [];
    const replay = new URLSearchParams({scenario: view.scenario.id, mode: view.mode, environment: view.environment});
    const sameSeed = new URLSearchParams(replay);
    if (view.seed != null) sameSeed.set('seed', String(view.seed));
    const lessHelp = new URLSearchParams(replay);
    lessHelp.set('mode', view.mode === 'demonstration' ? 'guided' : 'challenge');
    return `<div class="debrief-content"><h2 id="debrief-title">Debrief${feedback.total == null ? '' : ` · ${escape(feedback.total)} / 100`}</h2>
      ${steps.length ? `<ol class="debrief-steps" aria-label="Steps taken and what we learned">${steps.map(step =>
        `<li><strong>${escape(step.action)}</strong><p>${escape(step.finding)}</p></li>`).join('')}</ol>`
        : '<p class="muted">No steps were recorded for this run.</p>'}
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
      summary: view.brief};
    const started = sessionStorage.getItem(startedKey) === 'true';
    const autoStart = view.mode === 'demonstration' && !started;
    return `<div class="modal-wrap"><div class="modal incident-briefing" role="dialog" aria-modal="true" aria-labelledby="brief-title" tabindex="-1">
      <div class="brief-header"><span class="brief-source">${escape(incident.source)}</span><span class="brief-mode">${escape(view.mode)}</span></div>
      <div class="brief-body"><p class="brief-context">${escape(view.environment)} environment</p>
      <h2 id="brief-title">${escape(incident.headline)}</h2>
      <p class="brief-summary">${escape(incident.summary)}</p></div>
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
    if (root.querySelector('.demo-patch')) demoPatchOpen = root.querySelector('.demo-patch').open;
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
    const showGitSource = view.fix_surface !== 'none' && view.mode !== 'demonstration' && !recentLearning;
    const showTerminal = view.mode !== 'demonstration' &&
      ['git', 'argo-and-git', 'terminal'].includes(view.fix_surface);
    const sourceActions = `${showGitSource ? '<button class="secondary" data-action="gitea">View Git source</button>' : ''}
      ${showTerminal ? `<button class="secondary" data-action="terminal">${!terminalOpen ? 'Open terminal' : terminalMinimized ? 'Restore terminal' : 'Minimize terminal'}</button>` : ''}`;
    const body = preparing ? `<p>Preparing the environment and waiting for Argo CD to show the incident…</p>`
      : view.state === 'FAILED' ? `<p class="message error">${escape(view.run_error || 'The run could not start.')}</p>`
      : view.state === 'ABORTED' ? '<p>The run was stopped.</p><a class="secondary" href="/">Return to missions</a>'
      : `${view.mode === 'demonstration' ? '<p class="driving">✦ Demo running</p>' : ''}
         <h2>${escape(view.briefing?.headline || view.scenario.title)}</h2>
         ${view.alert ? `<div class="message error" role="alert">${escape(view.alert.message)}</div>` : ''}
         ${checkInCard()} ${recentLearning ? learningCard() : checkCard()} ${demoPatchCard()} ${targetList()}
         ${view.feedback || view.mode === 'demonstration' || recentLearning ? '' : view.mode === 'challenge' ? `<div class="actions"><button class="secondary" data-action="incident-info">Incident info</button>
           <button class="secondary" data-action="hint">Hint (assistance recorded)</button><button class="primary" data-action="note">Write incident note</button></div>` :
           `<div class="actions"><button class="secondary" data-action="incident-info">Incident info</button><button class="secondary" data-action="hint">Hint</button>
             <button class="secondary" data-action="show-location">Show me</button>
             ${view.fixed && view.scenario.level !== 1 && !view.feedback ? '<button class="primary" data-action="note">Write incident note</button>' : ''}</div>`}
         ${showGitSource || showTerminal ? `<div class="actions">${sourceActions}</div>` : ''}`;
    const previousValues = new Map(Array.from(root.querySelectorAll('input, textarea')).map(element => [element.id, element.value]));
    const active = shadow.activeElement?.id;
    const stepId = demoStepId();
    const doing = view.mode === 'demonstration' && demoNarration?.id === stepId && demoNarration?.phase === 'doing';
    root.innerHTML = `<aside class="panel" ${collapsed ? 'data-collapsed' : ''} ${doing ? 'data-doing' : ''} aria-label="Argo CD Coach">
      <div class="header panel-controls">
      ${view.mode === 'demonstration' && !['ABORTED', 'COMPLETED', 'FAILED'].includes(view.state) ? '<button class="secondary stop-button" data-action="stop" aria-label="Stop demonstration">Stop</button>' : ''}
      <button class="icon-button" data-action="collapse" aria-label="${collapsed ? 'Expand' : 'Collapse'} coach">${collapsed ? '▣' : '−'}</button></div>
      ${collapsed ? '' : `<div class="body">${body}${message ? `<div class="message ${error ? 'error' : ''}" role="status">${escape(message)}</div>` : ''}${view.mode === 'demonstration' ? demoTimerMarkup() : ''}</div>`}
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
    if (!element) return false;
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  }

  function candidate(text) {
    const phrase = text.toLowerCase();
    return Array.from(document.querySelectorAll('button, a, [role="tab"], [role="button"], [title]'))
      .find(element => visible(element) && [element.textContent, element.getAttribute('title'), element.getAttribute('aria-label')]
        .some(value => (value || '').trim().toLowerCase().includes(phrase)));
  }

  function exactControl(label, scope = document) {
    const matches = element => [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')]
      .some(value => (value || '').trim().toLowerCase() === label.toLowerCase());
    const control = Array.from(scope.querySelectorAll('button, a, [role="tab"], [role="button"]'))
      .find(element => visible(element) && matches(element));
    if (control) return control;
    const text = Array.from(scope.querySelectorAll('*'))
      .find(element => element.childElementCount === 0 && visible(element) && matches(element));
    return text?.closest('button, a, [role="tab"], [role="button"]') || text;
  }

  function resourceScope() {
    return Array.from(document.querySelectorAll('.sliding-panel')).find(visible) ||
      document.querySelector('.application-node-info') || document;
  }

  function selectedControl(element) {
    for (let item = element, depth = 0; item && depth < 4; item = item.parentElement, depth += 1) {
      if (item.matches('[aria-selected="true"], [aria-current="page"], [aria-pressed="true"], [data-state="active"]') ||
          Array.from(item.classList).some(name => /(?:^|[-_])(active|selected|current)$/.test(name))) return true;
    }
    return false;
  }

  function resourceEvidenceReady(check) {
    const drawer = document.querySelector('.application-node-info');
    if (!visible(drawer)) return false;
    const tab = new URL(location.href).searchParams.get('tab')?.toLowerCase();
    if (check.target === 'resource.manifest') {
      const scope = resourceScope();
      const desired = exactControl('Desired Manifest', scope) || exactControl('Desired', scope);
      return Boolean(desired && selectedControl(desired) &&
        Array.from(drawer.querySelectorAll('.application-node-info__manifest--raw')).some(visible));
    }
    const label = {'resource.events': 'Events', 'resource.logs': 'Logs', 'resource.summary': 'Summary'}[check.target];
    const control = exactControl(label, resourceScope());
    return control ? selectedControl(control) :
      tab === label.toLowerCase() || (check.target === 'resource.summary' && !tab);
  }

  function stopDemoAt(check, action) {
    demoStopped = true;
    cancelDemoDelay();
    say(`The demonstration could not open ${action} for ${check.where}. Stop this run and retry.`, true);
    return false;
  }

  function countDemoLocationAttempt(check) {
    const id = `${view.scenario.id}:${check.id}`;
    demoAttempts = {id, count: demoAttempts?.id === id ? demoAttempts.count + 1 : 1};
    sessionStorage.setItem(demoAttemptsKey, JSON.stringify(demoAttempts));
    return demoAttempts.count <= 6 || stopDemoAt(check, check.where);
  }

  function clearDemoLocationAttempts() {
    demoAttempts = null;
    sessionStorage.removeItem(demoAttemptsKey);
  }

  function markDemoTarget(check) {
    if (view?.mode !== 'demonstration' || check.available) return;
    if (typeof observer.visit === 'function') observer.visit(check.target, view.application);
    else sendAction('target_visited', {target: check.target, application: view.application});
  }

  const demoContent = {
    'app.history': '.application-deployment-history',
    'app.conditions': '.application-conditions',
    'app.operation': '.application-operation-state__message, .application-operation-state__icons_container_padding',
    'app.diff': '.application-resources-diff',
    'app.tree': '.application-resource-tree__node-title',
  };

  async function waitForDemoContent(target) {
    const selector = demoContent[target];
    for (let attempt = 0; attempt < 20 && !demoStopped; attempt += 1) {
      if (Array.from(document.querySelectorAll(selector)).some(visible)) return true;
      await sleep(250);
    }
    return false;
  }

  function demoNeedsLocation(check) {
    if (!check.available || check.target.startsWith('resource.')) return true;
    if (check.target === 'settings.repos') return !/\/argocd\/settings\/repos(?:itories)?\/?$/.test(location.pathname);
    if (!location.pathname.includes(`/applications/argocd/${encodeURIComponent(view.application)}`)) return true;
    const selector = demoContent[check.target];
    if (selector) return !Array.from(document.querySelectorAll(selector)).some(visible);
    const appView = {'app.network': 'network', 'app.list': 'list', 'app.pods': 'pods'}[check.target];
    if (appView) {
      const selected = (new URL(location.href).searchParams.get('view') || 'tree').toLowerCase() === appView;
      return !selected && !selectedControl(exactControl(appView));
    }
    return false;
  }

  async function indicateEvidence(check, demonstration) {
    if (demonstration) markDemoTarget(check);
    else {
      const element = evidenceElement(check);
      if (element) { await scrollToTarget(element); spotlight(element); }
      say(check.hint || `Read ${check.where}.`);
    }
    return true;
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
      Array.from(document.querySelectorAll(selectors[check.target] || '.__argo_coach_no_match__')).find(visible) ||
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
      name: node.name, kind: node.kind} : null;
  }

  async function showLocation(demonstration = false) {
    const check = view?.next_check;
    if (!check) { say('Open the affected Application and verify its health and deployed revision.'); return; }
    const target = check.target;
    if (target === 'apps.list' || target === 'apps.filter') {
      if (demonstration && location.pathname.includes(`/applications/argocd/${encodeURIComponent(view.application)}`)) {
        return indicateEvidence(check, true);
      }
      if (!location.pathname.endsWith('/applications')) {
        narrateClick(check, 'Open the Applications list.');
        location.href = '/argocd/applications';
      }
      else if (demonstration) {
        observer.fromURL(location.href);
        await sending;
        let card;
        for (let attempt = 0; attempt < 20 && !card && !demoStopped; attempt += 1) {
          const label = Array.from(document.querySelectorAll('body *')).find(element =>
            element.childElementCount === 0 && element.textContent?.trim() === view.application && visible(element));
          card = label?.closest('a[href]') || label;
          if (!card) await sleep(250);
        }
        if (demoStopped) return;
        if (card) {
          narrateClick(check, `Open the ${view.application} Application from the list.`);
          await pointAt(card, true);
        }
        else location.href = `/argocd/applications/argocd/${encodeURIComponent(view.application)}`;
      } else say(check.hint);
      return;
    }
    if (target === 'settings.repos') {
      if (!/\/argocd\/settings\/repos(?:itories)?\/?$/.test(location.pathname)) {
        narrateClick(check, 'Open Settings → Repositories.');
        location.href = '/argocd/settings/repos';
      } else if (demonstration) {
        const entry = evidenceElement(check);
        observer.fromURL(location.href);
        if (entry) return indicateEvidence(check, true);
      } else say(check.hint);
      return;
    }
    if (!location.pathname.includes(`/applications/argocd/${encodeURIComponent(view.application)}`)) {
      const cardLabel = Array.from(document.querySelectorAll('body *')).find(element =>
        element.childElementCount === 0 && element.textContent?.trim() === view.application && visible(element));
      narrateClick(check, `Open the ${view.application} Application.`);
      if (cardLabel) { await activate(cardLabel, demonstration); return; }
      location.href = `/argocd/applications/argocd/${encodeURIComponent(view.application)}`;
      return;
    }
    if (target === 'app.header' && visible(evidenceElement(check))) {
      return indicateEvidence(check, demonstration);
    }
    const url = new URL(location.href);
    const panel = {'app.history': ['rollback', '0'], 'app.conditions': ['conditions', 'true'],
      'app.operation': ['operation', 'true']};
    if (panel[target]) {
      const [name, value] = panel[target];
      if (Array.from(document.querySelectorAll(demoContent[target])).some(visible)) {
        return indicateEvidence(check, demonstration);
      }
      if (url.searchParams.get(name) !== value) {
        const label = {'app.history': 'History and Rollback', 'app.conditions': 'Conditions',
          'app.operation': 'Sync Status'}[target];
        const control = exactControl(label) || candidate(label);
        if (selectedControl(control)) return false;
        narrateClick(check, `Open ${label} on ${view.application}.`);
        if (demonstration && control) {
          await activate(control, true);
          if (await waitForDemoContent(target)) return indicateEvidence(check, true);
          return stopDemoAt(check, label);
        }
        url.searchParams.set(name, value); location.href = url.href; return;
      }
      return false;
    }
    const appView = {'app.tree': 'tree', 'app.network': 'network', 'app.list': 'list', 'app.pods': 'pods'}[target];
    if (appView) {
      const control = exactControl(appView) || candidate(appView);
      if ((url.searchParams.get('view') || 'tree').toLowerCase() !== appView && !selectedControl(control)) {
        narrateClick(check, `Switch ${view.application} to the ${appView} view.`);
        if (demonstration && control) {
          await activate(control, true);
          if (target === 'app.tree') {
            if (await waitForDemoContent(target)) return indicateEvidence(check, true);
            return stopDemoAt(check, `${appView} view`);
          }
          for (let attempt = 0; attempt < 20 && !demoStopped; attempt += 1) {
            if ((new URL(location.href).searchParams.get('view') || 'tree').toLowerCase() === appView ||
                selectedControl(exactControl(appView))) return indicateEvidence(check, true);
            await sleep(250);
          }
          return stopDemoAt(check, `${appView} view`);
        }
        url.searchParams.set('view', appView);
        location.href = url.href;
        return;
      }
      if (visible(evidenceElement(check)) &&
          (target !== 'app.tree' || Array.from(document.querySelectorAll(demoContent[target])).some(visible))) {
        return indicateEvidence(check, demonstration);
      }
      return false;
    }
    if (target === 'app.diff') {
      const control = exactControl('Diff') || candidate('Diff');
      if (url.searchParams.get('tab') !== 'diff' && url.searchParams.get('view') !== 'diff' &&
          !selectedControl(control) && !Array.from(document.querySelectorAll(demoContent[target])).some(visible)) {
        narrateClick(check, `Open Diff on ${view.application}.`);
        if (demonstration && control) {
          await activate(control, true);
          if (await waitForDemoContent(target)) return indicateEvidence(check, true);
          return stopDemoAt(check, 'Diff');
        }
        url.searchParams.set('node', `argoproj.io/Application/argocd/${view.application}/0`);
        url.searchParams.set('tab', 'diff');
        location.href = url.href;
        return;
      }
      observer.fromURL(location.href);
      if (Array.from(document.querySelectorAll(demoContent[target])).some(visible)) {
        return indicateEvidence(check, demonstration);
      }
      return false;
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
          const nodeSelected = () => new URL(location.href).searchParams.get('node') === node.id;
          if (!nodeSelected()) {
            // The tree often contains Service/django and Deployment/django.
            // A name-only click can open the wrong resource and loop forever.
            const titles = Array.from(document.querySelectorAll('.application-resource-tree__node-title'))
              .filter(element => visible(element) && element.textContent?.trim() === node.name);
            if (titles.length === 1) {
              narrateClick(check, `Open ${node.kind}/${node.name} in ${view.application}'s Tree.`);
              await activate(titles[0], demonstration);
              for (let attempt = 0; attempt < 20 && !nodeSelected() && !demoStopped; attempt += 1) await sleep(250);
            }
            if (demoStopped) return false;
          }
          if (!nodeSelected()) {
            const destination = new URL(location.href);
            destination.searchParams.set('node', node.id);
            destination.searchParams.set('tab', ({'resource.events': 'events', 'resource.logs': 'logs',
              'resource.manifest': 'manifest', 'resource.summary': 'summary'})[target]);
            if (destination.href !== location.href) {
              narrateClick(check, `Open ${node.kind}/${node.name} in ${view.application}'s Tree.`);
              location.href = destination.href;
            }
            return false;
          }
          if (resourceEvidenceReady(check)) return indicateEvidence(check, demonstration);
          if (target === 'resource.manifest') {
            const scope = resourceScope();
            let desired = exactControl('Desired Manifest', scope) || exactControl('Desired', scope);
            if (!desired) {
              const manifest = exactControl('Manifest', scope);
              if (manifest && !selectedControl(manifest)) {
                narrateClick(check, `Open Manifest on ${node.kind}/${node.name}.`);
                await activate(manifest, demonstration);
              }
              for (let attempt = 0; attempt < 20 && !desired && !demoStopped; attempt += 1) {
                desired = exactControl('Desired Manifest', resourceScope()) ||
                  exactControl('Desired', resourceScope());
                if (!desired) await sleep(250);
              }
            }
            if (desired && !selectedControl(desired)) {
              narrateClick(check, `Open Desired Manifest on ${node.kind}/${node.name}.`);
              await activate(desired, demonstration);
            }
          } else {
            const label = {'resource.events': 'Events', 'resource.logs': 'Logs',
              'resource.summary': 'Summary'}[target];
            const tab = exactControl(label, resourceScope());
            if (tab && !selectedControl(tab)) {
              narrateClick(check, `Open ${label} on ${node.kind}/${node.name}.`);
              await activate(tab, demonstration);
            }
          }
          for (let attempt = 0; attempt < 20 && !demoStopped; attempt += 1) {
            if (nodeSelected() && resourceEvidenceReady(check)) return indicateEvidence(check, demonstration);
            await sleep(250);
          }
          if (demonstration) return stopDemoAt(check, target === 'resource.manifest' ? 'Desired Manifest' :
            {'resource.events': 'Events', 'resource.logs': 'Logs', 'resource.summary': 'Summary'}[target]);
          const destination = new URL(location.href);
          destination.searchParams.set('node', node.id);
          destination.searchParams.set('tab', ({'resource.events': 'events', 'resource.logs': 'logs',
            'resource.manifest': 'manifest', 'resource.summary': 'summary'})[target]);
          if (destination.href !== location.href) location.href = destination.href;
          return false;
        }
      } catch (_) { /* Keep the on-screen pointer when the tree is unavailable. */ }
    }
    const labels = {"app.history": 'History', "app.conditions": 'Conditions', "app.operation": 'Sync Status',
      "app.diff": 'Diff', "resource.events": 'Events', "resource.logs": 'Logs',
      "resource.manifest": 'Desired', "app.tree": 'Tree'};
    const element = candidate(labels[target] || target.split('.')[1]);
    if (element) {
      if (demonstration) {
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

  async function showDemoFinding(check) {
    clearDemoLocationAttempts();
    const element = evidenceElement(check);
    if (element) await pointAt(element);
    if (demoStopped || view.next_check?.id !== check.id) return;
    setDemoNarration(check.id, 'learning');
    await demoWait();
    if (demoStopped || view.next_check?.id !== check.id) return;
    await answerCheck(check.demonstration_answer);
  }

  async function driveDemo() {
    if (demoBusy || demoStopped || briefOpen || !view || !['READY', 'INVESTIGATING', 'FIXED'].includes(view.state) || view.feedback) return;
    demoBusy = true;
    try {
      const expectedStep = demoStepId();
      await sending;
      if (demoStopped || view.feedback || !ready() || expectedStep !== demoStepId()) return;
      const check = view.next_check;
      if (check) {
        if (demoNeedsLocation(check)) {
          if (!countDemoLocationAttempt(check)) return;
          const readyNow = await showLocation(true);
          await sending;
          if (!demoStopped) await refresh();
          if (readyNow && view.next_check?.id === check.id && view.next_check.available &&
              check.demonstration_answer) await showDemoFinding(check);
        } else if (check.demonstration_answer) {
          await showDemoFinding(check);
        }
      } else if (!view.fixed && view.scenario.level !== 1 && !demoFixStarted) {
        demoFixStarted = true;
        sessionStorage.setItem(demoFixKey, 'true');
        const fixStep = `fix:${view.scenario.id}`;
        setDemoNarration(fixStep, 'doing');
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
        setDemoNarration(fixStep, 'learning');
        await demoWait();
        if (!demoStopped) await refresh();
      } else if (view.fixed && view.checks_passed >= view.checks_total) {
        say('Writing the incident note.');
        await demoWait();
        if (demoStopped) return;
        const note = view.demonstration_note || {};
        await submitNote({resource: note.resource || view.application, evidence: note.evidence || 'Healthy and Synced',
          revision: note.revision || view.revision, cause: note.cause || 'No incident', fix: note.fix || 'No fix needed'});
      } else await refresh();
    } catch (reason) { say(reason.message, true); }
    finally {
      if (!demoStopped && demoNarration?.phase === 'doing' && demoNarration.id === demoStepId()) {
        // The action returned without advancing this step. Show the next reading beat
        // locally; keep the persisted Doing phase so a page navigation resumes the action.
        demoNarration = {id: demoNarration.id, phase: 'what'};
        render();
      }
      demoBusy = false;
      scheduleDemo();
    }
  }

  root.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'retry-session') refresh();
    else if (action === 'begin') beginInvestigation();
    else if (action === 'advance') demoAdvance?.();
    else if (action === 'continue-step') { recentLearning = null; render(); scheduleDemo(); }
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
      cancelDemoDelay();
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
