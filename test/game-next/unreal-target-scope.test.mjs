import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
const target = path.join(root, 'adapters/game/unreal');
const pins = JSON.parse(fs.readFileSync(path.join(target, 'RELEASE_PINS.json'), 'utf8'));
const headerPath = 'Source/Game/ProbeActor.h';
const header = fs.readFileSync(path.join(target, 'fixtures/ProbeActor.h'));
const payloadBytes = fs.readFileSync(path.join(target, 'fixtures/declared-reflection.json'));
const payload = JSON.parse(payloadBytes);
const producer = {
  id: 't17-unreal-hand-authored-fixture',
  version: 'target-01-test-only',
  implementation_sha256: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
};
const envelope = (bytes = payloadBytes, sourceBytes = header) => createNativeExportEnvelope(bytes, {
  engine: 'unreal',
  evidenceClass: 'source-export',
  engineVersion: pins.unreal.hotfix_version,
  platform: 'test-only',
  producer,
  sourceInputs: [createNativeSourceRef(sourceBytes, { path: headerPath })],
});
const normalize = (value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return normalizeNativeStructureExport(bytes, envelope(bytes));
};

test('Unreal target-01 pins an official release series, never a verified engine or producer', () => {
  assert.equal(pins.schema, 'sbf.game-unreal-target-scope-pins/1');
  assert.equal(pins.scope, 'declared-reflection-target-01-only');
  assert.deepEqual([pins.unreal.release_series, pins.unreal.released_on,
    pins.unreal.hotfix_version, pins.unreal.hotfix_released_on],
  ['5.8', '2026-06-23', '5.8.4', '2026-10-20']);
  assert.equal(pins.unreal.announcement_url,
    'https://www.unrealengine.com/news/unreal-engine-5-8-is-now-available');
  assert.equal(pins.unreal.release_notes_url,
    'https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes');
  assert.equal(pins.unreal.hotfix_announcement_url,
    'https://forums.unrealengine.com/t/5-8-4-hotfix-released/2842775');
  for (const field of ['fixture_generated_by_pinned_engine', 'engine_executed',
    'exporter_implemented', 'runtime_certified', 'release_authorized']) assert.equal(pins[field], false);
  assert.deepEqual(fs.readdirSync(path.join(target, 'fixtures')).sort(),
    ['ProbeActor.h', 'declared-reflection.json']);
  const scope = fs.readFileSync(path.join(target, 'SCOPE.md'), 'utf8');
  for (const limit of ['no Unreal producer', 'not Engine-generated', 'Blueprint',
    'asset identity', 'caller declarations', 'GAME-unreal-02', 'GAME-unreal-03',
    'release=BLOCKED']) assert.ok(scope.toLowerCase().includes(limit.toLowerCase()), `missing scope limit: ${limit}`);
});

test('hand-authored reflection shape binds exact bytes but emits only declared facts', () => {
  assert.match(header.toString(), /UCLASS\(\)/);
  assert.match(header.toString(), /UPROPERTY\(ReplicatedUsing=OnRep_Health\)/);
  assert.match(header.toString(), /UFUNCTION\(Server, Reliable\)/);
  const bound = envelope();
  assert.equal(bound.engine, 'unreal');
  assert.equal(bound.engine_version, '5.8.4');
  assert.equal(bound.evidence_class, 'source-export');
  assert.equal(bound.status, 'bound-uninterpreted');
  assert.deepEqual(verifyNativeExportEnvelope(bound, {
    sourceBytes: payloadBytes,
    sourceInputBytes: { [headerPath]: header },
  }), { valid: true, errors: [] });
  const structure = normalizeNativeStructureExport(payloadBytes, bound);
  assert.deepEqual(verifyNativeStructureInvariants(structure), { valid: true, errors: [] });
  assert.equal(structure.status, 'declared-structure-only');
  assert.ok(structure.nodes.some((node) => node.id === 'unreal:type:AProbeActor' && node.kind === 'unreal-class'));
  assert.ok(structure.relations.some((edge) => edge.kind === 'declared-base' && edge.to_symbol === 'AActor'));
  assert.deepEqual(structure.declarations.replication.map(({ mode, notify, evidence }) =>
    [mode, notify, evidence]), [['ReplicatedUsing', 'OnRep_Health', 'declared-specifier']]);
  assert.deepEqual(structure.declarations.rpc.map(({ mode, reliability, evidence }) =>
    [mode, reliability, evidence]), [['Server', 'reliable', 'declared-specifier']]);
  for (const claim of Object.values(bound.claims)) assert.equal(claim, false);
  for (const claim of Object.values(structure.claims)) assert.equal(claim, false);
});

test('NEG-GAME-06: unexported Blueprint/editor content is unknown, not absent', () => {
  const structure = normalizeNativeStructureExport(payloadBytes, envelope());
  assert.equal(structure.nodes.some((node) => /Blueprint|BP_/.test(node.name ?? '')), false);
  assert.equal(structure.claims.source_structure_verified, false);
  assert.equal(structure.claims.runtime_behavior_verified, false);
  assert.equal(Object.hasOwn(structure, 'blueprint_inventory'), false);
  assert.equal(Object.hasOwn(structure, 'absence_verified'), false);
  const invented = structuredClone(payload);
  invented.blueprint_absent = true;
  assert.throws(() => normalize(invented), /unsupported fields: blueprint_absent/);
});

test('NEG-GAME-07: source identity drift invalidates binding; asset identity cannot be invented', () => {
  const changedHeader = Buffer.from(header.toString().replace('VisualAsset;', 'ChangedVisualAsset;'));
  assert.notDeepEqual(changedHeader, header);
  const bound = envelope();
  assert.deepEqual(verifyNativeExportEnvelope(bound, {
    sourceBytes: payloadBytes,
    sourceInputBytes: { [headerPath]: changedHeader },
  }), { valid: false, errors: [`source_input_bytes.mismatch:${headerPath}`] });
  const changedPayload = Buffer.from(payloadBytes.toString().replace('VisualAsset', 'ChangedVisualAsset'));
  assert.deepEqual(verifyNativeExportEnvelope(bound, {
    sourceBytes: changedPayload,
    sourceInputBytes: { [headerPath]: header },
  }), { valid: false, errors: ['artifact-bytes'] });
  const invented = structuredClone(payload);
  invented.types[0].properties[1].asset_guid = 'invented';
  assert.throws(() => normalize(invented), /unsupported fields: asset_guid/);
  const structure = normalizeNativeStructureExport(payloadBytes, bound);
  assert.equal(Object.hasOwn(structure.nodes.find((node) => node.name === 'VisualAsset'), 'asset_guid'), false);
});

test('conflicting network declarations and duplicate identities fail closed', () => {
  const replication = structuredClone(payload);
  replication.types[0].properties[0].specifiers.push('NotReplicated');
  assert.throws(() => normalize(replication), /conflicting Unreal replication specifiers/);
  const rpc = structuredClone(payload);
  rpc.types[0].functions[1].specifiers.push('Client');
  assert.throws(() => normalize(rpc), /conflicting Unreal RPC modes/);
  const duplicate = structuredClone(payload);
  duplicate.types.push(structuredClone(duplicate.types[0]));
  assert.throws(() => normalize(duplicate), /duplicate native node id/);
  assert.throws(() => createNativeExportEnvelope(payloadBytes, {
    engine: 'unreal', evidenceClass: 'headless-export', engineVersion: '5.8',
    platform: 'test-only', producer,
  }), /unsupported evidence class for unreal/);
});
