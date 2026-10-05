import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const GuidedStepClock = require('../src/step-clock.js');

test('guided check-ins count active time, wait for quiet, and back off', () => {
  let now = 0;
  let paused = false;
  let due = 0;
  const clock = new GuidedStepClock({
    now: () => now,
    isPaused: () => paused,
    onDue: () => { due += 1; },
    setTimer: () => 1,
    clearTimer: () => {},
    idleMs: 5000,
  });
  const advance = seconds => {
    for (let index = 0; index < seconds * 2; index++) {
      now += 500;
      clock.tick();
    }
  };

  clock.start('check:application', 45);
  advance(20);
  paused = true;
  advance(20);
  assert.equal(clock.seconds, 20);
  paused = false;
  advance(23);
  clock.input();
  advance(2);
  assert.equal(due, 0, 'recent activity should defer a check-in');
  advance(3);
  assert.equal(due, 1);

  clock.keepGoing();
  advance(67);
  assert.equal(due, 1, 'first decline backs off by one and a half budgets');
  advance(1);
  assert.equal(due, 2);
  clock.keepGoing();
  advance(180);
  assert.equal(due, 2, 'two declines suppress further check-ins on this step');

  clock.start('fix:missing-configmap', 90);
  advance(89);
  assert.equal(due, 2);
  advance(1);
  assert.equal(due, 3, 'a new step gets a fresh budget');
  clock.stop();
});
