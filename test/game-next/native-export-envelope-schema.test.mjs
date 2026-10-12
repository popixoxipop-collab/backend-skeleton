import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  NATIVE_EXPORT_ENVELOPE_REVISION,
  NATIVE_EXPORT_ENVELOPE_SCHEMA,
  createNativeExportEnvelope,
  createNativeSourceRef,
  verifyNativeExportEnvelope,
} from '../../adapters/game-next/native-export-envelope.mjs';
import {
  buildGodotTextSceneExport,
  buildUnityTextSceneExport,
} from '../../adapters/game-next/native-text-source-exporters.mjs';
import { normalizeNativeStructureExport } from '../../adapters/game-next/native-structure-normalizer.mjs';

// T17-02: the JSON Schema of the native export envelope against the code that builds and verifies it.
// Every verdict below is computed by running ajv and the real functions; the lists of differences are asserted, not described.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_FILE = path.join(ROOT, 'adapters', 'game-next', 'native-export-envelope.schema.json');
const schemaDoc = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
const compile = (doc) => new Ajv2020({ allErrors: true, strict: true }).compile(doc);
const validateSchema = compile(schemaDoc);

const producer = { id: 't17-schema-test', version: '0-draft', implementation_sha256: 'a'.repeat(64) };
const bytes = (text) => Buffer.from(text, 'utf8');
const json = (value) => bytes(JSON.stringify(value));
const UNITY_TEXT = bytes([
  '%YAML 1.1',
  '%TAG !u! tag:unity3d.com,2011:',
  '--- !u!1 &6',
  'GameObject:',
  '  m_Name: Hero',
  '--- !u!4 &8',
  'Transform:',
  '  m_GameObject: {fileID: 6}',
  '  m_Father: {fileID: 0}',
  '',
].join('\n'));
const GODOT_TEXT = bytes([
  '[gd_scene load_steps=2 format=3]',
  '',
  '[ext_resource type="Script" path="res://player.gd" id="1"]',
  '[node name="Main" type="Node3D"]',
  '[node name="Player" type="CharacterBody3D" parent="."]',
  'script = ExtResource("1")',
  '[connection signal="hit" from="Player" to="." method="_on_hit"]',
  '',
].join('\n'));
const UNREAL_PAYLOAD = json({
  schema: 'sbf.game-unreal-structure-export/draft-1',
  types: [{
    id: 'Hero',
    kind: 'class',
    name: 'AHero',
    properties: [{ name: 'Health', type: 'float', specifiers: ['Replicated'] }],
    functions: [{ name: 'Fire', specifiers: ['Server', 'Reliable'] }],
  }],
});
const UNITY_PAYLOAD = json({ schema: 'sbf.game-unity-serialized-export/draft-1', documents: [{ file_id: '6', class_id: 1, name: 'Hero' }] });
const GODOT_PAYLOAD = json({ schema: 'sbf.game-godot-scene-export/draft-1', scenes: [{ path: 'scenes/main.tscn', nodes: [{ path: 'Main', name: 'Main', type: 'Node3D' }] }] });

const common = { engineVersion: 'test-1', platform: 'test-platform', producer };
const HEADER_SOURCE = bytes('class AHero {};\n');
const YAML_SOURCE = bytes('hero: true\n');

// Real envelopes: two from the exporters, the rest from the builder with every engine / evidence class pair the code accepts.
function samples() {
  const unity = buildUnityTextSceneExport(UNITY_TEXT, { path: 'Assets/Scenes/Main.unity', ...common });
  const godot = buildGodotTextSceneExport(GODOT_TEXT, { path: 'scenes/main.tscn', ...common });
  const refs = (list) => list.map(([source, options]) => createNativeSourceRef(source, options));
  const withInputs = (payload, engine, evidenceClass, list) => {
    const sourceInputs = refs(list);
    return {
      envelope: createNativeExportEnvelope(payload, { engine, evidenceClass, ...common, sourceInputs }),
      payload,
      sourceInputBytes: Object.fromEntries(list.map(([source, options]) => [options.path, source])),
    };
  };
  return [
    { name: 'unity text exporter (source-export)', envelope: unity.envelope, payload: unity.payload_bytes, sourceInputBytes: { 'Assets/Scenes/Main.unity': UNITY_TEXT }, normalizable: true },
    { name: 'godot text exporter (source-export)', envelope: godot.envelope, payload: godot.payload_bytes, sourceInputBytes: { 'scenes/main.tscn': GODOT_TEXT }, normalizable: true },
    { name: 'unreal editor-export without source inputs', envelope: createNativeExportEnvelope(UNREAL_PAYLOAD, { engine: 'unreal', evidenceClass: 'editor-export', ...common }), payload: UNREAL_PAYLOAD, sourceInputBytes: {}, normalizable: true },
    { name: 'unity editor-export with two source inputs of different roles', ...withInputs(UNITY_PAYLOAD, 'unity', 'editor-export', [
      [UNITY_TEXT, { path: 'Assets/Scenes/Main.unity', role: 'reference' }],
      [YAML_SOURCE, { path: 'Assets/Config/game.yaml', role: 'generated', mediaType: 'application/x-yaml' }],
    ]), normalizable: true },
    { name: 'godot headless-export', envelope: createNativeExportEnvelope(GODOT_PAYLOAD, { engine: 'godot', evidenceClass: 'headless-export', ...common }), payload: GODOT_PAYLOAD, sourceInputBytes: {}, normalizable: true },
    { name: 'unreal source-export (no Unreal source exporter exists)', ...withInputs(UNREAL_PAYLOAD, 'unreal', 'source-export', [[HEADER_SOURCE, { path: 'Source/Game/Hero.h' }]]), normalizable: true },
    { name: 'payload without a schema property', envelope: createNativeExportEnvelope(json({ hello: 1 }), { engine: 'unity', evidenceClass: 'editor-export', ...common }), payload: json({ hello: 1 }), sourceInputBytes: {}, normalizable: false },
  ];
}

const BASE = (() => {
  const built = buildGodotTextSceneExport(GODOT_TEXT, { path: 'scenes/main.tscn', ...common });
  return built.envelope;
})();
const other = (hex) => (hex[0] === 'f' ? '0' : 'f') + hex.slice(1);

// [name, damage, schema verdict, code verdict (verifyNativeExportEnvelope without bytes), an error token the code must report]
const CASES = [
  ['unchanged envelope', () => {}, true, true, null],
  ['schema string changed', (e) => { e.schema = 'sbf.game-native-export-envelope/draft-2'; }, false, false, 'schema'],
  ['envelope_revision 1', (e) => { e.envelope_revision = 1; }, false, false, 'envelope_revision'],
  ['status interpreted', (e) => { e.status = 'interpreted'; }, false, false, 'status'],
  ['unknown engine', (e) => { e.engine = 'cryengine'; }, false, false, 'engine-profile'],
  ['engine missing', (e) => { delete e.engine; }, false, false, 'engine-profile'],
  ['evidence class missing', (e) => { delete e.evidence_class; }, false, false, 'engine-profile'],
  ['unknown evidence class', (e) => { e.evidence_class = 'runtime-trace'; }, false, false, 'engine-profile'],
  ['godot with editor-export', (e) => { e.evidence_class = 'editor-export'; }, false, false, 'engine-profile'],
  ['unity with headless-export', (e) => { e.engine = 'unity'; e.evidence_class = 'headless-export'; }, false, false, 'engine-profile'],
  ['unreal with headless-export', (e) => { e.engine = 'unreal'; e.evidence_class = 'headless-export'; }, false, false, 'engine-profile'],
  ['source-export without source inputs', (e) => { e.source_inputs = []; }, false, false, 'source_inputs.required'],
  ['claim producer_identity_verified true', (e) => { e.claims.producer_identity_verified = true; }, false, false, 'claims.producer_identity_verified'],
  ['claim runtime_behavior_verified true', (e) => { e.claims.runtime_behavior_verified = true; }, false, false, 'claims.runtime_behavior_verified'],
  ['claim causal_edges_verified true', (e) => { e.claims.causal_edges_verified = true; }, false, false, 'claims.causal_edges_verified'],
  ['claim state_transitions_verified true', (e) => { e.claims.state_transitions_verified = true; }, false, false, 'claims.state_transitions_verified'],
  ['claim given as the string false', (e) => { e.claims.runtime_behavior_verified = 'false'; }, false, false, 'claims.runtime_behavior_verified'],
  ['claim null', (e) => { e.claims.runtime_behavior_verified = null; }, false, false, 'claims.runtime_behavior_verified'],
  ['claim deleted', (e) => { delete e.claims.causal_edges_verified; }, false, false, 'claims.causal_edges_verified'],
  ['claims deleted', (e) => { delete e.claims; }, false, false, 'claims.producer_identity_verified'],
  ['artifact deleted (identity missing)', (e) => { delete e.artifact; }, false, false, 'artifact'],
  ['artifact byte_sha256 deleted (identity missing)', (e) => { delete e.artifact.byte_sha256; }, false, false, 'artifact'],
  ['artifact byte_sha256 upper case', (e) => { e.artifact.byte_sha256 = e.artifact.byte_sha256.toUpperCase(); }, false, false, 'artifact'],
  ['artifact byte_sha256 too short', (e) => { e.artifact.byte_sha256 = e.artifact.byte_sha256.slice(1); }, false, false, 'artifact'],
  ['artifact size negative', (e) => { e.artifact.size_bytes = -1; }, false, false, 'artifact'],
  ['artifact size fractional', (e) => { e.artifact.size_bytes = 1.5; }, false, false, 'artifact'],
  ['artifact size beyond the safe integer range', (e) => { e.artifact.size_bytes = 2 ** 53; }, false, false, 'artifact'],
  ['artifact media type text/plain', (e) => { e.artifact.media_type = 'text/plain'; }, false, false, 'artifact'],
  ['artifact family of a source', (e) => { e.artifact.family = 'game-native-source'; }, false, false, 'artifact'],
  ['artifact version draft-2', (e) => { e.artifact.version = 'draft-2'; }, false, false, 'artifact'],
  ['artifact_ref changed', (e) => { e.artifact.artifact_ref = 'sbf.artifact-ref/2'; }, false, false, 'artifact'],
  ['artifact extra property', (e) => { e.artifact.extra = 1; }, false, false, 'artifact'],
  ['producer deleted (identity missing)', (e) => { delete e.producer; }, false, false, 'producer'],
  ['producer id empty', (e) => { e.producer.id = ''; }, false, false, 'producer'],
  ['producer version deleted', (e) => { delete e.producer.version; }, false, false, 'producer'],
  ['producer digest not hexadecimal', (e) => { e.producer.implementation_sha256 = 'z'.repeat(64); }, false, false, 'producer'],
  ['producer extra property', (e) => { e.producer.extra = 'x'; }, false, false, 'producer'],
  ['source_inputs deleted', (e) => { delete e.source_inputs; }, false, false, 'source_inputs'],
  ['source_inputs is an object', (e) => { e.source_inputs = {}; }, false, false, 'source_inputs'],
  ['source path with a parent segment', (e) => { e.source_inputs[0].path = '../main.tscn'; }, false, false, 'source_inputs'],
  ['source path absolute', (e) => { e.source_inputs[0].path = '/scenes/main.tscn'; }, false, false, 'source_inputs'],
  ['source path with a backslash', (e) => { e.source_inputs[0].path = 'scenes\\main.tscn'; }, false, false, 'source_inputs'],
  ['source path with a drive prefix', (e) => { e.source_inputs[0].path = 'C:/scenes/main.tscn'; }, false, false, 'source_inputs'],
  ['source role unknown', (e) => { e.source_inputs[0].role = 'main'; }, false, false, 'source_inputs'],
  ['source media type with a space after the semicolon', (e) => { e.source_inputs[0].artifact.media_type = 'text/plain; charset=utf-8'; }, false, false, 'source_inputs'],
  ['source media type without a slash', (e) => { e.source_inputs[0].artifact.media_type = 'plain'; }, false, false, 'source_inputs'],
  ['source artifact family of an export', (e) => { e.source_inputs[0].artifact.family = 'game-native-export'; }, false, false, 'source_inputs'],
  ['source artifact digest invalid', (e) => { e.source_inputs[0].artifact.byte_sha256 = 'abc'; }, false, false, 'source_inputs'],
  ['source input extra property', (e) => { e.source_inputs[0].extra = 1; }, false, false, 'source_inputs'],
  ['source artifact extra property', (e) => { e.source_inputs[0].artifact.extra = 1; }, false, false, 'source_inputs'],
  // The schema is stricter: the code verifier does not look at these.
  ['top-level extra property', (e) => { e.extra = 1; }, false, true, null],
  ['claims extra property false', (e) => { e.claims.source_structure_verified = false; }, false, true, null],
  ['claims extra property true', (e) => { e.claims.extra_claim_verified = true; }, false, true, null],
  ['engine_version deleted', (e) => { delete e.engine_version; }, false, true, null],
  ['engine_version empty', (e) => { e.engine_version = ''; }, false, true, null],
  ['platform not a string', (e) => { e.platform = 5; }, false, true, null],
  ['payload_descriptor deleted', (e) => { delete e.payload_descriptor; }, false, true, null],
  ['payload_descriptor declared_schema a number', (e) => { e.payload_descriptor.declared_schema = 5; }, false, true, null],
  ['payload_descriptor top_level_keys with a duplicate', (e) => { e.payload_descriptor.top_level_keys = ['scenes', 'scenes']; }, false, true, null],
  ['payload_descriptor extra property', (e) => { e.payload_descriptor.extra = 1; }, false, true, null],
  // The schema is looser: it cannot express that source input paths are unique.
  ['duplicate source input path', (e) => { const twin = structuredClone(e.source_inputs[0]); twin.artifact.byte_sha256 = other(twin.artifact.byte_sha256); e.source_inputs.push(twin); }, true, false, 'source_inputs'],
  // Neither looks at the bytes or at the payload: shape-only checks accept a lie that is well formed.
  ['artifact digest of other bytes', (e) => { e.artifact.byte_sha256 = other(e.artifact.byte_sha256); }, true, true, null],
  ['source digest of other bytes', (e) => { e.source_inputs[0].artifact.byte_sha256 = other(e.source_inputs[0].artifact.byte_sha256); }, true, true, null],
  ['payload_descriptor describes another payload', (e) => { e.payload_descriptor = { declared_schema: 'sbf.other/1', top_level_keys: ['other'] }; }, true, true, null],
  ['source inputs not sorted by path', (e) => { const first = structuredClone(e.source_inputs[0]); first.path = 'scenes/a.tscn'; e.source_inputs.unshift(structuredClone(e.source_inputs[0])); e.source_inputs[1] = first; }, true, true, null],
];

// Names of the cases in which the schema and the code disagree: this list is the statement of where the schema is stricter or looser.
const STRICTER = [
  'top-level extra property',
  'claims extra property false',
  'claims extra property true',
  'engine_version deleted',
  'engine_version empty',
  'platform not a string',
  'payload_descriptor deleted',
  'payload_descriptor declared_schema a number',
  'payload_descriptor top_level_keys with a duplicate',
  'payload_descriptor extra property',
];
const LOOSER = ['duplicate source input path'];

function caseProblems(validate, verify = (envelope) => verifyNativeExportEnvelope(envelope)) {
  const out = [];
  for (const [name, damage, schemaOk, codeOk, token] of CASES) {
    const envelope = structuredClone(BASE);
    damage(envelope);
    const schemaVerdict = validate(envelope);
    const code = verify(envelope);
    if (schemaVerdict !== schemaOk) out.push(`${name}: the schema says ${schemaVerdict}, expected ${schemaOk}`);
    if (code.valid !== codeOk) out.push(`${name}: the code says ${code.valid}, expected ${codeOk}`);
    if (token && !code.errors.includes(token)) out.push(`${name}: the code errors ${JSON.stringify(code.errors)} lack ${token}`);
  }
  return out;
}

test('T17-02 the schema compiles in ajv strict mode and carries the identity of the code', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  assert.equal(ajv.validateSchema(schemaDoc), true);
  assert.equal(typeof ajv.compile(schemaDoc), 'function');
  assert.equal(schemaDoc.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.match(schemaDoc.$id, /^urn:sbf:[a-z0-9-]+:draft-1$/);
  assert.equal(schemaDoc.properties.schema.const, NATIVE_EXPORT_ENVELOPE_SCHEMA);
  assert.equal(schemaDoc.properties.envelope_revision.const, NATIVE_EXPORT_ENVELOPE_REVISION);
  assert.equal(schemaDoc.additionalProperties, false);
  // The required list and the property list are the key list of a real envelope, in the same order.
  assert.deepEqual(schemaDoc.required, Object.keys(BASE));
  assert.deepEqual(Object.keys(schemaDoc.properties), Object.keys(BASE));
  for (const [name, def] of [['producer', BASE.producer], ['export_artifact', BASE.artifact], ['source_artifact', BASE.source_inputs[0].artifact], ['source_input', BASE.source_inputs[0]], ['payload_descriptor', BASE.payload_descriptor], ['claims', BASE.claims]]) {
    assert.deepEqual(schemaDoc.$defs[name].required, Object.keys(def), name);
    assert.deepEqual(Object.keys(schemaDoc.$defs[name].properties), Object.keys(def), name);
    assert.equal(schemaDoc.$defs[name].additionalProperties, false, name);
  }
  // The description names what the file cannot do, so a reader does not take it for a verification.
  assert.match(schemaDoc.$defs.payload_descriptor.description, /^Not authoritative\./);
  assert.match(schemaDoc.properties.status.description, /not a support, runtime or correctness status/);
});

test('T17-02 real envelopes of the builder and both exporters validate under the schema and under the code', () => {
  const all = samples();
  assert.equal(all.length, 7);
  for (const sample of all) {
    for (const [label, envelope] of [['as built', sample.envelope], ['after a JSON round trip', JSON.parse(JSON.stringify(sample.envelope))]]) {
      assert.equal(validateSchema(envelope), true, `${sample.name} ${label}: ${JSON.stringify(validateSchema.errors)}`);
      assert.deepEqual(verifyNativeExportEnvelope(envelope), { valid: true, errors: [] }, `${sample.name} ${label}`);
      assert.deepEqual(verifyNativeExportEnvelope(envelope, { sourceBytes: sample.payload, sourceInputBytes: sample.sourceInputBytes }), { valid: true, errors: [] }, `${sample.name} ${label} with bytes`);
    }
    if (sample.normalizable) assert.equal(normalizeNativeStructureExport(sample.payload, sample.envelope).status, 'declared-structure-only', sample.name);
  }
  // The engine / evidence class pairs, the sort order of source inputs and the descriptor of a payload without a schema are all in the samples.
  assert.deepEqual(all.map((s) => [s.envelope.engine, s.envelope.evidence_class]), [
    ['unity', 'source-export'], ['godot', 'source-export'], ['unreal', 'editor-export'], ['unity', 'editor-export'], ['godot', 'headless-export'], ['unreal', 'source-export'], ['unity', 'editor-export'],
  ]);
  assert.deepEqual(all[3].envelope.source_inputs.map((i) => [i.path, i.role, i.artifact.media_type]), [['Assets/Config/game.yaml', 'generated', 'application/x-yaml'], ['Assets/Scenes/Main.unity', 'reference', 'text/plain']]);
  assert.deepEqual(all[6].envelope.payload_descriptor, { declared_schema: null, top_level_keys: ['hello'] });
  // A valid envelope is not a promise about the payload: the normalizer still refuses a payload that is no accepted profile.
  assert.throws(() => normalizeNativeStructureExport(all[6].payload, all[6].envelope), /native structure schema mismatch: expected sbf\.game-unity-serialized-export\/draft-1, got undefined/);
});

test('T17-02 hand-damaged envelopes: every case gets the stated verdict from the schema and from the code', () => {
  assert.deepEqual(caseProblems(validateSchema), []);
  // The four damages named by the audit, each rejected by both: unknown engine, a claim set to true, missing identity, an extra property where the code looks.
  const names = new Set(CASES.map(([name]) => name));
  for (const name of ['unknown engine', 'claim causal_edges_verified true', 'artifact deleted (identity missing)', 'producer deleted (identity missing)', 'artifact extra property', 'producer extra property', 'source input extra property']) {
    const [, , schemaOk, codeOk] = CASES.find(([n]) => n === name);
    assert.deepEqual([names.has(name), schemaOk, codeOk], [true, false, false], name);
  }
  assert.equal(CASES.length, new Set(CASES.map(([name]) => name)).size, 'case names are unique');
});

test('T17-02 the schema is stricter than the code in exactly these cases and looser in exactly this one', () => {
  const stricter = CASES.filter(([, , schemaOk, codeOk]) => !schemaOk && codeOk).map(([name]) => name);
  const looser = CASES.filter(([, , schemaOk, codeOk]) => schemaOk && !codeOk).map(([name]) => name);
  assert.deepEqual(stricter, STRICTER);
  assert.deepEqual(looser, LOOSER);
  // Re-run from scratch rather than from the table: the verdict pairs are the real ones.
  for (const name of STRICTER) {
    const [, damage] = CASES.find(([n]) => n === name);
    const envelope = structuredClone(BASE);
    damage(envelope);
    assert.deepEqual([validateSchema(envelope), verifyNativeExportEnvelope(envelope).valid], [false, true], name);
  }
  const twin = structuredClone(BASE);
  CASES.find(([n]) => n === LOOSER[0])[1](twin);
  assert.deepEqual([validateSchema(twin), verifyNativeExportEnvelope(twin).valid], [true, false]);
  assert.throws(() => createNativeExportEnvelope(GODOT_PAYLOAD, { engine: 'godot', evidenceClass: 'source-export', ...common, sourceInputs: [twin.source_inputs[0], twin.source_inputs[1]] }), /duplicate source input path: scenes\/main\.tscn/);
});

test('T17-02 byte identity is checked by the code only, and only when bytes are passed', () => {
  const built = buildGodotTextSceneExport(GODOT_TEXT, { path: 'scenes/main.tscn', ...common });
  const lie = structuredClone(built.envelope);
  lie.artifact.byte_sha256 = other(lie.artifact.byte_sha256);
  lie.source_inputs[0].artifact.byte_sha256 = other(lie.source_inputs[0].artifact.byte_sha256);
  // Without bytes the code is as blind as the schema.
  assert.deepEqual([validateSchema(lie), verifyNativeExportEnvelope(lie).valid], [true, true]);
  // With the real bytes the code finds both lies; the schema has nothing to compare.
  assert.deepEqual(verifyNativeExportEnvelope(lie, { sourceBytes: built.payload_bytes, sourceInputBytes: { 'scenes/main.tscn': GODOT_TEXT } }), {
    valid: false,
    errors: ['artifact-bytes', 'source_input_bytes.mismatch:scenes/main.tscn'],
  });
  assert.deepEqual(verifyNativeExportEnvelope(built.envelope, { sourceInputBytes: {} }), { valid: false, errors: ['source_input_bytes.missing:scenes/main.tscn'] });
  assert.deepEqual(verifyNativeExportEnvelope(built.envelope, { sourceBytes: bytes('{}') }), { valid: false, errors: ['artifact-bytes'] });
  assert.deepEqual(verifyNativeExportEnvelope(built.envelope, { sourceInputBytes: [] }), { valid: false, errors: ['source_input_bytes'] });
});

test('T17-02 engines, evidence classes, roles, paths and media types: schema, builder and verifier accept the same values', () => {
  // Engine x evidence class: the allOf rules of the schema against the builder and against the verifier, over the whole matrix.
  const engines = [...schemaDoc.properties.engine.enum, 'cryengine', ''];
  const classes = [...schemaDoc.properties.evidence_class.enum, 'runtime-trace', ''];
  const accepted = [];
  for (const engine of engines) {
    for (const evidenceClass of classes) {
      const envelope = structuredClone(BASE);
      envelope.engine = engine;
      envelope.evidence_class = evidenceClass;
      let built;
      try {
        createNativeExportEnvelope(GODOT_PAYLOAD, { engine, evidenceClass, ...common, sourceInputs: evidenceClass === 'source-export' ? BASE.source_inputs : [] });
        built = true;
      } catch {
        built = false;
      }
      const verdicts = [validateSchema(envelope), verifyNativeExportEnvelope(envelope).valid, built];
      assert.deepEqual(verdicts, [verdicts[0], verdicts[0], verdicts[0]], `${engine} / ${evidenceClass}: schema, verifier, builder`);
      if (verdicts[0]) accepted.push(`${engine}/${evidenceClass}`);
    }
  }
  assert.deepEqual(accepted, ['unreal/source-export', 'unreal/editor-export', 'unity/source-export', 'unity/editor-export', 'godot/source-export', 'godot/headless-export']);

  const viaSource = (patch) => {
    const envelope = structuredClone(BASE);
    Object.assign(envelope.source_inputs[0], patch.input ?? {});
    Object.assign(envelope.source_inputs[0].artifact, patch.artifact ?? {});
    const options = { path: envelope.source_inputs[0].path, role: envelope.source_inputs[0].role, mediaType: envelope.source_inputs[0].artifact.media_type, ...(patch.options ?? {}) };
    let built = true;
    try {
      createNativeSourceRef(GODOT_TEXT, options);
    } catch {
      built = false;
    }
    return [validateSchema(envelope), verifyNativeExportEnvelope(envelope).valid, built];
  };
  const agree = (label, verdicts) => assert.equal(new Set(verdicts).size, 1, `${label}: schema, verifier and builder disagree ${JSON.stringify(verdicts)}`);
  const roles = [...schemaDoc.$defs.source_input.properties.role.enum, 'main', '', 'ACTIVE'];
  const rolesAccepted = roles.filter((role) => { const v = viaSource({ input: { role } }); agree(`role ${JSON.stringify(role)}`, v); return v[0]; });
  assert.deepEqual(rolesAccepted, ['active', 'reference', 'generated', 'vendor', 'template']);
  const paths = ['a', 'a/b', 'Assets/Scenes/Main.unity', 'a b/c d', 'ünï/ß', '.hidden', '...', '..x', 'a/.b/c', 'C:', 'C:x', '/a', 'a//b', 'a/./b', 'a/../b', '..', '.', './a', 'a/', 'a/.', 'C:/x', 'c:/x', 'a\\b', 'a\0b', ''];
  const pathsAccepted = paths.filter((p) => { const v = viaSource({ input: { path: p } }); agree(`path ${JSON.stringify(p)}`, v); return v[0]; });
  assert.deepEqual(pathsAccepted, ['a', 'a/b', 'Assets/Scenes/Main.unity', 'a b/c d', 'ünï/ß', '.hidden', '...', '..x', 'a/.b/c', 'C:', 'C:x']);
  const mediaTypes = ['text/plain', 'application/x-yaml', 'a/b/c', 'text//plain', 'text/plain;charset=utf-8', 'text', 'text/', '/plain', 'text/plain; charset=utf-8', ' text/plain', 'text/pla in', 'text/plain\n', ''];
  const mediaAccepted = mediaTypes.filter((mediaType) => { const v = viaSource({ artifact: { media_type: mediaType } }); agree(`media type ${JSON.stringify(mediaType)}`, v); return v[0]; });
  assert.deepEqual(mediaAccepted, ['text/plain', 'application/x-yaml', 'a/b/c', 'text//plain', 'text/plain;charset=utf-8']);
  // The description of media_type is held to these verdicts: for every media type with a parameter it says what the three of them decide.
  // It is white space that is rejected, so a parameter written without white space is accepted; the earlier wording said the opposite.
  const withParameter = mediaTypes.filter((mediaType) => mediaType.includes(';'));
  assert.equal(withParameter.length, 2);
  const describes = (description) => withParameter.every((mediaType) => description.includes(`${mediaType} is ${mediaAccepted.includes(mediaType) ? 'accepted' : 'rejected'}`));
  assert.ok(describes(schemaDoc.$defs.media_type.description), `the description of media_type must say what the verdicts are: ${schemaDoc.$defs.media_type.description}`);
  assert.equal(describes('type/subtype without white space, the rule of the code (parameters and a missing slash are rejected).'), false, 'the earlier wording is reported');
  // The digest and the size rules of the two artifact shapes.
  for (const value of ['0'.repeat(64), 'f'.repeat(64), 'F'.repeat(64), '0'.repeat(63), '0'.repeat(65), 'g'.repeat(64), '']) {
    const envelope = structuredClone(BASE);
    envelope.artifact.byte_sha256 = value;
    agree(`digest ${value}`, [validateSchema(envelope), verifyNativeExportEnvelope(envelope).valid]);
  }
  for (const value of [0, 1, 2 ** 31, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, -1, 1.5, '1', null, NaN]) {
    const envelope = structuredClone(BASE);
    envelope.artifact.size_bytes = value;
    agree(`size ${String(value)}`, [validateSchema(envelope), verifyNativeExportEnvelope(envelope).valid]);
  }
});

test('T17-02 the builder can not emit an unknown engine, a true claim, an extra property or a malformed identity', () => {
  const build = (options, source = GODOT_PAYLOAD) => createNativeExportEnvelope(source, { engine: 'godot', evidenceClass: 'headless-export', ...common, ...options });
  assert.throws(() => build({ engine: 'cryengine' }), /unsupported native engine: cryengine/);
  assert.throws(() => build({ evidenceClass: 'editor-export' }), /unsupported evidence class for godot: editor-export/);
  assert.throws(() => build({ evidenceClass: 'source-export' }), /source-export requires at least one exact source input/);
  assert.throws(() => build({ producer: { ...producer, extra: 1 } }), /producer contains unsupported fields: extra/);
  assert.throws(() => build({ producer: { ...producer, implementation_sha256: 'xyz' } }), /producer\.implementation_sha256 must be a SHA-256 hex digest/);
  assert.throws(() => build({ engineVersion: '' }), /engineVersion must be a non-empty string/);
  assert.throws(() => build({ platform: undefined }), /platform must be a non-empty string/);
  assert.throws(() => build({}, bytes('[]')), /native export JSON must be a top-level object/);
  assert.throws(() => build({}, bytes('{')), /native export bytes must contain valid JSON/);
  assert.throws(() => build({ maxBytes: 4 }), /native export exceeds byte budget: \d+ > 4/);
  // Options that look like the envelope's own fields are not read: claims and status can not be set from outside.
  const forced = build({ claims: { producer_identity_verified: true, runtime_behavior_verified: true, causal_edges_verified: true, state_transitions_verified: true }, status: 'verified', extra: 1 });
  assert.deepEqual(forced.claims, { producer_identity_verified: false, runtime_behavior_verified: false, causal_edges_verified: false, state_transitions_verified: false });
  assert.equal(forced.status, 'bound-uninterpreted');
  assert.equal(validateSchema(forced), true);
  assert.deepEqual(Object.keys(forced), schemaDoc.required);
  // Every sample the builder makes has claims that are all false and a descriptor that only repeats the payload.
  for (const sample of samples()) {
    assert.ok(Object.values(sample.envelope.claims).every((claim) => claim === false), sample.name);
    assert.deepEqual(Object.keys(sample.envelope.payload_descriptor), ['declared_schema', 'top_level_keys'], sample.name);
    assert.deepEqual(sample.envelope.payload_descriptor.top_level_keys, Object.keys(JSON.parse(sample.payload.toString('utf8'))).sort(), sample.name);
  }
});

test('T17-02 negative: a damaged copy of the schema, or a code validator that accepts everything, fails the same checks', () => {
  const damaged = (edit) => {
    const copy = structuredClone(schemaDoc);
    edit(copy);
    return caseProblems(compile(copy)).join('\n');
  };
  const rows = [
    [(s) => { delete s.additionalProperties; }, /top-level extra property/],
    [(s) => { s.$defs.claims.properties.causal_edges_verified = { type: 'boolean' }; }, /claim causal_edges_verified true/],
    [(s) => { s.$defs.claims.properties.producer_identity_verified = { const: true }; }, /unchanged envelope/],
    [(s) => { s.properties.engine.enum.push('cryengine'); }, /unknown engine/],
    [(s) => { s.allOf.splice(0, 1); }, /godot with editor-export/],
    [(s) => { s.allOf.splice(1, 1); }, /unity with headless-export/],
    [(s) => { s.allOf.splice(2, 1); }, /source-export without source inputs/],
    [(s) => { s.required = s.required.filter((key) => key !== 'artifact'); }, /artifact deleted/],
    [(s) => { s.required = s.required.filter((key) => key !== 'engine_version'); }, /engine_version deleted/],
    [(s) => { s.$defs.sha256.pattern = '^.*$'; }, /artifact byte_sha256 too short/],
    [(s) => { s.$defs.portable_path.pattern = '^.*$'; }, /source path with a parent segment/],
    [(s) => { s.$defs.media_type.pattern = '^.*$'; }, /source media type without a slash/],
    [(s) => { s.$defs.producer.additionalProperties = true; }, /producer extra property/],
    [(s) => { s.$defs.export_artifact.properties.media_type = { type: 'string' }; }, /artifact media type text\/plain/],
    [(s) => { s.$defs.payload_descriptor.properties.top_level_keys.uniqueItems = false; }, /top_level_keys with a duplicate/],
    [(s) => { s.properties.status = { type: 'string' }; }, /status interpreted/],
    [(s) => { s.properties.envelope_revision = { type: 'integer' }; }, /envelope_revision 1/],
  ];
  for (const [edit, pattern] of rows) assert.match(damaged(edit), pattern, String(edit));
  // The code side of the comparison: a verifier that accepts everything differs from the stated verdicts in many cases.
  const blind = caseProblems(validateSchema, () => ({ valid: true, errors: [] }));
  assert.ok(blind.length >= 40, `a blind verifier is reported ${blind.length} times`);
  assert.match(blind.join('\n'), /unknown engine: the code says true/);
  // A schema that rejects everything differs from the stated verdicts as well.
  const closed = caseProblems(() => false);
  assert.match(closed.join('\n'), /unchanged envelope: the schema says false/);
  assert.ok(closed.length >= 5);
});
