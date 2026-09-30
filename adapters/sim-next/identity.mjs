import { createHash } from 'node:crypto';

export const ARTIFACT_REF_VERSION = 'sbf.artifact-ref/1';
export const SIMULATION_ITEM_REF_VERSION = 'sbf.simulation-item-ref/draft-1';

const SHA256_RE = /^[a-f0-9]{64}$/;
const FAMILY_RE = /^[a-z][a-z0-9.-]*$/;
const MEDIA_TYPE_RE = /^[^\s/]+\/[^\s]+$/;
const ITEM_KINDS = new Set(['body','prim','joint','actuator','drive','sensor','collider','geom','assertion-channel']);

function bytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('artifact bytes must be a string, Buffer, or Uint8Array');
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length) throw new TypeError(`${label} contains unsupported fields: ${unexpected.join(', ')}`);
  if (missing.length) throw new TypeError(`${label} is missing required fields: ${missing.join(', ')}`);
}

export function assertArtifactRef(ref, expected = {}) {
  exactKeys(ref, ['artifact_ref','family','version','media_type','byte_sha256','size_bytes'], 'ArtifactRef');
  if (ref.artifact_ref !== ARTIFACT_REF_VERSION) throw new TypeError('ArtifactRef.artifact_ref is invalid');
  if (!FAMILY_RE.test(ref.family)) throw new TypeError('ArtifactRef.family is invalid');
  if (typeof ref.version !== 'string' || !ref.version) throw new TypeError('ArtifactRef.version is invalid');
  if (!MEDIA_TYPE_RE.test(ref.media_type)) throw new TypeError('ArtifactRef.media_type is invalid');
  if (!SHA256_RE.test(ref.byte_sha256)) throw new TypeError('ArtifactRef.byte_sha256 is invalid');
  if (!Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 0) throw new TypeError('ArtifactRef.size_bytes is invalid');
  for (const [key, wanted] of Object.entries(expected)) {
    if (wanted !== undefined && ref[key] !== wanted) throw new TypeError(`ArtifactRef.${key} must be ${wanted}`);
  }
  return Object.freeze({ ...ref });
}

export function artifactRefForBytes(value, { family, version, mediaType }) {
  if (!FAMILY_RE.test(family ?? '')) throw new TypeError('family is invalid');
  if (typeof version !== 'string' || !version) throw new TypeError('version is required');
  if (!MEDIA_TYPE_RE.test(mediaType ?? '')) throw new TypeError('mediaType is invalid');
  const raw = bytes(value);
  return Object.freeze({
    artifact_ref: ARTIFACT_REF_VERSION,
    family,
    version,
    media_type: mediaType,
    byte_sha256: createHash('sha256').update(raw).digest('hex'),
    size_bytes: raw.byteLength,
  });
}

export function assertArtifactRefMatchesBytes(ref, value) {
  const normalized = assertArtifactRef(ref);
  const raw = bytes(value);
  const digest = createHash('sha256').update(raw).digest('hex');
  if (normalized.byte_sha256 !== digest || normalized.size_bytes !== raw.byteLength) {
    throw new Error('ArtifactRef does not match exact artifact bytes');
  }
  return normalized;
}

export function assertSimulationItemRef(ref, { contractBytes } = {}) {
  exactKeys(ref, ['simulation_item_ref','contract_artifact','item_kind','item_id'], 'SimulationItemRef');
  if (ref.simulation_item_ref !== SIMULATION_ITEM_REF_VERSION) throw new TypeError('SimulationItemRef version is invalid');
  const artifact = assertArtifactRef(ref.contract_artifact, { family: 'simulation-contract', version: 'draft-1' });
  if (contractBytes !== undefined) assertArtifactRefMatchesBytes(artifact, contractBytes);
  if (!ITEM_KINDS.has(ref.item_kind)) throw new TypeError(`unsupported simulation item kind: ${String(ref.item_kind)}`);
  if (typeof ref.item_id !== 'string' || !ref.item_id || /[\x00-\x1f]/.test(ref.item_id)) throw new TypeError('SimulationItemRef.item_id is invalid');
  return Object.freeze({
    simulation_item_ref: ref.simulation_item_ref,
    contract_artifact: artifact,
    item_kind: ref.item_kind,
    item_id: ref.item_id,
  });
}
