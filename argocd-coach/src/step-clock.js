// Guided time is active time on the current goal. Hidden tabs, briefing and
// note forms pause it. A check-in waits for a quiet moment and never penalizes
// the learner for continuing.
class GuidedStepClock {
  constructor({isPaused = () => false, isQuiet = () => true, onDue = () => {},
    now = () => performance.now(), setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = id => clearTimeout(id), tickMs = 500, idleMs = 5000} = {}) {
    Object.assign(this, {isPaused, isQuiet, onDue, now, setTimer, clearTimer, tickMs, idleMs});
    this.stepId = null;
    this.timer = null;
    this.active = 0;
  }
  start(stepId, budgetSeconds) {
    this.stop();
    this.stepId = stepId;
    this.budget = Math.max(45, Number(budgetSeconds) || 45) * 1000;
    this.active = 0;
    this.dueAt = this.budget;
    this.declines = 0;
    this.awaiting = false;
    this.lastTick = this.now();
    this.lastInput = this.lastTick;
    this.schedule();
  }
  get seconds() { return Math.round(this.active / 100) / 10; }
  stop() { this.clearTimer(this.timer); this.timer = null; this.stepId = null; }
  input() { this.lastInput = this.now(); }
  schedule() { this.timer = this.setTimer(() => this.tick(), this.tickMs); }
  tick() {
    const now = this.now();
    if (!this.isPaused()) this.active += Math.min(now - this.lastTick, 2 * this.tickMs);
    this.lastTick = now;
    if (!this.awaiting && this.dueAt != null && this.active >= this.dueAt &&
        now - this.lastInput >= this.idleMs && !this.isPaused() && this.isQuiet()) {
      this.awaiting = true;
      this.onDue(this.stepId);
    }
    if (this.stepId) this.schedule();
  }
  keepGoing() {
    this.awaiting = false;
    this.declines += 1;
    this.dueAt = this.declines >= 2 ? null : this.active + 1.5 * this.budget;
  }
  helped() {
    this.awaiting = false;
    if (this.dueAt != null) this.dueAt = this.active + this.budget;
  }
  retry() { this.awaiting = false; }
}
globalThis.GuidedStepClock = GuidedStepClock;
if (typeof module !== 'undefined') module.exports = GuidedStepClock;
