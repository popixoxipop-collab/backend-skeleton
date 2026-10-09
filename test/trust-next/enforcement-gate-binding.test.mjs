import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_MANIFEST_SCHEMA } from '../../lib/trust-next/permission-manifest.mjs';
import { createEnforcementGate, verifyAuditLog } from '../../lib/trust-next/enforcement-gate.mjs';
import { rechain } from './enforcement-audit-forge.mjs';
import { createRecordingHost } from './enforcement-host.mjs';

// What one gate instance fixes when it is built, and what the verifier therefore binds the whole log to. A gate has one mode, one
// manifest (its digest seeds the chain) and one contract, so a log that changes any of them in the middle did not come from one gate.
// Manifest and contract drift are covered by the chain and contract tests; this file covers the mode, which is a field of every entry,
// and the clock, which is the one fixed property that is deliberately not bound in direction. The sample logs use environment, secret and
// device operations only: those are written the same way in both modes, so flipping a mode in a re-chained log leaves
// the mode binding as the only thing wrong with it.

const MANIFEST = {
  schema: PERMISSION_MANIFEST_SCHEMA,
  environment: { allow: ['LANG'] },
  secret_refs: ['provider-token'],
  devices: { mode: 'allowlist', allow: ['gpu'] },
};
const OTHER = { enforce: 'shadow', shadow: 'enforce' };
const PHASES = ['decision', 'decision', 'outcome', 'decision', 'outcome', 'decision'];

// env decision, secret decision + outcome, device decision + outcome, env decision.
async function honestGate(mode, clock) {
  const host = createRecordingHost({ secrets: { 'provider-token': 'T' } });
  const gate = createEnforcementGate({ manifest: MANIFEST, host, mode, ...(clock === undefined ? {} : { clock }) });
  await gate.readEnv('LANG', { LANG: 'C' });
  await gate.useSecret('provider-token', () => 'used');
  await gate.useDevice('gpu');
  await gate.readEnv('LANG', {});
  return gate;
}

const codes = (result) => result.errors.map((error) => `${error.code}@${error.seq}`);
const edit = (entries, index, fields) => entries.map((entry, i) => (i === index ? { ...entry, ...fields } : entry));
const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

test('an honest log of either mode is bound to its own mode and verifies, with or without the expected mode', async () => {
  for (const mode of ['enforce', 'shadow']) {
    const gate = await honestGate(mode);
    const entries = gate.audit();
    const digest = gate.permissionDigest;
    assert.deepEqual(entries.map((entry) => entry.phase), PHASES, mode);
    assert.ok(entries.every((entry) => entry.mode === mode), mode);
    assert.equal(gate.verifyAudit().ok, true, mode);
    assert.deepEqual(verifyAuditLog(entries, { manifestDigest: digest }), { ok: true, errors: [] }, `${mode}: bound to its first entry`);
    assert.deepEqual(verifyAuditLog(entries, { manifestDigest: digest, expectedMode: mode }), { ok: true, errors: [] }, `${mode}: bound to the expected mode`);
    assert.deepEqual(verifyAuditLog(entries, { manifestDigest: digest, expectedMode: undefined }), { ok: true, errors: [] }, `${mode}: an undefined expected mode is no expected mode`);
    assert.deepEqual(verifyAuditLog([], { manifestDigest: digest, expectedMode: mode }), { ok: true, errors: [] }, `${mode}: an empty log has nothing to bind`);
  }
});

test('a log that switches mode is rejected at the entry that switches, decision or outcome, in both directions', async () => {
  for (const mode of ['enforce', 'shadow']) {
    const gate = await honestGate(mode);
    const entries = gate.audit();
    const digest = gate.permissionDigest;
    for (let k = 0; k < entries.length; k += 1) {
      const log = rechain(edit(entries, k, { mode: OTHER[mode] }), digest);
      // The first entry decides which mode the log is bound to, so a changed first entry puts every later entry in the wrong.
      const expected = (k === 0 ? range(1, entries.length) : [k]).map((i) => `AUDIT_MODE_CHANGED@${i}`);
      assert.deepEqual(codes(verifyAuditLog(log, { manifestDigest: digest })), expected, `${mode}: entry ${k} (${entries[k].phase}) carries ${OTHER[mode]}`);
    }
    // Every entry from some point on carries the other mode: the mode "changed once" and stayed changed.
    for (let from = 1; from < entries.length; from += 1) {
      const log = rechain(entries.map((entry, i) => (i >= from ? { ...entry, mode: OTHER[mode] } : entry)), digest);
      assert.deepEqual(codes(verifyAuditLog(log, { manifestDigest: digest })), range(from, entries.length).map((i) => `AUDIT_MODE_CHANGED@${i}`), `${mode}: from entry ${from} on`);
    }
  }
});

test('entries that really come from two gates of different modes do not make one log: decisions and outcomes alike', async () => {
  const enforce = await honestGate('enforce');
  const shadow = await honestGate('shadow');
  const digest = enforce.permissionDigest;
  assert.equal(shadow.permissionDigest, digest, 'the same manifest, so the same genesis: only the mode differs');
  const [e0, e1, e2] = enforce.audit();
  const [s0, s1, s2] = shadow.audit();
  assert.deepEqual([e0.mode, s0.mode], ['enforce', 'shadow']);
  assert.equal(e0.operation, 'env');
  assert.equal(s0.operation, 'env');
  // Two allowed environment decisions need no outcomes, so nothing but the mode can be wrong with them.
  assert.deepEqual(codes(verifyAuditLog(rechain([e0, s0], digest), { manifestDigest: digest })), ['AUDIT_MODE_CHANGED@1']);
  assert.deepEqual(codes(verifyAuditLog(rechain([s0, e0], digest), { manifestDigest: digest })), ['AUDIT_MODE_CHANGED@1']);
  assert.deepEqual(codes(verifyAuditLog(rechain([e0, s0], digest), { manifestDigest: digest, expectedMode: 'enforce' })), ['AUDIT_MODE_CHANGED@1']);
  assert.deepEqual(codes(verifyAuditLog(rechain([e0, s0], digest), { manifestDigest: digest, expectedMode: 'shadow' })), ['AUDIT_MODE_CHANGED@0']);
  // A secret decision of one gate and the outcome of the other.
  assert.deepEqual([e1.phase, s2.phase, s2.decision_seq], ['decision', 'outcome', 1]);
  assert.deepEqual(codes(verifyAuditLog(rechain([e0, e1, s2], digest), { manifestDigest: digest })), ['AUDIT_MODE_CHANGED@2']);
  assert.deepEqual(codes(verifyAuditLog(rechain([s0, s1, e2], digest), { manifestDigest: digest })), ['AUDIT_MODE_CHANGED@2']);
  // Each one alone is a fine log.
  assert.equal(verifyAuditLog(rechain([e0, e1, e2], digest), { manifestDigest: digest }).ok, true);
  assert.equal(verifyAuditLog(rechain([s0, s1, s2], digest), { manifestDigest: digest }).ok, true);
});

test('the expected mode binds the log even where its first entry would have set the mode, and an unknown mode is not accepted as an expectation', async () => {
  for (const mode of ['enforce', 'shadow']) {
    const gate = await honestGate(mode);
    const entries = gate.audit();
    const digest = gate.permissionDigest;
    const wrong = verifyAuditLog(entries, { manifestDigest: digest, expectedMode: OTHER[mode] });
    assert.deepEqual(codes(wrong), range(0, entries.length).map((i) => `AUDIT_MODE_CHANGED@${i}`), `${mode}: a whole log of the other mode`);
    assert.equal(wrong.ok, false);
    // A log whose every entry was relabelled agrees with itself, so only the expectation can see it.
    const relabelled = rechain(entries.map((entry) => ({ ...entry, mode: OTHER[mode] })), digest);
    assert.equal(verifyAuditLog(relabelled, { manifestDigest: digest }).ok, true, `${mode}: consistent with its first entry`);
    assert.deepEqual(codes(verifyAuditLog(relabelled, { manifestDigest: digest, expectedMode: mode })), range(0, entries.length).map((i) => `AUDIT_MODE_CHANGED@${i}`), `${mode}: not the mode the caller knows the gate ran in`);
    for (const bad of ['audit', 'ENFORCE', 'Shadow', '', null, 1, true, {}, []]) {
      for (const log of [entries, []]) {
        assert.deepEqual(codes(verifyAuditLog(log, { manifestDigest: digest, expectedMode: bad })), ['AUDIT_EXPECTED_MODE_INVALID@null'], `${mode}: expectedMode ${JSON.stringify(bad)}`);
      }
    }
  }
});

test('a first entry with an unknown mode is only invalid: the binding starts at the first entry that names a mode', async () => {
  const gate = await honestGate('enforce');
  const entries = gate.audit();
  const digest = gate.permissionDigest;
  for (const bad of ['audit', 'ENFORCE', '', null, undefined, 1, {}]) {
    for (const k of [0, 2, 3, 5]) {
      const log = rechain(edit(entries, k, { mode: bad }), digest);
      assert.deepEqual(codes(verifyAuditLog(log, { manifestDigest: digest })), [`AUDIT_ENTRY_INVALID@${k}`], `entry ${k} carries ${JSON.stringify(bad)}`);
    }
  }
  // When the only entries that name a valid mode disagree, the first valid one wins.
  const log = rechain(entries.map((entry, i) => ({ ...entry, mode: i === 0 ? 'audit' : i === 1 ? 'shadow' : 'enforce' })), digest);
  assert.deepEqual(codes(verifyAuditLog(log, { manifestDigest: digest })), ['AUDIT_ENTRY_INVALID@0', ...range(2, entries.length).map((i) => `AUDIT_MODE_CHANGED@${i}`)]);
});

test('the clock is not bound in direction: a wall clock that steps backwards still gives a log that verifies', async () => {
  const steps = [1000, 900, 950, 10, 2000, 5];
  for (const mode of ['enforce', 'shadow']) {
    let reads = 0;
    const gate = await honestGate(mode, () => steps[Math.min(reads++, steps.length - 1)]);
    const entries = gate.audit();
    assert.deepEqual(entries.map((entry) => entry.at), steps, mode);
    assert.equal(gate.verifyAudit().ok, true, `${mode}: the gate's own check`);
    assert.deepEqual(verifyAuditLog(entries, { manifestDigest: gate.permissionDigest, expectedMode: mode }), { ok: true, errors: [] }, `${mode}: the exported log`);
  }
});

test('the time of an entry is a safe integer, as the gate writes it: any other value is an invalid entry, and nothing else is wrong with the log', async () => {
  const gate = await honestGate('enforce');
  const entries = gate.audit();
  const digest = gate.permissionDigest;
  for (const bad of ['1', 1.5, NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53), null, undefined, {}, [], true]) {
    for (const k of [0, 2, 5]) {
      const log = rechain(edit(entries, k, { at: bad }), digest);
      assert.deepEqual(codes(verifyAuditLog(log, { manifestDigest: digest })), [`AUDIT_ENTRY_INVALID@${k}`], `entry ${k} carries at=${String(bad)}`);
    }
  }
  // The gate refuses a clock that does not return one, so it never writes these; every safe integer is a time it can write.
  for (const fine of [0, -5, 1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
    const log = rechain(entries.map((entry) => ({ ...entry, at: fine })), digest);
    assert.equal(verifyAuditLog(log, { manifestDigest: digest }).ok, true, `at=${fine}`);
  }
  const bad = createEnforcementGate({ manifest: MANIFEST, host: createRecordingHost(), clock: () => 1.5 });
  await assert.rejects(bad.readEnv('LANG', {}), (error) => error.code === 'INVALID_GATE_CLOCK');
});
