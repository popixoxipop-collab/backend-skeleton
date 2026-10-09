import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_MANIFEST_SCHEMA } from '../../lib/trust-next/permission-manifest.mjs';
import { createEnforcementGate } from '../../lib/trust-next/enforcement-gate.mjs';
import { createRecordingHost } from './enforcement-host.mjs';

// The wall_ms limit of a spawned child, under injected timers. A timer takes at most 2^31-1 ms (about 24.8 days) and fires a longer
// delay after 1 ms, so the gate arms a longer wall_ms as a chain of timers. The timers here are fake: a limit of days or of
// Number.MAX_SAFE_INTEGER ms is checked at once, and no test in this file waits on a real timer. enforcement-gate-limits.test.mjs
// and enforcement-gate-real.test.mjs check the same limit with real timers and real children.

const MAX_TIMER_MS = 2_147_483_647;

const manifest = (limits) => ({
  schema: PERMISSION_MANIFEST_SCHEMA,
  process: { mode: 'argv-allowlist', executables: ['node'], max_children: 1 },
  ...(limits === undefined ? {} : { limits }),
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

// One timer is armed at a time. A delay that no timer honours is refused, so the tests cannot pass on a delay that a real timer
// would turn into 1 ms. `elapse()` lets the armed timer run out; its callback may arm the next link of the chain.
function fakeTimers() {
  let armed = null;
  const log = { armed: 0, delays: [], cleared: [] };
  return {
    log,
    setTimeout(callback, delay) {
      if (!Number.isInteger(delay) || delay < 1 || delay > MAX_TIMER_MS) throw new RangeError(`${delay} is not a delay a timer takes`);
      if (armed !== null) throw new Error('the gate armed the next link before the previous one elapsed');
      log.armed += 1;
      log.delays.push(delay);
      armed = { id: log.armed, callback };
      return armed.id;
    },
    clearTimeout(id) {
      log.cleared.push(id);
      if (armed?.id === id) armed = null;
    },
    get pending() { return armed === null ? 0 : 1; },
    elapse() {
      if (armed === null) throw new Error('no timer is armed');
      const { callback } = armed;
      armed = null;
      callback();
    },
  };
}

// A child that ends only when the gate kills it, or when the test ends it.
function start(limits, { timers = fakeTimers() } = {}) {
  const kills = [];
  let end;
  const host = createRecordingHost({
    spawnImpl: () => {
      const done = new Promise((resolve) => { end = resolve; });
      return { pid: 4242, kill(signal) { kills.push(signal); end({ exit_code: null, signal }); }, done };
    },
  });
  const gate = createEnforcementGate({ manifest: manifest(limits), host, timers });
  const state = { settled: false, result: null, error: null };
  const run = gate.spawn('node', [], {}).then((value) => { state.settled = true; state.result = value; }, (error) => { state.settled = true; state.error = error; });
  return { gate, timers, kills, state, run, finish: (exit) => end(exit) };
}

async function withinOneLink(limits) {
  const child = start(limits);
  await flush();
  return child;
}

test('a wall_ms within the timer limit arms one timer for exactly that long, and the child is killed when it elapses', async () => {
  for (const [limits, wall] of [[{ wall_ms: 1234 }, 1234], [undefined, 30_000], [{ wall_ms: 1 }, 1], [{ wall_ms: MAX_TIMER_MS }, MAX_TIMER_MS]]) {
    const child = await withinOneLink(limits);
    assert.deepEqual(child.timers.log.delays, [wall], `wall_ms ${wall}`);
    assert.equal(child.state.settled, false);
    assert.deepEqual(child.kills, []);
    child.timers.elapse();
    await flush();
    assert.equal(child.state.settled, true);
    assert.equal(child.state.error, null);
    assert.equal(child.state.result.timed_out, true);
    assert.equal(child.state.result.killed_for, 'wall_ms');
    assert.equal(child.state.result.signal, 'SIGKILL');
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.deepEqual(child.timers.log.delays, [wall], 'no second timer after the kill');
    const outcome = child.gate.audit().at(-1);
    assert.equal(outcome.timed_out, true);
    assert.equal(outcome.killed_for, 'wall_ms');
    assert.deepEqual(child.gate.verifyAudit(), { ok: true, errors: [] });
  }
});

test('a wall_ms above the timer limit is a chain of timers whose delays add up to it: the child lives until the whole time has passed', async () => {
  for (const wall of [MAX_TIMER_MS + 1, 2 * MAX_TIMER_MS, 2 * MAX_TIMER_MS + 12_345, 40 * MAX_TIMER_MS + 7]) {
    const child = await withinOneLink({ wall_ms: wall });
    const links = Math.ceil(wall / MAX_TIMER_MS);
    for (let link = 1; link <= links; link += 1) {
      assert.equal(child.timers.pending, 1, `wall ${wall}, link ${link}: one timer is armed`);
      assert.equal(child.timers.log.armed, link, `wall ${wall}: ${link} timers were armed so far`);
      assert.deepEqual(child.kills, [], `wall ${wall}: the child is alive before link ${link} elapses`);
      assert.equal(child.state.settled, false, `wall ${wall}: the spawn is still running before link ${link} elapses`);
      child.timers.elapse();
      await flush();
    }
    assert.equal(child.timers.log.delays.length, links, `wall ${wall}`);
    assert.ok(child.timers.log.delays.every((delay) => delay <= MAX_TIMER_MS));
    assert.equal(child.timers.log.delays.reduce((sum, delay) => sum + delay, 0), wall, `the delays of the chain add up to ${wall}`);
    assert.equal(child.timers.log.delays.at(-1), wall - (links - 1) * MAX_TIMER_MS);
    assert.equal(child.state.settled, true);
    assert.equal(child.state.result.timed_out, true);
    assert.equal(child.state.result.killed_for, 'wall_ms');
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(child.timers.pending, 0);
  }
});

test('the largest wall_ms the manifest takes is a chain of millions of links, and the child is killed at the last one and not before', async () => {
  const wall = Number.MAX_SAFE_INTEGER;
  const child = await withinOneLink({ wall_ms: wall });
  const links = Math.ceil(wall / MAX_TIMER_MS);
  assert.equal(links, 4_194_305);
  let killedEarly = 0;
  let idle = 0;
  for (let link = 1; link <= links; link += 1) {
    if (child.timers.pending !== 1) idle += 1;
    child.timers.elapse();
    // The callbacks run without a macrotask in between, so the kill, once it happens, is visible at once.
    if (link < links && child.kills.length !== 0) killedEarly += 1;
  }
  const { delays } = child.timers.log;
  assert.equal(idle, 0, 'one timer is armed before every link elapses');
  assert.equal(killedEarly, 0, 'no kill before the last link');
  assert.equal(delays.length, links);
  let total = 0;
  let oversized = 0;
  for (const delay of delays) { total += delay; if (delay > MAX_TIMER_MS) oversized += 1; }
  assert.equal(oversized, 0);
  assert.equal(total, wall, 'the delays of the chain add up to the limit');
  assert.equal(delays.at(-1), wall - (links - 1) * MAX_TIMER_MS);
  assert.equal(delays.at(-1), 4_194_303);
  assert.deepEqual(child.kills, ['SIGKILL']);
  await flush();
  assert.equal(child.state.result.timed_out, true);
  assert.equal(child.state.result.killed_for, 'wall_ms');
  assert.equal(child.timers.pending, 0);
});

test('a child that ends before its wall time is not killed, and the timer that is armed at that moment is cleared', async () => {
  const early = await withinOneLink({ wall_ms: 5000 });
  early.finish({ exit_code: 0, signal: null });
  await flush();
  assert.equal(early.state.result.timed_out, false);
  assert.equal(early.state.result.killed_for, null);
  assert.equal(early.state.result.exit_code, 0);
  assert.deepEqual(early.kills, []);
  assert.deepEqual(early.timers.log.cleared, [1]);
  assert.equal(early.timers.pending, 0);
  // In the middle of a chain it is the current link that is cleared, so no later link can fire.
  const chained = await withinOneLink({ wall_ms: 2 * MAX_TIMER_MS + 5 });
  chained.timers.elapse();
  chained.timers.elapse();
  await flush();
  assert.deepEqual(chained.timers.log.delays, [MAX_TIMER_MS, MAX_TIMER_MS, 5]);
  chained.finish({ exit_code: 3, signal: null });
  await flush();
  assert.equal(chained.state.result.exit_code, 3);
  assert.equal(chained.state.result.timed_out, false);
  assert.deepEqual(chained.kills, []);
  assert.deepEqual(chained.timers.log.cleared, [3]);
  assert.equal(chained.timers.pending, 0);
});

test('a spawn the host refuses arms no timer and clears none', async () => {
  const timers = fakeTimers();
  const host = createRecordingHost({ spawnImpl: () => { throw Object.assign(new Error('no fork'), { code: 'EBOOM' }); } });
  const gate = createEnforcementGate({ manifest: manifest({ wall_ms: 100 }), host, timers });
  await assert.rejects(gate.spawn('node', [], {}), { code: 'EBOOM' });
  assert.deepEqual(timers.log, { armed: 0, delays: [], cleared: [] });
  assert.equal(gate.audit().at(-1).ok, false);
});

test('the gate takes injected timers or the runtime ones, and nothing else', () => {
  const host = createRecordingHost();
  const code = (options) => { try { createEnforcementGate({ manifest: manifest(), host, ...options }); } catch (error) { return error.code; } return 'NO_ERROR'; };
  for (const timers of [null, 5, 'timers', {}, { setTimeout() {} }, { clearTimeout() {} }, { setTimeout: 1, clearTimeout() {} }, { setTimeout() {}, clearTimeout: 'x' }]) {
    assert.equal(code({ timers }), 'INVALID_GATE_TIMERS', JSON.stringify(timers) ?? 'undefined');
  }
  assert.equal(code({ timers: { setTimeout() {}, clearTimeout() {} } }), 'NO_ERROR');
  assert.equal(code({ timers: undefined }), 'NO_ERROR');
  assert.equal(code({}), 'NO_ERROR');
});
