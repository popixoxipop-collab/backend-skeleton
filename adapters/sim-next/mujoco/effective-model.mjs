import { assertArtifactRef } from '../identity.mjs';

export const MUJOCO_EFFECTIVE_MODEL_SCHEMA = 'sbf.sim-mujoco-effective-model/draft-1';

const JOINT_WIDTHS = Object.freeze({
  free: { qpos: 7, dof: 6 },
  ball: { qpos: 4, dof: 3 },
  slide: { qpos: 1, dof: 1 },
  hinge: { qpos: 1, dof: 1 },
});
const TRANSMISSIONS = new Set(['joint', 'jointinparent', 'slidercrank', 'tendon', 'site', 'body']);
const MAX_MODEL_COUNT = 1_000_000;
const MAX_SOURCE_FILES = 10_000;
const MAX_TEXT_LENGTH = 4096;

function plain(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  plain(value, label);
  const extra = Object.keys(value).filter((key) => !keys.includes(key)).sort();
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (extra.length) throw new TypeError(`${label} contains unsupported fields: ${extra.join(', ')}`);
  if (missing.length) throw new TypeError(`${label} is missing required fields: ${missing.join(', ')}`);
}

function int(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer in ${min}..${max}`);
  }
  return value;
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function finiteArray(value, label, length) {
  if (!Array.isArray(value) || value.length !== length) throw new TypeError(`${label} must contain exactly ${length} numbers`);
  return value.map((item, index) => finite(item, `${label}[${index}]`));
}

function nullableName(value, label) {
  if (value !== null && (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TEXT_LENGTH ||
    /[\x00-\x1f\x7f]/.test(value)
  )) {
    throw new TypeError(`${label} must be null or a bounded non-empty control-free string`);
  }
  return value;
}

function boundedText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH || /[\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError(`${label} must be a bounded non-empty control-free string`);
  }
  return value;
}

function denseIds(items, expectedCount, label) {
  if (!Array.isArray(items) || items.length !== expectedCount) {
    throw new TypeError(`${label} length must equal ${expectedCount}`);
  }
  for (let index = 0; index < items.length; index += 1) {
    plain(items[index], `${label}[${index}]`);
    if (items[index].id !== index) throw new TypeError(`${label} ids must be dense and ordered; expected id ${index}`);
  }
}

function validateCoverage(ranges, total, label) {
  const occupancy = new Uint8Array(total);
  for (const range of ranges) {
    const { start, width, owner } = range;
    if (!Number.isSafeInteger(start) || start < 0) throw new TypeError(`${owner} has invalid ${label} start`);
    if (!Number.isSafeInteger(width) || width < 0) throw new TypeError(`${owner} has invalid ${label} width`);
    if (start + width > total) throw new TypeError(`${owner} ${label} range exceeds total ${total}`);
    for (let index = start; index < start + width; index += 1) {
      if (occupancy[index]) throw new TypeError(`${label} ranges overlap at index ${index}`);
      occupancy[index] = 1;
    }
  }
  if (occupancy.some((value) => value !== 1)) {
    const missing = [];
    for (let index = 0; index < occupancy.length; index += 1) if (!occupancy[index]) missing.push(index);
    throw new TypeError(`${label} coverage is incomplete; missing indices: ${missing.slice(0, 16).join(',')}`);
  }
}

function validateCounts(value) {
  const keys = ['nbody','njnt','ngeom','nsite','ntendon','nq','nv','na','nu','nsensor','nsensordata'];
  exactKeys(value, keys, 'model.counts');
  const out = {};
  for (const key of keys) out[key] = int(value[key], `model.counts.${key}`, { max:MAX_MODEL_COUNT });
  if (out.nbody < 1) throw new TypeError('model.counts.nbody must include world body');
  return Object.freeze(out);
}

function validateBodies(items, counts) {
  denseIds(items, counts.nbody, 'model.bodies');
  const normalized = items.map((item, index) => {
    exactKeys(item, ['id','name','parent_id'], `model.bodies[${index}]`);
    nullableName(item.name, `model.bodies[${index}].name`);
    int(item.parent_id, `model.bodies[${index}].parent_id`);
    if (item.parent_id >= counts.nbody) throw new TypeError(`model.bodies[${index}].parent_id is out of range`);
    if (index === 0 && item.parent_id !== 0) throw new TypeError('world body parent_id must be 0');
    if (index > 0 && item.parent_id === index) throw new TypeError(`model.bodies[${index}] cannot parent itself`);
    return Object.freeze({ ...item });
  });
  const state = new Uint8Array(normalized.length);
  state[0] = 2;
  for (let start = 1; start < normalized.length; start += 1) {
    if (state[start] === 2) continue;
    const path = [];
    let current = start;
    while (state[current] === 0) {
      state[current] = 1;
      path.push(current);
      current = normalized[current].parent_id;
    }
    if (state[current] === 1) throw new TypeError(`model.bodies parent graph contains a cycle at body ${current}`);
    for (const bodyId of path) state[bodyId] = 2;
  }
  return Object.freeze(normalized);
}

function validateJoints(items, counts) {
  denseIds(items, counts.njnt, 'model.joints');
  const qposRanges = [];
  const dofRanges = [];
  const normalized = items.map((item, index) => {
    exactKeys(item, [
      'id','name','body_id','type','qpos_adr','dof_adr','qpos_width','dof_width','limited','range'
    ], `model.joints[${index}]`);
    nullableName(item.name, `model.joints[${index}].name`);
    int(item.body_id, `model.joints[${index}].body_id`);
    if (item.body_id <= 0 || item.body_id >= counts.nbody) throw new TypeError(`model.joints[${index}].body_id must reference a non-world body`);
    const widths = JOINT_WIDTHS[item.type];
    if (!widths) throw new TypeError(`model.joints[${index}].type is unsupported: ${String(item.type)}`);
    int(item.qpos_adr, `model.joints[${index}].qpos_adr`);
    int(item.dof_adr, `model.joints[${index}].dof_adr`);
    int(item.qpos_width, `model.joints[${index}].qpos_width`);
    int(item.dof_width, `model.joints[${index}].dof_width`);
    if (item.qpos_width !== widths.qpos || item.dof_width !== widths.dof) {
      throw new TypeError(`model.joints[${index}] widths do not match joint type ${item.type}`);
    }
    if (typeof item.limited !== 'boolean') throw new TypeError(`model.joints[${index}].limited must be boolean`);
    let range = null;
    if (item.range !== null) range = finiteArray(item.range, `model.joints[${index}].range`, 2);
    if (item.limited && range === null) throw new TypeError(`model.joints[${index}] limited joint requires range`);
    qposRanges.push({ start:item.qpos_adr, width:item.qpos_width, owner:`joint ${index}` });
    dofRanges.push({ start:item.dof_adr, width:item.dof_width, owner:`joint ${index}` });
    return Object.freeze({ ...item, range });
  });
  validateCoverage(qposRanges, counts.nq, 'qpos');
  validateCoverage(dofRanges, counts.nv, 'qvel');
  return Object.freeze(normalized);
}

function validateBodyOwned(items, expectedCount, label, counts, extraKeys, mapper) {
  denseIds(items, expectedCount, label);
  return Object.freeze(items.map((item, index) => {
    exactKeys(item, ['id','name','body_id', ...extraKeys], `${label}[${index}]`);
    nullableName(item.name, `${label}[${index}].name`);
    int(item.body_id, `${label}[${index}].body_id`);
    if (item.body_id < 0 || item.body_id >= counts.nbody) throw new TypeError(`${label}[${index}].body_id is out of range`);
    return Object.freeze(mapper ? mapper(item, index) : { ...item });
  }));
}

function validateGeoms(items, counts) {
  return validateBodyOwned(items, counts.ngeom, 'model.geoms', counts, ['type','contype','conaffinity'], (item, index) => {
    boundedText(item.type, `model.geoms[${index}].type`);
    int(item.contype, `model.geoms[${index}].contype`);
    int(item.conaffinity, `model.geoms[${index}].conaffinity`);
    return { ...item };
  });
}

function validateSites(items, counts) {
  return validateBodyOwned(items, counts.nsite, 'model.sites', counts, [], (item) => ({ ...item }));
}

function validateActuators(items, counts) {
  denseIds(items, counts.nu, 'model.actuators');
  const activationRanges = [];
  const normalized = items.map((item, index) => {
    exactKeys(item, [
      'id','name','transmission_type','target_ids','activation_adr','activation_count','ctrl_limited','ctrl_range'
    ], `model.actuators[${index}]`);
    nullableName(item.name, `model.actuators[${index}].name`);
    if (!TRANSMISSIONS.has(item.transmission_type)) {
      throw new TypeError(`model.actuators[${index}].transmission_type is unsupported`);
    }
    if (!Array.isArray(item.target_ids) || item.target_ids.length !== 2 ||
        item.target_ids.some((value) => !Number.isSafeInteger(value) || value < -1)) {
      throw new TypeError(`model.actuators[${index}].target_ids must be two integers >= -1`);
    }
    const [primaryTarget, secondaryTarget] = item.target_ids;
    if (item.transmission_type === 'joint' || item.transmission_type === 'jointinparent') {
      if (primaryTarget < 0 || primaryTarget >= counts.njnt || secondaryTarget !== -1) {
        throw new TypeError(`model.actuators[${index}] joint transmission target_ids are invalid`);
      }
    } else if (item.transmission_type === 'tendon') {
      if (primaryTarget < 0 || primaryTarget >= counts.ntendon || secondaryTarget !== -1) {
        throw new TypeError(`model.actuators[${index}] tendon transmission target_ids are invalid`);
      }
    } else if (item.transmission_type === 'body') {
      if (primaryTarget < 0 || primaryTarget >= counts.nbody || secondaryTarget !== -1) {
        throw new TypeError(`model.actuators[${index}] body transmission target_ids are invalid`);
      }
    } else if (item.transmission_type === 'slidercrank') {
      if (primaryTarget < 0 || primaryTarget >= counts.nsite || secondaryTarget < 0 || secondaryTarget >= counts.nsite) {
        throw new TypeError(`model.actuators[${index}] slidercrank site target_ids are invalid`);
      }
    } else if (item.transmission_type === 'site') {
      if (primaryTarget < 0 || primaryTarget >= counts.nsite ||
          (secondaryTarget !== -1 && (secondaryTarget < 0 || secondaryTarget >= counts.nsite))) {
        throw new TypeError(`model.actuators[${index}] site transmission target_ids are invalid`);
      }
    }
    int(item.activation_count, `model.actuators[${index}].activation_count`);
    if (!Number.isSafeInteger(item.activation_adr) || item.activation_adr < -1) {
      throw new TypeError(`model.actuators[${index}].activation_adr must be >= -1`);
    }
    if (item.activation_count === 0 && item.activation_adr !== -1) {
      throw new TypeError(`model.actuators[${index}] stateless actuator must use activation_adr=-1`);
    }
    if (item.activation_count > 0) {
      if (item.activation_adr < 0) throw new TypeError(`model.actuators[${index}] stateful actuator requires activation_adr`);
      activationRanges.push({ start:item.activation_adr, width:item.activation_count, owner:`actuator ${index}` });
    }
    if (typeof item.ctrl_limited !== 'boolean') throw new TypeError(`model.actuators[${index}].ctrl_limited must be boolean`);
    let ctrlRange = null;
    if (item.ctrl_range !== null) ctrlRange = finiteArray(item.ctrl_range, `model.actuators[${index}].ctrl_range`, 2);
    if (item.ctrl_limited && ctrlRange === null) throw new TypeError(`model.actuators[${index}] limited control requires ctrl_range`);
    return Object.freeze({ ...item, ctrl_range:ctrlRange });
  });
  validateCoverage(activationRanges, counts.na, 'activation');
  return Object.freeze(normalized);
}

function validateSensors(items, counts) {
  denseIds(items, counts.nsensor, 'model.sensors');
  const ranges = [];
  const normalized = items.map((item, index) => {
    exactKeys(item, ['id','name','type','object_type','object_id','adr','dim'], `model.sensors[${index}]`);
    nullableName(item.name, `model.sensors[${index}].name`);
    boundedText(item.type, `model.sensors[${index}].type`);
    boundedText(item.object_type, `model.sensors[${index}].object_type`);
    if (!Number.isSafeInteger(item.object_id) || item.object_id < -1) throw new TypeError(`model.sensors[${index}].object_id must be >= -1`);
    int(item.adr, `model.sensors[${index}].adr`);
    int(item.dim, `model.sensors[${index}].dim`, { min:1 });
    ranges.push({ start:item.adr, width:item.dim, owner:`sensor ${index}` });
    return Object.freeze({ ...item });
  });
  validateCoverage(ranges, counts.nsensordata, 'sensordata');
  return Object.freeze(normalized);
}

function validateCompiler(value) {
  exactKeys(value, ['engine','version','build','helper_artifact'], 'compiler');
  if (value.engine !== 'mujoco') throw new TypeError('compiler.engine must be mujoco');
  boundedText(value.version, 'compiler.version');
  if (value.build !== null) boundedText(value.build, 'compiler.build');
  const helper = assertArtifactRef(value.helper_artifact, { family:'simulation-helper', version:'draft-1' });
  return Object.freeze({ ...value, helper_artifact:helper });
}

function sourcePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH || /[\x00-\x1f\x7f]/.test(value) ||
      value.includes('\\') || value.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
      /^[A-Za-z]:\//.test(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError(`${label} must be a repo-relative POSIX path without dot/parent segments`);
  }
  return value;
}

function validateSourceEntry(value, label, { roleRequired = false } = {}) {
  const keys = roleRequired ? ['path','role','artifact'] : ['path','artifact'];
  exactKeys(value, keys, label);
  const path = sourcePath(value.path, `${label}.path`);
  if (roleRequired && !['include','asset'].includes(value.role)) {
    throw new TypeError(`${label}.role must be include or asset`);
  }
  const artifact = assertArtifactRef(value.artifact, { family:'simulation-source', version:'draft-1' });
  return Object.freeze({
    path,
    ...(roleRequired ? { role:value.role } : {}),
    artifact,
  });
}

function validateSource(value) {
  exactKeys(value, ['root','dependencies'], 'source_bundle');
  const root = validateSourceEntry(value.root, 'source_bundle.root');
  if (!Array.isArray(value.dependencies)) throw new TypeError('source_bundle.dependencies must be an array');
  if (value.dependencies.length > MAX_SOURCE_FILES - 1) throw new TypeError(`source_bundle exceeds file-count limit ${MAX_SOURCE_FILES}`);
  const dependencies = value.dependencies.map((entry, index) =>
    validateSourceEntry(entry, `source_bundle.dependencies[${index}]`, { roleRequired:true })
  );
  const seenPaths = new Set([root.path]);
  for (const entry of dependencies) {
    if (seenPaths.has(entry.path)) throw new TypeError(`source_bundle contains duplicate logical path: ${entry.path}`);
    seenPaths.add(entry.path);
  }
  return Object.freeze({ root, dependencies:Object.freeze(dependencies) });
}

export function validateMujocoEffectiveModelExport(value) {
  exactKeys(value, [
    'schema','target','source_bundle','compiler','model','claims'
  ], 'effective-model export');
  if (value.schema !== MUJOCO_EFFECTIVE_MODEL_SCHEMA) throw new TypeError('effective-model export schema is invalid');
  if (value.target !== 'SIM-mujoco') throw new TypeError('effective-model export target must be SIM-mujoco');

  const source_bundle = validateSource(value.source_bundle);
  const compiler = validateCompiler(value.compiler);

  exactKeys(value.model, [
    'counts','options','bodies','joints','geoms','sites','actuators','sensors'
  ], 'model');
  const counts = validateCounts(value.model.counts);

  exactKeys(value.model.options, ['timestep','gravity','integrator'], 'model.options');
  const timestep = finite(value.model.options.timestep, 'model.options.timestep');
  if (timestep <= 0) throw new TypeError('model.options.timestep must be > 0');
  const gravity = finiteArray(value.model.options.gravity, 'model.options.gravity', 3);
  boundedText(value.model.options.integrator, 'model.options.integrator');

  const model = Object.freeze({
    counts,
    options:Object.freeze({ timestep, gravity, integrator:value.model.options.integrator }),
    bodies:validateBodies(value.model.bodies, counts),
    joints:validateJoints(value.model.joints, counts),
    geoms:validateGeoms(value.model.geoms, counts),
    sites:validateSites(value.model.sites, counts),
    actuators:validateActuators(value.model.actuators, counts),
    sensors:validateSensors(value.model.sensors, counts),
  });

  exactKeys(value.claims, [
    'compiled_model_facts','source_bundle_bound','runtime_behavior_verified','dynamic_state_observed'
  ], 'claims');
  if (value.claims.compiled_model_facts !== true) throw new TypeError('claims.compiled_model_facts must be true');
  if (value.claims.source_bundle_bound !== true) throw new TypeError('claims.source_bundle_bound must be true');
  if (value.claims.runtime_behavior_verified !== false) throw new TypeError('effective-model export cannot claim runtime behavior');
  if (value.claims.dynamic_state_observed !== false) throw new TypeError('effective-model export cannot claim dynamic state observation');

  return Object.freeze({
    schema:value.schema,
    target:value.target,
    source_bundle,
    compiler,
    model,
    claims:Object.freeze({ ...value.claims }),
  });
}
