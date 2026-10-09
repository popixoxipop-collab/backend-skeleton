import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_MANIFEST_SCHEMA } from '../../lib/trust-next/permission-manifest.mjs';
import { AUDIT_DECISION_REASONS, ENFORCEMENT_AUDIT_CONTRACT, GATE_OPERATIONS, createEnforcementGate, verifyAuditLog } from '../../lib/trust-next/enforcement-gate.mjs';
import { rechain } from './enforcement-audit-forge.mjs';
import { createRecordingHost } from './enforcement-host.mjs';

// The decision shapes of the audit log. The gate writes a fixed set of (decision, operation, reason) triples, and
// verifyAuditLog() accepts exactly that set: AUDIT_DECISION_REASONS is the table both sides use. The first test proves the table
// against the gate (a driver for every pair in it, and no driver for a pair outside it), the second sweeps malformed requests and
// checks that the gate never writes a pair outside the table and that every honest log verifies, and the third forges and
// re-chains every shape and checks the verifier against the table. Nothing here waits on a timer or a socket.

const NO_TIMERS = { setTimeout: () => 0, clearTimeout() {} };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const attempt = (promise) => promise.then(() => null, (error) => error);

const GRANTING = {
  schema: PERMISSION_MANIFEST_SCHEMA,
  read_roots: ['src'],
  write_roots: ['out'],
  network: { mode: 'allowlist', allow: ['api.example.com', 'down.example.com', 'internal.example.com', '1.2.3.999'].map((host) => ({ host, ports: [443] })) },
  listen: { mode: 'allowlist', allow: [{ host: '127.0.0.1', ports: [18080] }] },
  process: { mode: 'argv-allowlist', executables: ['node', 'ghost'], max_children: 1 },
  environment: { allow: ['LANG'] },
  secret_refs: ['provider-token'],
  devices: { mode: 'allowlist', allow: ['gpu'] },
};
const NOTHING = { schema: PERMISSION_MANIFEST_SCHEMA };

function setup({ mode = 'enforce', manifest = GRANTING, edit, ...hostOptions } = {}) {
  const host = createRecordingHost({
    files: { 'src/a.txt': 'alpha' },
    dns: { 'api.example.com': [['93.184.216.34']], 'internal.example.com': [['10.0.0.5']] },
    secrets: { 'provider-token': 'T' },
    ...hostOptions,
  });
  edit?.(host);
  return { gate: createEnforcementGate({ manifest, host, mode, timers: NO_TIMERS }), host };
}

// A host with no capability at all: every method is removed, so each operation fails closed.
const NO_METHODS = (host) => { for (const key of Object.keys(host)) if (typeof host[key] === 'function') delete host[key]; };
const hit = (options, call) => async () => {
  const { gate } = setup(options);
  await attempt(call(gate));
  return gate;
};
// One child holds the only process slot; the second spawn is refused (enforce) or passed through (shadow).
const busy = (options) => async () => {
  const ends = [];
  const { gate } = setup({ ...options, spawnImpl: () => ({ pid: 1, kill() {}, done: new Promise((resolve) => { ends.push(resolve); }) }) });
  const first = attempt(gate.spawn('node', [], {}));
  await flush();
  const second = attempt(gate.spawn('node', [], {}));
  await flush();
  for (const end of ends) end({ exit_code: 0, signal: null });
  await Promise.all([first, second]);
  return gate;
};

const DRIVERS = {};
for (const [operation, root, call] of [['read', 'src', (gate, path) => gate.read(path)], ['write', 'out', (gate, path) => gate.write(path, 'x')]]) {
  Object.assign(DRIVERS, {
    [`allow/${operation}/GRANTED`]: hit({}, (gate) => call(gate, `${root}/a.txt`)),
    [`deny/${operation}/NOT_GRANTED`]: hit({}, (gate) => call(gate, 'other/a.txt')),
    [`deny/${operation}/PATH_UNRESOLVABLE`]: hit({ edit: (host) => { host.realpath = async () => { throw new Error('boom'); }; } }, (gate) => call(gate, `${root}/a.txt`)),
    [`deny/${operation}/PATH_ESCAPES_ROOT`]: hit({ canonical: { [`${root}/up`]: null } }, (gate) => call(gate, `${root}/up`)),
    [`deny/${operation}/PATH_ESCAPES_GRANT`]: hit({ canonical: { [`${root}/link`]: 'secret/key' } }, (gate) => call(gate, `${root}/link`)),
    [`deny/${operation}/INVALID_ARGUMENT`]: hit({}, (gate) => call(gate, 5)),
    [`deny/${operation}/UNKNOWN_OPERATION`]: hit({}, (gate) => gate.invoke([operation], { path: `${root}/a.txt`, data: 'x' })),
    [`deny/${operation}/HOST_CAPABILITY_MISSING`]: hit({ edit: NO_METHODS }, (gate) => call(gate, `${root}/a.txt`)),
    [`would-deny/${operation}/NOT_GRANTED`]: hit({ mode: 'shadow', manifest: NOTHING }, (gate) => call(gate, `${root}/a.txt`)),
    [`would-deny/${operation}/PATH_UNRESOLVABLE`]: hit({ mode: 'shadow', edit: (host) => { host.realpath = async () => { throw new Error('boom'); }; } }, (gate) => call(gate, `${root}/a.txt`)),
    [`would-deny/${operation}/PATH_ESCAPES_ROOT`]: hit({ mode: 'shadow', canonical: { [`${root}/up`]: null } }, (gate) => call(gate, `${root}/up`)),
    [`would-deny/${operation}/PATH_ESCAPES_GRANT`]: hit({ mode: 'shadow', canonical: { [`${root}/link`]: 'secret/key' } }, (gate) => call(gate, `${root}/link`)),
  });
}
Object.assign(DRIVERS, {
  'allow/connect/GRANTED': hit({}, (gate) => gate.connect('api.example.com', 443)),
  'deny/connect/NOT_GRANTED': hit({}, (gate) => gate.connect('other.example.com', 443)),
  'deny/connect/INVALID_ADDRESS_LITERAL': hit({}, (gate) => gate.connect('1.2.3.999', 443)),
  'deny/connect/RESOLVE_FAILED': hit({}, (gate) => gate.connect('down.example.com', 443)),
  'deny/connect/RESOLVES_TO_NON_PUBLIC_ADDRESS': hit({}, (gate) => gate.connect('internal.example.com', 443)),
  'deny/connect/INVALID_ARGUMENT': hit({}, (gate) => gate.connect(5, 443)),
  'deny/connect/UNKNOWN_OPERATION': hit({}, (gate) => gate.invoke(['connect'], { host: 'api.example.com', port: 443 })),
  'deny/connect/HOST_CAPABILITY_MISSING': hit({ edit: NO_METHODS }, (gate) => gate.connect('api.example.com', 443)),
  'would-deny/connect/NOT_GRANTED': hit({ mode: 'shadow', manifest: NOTHING }, (gate) => gate.connect('api.example.com', 443)),
  'would-deny/connect/INVALID_ADDRESS_LITERAL': hit({ mode: 'shadow' }, (gate) => gate.connect('1.2.3.999', 443)),
  'would-deny/connect/RESOLVE_FAILED': hit({ mode: 'shadow' }, (gate) => gate.connect('down.example.com', 443)),
  'would-deny/connect/RESOLVES_TO_NON_PUBLIC_ADDRESS': hit({ mode: 'shadow' }, (gate) => gate.connect('internal.example.com', 443)),
  'allow/listen/GRANTED': hit({}, (gate) => gate.listen('127.0.0.1', 18080)),
  'deny/listen/NOT_GRANTED': hit({}, (gate) => gate.listen('127.0.0.1', 18081)),
  'deny/listen/INVALID_ARGUMENT': hit({}, (gate) => gate.listen(5, 18080)),
  'deny/listen/UNKNOWN_OPERATION': hit({}, (gate) => gate.invoke(['listen'], { host: '127.0.0.1', port: 18080 })),
  'deny/listen/HOST_CAPABILITY_MISSING': hit({ edit: NO_METHODS }, (gate) => gate.listen('127.0.0.1', 18080)),
  'would-deny/listen/NOT_GRANTED': hit({ mode: 'shadow', manifest: NOTHING }, (gate) => gate.listen('127.0.0.1', 18080)),
  'allow/spawn/GRANTED': hit({}, (gate) => gate.spawn('node', [], {})),
  'deny/spawn/NOT_GRANTED': hit({}, (gate) => gate.spawn('sh', [], {})),
  'deny/spawn/EXECUTABLE_NOT_RESOLVED': hit({}, (gate) => gate.spawn('ghost', [], {})),
  'deny/spawn/PROCESS_CAPACITY_EXCEEDED': busy({}),
  'deny/spawn/INVALID_ARGUMENT': hit({}, (gate) => gate.spawn('node', 'ls', {})),
  'deny/spawn/UNKNOWN_OPERATION': hit({}, (gate) => gate.invoke(['spawn'], { executable: 'node' })),
  'deny/spawn/HOST_CAPABILITY_MISSING': hit({ edit: NO_METHODS }, (gate) => gate.spawn('node', [], {})),
  'would-deny/spawn/NOT_GRANTED': hit({ mode: 'shadow', manifest: NOTHING }, (gate) => gate.spawn('node', [], {})),
  'would-deny/spawn/EXECUTABLE_NOT_RESOLVED': hit({ mode: 'shadow' }, (gate) => gate.spawn('ghost', [], {})),
  'would-deny/spawn/PROCESS_CAPACITY_EXCEEDED': busy({ mode: 'shadow' }),
  'allow/env/GRANTED': hit({}, (gate) => gate.readEnv('LANG', { LANG: 'C' })),
  'deny/env/NOT_GRANTED': hit({}, (gate) => gate.readEnv('SECRET', {})),
  'deny/env/INVALID_ARGUMENT': hit({}, (gate) => gate.readEnv(5, {})),
  'deny/env/UNKNOWN_OPERATION': hit({}, (gate) => gate.invoke(['env'], { name: 'LANG', ambientEnv: {} })),
  'allow/secret/GRANTED': hit({}, (gate) => gate.useSecret('provider-token', () => 1)),
  'deny/secret/NOT_GRANTED': hit({}, (gate) => gate.useSecret('other', () => 1)),
  'deny/secret/INVALID_ARGUMENT': hit({}, (gate) => gate.useSecret(5, () => 1)),
  'deny/secret/UNKNOWN_OPERATION': hit({}, (gate) => gate.invoke(['secret'], { ref: 'provider-token', use: () => 1 })),
  'deny/secret/HOST_CAPABILITY_MISSING': hit({ edit: NO_METHODS }, (gate) => gate.useSecret('provider-token', () => 1)),
  'allow/device/GRANTED': hit({}, (gate) => gate.useDevice('gpu')),
  'deny/device/NOT_GRANTED': hit({}, (gate) => gate.useDevice('tpu')),
  'deny/device/INVALID_ARGUMENT': hit({}, (gate) => gate.useDevice(5)),
  'deny/device/UNKNOWN_OPERATION': hit({}, (gate) => gate.invoke(['device'], { device: 'gpu' })),
  'deny/device/HOST_CAPABILITY_MISSING': hit({ edit: NO_METHODS }, (gate) => gate.useDevice('gpu')),
});

const keyOf = (entry) => `${entry.decision}/${entry.operation}/${entry.reason}`;
const decisions = (gate) => gate.audit().filter((entry) => entry.phase === 'decision');
const tableKeys = () => {
  const keys = GATE_OPERATIONS.map((operation) => `allow/${operation}/GRANTED`);
  for (const decision of ['deny', 'would-deny']) {
    for (const [operation, reasons] of Object.entries(AUDIT_DECISION_REASONS[decision])) for (const reason of reasons) keys.push(`${decision}/${operation}/${reason}`);
  }
  return keys;
};

test('the table of decision reasons is what the gate writes: a driver for every pair in it, and every driver writes its pair', async () => {
  assert.deepEqual(Object.keys(DRIVERS).sort(), tableKeys().sort(), 'a pair without a driver is unproven, a driver without a pair is not in the table');
  for (const [key, drive] of Object.entries(DRIVERS)) {
    const gate = await drive();
    const written = decisions(gate).map(keyOf);
    assert.ok(written.includes(key), `${key}: the gate wrote ${written.join(', ') || 'nothing'}`);
    for (const pair of written) assert.ok(tableKeys().includes(pair), `${key}: the gate wrote ${pair}, which is not in the table`);
    assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] }, key);
  }
});

test('the table is frozen, names every operation under both refusal kinds it can have, and a would-deny exists only for the operations shadow mode passes through', () => {
  assert.ok(Object.isFrozen(AUDIT_DECISION_REASONS));
  assert.ok(Object.isFrozen(AUDIT_DECISION_REASONS.deny));
  assert.ok(Object.isFrozen(AUDIT_DECISION_REASONS['would-deny']));
  for (const operation of GATE_OPERATIONS) {
    assert.ok(Object.isFrozen(AUDIT_DECISION_REASONS.deny[operation]), operation);
    assert.ok(AUDIT_DECISION_REASONS.deny[operation].includes('NOT_GRANTED'), operation);
    assert.ok(AUDIT_DECISION_REASONS.deny[operation].includes('UNKNOWN_OPERATION'), operation);
    assert.ok(AUDIT_DECISION_REASONS.deny[operation].includes('INVALID_ARGUMENT'), operation);
    assert.equal(new Set(AUDIT_DECISION_REASONS.deny[operation]).size, AUDIT_DECISION_REASONS.deny[operation].length, `${operation}: no reason twice`);
  }
  assert.deepEqual(Object.keys(AUDIT_DECISION_REASONS['would-deny']), ['read', 'write', 'connect', 'listen', 'spawn']);
  for (const reasons of Object.values(AUDIT_DECISION_REASONS['would-deny'])) {
    assert.ok(Object.isFrozen(reasons));
    assert.ok(!reasons.includes('INVALID_ARGUMENT') && !reasons.includes('UNKNOWN_OPERATION') && !reasons.includes('HOST_CAPABILITY_MISSING'), 'a refusal is never softened to a would-deny');
  }
  // env has no host method, so a missing host capability cannot refuse it.
  assert.ok(!AUDIT_DECISION_REASONS.deny.env.includes('HOST_CAPABILITY_MISSING'));
});

// Requests that deviate from a valid one in a single field, and values that are not requests at all. Every operation, in both
// modes, with a manifest that grants the base request and one that grants nothing, against hosts that have every method, none, or a
// method that throws or answers badly.
const BASES = {
  read: { path: 'src/a.txt' },
  write: { path: 'out/r.json', data: 'x' },
  connect: { host: 'api.example.com', port: 443 },
  listen: { host: '127.0.0.1', port: 18080 },
  spawn: { executable: 'node', args: [], ambientEnv: {} },
  env: { name: 'LANG', ambientEnv: { LANG: 'C' } },
  secret: { ref: 'provider-token', use: () => 1 },
  device: { device: 'gpu' },
};
const GARBAGE = [undefined, null, 0, 1, -1, 1.5, Number.NaN, 65536, true, '', 'x', 'a\0b', 'y'.repeat(70_000), [], ['read'], {}, () => 1,
  'other/a.txt', 'other.example.com', '1.2.3.999', 'sh', 'ghost', 'tpu', 'SECRET'];
const HOSTS = {
  full: () => {},
  empty: NO_METHODS,
  'no resolver': (host) => { delete host.resolve; },
  'throwing': (host) => {
    for (const name of ['realpath', 'readFile', 'writeFile', 'resolve', 'connect', 'listen', 'resolveExecutable', 'spawn', 'resolveSecret', 'openDevice']) {
      host[name] = () => { throw Object.assign(new Error(name), { code: 'EHOST' }); };
    }
  },
  'bad answers': (host) => {
    host.realpath = async () => 5;
    host.resolve = async () => 'not-a-list';
    host.connect = async () => null;
    host.resolveExecutable = async () => '';
    host.spawn = () => ({ pid: 1, kill() {}, done: Promise.resolve(null) });
  },
};

test('whatever a caller sends, the gate writes only pairs from the table, and an honest log verifies with exactly one outcome per decision that owes one', async () => {
  const allowed = new Set(tableKeys());
  let requests = 0;
  const seen = new Set();
  for (const mode of ['enforce', 'shadow']) {
    for (const [manifestName, manifest] of [['granting', GRANTING], ['nothing', NOTHING]]) {
      for (const [hostName, edit] of Object.entries(HOSTS)) {
        for (const [operation, base] of Object.entries(BASES)) {
          const label = `${mode}/${manifestName}/${hostName}/${operation}`;
          const { gate } = setup({ mode, manifest, edit });
          const calls = [base];
          for (const field of Object.keys(base)) for (const value of GARBAGE) calls.push({ ...base, [field]: value });
          for (const value of GARBAGE) calls.push(value);
          for (const request of calls) {
            requests += 1;
            await attempt(gate.invoke(operation, request));
          }
          for (const entry of decisions(gate)) {
            const key = keyOf(entry);
            seen.add(key);
            assert.ok(allowed.has(key), `${label}: the gate wrote ${key}, which is not in the table`);
            const owed = (entry.decision === 'allow' || entry.decision === 'would-deny') && entry.operation !== 'env';
            const outcomes = gate.audit().filter((other) => other.phase === 'outcome' && other.decision_seq === entry.seq);
            assert.equal(outcomes.length, owed ? 1 : 0, `${label}: ${key} at ${entry.seq}`);
          }
          assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] }, label);
        }
      }
    }
  }
  assert.ok(requests > 5000, `the sweep sent ${requests} requests`);
  assert.ok(seen.size >= 40, `the sweep reached ${seen.size} distinct pairs`);
});

// A forged, re-chained log of one decision (and its outcome when one is owed), in the shape the gate writes.
function forge({ mode, operation, decision, reason, outcome, enforced }) {
  const flag = enforced ?? (decision === 'deny' ? true : decision === 'would-deny' ? false : mode === 'enforce' || !['read', 'write', 'connect', 'listen', 'spawn'].includes(operation));
  const entries = [{ contract: ENFORCEMENT_AUDIT_CONTRACT, at: 1, mode, phase: 'decision', operation, decision, reason, enforced: flag, target: {} }];
  if (outcome) entries.push({ contract: ENFORCEMENT_AUDIT_CONTRACT, at: 2, mode, phase: 'outcome', operation, decision_seq: 0, ok: true });
  return entries;
}
const digest = createEnforcementGate({ manifest: GRANTING, host: createRecordingHost() }).permissionDigest;
const verdict = (entries) => verifyAuditLog(rechain(entries, digest), { manifestDigest: digest }).errors.map((error) => `${error.code}@${error.seq}`);

test('the verifier accepts a decision shape if and only if the table has it: every operation, decision, reason and mode, forged and re-chained', () => {
  const reasons = [...new Set([...Object.values(AUDIT_DECISION_REASONS.deny).flat(), ...Object.values(AUDIT_DECISION_REASONS['would-deny']).flat(), 'GRANTED', 'BOGUS', '', 'granted', 'NOT_GRANTED ', undefined, null, 5])];
  const owes = (decision, operation) => decision !== 'deny' && operation !== 'env';
  let accepted = 0;
  let rejected = 0;
  for (const mode of ['enforce', 'shadow']) {
    for (const operation of GATE_OPERATIONS) {
      for (const decision of ['allow', 'deny', 'would-deny']) {
        if (decision === 'would-deny' && mode === 'enforce') continue;
        for (const reason of reasons) {
          const valid = decision === 'allow' ? reason === 'GRANTED' : (AUDIT_DECISION_REASONS[decision][operation] ?? []).includes(reason);
          const label = `${mode}/${decision}/${operation}/${String(reason)}`;
          assert.deepEqual(verdict(forge({ mode, operation, decision, reason, outcome: owes(decision, operation) })), valid ? [] : ['AUDIT_INCONSISTENT@0'], label);
          if (valid) accepted += 1; else rejected += 1;
        }
      }
    }
  }
  assert.ok(accepted > 60 && rejected > 300, `${accepted} accepted, ${rejected} rejected`);
});

test('named shapes the gate never writes are rejected, and named shapes it does write are accepted, whatever the table says', () => {
  const never = [
    ['deny', 'read', 'GRANTED'], ['deny', 'connect', 'PATH_ESCAPES_ROOT'], ['deny', 'read', 'INVALID_ADDRESS_LITERAL'], ['deny', 'spawn', 'RESOLVE_FAILED'],
    ['deny', 'listen', 'EXECUTABLE_NOT_RESOLVED'], ['deny', 'env', 'HOST_CAPABILITY_MISSING'], ['deny', 'secret', 'PATH_UNRESOLVABLE'], ['deny', 'device', 'PROCESS_CAPACITY_EXCEEDED'],
    ['would-deny', 'read', 'UNKNOWN_OPERATION'], ['would-deny', 'read', 'INVALID_ARGUMENT'], ['would-deny', 'connect', 'HOST_CAPABILITY_MISSING'], ['would-deny', 'spawn', 'GRANTED'],
    ['would-deny', 'secret', 'NOT_GRANTED'], ['would-deny', 'device', 'NOT_GRANTED'], ['would-deny', 'env', 'NOT_GRANTED'],
    ['allow', 'read', 'NOT_GRANTED'], ['allow', 'spawn', 'UNKNOWN_OPERATION'], ['allow', 'env', ''],
  ];
  for (const [decision, operation, reason] of never) {
    assert.deepEqual(verdict(forge({ mode: 'shadow', operation, decision, reason, outcome: decision !== 'deny' && operation !== 'env' })), ['AUDIT_INCONSISTENT@0'], `${decision}/${operation}/${reason}`);
  }
  const always = [
    ['allow', 'read', 'GRANTED'], ['allow', 'env', 'GRANTED'], ['deny', 'read', 'PATH_ESCAPES_GRANT'], ['deny', 'connect', 'RESOLVES_TO_NON_PUBLIC_ADDRESS'], ['deny', 'spawn', 'PROCESS_CAPACITY_EXCEEDED'],
    ['deny', 'device', 'UNKNOWN_OPERATION'], ['would-deny', 'connect', 'INVALID_ADDRESS_LITERAL'], ['would-deny', 'spawn', 'EXECUTABLE_NOT_RESOLVED'], ['would-deny', 'listen', 'NOT_GRANTED'],
  ];
  for (const [decision, operation, reason] of always) {
    assert.deepEqual(verdict(forge({ mode: 'shadow', operation, decision, reason, outcome: decision !== 'deny' && operation !== 'env' })), [], `${decision}/${operation}/${reason}`);
  }
});

test('an outcome is owed by an allow or would-deny of a known operation other than env, and by nothing else', () => {
  for (const mode of ['enforce', 'shadow']) {
    for (const operation of GATE_OPERATIONS) {
      const label = `${mode}/${operation}`;
      const allow = { mode, operation, decision: 'allow', reason: 'GRANTED' };
      assert.deepEqual(verdict(forge({ ...allow, outcome: false })), operation === 'env' ? [] : ['AUDIT_OUTCOME_MISSING@0'], `${label}: an allow without an outcome`);
      assert.deepEqual(verdict(forge({ ...allow, outcome: true })), operation === 'env' ? ['AUDIT_OUTCOME_ORPHAN@1'] : [], `${label}: an allow with an outcome`);
      assert.deepEqual(verdict(forge({ mode, operation, decision: 'deny', reason: 'NOT_GRANTED', outcome: true })), ['AUDIT_OUTCOME_ORPHAN@1'], `${label}: a deny has no outcome`);
      assert.deepEqual(verdict(forge({ mode, operation, decision: 'deny', reason: 'NOT_GRANTED', outcome: false })), [], `${label}: a deny alone`);
    }
  }
  for (const operation of ['read', 'write', 'connect', 'listen', 'spawn']) {
    const wouldDeny = { mode: 'shadow', operation, decision: 'would-deny', reason: 'NOT_GRANTED' };
    assert.deepEqual(verdict(forge({ ...wouldDeny, outcome: false })), ['AUDIT_OUTCOME_MISSING@0'], `${operation}: a would-deny without an outcome`);
    assert.deepEqual(verdict(forge({ ...wouldDeny, outcome: true })), [], `${operation}: a would-deny with an outcome`);
  }
});

test('an outcome entry follows the decision it closes and names that decision\'s operation: any other reference is an orphan and leaves its decision without an outcome', () => {
  const [decision, outcome] = forge({ mode: 'enforce', operation: 'read', decision: 'allow', reason: 'GRANTED', outcome: true });
  assert.deepEqual(verdict([decision, outcome]), []);
  // The outcome comes first and points forward at its decision.
  assert.deepEqual(verdict([{ ...outcome, decision_seq: 1 }, decision]), ['AUDIT_OUTCOME_ORPHAN@0', 'AUDIT_OUTCOME_MISSING@1']);
  // The outcome names another operation than the decision it points at, whether or not the gate knows that operation.
  for (const operation of ['write', 'env', 'chmod', '']) {
    assert.deepEqual(verdict([decision, { ...outcome, operation }]), ['AUDIT_OUTCOME_ORPHAN@1', 'AUDIT_OUTCOME_MISSING@0'], `an outcome that names ${operation || 'nothing'}`);
  }
  // The reference is not an earlier entry: itself, a missing entry, or not an index at all.
  for (const decision_seq of [1, 2, 99, -1, 0.5, '0', null, undefined]) {
    assert.deepEqual(verdict([decision, { ...outcome, decision_seq }]), ['AUDIT_OUTCOME_ORPHAN@1', 'AUDIT_OUTCOME_MISSING@0'], `decision_seq ${String(decision_seq)}`);
  }
});
