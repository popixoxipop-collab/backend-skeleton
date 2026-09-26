import crypto from 'node:crypto';

const SHA256_RE = /^[a-f0-9]{64}$/;
const FAMILY_RE = /^[a-z][a-z0-9.-]*$/;
const MEDIA_TYPE_RE = /^[^\s/]+\/[^\s]+$/;
const ARTIFACT_REF_VERSION = 'sbf.artifact-ref/1';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) throw new TypeError(label + ' must be a plain JSON object');
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(label + ' must contain exactly: ' + wanted.join(', '));
  }
}

function bytesOf(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('artifact bytes must be a UTF-8 string, Buffer, or Uint8Array');
}

export function sha256Bytes(value) {
  return crypto.createHash('sha256').update(bytesOf(value)).digest('hex');
}

export function createT01ArtifactRef(bytes, {
  family,
  version,
  media_type = 'application/json',
} = {}) {
  const raw = bytesOf(bytes);
  if (typeof family !== 'string' || !FAMILY_RE.test(family)) {
    throw new TypeError('artifact family must be a lowercase stable identifier');
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new TypeError('artifact version must be a non-empty string');
  }
  if (typeof media_type !== 'string' || !MEDIA_TYPE_RE.test(media_type)) {
    throw new TypeError('artifact media_type must be a media type');
  }
  return {
    artifact_ref: ARTIFACT_REF_VERSION,
    family,
    version,
    media_type,
    byte_sha256: sha256Bytes(raw),
    size_bytes: raw.byteLength,
  };
}

export function assertT01ArtifactRef(ref) {
  exactKeys(
    ref,
    ['artifact_ref', 'family', 'version', 'media_type', 'byte_sha256', 'size_bytes'],
    'ArtifactRef',
  );
  if (ref.artifact_ref !== ARTIFACT_REF_VERSION) {
    throw new TypeError('unsupported artifact_ref: ' + String(ref.artifact_ref));
  }
  if (typeof ref.family !== 'string' || !FAMILY_RE.test(ref.family)) {
    throw new TypeError('ArtifactRef.family is invalid');
  }
  if (typeof ref.version !== 'string' || ref.version.length === 0) {
    throw new TypeError('ArtifactRef.version must be a non-empty string');
  }
  if (typeof ref.media_type !== 'string' || !MEDIA_TYPE_RE.test(ref.media_type)) {
    throw new TypeError('ArtifactRef.media_type is invalid');
  }
  if (typeof ref.byte_sha256 !== 'string' || !SHA256_RE.test(ref.byte_sha256)) {
    throw new TypeError('ArtifactRef.byte_sha256 is invalid');
  }
  if (!Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 0) {
    throw new TypeError('ArtifactRef.size_bytes must be a non-negative safe integer');
  }
  return ref;
}

export function artifactRefMatches(bytes, ref) {
  assertT01ArtifactRef(ref);
  const raw = bytesOf(bytes);
  return raw.byteLength === ref.size_bytes && sha256Bytes(raw) === ref.byte_sha256;
}

export function assertArtifactRefMatches(bytes, ref) {
  if (!artifactRefMatches(bytes, ref)) {
    throw new TypeError('artifact bytes do not match ArtifactRef');
  }
  return ref;
}

export function artifactEvidenceRef(ref) {
  assertT01ArtifactRef(ref);
  return ref.byte_sha256;
}
