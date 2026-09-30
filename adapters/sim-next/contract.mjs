import {
  assertSimulationArtifactRef,
} from './artifact-ref.mjs';
import {
  SIM_CANONICAL_UNITS,
  assertCoordinateSystem,
  assertSimulationUnits,
  assertTiming,
} from './units.mjs';

export const SIMULATION_CONTRACT_SCHEMA = 'sbf.simulation-contract/draft-1';
export const SIMULATION_TARGETS = Object.freeze(['SIM-mujoco', 'SIM-isaacsim']);
export const SIM_CAPABILITY_STATUSES = Object.freeze([
  'supported',
  'partial',
  'unsupported',
  'unknown',
  'not-applicable',
]);

const SHA256_RE = /^[a-f0-9]{64}$/;
const SOURCE_ROLES = new Set(['active', 'reference', 'generated', 'vendor', 'template']);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unexpected.length) throw new TypeError(`${label} contains unsupported fields: ${unexpected.join(', ')}`);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function portablePath(value, label) {
  const path = requiredString(value, label);
  if (path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:\//.test(path)) {
    throw new TypeError(`${label} must be a repo-relative POSIX path`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError(`${label} must not contain empty, dot, or parent segments`);
  }
  return path;
}

function sourceInput(input) {
  exactKeys(input, ['path', 'role', 'artifact'], 'source input');
  const path = portablePath(input.path, 'source input.path');
  if (!SOURCE_ROLES.has(input.role)) throw new TypeError(`unsupported source role: ${String(input.role)}`);
  const artifact = assertSimulationArtifactRef(input.artifact, {
    family: 'simulation-source',
    version: 'draft-1',
  });
  return Object.freeze({ path, role: input.role, artifact });
}

function identity(value) {
  exactKeys(value, ['target', 'repository', 'revision', 'contract_id'], 'identity');
  if (!SIMULATION_TARGETS.includes(value.target)) throw new TypeError('identity.target is unsupported');
  return Object.freeze({
    target: value.target,
    repository: requiredString(value.repository, 'identity.repository'),
    revision: requiredString(value.revision, 'identity.revision'),
    contract_id: requiredString(value.contract_id, 'identity.contract_id'),
  });
}

function uniqueIds(items, label) {
  if (!Array.isArray(items)) throw new TypeError(`${label} must be an array`);
  const seen = new Set();
  return Object.freeze(items.map((entry, index) => {
    object(entry, `${label}[${index}]`);
    const id = requiredString(entry.id, `${label}[${index}].id`);
    if (seen.has(id)) throw new TypeError(`${label} contains duplicate id: ${id}`);
    seen.add(id);
    return Object.freeze({ ...entry });
  }));
}

function model(value) {
  exactKeys(value, ['entities', 'joints', 'actuators', 'sensors', 'colliders'], 'model');
  return Object.freeze({
    entities: uniqueIds(value.entities ?? [], 'model.entities'),
    joints: uniqueIds(value.joints ?? [], 'model.joints'),
    actuators: uniqueIds(value.actuators ?? [], 'model.actuators'),
    sensors: uniqueIds(value.sensors ?? [], 'model.sensors'),
    colliders: uniqueIds(value.colliders ?? [], 'model.colliders'),
  });
}

function unitValue(value, label) {
  const allowed = new Set(Object.values(SIM_CANONICAL_UNITS));
  if (!allowed.has(value)) throw new TypeError(`${label} is not a canonical simulation unit`);
  return value;
}

function channel(entry, label) {
  exactKeys(entry, ['index', 'semantic', 'item_ref', 'dtype', 'shape', 'unit', 'scale', 'offset'], label);
  if (!Number.isSafeInteger(entry.index) || entry.index < 0) throw new TypeError(`${label}.index must be a non-negative safe integer`);
  requiredString(entry.semantic, `${label}.semantic`);
  requiredString(entry.item_ref, `${label}.item_ref`);
  requiredString(entry.dtype, `${label}.dtype`);
  if (!Array.isArray(entry.shape) || entry.shape.length === 0) throw new TypeError(`${label}.shape must be a non-empty array`);
  for (const [i, dim] of entry.shape.entries()) {
    if (!Number.isSafeInteger(dim) || dim <= 0) throw new TypeError(`${label}.shape[${i}] must be a positive safe integer`);
  }
  unitValue(entry.unit, `${label}.unit`);
  for (const field of ['scale', 'offset']) {
    if (entry[field] !== undefined && (typeof entry[field] !== 'number' || !Number.isFinite(entry[field]))) {
      throw new TypeError(`${label}.${field} must be finite when present`);
    }
  }
  return Object.freeze({
    index: entry.index,
    semantic: entry.semantic,
    item_ref: entry.item_ref,
    dtype: entry.dtype,
    shape: Object.freeze([...entry.shape]),
    unit: entry.unit,
    ...(entry.scale === undefined ? {} : { scale: entry.scale }),
    ...(entry.offset === undefined ? {} : { offset: entry.offset }),
  });
}

function channelSet(entries, label) {
  if (!Array.isArray(entries)) throw new TypeError(`${label} must be an array`);
  const seen = new Set();
  return Object.freeze(entries.map((entry, index) => {
    const normalized = channel(entry, `${label}[${index}]`);
    if (seen.has(normalized.index)) throw new TypeError(`${label} contains duplicate index: ${normalized.index}`);
    seen.add(normalized.index);
    return normalized;
  }));
}

function mapping(value) {
  exactKeys(value, ['state_channels', 'action_channels'], 'mapping');
  return Object.freeze({
    state_channels: channelSet(value.state_channels ?? [], 'mapping.state_channels'),
    action_channels: channelSet(value.action_channels ?? [], 'mapping.action_channels'),
  });
}

function physics(value) {
  exactKeys(value, ['backend', 'integrator', 'solver', 'gravity', 'effective_model_required'], 'physics');
  const backend = requiredString(value.backend, 'physics.backend');
  if (!Array.isArray(value.gravity) || value.gravity.length !== 3 || value.gravity.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new TypeError('physics.gravity must contain exactly three finite numbers');
  }
  if (typeof value.effective_model_required !== 'boolean') throw new TypeError('physics.effective_model_required must be boolean');
  return Object.freeze({
    backend,
    integrator: value.integrator == null ? null : requiredString(value.integrator, 'physics.integrator'),
    solver: value.solver == null ? null : requiredString(value.solver, 'physics.solver'),
    gravity: Object.freeze([...value.gravity]),
    effective_model_required: value.effective_model_required,
  });
}

function capabilityRecord(value, label) {
  exactKeys(value, ['status', 'basis', 'reason', 'evidence_refs'], label);
  if (!SIM_CAPABILITY_STATUSES.includes(value.status)) throw new TypeError(`${label}.status is invalid`);
  if (value.status === 'supported') {
    requiredString(value.basis, `${label}.basis`);
  } else {
    requiredString(value.reason, `${label}.reason`);
  }
  const refs = value.evidence_refs ?? [];
  if (!Array.isArray(refs)) throw new TypeError(`${label}.evidence_refs must be an array`);
  return Object.freeze({
    status: value.status,
    ...(value.basis === undefined ? {} : { basis: value.basis }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    evidence_refs: Object.freeze(refs.map((ref) => assertSimulationArtifactRef(ref))),
  });
}

function support(value) {
  exactKeys(value, ['capabilities', 'certification', 'release_approved'], 'support');
  const caps = object(value.capabilities, 'support.capabilities');
  const normalizedCaps = Object.fromEntries(
    Object.keys(caps).sort().map((name) => [
      name,
      capabilityRecord(caps[name], `support.capabilities.${name}`),
    ]),
  );
  exactKeys(value.certification, ['discovery', 'contract', 'runtime_tested'], 'support.certification');
  for (const [key, status] of Object.entries(value.certification)) {
    if (status !== 'not-certified') {
      throw new TypeError(`support.certification.${key} must remain not-certified in draft-1`);
    }
  }
  if (value.release_approved !== false) {
    throw new TypeError('support.release_approved must remain false in draft-1');
  }
  return Object.freeze({
    capabilities: Object.freeze(normalizedCaps),
    certification: Object.freeze({ ...value.certification }),
    release_approved: false,
  });
}

function provenance(value) {
  exactKeys(value, ['producer'], 'provenance');
  exactKeys(value.producer, ['id', 'version', 'implementation_sha256'], 'provenance.producer');
  const digest = requiredString(value.producer.implementation_sha256, 'provenance.producer.implementation_sha256');
  if (!SHA256_RE.test(digest)) throw new TypeError('provenance.producer.implementation_sha256 must be lowercase sha256');
  return Object.freeze({
    producer: Object.freeze({
      id: requiredString(value.producer.id, 'provenance.producer.id'),
      version: requiredString(value.producer.version, 'provenance.producer.version'),
      implementation_sha256: digest,
    }),
  });
}

export function assertSimulationContractDraft(value) {
  exactKeys(value, [
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

  if (value.simulation_contract !== SIMULATION_CONTRACT_SCHEMA) {
    throw new TypeError('simulation_contract version is unsupported');
  }
  if (!Array.isArray(value.source_inputs) || value.source_inputs.length === 0) {
    throw new TypeError('source_inputs must contain at least one exact source artifact');
  }

  const normalizedIdentity = identity(value.identity);
  const normalizedSources = value.source_inputs.map(sourceInput);
  const paths = normalizedSources.map((item) => item.path);
  if (new Set(paths).size !== paths.length) throw new TypeError('source_inputs contains duplicate paths');

  return Object.freeze({
    simulation_contract: SIMULATION_CONTRACT_SCHEMA,
    identity: normalizedIdentity,
    source_inputs: Object.freeze(normalizedSources),
    model: model(value.model),
    mapping: mapping(value.mapping),
    coordinates: assertCoordinateSystem(value.coordinates),
    units: assertSimulationUnits(value.units),
    timing: assertTiming(value.timing),
    physics: physics(value.physics),
    support: support(value.support),
    provenance: provenance(value.provenance),
  });
}
