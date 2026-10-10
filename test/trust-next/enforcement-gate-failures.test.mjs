import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_MANIFEST_SCHEMA } from '../../lib/trust-next/permission-manifest.mjs';
import { EnforcementDenied, createEnforcementGate } from '../../lib/trust-next/enforcement-gate.mjs';
import { createRecordingHost } from './enforcement-host.mjs';

// The failure rule of the gate. Between the moment the host has started something (a child, a listener, a device, a write) and the moment
// the gate counts it as finished, the gate calls functions it does not own: the timers, the clock, the host and the caller's callback.
// When one of them fails, the gate stops what it can (kills the child, closes what offers close()), records the failure, releases what
// it counted (the slot of the child, the decision that is in flight) and rethrows the ORIGINAL error. A step of the gate's own, such as
// writing the outcome or clearing a timer, never replaces that error and never keeps a slot. The timers, the clock and the children
// here are scripted: nothing in this file waits on a real timer, and a child ends only when the test or the gate's kill says so.

const MAX_TIMER_MS = 2_147_483_647;
const LONG_WALL = { limits: { wall_ms: MAX_TIMER_MS + 1 } };

const manifest = (extra = {}) => ({
  schema: PERMISSION_MANIFEST_SCHEMA,
  read_roots: ['src'],
  write_roots: ['out'],
  network: { mode: 'allowlist', allow: [{ host: 'api.example.com', ports: [443] }] },
  listen: { mode: 'allowlist', allow: [{ host: '127.0.0.1', ports: [18080] }] },
  process: { mode: 'argv-allowlist', executables: ['node'], max_children: 1 },
  secret_refs: ['provider-token'],
  devices: { mode: 'allowlist', allow: ['gpu'] },
  ...extra,
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const fault = (code) => Object.assign(new Error(`${code} (scripted)`), { code });
const pick = (entry, keys) => Object.fromEntries(keys.map((key) => [key, entry?.[key]]));
const outcomeOf = (gate, seq) => gate.audit().find((entry) => entry.phase === 'outcome' && entry.decision_seq === seq);
const missing = (gate) => gate.verifyAudit().errors.map((error) => `${error.code}@${error.seq}`);
const inFlight = (gate) => gate.report().audit.in_flight;
const failedWith = (gate, seq = 0) => pick(outcomeOf(gate, seq), ['ok', 'error_code', 'killed_for']);

// One timer is armed at a time. Arming the n-th timer fails for every n in `failArm`; clearing fails while `clearError` is set.
function fakeTimers({ failArm = [], armError = fault('ETIMER'), clearError = null } = {}) {
  let armed = null;
  const timers = {
    log: { armed: 0, cleared: [] },
    clearError,
    setTimeout(callback) {
      timers.log.armed += 1;
      if (failArm.includes(timers.log.armed)) throw armError;
      armed = { id: timers.log.armed, callback };
      return armed.id;
    },
    clearTimeout(id) {
      timers.log.cleared.push(id);
      if (timers.clearError !== null) throw timers.clearError;
      if (armed?.id === id) armed = null;
    },
    get pending() { return armed === null ? 0 : 1; },
    elapse() {
      const { callback } = armed;
      armed = null;
      callback();
    },
  };
  return timers;
}

// A clock that can be broken and mended by the test; `failures` counts the calls that failed.
function controlledClock() {
  let now = 1_700_000_000_000;
  const clock = () => {
    if (clock.broken) {
      clock.failures += 1;
      throw clock.error;
    }
    now += 1;
    return now;
  };
  clock.broken = false;
  clock.failures = 0;
  clock.error = fault('ECLOCK');
  return clock;
}

// A child that ends only when the test ends it, or when the gate kills it and `killEnds` is set. `rejectOnKill` makes the host fail to
// report it (done rejects) instead; `killFails` makes kill() itself throw. `child.request` is the last spawn request.
function childHost({ killEnds = true, killFails = false, rejectOnKill = null, extra = {} } = {}) {
  const child = { kills: [], spawns: 0, request: null, end: null, crash: null };
  const host = createRecordingHost({
    ...extra,
    spawnImpl: (request) => {
      child.spawns += 1;
      child.request = request;
      const done = new Promise((resolve, reject) => { child.end = resolve; child.crash = reject; });
      return {
        pid: 4242,
        kill(signal) {
          child.kills.push(signal);
          if (killFails) throw fault('ESRCH');
          if (rejectOnKill !== null) child.crash(rejectOnKill);
          else if (killEnds) child.end({ exit_code: null, signal });
        },
        done,
      };
    },
  });
  return { host, child };
}

function launch(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  const done = promise.then((value) => { state.settled = true; state.value = value; }, (error) => { state.settled = true; state.error = error; });
  return { state, done };
}

// A scripted run settles within a few turns of the event loop, or it never settles (a child nobody ended, a report nobody sent). Waiting a
// bounded number of turns turns "never" into a failure that names the call, instead of a test runner that hangs.
async function settle(run) {
  for (let turn = 0; turn < 50 && !run.state.settled; turn += 1) await flush();
  assert.equal(run.state.settled, true, 'the call settles');
}

// Collects the unhandled rejections of the process until the returned function is called, which returns them.
function watchUnhandled() {
  const seen = [];
  const listener = (reason) => { seen.push(reason); };
  process.on('unhandledRejection', listener);
  return async () => {
    await flush();
    await flush();
    process.off('unhandledRejection', listener);
    return seen;
  };
}

async function releasedSlot(gate, child, label = 'the slot') {
  const later = launch(gate.spawn('node', [], {}));
  await flush();
  child.end({ exit_code: 0, signal: null });
  await settle(later);
  assert.equal(later.state.error, undefined, `${label}: a later spawn is not refused`);
  assert.equal(later.state.value.exit_code, 0, `${label} was released`);
}

test('a wall timer that cannot be armed stops the child, holds its slot until the host reports it gone, then records the failure and rethrows the timer error', async () => {
  const armError = fault('ETIMER');
  const timers = fakeTimers({ failArm: [1], armError });
  const { host, child } = childHost({ killEnds: false });
  const gate = createEnforcementGate({ manifest: manifest(), host, timers });
  const first = launch(gate.spawn('node', [], {}));
  await flush();
  assert.deepEqual(child.kills, ['SIGKILL'], 'a child the gate cannot hold to its wall limit is stopped at once');
  assert.equal(first.state.settled, false, 'the call waits until the host reports the child gone');
  assert.equal(inFlight(gate), 1, 'the decision is in flight while the child may be running');
  await assert.rejects(gate.spawn('node', [], {}), (error) => error instanceof EnforcementDenied && error.reason === 'PROCESS_CAPACITY_EXCEEDED');
  assert.equal(child.spawns, 1, 'the slot of a child that may still be running is still counted');
  child.end({ exit_code: null, signal: 'SIGKILL' });
  await settle(first);
  assert.equal(first.state.error, armError, 'the error that is rethrown is the one the timer raised');
  assert.deepEqual(failedWith(gate), { ok: false, error_code: 'ETIMER', killed_for: 'gate_error' });
  assert.equal(inFlight(gate), 0);
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
  await releasedSlot(gate, child);
});

test('a wall timer that cannot be armed again inside its own callback stops the child, and the error does not escape from the callback', async () => {
  const armError = fault('ETIMER');
  const timers = fakeTimers({ failArm: [2], armError });
  const { host, child } = childHost();
  const gate = createEnforcementGate({ manifest: manifest(LONG_WALL), host, timers });
  const run = launch(gate.spawn('node', [], {}));
  await flush();
  assert.equal(timers.pending, 1);
  assert.doesNotThrow(() => timers.elapse(), 'a timer callback must never throw');
  await settle(run);
  assert.equal(timers.log.armed, 2);
  assert.equal(run.state.error, armError);
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.deepEqual(failedWith(gate), { ok: false, error_code: 'ETIMER', killed_for: 'gate_error' });
  assert.equal(timers.pending, 0);
  assert.equal(inFlight(gate), 0);
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
  await releasedSlot(gate, child);
});

test('a timer that cannot be cleared after the child ended keeps the recorded outcome, releases the slot, and is inert when it fires later', async () => {
  const clearError = fault('ECLEAR');
  const timers = fakeTimers({ clearError });
  const { host, child } = childHost();
  const gate = createEnforcementGate({ manifest: manifest(LONG_WALL), host, timers });
  const run = launch(gate.spawn('node', [], {}));
  await flush();
  child.end({ exit_code: 0, signal: null });
  await settle(run);
  assert.equal(run.state.error, clearError, 'a timer that cannot be cleared is the error of the call');
  assert.deepEqual(pick(outcomeOf(gate, 0), ['ok', 'exit_code']), { ok: true, exit_code: 0 }, 'the child did run and end, and the log says so');
  assert.equal(inFlight(gate), 0);
  assert.equal(timers.pending, 1, 'the link that could not be cleared is still armed');
  assert.doesNotThrow(() => timers.elapse());
  assert.deepEqual(child.kills, [], 'a link that fires after the child ended kills nothing (its pid may belong to another process)');
  assert.equal(timers.log.armed, 1, 'and arms no further link');
  assert.equal(timers.pending, 0);
  timers.clearError = null;
  await releasedSlot(gate, child);
});

test('a timer that cannot be cleared while a failure is handled does not replace that failure or keep the slot', async () => {
  const hostError = fault('EHOSTGONE');
  const timers = fakeTimers({ clearError: fault('ECLEAR') });
  const { host, child } = childHost({ killEnds: false });
  const gate = createEnforcementGate({ manifest: manifest(), host, timers });
  const run = launch(gate.spawn('node', [], {}));
  await flush();
  child.crash(hostError);
  await settle(run);
  assert.equal(run.state.error, hostError, 'the host that can no longer report on the child is the error of the call');
  assert.deepEqual(child.kills, ['SIGKILL'], 'a child the host can no longer report on may still be running, so it is killed');
  assert.deepEqual(failedWith(gate), { ok: false, error_code: 'EHOSTGONE', killed_for: 'gate_error' });
  assert.equal(inFlight(gate), 0);
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
  assert.doesNotThrow(() => timers.elapse());
  assert.deepEqual(child.kills, ['SIGKILL'], 'the link that could not be cleared kills nothing when it fires');
  timers.clearError = null;
  await releasedSlot(gate, child);
});

test('a child whose report rejects after the gate stopped it is observed: the first error stays and nothing is left unhandled', async () => {
  const stopWatching = watchUnhandled();
  try {
    const armError = fault('ETIMER');
    const { host, child } = childHost({ rejectOnKill: fault('EHOSTGONE') });
    const gate = createEnforcementGate({ manifest: manifest(), host, timers: fakeTimers({ failArm: [1], armError }) });
    const run = launch(gate.spawn('node', [], {}));
    await settle(run);
    assert.equal(run.state.error, armError);
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.deepEqual(failedWith(gate), { ok: false, error_code: 'ETIMER', killed_for: 'gate_error' });
    assert.equal(inFlight(gate), 0);
  } finally {
    assert.deepEqual(await stopWatching(), [], 'no rejection is left without a handler');
  }
});

test('the child is stopped before the failure is recorded: a clock that fails can neither skip the kill nor replace the error', async () => {
  const clock = controlledClock();
  const armError = fault('ETIMER');
  const { host, child } = childHost();
  let breakOnce = true;
  const broken = { ...host, spawn: (request) => { if (breakOnce) clock.broken = true; breakOnce = false; return host.spawn(request); } };
  const gate = createEnforcementGate({ manifest: manifest(), host: broken, clock, timers: fakeTimers({ failArm: [1], armError }) });
  const run = launch(gate.spawn('node', [], {}));
  await settle(run);
  assert.deepEqual(child.kills, ['SIGKILL'], 'the kill does not wait for the log');
  assert.equal(run.state.error, armError, 'the error of the timer, not the error of the clock');
  assert.equal(clock.failures, 1, 'the failure is offered to the log once');
  assert.deepEqual(missing(gate), ['AUDIT_OUTCOME_MISSING@0'], 'the log shows the decision without an outcome');
  assert.equal(inFlight(gate), 0, 'and does not excuse it as still running');
  clock.broken = false;
  await releasedSlot(gate, child);
});

test('an outcome that cannot be written for a child that ended on its own is not retried, kills nothing, and its error is the one thrown', async () => {
  const clock = controlledClock();
  const timers = fakeTimers();
  const { host, child } = childHost();
  const gate = createEnforcementGate({ manifest: manifest(), host, clock, timers });
  const run = launch(gate.spawn('node', [], {}));
  await flush();
  clock.broken = true;
  child.end({ exit_code: 0, signal: null });
  await settle(run);
  assert.equal(run.state.error, clock.error);
  assert.equal(clock.failures, 1, 'one attempt: the child ran, so the log is not offered a failure for it');
  assert.deepEqual(child.kills, []);
  assert.deepEqual(missing(gate), ['AUDIT_OUTCOME_MISSING@0']);
  assert.equal(inFlight(gate), 0);
  assert.equal(timers.pending, 0, 'the wall timer is cleared on this path too');
  clock.broken = false;
  await releasedSlot(gate, child);
});

test('a chunk the gate cannot read does not throw into the host: the child is stopped and the call fails with that error', async () => {
  const { host, child } = childHost();
  const gate = createEnforcementGate({ manifest: manifest(), host, timers: fakeTimers() });
  const run = launch(gate.spawn('node', [], {}));
  await flush();
  assert.doesNotThrow(() => child.request.onStdout(5), 'the host calls this from its event handler');
  await settle(run);
  assert.ok(run.state.error instanceof TypeError);
  assert.equal(run.state.error.code, 'ERR_INVALID_ARG_TYPE');
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.deepEqual(failedWith(gate), { ok: false, error_code: 'ERR_INVALID_ARG_TYPE', killed_for: 'gate_error' });
  assert.equal(inFlight(gate), 0);
  await releasedSlot(gate, child);
});

test('a chunk the gate cannot read that arrives while the host is still starting the child stops the child as soon as the gate has it', async () => {
  const kills = [];
  const host = createRecordingHost({
    spawnImpl: (request) => {
      let end;
      const done = new Promise((resolve) => { end = resolve; });
      request.onStderr({});
      return { pid: 7, kill: (signal) => { kills.push(signal); end({ exit_code: null, signal }); }, done };
    },
  });
  const gate = createEnforcementGate({ manifest: manifest(), host, timers: fakeTimers() });
  const run = launch(gate.spawn('node', [], {}));
  await settle(run);
  assert.equal(run.state.error?.code, 'ERR_INVALID_ARG_TYPE');
  assert.deepEqual(kills, ['SIGKILL'], 'the callback did not throw into spawn(), and the child was stopped once it could be');
  assert.deepEqual(failedWith(gate), { ok: false, error_code: 'ERR_INVALID_ARG_TYPE', killed_for: 'gate_error' });
  assert.equal(inFlight(gate), 0);
});

test('a host whose spawn throws started nothing: no kill reason is recorded for a child that does not exist, and the slot is released', async () => {
  const spawnError = fault('ESPAWN');
  const starts = [() => { throw spawnError; }, (request) => { request.onStdout(5); throw spawnError; }];
  for (const [index, start] of starts.entries()) {
    let calls = 0;
    const host = createRecordingHost({ spawnImpl: (request) => { calls += 1; if (calls === 1) return start(request); return { pid: 8, kill() {}, done: Promise.resolve({ exit_code: 0, signal: null }) }; } });
    const gate = createEnforcementGate({ manifest: manifest(), host, timers: fakeTimers() });
    const expected = index === 0 ? 'ESPAWN' : 'ERR_INVALID_ARG_TYPE';
    await assert.rejects(gate.spawn('node', [], {}), (error) => error.code === expected && (index === 0 ? error === spawnError : error instanceof TypeError), `start ${index}: the first error is the one thrown`);
    assert.deepEqual(failedWith(gate), { ok: false, error_code: expected, killed_for: undefined }, `start ${index}`);
    assert.equal(inFlight(gate), 0);
    assert.equal((await gate.spawn('node', [], {})).exit_code, 0, `start ${index}: the slot was released`);
  }
});

test('the first error is the one thrown when the host also fails to report the child it was asked to stop', async () => {
  const { host, child } = childHost({ rejectOnKill: fault('EHOSTGONE') });
  const gate = createEnforcementGate({ manifest: manifest(), host, timers: fakeTimers() });
  const run = launch(gate.spawn('node', [], {}));
  await flush();
  child.request.onStdout(5);
  await settle(run);
  assert.equal(run.state.error?.code, 'ERR_INVALID_ARG_TYPE', 'the unreadable chunk came first');
  assert.deepEqual(failedWith(gate), { ok: false, error_code: 'ERR_INVALID_ARG_TYPE', killed_for: 'gate_error' });
  assert.equal(inFlight(gate), 0);
});

test('the reason a child was stopped for is kept when the host then fails to report it', async () => {
  const hostError = fault('EHOSTGONE');
  const timers = fakeTimers();
  const { host, child } = childHost({ rejectOnKill: hostError });
  const gate = createEnforcementGate({ manifest: manifest(), host, timers });
  const run = launch(gate.spawn('node', [], {}));
  await flush();
  timers.elapse();
  await settle(run);
  assert.equal(run.state.error, hostError);
  assert.ok(child.kills.length >= 1 && child.kills.every((signal) => signal === 'SIGKILL'));
  assert.deepEqual(failedWith(gate), { ok: false, error_code: 'EHOSTGONE', killed_for: 'wall_ms' });
  assert.equal(inFlight(gate), 0);
});

test('output and errors that arrive after the child has ended stop nothing', async () => {
  const { host, child } = childHost();
  const gate = createEnforcementGate({ manifest: manifest({ limits: { stdout_bytes: 16 } }), host, timers: fakeTimers() });
  const run = launch(gate.spawn('node', [], {}));
  await flush();
  child.end({ exit_code: 0, signal: null });
  await settle(run);
  assert.equal(run.state.error, undefined);
  assert.doesNotThrow(() => child.request.onStdout(Buffer.alloc(64)));
  assert.doesNotThrow(() => child.request.onStderr(5));
  assert.deepEqual(child.kills, [], 'a pid that the host has reported gone can belong to another process now');
  assert.deepEqual(pick(outcomeOf(gate, 0), ['ok', 'killed_for']), { ok: true, killed_for: null });
});

test('a kill that throws replaces nothing and ends no wait: the gate still waits for the host to report the child', async () => {
  const armError = fault('ETIMER');
  const { host, child } = childHost({ killFails: true });
  const gate = createEnforcementGate({ manifest: manifest(), host, timers: fakeTimers({ failArm: [1], armError }) });
  const run = launch(gate.spawn('node', [], {}));
  await flush();
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.equal(run.state.settled, false, 'the child may still be running, so its slot is held');
  assert.equal(inFlight(gate), 1);
  child.end({ exit_code: null, signal: 'SIGKILL' });
  await settle(run);
  assert.equal(run.state.error, armError);
  assert.deepEqual(failedWith(gate), { ok: false, error_code: 'ETIMER', killed_for: 'gate_error' });
  assert.equal(inFlight(gate), 0);
});

test('a spawn handle the gate can neither stop nor wait for is refused: it is killed if it can be, and its slot is released', async () => {
  const exited = () => Promise.resolve({ exit_code: 0, signal: null });
  const cases = [
    ['no handle', () => undefined, 0],
    ['null', () => null, 0],
    ['a string', () => 'pid 7', 0],
    ['no kill()', () => ({ pid: 7, done: exited() }), 0],
    ['no done', (kills) => ({ pid: 7, kill: (signal) => kills.push(signal) }), 1],
    ['a done that is not a promise', (kills) => ({ pid: 7, kill: (signal) => kills.push(signal), done: 5 }), 1],
  ];
  for (const [label, make, killed] of cases) {
    const kills = [];
    let calls = 0;
    const host = createRecordingHost({ spawnImpl: () => { calls += 1; return calls === 1 ? make(kills) : { pid: 8, kill() {}, done: exited() }; } });
    const gate = createEnforcementGate({ manifest: manifest(), host, timers: fakeTimers() });
    await assert.rejects(gate.spawn('node', [], {}), (error) => error.code === 'HOST_SPAWN_INVALID', label);
    assert.equal(kills.length, killed, `${label}: kills`);
    assert.deepEqual(pick(outcomeOf(gate, 0), ['ok', 'error_code']), { ok: false, error_code: 'HOST_SPAWN_INVALID' }, label);
    assert.equal(inFlight(gate), 0, label);
    assert.equal((await gate.spawn('node', [], {})).exit_code, 0, `${label}: the slot was released`);
  }
});

// The operations that end in finish(): the host call, then the outcome. `opens` marks the ones whose host answer is a handle that the
// caller receives and that the gate closes when it cannot hand it over; `answer` is what such an answer must carry to be accepted.
const OPERATIONS = [
  { name: 'read', method: 'readFile', call: (gate) => gate.read('src/a.txt') },
  { name: 'write', method: 'writeFile', call: (gate) => gate.write('out/r.json', 'x') },
  { name: 'connect', method: 'connect', call: (gate) => gate.connect('api.example.com', 443), opens: true, answer: { connected: true } },
  { name: 'listen', method: 'listen', call: (gate) => gate.listen('127.0.0.1', 18080), opens: true },
  { name: 'secret', method: 'resolveSecret', call: (gate, probe) => gate.useSecret('provider-token', () => { probe.used += 1; return probe.result; }) },
  { name: 'device', method: 'openDevice', call: (gate) => gate.useDevice('gpu'), opens: true },
];
const closable = (answer = {}) => {
  const made = { ...answer, closes: 0, close() { made.closes += 1; } };
  return made;
};

async function runOperation(operation, { breakClock, hostError = null }) {
  const clock = controlledClock();
  const opened = closable(operation.answer);
  const probe = { used: 0, result: closable() };
  const base = createRecordingHost({ files: { 'src/a.txt': 'alpha' }, dns: { 'api.example.com': [['93.184.216.34']] }, secrets: { 'provider-token': 'tok' } });
  const original = base[operation.method];
  const host = {
    ...base,
    [operation.method]: async (...args) => {
      if (breakClock) clock.broken = true;
      if (hostError !== null) throw hostError;
      const result = await original.apply(base, args);
      return operation.opens ? opened : result;
    },
  };
  const gate = createEnforcementGate({ manifest: manifest(), host, clock });
  const settled = await operation.call(gate, probe).then((value) => ({ value }), (error) => ({ error }));
  return { gate, clock, base, opened, probe, settled };
}

test('a host call that fails while the log cannot take the failure still throws the host error, and the decision is not left in flight', async () => {
  for (const operation of OPERATIONS) {
    const hostError = fault('EHOST');
    const { gate, clock, opened, probe, settled } = await runOperation(operation, { breakClock: true, hostError });
    assert.equal(settled.error, hostError, `${operation.name}: the error of the host`);
    assert.equal(clock.failures, 1, `${operation.name}: the failure is offered to the log once`);
    assert.deepEqual(missing(gate), ['AUDIT_OUTCOME_MISSING@0'], operation.name);
    assert.equal(inFlight(gate), 0, operation.name);
    assert.equal(opened.closes + probe.result.closes + probe.used, 0, `${operation.name}: nothing was opened or used`);
  }
});

test('a host call that fails is recorded as failed with its code, and the host error is rethrown', async () => {
  for (const operation of OPERATIONS) {
    const hostError = fault('EHOST');
    const { gate, settled } = await runOperation(operation, { breakClock: false, hostError });
    assert.equal(settled.error, hostError, operation.name);
    assert.deepEqual(pick(outcomeOf(gate, 0), ['ok', 'error_code']), { ok: false, error_code: 'EHOST' }, operation.name);
    assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] }, operation.name);
  }
});

test('an outcome that cannot be written after the host has acted is not retried, throws its own error, and closes what the gate cannot hand over', async () => {
  for (const operation of OPERATIONS) {
    const { gate, clock, base, opened, probe, settled } = await runOperation(operation, { breakClock: true });
    assert.equal(settled.error, clock.error, `${operation.name}: the error of the log`);
    assert.equal(base.count(operation.method), 1, `${operation.name}: the host acted once`);
    assert.equal(clock.failures, 1, `${operation.name}: the effect happened, so no failure is offered to the log in its place`);
    assert.deepEqual(missing(gate), ['AUDIT_OUTCOME_MISSING@0'], operation.name);
    assert.equal(inFlight(gate), 0, operation.name);
    assert.equal(opened.closes, operation.opens ? 1 : 0, `${operation.name}: a listener, device or connection the caller never received is closed once`);
    assert.equal(probe.result.closes, 0, `${operation.name}: a value the caller's own callback returned is not the gate's to close`);
    if (operation.name === 'write') assert.equal(base.files['out/r.json'], 'x', 'a file that was written stays written');
    if (operation.name === 'secret') assert.equal(probe.used, 1, 'a secret that was used stays used');
  }
});

test('what the host opened is handed over, not closed, when the outcome is written', async () => {
  for (const operation of OPERATIONS) {
    const { gate, opened, probe, settled } = await runOperation(operation, { breakClock: false });
    assert.equal(settled.error, undefined, operation.name);
    if (operation.opens) assert.equal(settled.value, opened, `${operation.name}: the caller gets the handle the host opened`);
    if (operation.name === 'secret') assert.equal(settled.value, probe.result, 'and the result of its own callback');
    assert.equal(opened.closes + probe.result.closes, 0, `${operation.name}: nothing is closed`);
    assert.equal(outcomeOf(gate, 0).ok, true, operation.name);
    assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] }, operation.name);
  }
});

test('an opened listener, device or connection whose close() throws, rejects or is missing does not replace the error, and leaves nothing unhandled', async () => {
  const stopWatching = watchUnhandled();
  try {
    for (const [label, close] of [['throws', () => { throw fault('ECLOSE'); }], ['rejects', () => Promise.reject(fault('ECLOSE'))], ['is not a function', 5], ['is absent', undefined]]) {
      for (const operation of OPERATIONS.filter((candidate) => candidate.opens)) {
        const clock = controlledClock();
        const attempts = [];
        const opened = { ...operation.answer, close: typeof close === 'function' ? () => { attempts.push(label); return close(); } : close };
        const base = createRecordingHost({ dns: { 'api.example.com': [['93.184.216.34']] } });
        const host = { ...base, [operation.method]: async () => { clock.broken = true; return opened; } };
        const gate = createEnforcementGate({ manifest: manifest(), host, clock });
        await assert.rejects(operation.call(gate), (error) => error === clock.error, `${operation.name}, close() ${label}`);
        assert.equal(attempts.length, typeof close === 'function' ? 1 : 0, `${operation.name}, close() ${label}`);
        assert.equal(inFlight(gate), 0);
      }
    }
  } finally {
    assert.deepEqual(await stopWatching(), []);
  }
});

test('a connect answer that does not report the connection as made is closed when it offers close(), and the caller still gets NOT_CONNECTED', async () => {
  const stopWatching = watchUnhandled();
  try {
    for (const mode of ['enforce', 'shadow']) {
      for (const [label, behaviour] of [['works', () => undefined], ['throws', () => { throw fault('ECLOSE'); }], ['rejects', () => Promise.reject(fault('ECLOSE'))]]) {
        const name = mode === 'enforce' ? 'api.example.com' : 'other.example.org';
        const tag = `${mode}, close() ${label}`;
        const answer = closable({ connected: false });
        const close = answer.close;
        answer.close = () => { close(); return behaviour(); };
        const base = createRecordingHost({ dns: { [name]: [['93.184.216.34']] } });
        const gate = createEnforcementGate({ manifest: manifest(), host: { ...base, connect: async () => answer }, mode });
        await assert.rejects(gate.connect(name, 443), (error) => error.code === 'NOT_CONNECTED', tag);
        assert.equal(answer.closes, 1, `${tag}: what the host answered is closed once`);
        assert.deepEqual(pick(outcomeOf(gate, 0), ['ok', 'error_code']), { ok: false, error_code: 'NOT_CONNECTED' }, tag);
        assert.equal(inFlight(gate), 0, tag);
        assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] }, tag);
      }
    }
  } finally {
    assert.deepEqual(await stopWatching(), []);
  }
});

test('a read whose answer is not bytes is recorded as failed and the conversion error is rethrown, with or without a working log', async () => {
  const base = createRecordingHost({ files: { 'src/a.txt': 'alpha' } });
  const host = { ...base, readFile: async () => 5 };
  const gate = createEnforcementGate({ manifest: manifest(), host });
  await assert.rejects(gate.read('src/a.txt'), (error) => error instanceof TypeError && error.code === 'ERR_INVALID_ARG_TYPE');
  assert.deepEqual(pick(outcomeOf(gate, 0), ['ok', 'error_code']), { ok: false, error_code: 'ERR_INVALID_ARG_TYPE' });
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
  const clock = controlledClock();
  const flaky = { ...base, readFile: async () => { clock.broken = true; return 5; } };
  const second = createEnforcementGate({ manifest: manifest(), host: flaky, clock });
  await assert.rejects(second.read('src/a.txt'), (error) => error instanceof TypeError && error.code === 'ERR_INVALID_ARG_TYPE');
  assert.deepEqual(missing(second), ['AUDIT_OUTCOME_MISSING@0']);
  assert.equal(inFlight(second), 0);
});

test('an error whose code cannot be read is still the error that is rethrown, and its outcome carries a neutral code', async () => {
  const hostile = new Error('hostile');
  Object.defineProperty(hostile, 'code', { get() { throw new Error('the getter of the code'); } });
  const base = createRecordingHost({ files: { 'src/a.txt': 'alpha' } });
  const reading = createEnforcementGate({ manifest: manifest(), host: { ...base, readFile: async () => { throw hostile; } } });
  await assert.rejects(reading.read('src/a.txt'), (error) => error === hostile);
  assert.deepEqual(pick(outcomeOf(reading, 0), ['ok', 'error_code']), { ok: false, error_code: 'HOST_ERROR' });
  assert.deepEqual(reading.verifyAudit(), { ok: true, errors: [] });
  const { host, child } = childHost();
  const spawning = createEnforcementGate({ manifest: manifest(), host, timers: fakeTimers({ failArm: [1], armError: hostile }) });
  const run = launch(spawning.spawn('node', [], {}));
  await settle(run);
  assert.equal(run.state.error, hostile);
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.deepEqual(failedWith(spawning), { ok: false, error_code: 'HOST_ERROR', killed_for: 'gate_error' });
  assert.equal(inFlight(spawning), 0);
});

test('in shadow mode a request that cannot be passed through is still refused with the denial when the log cannot record the failure', async () => {
  const refusals = [
    ['connect', (gate) => gate.connect('unknown.example.org', 443), 'RESOLVE_FAILED'],
    ['spawn', (gate) => gate.spawn('python', [], {}), 'EXECUTABLE_NOT_RESOLVED'],
  ];
  for (const [label, run, reason] of refusals) {
    const clock = controlledClock();
    const base = createRecordingHost();
    const breaking = (name) => async (...args) => {
      clock.broken = true;
      return base[name](...args);
    };
    const host = { ...base, resolve: breaking('resolve'), resolveExecutable: breaking('resolveExecutable') };
    const gate = createEnforcementGate({ manifest: manifest(), host, clock, mode: 'shadow' });
    await assert.rejects(run(gate), (error) => error instanceof EnforcementDenied && error.reason === reason && error.audit_seq === 0, label);
    assert.equal(clock.failures, 1, `${label}: the failure is offered to the log once`);
    assert.deepEqual(missing(gate), ['AUDIT_OUTCOME_MISSING@0'], label);
    assert.equal(inFlight(gate), 0, label);
  }
});
