import { createHash } from 'node:crypto';

export const ARTIFACT_REF_VERSION = 'sbf.artifact-ref/1';
export const SIMULATION_ITEM_REF_VERSION = 'sbf.simulation-item-ref/draft-1';

const SHA256_RE = /^[a-f0-9]{64}$/;
const FAMILY_RE = /^[a-z][a-z0-9.-]*$/;
const MEDIA_TYPE_RE = /^[^\s/]+\/[^\s]+$/;
const ITEM_KINDS = new Set(['body','prim','joint','actuator','drive','sensor','collider','geom','assertion-channel']);
const RESOLVABLE_ITEM_KINDS = new Set(['body','prim','joint','actuator','drive','sensor','collider','geom']);

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

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function boundedId(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
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

export function assertSimulationItemRefShape(ref) {
  exactKeys(ref, ['simulation_item_ref','contract_artifact','item_kind','item_id'], 'SimulationItemRef');
  if (ref.simulation_item_ref !== SIMULATION_ITEM_REF_VERSION) {
    throw new TypeError('SimulationItemRef version is invalid');
  }
  const artifact = assertArtifactRef(ref.contract_artifact, {
    family: 'simulation-contract',
    version: 'draft-1',
  });
  if (!ITEM_KINDS.has(ref.item_kind)) {
    throw new TypeError(`unsupported simulation item kind: ${String(ref.item_kind)}`);
  }
  boundedId(ref.item_id, 'SimulationItemRef.item_id');
  return Object.freeze({
    simulation_item_ref: ref.simulation_item_ref,
    contract_artifact: artifact,
    item_kind: ref.item_kind,
    item_id: ref.item_id,
  });
}

function parseContract(contractBytes) {
  const raw = bytes(contractBytes);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new TypeError('simulation contract bytes must be valid UTF-8');
  }

  let contract;
  try {
    contract = JSON.parse(text);
  } catch {
    throw new TypeError('simulation contract bytes must contain valid JSON');
  }

  plain(contract, 'simulation contract');
  exactKeys(contract, [
    'simulation_contract',
    'identity',
    'source_inputs',
    'model',
    'mapping',
    'coordinates',
    'units',
    'timing',
    'physics',
    'support',
    'provenance',
  ], 'simulation contract');

  if (contract.simulation_contract !== 'sbf.simulation-contract/draft-1') {
    throw new TypeError('simulation contract version is invalid');
  }

  const identity = plain(contract.identity, 'simulation contract identity');
  exactKeys(identity, ['target','repository','revision','contract_id'], 'simulation contract identity');
  if (!['SIM-mujoco','SIM-isaacsim'].includes(identity.target)) {
    throw new TypeError('simulation contract identity.target is invalid');
  }
  for (const key of ['repository','revision','contract_id']) {
    boundedId(identity[key], `simulation contract identity.${key}`);
  }

  if (!Array.isArray(contract.source_inputs) || contract.source_inputs.length === 0) {
    throw new TypeError('simulation contract source_inputs must be a non-empty array');
  }
  const sourceRoles = new Set(['active','reference','generated','vendor','template']);
  for (const [index, input] of contract.source_inputs.entries()) {
    plain(input, `simulation contract source_inputs[${index}]`);
    exactKeys(input, ['path','role','artifact'], `simulation contract source_inputs[${index}]`);
    boundedId(input.path, `simulation contract source_inputs[${index}].path`);
    if (!sourceRoles.has(input.role)) {
      throw new TypeError(`simulation contract source_inputs[${index}].role is invalid`);
    }
    assertArtifactRef(input.artifact);
  }

  const model = plain(contract.model, 'simulation contract model');
  exactKeys(model, ['entities','joints','actuators','sensors','colliders'], 'simulation contract model');
  for (const key of ['entities','joints','actuators','sensors','colliders']) {
    if (!Array.isArray(model[key])) {
      throw new TypeError(`simulation contract model.${key} must be an array`);
    }
  }

  const mapping = plain(contract.mapping, 'simulation contract mapping');
  exactKeys(mapping, ['state_channels','action_channels'], 'simulation contract mapping');
  for (const key of ['state_channels','action_channels']) {
    if (!Array.isArray(mapping[key])) {
      throw new TypeError(`simulation contract mapping.${key} must be an array`);
    }
  }

  const coordinates = plain(contract.coordinates, 'simulation contract coordinates');
  exactKeys(coordinates, ['world_frame','up_axis','handedness','quaternion_order'], 'simulation contract coordinates');
  boundedId(coordinates.world_frame, 'simulation contract coordinates.world_frame');
  if (!['X','Y','Z'].includes(coordinates.up_axis)) {
    throw new TypeError('simulation contract coordinates.up_axis is invalid');
  }
  if (!['left','right'].includes(coordinates.handedness)) {
    throw new TypeError('simulation contract coordinates.handedness is invalid');
  }
  if (!['wxyz','xyzw'].includes(coordinates.quaternion_order)) {
    throw new TypeError('simulation contract coordinates.quaternion_order is invalid');
  }

  const units = plain(contract.units, 'simulation contract units');
  exactKeys(units, ['length','angle','force','torque','time'], 'simulation contract units');
  const requiredUnits = { length:'m', angle:'rad', force:'N', torque:'N*m', time:'s' };
  for (const [key, expected] of Object.entries(requiredUnits)) {
    if (units[key] !== expected) {
      throw new TypeError(`simulation contract units.${key} is invalid; expected ${expected}`);
    }
  }

  const timing = plain(contract.timing, 'simulation contract timing');
  exactKeys(timing, ['physics_dt','control_dt','decimation','render_dt'], 'simulation contract timing');
  for (const key of ['physics_dt','control_dt']) {
    if (typeof timing[key] !== 'number' || !Number.isFinite(timing[key]) || timing[key] <= 0) {
      throw new TypeError(`simulation contract timing.${key} must be a positive finite number`);
    }
  }
  if (!Number.isSafeInteger(timing.decimation) || timing.decimation <= 0) {
    throw new TypeError('simulation contract timing.decimation must be a positive safe integer');
  }
  if (timing.render_dt !== null &&
      (typeof timing.render_dt !== 'number' || !Number.isFinite(timing.render_dt) || timing.render_dt <= 0)) {
    throw new TypeError('simulation contract timing.render_dt must be null or a positive finite number');
  }

  const physics = plain(contract.physics, 'simulation contract physics');
  if (typeof physics.backend !== 'string' || physics.backend.length === 0) {
    throw new TypeError('simulation contract physics.backend is required');
  }

  const support = plain(contract.support, 'simulation contract support');
  exactKeys(support, ['capabilities','certification','release_approved'], 'simulation contract support');
  plain(support.capabilities, 'simulation contract support.capabilities');
  const certification = plain(support.certification, 'simulation contract support.certification');
  exactKeys(certification, ['discovery','contract','runtime_tested'], 'simulation contract support.certification');
  for (const key of ['discovery','contract','runtime_tested']) {
    if (!['not-certified','certified'].includes(certification[key])) {
      throw new TypeError(`simulation contract support.certification.${key} is invalid`);
    }
  }
  if (support.release_approved !== false) {
    throw new TypeError('simulation contract support.release_approved must be false in draft-1');
  }

  plain(contract.provenance, 'simulation contract provenance');
  return contract;
}

function contractItemEntries(contract) {
  const model = contract.model;
  const entries = [];

  for (const [index, item] of model.entities.entries()) {
    plain(item, `model.entities[${index}]`);
    boundedId(item.id, `model.entities[${index}].id`);
    if (item.kind !== 'body' && item.kind !== 'prim') {
      throw new TypeError(`model.entities[${index}].kind must be body or prim`);
    }
    entries.push({ id: item.id, kind: item.kind });
  }

  for (const [collection, defaultKind, allowedKinds] of [
    ['joints', 'joint', new Set(['joint'])],
    ['actuators', 'actuator', new Set(['actuator','drive'])],
    ['sensors', 'sensor', new Set(['sensor'])],
    ['colliders', 'collider', new Set(['collider','geom'])],
  ]) {
    for (const [index, item] of model[collection].entries()) {
      plain(item, `model.${collection}[${index}]`);
      boundedId(item.id, `model.${collection}[${index}].id`);
      const kind = item.kind ?? defaultKind;
      if (!allowedKinds.has(kind)) {
        throw new TypeError(`model.${collection}[${index}].kind is invalid for authoritative item binding`);
      }
      entries.push({ id: item.id, kind });
    }
  }

  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new TypeError(`simulation contract contains duplicate item identity: ${entry.id}`);
    }
    seen.add(entry.id);
  }
  return entries;
}

export function resolveSimulationItemRef(ref, { contractBytes } = {}) {
  const shaped = assertSimulationItemRefShape(ref);
  if (contractBytes === undefined) {
    throw new TypeError('authoritative SimulationItemRef requires exact contractBytes; use assertSimulationItemRefShape() for syntax-only validation');
  }
  assertArtifactRefMatchesBytes(shaped.contract_artifact, contractBytes);
  if (!RESOLVABLE_ITEM_KINDS.has(shaped.item_kind)) {
    throw new TypeError(`authoritative SimulationItemRef kind ${shaped.item_kind} is not resolvable in draft-1`);
  }

  const contract = parseContract(contractBytes);
  const matches = contractItemEntries(contract).filter((item) => item.id === shaped.item_id);
  if (matches.length === 0) {
    throw new TypeError(`SimulationItemRef item identity not found in bound contract: ${shaped.item_id}`);
  }
  if (matches.length !== 1) {
    throw new TypeError(`SimulationItemRef item identity is ambiguous in bound contract: ${shaped.item_id}`);
  }
  if (matches[0].kind !== shaped.item_kind) {
    throw new TypeError(`SimulationItemRef item kind mismatch: ref=${shaped.item_kind}, contract=${matches[0].kind}`);
  }

  return Object.freeze({
    ...shaped,
    authoritative: true,
  });
}

export function assertSimulationItemRef(ref, options = {}) {
  return resolveSimulationItemRef(ref, options);
}
