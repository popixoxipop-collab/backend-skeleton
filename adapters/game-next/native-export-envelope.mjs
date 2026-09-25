import { createHash } from 'node:crypto';

export const NATIVE_EXPORT_ENVELOPE_SCHEMA = 'sbf.game-native-export-envelope/draft-1';
export const NATIVE_EXPORT_ENVELOPE_REVISION = 2;

const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const ENGINE_PROFILES = Object.freeze({
  unreal: new Set(['source-export', 'editor-export']),
  unity: new Set(['source-export', 'editor-export']),
  godot: new Set(['source-export', 'headless-export']),
});
const SOURCE_ROLES = new Set(['active', 'reference', 'generated', 'vendor', 'template']);
const SHA256_RE = /^[a-f0-9]{64}$/;
const MEDIA_TYPE_RE = /^[^\s/]+\/[^\s]+$/;

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

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unexpected.length > 0) throw new TypeError(`${label} contains unsupported fields: ${unexpected.join(', ')}`);
}

function portablePath(value) {
  const p = requireString(value, 'source path');
  if (p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:\//.test(p)) {
    throw new TypeError('source path must be a repo-relative POSIX path');
  }
  const segments = p.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TypeError('source path must not contain empty, dot, or parent segments');
  }
  return p;
}

function requireMediaType(value) {
  const mediaType = requireString(value, 'media type');
  if (!MEDIA_TYPE_RE.test(mediaType)) throw new TypeError('media type is invalid');
  return mediaType;
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
  exactKeys(producer, ['id', 'version', 'implementation_sha256'], 'producer');
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

function exactArtifact(raw, { family, version, mediaType }) {
  return {
    artifact_ref: 'sbf.artifact-ref/1',
    family,
    version,
    media_type: requireMediaType(mediaType),
    byte_sha256: createHash('sha256').update(raw).digest('hex'),
    size_bytes: raw.byteLength,
  };
}

function assertArtifact(ref, { family, version, mediaType } = {}) {
  exactKeys(ref, ['artifact_ref', 'family', 'version', 'media_type', 'byte_sha256', 'size_bytes'], 'ArtifactRef');
  if (ref.artifact_ref !== 'sbf.artifact-ref/1') throw new TypeError('ArtifactRef.artifact_ref is invalid');
  if (family && ref.family !== family) throw new TypeError(`ArtifactRef.family must be ${family}`);
  if (version && ref.version !== version) throw new TypeError(`ArtifactRef.version must be ${version}`);
  if (mediaType && ref.media_type !== mediaType) throw new TypeError(`ArtifactRef.media_type must be ${mediaType}`);
  requireMediaType(ref.media_type);
  if (!SHA256_RE.test(ref.byte_sha256 ?? '')) throw new TypeError('ArtifactRef.byte_sha256 is invalid');
  if (!Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 0) throw new TypeError('ArtifactRef.size_bytes is invalid');
  return ref;
}

export function createNativeSourceRef(
  sourceBytes,
  { path, role = 'active', mediaType = 'text/plain' } = {},
) {
  const raw = toBytes(sourceBytes);
  const sourcePath = portablePath(path);
  if (!SOURCE_ROLES.has(role)) throw new TypeError(`unsupported source role: ${String(role)}`);
  return {
    path: sourcePath,
    role,
    artifact: exactArtifact(raw, {
      family: 'game-native-source',
      version: 'draft-1',
      mediaType,
    }),
  };
}

function assertSourceInput(input) {
  exactKeys(input, ['path', 'role', 'artifact'], 'source input');
  const path = portablePath(input.path);
  if (!SOURCE_ROLES.has(input.role)) throw new TypeError(`unsupported source role: ${String(input.role)}`);
  const artifact = assertArtifact(input.artifact, { family: 'game-native-source', version: 'draft-1' });
  return {
    path,
    role: input.role,
    artifact: { ...artifact },
  };
}

function normalizeSourceInputs(sourceInputs) {
  if (!Array.isArray(sourceInputs)) throw new TypeError('sourceInputs must be an array');
  const out = sourceInputs.map(assertSourceInput).sort((a, b) => a.path.localeCompare(b.path));
  for (let i = 1; i < out.length; i += 1) {
    if (out[i - 1].path === out[i].path) throw new TypeError(`duplicate source input path: ${out[i].path}`);
  }
  return out;
}

function validateEngineProfile(engine, evidenceClass) {
  if (!Object.hasOwn(ENGINE_PROFILES, engine)) throw new TypeError(`unsupported native engine: ${engine}`);
  if (!ENGINE_PROFILES[engine].has(evidenceClass)) {
    throw new TypeError(`unsupported evidence class for ${engine}: ${evidenceClass}`);
  }
}

export function createNativeExportEnvelope(
  sourceBytes,
  { engine, evidenceClass, engineVersion, platform, producer, sourceInputs = [], maxBytes = MAX_EXPORT_BYTES } = {},
) {
  requireString(engine, 'engine');
  requireString(evidenceClass, 'evidenceClass');
  requireString(engineVersion, 'engineVersion');
  requireString(platform, 'platform');
  validateEngineProfile(engine, evidenceClass);
  const safeProducer = assertProducer(producer);
  const safeSourceInputs = normalizeSourceInputs(sourceInputs);
  if (evidenceClass === 'source-export' && safeSourceInputs.length === 0) {
    throw new TypeError('source-export requires at least one exact source input');
  }
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
    source_inputs: safeSourceInputs,
    artifact: exactArtifact(raw, {
      family: 'game-native-export',
      version: 'draft-1',
      mediaType: 'application/json',
    }),
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

export function verifyNativeExportEnvelope(envelope, { sourceBytes, sourceInputBytes } = {}) {
  const errors = [];
  if (envelope?.schema !== NATIVE_EXPORT_ENVELOPE_SCHEMA) errors.push('schema');
  if (envelope?.envelope_revision !== NATIVE_EXPORT_ENVELOPE_REVISION) errors.push('envelope_revision');
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

  let safeSourceInputs = [];
  try {
    safeSourceInputs = normalizeSourceInputs(envelope?.source_inputs);
    if (envelope?.evidence_class === 'source-export' && safeSourceInputs.length === 0) {
      errors.push('source_inputs.required');
    }
  } catch {
    errors.push('source_inputs');
  }

  const a = envelope?.artifact;
  try {
    assertArtifact(a, { family: 'game-native-export', version: 'draft-1', mediaType: 'application/json' });
  } catch {
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

  if (sourceInputBytes !== undefined) {
    if (!sourceInputBytes || typeof sourceInputBytes !== 'object' || Array.isArray(sourceInputBytes)) {
      errors.push('source_input_bytes');
    } else {
      for (const input of safeSourceInputs) {
        if (!Object.hasOwn(sourceInputBytes, input.path)) {
          errors.push(`source_input_bytes.missing:${input.path}`);
          continue;
        }
        const raw = toBytes(sourceInputBytes[input.path]);
        if (
          raw.byteLength !== input.artifact.size_bytes ||
          createHash('sha256').update(raw).digest('hex') !== input.artifact.byte_sha256
        ) {
          errors.push(`source_input_bytes.mismatch:${input.path}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
