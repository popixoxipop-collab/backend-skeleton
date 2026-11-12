import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createNativeExportEnvelope,
  createNativeSourceRef,
  verifyNativeExportEnvelope,
} from '../../adapters/game-next/native-export-envelope.mjs';
import {
  normalizeNativeStructureExport,
  verifyNativeStructureInvariants,
} from '../../adapters/game-next/native-structure-normalizer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const corpus = JSON.parse(fs.readFileSync(path.join(root, 'test/corpus-next/negative-vectors.json')));
const vectors = Array.isArray(corpus) ? corpus : corpus.vectors;
const gameVectors = vectors.filter(({ id }) => id.startsWith('NEG-GAME-'));
const schema = 'sbf.game-unreal-structure-export/draft-1';
const producer = {
  id: 't17-adversarial-hand-authored', version: '1-test-only', implementation_sha256: 'a'.repeat(64),
};
const base = () => ({ schema, types: [{
  id: 'HeroA', kind: 'class', name: 'Hero', base: 'AActor',
  properties: [{ name: 'Speed', type: 'float', specifiers: [] }],
  functions: [{ name: 'OnJump', specifiers: [] }],
}] });
const bytes = (value) => Buffer.from(JSON.stringify(value));
const options = (version = '5.8.4') => ({
  engine: 'unreal', evidenceClass: 'editor-export', engineVersion: version,
  platform: 'test-only', producer,
});
const bound = (value = base(), version = '5.8.4') => {
  const raw = bytes(value);
  return { raw, envelope: createNativeExportEnvelope(raw, options(version)) };
};
const normalized = (value = base(), version = '5.8.4') => {
  const { raw, envelope } = bound(value, version);
  return normalizeNativeStructureExport(raw, envelope);
};
const falseClaims = (record) => {
  assert.ok(Object.values(record.claims).length >= 4);
  for (const value of Object.values(record.claims)) assert.equal(value, false);
};

test('T19 game negative corpus has exactly the seven adjudicated vectors', () => {
  assert.deepEqual(gameVectors.map(({ id }) => id), [
    'NEG-GAME-01', 'NEG-GAME-02', 'NEG-GAME-03', 'NEG-GAME-04',
    'NEG-GAME-05', 'NEG-GAME-06', 'NEG-GAME-07',
  ]);
  assert.deepEqual(gameVectors.map(({ expected }) => expected), [
    'preserve-unknown', 'reject', 'preserve-unknown', 'preserve-unknown',
    'preserve-unknown', 'preserve-unknown', 'reject',
  ]);
});

test('NEG-GAME-01: nearby input and movement names never become a causal edge', () => {
  const result = normalized();
  assert.ok(result.nodes.some((node) => node.name === 'Speed'));
  assert.ok(result.nodes.some((node) => node.name === 'OnJump'));
  assert.equal(result.relations.some((edge) => /causal|behavior|transition/.test(edge.kind)), false);
  assert.equal(result.claims.causal_edges_verified, false);
  assert.equal(result.claims.state_transitions_verified, false);
});

test('NEG-GAME-02: candidate self-certification is rejected at the intake boundary', () => {
  assert.equal(fs.existsSync(path.join(root, 'adapters/game-next/legacy-webgame-bridge.mjs')), false);
  const { raw, envelope } = bound();
  const candidate = structuredClone(envelope);
  candidate.claims.runtime_behavior_verified = true;
  assert.deepEqual(verifyNativeExportEnvelope(candidate, { sourceBytes: raw }), {
    valid: false, errors: ['claims.runtime_behavior_verified'],
  });
  assert.throws(() => normalizeNativeStructureExport(raw, candidate), /envelope invalid/);
  assert.throws(() => normalized({ ...base(), candidate_reported_pass: true }),
    /unsupported fields: candidate_reported_pass/);
});

test('NEG-GAME-03: duplicate display names keep distinct local identities', () => {
  const value = base();
  value.types.push({ id: 'HeroB', kind: 'class', name: 'Hero' });
  const result = normalized(value);
  assert.deepEqual(result.nodes.filter(({ name }) => name === 'Hero').map(({ id }) => id),
    ['unreal:type:HeroA', 'unreal:type:HeroB']);
  value.types[1].id = 'HeroA';
  assert.throws(() => normalized(value), /duplicate native node id/);
});

test('NEG-GAME-04: screenshot byte drift has no functional verdict in this data-only plane', () => {
  const rendererA = { screenshot_sha256: '1'.repeat(64), payload: base() };
  const rendererB = { screenshot_sha256: '2'.repeat(64), payload: base() };
  assert.notEqual(rendererA.screenshot_sha256, rendererB.screenshot_sha256);
  const a = normalized(rendererA.payload);
  const b = normalized(rendererB.payload);
  assert.deepEqual(a, b);
  falseClaims(a);
  const invented = { ...base(), screenshot_sha256: rendererA.screenshot_sha256 };
  assert.throws(() => normalized(invented), /unsupported fields: screenshot_sha256/);
});

test('NEG-GAME-05: timing and seed changes never certify deterministic simulation', () => {
  const traceA = { delta_seconds: 0.016, seed: 1, payload: base() };
  const traceB = { delta_seconds: 0.033, seed: 2, payload: base() };
  assert.notDeepEqual([traceA.delta_seconds, traceA.seed], [traceB.delta_seconds, traceB.seed]);
  assert.deepEqual(normalized(traceA.payload), normalized(traceB.payload));
  const invented = { ...base(), deterministic_runtime: true };
  assert.throws(() => normalized(invented), /unsupported fields: deterministic_runtime/);
  assert.equal(normalized().claims.runtime_behavior_verified, false);
});

test('NEG-GAME-06: source-only reflection cannot assert Blueprint/editor absence', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root,
    'adapters/game/unreal/fixtures/declared-reflection.json')));
  const result = normalized(fixture);
  assert.equal(result.nodes.some(({ name }) => /Blueprint|BP_/.test(name ?? '')), false);
  assert.equal(result.claims.source_structure_verified, false);
  const invented = { ...fixture, blueprint_absent: true };
  assert.throws(() => normalized(invented), /unsupported fields: blueprint_absent/);
});

test('NEG-GAME-07: a changed asset source identity invalidates its exact binding', () => {
  const oldSource = Buffer.from('AssetGuid=11111111111111111111111111111111\n');
  const newSource = Buffer.from('AssetGuid=22222222222222222222222222222222\n');
  const sourcePath = 'Content/Hero.asset.txt';
  const raw = bytes(base());
  const envelope = createNativeExportEnvelope(raw, {
    ...options(), evidenceClass: 'source-export',
    sourceInputs: [createNativeSourceRef(oldSource, { path: sourcePath })],
  });
  assert.deepEqual(verifyNativeExportEnvelope(envelope, {
    sourceBytes: raw, sourceInputBytes: { [sourcePath]: newSource },
  }), { valid: false, errors: [`source_input_bytes.mismatch:${sourcePath}`] });
  const result = normalizeNativeStructureExport(raw, envelope);
  falseClaims(result);
  assert.equal(Object.hasOwn(result, 'asset_registry_identity'), false);
});

test('mutation matrix kills changed bytes, claims, profile, extra fields and conflicting declarations', () => {
  const { raw, envelope } = bound();
  const badBytes = Buffer.from(raw.toString().replace('Speed', 'SpeedChanged'));
  assert.deepEqual(verifyNativeExportEnvelope(envelope, { sourceBytes: badBytes }),
    { valid: false, errors: ['artifact-bytes'] });
  assert.throws(() => normalizeNativeStructureExport(badBytes, envelope), /envelope invalid/);
  const badClaim = structuredClone(envelope);
  badClaim.claims.causal_edges_verified = true;
  assert.throws(() => normalizeNativeStructureExport(raw, badClaim), /envelope invalid/);
  const wrongProfile = structuredClone(envelope);
  wrongProfile.engine = 'unity';
  assert.throws(() => normalizeNativeStructureExport(raw, wrongProfile), /schema mismatch/);
  const extra = { ...base(), runtime_verified: true };
  assert.throws(() => normalized(extra), /unsupported fields: runtime_verified/);
  const rpc = base();
  rpc.types[0].functions[0].specifiers = ['Server', 'Client'];
  assert.throws(() => normalized(rpc), /conflicting Unreal RPC modes/);
  const replication = base();
  replication.types[0].properties[0].specifiers = ['Replicated', 'NotReplicated'];
  assert.throws(() => normalized(replication), /conflicting Unreal replication specifiers/);
});

test('engine-version labels cannot establish compatibility or installed identity', () => {
  const old = bound(base(), '5.8.3');
  const current = bound(base(), '5.8.4');
  assert.notEqual(old.envelope.engine_version, current.envelope.engine_version);
  const oldResult = normalizeNativeStructureExport(old.raw, old.envelope);
  const newResult = normalizeNativeStructureExport(current.raw, current.envelope);
  assert.deepEqual(oldResult, newResult);
  assert.equal(Object.hasOwn(newResult, 'engine_version'), false);
  falseClaims(old.envelope);
  falseClaims(newResult);
  assert.throws(() => createNativeExportEnvelope(current.raw, options('')),
    /engineVersion must be a non-empty string/);
});

test('Node permission mode permits data-only intake but denies unrelated read, write and spawn', () => {
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { createNativeExportEnvelope } from './adapters/game-next/native-export-envelope.mjs';
    import { normalizeNativeStructureExport } from './adapters/game-next/native-structure-normalizer.mjs';
    assert.equal(process.permission.has('fs.write'), false);
    assert.equal(process.permission.has('fs.read', 'test/corpus-next/negative-vectors.json'), false);
    const payload = JSON.stringify({schema:'sbf.game-unreal-structure-export/draft-1',types:[]});
    const envelope = createNativeExportEnvelope(payload, {engine:'unreal',evidenceClass:'editor-export',engineVersion:'5.8.4',platform:'test-only',producer:{id:'p',version:'1',implementation_sha256:'a'.repeat(64)}});
    const result = normalizeNativeStructureExport(payload, envelope);
    assert.equal(result.claims.runtime_behavior_verified, false);
    assert.throws(() => fs.readFileSync('test/corpus-next/negative-vectors.json'), (e) => e.code === 'ERR_ACCESS_DENIED');
    let fd;
    try { fd = fs.openSync('adapters/game-next/INTERFACE_RFC.md', 'r+'); }
    catch (e) { assert.equal(e.code, 'ERR_ACCESS_DENIED'); }
    if (fd !== undefined) { fs.closeSync(fd); throw new Error('write access unexpectedly granted'); }
    let denied = false;
    try { denied = spawnSync(process.execPath, ['-e', '0']).error?.code === 'ERR_ACCESS_DENIED'; }
    catch (e) { denied = e.code === 'ERR_ACCESS_DENIED'; }
    assert.equal(denied, true);
  `;
  const run = spawnSync(process.execPath, [
    '--permission', '--allow-fs-read=./adapters/game-next', '--input-type=module', '-e', script,
  ], { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '');
});

test('the normalized structure remains internally valid after the adversarial controls', () => {
  assert.deepEqual(verifyNativeStructureInvariants(normalized()), { valid: true, errors: [] });
});
