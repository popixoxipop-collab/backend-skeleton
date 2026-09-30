import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGodotTextSceneExport } from '../../adapters/game-next/native-text-source-exporters.mjs';
import {
  createNativeExportEnvelope,
  createNativeSourceRef,
  verifyNativeExportEnvelope,
} from '../../adapters/game-next/native-export-envelope.mjs';
import {
  normalizeNativeStructureExport,
  verifyNativeStructureInvariants,
} from '../../adapters/game-next/native-structure-normalizer.mjs';

const producer = {
  id: 't17-media-type-test',
  version: '0-draft',
  implementation_sha256: '6'.repeat(64),
};
const SOURCE_PATH = 'game/main.tscn';
const SOURCE_INPUT_ERROR = [`source_inputs.artifact:${SOURCE_PATH}`];
const scene = Buffer.from([
  '[gd_scene format=3]',
  '[node name="Main" type="Node3D"]',
  '',
].join('\n'), 'utf8');

const built = buildGodotTextSceneExport(scene, {
  path: SOURCE_PATH,
  engineVersion: '4-test',
  platform: 'source-only',
  producer,
});
const normalizedBase = normalizeNativeStructureExport(built.payload_bytes, built.envelope);

function invariantsWithMediaType(mediaType) {
  const value = structuredClone(normalizedBase);
  value.source_inputs[0].artifact.media_type = mediaType;
  return verifyNativeStructureInvariants(value);
}

function envelopeAcceptsMediaType(mediaType) {
  try {
    createNativeSourceRef(scene, { path: SOURCE_PATH, mediaType });
    return true;
  } catch (error) {
    if (error instanceof TypeError && /media type/.test(error.message)) return false;
    throw error;
  }
}

const ACCEPTED = [
  'application/json',
  'text/x-godot-scene',
  'application/vnd.api+json',
  'image/svg+xml',
  'image/png',
  'text/plain',
  'text/yaml',
];

const REJECTED = [
  ['space in subtype', 'text/plain x'],
  ['space in type', 'te xt/plain'],
  ['leading space', ' text/plain'],
  ['tab', 'text/plain\tx'],
  ['trailing newline', 'text/plain\n'],
  ['non-breaking space', 'text/pl\u00a0ain'],
  ['parameter after a space', 'text/plain; charset=utf-8'],
  ['no slash', 'textplain'],
  ['empty subtype', 'text/'],
  ['empty type', '/plain'],
  ['empty string', ''],
];

test('the exporter-produced normalized structure passes the invariant check before any mutation', () => {
  assert.deepEqual(verifyNativeStructureInvariants(normalizedBase), { valid: true, errors: [] });
  assert.equal(normalizedBase.source_inputs[0].artifact.media_type, 'text/plain');
});

test('an envelope-valid source input keeps its media type through normalization and invariants', () => {
  for (const mediaType of ['application/json', 'text/x-godot-scene']) {
    const sourceRef = createNativeSourceRef(scene, { path: SOURCE_PATH, mediaType });
    const envelope = createNativeExportEnvelope(built.payload_bytes, {
      engine: 'godot',
      evidenceClass: 'source-export',
      engineVersion: '4-test',
      platform: 'source-only',
      producer,
      sourceInputs: [sourceRef],
    });
    assert.deepEqual(verifyNativeExportEnvelope(envelope, {
      sourceBytes: built.payload_bytes,
      sourceInputBytes: { [SOURCE_PATH]: scene },
    }), { valid: true, errors: [] }, `envelope ${mediaType}`);

    const normalized = normalizeNativeStructureExport(built.payload_bytes, envelope);
    assert.equal(normalized.source_inputs[0].artifact.media_type, mediaType);
    assert.deepEqual(verifyNativeStructureInvariants(normalized), { valid: true, errors: [] }, `invariants ${mediaType}`);
  }
});

test('well-formed media types are accepted, including ones that contain the letter s', () => {
  for (const mediaType of ACCEPTED) {
    assert.deepEqual(invariantsWithMediaType(mediaType), { valid: true, errors: [] }, mediaType);
  }
});

test('media types with whitespace, no slash, or an empty part are rejected', () => {
  for (const [label, mediaType] of REJECTED) {
    assert.deepEqual(
      invariantsWithMediaType(mediaType),
      { valid: false, errors: SOURCE_INPUT_ERROR },
      `${label}: ${JSON.stringify(mediaType)}`,
    );
  }
});

test('non-string media types are rejected', () => {
  for (const mediaType of [null, undefined, 42, {}, ['text/plain']]) {
    assert.deepEqual(
      invariantsWithMediaType(mediaType),
      { valid: false, errors: SOURCE_INPUT_ERROR },
      Object.prototype.toString.call(mediaType),
    );
  }
});

test('the invariant check accepts exactly the media types the envelope constructor accepts', () => {
  const probes = [
    ...ACCEPTED,
    ...REJECTED.map(([, mediaType]) => mediaType),
    'text/plain;charset=utf-8',
    'a/b/c',
    'text//plain',
    'text/pl\\ain',
    'text/pl\u0000ain',
  ];
  for (const mediaType of probes) {
    assert.equal(
      invariantsWithMediaType(mediaType).valid,
      envelopeAcceptsMediaType(mediaType),
      JSON.stringify(mediaType),
    );
  }
});
