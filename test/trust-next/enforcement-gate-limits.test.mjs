import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PERMISSION_MANIFEST_DIGEST_FORMAT, PERMISSION_MANIFEST_SCHEMA, permissionManifestDigest, validatePermissionManifest } from '../../lib/trust-next/permission-manifest.mjs';
import { ENFORCEMENT_AUDIT_CONTRACT, EnforcementDenied, GATE_LIMITS, UNSUPPORTED_LIMITS, createEnforcementGate, verifyAuditLog } from '../../lib/trust-next/enforcement-gate.mjs';
import { createRecordingHost } from './enforcement-host.mjs';

// Limits, secrets, environment, devices, the audit chain and the honesty of the report. The child
// processes here are scripted in memory; enforcement-gate-real.test.mjs repeats the limits on real ones.

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function denied(promise, reason, operation) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof EnforcementDenied, `expected EnforcementDenied, got ${error?.name}: ${error?.message}`);
    assert.equal(error.reason, reason);
    if (operation) assert.equal(error.operation, operation);
    return true;
  });
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error('condition was not reached');
}

// A scripted child: it exits by itself after `natural` ms unless the gate kills it first.
function scriptedChild({ natural = 400, stdout, stderr, kills }) {
  return ({ onStdout, onStderr }) => {
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const timer = setTimeout(() => finish({ exit_code: 0, signal: null }), natural);
    if (stdout) onStdout(stdout);
    if (stderr) onStderr(stderr);
    return { pid: 7, kill(signal) { kills.push(signal); clearTimeout(timer); finish({ exit_code: null, signal }); }, done };
  };
}

test('max_children is enforced across concurrent spawns and capacity returns when a child exits', async () => {
  const pending = [];
  const host = createRecordingHost({ spawnImpl: () => {
    let release;
    const done = new Promise((resolve) => { release = resolve; });
    pending.push(release);
    return { pid: 100 + pending.length, kill() {}, done };
  } });
  const gate = createEnforcementGate({ manifest: manifest({ process: { mode: 'argv-allowlist', executables: ['node'], max_children: 1 } }), host });
  const first = gate.spawn('node', ['a'], {});
  const second = gate.spawn('node', ['b'], {});
  const verdict = await Promise.race([second.then(() => 'spawned', (error) => error.reason), sleep(300).then(() => 'still-pending')]);
  try {
    assert.equal(verdict, 'PROCESS_CAPACITY_EXCEEDED');
    assert.equal(host.count('spawn'), 1);
  } finally {
    for (const release of pending) release({ exit_code: 0, signal: null });
  }
  await first;
  const third = gate.spawn('node', ['c'], {});
  await waitFor(() => pending.length === 2);
  pending[1]({ exit_code: 0, signal: null });
  assert.equal((await third).exit_code, 0);
  assert.equal(gate.audit().filter((entry) => entry.reason === 'PROCESS_CAPACITY_EXCEEDED').length, 1);
});

test('a host failure while spawning is audited and does not leak capacity', async () => {
  let calls = 0;
  const host = createRecordingHost({ spawnImpl: () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('no fork'), { code: 'EBOOM' });
    return { pid: 9, kill() {}, done: Promise.resolve({ exit_code: 0, signal: null }) };
  } });
  const gate = createEnforcementGate({ manifest: manifest({ process: { mode: 'argv-allowlist', executables: ['node'], max_children: 1 } }), host });
  await assert.rejects(gate.spawn('node', [], {}), { code: 'EBOOM' });
  assert.equal((await gate.spawn('node', [], {})).exit_code, 0);
  const failed = gate.audit().find((entry) => entry.phase === 'outcome' && entry.ok === false);
  assert.equal(failed.error_code, 'EBOOM');
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
});

test('stdout and stderr caps are applied by the gate: output is cut, flagged, and the child is killed', async () => {
  const kills = [];
  const host = createRecordingHost({ spawnImpl: scriptedChild({ stdout: Buffer.alloc(5000, 97), stderr: Buffer.alloc(10, 98), kills }) });
  const gate = createEnforcementGate({ manifest: manifest({ limits: { stdout_bytes: 1024 } }), host });
  const result = await gate.spawn('node', [], {});
  assert.equal(result.stdout.length, 1024);
  assert.equal(result.stdout_truncated, true);
  assert.equal(result.stderr_truncated, false);
  assert.equal(result.stderr.toString(), 'bbbbbbbbbb');
  assert.equal(result.killed_for, 'stdout_bytes');
  assert.equal(result.signal, 'SIGKILL');
  assert.deepEqual(kills, ['SIGKILL']);
  const outcome = gate.audit().at(-1);
  assert.equal(outcome.stdout_truncated, true);
  assert.equal(outcome.stdout_bytes, 1024);
});

test('the wall limit kills a child that outlives it and reports the timeout', async () => {
  const kills = [];
  const host = createRecordingHost({ spawnImpl: scriptedChild({ natural: 400, kills }) });
  const gate = createEnforcementGate({ manifest: manifest({ limits: { wall_ms: 50 } }), host });
  const result = await gate.spawn('node', [], {});
  assert.equal(result.timed_out, true);
  assert.equal(result.killed_for, 'wall_ms');
  assert.equal(result.signal, 'SIGKILL');
  assert.deepEqual(kills, ['SIGKILL']);
  assert.equal(gate.audit().at(-1).timed_out, true);
});

test('a secret reaches only the callback; the audit log keeps the reference and never the value or the result', async () => {
  const host = createRecordingHost({ secrets: { 'provider-token': 'tok_SECRET_VALUE_123' } });
  const gate = createEnforcementGate({ manifest: manifest(), host });
  assert.equal(await gate.useSecret('provider-token', (value) => value), 'tok_SECRET_VALUE_123');
  await assert.rejects(gate.useSecret('provider-token', (value) => { throw new Error(`leak ${value}`); }), /leak/);
  await denied(gate.useSecret('other-token', () => 1), 'NOT_GRANTED', 'secret');
  await denied(gate.useSecret('provider-token', 'not a function'), 'INVALID_ARGUMENT', 'secret');
  const text = JSON.stringify(gate.audit());
  assert.equal(text.includes('tok_SECRET_VALUE_123'), false);
  assert.equal(text.includes('provider-token'), true);
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
});

test('environment reads are limited to allowlisted names, values are not logged, devices are granted by class', async () => {
  const gate = createEnforcementGate({ manifest: manifest(), host: createRecordingHost() });
  assert.equal(await gate.readEnv('LANG', { LANG: 'ko_KR.UTF-8' }), 'ko_KR.UTF-8');
  assert.equal(await gate.readEnv('LANG', {}), undefined);
  for (const name of ['SECRET_TOKEN', 'NODE_OPTIONS', 'PATH', 'lang']) await denied(gate.readEnv(name, { [name]: 'v' }), 'NOT_GRANTED', 'env');
  await denied(gate.readEnv('LANG', 'x'), 'INVALID_ARGUMENT', 'env');
  await denied(gate.readEnv('LANG', { LANG: 5 }), 'INVALID_ARGUMENT', 'env');
  await denied(gate.spawn('node', [], { LANG: 5 }), 'INVALID_ARGUMENT', 'spawn');
  assert.equal(JSON.stringify(gate.audit()).includes('ko_KR'), false);
  assert.deepEqual(await gate.useDevice('gpu'), { opened: 'gpu' });
  for (const device of ['camera', 'usb', 'accelerator']) await denied(gate.useDevice(device), 'NOT_GRANTED', 'device');
  await denied(gate.useDevice(5), 'INVALID_ARGUMENT', 'device');
});

// Independent re-implementation of the chain, so the gate's hashes are recomputed rather than trusted.
const canon = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`;
};
const sha = (text) => createHash('sha256').update(text).digest('hex');
const genesis = (digest) => sha(`${ENFORCEMENT_AUDIT_CONTRACT}\n${PERMISSION_MANIFEST_DIGEST_FORMAT}\n${digest}`);
function rechain(entries, digest) {
  let prev = genesis(digest);
  return entries.map((entry, seq) => {
    const body = { ...entry, seq, prev_sha256: prev };
    delete body.sha256;
    const out = { ...body, sha256: sha(canon(body)) };
    prev = out.sha256;
    return out;
  });
}

async function sampleGate() {
  const host = createRecordingHost({ files: { 'src/a.txt': 'alpha' }, dns: { 'api.example.com': [['93.184.216.34']] } });
  const gate = createEnforcementGate({ manifest: manifest(), host, clock: () => 1_700_000_000_000 });
  await gate.read('src/a.txt');
  await denied(gate.read('secret/x'), 'NOT_GRANTED');
  await gate.write('out/r.json', 'x');
  await gate.connect('api.example.com', 443);
  await denied(gate.spawn('sh', [], {}), 'NOT_GRANTED');
  return gate;
}

test('the audit chain recomputes independently and survives a JSON round trip', async () => {
  const gate = await sampleGate();
  const entries = gate.audit();
  const digest = gate.permissionDigest;
  assert.equal(entries.length, 8);
  assert.deepEqual(entries, rechain(entries, digest));
  const report = gate.report();
  assert.deepEqual(verifyAuditLog(JSON.parse(JSON.stringify(entries)), { manifestDigest: digest, expectedEntries: 8, expectedHeadSha256: report.audit.head_sha256 }), { ok: true, errors: [] });
  assert.equal(report.audit.entries, 8);
  assert.equal(report.audit.genesis_sha256, genesis(digest));
  assert.equal(report.audit.head_sha256, entries.at(-1).sha256);
  const empty = createEnforcementGate({ manifest: manifest(), host: createRecordingHost() });
  assert.equal(empty.report().audit.head_sha256, genesis(empty.permissionDigest));
  assert.deepEqual(verifyAuditLog([], { manifestDigest: empty.permissionDigest, expectedEntries: 0, expectedHeadSha256: genesis(empty.permissionDigest) }), { ok: true, errors: [] });
});

test('audit tampering is detected: edits, removals, truncation, reordering, splices, wrong seed and impossible records', async () => {
  const gate = await sampleGate();
  const digest = gate.permissionDigest;
  const head = gate.report().audit.head_sha256;
  const fresh = () => JSON.parse(JSON.stringify(gate.audit()));
  const codes = (entries, options = {}) => verifyAuditLog(entries, { manifestDigest: digest, ...options }).errors.map((error) => `${error.code}@${error.seq}`);
  let copy = fresh();
  copy[1].reason = 'EDITED';
  assert.ok(codes(copy).includes('AUDIT_HASH_MISMATCH@1'));
  copy = fresh();
  copy.splice(2, 1);
  assert.ok(codes(copy).some((code) => code.startsWith('AUDIT_SEQ_MISMATCH') || code.startsWith('AUDIT_CHAIN_BROKEN')));
  copy = fresh().slice(0, -1);
  assert.ok(codes(copy, { expectedEntries: 8 }).includes('AUDIT_TRUNCATED@null'));
  assert.ok(codes(copy, { expectedHeadSha256: head }).includes('AUDIT_HEAD_MISMATCH@null'));
  copy = fresh();
  [copy[2], copy[3]] = [copy[3], copy[2]];
  assert.notDeepEqual(codes(copy), []);
  copy = fresh();
  copy[2].decision = 'allow';
  copy[2].sha256 = sha(canon((({ sha256, ...body }) => body)(copy[2])));
  assert.ok(codes(copy).includes('AUDIT_CHAIN_BROKEN@3'));
  copy = fresh();
  copy[2].enforced = false;
  assert.ok(codes(rechain(copy, digest)).includes('AUDIT_INCONSISTENT@2'));
  copy = fresh();
  copy[0].mode = 'shadow';
  assert.ok(codes(rechain(copy, digest)).includes('AUDIT_INCONSISTENT@0'));
  copy = fresh();
  copy[1].decision_seq = 2;
  assert.ok(codes(rechain(copy, digest)).includes('AUDIT_OUTCOME_ORPHAN@1'));
  copy = fresh();
  copy[0].phase = 'other';
  assert.ok(codes(rechain(copy, digest)).includes('AUDIT_PHASE_INVALID@0'));
  assert.ok(verifyAuditLog(fresh(), { manifestDigest: '0'.repeat(64) }).errors.some((error) => error.code === 'AUDIT_CHAIN_BROKEN' && error.seq === 0));
  assert.equal(verifyAuditLog('nope', { manifestDigest: digest }).errors[0].code, 'AUDIT_NOT_ARRAY');
  assert.equal(verifyAuditLog(fresh(), {}).errors[0].code, 'AUDIT_MANIFEST_DIGEST_REQUIRED');
  assert.equal(verifyAuditLog(fresh(), { manifestDigest: digest, expectedEntries: 8, expectedHeadSha256: head }).ok, true);
});

test('a full audit log fails closed: the next operation is refused and the host is not called', async () => {
  const host = createRecordingHost({ files: { 'src/a.txt': 'alpha' } });
  const gate = createEnforcementGate({ manifest: manifest(), host, maxAuditEntries: 4 });
  await gate.read('src/a.txt');
  await gate.read('src/a.txt');
  await denied(gate.read('src/a.txt'), 'AUDIT_FULL', 'read');
  assert.equal(host.count('readFile'), 2);
  assert.equal(gate.audit().length, 4);
});

const layout = (gate) => gate.audit().map((entry) => `${entry.phase}:${entry.operation}:${entry.decision ?? (entry.ok ? 'ok' : 'failed')}`);
const strict = (gate, options = {}) => verifyAuditLog(gate.audit(), { manifestDigest: gate.permissionDigest, ...options });

test('one free slot is not enough for a request that reaches the host: its decision and its outcome are reserved first', async () => {
  const host = createRecordingHost({ files: { 'src/a.txt': 'alpha' }, dns: { 'api.example.com': [['93.184.216.34']] }, secrets: { 'provider-token': 'tok' } });
  const gate = createEnforcementGate({ manifest: manifest(), host, maxAuditEntries: 5 });
  await assert.rejects(gate.read('src/missing.txt'), { code: 'ENOENT' });
  await gate.read('src/a.txt');
  assert.equal(gate.audit().length, 4);
  assert.equal(gate.report().audit.in_flight, 0);
  const before = host.calls.length;
  // One slot is free, so a decision could be written but its outcome could not: nothing may reach the host.
  await denied(gate.read('src/a.txt'), 'AUDIT_FULL', 'read');
  await denied(gate.write('out/r.json', 'x'), 'AUDIT_FULL', 'write');
  await denied(gate.connect('api.example.com', 443), 'AUDIT_FULL', 'connect');
  await denied(gate.listen('127.0.0.1', 18080), 'AUDIT_FULL', 'listen');
  await denied(gate.spawn('node', [], {}), 'AUDIT_FULL', 'spawn');
  await denied(gate.useSecret('provider-token', () => 1), 'AUDIT_FULL', 'secret');
  await denied(gate.useDevice('gpu'), 'AUDIT_FULL', 'device');
  assert.equal(host.calls.length, before);
  assert.equal(host.count('readFile'), 2);
  assert.equal(gate.audit().length, 4);
  assert.deepEqual(strict(gate, { expectedEntries: 4 }), { ok: true, errors: [] });
  // An environment read owes no outcome, so the last slot is enough for it; after that the log is full.
  assert.equal(await gate.readEnv('LANG', { LANG: 'C' }), 'C');
  assert.equal(gate.audit().length, 5);
  await denied(gate.readEnv('LANG', { LANG: 'C' }), 'AUDIT_FULL', 'env');
  assert.equal(gate.audit().length, 5);
  assert.deepEqual(strict(gate, { expectedEntries: 5 }), { ok: true, errors: [] });
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
});

test('a record that needs no host call needs one free slot: environment reads and unknown operations fill the log exactly', async () => {
  const gate = createEnforcementGate({ manifest: manifest(), host: createRecordingHost(), maxAuditEntries: 3 });
  assert.equal(await gate.readEnv('LANG', { LANG: 'C' }), 'C');
  await denied(gate.invoke('exec', {}), 'UNKNOWN_OPERATION');
  assert.equal(await gate.readEnv('LANG', {}), undefined);
  assert.deepEqual(layout(gate), ['decision:env:allow', 'decision:exec:deny', 'decision:env:allow']);
  await denied(gate.readEnv('LANG', { LANG: 'C' }), 'AUDIT_FULL', 'env');
  await denied(gate.invoke('exec', {}), 'AUDIT_FULL');
  assert.equal(gate.audit().length, 3);
  assert.deepEqual(strict(gate, { expectedEntries: 3 }), { ok: true, errors: [] });
});

test('slots held by requests that are still running count against the capacity, so concurrent requests cannot overrun the log', async () => {
  const held = [];
  let started = 0;
  const host = createRecordingHost({ files: { 'src/a.txt': 'alpha' } });
  host.readFile = () => {
    started += 1;
    // Only the first two reads are held. A third one must never get this far; if it does it finishes at once, so a broken
    // reservation fails the assertions below instead of leaving the test waiting for a read that nobody releases.
    if (started > 2) return Promise.resolve(Buffer.from('alpha'));
    return new Promise((resolve) => held.push(() => resolve(Buffer.from('alpha'))));
  };
  const gate = createEnforcementGate({ manifest: manifest(), host, maxAuditEntries: 4 });
  const first = gate.read('src/a.txt');
  const second = gate.read('src/a.txt');
  try {
    await waitFor(() => started === 2);
    // Two decisions are written and two outcomes are owed: the log has no room for a third pair although it holds two entries.
    assert.equal(gate.audit().length, 2);
    assert.equal(gate.report().audit.in_flight, 2);
    await denied(gate.read('src/a.txt'), 'AUDIT_FULL', 'read');
    assert.equal(started, 2);
    // The live verifier knows both decisions are still running; an exported copy of the log does not.
    assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
    assert.deepEqual(strict(gate).errors.map((error) => `${error.code}@${error.seq}`), ['AUDIT_OUTCOME_MISSING@0', 'AUDIT_OUTCOME_MISSING@1']);
    assert.deepEqual(strict(gate, { inFlight: [0, 1] }), { ok: true, errors: [] });
  } finally {
    for (const release of held) release();
  }
  await Promise.all([first, second]);
  assert.equal(gate.audit().length, 4);
  assert.equal(gate.report().audit.in_flight, 0);
  assert.deepEqual(strict(gate, { expectedEntries: 4 }), { ok: true, errors: [] });
  assert.deepEqual(gate.verifyAudit(), { ok: true, errors: [] });
});

test('every allowed or would-deny decision has exactly one outcome, including a request refused inside a secret callback', async () => {
  const host = createRecordingHost({ secrets: { 'provider-token': 'tok_SECRET' }, files: { 'src/a.txt': 'alpha' } });
  const gate = createEnforcementGate({ manifest: manifest(), host });
  await denied(gate.useSecret('provider-token', () => gate.read('secret/x')), 'NOT_GRANTED', 'read');
  await assert.rejects(gate.useSecret('provider-token', () => { throw new Error('callback failed'); }), /callback failed/);
  assert.equal(await gate.useSecret('provider-token', () => gate.read('src/a.txt').then((bytes) => bytes.toString())), 'alpha');
  assert.deepEqual(layout(gate), [
    'decision:secret:allow', 'decision:read:deny', 'outcome:secret:failed',
    'decision:secret:allow', 'outcome:secret:failed',
    'decision:secret:allow', 'decision:read:allow', 'outcome:read:ok', 'outcome:secret:ok',
  ]);
  assert.equal(gate.audit()[2].error_code, 'PERMISSION_DENIED');
  assert.equal(gate.audit()[2].decision_seq, 0);
  assert.equal(gate.audit()[8].decision_seq, 5);
  assert.equal(gate.report().audit.in_flight, 0);
  assert.deepEqual(strict(gate, { expectedEntries: 9 }), { ok: true, errors: [] });
  assert.equal(JSON.stringify(gate.audit()).includes('tok_SECRET'), false);
});

test('a shadow-mode would-deny and an allow that lost its outcome are both reported by the verifier', async () => {
  const shadow = createEnforcementGate({ manifest: manifest(), host: createRecordingHost({ files: { 'src/a.txt': 'alpha' } }), mode: 'shadow' });
  await shadow.read('secret/x').catch(() => {});
  await shadow.read('src/a.txt');
  const digest = shadow.permissionDigest;
  const copy = JSON.parse(JSON.stringify(shadow.audit()));
  assert.deepEqual(layout(shadow), ['decision:read:would-deny', 'outcome:read:failed', 'decision:read:allow', 'outcome:read:ok']);
  assert.deepEqual(verifyAuditLog(copy, { manifestDigest: digest }), { ok: true, errors: [] });
  assert.deepEqual(verifyAuditLog(copy.slice(0, 1), { manifestDigest: digest }).errors.map((error) => `${error.code}@${error.seq}`), ['AUDIT_OUTCOME_MISSING@0']);
  assert.deepEqual(verifyAuditLog(copy.slice(0, 3), { manifestDigest: digest }).errors.map((error) => `${error.code}@${error.seq}`), ['AUDIT_OUTCOME_MISSING@2']);
  assert.deepEqual(verifyAuditLog(copy.slice(0, 3), { manifestDigest: digest, inFlight: [2] }), { ok: true, errors: [] });
  const sample = await sampleGate();
  const entries = JSON.parse(JSON.stringify(sample.audit()));
  const codes = (list, options = {}) => verifyAuditLog(list, { manifestDigest: sample.permissionDigest, ...options }).errors.map((error) => `${error.code}@${error.seq}`);
  // sampleGate: 0 read allow, 1 read outcome, 2 read deny, 3 write allow, 4 write outcome, 5 connect allow, 6 connect outcome, 7 spawn deny
  assert.deepEqual(codes(entries), []);
  const removed = rechain(entries.filter((_, index) => index !== 6), sample.permissionDigest);
  assert.deepEqual(codes(removed), ['AUDIT_OUTCOME_MISSING@5']);
  assert.deepEqual(codes(removed, { inFlight: [5] }), []);
  assert.deepEqual(codes(entries.slice(0, 6)), ['AUDIT_OUTCOME_MISSING@5']);
  assert.deepEqual(codes(entries.slice(0, 6), { inFlight: [5] }), []);
  assert.deepEqual(codes(entries.slice(0, 6), { inFlight: [4] }), ['AUDIT_OUTCOME_MISSING@5']);
  // An environment read is the one allowed decision without a host effect, so it owes no outcome.
  const env = createEnforcementGate({ manifest: manifest(), host: createRecordingHost() });
  await env.readEnv('LANG', { LANG: 'C' });
  assert.deepEqual(layout(env), ['decision:env:allow']);
  assert.deepEqual(strict(env, { expectedEntries: 1 }), { ok: true, errors: [] });
});

test('when the outcome entry itself cannot be written the decision is reported as missing its outcome, not excused as running', async () => {
  let broken = false;
  const host = createRecordingHost({ files: { 'src/a.txt': 'alpha' } });
  const readFile = host.readFile;
  host.readFile = async (rel) => {
    const bytes = await readFile(rel);
    broken = true;
    return bytes;
  };
  const gate = createEnforcementGate({ manifest: manifest(), host, clock: () => (broken ? Number.NaN : 1_700_000_000_000) });
  await assert.rejects(gate.read('src/a.txt'), { code: 'INVALID_GATE_CLOCK' });
  assert.equal(gate.audit().length, 1);
  assert.equal(gate.report().audit.in_flight, 0);
  assert.deepEqual(gate.verifyAudit().errors.map((error) => `${error.code}@${error.seq}`), ['AUDIT_OUTCOME_MISSING@0']);
});

test('construction rejects an unknown mode, a missing host, a bad clock, bad options and an invalid manifest', () => {
  const host = createRecordingHost();
  const code = (options) => { try { createEnforcementGate(options); } catch (error) { return error.code; } return 'NO_ERROR'; };
  assert.equal(code({ manifest: manifest(), host, mode: 'audit' }), 'INVALID_GATE_MODE');
  assert.equal(code({ manifest: manifest(), host: null }), 'INVALID_GATE_HOST');
  assert.equal(code({ manifest: manifest() }), 'INVALID_GATE_HOST');
  assert.equal(code({ manifest: manifest(), host, clock: 5 }), 'INVALID_GATE_CLOCK');
  assert.equal(code({ manifest: manifest(), host, maxAuditEntries: 1 }), 'INVALID_GATE_OPTIONS');
  assert.equal(code({ manifest: { schema: 'wrong' }, host }), 'INVALID_PERMISSION_MANIFEST');
  assert.equal(code({ host }), 'INVALID_PERMISSION_MANIFEST');
  assert.equal(createEnforcementGate({ manifest: manifest(), host }).mode, 'enforce');
});

test('the report states what is not claimed: no attestation, no OS sandbox, no enforced echo, unsupported limits', () => {
  const gate = createEnforcementGate({ manifest: manifest(), host: createRecordingHost() });
  const report = gate.report();
  assert.equal(report.attestation.present, false);
  assert.equal(report.os_sandbox, false);
  assert.equal(report.scope, 'in-process-mediation');
  const keys = [];
  const walk = (value) => { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { keys.push(key); walk(child); } };
  walk(report);
  assert.equal(keys.includes('enforced'), false);
  for (const name of UNSUPPORTED_LIMITS) assert.equal(report.dimensions[name], 'unsupported', name);
  for (const name of ['fs_read', 'fs_write', 'network_connect', 'process_spawn', 'wall_ms']) assert.equal(report.dimensions[name], 'mediated', name);
  const ids = report.limits.map((limit) => limit.id);
  for (const id of ['cooperative-mediation', 'no-os-sandbox', 'check-use-race', 'no-attestation', 'echo-enforced-flag-not-set', 'shadow-is-not-enforcement', 'resource-limits-unsupported']) assert.ok(ids.includes(id), id);
  assert.deepEqual(report.limits, GATE_LIMITS);
  assert.deepEqual(report.permission_digest, { format: PERMISSION_MANIFEST_DIGEST_FORMAT, sha256: permissionManifestDigest(validatePermissionManifest(manifest()).value) });
  assert.equal(report.permission_digest.sha256, gate.permissionDigest);
  assert.equal(Object.isFrozen(report), true);
});

test('every manifest dimension changes the permission digest and the audit seed', async () => {
  const base = createEnforcementGate({ manifest: manifest(), host: createRecordingHost() });
  const variants = {
    read_roots: { read_roots: ['src', 'docs'] },
    write_roots: { write_roots: ['out', 'tmp'] },
    network: { network: { mode: 'allowlist', allow: [{ host: 'api.example.com', ports: [443, 8443] }] } },
    listen: { listen: { mode: 'allowlist', allow: [{ host: '127.0.0.1', ports: [18081] }] } },
    process: { process: { mode: 'argv-allowlist', executables: ['node'], max_children: 3 } },
    environment: { environment: { allow: ['LANG', 'TZ'] } },
    secret_refs: { secret_refs: ['provider-token', 'other-token'] },
    devices: { devices: { mode: 'allowlist', allow: ['gpu', 'audio'] } },
    limits: { limits: { wall_ms: 1234 } },
  };
  const seen = new Set([base.permissionDigest]);
  for (const [name, extra] of Object.entries(variants)) {
    const gate = createEnforcementGate({ manifest: manifest(extra), host: createRecordingHost() });
    assert.notEqual(gate.permissionDigest, base.permissionDigest, name);
    assert.notEqual(gate.report().audit.genesis_sha256, base.report().audit.genesis_sha256, name);
    seen.add(gate.permissionDigest);
  }
  assert.equal(seen.size, 10);
  const sample = await sampleGate();
  assert.equal(verifyAuditLog(sample.audit(), { manifestDigest: sample.permissionDigest }).ok, true);
  const other = [...seen].find((digest) => digest !== sample.permissionDigest);
  assert.equal(verifyAuditLog(sample.audit(), { manifestDigest: other }).ok, false);
});
