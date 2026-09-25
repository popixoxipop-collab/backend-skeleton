import { createHash } from 'node:crypto';

export const NATIVE_EXPORT_ENVELOPE_SCHEMA = 'sbf.game-native-export-envelope/draft-1';
export const NATIVE_EXPORT_ENVELOPE_REVISION = 1;

const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const ENGINE_PROFILES = Object.freeze({
  unreal: new Set(['source-export', 'editor-export']),
  unity: new Set(['source-export', 'editor-export']),
  godot: new Set(['source-export', 'headless-export']),
});
const SHA256_RE = /^[a-f0-9]{64}$/;

function toBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('native export bytes must be a UTF-8 string, Buffer, or Uint8Array');
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function parseJson(raw) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Error('native export bytes must be valid UTF-8');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('native export bytes must contain valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('native export JSON must be a top-level object');
  }
  return value;
}

function assertProducer(producer) {
  if (!producer || typeof producer !== 'object' || Array.isArray(producer)) {
    throw new TypeError('producer must be an object');
  }
  requireString(producer.id, 'producer.id');
  requireString(producer.version, 'producer.version');
  if (typeof producer.implementation_sha256 !== 'string' || !SHA256_RE.test(producer.implementation_sha256)) {
    throw new TypeError('producer.implementation_sha256 must be a SHA-256 hex digest');
  }
  return {
    id: producer.id,
    version: producer.version,
    implementation_sha256: producer.implementation_sha256,
  };
}

function artifact(raw) {
  return {
    artifact_ref: 'sbf.artifact-ref/1',
    family: 'game-native-export',
    version: 'draft-1',
    media_type: 'application/json',
    byte_sha256: createHash('sha256').update(raw).digest('hex'),
    size_bytes: raw.byteLength,
  };
}

function validateEngineProfile(engine, evidenceClass) {
  if (!Object.hasOwn(ENGINE_PROFILES, engine)) throw new TypeError(`unsupported native engine: ${engine}`);
  if (!ENGINE_PROFILES[engine].has(evidenceClass)) {
    throw new TypeError(`unsupported evidence class for ${engine}: ${evidenceClass}`);
  }
}

export function createNativeExportEnvelope(
  sourceBytes,
  { engine, evidenceClass, engineVersion, platform, producer, maxBytes = MAX_EXPORT_BYTES } = {},
) {
  requireString(engine, 'engine');
  requireString(evidenceClass, 'evidenceClass');
  requireString(engineVersion, 'engineVersion');
  requireString(platform, 'platform');
  validateEngineProfile(engine, evidenceClass);
  const safeProducer = assertProducer(producer);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');

  const raw = toBytes(sourceBytes);
  if (raw.byteLength > maxBytes) {
    throw new RangeError(`native export exceeds byte budget: ${raw.byteLength} > ${maxBytes}`);
  }
  const payload = parseJson(raw);

  return {
    schema: NATIVE_EXPORT_ENVELOPE_SCHEMA,
    envelope_revision: NATIVE_EXPORT_ENVELOPE_REVISION,
    status: 'bound-uninterpreted',
    engine,
    evidence_class: evidenceClass,
    engine_version: engineVersion,
    platform,
    producer: safeProducer,
    artifact: artifact(raw),
    payload_descriptor: {
      declared_schema: typeof payload.schema === 'string' ? payload.schema : null,
      top_level_keys: Object.keys(payload).sort(),
    },
    claims: {
      producer_identity_verified: false,
      runtime_behavior_verified: false,
      causal_edges_verified: false,
      state_transitions_verified: false,
    },
  };
}

export function verifyNativeExportEnvelope(envelope, { sourceBytes } = {}) {
  const errors = [];
  if (envelope?.schema !== NATIVE_EXPORT_ENVELOPE_SCHEMA) errors.push('schema');
  if (envelope?.status !== 'bound-uninterpreted') errors.push('status');

  try {
    validateEngineProfile(envelope?.engine, envelope?.evidence_class);
  } catch {
    errors.push('engine-profile');
  }
  try {
    assertProducer(envelope?.producer);
  } catch {
    errors.push('producer');
  }

  const a = envelope?.artifact;
  if (
    !a ||
    a.artifact_ref !== 'sbf.artifact-ref/1' ||
    a.family !== 'game-native-export' ||
    a.version !== 'draft-1' ||
    a.media_type !== 'application/json' ||
    !SHA256_RE.test(a.byte_sha256 ?? '') ||
    !Number.isSafeInteger(a.size_bytes) ||
    a.size_bytes < 0
  ) {
    errors.push('artifact');
  }

  if (envelope?.claims?.producer_identity_verified !== false) errors.push('claims.producer_identity_verified');
  if (envelope?.claims?.runtime_behavior_verified !== false) errors.push('claims.runtime_behavior_verified');
  if (envelope?.claims?.causal_edges_verified !== false) errors.push('claims.causal_edges_verified');
  if (envelope?.claims?.state_transitions_verified !== false) errors.push('claims.state_transitions_verified');

  if (sourceBytes !== undefined && a) {
    const raw = toBytes(sourceBytes);
    if (
      raw.byteLength !== a.size_bytes ||
      createHash('sha256').update(raw).digest('hex') !== a.byte_sha256
    ) {
      errors.push('artifact-bytes');
    }
  }
  return { valid: errors.length === 0, errors };
}
