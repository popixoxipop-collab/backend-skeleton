import { createHash } from 'node:crypto';

export const ARTIFACT_REF_SCHEMA = 'sbf.artifact-ref/1';
const SHA256_RE = /^[a-f0-9]{64}$/;
const FAMILY_RE = /^[a-z][a-z0-9.-]*$/;
const MEDIA_TYPE_RE = /^[^\s/]+\/[^\s]+$/;

function toBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('artifact bytes must be a string, Buffer, or Uint8Array');
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unexpected.length) throw new TypeError(`${label} contains unsupported fields: ${unexpected.join(', ')}`);
}

export function assertSimulationArtifactRef(ref, {
  family,
  version,
  mediaType,
} = {}) {
  exactKeys(ref, [
    'artifact_ref',
    'family',
    'version',
    'media_type',
    'byte_sha256',
    'size_bytes',
  ], 'ArtifactRef');

  if (ref.artifact_ref !== ARTIFACT_REF_SCHEMA) throw new TypeError('ArtifactRef.artifact_ref is invalid');
  if (typeof ref.family !== 'string' || !FAMILY_RE.test(ref.family)) throw new TypeError('ArtifactRef.family is invalid');
  if (typeof ref.version !== 'string' || !ref.version) throw new TypeError('ArtifactRef.version is invalid');
  if (typeof ref.media_type !== 'string' || !MEDIA_TYPE_RE.test(ref.media_type)) throw new TypeError('ArtifactRef.media_type is invalid');
  if (typeof ref.byte_sha256 !== 'string' || !SHA256_RE.test(ref.byte_sha256)) throw new TypeError('ArtifactRef.byte_sha256 is invalid');
  if (!Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 0) throw new TypeError('ArtifactRef.size_bytes is invalid');

  if (family !== undefined && ref.family !== family) throw new TypeError(`ArtifactRef.family must be ${family}`);
  if (version !== undefined && ref.version !== version) throw new TypeError(`ArtifactRef.version must be ${version}`);
  if (mediaType !== undefined && ref.media_type !== mediaType) throw new TypeError(`ArtifactRef.media_type must be ${mediaType}`);

  return Object.freeze({ ...ref });
}

export function simulationArtifactRefForBytes(bytes, {
  family,
  version = 'draft-1',
  mediaType,
}) {
  const raw = toBytes(bytes);
  const ref = {
    artifact_ref: ARTIFACT_REF_SCHEMA,
    family,
    version,
    media_type: mediaType,
    byte_sha256: createHash('sha256').update(raw).digest('hex'),
    size_bytes: raw.byteLength,
  };
  return assertSimulationArtifactRef(ref);
}

export function assertSimulationArtifactRefMatchesBytes(ref, bytes, expected = {}) {
  const normalized = assertSimulationArtifactRef(ref, expected);
  const raw = toBytes(bytes);
  const digest = createHash('sha256').update(raw).digest('hex');
  if (normalized.byte_sha256 !== digest || normalized.size_bytes !== raw.byteLength) {
    throw new Error('ArtifactRef does not match exact artifact bytes');
  }
  return normalized;
}
