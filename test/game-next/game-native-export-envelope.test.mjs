import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeExportEnvelope,
  createNativeSourceRef,
  verifyNativeExportEnvelope,
} from '../../adapters/game-next/native-export-envelope.mjs';

const producer = {
  id: 't17-test-exporter',
  version: '0-draft',
  implementation_sha256: '1'.repeat(64),
};

function bytes(value, space = 0) {
  return Buffer.from(JSON.stringify(value, null, space) + '\n', 'utf8');
}

function sourceInput(path = 'Source/Test.txt', raw = Buffer.from('native source\n', 'utf8')) {
  return {
    raw,
    ref: createNativeSourceRef(raw, { path, role: 'active', mediaType: 'text/plain' }),
  };
}

test('binds exact Unreal editor-export bytes without interpreting gameplay', () => {
  const raw = bytes({ schema: 'example.unreal/1', actors: [{ name: 'Hero' }] }, 2);
  const envelope = createNativeExportEnvelope(raw, {
    engine: 'unreal',
    evidenceClass: 'editor-export',
    engineVersion: '5.x-test',
    platform: 'test-only',
    producer,
  });
  assert.equal(envelope.artifact.size_bytes, raw.byteLength);
  assert.equal(envelope.payload_descriptor.declared_schema, 'example.unreal/1');
  assert.deepEqual(envelope.claims, {
    producer_identity_verified: false,
    runtime_behavior_verified: false,
    causal_edges_verified: false,
    state_transitions_verified: false,
  });
  assert.deepEqual(verifyNativeExportEnvelope(envelope, { sourceBytes: raw }), { valid: true, errors: [] });
});

test('formatting-only bytes produce different native export artifacts', () => {
  const value = { schema: 'x', nodes: [1, 2] };
  const a = createNativeExportEnvelope(bytes(value, 0), {
    engine: 'unity', evidenceClass: 'editor-export', engineVersion: '6-test', platform: 'test', producer,
  });
  const b = createNativeExportEnvelope(bytes(value, 2), {
    engine: 'unity', evidenceClass: 'editor-export', engineVersion: '6-test', platform: 'test', producer,
  });
  assert.notEqual(a.artifact.byte_sha256, b.artifact.byte_sha256);
});

test('engine/profile allowlist prevents unsupported runtime claims', () => {
  assert.throws(() => createNativeExportEnvelope(bytes({}), {
    engine: 'unreal', evidenceClass: 'runtime-tested', engineVersion: '5', platform: 'x', producer,
  }), /unsupported evidence class/);
  assert.throws(() => createNativeExportEnvelope(bytes({}), {
    engine: 'unknown', evidenceClass: 'source-export', engineVersion: '1', platform: 'x', producer,
  }), /unsupported native engine/);
});

test('Godot headless export is accepted but editor-export is not', () => {
  assert.doesNotThrow(() => createNativeExportEnvelope(bytes({}), {
    engine: 'godot', evidenceClass: 'headless-export', engineVersion: '4-test', platform: 'x', producer,
  }));
  assert.throws(() => createNativeExportEnvelope(bytes({}), {
    engine: 'godot', evidenceClass: 'editor-export', engineVersion: '4-test', platform: 'x', producer,
  }), /unsupported evidence class/);
});

test('invalid UTF-8, malformed JSON and non-object JSON fail closed', () => {
  const input = sourceInput();
  const options = { engine: 'unreal', evidenceClass: 'source-export', engineVersion: '5', platform: 'x', producer, sourceInputs: [input.ref] };
  assert.throws(() => createNativeExportEnvelope(Buffer.from([0xff]), options), /valid UTF-8/);
  assert.throws(() => createNativeExportEnvelope(Buffer.from('{'), options), /valid JSON/);
  assert.throws(() => createNativeExportEnvelope(Buffer.from('[]'), options), /top-level object/);
});

test('byte budget fails before parsing oversized data', () => {
  const input = sourceInput();
  const options = {
    engine: 'unity', evidenceClass: 'source-export', engineVersion: '6', platform: 'x', producer, sourceInputs: [input.ref], maxBytes: 8,
  };
  assert.throws(() => createNativeExportEnvelope(Buffer.from('{"long":true}'), options), /byte budget/);
});

test('producer code identity must use exact SHA-256 syntax', () => {
  assert.throws(() => createNativeExportEnvelope(bytes({}), {
    engine: 'unreal',
    evidenceClass: 'source-export',
    engineVersion: '5',
    platform: 'x',
    producer: { ...producer, implementation_sha256: 'main' },
    sourceInputs: [sourceInput().ref],
  }), /SHA-256/);
});

test('mismatched source bytes and invented runtime claims are rejected', () => {
  const raw = bytes({ schema: 'x' });
  const input = sourceInput('Assets/Hero.prefab', Buffer.from('hero-source\n', 'utf8'));
  const envelope = createNativeExportEnvelope(raw, {
    engine: 'unity', evidenceClass: 'source-export', engineVersion: '6', platform: 'x', producer,
    sourceInputs: [input.ref],
  });
  envelope.claims.producer_identity_verified = true;
  envelope.claims.runtime_behavior_verified = true;
  const checked = verifyNativeExportEnvelope(envelope, { sourceBytes: bytes({ schema: 'y' }) });
  assert.equal(checked.valid, false);
  assert.ok(checked.errors.includes('artifact-bytes'));
  assert.ok(checked.errors.includes('claims.producer_identity_verified'));
  assert.ok(checked.errors.includes('claims.runtime_behavior_verified'));
});


test('source-export requires at least one exact native source input', () => {
  assert.throws(() => createNativeExportEnvelope(bytes({ schema: 'x' }), {
    engine: 'unity',
    evidenceClass: 'source-export',
    engineVersion: '6-test',
    platform: 'test',
    producer,
  }), /requires at least one exact source input/);
});

test('source input refs bind exact bytes and reject missing or changed source material', () => {
  const input = sourceInput('Assets/Hero.prefab', Buffer.from('hero-v1\n', 'utf8'));
  const raw = bytes({ schema: 'x' });
  const envelope = createNativeExportEnvelope(raw, {
    engine: 'unity',
    evidenceClass: 'source-export',
    engineVersion: '6-test',
    platform: 'test',
    producer,
    sourceInputs: [input.ref],
  });

  assert.deepEqual(verifyNativeExportEnvelope(envelope, {
    sourceBytes: raw,
    sourceInputBytes: { 'Assets/Hero.prefab': input.raw },
  }), { valid: true, errors: [] });

  const missing = verifyNativeExportEnvelope(envelope, {
    sourceBytes: raw,
    sourceInputBytes: {},
  });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.includes('source_input_bytes.missing:Assets/Hero.prefab'));

  const changed = verifyNativeExportEnvelope(envelope, {
    sourceBytes: raw,
    sourceInputBytes: { 'Assets/Hero.prefab': Buffer.from('hero-v2\n', 'utf8') },
  });
  assert.equal(changed.valid, false);
  assert.ok(changed.errors.includes('source_input_bytes.mismatch:Assets/Hero.prefab'));
});

test('source paths are portable repo-relative identities and duplicate paths fail closed', () => {
  for (const path of ['/abs/file', '../escape', 'A/../B', 'C:/root/file', 'dir\\file']) {
    assert.throws(() => createNativeSourceRef(Buffer.from('x'), { path }), /source path/);
  }
  const raw = bytes({ schema: 'x' });
  const ref = sourceInput('Assets/Hero.prefab').ref;
  assert.throws(() => createNativeExportEnvelope(raw, {
    engine: 'unity',
    evidenceClass: 'source-export',
    engineVersion: '6-test',
    platform: 'test',
    producer,
    sourceInputs: [ref, ref],
  }), /duplicate source input path/);
});

test('editor/headless exports may omit source inputs because their producer boundary is separately controlled', () => {
  const unreal = createNativeExportEnvelope(bytes({ schema: 'x' }), {
    engine: 'unreal', evidenceClass: 'editor-export', engineVersion: '5-test', platform: 'test', producer,
  });
  assert.deepEqual(unreal.source_inputs, []);
  const godot = createNativeExportEnvelope(bytes({ schema: 'x' }), {
    engine: 'godot', evidenceClass: 'headless-export', engineVersion: '4-test', platform: 'test', producer,
  });
  assert.deepEqual(godot.source_inputs, []);
});
