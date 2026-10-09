import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_MANIFEST_SCHEMA } from '../../lib/trust-next/permission-manifest.mjs';
import { EnforcementDenied, createEnforcementGate } from '../../lib/trust-next/enforcement-gate.mjs';
import { canon, sha } from './enforcement-audit-forge.mjs';
import { createRecordingHost } from './enforcement-host.mjs';

// Values the caller owns and can still hold after the call: the argument array of a spawn, the bytes of a write, the ambient
// environment, the manifest, the timers object, and what the gate hands back. The gate copies each of them when the operation is
// entered, before its first await, and checks, records and uses only the copy. A host call that is slow (executable lookup, path
// canonicalisation) is the window in which the caller edits the original; these tests open that window on purpose.
// The host and what it emits are the trusted effect layer; ENFORCEMENT_GATE.md lists them as such.

const manifest = (extra = {}) => ({
  schema: PERMISSION_MANIFEST_SCHEMA,
  read_roots: ['src'],
  write_roots: ['out'],
  network: { mode: 'allowlist', allow: [{ host: 'api.example.com', ports: [443] }] },
  listen: { mode: 'allowlist', allow: [{ host: '127.0.0.1', ports: [18080] }] },
  process: { mode: 'argv-allowlist', executables: ['node'], max_children: 2 },
  environment: { allow: ['LANG'] },
  secret_refs: ['provider-token'],
  devices: { mode: 'allowlist', allow: ['gpu'] },
  ...extra,
});

async function denied(promise, reason, operation) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof EnforcementDenied, `expected EnforcementDenied, got ${error?.name}: ${error?.message}`);
    assert.equal(error.reason, reason);
    if (operation) assert.equal(error.operation, operation);
    return true;
  });
}

// The host method does not answer until `release()` is called, so the test can edit the caller's value while the gate waits.
// `entered` settles when the gate has reached the host method (the recording host counts a call only once it is answered).
function hold(host, method) {
  let release;
  let reached;
  const open = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { reached = resolve; });
  const inner = host[method].bind(host);
  host[method] = async (...args) => { reached(); await open; return inner(...args); };
  return { release, entered };
}

const allowed = (gate) => gate.audit().filter((entry) => entry.phase === 'decision' && entry.decision === 'allow');

const spawnCall = (host) => host.calls.find((call) => call.method === 'spawn');

test('spawn arguments and environment are copied before the executable is resolved: edits made while it is pending reach neither the host nor the audit record', async () => {
  const original = ['-e', '1'];
  // The third case is the one where the executable is looked up after the decision was recorded (a shadow-mode would-deny).
  for (const [mode, executable] of [['enforce', 'node'], ['shadow', 'node'], ['shadow', 'sh']]) {
    const label = `${mode}/${executable}`;
    const host = createRecordingHost({ executables: { node: '/pinned/bin/node', sh: '/pinned/bin/sh' } });
    const held = hold(host, 'resolveExecutable');
    const gate = createEnforcementGate({ manifest: manifest(), host, mode });
    const args = [...original];
    const env = { LANG: 'C' };
    const run = gate.spawn(executable, args, env);
    await held.entered;
    args[1] = 'process.exit(9)';
    args.push('--extra');
    env.LANG = 'edited';
    held.release();
    await run;
    assert.deepEqual(spawnCall(host).args, original, `${label}: the host gets the arguments that were checked`);
    assert.deepEqual(spawnCall(host).env, { LANG: 'C' }, `${label}: the host gets the environment that was selected`);
    const [decision] = gate.audit();
    assert.equal(decision.operation, 'spawn', label);
    assert.equal(decision.target.argc, 2, label);
    assert.equal(decision.target.args_sha256, sha(canon(original)), `${label}: the recorded hash is the hash of what the host got`);
    assert.equal(decision.decision === 'allow', executable === 'node', label);
    assert.equal(gate.verifyAudit().ok, true, label);
  }
});

test('spawn arguments are read once, element by element: a hole is refused, an accessor is read one time, and a reader that throws is a refusal', async () => {
  const host = createRecordingHost();
  const gate = createEnforcementGate({ manifest: manifest(), host });
  const sparse = new Array(2);
  sparse[1] = 'x';
  await denied(gate.spawn('node', sparse, {}), 'INVALID_ARGUMENT', 'spawn');
  assert.equal(host.count('spawn'), 0, 'a hole is not turned into an undefined argument');

  const reads = [];
  const accessor = ['placeholder', 'two'];
  Object.defineProperty(accessor, 0, { get() { reads.push('read'); return reads.length === 1 ? 'first' : 'later'; }, enumerable: true, configurable: true });
  await gate.spawn('node', accessor, {});
  assert.equal(reads.length, 1, 'the element is read once');
  assert.deepEqual(spawnCall(host).args, ['first', 'two']);
  assert.equal(allowed(gate).at(-1).target.args_sha256, sha(canon(['first', 'two'])), 'the record hashes the value the host got');

  const throwing = ['x'];
  Object.defineProperty(throwing, 0, { get() { throw new Error('unreadable'); }, enumerable: true, configurable: true });
  await denied(gate.spawn('node', throwing, {}), 'INVALID_ARGUMENT', 'spawn');

  // Lists the gate cannot even measure: a revoked proxy and a proxy whose length throws.
  const { proxy: revoked, revoke } = Proxy.revocable([], {});
  revoke();
  await denied(gate.spawn('node', revoked, {}), 'INVALID_ARGUMENT', 'spawn');
  const lengthThrows = new Proxy([], { get(target, key) { if (key === 'length') throw new Error('unreadable'); return Reflect.get(target, key); } });
  await denied(gate.spawn('node', lengthThrows, {}), 'INVALID_ARGUMENT', 'spawn');
  assert.equal(host.count('spawn'), 1);
});

test('spawn argument limits are checked on the copy: 1024 arguments and 65536 characters pass, one more of either is refused', async () => {
  const host = createRecordingHost();
  const gate = createEnforcementGate({ manifest: manifest(), host });
  await gate.spawn('node', new Array(1024).fill('x'), {});
  await gate.spawn('node', ['y'.repeat(65536)], {});
  assert.equal(host.count('spawn'), 2);
  await denied(gate.spawn('node', new Array(1025).fill('x'), {}), 'INVALID_ARGUMENT', 'spawn');
  await denied(gate.spawn('node', ['y'.repeat(65537)], {}), 'INVALID_ARGUMENT', 'spawn');
  await denied(gate.spawn('node', ['a\0b'], {}), 'INVALID_ARGUMENT', 'spawn');
  await denied(gate.spawn('node', 'not an array', {}), 'INVALID_ARGUMENT', 'spawn');
  assert.equal(host.count('spawn'), 2);
});

test('write bytes are copied when the call is made: bytes overwritten, resized or detached while the path is canonicalised are not what the host writes', async () => {
  for (const [label, make] of [['Uint8Array', (text) => new Uint8Array(Buffer.from(text))], ['Buffer', (text) => Buffer.from(text)]]) {
    const host = createRecordingHost();
    const held = hold(host, 'realpath');
    const gate = createEnforcementGate({ manifest: manifest(), host });
    const data = make('AAA');
    const run = gate.write('out/a.txt', data);
    await held.entered;
    data.fill(66);
    held.release();
    await run;
    assert.equal(host.calls.find((call) => call.method === 'writeFile').text, 'AAA', `${label}: the host writes what was passed`);
    const [decision, outcome] = gate.audit();
    assert.equal(decision.target.bytes, 3, label);
    assert.equal(outcome.bytes, 3, label);
  }

  // A string is written as UTF-8 and counted in bytes, not in characters.
  {
    const host = createRecordingHost();
    const gate = createEnforcementGate({ manifest: manifest(), host });
    await gate.write('out/u.txt', '\u00e9');
    assert.equal(host.calls.find((call) => call.method === 'writeFile').text, '\u00e9');
    const [decision, outcome] = gate.audit();
    assert.equal(decision.target.bytes, 2);
    assert.equal(outcome.bytes, 2);
  }

  // A view that follows the length of a resizable buffer (runtimes that have them): the recorded length and the written length agree.
  if (typeof ArrayBuffer.prototype.resize === 'function') {
    const host = createRecordingHost();
    const held = hold(host, 'realpath');
    const gate = createEnforcementGate({ manifest: manifest(), host });
    const buffer = new ArrayBuffer(4, { maxByteLength: 16 });
    const view = new Uint8Array(buffer);
    view.fill(65);
    const run = gate.write('out/a.txt', view);
    await held.entered;
    buffer.resize(8);
    held.release();
    await run;
    const [decision, outcome] = gate.audit();
    assert.equal(host.calls.find((call) => call.method === 'writeFile').text, 'AAAA');
    assert.equal(decision.target.bytes, 4);
    assert.equal(outcome.bytes, 4);
  }

  // Bytes that cannot be read any more are an invalid argument, not an empty write.
  const host = createRecordingHost();
  const gate = createEnforcementGate({ manifest: manifest(), host });
  const detached = new Uint8Array([1, 2, 3]);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  await denied(gate.write('out/a.txt', detached), 'INVALID_ARGUMENT', 'write');
  const { proxy: revoked, revoke } = Proxy.revocable(new Uint8Array(1), {});
  revoke();
  await denied(gate.write('out/a.txt', revoked), 'INVALID_ARGUMENT', 'write');
  assert.equal(host.count('realpath') + host.count('writeFile'), 0);
});

test('the wall timers are the two functions the gate was given: replacing them on the caller\'s object afterwards changes nothing', async () => {
  const log = [];
  const timers = {
    setTimeout(callback, delay) { log.push(['set', delay]); return 7; },
    clearTimeout(id) { log.push(['clear', id]); },
  };
  const host = createRecordingHost();
  const gate = createEnforcementGate({ manifest: manifest({ limits: { wall_ms: 1000 } }), host, timers });
  timers.setTimeout = () => { throw new Error('the gate looked setTimeout up again'); };
  timers.clearTimeout = () => { throw new Error('the gate looked clearTimeout up again'); };
  await gate.spawn('node', [], {});
  assert.deepEqual(log, [['set', 1000], ['clear', 7]]);
});

test('child output is copied as it arrives: a host that reuses its buffers afterwards does not change what the caller gets', async () => {
  const out = Buffer.from('hello');
  const err = Buffer.from('oops');
  const host = createRecordingHost({
    spawnImpl: ({ onStdout, onStderr }) => {
      onStdout(out);
      onStderr(err);
      const done = Promise.resolve().then(() => {
        out.fill(0x7a);
        err.fill(0x7a);
        return { exit_code: 0, signal: null };
      });
      return { pid: 9, kill() {}, done };
    },
  });
  const gate = createEnforcementGate({ manifest: manifest({ limits: { stdout_bytes: 3 } }), host });
  const result = await gate.spawn('node', [], {});
  assert.equal(result.stdout.toString(), 'hel', 'the part of the chunk that fits under the cap');
  assert.equal(result.stdout_truncated, true);
  assert.equal(result.stderr.toString(), 'oops');
});

test('the manifest is copied when the gate is built: editing the caller\'s object afterwards changes neither the policy, the digest nor the audit seed', async () => {
  const source = manifest({ limits: { wall_ms: 5000, stdout_bytes: 4096 } });
  const host = createRecordingHost({ files: { 'src/a.txt': 'x', 'etc/p': 'y' }, executables: { node: '/pinned/bin/node', sh: '/pinned/bin/sh' } });
  const gate = createEnforcementGate({ manifest: source, host });
  const before = { manifest: JSON.stringify(gate.manifest), digest: gate.permissionDigest };
  // Every array grows by names a grant would have to name, every number grows, every nested object is edited the same way.
  const widen = (value) => {
    if (Array.isArray(value)) {
      value.forEach(widen);
      value.push('etc', 'sh', 'SECRET', 80);
    } else if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        if (typeof value[key] === 'number') value[key] += 1;
        else widen(value[key]);
      }
    }
  };
  widen(source);
  source.network.mode = 'open';
  assert.equal(JSON.stringify(gate.manifest), before.manifest);
  assert.equal(gate.permissionDigest, before.digest);
  assert.equal(gate.report().permission_digest.sha256, before.digest);
  await denied(gate.read('etc/p'), 'NOT_GRANTED', 'read');
  await denied(gate.connect('api.example.com', 80), 'NOT_GRANTED', 'connect');
  await denied(gate.spawn('sh', [], {}), 'NOT_GRANTED', 'spawn');
  await denied(gate.readEnv('SECRET', { SECRET: 's' }), 'NOT_GRANTED', 'env');
  assert.equal(host.count('readFile') + host.count('connect') + host.count('spawn'), 0);
  assert.equal(gate.verifyAudit().ok, true);
  // The copy the gate shows is frozen as well.
  assert.throws(() => { gate.manifest.read_roots.push('etc'); }, TypeError);
});

test('what the gate hands back is not its own state: the audit array is a copy, and entries and reports are frozen', async () => {
  const gate = createEnforcementGate({ manifest: manifest(), host: createRecordingHost({ files: { 'src/a.txt': 'x' } }) });
  await gate.read('src/a.txt');
  await gate.readEnv('LANG', { LANG: 'C' });
  const length = gate.audit().length;
  assert.equal(length, 3);
  const handed = gate.audit();
  handed.length = 0;
  handed.push({ forged: true });
  assert.equal(gate.audit().length, length, 'the array a caller got is not the log');
  assert.equal(gate.verifyAudit().ok, true);
  for (const entry of gate.audit()) {
    assert.ok(Object.isFrozen(entry), `entry ${entry.seq} is frozen`);
    if (entry.target !== undefined) assert.ok(Object.isFrozen(entry.target), `the target of entry ${entry.seq} is frozen`);
  }
  assert.throws(() => { gate.audit()[0].mode = 'shadow'; }, TypeError);
  assert.throws(() => { gate.audit()[0].target.path = 'etc/passwd'; }, TypeError);
  const report = gate.report();
  assert.ok(Object.isFrozen(report) && Object.isFrozen(report.dimensions) && Object.isFrozen(report.audit));
  assert.throws(() => { report.enforcing = false; }, TypeError);
});
