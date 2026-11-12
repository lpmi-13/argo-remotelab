(function initialize() {
  // The first authenticated Argo page is replaced after login. Starting its
  // countdown there would consume the briefing before the visible page loads.
  if (window.ArgoCoachBootstrap?.authPending) {
    addEventListener('argo-coach:auth-failed', initialize, {once: true});
    return;
  }
  /** @type {CoachHandoff | null} */
  const config = JSON.parse(sessionStorage.getItem('argo-coach:handoff') || 'null');
  if (!config?.session || !config?.token) return;
  const service = '/coach/learning';
  const sessionPath = `/api/sessions/${encodeURIComponent(config.session)}`;
  const startedKey = `argo-coach:started:${config.session}`;
  const initialViewKey = `argo-coach:initial-view:${config.session}`;
  const seqKey = `argo-coach:sequence:${config.session}`;
  const collapsedKey = `argo-coach:collapsed:${config.session}`;
  const positionKey = `argo-coach:position:${config.session}`;
  const demoPatchKey = `argo-coach:demo-patch:${config.session}`;
  const demoFixKey = `argo-coach:demo-fix-started:${config.session}`;
  const demoRepairKey = `argo-coach:demo-repair:${config.session}`;
  const demoNarrationKey = `argo-coach:demo-narration:${config.session}`;
  const demoAttemptsKey = `argo-coach:demo-attempts:${config.session}`;
  const demoPausedKey = `argo-coach:demo-paused:${config.session}`;
  const debriefDismissedKey = `argo-coach:debrief-dismissed:${config.session}`;
  let sequence = Number(sessionStorage.getItem(seqKey) || 0);
  /** @type {SessionView | null} */
  let view = JSON.parse(sessionStorage.getItem(initialViewKey) || 'null');
  if (view?.session_id !== config.session) view = null;
  let message = '';
  let error = false;
  let redirecting = false;
  let replaying = false;
  let replayError = '';
  let briefOpen = !sessionStorage.getItem(startedKey);
  let noteOpen = false;
  // Learners may close the final debrief to keep exploring the lab; the
  // completed-mission panel reopens it.
  let debriefDismissed = sessionStorage.getItem(debriefDismissedKey) === 'true';
  let collapsed = sessionStorage.getItem(collapsedKey) === 'true';
  const savedPosition = JSON.parse(sessionStorage.getItem(positionKey) || 'null');
  /** @type {{x: number, y: number} | null} */
  let panelPosition = savedPosition && Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y)
    ? savedPosition : null;
  /** Where the coach moved to keep a highlighted control visible. @type {{x: number, y: number} | null} */
  let clearPosition = null;
  /** The step clearPosition was chosen for. @type {string | null} */
  let clearStep = null;
  /** @typedef {{id: string, quote: string, where: string, text: string}} ArgoNote */
  /** What Argo CD shows that the coach is explaining, with the step each was last seen in. @type {(ArgoNote & {step: string | null})[]} */
  let argoNotes = [];
  /** Notes a demonstration has already held its countdown for, by note and step. @type {Set<string>} */
  const heldNotes = new Set();
  const argoNoticeReadDelay = 8000;
  let nativeOverlayOpen = false;
  let autoCollapsed = false;
  let hintVisible = false;
  let demoBusy = false;
  let demoNavigating = false;
  let demoFixStarted = sessionStorage.getItem(demoFixKey) === 'true';
  let demoStopped = false;
  let demoPaused = sessionStorage.getItem(demoPausedKey) === 'true';
  let demoTimer = null;
  let demoAdvance = null;
  let demoWaitResolve = null;
  let restoreAdvanceFocus = false;
  let demoCountdown = null;
  let demoCountdownTicker = null;
  const demoAdvanceDelay = 15000;
  const demoTypingDelay = 35;
  let noteSubmissions = 0;
  const evidenceLocateDelay = 4000;
  const briefDuration = demoAdvanceDelay;
  let briefRemaining = briefDuration;
  let briefDeadline = null;
  let briefTimer = null;
  let briefTicker = null;
  let pointerTimer = null;
  /** @type {DemoPatch | null} */
  let demoPatch = JSON.parse(sessionStorage.getItem(demoPatchKey) || 'null');
  /** @type {DemoRepair | null} */
  let demoRepair = JSON.parse(sessionStorage.getItem(demoRepairKey) || 'null');
  /** @type {DemoNarration | null} */
  let demoNarration = JSON.parse(sessionStorage.getItem(demoNarrationKey) || 'null');
  /** @type {DemoAttempts | null} */
  let demoAttempts = JSON.parse(sessionStorage.getItem(demoAttemptsKey) || 'null');
  /** @type {{answer: string, explanation: string} | null} */
  let recentLearning = null;
  let evidenceMapOpen = false;
  let demoPatchOpen = false;
  let terminalOpen = false;
  let terminalMinimized = false;
  let checkInOpen = false;
  let guidedLocationTasks = 0;
  let sending = Promise.resolve();
  /** @type {WebSocket | null} */
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
  /** @param {number} ms @returns {Promise<void>} */
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ready = () => ['READY', 'INVESTIGATING', 'FIXED'].includes(view?.state);
  /** @param {string} [commit] */
  const gitCommitURL = commit => /^[0-9a-f]{40}$/.test(commit || '')
    ? `/gitea/remotelab/django-app/commit/${commit}` : null;
  /** @param {DemoRepair | null} next */
  function saveDemoRepair(next) {
    demoRepair = next;
    if (next) sessionStorage.setItem(demoRepairKey, JSON.stringify(next));
    else sessionStorage.removeItem(demoRepairKey);
  }
  /** The repair step a demonstration is performing, until the repair is done or falls back. */
  function repairStep() {
    if (!demoRepair || demoRepair.fellBack || view?.mode !== 'demonstration' || view.feedback) return null;
    return demoRepair.plan.steps[demoRepair.step] || null;
  }
  function demoStepId() {
    if (repairStep()) return `repair:${demoRepair.step}`;
    if (view?.next_check) return view.next_check.id;
    if (view && !view.fixed && view.scenario.level !== 1) return `fix:${view.scenario.id}`;
    return null;
  }
  const stepClock = new window.GuidedStepClock({
    isPaused: () => document.hidden || briefOpen || noteOpen || checkInOpen || guidedLocationTasks > 0 || collapsed ||
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

  function leaveCurrentSession() {
    redirecting = true;
    demoStopped = true;
    cancelDemoDelay();
    clearBriefCountdown();
    clearInterval(pollTimer);
    clearTimeout(reconnectTimer);
    if (stream) { stream.onclose = null; stream.close(); stream = null; }
    for (const key of ['argo-coach:handoff', 'argo-coach:argocd-landing', startedKey, initialViewKey,
      seqKey, collapsedKey, positionKey, demoPatchKey, demoFixKey, demoRepairKey, demoNarrationKey,
      demoAttemptsKey, demoPausedKey, debriefDismissedKey]) sessionStorage.removeItem(key);
  }

  function returnToMissions() {
    if (redirecting) return;
    leaveCurrentSession();
    location.replace('/');
  }

  async function replayMission() {
    if (replaying || !view?.feedback) return;
    replaying = true;
    replayError = '';
    render();
    try {
      /** @type {RunCreatedResponse} */
      const result = await request('/api/runs', {method: 'POST', body: JSON.stringify({
        scenario: view.scenario.id, mode: view.mode, environment: view.environment, replace_existing: true,
      })});
      const {run, session} = result;
      if (!run?.id || !session?.session_id || !session?.connection_token) {
        throw new Error('The new mission could not be prepared.');
      }
      const {connection_token: token, ...initialView} = session;
      leaveCurrentSession();
      sessionStorage.setItem(`argo-coach:initial-view:${session.session_id}`, JSON.stringify(initialView));
      sessionStorage.setItem('argo-coach:preparing', JSON.stringify({
        run_id: run.id, session_id: session.session_id, token, mode: session.mode,
      }));
      location.assign('/preparing.html');
    } catch (reason) {
      replaying = false;
      replayError = reason.message;
      render();
      root.querySelector('[data-action="replay"]')?.focus();
    }
  }

  /**
   * Calls the learning service with the session token. The JSON is untyped;
   * callers declare the response type they expect.
   * @param {string} path
   * @param {RequestInit} [options]
   * @returns {Promise<any>}
   */
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

  /** @param {string} value @param {boolean} [isError] */
  function say(value, isError = false) {
    if (redirecting) return;
    message = value;
    error = isError;
    render();
  }

  /** @type {(type: string, details?: Record<string, any>) => Promise<void>} */
  function sendAction(type, details = {}) {
    // The run is scored. Exploring after the debrief must not add evidence or
    // coaching messages to a finished mission.
    if (view?.feedback) return sending;
    sequence += 1;
    sessionStorage.setItem(seqKey, String(sequence));
    const action = {protocol_version: 2, sequence, type, actor: view?.mode === 'demonstration' ? 'tutorial' : 'learner',
      observed_at: new Date().toISOString(), details};
    sending = sending.catch(() => {}).then(async () => {
      /** @type {ActionResponse} */
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
      if (view?.scenario.level === 1 && view.feedback) {
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
    // The drawer layout places the coach beside it; drop any spot chosen for the page underneath.
    if (clearPosition) { clearPosition = null; render(); }
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
  // What Argo CD shows during a comparison failure that can look like a second
  // fault or contradict the error. Demonstration and Guided explain each one
  // beside the step and keep the coach off it, so what Argo shows and its
  // meaning can be read together. Challenge leaves them to the learner.
  const argoPopups = [{pattern: /revision \S+ must be resolved/i,
    text: 'Argo CD shows this while it cannot compare the newest commit.'}];
  const argoNoteOrder = ['popup', 'sync-ok'];

  /** @param {Element} toast */
  const toastText = toast => (toast.querySelector('.Toastify__toast-body') || toast).textContent.replace(/\s+/g, ' ').trim();

  function argoToasts() {
    return Array.from(document.querySelectorAll('.Toastify__toast')).filter(visible);
  }

  /** @param {string} title An Application header item's heading, such as LAST SYNC. */
  function statusItem(title) {
    return Array.from(document.querySelectorAll('.application-status-panel__item'))
      .find(item => visible(item) && item.textContent.trim().toUpperCase().startsWith(title));
  }

  /** @param {DOMRect} box */
  const padded = box => ({left: box.left - 4, top: box.top - 4, right: box.right + 4, bottom: box.bottom + 4});

  const explainingArgo = () => Boolean(view) && view.mode !== 'challenge' && !view.feedback;

  /** @returns {(ArgoNote & {element: Element})[]} */
  function argoNotesOnScreen() {
    /** @type {(ArgoNote & {element: Element})[]} */
    const notes = [];
    for (const toast of argoToasts()) {
      const quote = toastText(toast);
      const known = argoPopups.find(popup => popup.pattern.test(quote));
      if (known) {
        notes.push({id: 'popup', quote, where: 'popup', text: known.text, element: toast});
        break;
      }
    }
    // The last successful sync was of an earlier commit; the error is about the newest one.
    const lastSync = statusItem('LAST SYNC');
    if (lastSync && /\bSync OK\b/.test(lastSync.textContent) &&
        /\b\d+\s+Errors?\b/.test(statusItem('APP CONDITIONS')?.textContent || '')) {
      notes.push({id: 'sync-ok', quote: 'Sync OK', where: 'under Last Sync', element: lastSync,
        text: 'That sync was of an earlier commit. Argo CD cannot sync the newest one until it can compare it.'});
    }
    return notes;
  }

  // A note stays for the rest of the step after Argo stops showing what it explains.
  function syncArgoNotes() {
    const step = demoStepId();
    const onScreen = explainingArgo() ? argoNotesOnScreen() : [];
    const earlier = explainingArgo()
      ? argoNotes.filter(note => note.step === step && !onScreen.some(seen => seen.id === note.id)) : [];
    argoNotes = [...onScreen.map(({element, ...note}) => ({...note, step})), ...earlier]
      .sort((a, b) => argoNoteOrder.indexOf(a.id) - argoNoteOrder.indexOf(b.id));
    return onScreen;
  }

  function argoNoticeMarkup() {
    if (!argoNotes.length) return '';
    // A learner's commit can also break rendering; the coach's alert reports that case.
    const heading = view.alert?.reason_code === 'fix_broke_render' ? 'From the comparison error' : 'Expected in this scenario';
    return `<section class="argo-notice" role="note" aria-label="${heading}"><p class="step-eyebrow">${heading}</p>
      <ul>${argoNotes.map(note => `<li><q>${escape(note.quote)}</q> <span>${escape(note.where)}</span>
        <p>${escape(note.text)}</p></li>`).join('')}</ul></section>`;
  }

  /** Argo CD's confirmation dialogs on screen, such as Terminate's and Prune's. */
  const argoDialogs = () => Array.from(document.querySelectorAll('.popup-container'))
    .filter(visible).map(element => padded(element.getBoundingClientRect()));

  /**
   * Where Argo shows its popups and what the coach explains. An open drawer covers the header.
   * A toast slides in from off screen, so keep clear of its container, where it comes to rest.
   */
  function argoAreas(onScreen = explainingArgo() ? argoNotesOnScreen() : []) {
    if (!explainingArgo()) return [];
    return [...argoToasts().map(toast => {
      const container = toast.closest('.Toastify__toast-container');
      const box = container?.getBoundingClientRect();
      return box?.width && box.height ? container : toast;
    }),
      ...(nativeOverlayOpen ? [] : onScreen.filter(note => note.id !== 'popup').map(note => note.element))]
      .map(element => padded(element.getBoundingClientRect()));
  }

  /** @param {(ArgoNote & {element: Element})[]} onScreen */
  function settleArgoNotes(onScreen) {
    if (!explainingArgo()) return;
    const areas = argoAreas(onScreen);
    if (areas.length) {
      const target = root.querySelector('.spotlight')?.getBoundingClientRect();
      keepPanelClear(...(target ? [target] : []), ...areas);
    }
    const step = demoStepId();
    for (const note of onScreen) {
      const key = `${note.id}|${step}`;
      if (heldNotes.has(key)) continue;
      heldNotes.add(key);
      if (view.mode === 'demonstration') holdDemoCountdown(argoNoticeReadDelay);
    }
  }

  function updateArgoNotice() {
    const before = argoNoticeMarkup();
    const onScreen = syncArgoNotes();
    if (argoNoticeMarkup() !== before) {
      // Patch only this block: a full render would drop a highlight the demo is showing.
      const slot = root.querySelector('[data-argo-notice]');
      if (slot) {
        slot.innerHTML = argoNoticeMarkup();
        fitPanel();
      }
    }
    settleArgoNotes(onScreen);
  }

  function endCompactPanel() {
    if (!host.hasAttribute('data-compact') || argoDialogs().length) return;
    host.removeAttribute('data-compact');
    if (clearPosition) { clearPosition = null; render(); }
  }

  const nativeOverlayObserver = new MutationObserver(() => { updateNativeOverlay(); updateArgoNotice(); endCompactPanel(); });
  nativeOverlayObserver.observe(document.body, {childList: true, subtree: true,
    attributes: true, attributeFilter: ['class', 'style', 'aria-hidden']});
  updateNativeOverlay();

  /** @param {SessionView} nextView @param {boolean} [preserveMessage] */
  function applyView(nextView, preserveMessage = false) {
    // HTTP and WebSocket responses can finish out of order during preparation.
    if (view?.run_updated_at && nextView.run_updated_at &&
        Date.parse(nextView.run_updated_at) < Date.parse(view.run_updated_at)) return;
    if (!view && !preserveMessage) { message = ''; error = false; }
    view = nextView;
    // Argo can reload the page mid-run. Keep the cached view current so the
    // coach resumes at this step instead of showing the first one until the
    // next poll.
    sessionStorage.setItem(initialViewKey, JSON.stringify(view, (key, value) =>
      key === 'connection_token' ? undefined : value));
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
      : demoPaused ? 'Demonstration paused. Time remaining:' : 'Demonstration starts automatically in';
    /** @type {HTMLElement} */
    const seconds = progress.querySelector('[data-brief-seconds]');
    seconds.hidden = waiting;
    seconds.textContent = `${Math.ceil(remaining / 1000)}s`;
    progress.querySelector('[data-brief-fill]').style.width = `${100 * (1 - remaining / briefDuration)}%`;
    const bar = progress.querySelector('[role="progressbar"]');
    if (waiting) {
      bar.removeAttribute('aria-valuenow');
      bar.setAttribute('aria-valuetext', 'Preparing the lab');
    } else {
      bar.setAttribute('aria-valuenow', String(Math.round(100 * (1 - remaining / briefDuration))));
      bar.setAttribute('aria-valuetext', `${Math.ceil(remaining / 1000)} seconds remaining${demoPaused ? '; demonstration paused' : ' until demonstration starts'}`);
    }
  }

  function startBriefCountdown() {
    if (!briefOpen || view?.mode !== 'demonstration' || !ready() || view.feedback ||
        demoStopped || demoPaused || document.hidden || briefDeadline !== null || sessionStorage.getItem(startedKey)) return;
    briefDeadline = performance.now() + briefRemaining;
    briefTimer = setTimeout(beginInvestigation, briefRemaining);
    briefTicker = setInterval(updateBriefCountdown, 100);
    updateBriefCountdown();
  }

  function beginInvestigation() {
    if (!ready()) return;
    if (demoPaused) setDemoPaused(false);
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
    /** @type {HTMLElement} */
    const timer = root.querySelector('[data-demo-timer]');
    if (!timer) return;
    timer.hidden = !demoCountdown;
    if (!demoCountdown) return;
    const remaining = demoCountdown.deadline === null ? demoCountdown.remaining :
      Math.max(0, demoCountdown.deadline - performance.now());
    timer.querySelector('[data-demo-label]').textContent = demoPaused ? 'Paused · next action in' : 'Next action in';
    timer.querySelector('[data-demo-seconds]').textContent = (remaining / 1000).toFixed(1);
    timer.querySelector('[data-demo-fill]').style.width = `${100 * (1 - remaining / demoCountdown.duration)}%`;
    /** @type {HTMLButtonElement} */ (timer.querySelector('[data-action="advance"]')).disabled = demoPaused;
  }

  function pauseDemoDelay() {
    if (!demoCountdown || demoCountdown.deadline === null) return;
    demoCountdown.remaining = Math.max(0, demoCountdown.deadline - performance.now());
    demoCountdown.deadline = null;
    clearTimeout(demoTimer);
    clearInterval(demoCountdownTicker);
    demoTimer = null;
    demoCountdownTicker = null;
    updateDemoCountdown();
  }

  function resumeDemoDelay() {
    if (!demoCountdown || demoCountdown.deadline !== null || demoPaused || document.hidden) return;
    demoCountdown.deadline = performance.now() + demoCountdown.remaining;
    demoTimer = setTimeout(demoAdvance, demoCountdown.remaining);
    demoCountdownTicker = setInterval(updateDemoCountdown, 100);
    updateDemoCountdown();
  }

  // Leave time to read an explanation that appears late in a countdown.
  /** @param {number} duration */
  function holdDemoCountdown(duration) {
    if (!demoCountdown || !demoAdvance) return;
    const remaining = demoCountdown.deadline === null ? demoCountdown.remaining :
      Math.max(0, demoCountdown.deadline - performance.now());
    if (remaining >= duration) return;
    demoCountdown.duration += duration - remaining;
    demoCountdown.remaining = duration;
    if (demoCountdown.deadline !== null) {
      demoCountdown.deadline = performance.now() + duration;
      clearTimeout(demoTimer);
      demoTimer = setTimeout(demoAdvance, duration);
    }
    updateDemoCountdown();
  }

  /** @param {boolean} paused */
  function setDemoPaused(paused) {
    if (demoPaused === paused) return;
    demoPaused = paused;
    sessionStorage.setItem(demoPausedKey, String(paused));
    if (paused) {
      pauseBriefCountdown();
      pauseDemoDelay();
    }
    render();
    if (!paused) {
      startBriefCountdown();
      resumeDemoDelay();
      scheduleDemo();
    }
  }

  /** @param {number} duration */
  function startDemoCountdown(duration) {
    clearInterval(demoCountdownTicker);
    demoCountdown = {duration, remaining: duration, deadline: null};
    updateDemoCountdown();
  }

  /** @param {() => void} onComplete @param {number} [duration] */
  function startDemoDelay(onComplete, duration = demoAdvanceDelay) {
    startDemoCountdown(duration);
    if (restoreAdvanceFocus) root.querySelector('#demo-advance')?.focus();
    restoreAdvanceFocus = false;
    const countdown = demoCountdown;
    const finish = () => {
      if (demoAdvance !== finish) return;
      if (demoPaused || document.hidden) { pauseDemoDelay(); return; }
      restoreAdvanceFocus = shadow.activeElement?.id === 'demo-advance';
      demoAdvance = null;
      clearTimeout(demoTimer);
      demoTimer = null;
      if (demoCountdown === countdown) clearDemoCountdown();
      onComplete();
    };
    demoAdvance = finish;
    resumeDemoDelay();
  }

  /** @param {number} [duration] @returns {Promise<void>} */
  function demoWait(duration = demoAdvanceDelay) {
    return new Promise(resolve => {
      demoWaitResolve = resolve;
      startDemoDelay(() => { demoWaitResolve = null; resolve(); }, duration);
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
    if (demoAdvance || demoBusy || demoNavigating || demoStopped || demoPaused || document.hidden || briefOpen || view?.mode !== 'demonstration' ||
        view.feedback || !['READY', 'INVESTIGATING', 'FIXED'].includes(view.state)) return;
    const stepId = demoStepId();
    if (repairStep()) {
      // A step that loaded a new page carries on there; others wait to be read first.
      if (demoRepair.stage && !repairReadingStages.has(demoRepair.stage)) void driveDemo();
      else startDemoDelay(driveDemo);
    } else if (stepId && demoNarration?.id === stepId && ['doing', 'locate'].includes(demoNarration.phase)) {
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

  /** @param {string} id @param {DemoNarration['phase']} phase */
  function setDemoNarration(id, phase) {
    demoNarration = {id, phase};
    sessionStorage.setItem(demoNarrationKey, JSON.stringify(demoNarration));
    message = '';
    render();
  }

  /** @param {NextCheck} check @param {string} detail @param {string} [reason] */
  function narrateClick(check, detail, reason) {
    if (view?.mode !== 'demonstration') return;
    demoNarration = {id: check.id, phase: 'doing', detail, detailReason: reason || check.demo?.why};
    sessionStorage.setItem(demoNarrationKey, JSON.stringify(demoNarration));
    render();
  }

  /** @param {string} what @param {string} why @param {string} [label] */
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
    const step = view.mode === 'demonstration' ? repairStep() : null;
    if (step) {
      // Narration for this step: what is being done now, or what was found.
      const narration = demoNarration?.id === demoStepId() ? demoNarration : null;
      const label = narration?.phase === 'doing' ? 'Doing' : narration?.phase === 'learning' ? 'Found' : 'Next';
      return `<section class="step-card demo-step"><p class="step-count">Repair · step ${demoRepair.step + 1} of ${demoRepair.plan.steps.length}</p>
        ${demoExplanation(narration?.detail || step.what, narration?.detailReason || step.why, label)}</section>`;
    }
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
      return `<p class="muted">${view.scenario.level === 1 ? 'Evidence gathered. Finishing this mission…' : 'Evidence gathered. Write a short incident note to finish the run.'}</p>`;
    }
    const ready = check.available;
    if (view.mode === 'demonstration') {
      const narration = demoNarration?.id === check.id ? demoNarration : null;
      const found = narration?.phase === 'learning';
      const orientationRevision = view.scenario.id === 'console-orientation' && check.id === 'revision';
      const unhealthyPod = view.scenario.id === 'console-unhealthy-version' && check.id === 'ready-pod';
      const unhealthyRevision = view.scenario.id === 'console-unhealthy-version' && check.id === 'revision';
      const locating = Boolean(check.demo?.look) && narration?.phase === 'locate';
      const what = found ? (orientationRevision ? `Revision: ${check.demonstration_answer}`
        : unhealthyPod ? 'One Healthy Pod; the new Pod is unready.'
        : unhealthyRevision ? `Serving revision: ${String(check.demonstration_answer).slice(0, 7)}`
        : check.demonstration_answer)
        : locating ? check.demo.look : narration?.phase === 'doing'
        ? narration.detail || check.demo?.what || check.action : check.demo?.what || check.action;
      const why = found && check.learning ? check.learning : narration?.phase === 'doing' && narration.detailReason
        ? narration.detailReason : check.demo?.why || check.reason;
      return `<section class="step-card demo-step"><p class="step-count">Step ${view.checks_passed + 1} of ${view.checks_total}</p>
        ${demoExplanation(what, why, found ? 'Found' : locating ? 'Look' : narration?.phase === 'doing' ? 'Doing' : 'Next')}</section>`;
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
      <p class="small muted">Argo CD is applying this change.${gitCommitURL(demoPatch.commit) ?
        ` <a href="${gitCommitURL(demoPatch.commit)}">View commit ${escape(demoPatch.commit.slice(0, 10))} in Git</a>.` : ''}</p>
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
    const outcome = view.scenario.level === 1
      ? feedback.fixed ? 'Release evidence verified.' : 'Unhealthy release evidence verified.'
      : !feedback.fixed ? 'The deployment still needs repair.' : feedback.durable
        ? 'The deployment recovered and the repair is in the deployed Git revision.'
        : 'The deployment recovered, but the repair is not in the deployed Git revision.';
    /** @type {[string, keyof ScoreBreakdown, number][]} */
    const scoreParts = [
      ['Remediation', 'remediation', 35], ['Console evidence', 'console_evidence', 25],
      ['Diagnosis', 'diagnosis', 20], ['Operating practice', 'operational_practice', 10],
      ['Efficiency', 'efficiency', 10],
    ];
    /** @type {Partial<Truth>} */
    const reference = feedback.truth || {};
    const referenceParts = [['Cause', reference.cause], ['Evidence', reference.evidence], ['Repair', reference.fix]]
      .filter(([, value]) => value);
    const hints = Number(feedback.assistance?.hints || 0);
    const demonstrations = Number(feedback.assistance?.show_me || 0);
    const lessHelp = new URLSearchParams({scenario: view.scenario.id, mode: view.mode,
      environment: view.environment});
    lessHelp.set('mode', view.mode === 'demonstration' ? 'guided' : 'challenge');
    const nextScenario = view.next_scenario && new URLSearchParams({
      scenario: view.next_scenario, mode: view.mode, environment: view.environment,
    });
    return `<div class="debrief-content"><div class="debrief-header"><h2 id="debrief-title">Debrief${feedback.total == null ? '' : ` · ${escape(feedback.total)} / 100`}</h2>
        <button class="icon-button" type="button" data-action="dismiss-debrief" aria-label="Close debrief and explore the lab" title="Close debrief and explore the lab">×</button></div>
      <p class="debrief-outcome">${escape(outcome)}</p>
      ${steps.length ? `<ol class="debrief-steps" aria-label="Steps taken and what we learned">${steps.map(step =>
        `<li><strong>${escape(step.action)}</strong><p>${escape(step.finding)}</p></li>`).join('')}</ol>`
        : '<p class="muted">No steps were recorded for this run.</p>'}
      ${feedback.total != null && feedback.breakdown ? `<details class="debrief-detail"><summary>How the score was calculated</summary>
        <dl>${scoreParts.map(([label, key, maximum]) => `<div><dt>${label}</dt><dd>${escape(feedback.breakdown[key] ?? 0)} / ${maximum}</dd></div>`).join('')}</dl>
        ${feedback.fixed ? '' : '<p class="small muted">An unrepaired deployment can earn at most 50 points.</p>'}</details>` : ''}
      ${view.mode === 'challenge' && referenceParts.length ? `<details class="debrief-detail"><summary>Reference finding</summary>
        <dl>${referenceParts.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl></details>` : ''}
      ${view.mode !== 'demonstration' && feedback.practice_notes?.length ? `<div class="debrief-practice"><strong>Operating habits</strong>
        <ul>${feedback.practice_notes.map(note => `<li>${escape(note)}</li>`).join('')}</ul></div>` : ''}
      ${view.mode === 'guided' && feedback.assistance ? `<p class="debrief-assistance">Help used: ${hints} ${hints === 1 ? 'hint' : 'hints'} · ${demonstrations} ${demonstrations === 1 ? 'demonstration' : 'demonstrations'}</p>` : ''}
      <div class="actions"><button class="secondary" type="button" data-action="replay" ${replaying ? 'disabled aria-busy="true"' : ''}>${replaying ? 'Preparing replay…' : 'Replay with new key'}</button>
        ${view.mode !== 'challenge' && view.scenario.level !== 1 ? `<a class="secondary" href="/?${escape(lessHelp)}">Less help</a>` : ''}
        ${nextScenario ? `<a class="secondary" href="/?${escape(nextScenario)}">Next scenario</a>` : ''}
        <button class="secondary" type="button" data-action="dismiss-debrief">Explore the lab</button></div>
      ${replaying ? '<p role="status">Creating a new mission…</p>' : ''}
      ${replayError ? `<p class="message error" role="alert">${escape(replayError)}</p>` : ''}</div>`;
  }

  /** @param {string} sourceActions */
  function completedSummary(sourceActions) {
    const feedback = view.feedback;
    return `<p class="step-eyebrow">Mission complete${feedback.total == null ? '' : ` · ${escape(feedback.total)} / 100`}</p>
      <h2>${escape(view.briefing?.headline || view.scenario.title)}</h2>
      <p class="small muted">Explore the lab as long as you like. The run is finished, so nothing you do now changes the debrief.</p>
      <div class="actions"><button id="debrief-reopen" class="primary" type="button" data-action="show-debrief">View debrief</button>${sourceActions}</div>`;
  }

  function dismissDebrief() {
    if (!view?.feedback || debriefDismissed || replaying) return;
    debriefDismissed = true;
    sessionStorage.setItem(debriefDismissedKey, 'true');
    message = '';
    error = false;
    // Return to an open panel so the learner can see how to reopen the debrief.
    collapsed = false;
    autoCollapsed = false;
    sessionStorage.setItem(collapsedKey, 'false');
    render();
    (root.querySelector('#debrief-reopen') || root.querySelector('[data-action="collapse"]'))?.focus();
  }

  function showDebrief() {
    debriefDismissed = false;
    sessionStorage.removeItem(debriefDismissedKey);
    render();
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
      <div class="brief-footer">${autoStart ? `<button class="secondary" data-action="pause-demo">${demoPaused ? 'Resume' : 'Pause'}</button><button class="secondary" data-action="stop">Stop</button>` : ''}
        <button class="primary" data-action="begin" ${ready() ? '' : 'disabled'}>${started ? 'Return to investigation' : autoStart ? 'Start now' : 'Begin investigation'}</button></div>
    </div></div>`;
  }

  /** @param {Element} panel @param {number} x @param {number} y @returns {{x: number, y: number}} */
  function clampPanel(panel, x, y) {
    const bounds = panel.getBoundingClientRect();
    const margin = 8;
    return {
      x: Math.max(margin, Math.min(Math.round(x), Math.max(margin, innerWidth - bounds.width - margin))),
      y: Math.max(margin, Math.min(Math.round(y), Math.max(margin, innerHeight - bounds.height - margin))),
    };
  }

  /** @param {Element} panel @param {{x: number, y: number}} position */
  function placePanel(panel, position) {
    const {style} = /** @type {HTMLElement} */ (panel);
    style.left = `${position.x}px`;
    style.top = `${position.y}px`;
    style.right = 'auto';
    style.bottom = 'auto';
  }

  // Content can grow after the coach is placed; keep the whole panel on screen.
  function fitPanel() {
    const panel = root.querySelector('.panel');
    const spot = clearPosition || panelPosition;
    if (panel && spot) placePanel(panel, clampPanel(panel, spot.x, spot.y));
  }

  /** @param {Element} panel @param {number} x @param {number} y @param {boolean} [save] */
  function positionCoach(panel, x, y, save = false) {
    panelPosition = clampPanel(panel, x, y);
    clearPosition = null;
    placePanel(panel, panelPosition);
    if (save) sessionStorage.setItem(positionKey, JSON.stringify(panelPosition));
  }

  // The coach sits above Argo, so a control under it would be highlighted and
  // clicked out of sight, and an Argo popup under it could not be read. Move
  // the coach to the first corner that leaves every area visible, or failing
  // that the first area, which is what the coach points at. Moving the coach,
  // resizing the window, or an Argo drawer opening or closing returns it to
  // its usual place.
  /** @param {...{left: number, top: number, right: number, bottom: number}} areas */
  function keepPanelClear(...areas) {
    const panel = root.querySelector('.panel');
    if (!panel || !areas.length) return;
    if (placePanelClear(panel, areas)) return;
    // Beside a wide Argo dialog on a small screen, keep only what the coach is
    // doing, which fits above or below it, until the dialog closes.
    if (view?.mode !== 'demonstration' || host.hasAttribute('data-compact') || !argoDialogs().length) return;
    host.setAttribute('data-compact', '');
    placePanelClear(panel, areas);
  }

  /**
   * @param {Element} panel @param {{left: number, top: number, right: number, bottom: number}[]} areas
   * @returns {boolean} whether the panel now leaves every area visible
   */
  function placePanelClear(panel, areas) {
    const box = panel.getBoundingClientRect();
    const gap = 12;
    /** @param {{x: number, y: number}} spot @param {typeof areas} [avoid] */
    const clear = (spot, avoid = areas) => !avoid.some(area => spot.x < area.right + gap &&
      spot.x + box.width > area.left - gap && spot.y < area.bottom + gap && spot.y + box.height > area.top - gap);
    const current = {x: box.left, y: box.top};
    if (clear(current)) return true;
    const right = innerWidth - box.width - 20;
    const bottom = innerHeight - box.height - gap;
    // The top edge, over Argo's toolbar, is the last resort: a dialog's overlay covers the toolbar anyway.
    const spots = [[right, 72], [right, bottom], [gap, bottom], [gap, 72], [right, gap], [gap, gap]]
      .map(([x, y]) => clampPanel(panel, x, y));
    const pointedAt = areas.slice(0, 1);
    const clearOfAll = spots.find(candidate => clear(candidate));
    const spot = clearOfAll || (clear(current, pointedAt) ? null : spots.find(candidate => clear(candidate, pointedAt)));
    if (!spot) return false;
    clearPosition = spot;
    clearStep = demoStepId();
    placePanel(panel, spot);
    return Boolean(clearOfAll);
  }

  function render() {
    if (!view) {
      root.innerHTML = error && message ? `<div class="modal-wrap"><div class="modal" role="alert">
        <h2>Could not load the learning session</h2><p>${escape(message)}</p>
        <button class="secondary" data-action="retry-session">Retry</button></div></div>` : '';
      return;
    }
    const debriefOpen = Boolean(view.feedback) && !debriefDismissed;
    host.toggleAttribute('data-debrief', debriefOpen);
    if (view.mode === 'demonstration' && autoCollapsed) {
      collapsed = false;
      autoCollapsed = false;
    } else if (view.mode !== 'demonstration' && nativeOverlayOpen && !collapsed) {
      collapsed = true;
      autoCollapsed = true;
    }
    /** @type {HTMLDetailsElement} */
    const evidenceMap = root.querySelector('.evidence-map');
    if (evidenceMap) evidenceMapOpen = evidenceMap.open;
    /** @type {HTMLDetailsElement} */
    const patchDetails = root.querySelector('.demo-patch');
    if (patchDetails) demoPatchOpen = patchDetails.open;
    host.toggleAttribute('data-native-overlay', nativeOverlayOpen && view.mode === 'demonstration');
    if (view.mode === 'demonstration' && !view.feedback && (demoPatch?.diff ||
        (!view.next_check && view.scenario.level !== 1))) {
      // Show the source change even if Argo's resource or History drawer
      // previously collapsed the coach.
      collapsed = false;
      autoCollapsed = false;
    }
    if (view.feedback) pointer.removeAttribute('data-visible');
    syncClock();
    const argoOnScreen = syncArgoNotes();
    const preparing = !['READY', 'INVESTIGATING', 'FIXED', 'COMPLETED', 'FAILED', 'ABORTED'].includes(view.state);
    if (debriefOpen) {
      const oldDebrief = root.querySelector('.debrief-modal');
      const focusedInside = oldDebrief?.contains(shadow.activeElement);
      const focusedAction = focusedInside ? shadow.activeElement?.dataset.action : null;
      root.innerHTML = `<div class="modal-wrap"><div class="modal debrief-modal" role="dialog" aria-modal="true" aria-labelledby="debrief-title" tabindex="-1">${debrief()}</div></div>`;
      const newDebrief = root.querySelector('.debrief-modal');
      if (focusedAction) root.querySelector(`[data-action="${focusedAction}"]:not(:disabled)`)?.focus({preventScroll: true});
      else if (!oldDebrief || focusedInside) newDebrief.focus({preventScroll: true});
      return;
    }
    if (briefOpen && !view.feedback && !['FAILED', 'ABORTED', 'COMPLETED'].includes(view.state)) {
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
    // Once the mission is complete every mode may explore Git and the terminal.
    const exploring = Boolean(view.feedback);
    // A demonstration shows the controls its repair uses, where a learner would find them.
    const repairing = repairStep();
    /** @param {RepairStep['surface']} surface */
    const repairUses = surface => Boolean(repairing) && demoRepair.plan.steps.some(step => step.surface === surface);
    const onGitea = location.pathname.startsWith('/gitea/');
    const gitPath = (repairing?.surface === 'gitea' && repairing.path) || view.fix_paths?.[0] || '';
    const showGitSource = view.fix_surface !== 'none' &&
      (exploring || repairUses('gitea') || (view.mode !== 'demonstration' && !recentLearning));
    const showTerminal = (exploring || repairUses('terminal') || view.mode !== 'demonstration') &&
      ['git', 'argo-and-git', 'terminal'].includes(view.fix_surface);
    const sourceActions = `${onGitea ? '<button class="secondary" data-action="argocd">Return to Argo CD</button>' : ''}
      ${showGitSource ? `<button class="secondary" data-action="gitea" data-path="${escape(gitPath)}">View Git source</button>` : ''}
      ${showTerminal ? `<button class="secondary" data-action="terminal">${!terminalOpen ? 'Open terminal' : terminalMinimized ? 'Restore terminal' : 'Minimize terminal'}</button>` : ''}`;
    const body = exploring ? completedSummary(sourceActions)
      : preparing ? `<p>Preparing the environment and waiting for Argo CD to show the incident…</p>`
      : view.state === 'FAILED' ? `<p class="message error">${escape(view.run_error || 'The run could not start.')}</p>`
      : view.state === 'ABORTED' ? '<p>The run was stopped.</p><a class="secondary" href="/">Return to missions</a>'
      : `${view.mode === 'demonstration' ? `<p class="driving">✦ Demo ${demoPaused ? 'paused' : 'running'}</p>` : ''}
         <h2>${escape(view.briefing?.headline || view.scenario.title)}</h2>
         ${view.alert ? `<div class="message error" role="alert">${escape(view.alert.message)}</div>` : ''}
         ${checkInCard()} ${recentLearning ? learningCard() : checkCard()}
         <div data-argo-notice>${argoNoticeMarkup()}</div> ${demoPatchCard()} ${targetList()}
         ${view.mode === 'demonstration' && view.fixed && view.scenario.level !== 1 && !view.feedback &&
           view.checks_passed >= view.checks_total ? '<div class="actions"><button class="primary" data-action="note">Write incident note</button></div>' : ''}
         ${view.feedback || view.mode === 'demonstration' || recentLearning ? '' : view.mode === 'challenge' ? `<div class="actions"><button class="secondary" data-action="incident-info">Incident info</button>
           <button class="secondary" data-action="hint">Hint (assistance recorded)</button><button class="primary" data-action="note">Write incident note</button></div>` :
           `<div class="actions"><button class="secondary" data-action="incident-info">Incident info</button><button class="secondary" data-action="hint">Hint</button>
             <button class="secondary" data-action="show-location">Show me</button>
             ${view.fixed && view.scenario.level !== 1 && !view.feedback ? '<button class="primary" data-action="note">Write incident note</button>' : ''}</div>`}
         ${onGitea || showGitSource || showTerminal ? `<div class="actions">${sourceActions}</div>` : ''}`;
    /** @type {NodeListOf<HTMLInputElement | HTMLTextAreaElement>} */
    const fields = root.querySelectorAll('input, textarea');
    const previousValues = new Map(Array.from(fields).map(element => [element.id, element.value]));
    const active = shadow.activeElement?.id;
    const stepId = demoStepId();
    const doing = !exploring && view.mode === 'demonstration' && demoNarration?.id === stepId && demoNarration?.phase === 'doing';
    const demoRunning = view.mode === 'demonstration' && !exploring && !['ABORTED', 'COMPLETED', 'FAILED'].includes(view.state);
    root.innerHTML = `<aside class="panel" ${collapsed ? 'data-collapsed' : ''} ${doing ? 'data-doing' : ''} aria-label="Argo CD Coach">
      <div class="header panel-controls">
      <button id="coach-move" class="coach-drag-handle" type="button" aria-label="Move coach. Drag or use arrow keys." title="Drag to move coach; use arrow keys when focused">⠿ Move</button>
      ${demoRunning ? '<button class="secondary stop-button" data-action="stop" aria-label="Stop demonstration">Stop</button>' : ''}
      ${demoRunning ? `<button class="secondary stop-button" data-action="pause-demo" aria-label="${demoPaused ? 'Resume' : 'Pause'} demonstration">${demoPaused ? 'Resume' : 'Pause'}</button>` : ''}
      <button class="icon-button" data-action="collapse" aria-label="${collapsed ? 'Expand' : 'Collapse'} coach">${collapsed ? '▣' : '−'}</button></div>
      ${collapsed ? '' : `<div class="body">${body}${message ? `<div class="message ${error ? 'error' : ''}" role="status">${escape(message)}</div>` : ''}${view.mode === 'demonstration' && !exploring ? demoTimerMarkup() : ''}</div>`}
    </aside>${noteOpen ? noteForm() : ''}`;
    // A spot chosen for one step's highlight does not suit the next step.
    if (clearPosition && clearStep !== demoStepId()) clearPosition = null;
    if (clearPosition) fitPanel();
    else if (panelPosition) positionCoach(root.querySelector('.panel'), panelPosition.x, panelPosition.y);
    settleArgoNotes(argoOnScreen);
    for (const [id, value] of previousValues) {
      /** @type {HTMLInputElement | HTMLTextAreaElement} */
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

  /** @param {string} label @param {ParentNode} [scope] */
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
    return Array.from(document.querySelectorAll('.sliding-panel--opened'))
      .find(panel => visible(panel.querySelector('.resource-details__header'))) ||
      document.querySelector('.application-node-info') || document;
  }

  function selectedControl(element) {
    for (let item = element, depth = 0; item && depth < 4; item = item.parentElement, depth += 1) {
      if (item.matches('[aria-selected="true"], [aria-current="page"], [aria-pressed="true"], [data-state="active"]') ||
          Array.from(item.classList).some(name => /(?:^|[-_])(active|selected|current)$/.test(name))) return true;
    }
    return false;
  }

  /** @param {NextCheck} check */
  function resourceEvidenceReady(check) {
    const drawer = resourceScope();
    if (drawer === document) return false;
    const tab = new URL(location.href).searchParams.get('tab')?.toLowerCase();
    if (check.target === 'resource.manifest') {
      const desired = exactControl('Desired Manifest', drawer) || exactControl('Desired', drawer);
      return Boolean(desired && selectedControl(desired) &&
        Array.from(drawer.querySelectorAll('.application-node-info__manifest, .application-node-info__manifest--raw'))
          .some(visible));
    }
    const label = {'resource.events': 'Events', 'resource.logs': 'Logs', 'resource.summary': 'Summary'}[check.target];
    const control = exactControl(label, drawer);
    return control ? selectedControl(control) :
      tab === label.toLowerCase() || (check.target === 'resource.summary' && !tab);
  }

  /** @param {NextCheck} check @param {string} action */
  function stopDemoAt(check, action) {
    demoStopped = true;
    cancelDemoDelay();
    say(`The demonstration could not open ${action} for ${check.where}. Stop this run and retry.`, true);
    return false;
  }

  /** @param {NextCheck} check */
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

  /** @param {NextCheck} check */
  function markDemoTarget(check) {
    if (view?.mode !== 'demonstration' || check.available) return;
    if (typeof observer.visit === 'function') observer.visit(check.target, view.application);
    else sendAction('target_visited', {target: check.target, application: view.application});
  }

  /** @type {Partial<Record<TargetId, string>>} */
  const demoContent = {
    'app.history': '.application-deployment-history',
    'app.conditions': '.application-conditions',
    'app.operation': '.application-operation-state__message, .application-operation-state__icons_container_padding',
    'app.diff': '.application-resources-diff',
    'app.tree': '.application-resource-tree__node-title',
  };

  // The short kind names Argo CD 3.5 shows under each resource tree node's icon.
  const argoKindLabels = new Map([['ClusterRole', 'c-role'], ['ComponentStatus', 'cs'], ['ConfigMap', 'cm'],
    ['ClusterRoleBinding', 'crb'], ['CustomResourceDefinition', 'crd'], ['CertificateSigningRequest', 'csr'],
    ['CronJob', 'cronjob'], ['Deployment', 'deploy'], ['DaemonSet', 'ds'], ['Endpoint', 'ep'], ['Endpoints', 'ep'],
    ['Event', 'ev'], ['Group', 'group'], ['HorizontalPodAutoscaler', 'hpa'], ['Ingress', 'ing'], ['Job', 'job'],
    ['LimitRange', 'limits'], ['NetworkPolicy', 'netpol'], ['Namespace', 'ns'], ['Node', 'no'], ['Pod', 'pod'],
    ['PodSecurityPolicy', 'psp'], ['PersistentVolume', 'pv'], ['PersistentVolumeClaim', 'pvc'],
    ['PodDisruptionBudget', 'pdb'], ['PriorityClass', 'pc'], ['ReplicationController', 'rc'], ['ResourceQuota', 'quota'],
    ['RoleBinding', 'rb'], ['Role', 'role'], ['ReplicaSet', 'rs'], ['ServiceAccount', 'sa'], ['StorageClass', 'sc'],
    ['Secret', 'secret'], ['StatefulSet', 'sts'], ['Service', 'svc'], ['User', 'user'], ['Volume', 'vol']]);

  /** @param {string} title An Argo CD 3.5 sidebar entry, such as Settings. */
  const argoSidebarItem = title => Array.from(document.querySelectorAll('.sidebar__nav-item'))
    .find(item => visible(item) && item.textContent?.trim() === title) || null;

  /** @param {string} title A tile on Argo CD 3.5's Settings page, such as Repositories. */
  const argoSettingsTile = title => Array.from(document.querySelectorAll('.settings-overview__redirect-panel'))
    .find(tile => visible(tile) && tile.querySelector('.settings-overview__redirect-panel__title')?.textContent?.trim() === title) || null;

  /**
   * Polls for up to five seconds, as Argo renders the next page.
   * @template T @param {() => T} find @returns {Promise<T | null>}
   */
  async function waitFor(find) {
    for (let attempt = 0; attempt < 20 && !demoStopped; attempt += 1) {
      const found = find();
      if (found) return found;
      await sleep(250);
    }
    return null;
  }

  // Argo CD 3.5 has no Conditions button. The App Conditions summary in the
  // Application header, such as "1 Error", opens the panel in place.
  function conditionsControl() {
    return Array.from(document.querySelectorAll('.application-status-panel__conditions a')).find(visible) ||
      Array.from(document.querySelectorAll('.application-status-panel__conditions')).find(visible) || null;
  }

  /** @param {TargetId} target */
  async function waitForDemoContent(target) {
    const selector = demoContent[target];
    for (let attempt = 0; attempt < 20 && !demoStopped; attempt += 1) {
      if (Array.from(document.querySelectorAll(selector)).some(visible)) return true;
      await sleep(250);
    }
    return false;
  }

  /** @param {NextCheck} check */
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

  /** @param {NextCheck} check @param {boolean} demonstration */
  async function indicateEvidence(check, demonstration) {
    if (demonstration) markDemoTarget(check);
    else {
      let element = evidenceElement(check), related = null;
      if (view?.scenario.id === 'console-unhealthy-version' && check.id === 'ready-pod') {
        try {
          const pods = await rolloutPodElements();
          element = pods.healthy || element;
          related = pods.unready;
        } catch (_) { /* The Tree is still a useful fallback. */ }
      }
      if (element) await scrollToTarget(element);
      say(check.hint || `Read ${check.where}.`);
      if (element?.isConnected && visible(element)) spotlight(element, related);
    }
    return true;
  }

  /** @param {Element} element @param {Element | null} [relatedElement] @param {boolean} [lasting] Keep it past five seconds. */
  function spotlight(element, relatedElement = null, lasting = false) {
    const bounds = element.getBoundingClientRect();
    const related = relatedElement?.getBoundingClientRect();
    const left = Math.min(bounds.left, related?.left ?? bounds.left);
    const top = Math.min(bounds.top, related?.top ?? bounds.top);
    const right = Math.max(bounds.right, related?.right ?? bounds.right);
    const bottom = Math.max(bounds.bottom, related?.bottom ?? bounds.bottom);
    keepPanelClear({left: left - 4, top: top - 4, right: right + 4, bottom: bottom + 4}, ...argoDialogs(), ...argoAreas());
    const frame = document.createElement('div');
    frame.className = 'spotlight';
    Object.assign(frame.style, {left: `${left - 4}px`, top: `${top - 4}px`,
      width: `${right - left + 8}px`, height: `${bottom - top + 8}px`});
    root.append(frame);
    // A click that opens another Argo page removes the element; drop its frame
    // then rather than leaving it over the new page.
    const shownAt = performance.now();
    const watch = setInterval(() => {
      if (element.isConnected && frame.isConnected && (lasting || performance.now() - shownAt < 5000)) return;
      clearInterval(watch);
      frame.remove();
    }, 100);
    return frame;
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
      await /** @type {Promise<void>} */ (new Promise(resolve => {
        const started = performance.now();
        /** @param {number} now */
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
      }));
    }
    await new Promise(resolve => requestAnimationFrame(resolve));
    return element.isConnected && !demoStopped;
  }

  /**
   * Where an element comes to rest, such as a button in an Argo CD panel that is
   * still sliding in: the same box for three frames in a row, or after 1.5 s.
   * @param {Element} element @returns {Promise<DOMRect>}
   */
  async function stillBounds(element) {
    let last = element.getBoundingClientRect();
    for (let frame = 0, still = 0; frame < 90 && still < 3 && element.isConnected; frame += 1) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const now = element.getBoundingClientRect();
      still = Math.abs(now.left - last.left) < 1 && Math.abs(now.top - last.top) < 1 ? still + 1 : 0;
      last = now;
    }
    return last;
  }

  async function pointAt(element, click = false, highlightWith = null) {
    if (!element?.isConnected || !visible(element) || demoStopped) return false;
    if (!await scrollToTarget(element)) return false;
    const bounds = await stillBounds(element);
    if (!bounds.width || !bounds.height || !element.isConnected) return false;
    spotlight(element, highlightWith);
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
      // A render can replace the element during the click animation too.
      if (demoStopped || !element.isConnected) return false;
      element.click();
    }
    pointerTimer = setTimeout(() => { pointer.removeAttribute('data-visible'); }, click ? 1200 : 2700);
    return true;
  }

  function historyRevisionElement(revision) {
    const history = document.querySelector('.application-deployment-history');
    const answer = String(revision || '').toLowerCase();
    return history && answer && Array.from(history.querySelectorAll('*')).find(element => {
      if (element.childElementCount || !visible(element)) return false;
      const text = element.textContent?.trim().toLowerCase() || '';
      return text.includes(answer) || (text.length >= 7 && answer.startsWith(text));
    });
  }

  /** @param {NextCheck} check */
  function evidenceElement(check) {
    /** @param {string} text @param {Element} [scope] */
    const exact = (text, scope = document.body) => Array.from(scope.querySelectorAll('*')).find(element =>
      element.childElementCount === 0 && element.textContent?.trim() === text && visible(element));
    const selectors = {
      'app.operation': '.application-operation-state__message',
      'app.conditions': '.application-conditions',
      'app.tree': '.application-resource-tree__node-title',
      'resource.events': '.resource-details__header',
      'resource.logs': '.resource-details__header',
      'resource.manifest': '.application-node-info__manifest, .application-node-info__manifest--raw',
    };
    // Argo's sidebar health filters use the same words as the header's App Health,
    // which Argo CD 3.5 shows as an icon and the status in one value.
    const headerHealth = () => {
      const item = statusItem('APP HEALTH');
      if (!item) return exact(view.health || '');
      return Array.from(item.querySelectorAll('.application-status-panel__item-value'))
        .find(value => visible(value) && value.textContent?.trim() === view.health) || null;
    };
    const history = check.target === 'app.history' && document.querySelector('.application-deployment-history');
    const answer = String(check.demonstration_answer || '').toLowerCase();
    const historyRevision = history && historyRevisionElement(answer);
    const evidenceScope = {
      'app.operation': '.application-operation-state__message, .application-operation-state__icons_container_padding',
      'app.conditions': '.application-conditions',
      'resource.manifest': '.application-node-info__manifest, .application-node-info__manifest--raw',
    }[check.target];
    const drawer = check.target.startsWith('resource.') ? resourceScope() : null;
    const scope = drawer && drawer !== document ?
      (evidenceScope && Array.from(drawer.querySelectorAll(evidenceScope)).find(visible)) || drawer :
      evidenceScope && Array.from(document.querySelectorAll(evidenceScope)).find(visible);
    const answerMatch = scope && answer && [scope, ...scope.querySelectorAll('*')]
      .filter(element => !element.childElementCount && visible(element) &&
        element.textContent?.toLowerCase().includes(answer))
      .sort((a, b) => a.textContent.length - b.textContent.length)[0];
    return (check.target === 'apps.list' ? exact(view.application) : null) ||
      (check.target === 'app.header' ? headerHealth() : null) ||
      (check.target === 'app.tree' && check.id !== 'ready-pod' ? exact(check.demonstration_answer || '') : null) ||
      historyRevision || answerMatch || history || (drawer !== document && visible(drawer) ? drawer : null) ||
      (check.target === 'settings.repos' ? candidate('gitea.applications.svc.cluster.local') : null) ||
      Array.from(document.querySelectorAll(selectors[check.target] || '.__argo_coach_no_match__')).find(visible) ||
      candidate(({'app.history': 'History', 'app.operation': 'Sync Status',
        'resource.manifest': 'Desired'}[check.target]) || check.target.split('.')[1]);
  }

  function historyRevisionLabel(element) {
    const history = element?.closest('.application-deployment-history');
    if (!history) return null;
    const top = element.getBoundingClientRect().top;
    return Array.from(history.querySelectorAll('*')).filter(candidate =>
      /^revision:?$/i.test(candidate.textContent?.trim() || '') && visible(candidate) &&
      Math.abs(candidate.getBoundingClientRect().top - top) < 32)
      .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0] || null;
  }

  async function activate(element, demonstration) {
    if (demonstration) return pointAt(element, true);
    if (!await scrollToTarget(element)) return false;
    element.click();
    return true;
  }

  /** @returns {Promise<ArgoResourceNode[]>} */
  async function resourceTreeNodes() {
    const token = localStorage.getItem('argocd.token');
    const response = await fetch(`/argocd/api/v1/applications/${encodeURIComponent(view.application)}/resource-tree?appNamespace=argocd`,
      {headers: token ? {Authorization: `Bearer ${token}`} : {}});
    if (!response.ok) throw new Error(`Argo CD resource tree returned ${response.status}`);
    return (await response.json()).nodes || [];
  }

  async function rolloutPodElements() {
    // The tree can also contain Pods owned by migration and verification Jobs.
    const pods = (await resourceTreeNodes()).filter(node =>
      node.kind === 'Pod' && /^django-[a-z0-9]+-[a-z0-9]+$/.test(node.name));
    const titles = Array.from(document.querySelectorAll('.application-resource-tree__node-title'));
    const title = node => node && titles.find(element =>
      element.textContent?.trim() === node.name && visible(element));
    return {
      healthy: title(pods.find(node => node.health?.status === 'Healthy')),
      unready: title(pods.find(node => node.health?.status && node.health.status !== 'Healthy')),
    };
  }

  /** Argo's `node` URL parameter for a resource tree node. @param {ArgoResourceNode} node */
  const resourceNodeId = node => [node.group || '', node.kind, node.namespace || '', node.name].join('/') + '/0';

  /** @param {TargetId} target */
  async function resourceNode(target) {
    const nodes = await resourceTreeNodes();
    const kind = target === 'resource.events' && view.scenario.id === 'stale-job' ? 'Job' :
      target === 'resource.events' || target === 'resource.logs' ? 'Pod' : 'Deployment';
    const matching = nodes.filter(node => node.kind === kind);
    const node = matching.find(item => item.health?.status && item.health.status !== 'Healthy') || matching[0];
    return node ? {id: resourceNodeId(node), name: node.name, kind: node.kind} : null;
  }

  // Argo opens a resource's drawer in the same render that finds its node in
  // the resource tree, but renders the drawer's header only after a chain of
  // API calls. So while the node is in the tree, a missing drawer is still
  // loading; once a replaced Pod or recreated hook Job has left the tree, its
  // drawer will never open.
  const drawerLoadLimit = 30000;
  const drawerTreeCheckInterval = 2000;

  /**
   * @param {string} nodeId
   * @returns {Promise<'open' | 'loading' | 'gone' | 'closed'>} `loading` when Argo
   *   still lists the resource but has not shown it within the limit; `closed`
   *   when another resource was selected or the demonstration stopped.
   */
  async function waitForResourceDrawer(nodeId) {
    const started = performance.now();
    let treeChecked = started;
    while (!demoStopped) {
      if (resourceScope() !== document) return 'open';
      if (new URL(location.href).searchParams.get('node') !== nodeId) return 'closed';
      const now = performance.now();
      if (now - treeChecked >= drawerTreeCheckInterval) {
        if (!(await resourceTreeNodes()).some(node => resourceNodeId(node) === nodeId)) return 'gone';
        treeChecked = performance.now();
      }
      if (now - started >= drawerLoadLimit) return 'loading';
      await sleep(250);
    }
    return 'closed';
  }

  /**
   * Argo did not show the resource. A demonstration stops when Argo still lists
   * the resource but could not load it; otherwise it tries again on its next
   * step, within its attempt limit. Guided learners get the written hint.
   * @param {NextCheck} check @param {boolean} demonstration
   * @param {boolean} failedToLoad @param {string} tabLabel
   */
  function resourceDrawerUnavailable(check, demonstration, failedToLoad, tabLabel) {
    if (!demonstration) say(check.hint || `Open ${check.where} in the Argo CD console.`);
    else if (failedToLoad) return stopDemoAt(check, tabLabel);
    return false;
  }

  /** @param {boolean} [demonstration] */
  async function showLocation(demonstration = false) {
    if (!demonstration) guidedLocationTasks += 1;
    try { return await showLocationImpl(demonstration); }
    finally { if (!demonstration) guidedLocationTasks -= 1; }
  }

  /** @param {boolean} demonstration */
  async function showLocationImpl(demonstration) {
    const check = view?.next_check;
    if (!check) { say('Open the affected Application and verify its health and deployed revision.'); return; }
    const target = check.target;
    if (target === 'apps.list' || target === 'apps.filter') {
      if (demonstration && location.pathname.includes(`/applications/argocd/${encodeURIComponent(view.application)}`)) {
        return indicateEvidence(check, true);
      }
      if (!location.pathname.endsWith('/applications')) {
        const applications = demonstration && argoSidebarItem('Applications');
        narrateClick(check, applications ? 'Open Applications in the Argo CD sidebar.' : 'Open the Applications list.');
        if (applications && await activate(applications, true) &&
            await waitFor(() => location.pathname.endsWith('/applications'))) return;
        if (!demoStopped && !location.pathname.endsWith('/applications')) location.href = '/argocd/applications';
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
      const reposPage = /\/argocd\/settings\/repos(?:itories)?\/?$/;
      const settingsPage = /\/argocd\/settings\/?$/;
      if (demonstration && !reposPage.test(location.pathname)) {
        // Go the way a person would: Settings in the sidebar, then the Repositories tile.
        if (!settingsPage.test(location.pathname)) {
          const settings = argoSidebarItem('Settings');
          if (settings) {
            narrateClick(check, 'Open Settings in the Argo CD sidebar.');
            if (await activate(settings, true)) await waitFor(() => settingsPage.test(location.pathname));
          }
        }
        const repositories = settingsPage.test(location.pathname) && await waitFor(() => argoSettingsTile('Repositories'));
        if (repositories) {
          narrateClick(check, 'Open Repositories in Settings.');
          if (await activate(repositories, true)) await waitFor(() => reposPage.test(location.pathname));
        }
        if (demoStopped) return;
      }
      if (!reposPage.test(location.pathname)) {
        narrateClick(check, 'Open Settings → Repositories.');
        location.href = '/argocd/settings/repos';
      } else if (demonstration) {
        // Argo fills in the repository list after the page opens.
        const entry = await waitFor(() => evidenceElement(check));
        observer.fromURL(location.href);
        if (entry) return indicateEvidence(check, true);
      } else say(check.hint);
      return;
    }
    if (!location.pathname.includes(`/applications/argocd/${encodeURIComponent(view.application)}`)) {
      const findCard = () => Array.from(document.querySelectorAll('body *')).find(element =>
        element.childElementCount === 0 && element.textContent?.trim() === view.application && visible(element));
      let cardLabel = findCard();
      // From another Argo page, such as Settings, a person returns through the sidebar.
      if (!cardLabel && demonstration && !/\/argocd\/applications\/?$/.test(location.pathname)) {
        const applications = argoSidebarItem('Applications');
        if (applications) {
          narrateClick(check, 'Open Applications in the Argo CD sidebar.');
          if (await activate(applications, true)) cardLabel = await waitFor(findCard);
          if (demoStopped) return;
        }
      }
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
        const control = (target === 'app.conditions' && conditionsControl()) || exactControl(label) || candidate(label);
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
        const operationPanel = Array.from(document.querySelectorAll('.sliding-panel--opened'))
          .find(panel => visible(panel) && panel.querySelector('.application-operation-state__icons_container_padding'));
        if (operationPanel) {
          /** @type {HTMLElement} */
          const close = operationPanel.querySelector('.sliding-panel__close');
          if (close) {
            narrateClick(check, 'Close Sync Status to inspect the resource in the tree.');
            if (!await activate(close, demonstration) && close.isConnected) close.click();
            return false;
          }
        }
        // Argo normalizes the Application URL while its tree is mounting.
        // Navigating to a node before that mount can be overwritten by a
        // later `?resource=` replaceState from Argo itself.
        for (let attempt = 0; attempt < 20 &&
             !document.querySelector('.application-resource-tree__node-title'); attempt += 1) {
          await sleep(250);
        }
        let node = await resourceNode(target);
        const nodeSelected = () => new URL(location.href).searchParams.get('node') === node.id;
        const tabLabel = target === 'resource.manifest' ? 'Desired Manifest' :
          {'resource.events': 'Events', 'resource.logs': 'Logs', 'resource.summary': 'Summary'}[target];
        /** @type {'open' | 'loading' | 'gone' | 'closed'} */
        let drawer = 'gone';
        // A replaced Pod or recreated hook Job never opens, so select the
        // resource that replaced it, a few times at most.
        for (let selection = 0; node && selection < 3; selection += 1) {
          if (!nodeSelected()) {
            // The tree often contains Service/django and Deployment/django.
            // A name-only click can open the wrong resource and loop forever,
            // so also match the kind Argo shows under each node's icon.
            const kind = argoKindLabels.get(node.kind) || node.kind.toLowerCase();
            const titles = Array.from(document.querySelectorAll('.application-resource-tree__node-title'))
              .filter(element => visible(element) && element.textContent?.trim() === node.name)
              .filter((element, _, named) => named.length === 1 || element.closest('.application-resource-tree__node')
                ?.querySelector('.application-resource-tree__node-kind')?.textContent?.trim() === kind);
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
              'resource.manifest': 'summary', 'resource.summary': 'summary'})[target]);
            if (destination.href !== location.href) {
              narrateClick(check, `Open ${node.kind}/${node.name} in ${view.application}'s Tree.`);
              location.href = destination.href;
            }
            return false;
          }
          drawer = await waitForResourceDrawer(node.id);
          if (drawer !== 'gone') break;
          node = await resourceNode(target);
        }
        if (node) {
          if (drawer === 'closed') return false;
          if (drawer !== 'open') return resourceDrawerUnavailable(check, demonstration, drawer === 'loading', tabLabel);
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
            let tab = exactControl(label, resourceScope());
            for (let attempt = 0; attempt < 20 && !tab && !demoStopped; attempt += 1) {
              await sleep(250);
              tab = exactControl(label, resourceScope());
            }
            if (tab && !selectedControl(tab)) {
              narrateClick(check, `Open ${label} on ${node.kind}/${node.name}.`);
              await activate(tab, demonstration);
            }
          }
          for (let attempt = 0; attempt < 20 && !demoStopped; attempt += 1) {
            if (nodeSelected() && resourceEvidenceReady(check)) return indicateEvidence(check, demonstration);
            await sleep(250);
          }
          const destination = new URL(location.href);
          destination.searchParams.set('node', node.id);
          destination.searchParams.set('tab', ({'resource.events': 'events', 'resource.logs': 'logs',
            'resource.manifest': 'summary', 'resource.summary': 'summary'})[target]);
          const drawerScope = resourceScope();
          // The drawer closed while its tab was opening: the resource was replaced.
          if (!(drawerScope instanceof Element)) return resourceDrawerUnavailable(check, demonstration, false, tabLabel);
          if (destination.href !== location.href && drawerScope.matches('.sliding-panel--opened')) {
            // A resource can remount while a hook retries. The URL lets Argo
            // reopen the selected tab on the next mount.
            location.href = destination.href;
            return false;
          }
          if (demonstration) return stopDemoAt(check, tabLabel);
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

  /** @param {string} answer */
  async function answerCheck(answer) {
    const check = view?.next_check;
    if (!check) return;
    await sendAction('evidence_check_answered', {check_id: check.id, answer});
    hintVisible = false;
    await refresh();
  }

  /** @param {IncidentNote} values */
  async function submitNote(values) {
    try {
      /** @type {Feedback} */
      const feedback = await request(sessionPath + '/note', {method: 'POST', body: JSON.stringify(values)});
      noteOpen = false;
      view.feedback = feedback;
      if (view.scenario.level === 1) localStorage.setItem('argo-coach:orientation-complete', 'true');
      say(feedback.message);
      await refresh();
    } catch (reason) { say(reason.message, true); }
  }

  /** @param {NextCheck} check */
  async function showDemoFinding(check) {
    clearDemoLocationAttempts();
    const needsLook = Boolean(check.demo?.look);
    const phase = demoNarration?.id === check.id ? demoNarration.phase : null;
    const unhealthyHistory = view.scenario.id === 'console-unhealthy-version' && check.id === 'revision';
    if (needsLook && phase === 'learning') {
      await answerCheck(check.demonstration_answer);
      return;
    }
    if (needsLook && phase !== 'locate') {
      pointer.removeAttribute('data-visible');
      setDemoNarration(check.id, 'locate');
      if (unhealthyHistory) {
        const newest = historyRevisionElement(view.revision);
        if (newest) await pointAt(newest, false, historyRevisionLabel(newest));
      }
      await demoWait(evidenceLocateDelay);
    }
    if (demoStopped || view.next_check?.id !== check.id) return;
    let element = evidenceElement(check), label = null;
    if (view.scenario.id === 'console-unhealthy-version' && check.id === 'ready-pod') {
      try {
        const pods = await rolloutPodElements();
        element = pods.healthy || element;
        label = pods.unready;
      } catch (_) { /* Keep the Tree pointer when Pod details are unavailable. */ }
    } else if (check.target === 'app.history') label = historyRevisionLabel(element);
    if (unhealthyHistory) root.querySelectorAll('.spotlight').forEach(frame => frame.remove());
    if (element) await pointAt(element, false, label);
    if (demoStopped || view.next_check?.id !== check.id) return;
    setDemoNarration(check.id, 'learning');
    if (needsLook && element?.isConnected && visible(element)) spotlight(element, label);
    await demoWait();
    if (demoStopped || view.next_check?.id !== check.id) return;
    await answerCheck(check.demonstration_answer);
  }

  /**
   * Types into one of the coach's own fields the way a person would, with the
   * pointer on the field. A render replaces the field, so it is looked up again
   * before each character; render() keeps the typed value.
   * @param {string} selector @param {string} text
   */
  async function typeIntoField(selector, text) {
    /** @type {() => HTMLInputElement | HTMLTextAreaElement | null} */
    const field = () => root.querySelector(selector);
    let pointed = false;
    for (let attempt = 0; attempt < 3 && !pointed && !demoStopped && field(); attempt += 1) {
      pointed = await pointAt(field());
    }
    if (!pointed || !field()) return false;
    clearTimeout(pointerTimer);
    pointer.dataset.visible = 'true';
    field().focus({preventScroll: true});
    field().value = '';
    for (const char of text) {
      while (demoPaused && !demoStopped) await sleep(200);
      if (demoStopped || !field()) return false;
      field().value += char;
      await sleep(demoTypingDelay);
    }
    pointerTimer = setTimeout(() => { pointer.removeAttribute('data-visible'); }, 1200);
    return true;
  }

  // Write the incident note as a learner does: open the form, type each field,
  // then submit it.
  /** @param {IncidentNote} values */
  async function demonstrateNote(values) {
    if (!noteOpen) {
      const open = root.querySelector('[data-action="note"]');
      if (open) await activate(open, true);
      if (demoStopped) return;
      // A render can replace the button while the pointer moves to it.
      if (!noteOpen) { noteOpen = true; render(); }
    }
    for (const name of /** @type {(keyof IncidentNote)[]} */ (['resource', 'evidence', 'revision', 'cause', 'fix'])) {
      if (!await typeIntoField(`#note-${name}`, values[name])) return;
    }
    // Click Submit again only if a render replaced it before the click landed.
    for (let attempt = 0; attempt < 3 && !demoStopped && noteOpen; attempt += 1) {
      const submitted = noteSubmissions;
      const submit = root.querySelector('#note-form [type="submit"]');
      if (!submit) return;
      await activate(submit, true);
      if (noteSubmissions !== submitted) return;
    }
  }

  // ---- Demonstration repair --------------------------------------------------
  // A demonstration repairs the run the way its mission teaches: with Argo CD's
  // own controls, the coach's Git and terminal buttons, Gitea pages, and
  // commands typed into the lab terminal. The scenario controller's repair plan
  // lists the steps for this run's fault and variant. When a step cannot
  // finish, the coach says why and falls back to the controller's reference
  // repair, so the demonstration still ends.

  /** Stages after which a step waits for its reading countdown before going on. */
  const repairReadingStages = new Set(['shown', 'reviewed']);
  const giteaRepository = '/gitea/remotelab/django-app';
  /** lab-terminal/telemetry.sh titles each prompt "lab-terminal <count> <exit code> <HEAD>". */
  const terminalTitle = /^lab-terminal (\d+) (\d+) (\S+)/;

  /** @typedef {'done' | 'read' | 'navigating' | 'stopped' | {skipped: string} | {failed: string}} RepairOutcome */
  /** @param {string} reason @returns {RepairOutcome} */
  const fail = reason => ({failed: reason});

  /**
   * Polls until find returns something, for up to timeout ms.
   * @template T @param {() => T | Promise<T>} find @param {number} timeout @param {number} [interval]
   * @returns {Promise<T | null>}
   */
  async function waitUntil(find, timeout, interval = 250) {
    const deadline = performance.now() + timeout;
    while (!demoStopped) {
      const found = await find();
      if (found) return found;
      if (performance.now() >= deadline) return null;
      await sleep(interval);
    }
    return null;
  }

  async function whilePaused() {
    while (demoPaused && !demoStopped) await sleep(200);
  }

  /**
   * Narrates what the repair is doing now. Call it before pointing: it re-renders the panel.
   * @param {string} detail @param {string} [reason] @param {DemoNarration['phase']} [phase]
   */
  function narrateRepair(detail, reason, phase = 'doing') {
    demoNarration = {id: demoStepId(), phase, detail, detailReason: reason || repairStep()?.why};
    sessionStorage.setItem(demoNarrationKey, JSON.stringify(demoNarration));
    message = '';
    render();
  }

  /**
   * Clicks a control that loads another page, where the step carries on at stage.
   * @param {() => Element | null} control Looked up after narrating, which re-renders the panel.
   * @param {string} stage @param {string} detail
   */
  async function clickToNavigate(control, stage, detail) {
    narrateRepair(detail);
    const what = detail.replace(/\.$/, '');
    if (!control()) return fail(`${what}: the control is not on the page`);
    const previous = demoRepair;
    saveDemoRepair({...demoRepair, stage});
    demoNavigating = true;
    if (!await clickControl(control)) {
      demoNavigating = false;
      saveDemoRepair(previous);
      return demoStopped ? 'stopped' : fail(`${what}: the control could not be clicked`);
    }
    // The next page continues the step; this one only resumes if it never loads.
    await waitUntil(() => false, 20000);
    demoNavigating = false;
    return demoStopped ? 'stopped' : fail(`${what}: the page did not open`);
  }

  /**
   * Clicks a control, looking it up again when a render replaces it while the
   * pointer moves to it, as the panel does whenever the session changes.
   * @param {() => Element | null} control @returns {Promise<boolean>}
   */
  async function clickControl(control) {
    for (let attempt = 0; attempt < 3 && !demoStopped; attempt += 1) {
      const target = control();
      if (!target) return false;
      if (await activate(target, true)) return true;
      if (target.isConnected) return false;
    }
    return false;
  }

  const giteaButton = () => root.querySelector('[data-action="gitea"]');
  const argoButton = () => root.querySelector('[data-action="argocd"]');
  const onApplicationPage = () => location.pathname.includes(`/applications/argocd/${encodeURIComponent(view.application)}`);
  /** @param {string} path */
  const onGiteaFile = path => decodeURIComponent(location.pathname) === `${giteaRepository}/src/branch/main/${path}`;

  // The lab terminal ------------------------------------------------------------

  const terminalFrame = () => /** @type {HTMLIFrameElement | null} */ (dockRoot.querySelector('.terminal-dock iframe'));

  /** The ttyd page's xterm terminal, once it has loaded. @returns {XtermTerminal | null} */
  function terminalTerm() {
    try { return /** @type {TtydWindow} */ (terminalFrame()?.contentWindow)?.term || null; }
    catch (_) { return null; }
  }

  /** What the terminal's latest prompt reported. */
  function terminalPrompt() {
    let title = '';
    try { title = terminalFrame()?.contentDocument?.title || ''; } catch (_) { return null; }
    const match = title.match(terminalTitle);
    return match ? {count: Number(match[1]), exit: Number(match[2]), head: match[3]} : null;
  }

  /** Puts the pointer on the terminal's cursor, where the next keystroke appears. @param {XtermTerminal} term */
  function pointAtTerminalCursor(term) {
    const frame = terminalFrame();
    if (!frame) return;
    const box = frame.getBoundingClientRect();
    const screen = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect() ||
      {left: 0, top: 0, width: box.width, height: box.height};
    const buffer = term.buffer.active;
    const x = box.left + screen.left + (buffer.cursorX + .5) * screen.width / term.cols;
    const y = box.top + screen.top + (buffer.cursorY + .6) * screen.height / term.rows;
    pointer.style.left = `${Math.round(Math.min(x, box.right - 12))}px`;
    pointer.style.top = `${Math.round(Math.min(y, box.bottom - 12))}px`;
  }

  /** Keeps the terminal highlighted while commands are typed and run; a panel render removes the frame. */
  function highlightTerminal() {
    const frame = terminalFrame();
    if (!frame || root.querySelector('.spotlight[data-terminal]')) return;
    spotlight(frame, null, true).dataset.terminal = '';
  }

  const clearTerminalHighlight = () => root.querySelectorAll('.spotlight[data-terminal]').forEach(frame => frame.remove());

  // The pointer clicks the coach's own Open terminal button, as a learner would.
  async function openTerminal() {
    if (!terminalOpen || terminalMinimized) {
      narrateRepair(terminalOpen ? 'Restore the lab terminal.' : 'Open the lab terminal.');
      await clickControl(() => root.querySelector('[data-action="terminal"]'));
      if (demoStopped) return false;
      if (!terminalOpen || terminalMinimized) {
        terminalOpen = true;
        terminalMinimized = false;
        renderDock();
        render();
      }
    }
    // ttyd connects, the session refreshes its checkout, then bash titles its first prompt.
    return Boolean(await waitUntil(() => terminalTerm() && terminalPrompt(), 45000));
  }

  async function minimizeTerminal() {
    if (!terminalOpen || terminalMinimized || demoStopped) return;
    const minimize = dockRoot.querySelector('[data-action="minimize-terminal"]');
    if (minimize) await activate(minimize, true);
    if (!terminalMinimized && !demoStopped) {
      terminalMinimized = true;
      renderDock();
      render();
    }
  }

  /**
   * Types text into the lab terminal a character at a time, with the pointer
   * at the cursor and the terminal highlighted, through ttyd's own terminal so
   * the shell echoes it on screen. Pause holds the typing; Stop ends it.
   * @param {string} text
   */
  async function typeIntoTerminal(text) {
    const term = terminalTerm();
    const frame = terminalFrame();
    if (!term || !frame || demoStopped) return false;
    highlightTerminal();
    if (!pointer.style.left) {
      const panel = root.querySelector('.panel')?.getBoundingClientRect();
      pointer.style.left = `${panel?.left ?? innerWidth - 80}px`;
      pointer.style.top = `${panel?.top ?? 80}px`;
    }
    clearTimeout(pointerTimer);
    pointer.removeAttribute('data-click');
    pointer.dataset.visible = 'true';
    await new Promise(resolve => requestAnimationFrame(resolve));
    pointAtTerminalCursor(term);
    term.focus();
    await sleep(700);
    for (const char of text) {
      await whilePaused();
      if (demoStopped || terminalTerm() !== term) return false;
      term.input(char, true);
      await sleep(demoTypingDelay);
      highlightTerminal();
      pointAtTerminalCursor(term);
    }
    return true;
  }

  /**
   * Types a command, presses Enter, and waits for the shell's next prompt.
   * @param {string} command @param {number} [timeout]
   * @returns {Promise<{exit: number, head: string, output: string} | null>}
   */
  async function runTerminalCommand(command, timeout = 120000) {
    const before = terminalPrompt();
    if (!before || !await typeIntoTerminal(command)) return null;
    const term = terminalTerm();
    // Let the shell echo the last keystrokes before marking where the output starts.
    await sleep(250);
    await whilePaused();
    if (demoStopped || !term) return null;
    const typed = term.buffer.active;
    const commandEnd = typed.baseY + typed.cursorY;
    term.input('\r', true);
    const after = await waitUntil(() => {
      highlightTerminal();
      const prompt = terminalPrompt();
      return prompt && prompt.count > before.count ? prompt : null;
    }, timeout, 100);
    if (!after || terminalTerm() !== term) return null;
    const buffer = term.buffer.active;
    /** @type {string[]} */
    const lines = [];
    for (let row = commandEnd + 1; row < buffer.baseY + buffer.cursorY; row += 1) {
      const line = buffer.getLine(row);
      if (!line) continue;
      if (line.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true);
      else lines.push(line.translateToString(true));
    }
    clearTimeout(pointerTimer);
    pointerTimer = setTimeout(() => { pointer.removeAttribute('data-visible'); }, 2700);
    return {exit: after.exit, head: after.head, output: lines.join('\n')};
  }

  /**
   * The terminal keeps its checkout between missions. Start from a current
   * checkout and keep anyone's earlier work recoverable: uncommitted changes go
   * to the stash. Returns why the checkout cannot be used, or null.
   */
  async function prepareCheckout() {
    narrateRepair('Check the terminal\'s Git checkout before editing.',
      'The lab terminal keeps its checkout between missions, so it may hold someone\'s unfinished changes.');
    const status = await runTerminalCommand('git status --short --branch');
    if (demoStopped) return null;
    if (!status || status.exit) return 'The terminal could not show the checkout\'s status';
    const [branch = '', ...changes] = status.output.split('\n').filter(line => line.trim());
    if (/\bahead \d+/.test(branch)) return 'The terminal checkout has unpushed commits from earlier work';
    if (changes.length) {
      narrateRepair('Stash the uncommitted changes left in the checkout.',
        'The stash keeps them, and git stash pop restores them; the repair starts from a clean checkout.');
      const stash = await runTerminalCommand('git stash push --include-untracked --message "before demo"');
      if (demoStopped) return null;
      if (!stash || stash.exit) return 'The terminal could not stash the earlier changes';
    }
    narrateRepair('Update the checkout from the lab repository.',
      'Editing the newest commit on main lets the push fast-forward.');
    const pull = await runTerminalCommand('git pull --ff-only');
    if (demoStopped) return null;
    if (!pull || pull.exit) return 'The terminal checkout could not fast-forward to main';
    return null;
  }

  /** @param {RepairStep} step @returns {Promise<RepairOutcome>} */
  async function runCommands(step) {
    try { return await typeCommands(step); }
    finally { clearTerminalHighlight(); }
  }

  /** @param {RepairStep} step @returns {Promise<RepairOutcome>} */
  async function typeCommands(step) {
    if (demoRepair.stage !== 'terminal') saveDemoRepair({...demoRepair, stage: 'terminal'});
    if (!await openTerminal()) return demoStopped ? 'stopped' : fail('The lab terminal did not open');
    if (!demoRepair.checkoutReady) {
      const problem = await prepareCheckout();
      if (demoStopped) return 'stopped';
      if (problem) return fail(problem);
      saveDemoRepair({...demoRepair, checkoutReady: true});
    }
    narrateRepair(step.what);
    for (let index = demoRepair.command; index < step.commands.length; index += 1) {
      const command = step.commands[index];
      const result = await runTerminalCommand(command);
      if (demoStopped) return 'stopped';
      if (!result) return fail(`The terminal did not finish ${command}`);
      if (result.exit) return fail(`${command} exited with status ${result.exit}`);
      // After the commit and push, HEAD is the repair's commit.
      saveDemoRepair({...demoRepair, command: index + 1, commit: result.head});
    }
    // A person tucks the terminal away before using Argo CD or Gitea again.
    clearTerminalHighlight();
    await minimizeTerminal();
    return 'done';
  }

  // Gitea -----------------------------------------------------------------------

  /** @param {RepairStep} step @returns {Promise<RepairOutcome>} */
  async function viewSource(step) {
    const stage = demoRepair.stage;
    if (!stage) return clickToNavigate(giteaButton, 'opening', `Open ${step.path} in Git with View Git source.`);
    if (stage === 'opening') {
      if (!onGiteaFile(step.path)) return fail(`Gitea did not open ${step.path}`);
      const line = await waitUntil(() => Array.from(document.querySelectorAll('main code.code-inner, [role="main"] code.code-inner'))
        .find(code => visible(code) && code.textContent?.includes(step.find)), 5000);
      if (!line) return fail(`Gitea did not show ${step.find} in ${step.path}`);
      narrateRepair(`${step.path} refers to ${step.find}.`, step.why, 'learning');
      await pointAt(line);
      saveDemoRepair({...demoRepair, stage: 'shown'});
      return 'read';
    }
    if (stage === 'shown') return clickToNavigate(argoButton, 'returning', 'Return to Argo CD.');
    return onApplicationPage() ? 'done' : fail('Argo CD did not open the Application');
  }

  /** @param {RepairStep} step @returns {Promise<RepairOutcome>} */
  async function viewCommit(step) {
    const stage = demoRepair.stage;
    if (!stage) return clickToNavigate(giteaButton, 'opening', `Open ${step.path} in Git with View Git source.`);
    if (stage === 'opening') {
      if (!onGiteaFile(step.path)) return fail(`Gitea did not open ${step.path}`);
      const latest = await waitUntil(() => Array.from(document.querySelectorAll('.latest-commit a.commit-id-short')).find(visible), 5000);
      const commit = (latest?.getAttribute('href') || '').split('/commit/')[1] || '';
      if (!latest) return fail('Gitea did not show the file\'s latest commit');
      if (/^[0-9a-f]{40}$/.test(demoRepair.commit || '') && commit !== demoRepair.commit) {
        return fail(`Gitea's latest commit for ${step.path} is not the one just pushed`);
      }
      return clickToNavigate(() => latest, 'commit', `Open the latest commit, ${commit.slice(0, 10)}, which was just pushed.`);
    }
    if (stage === 'commit') {
      if (!location.pathname.startsWith(`${giteaRepository}/commit/`)) return fail('Gitea did not open the commit');
      const file = await waitUntil(() => Array.from(document.querySelectorAll('.diff-file-box'))
        .find(box => box.getAttribute('data-new-filename') === step.path && visible(box)), 5000);
      if (!file) return fail(`The commit does not change ${step.path}`);
      const changes = Array.from(file.querySelectorAll('tr.del-code, tr.add-code')).filter(visible);
      const commit = location.pathname.split('/commit/')[1]?.slice(0, 10);
      narrateRepair(`Commit ${commit} changes ${step.path}.`, step.why, 'learning');
      await pointAt(changes[0]?.querySelector('code') || file.querySelector('.file-link') || file, false, changes.at(-1) || null);
      saveDemoRepair({...demoRepair, stage: 'reviewed'});
      return 'read';
    }
    if (stage === 'reviewed') return clickToNavigate(argoButton, 'returning', 'Return to Argo CD.');
    return onApplicationPage() ? 'done' : fail('Argo CD did not open the Application');
  }

  // Argo CD ---------------------------------------------------------------------

  /** The Application as Argo CD's API reports it. @returns {Promise<ArgoApplication>} */
  async function argoApplication() {
    const token = localStorage.getItem('argocd.token');
    const response = await fetch(`/argocd/api/v1/applications/${encodeURIComponent(view.application)}?appNamespace=argocd`,
      {headers: token ? {Authorization: `Bearer ${token}`} : {}});
    if (!response.ok) throw new Error(`Argo CD returned ${response.status}`);
    return response.json();
  }

  /** @param {ArgoApplication} app */
  const operationRunning = app => ['Running', 'Terminating'].includes(app?.status?.operationState?.phase);

  /** @param {ArgoApplication} app @param {RepairResource} resource */
  const listedResource = (app, resource) => (app?.status?.resources || []).find(item => item.kind === resource.kind &&
    item.name === resource.name && (item.namespace || '') === resource.namespace);

  const openedPanel = () => Array.from(document.querySelectorAll('.sliding-panel--opened')).find(visible) || null;

  async function closeArgoPanels() {
    for (let attempt = 0; attempt < 3 && !demoStopped; attempt += 1) {
      const close = openedPanel()?.querySelector('.sliding-panel__close');
      if (!close) return true;
      await activate(close, true);
      await waitUntil(() => !close.isConnected || !visible(close), 3000);
    }
    return !openedPanel();
  }

  /** From another Argo CD page, a person opens the Application from the sidebar and its tile. */
  async function openApplication() {
    if (onApplicationPage()) return true;
    if (!location.pathname.startsWith('/argocd/')) return false;
    const findCard = () => {
      const label = Array.from(document.querySelectorAll('body *')).find(element =>
        element.childElementCount === 0 && element.textContent?.trim() === view.application && visible(element));
      return label?.closest('a[href]') || label || null;
    };
    let card = findCard();
    if (!card) {
      const applications = argoSidebarItem('Applications');
      if (!applications) return false;
      narrateRepair('Open Applications in the Argo CD sidebar.');
      if (!await activate(applications, true)) return false;
      card = await waitUntil(findCard, 10000);
    }
    if (!card) return false;
    narrateRepair(`Open the ${view.application} Application.`);
    await activate(card, true);
    return Boolean(await waitUntil(() => onApplicationPage() &&
      document.querySelector('.application-status-panel, .application-resource-tree__node-title'), 15000));
  }

  /** Opens the Application with no Argo drawer over its controls. */
  async function readyApplication() {
    if (!await openApplication()) return false;
    return closeArgoPanels();
  }

  /**
   * Types into an Argo CD form field a character at a time, with the pointer on
   * it. Argo's forms are React components that track each input's value, so
   * set it through the native setter and report every change with an input event.
   * @param {HTMLInputElement} field @param {string} text
   */
  async function typeIntoArgoField(field, text) {
    if (!await pointAt(field)) return false;
    clearTimeout(pointerTimer);
    pointer.dataset.visible = 'true';
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    /** @param {string} value */
    const enter = value => {
      setValue.call(field, value);
      field.dispatchEvent(new Event('input', {bubbles: true}));
    };
    field.focus({preventScroll: true});
    field.select();
    await sleep(300);
    enter('');
    for (const char of text) {
      await whilePaused();
      if (demoStopped || !field.isConnected) return false;
      enter(field.value + char);
      await sleep(demoTypingDelay);
    }
    pointerTimer = setTimeout(() => { pointer.removeAttribute('data-visible'); }, 1200);
    return field.value === text;
  }

  /** @param {RepairStep} step @returns {Promise<RepairOutcome>} */
  async function terminateOperation(step) {
    if (!operationRunning(await argoApplication())) {
      return {skipped: 'No sync operation is running, so there is nothing to terminate.'};
    }
    if (!await readyApplication()) return fail('Argo CD did not open the Application');
    narrateRepair(`Open Sync Status on ${view.application}.`);
    const status = exactControl('Sync Status');
    if (!status || !await activate(status, true)) return fail('Sync Status could not be opened');
    const terminate = await waitUntil(() => openedPanel() && exactControl('Terminate', openedPanel()), 10000);
    if (!terminate) {
      if (!operationRunning(await argoApplication())) {
        await closeArgoPanels();
        return {skipped: 'The operation ended on its own, so there is nothing to terminate.'};
      }
      return fail('Sync Status shows no Terminate button');
    }
    narrateRepair('Terminate the running operation.');
    await activate(terminate, true);
    const confirm = await waitUntil(() => Array.from(document.querySelectorAll(
      '.popup-container [qe-id="argo-popup-ok-button"]')).find(visible), 5000);
    if (!confirm) return fail('Argo CD did not ask to confirm the termination');
    narrateRepair('Confirm the termination with OK.');
    await activate(confirm, true);
    if (!await waitUntil(async () => !operationRunning(await argoApplication()), 30000, 1000)) {
      return fail('The operation did not stop');
    }
    const result = openedPanel() && Array.from(openedPanel().querySelectorAll('*'))
      .find(element => !element.childElementCount && /operation terminated/i.test(element.textContent || '') && visible(element));
    narrateRepair('Argo CD terminated the operation.', step.why, 'learning');
    if (result) await pointAt(result);
    await closeArgoPanels();
    return 'done';
  }

  /** @param {RepairStep} step @returns {Promise<RepairOutcome>} */
  async function syncApplication(step) {
    const commit = demoRepair.commit || '';
    narrateRepair(`Wait for Argo CD to compare commit ${commit.slice(0, 7)} and finish any operation it started.`);
    const before = await waitUntil(async () => {
      const app = await argoApplication();
      const compared = !/^[0-9a-f]{40}$/.test(commit) || app?.status?.sync?.revision === commit;
      return compared && !operationRunning(app) ? app : null;
    }, 180000, 3000);
    if (!before) return fail('Argo CD did not compare the pushed commit');
    await refresh();
    if (view.fixed) return {skipped: 'Argo CD has already synced the repaired revision.'};
    if (!await readyApplication()) return fail('Argo CD did not open the Application');
    narrateRepair(`Open Sync on ${view.application}.`);
    const sync = exactControl('Sync');
    if (!sync || !await activate(sync, true)) return fail('Sync could not be opened');
    const synchronize = await waitUntil(() => Array.from(document.querySelectorAll(
      '[qe-id="application-sync-panel-button-synchronize"]')).find(visible), 10000);
    if (!synchronize) return fail('The Sync panel did not open');
    narrateRepair('Synchronize.', step.why);
    await activate(synchronize, true);
    const started = await waitUntil(async () => (await argoApplication())?.status?.operationState?.startedAt !==
      before.status?.operationState?.startedAt, 15000, 1000);
    return started ? 'done' : fail('Argo CD did not start the sync');
  }

  /** @param {RepairStep} step @returns {Promise<RepairOutcome>} */
  async function inspectDiff(step) {
    const resource = step.resource;
    if (demoRepair.stage === 'shown') {
      await closeArgoPanels();
      return 'done';
    }
    narrateRepair('Wait for Argo CD to compare the pushed commit.');
    const pending = await waitUntil(async () => listedResource(await argoApplication(), resource)?.requiresPruning, 180000, 3000);
    if (!pending) return fail(`Argo CD does not list ${resource.kind} ${resource.name} for pruning`);
    if (!await readyApplication()) return fail('Argo CD did not open the Application');
    narrateRepair(`Open Diff on ${view.application}.`);
    const diff = await waitUntil(() => {
      const button = /** @type {HTMLButtonElement} */ (exactControl('Diff'));
      return button && !button.disabled ? button : null;
    }, 15000);
    if (!diff) return fail('Diff could not be opened');
    await activate(diff, true);
    if (!await waitForDemoContent('app.diff')) return fail('Diff did not open');
    const entry = Array.from(document.querySelectorAll('.application-resources-diff *')).find(element =>
      !element.childElementCount && element.textContent?.includes(resource.name) && visible(element));
    narrateRepair(`Only ${resource.kind} ${resource.name} is left to remove.`, step.why, 'learning');
    if (entry) await pointAt(entry);
    saveDemoRepair({...demoRepair, stage: 'shown'});
    return 'read';
  }

  /** @param {RepairStep} step @returns {Promise<RepairOutcome>} */
  async function pruneResource(step) {
    const resource = step.resource;
    const name = `${resource.group}/${resource.kind}/${resource.namespace}/${resource.name}`;
    if (!listedResource(await argoApplication(), resource)) {
      return {skipped: `${resource.kind} ${resource.name} is already gone.`};
    }
    if (!await readyApplication()) return fail('Argo CD did not open the Application');
    narrateRepair(`Open Sync on ${view.application}.`);
    const sync = exactControl('Sync');
    if (!sync || !await activate(sync, true)) return fail('Sync could not be opened');
    const panel = await waitUntil(() => {
      const opened = openedPanel();
      return opened?.querySelector('[qe-id="application-sync-panel-button-synchronize"]') ? opened : null;
    }, 10000);
    if (!panel) return fail('The Sync panel did not open');
    narrateRepair('Clear the resource selection with Synchronize resources: none.');
    const none = Array.from(panel.querySelectorAll('a')).find(link => link.textContent?.trim() === 'none' && visible(link));
    if (!none) return fail('The Sync panel has no way to clear its selection');
    await activate(none, true);
    narrateRepair(`Select only ${name}.`);
    const label = await waitUntil(() => Array.from(panel.querySelectorAll('label'))
      .find(item => item.textContent?.trim() === name && visible(item)), 5000);
    if (!label) return fail(`The Sync panel does not list ${name}`);
    await activate(label, true);
    const prune = /** @type {HTMLLabelElement} */ (Array.from(panel.querySelectorAll('label'))
      .find(item => /^sync-option-Prune-/.test(item.getAttribute('for') || '')));
    const pruneBox = /** @type {HTMLInputElement} */ (prune && document.getElementById(prune.htmlFor));
    if (!prune || !pruneBox) return fail('The Sync panel has no Prune option');
    narrateRepair('Turn on Prune, so the sync deletes what Git no longer contains.');
    if (!pruneBox.checked) await activate(prune, true);
    // Check the selection before deleting anything: only the leftover resource, with Prune.
    const selected = Array.from(panel.querySelectorAll('.application-sync-panel__resource input[type="checkbox"]'))
      .filter(box => /** @type {HTMLInputElement} */ (box).checked).map(box => box.id);
    if (selected.join('\n') !== name || !pruneBox.checked) {
      await closeArgoPanels();
      return fail(`The Sync selection was not only ${name} with Prune`);
    }
    narrateRepair('Synchronize.', step.why);
    await activate(panel.querySelector('[qe-id="application-sync-panel-button-synchronize"]'), true);
    // Argo CD asks for the word prune before it deletes anything.
    const confirmation = () => Array.from(document.querySelectorAll('.popup-container'))
      .find(popup => visible(popup) && popup.querySelector('input')) || null;
    const asked = await waitUntil(confirmation, 10000);
    if (asked) {
      const field = /** @type {HTMLInputElement} */ (asked.querySelector('input'));
      narrateRepair(`Argo CD lists ${resource.kind}/${resource.name} to be deleted and asks for the word prune to confirm.`);
      if (!await typeIntoArgoField(field, 'prune')) return demoStopped ? 'stopped' : fail('The prune confirmation could not be typed');
      const ok = Array.from(asked.querySelectorAll('button')).find(button =>
        /popup-ok-button$/.test(button.getAttribute('qe-id') || '') || button.textContent?.trim().toUpperCase() === 'OK');
      narrateRepair('Confirm with OK.', step.why);
      if (!ok || !await activate(ok, true)) return fail('The prune confirmation could not be confirmed');
    }
    if (!await waitUntil(async () => !listedResource(await argoApplication(), resource), 120000, 2000)) {
      return fail(`Argo CD did not remove ${resource.kind} ${resource.name}`);
    }
    narrateRepair(`Argo CD pruned ${resource.kind} ${resource.name}.`, step.why, 'learning');
    return 'done';
  }

  /** @param {RepairStep} step @returns {Promise<RepairOutcome>} */
  async function setRepoURL(step) {
    if (!await readyApplication()) return fail('Argo CD did not open the Application');
    narrateRepair(`Open Details on ${view.application}.`);
    const details = exactControl('Details');
    if (!details || !await activate(details, true)) return fail('Details could not be opened');
    const source = () => Array.from(document.querySelectorAll('.sliding-panel--opened .editable-panel'))
      .find(panel => visible(panel) && /REPO URL/.test(panel.textContent || '')) || null;
    if (!await waitUntil(source, 15000)) return fail('Details does not show the Application source');
    narrateRepair('Edit the Source section.');
    const edit = exactControl('Edit', source());
    if (!edit || !await activate(edit, true)) return fail('The Source section could not be edited');
    const field = /** @type {HTMLInputElement} */ (await waitUntil(() => Array.from(source()?.querySelectorAll('.white-box__details-row') || [])
      .find(row => row.querySelector('.columns.small-3')?.textContent?.trim() === 'REPO URL')
      ?.querySelector('input.argo-field'), 5000));
    if (!field) return fail('The Source section has no Repo URL field');
    narrateRepair(`Set Repo URL to ${step.value}.`);
    if (!await typeIntoArgoField(field, step.value)) return demoStopped ? 'stopped' : fail('The Repo URL could not be typed');
    narrateRepair('Save the Application source.');
    const save = exactControl('Save', source());
    if (!save || !await activate(save, true)) return fail('The source could not be saved');
    const saved = await waitUntil(() => {
      const panel = source();
      return panel && !panel.querySelector('input.argo-field') && panel.textContent?.includes(step.value) ? panel : null;
    }, 15000);
    if (!saved) return fail('Argo CD did not save the Repo URL');
    const url = Array.from(saved.querySelectorAll('*')).find(element =>
      !element.childElementCount && element.textContent?.trim() === step.value && visible(element));
    narrateRepair(`Repo URL is now ${step.value}.`, step.why, 'learning');
    if (url) await pointAt(url);
    await closeArgoPanels();
    return 'done';
  }

  /** @param {RepairStep} step @returns {Promise<RepairOutcome>} */
  async function refreshApplication(step) {
    if (!await readyApplication()) return fail('Argo CD did not open the Application');
    narrateRepair(`Refresh ${view.application}.`, step.why);
    const refreshButton = Array.from(document.querySelectorAll('.argo-split-button__primary')).find(visible) ||
      exactControl('Refresh');
    if (!refreshButton || !await activate(refreshButton, true)) return fail('Refresh could not be clicked');
    await sleep(1500);
    return 'done';
  }

  /** @type {Record<RepairStep['action'], (step: RepairStep) => Promise<RepairOutcome>>} */
  const repairActions = {
    'run-commands': runCommands, 'view-source': viewSource, 'view-commit': viewCommit,
    'terminate-operation': terminateOperation, 'sync': syncApplication, 'diff': inspectDiff,
    'prune': pruneResource, 'set-repo-url': setRepoURL, 'refresh': refreshApplication,
  };

  async function startRepair() {
    /** @type {RepairPlan} */
    let plan;
    try {
      plan = await request(`${sessionPath}/repair-plan`);
      if (!plan?.steps?.length) throw new Error('the plan has no steps');
    } catch (reason) {
      await fallBack(null, `The repair plan could not be loaded: ${reason.message}`);
      return;
    }
    saveDemoRepair({plan, step: 0, stage: null, command: 0});
    setDemoNarration(demoStepId(), 'what');
  }

  async function driveRepair() {
    const step = repairStep();
    if (!step) return;
    await whilePaused();
    if (demoStopped) return;
    /** @type {RepairOutcome} */
    let outcome;
    try { outcome = await repairActions[step.action](step); }
    catch (reason) { outcome = fail(reason.message); }
    if (demoStopped || typeof outcome === 'string' && outcome !== 'done') return;
    if (typeof outcome === 'object' && 'failed' in outcome) {
      await fallBack(step, outcome.failed);
      return;
    }
    const next = demoRepair.step + 1;
    saveDemoRepair({...demoRepair, step: next, stage: null, command: 0});
    setDemoNarration(next < demoRepair.plan.steps.length ? demoStepId() : `fix:${view.scenario.id}`,
      next < demoRepair.plan.steps.length ? 'what' : 'learning');
    if (typeof outcome === 'object') say(outcome.skipped);
    if (next >= demoRepair.plan.steps.length) await refresh();
  }

  /**
   * A step could not finish: say why, record it, and apply the controller's
   * reference repair so the demonstration still ends.
   * @param {RepairStep | null} step @param {string} reason
   */
  async function fallBack(step, reason) {
    demoNavigating = false;
    const details = {step: step?.id || 'plan', action: step?.action || 'repair-plan', reason};
    console.warn('[coach-fallback]', JSON.stringify(details));
    sendAction('demo_fallback', details);
    if (demoRepair) saveDemoRepair({...demoRepair, fellBack: details.step});
    await refresh();
    if (view.fixed) {
      say(`${reason}. The repair has already reached Argo CD, so the demonstration continues.`);
      return;
    }
    await performDemoFix(`fix:${view.scenario.id}`, `${reason}, so the coach applied the repair for you.`);
  }

  /**
   * The scenario controller's reference repair, used only when a demonstrated step cannot finish.
   * @param {string} fixStep @param {string} notice
   */
  async function performDemoFix(fixStep, notice) {
    demoFixStarted = true;
    sessionStorage.setItem(demoFixKey, 'true');
    setDemoNarration(fixStep, 'doing');
    say(notice);
    /** @type {DemonstrateFixResponse} */
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
    say(notice);
    await demoWait();
    if (!demoStopped) await refresh();
  }

  async function driveDemo() {
    if (demoBusy || demoNavigating || demoStopped || briefOpen || !view || !['READY', 'INVESTIGATING', 'FIXED'].includes(view.state) || view.feedback) return;
    demoBusy = true;
    try {
      const expectedStep = demoStepId();
      await sending;
      if (demoStopped || view.feedback || !ready() || expectedStep !== demoStepId()) return;
      if (repairStep()) {
        await driveRepair();
        return;
      }
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
      } else if (!view.fixed && view.scenario.level !== 1 && !demoFixStarted && !demoRepair) {
        await startRepair();
      } else if (view.fixed && view.checks_passed >= view.checks_total) {
        if (!noteOpen) {
          say('Writing the incident note.');
          await demoWait();
          if (demoStopped) return;
        }
        /** @type {Partial<DemonstrationNote>} */
        const note = view.demonstration_note || {};
        const values = {resource: note.resource || view.application, evidence: note.evidence || 'Healthy and Synced',
          revision: note.revision || view.revision, cause: note.cause || 'No incident', fix: note.fix || 'No fix needed'};
        // Level 1 missions finish without a note form.
        if (view.scenario.level === 1) await submitNote(values);
        else await demonstrateNote(values);
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

  // Listeners on root and dockRoot only see events from the coach's own markup.
  /** @param {Event} event */
  const eventElement = event => /** @type {Element} */ (event.target);

  root.addEventListener('click', event => {
    const action = eventElement(event).closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'retry-session') refresh();
    else if (action === 'replay') replayMission();
    else if (action === 'dismiss-debrief') dismissDebrief();
    else if (action === 'show-debrief') showDebrief();
    else if (action === 'begin') beginInvestigation();
    else if (action === 'advance' && !demoPaused) demoAdvance?.();
    else if (action === 'pause-demo') setDemoPaused(!demoPaused);
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
    else if (action === 'argocd') location.href = `/argocd/applications/argocd/${encodeURIComponent(view.application)}`;
    else if (action === 'gitea') {
      const path = eventElement(event).closest('[data-action]').dataset.path || view.fix_paths?.[0] || '';
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
  root.addEventListener('pointerdown', event => {
    const handle = eventElement(event).closest('.coach-drag-handle');
    if (!handle || event.button !== 0 || !event.isPrimary) return;
    const panel = handle.closest('.panel');
    const start = panel.getBoundingClientRect();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    event.preventDefault();
    handle.setPointerCapture(pointerId);
    handle.setAttribute('data-dragging', '');
    const move = update => {
      if (update.pointerId !== pointerId) return;
      const currentPanel = root.querySelector('.panel');
      if (currentPanel) positionCoach(currentPanel, start.left + update.clientX - startX,
        start.top + update.clientY - startY, true);
    };
    const finish = () => {
      handle.removeAttribute('data-dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      handle.removeEventListener('lostpointercapture', finish);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
  });
  dockRoot.addEventListener('click', event => {
    if (eventElement(event).closest('[data-action="close-terminal"]')) {
      terminalOpen = false;
      terminalMinimized = false;
      renderDock(); render();
    } else if (eventElement(event).closest('[data-action="minimize-terminal"]')) {
      terminalMinimized = !terminalMinimized;
      renderDock(); render();
    }
  });
  dockRoot.addEventListener('pointerdown', event => {
    const handle = eventElement(event).closest('.terminal-resize');
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
    if (!eventElement(event).matches('.terminal-resize')) return;
    const steps = {ArrowLeft: [20, 0], ArrowRight: [-20, 0], ArrowUp: [0, 20], ArrowDown: [0, -20]};
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    const bounds = dockRoot.querySelector('.terminal-dock').getBoundingClientRect();
    resizeTerminal(bounds.width + step[0], bounds.height + step[1]);
  });
  root.addEventListener('submit', event => {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.target);
    if (form.id === 'check-form') {
      answerCheck(/** @type {HTMLInputElement} */ (root.querySelector('#check-answer'))?.value || '');
    } else if (form.id === 'note-form') {
      noteSubmissions += 1;
      // noteForm() renders one textarea for each IncidentNote field.
      submitNote(/** @type {IncidentNote} */ (/** @type {unknown} */ (Object.fromEntries(new FormData(form)))));
    }
  });
  root.addEventListener('keydown', event => {
    if (eventElement(event).matches('.coach-drag-handle')) {
      const step = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
      if (step) {
        event.preventDefault();
        const panel = root.querySelector('.panel');
        const bounds = panel.getBoundingClientRect();
        const distance = event.shiftKey ? 50 : 20;
        positionCoach(panel, bounds.left + step[0] * distance, bounds.top + step[1] * distance, true);
        return;
      }
    }
    if (event.key === 'Escape' && noteOpen) { noteOpen = false; render(); }
  });
  addEventListener('resize', () => {
    const panel = root.querySelector('.panel');
    if (panel && panelPosition) positionCoach(panel, panelPosition.x, panelPosition.y, true);
    else if (clearPosition) { clearPosition = null; render(); }
  });
  addEventListener('pointerdown', () => stepClock.input(), {passive: true});
  addEventListener('keydown', () => stepClock.input(), {passive: true});
  addEventListener('keydown', event => {
    if (event.key === 'Escape' && view?.feedback && !debriefDismissed) dismissDebrief();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pauseBriefCountdown();
      pauseDemoDelay();
    } else {
      startBriefCountdown();
      resumeDemoDelay();
      scheduleDemo();
    }
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
    if (!document.hidden && !view?.feedback && window.WebSocket && stream?.readyState === WebSocket.OPEN &&
        Date.now() - lastStreamMessage > 12000) refresh();
  }, 12000);
})();
