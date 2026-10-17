import { isDeepStrictEqual } from 'node:util';

import { assertArtifactRef } from '../identity.mjs';
import { validateMujocoEffectiveModelExport } from './effective-model.mjs';

export const MUJOCO_EFFECTIVE_HELPER_REQUEST = 'sbf.sim-mujoco-effective-helper-request/draft-1';
export const MUJOCO_EFFECTIVE_HELPER_RESPONSE = 'sbf.sim-mujoco-effective-helper-response/draft-1';
export const MUJOCO_EFFECTIVE_HELPER_ENGINE_VERSION = '3.12.0';

const MAX_SOURCE_FILES = 10_000;
const MAX_TEXT_LENGTH = 4096;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;

function plain(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  plain(value, label);
  const actual = Object.keys(value);
  const extra = actual.filter((key) => !keys.includes(key)).sort();
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (extra.length) throw new TypeError(`${label} contains unsupported fields: ${extra.join(', ')}`);
  if (missing.length) throw new TypeError(`${label} is missing required fields: ${missing.join(', ')}`);
}

function boundedText(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TEXT_LENGTH ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new TypeError(`${label} must be a bounded non-empty control-free string`);
  }
  return value;
}

function sourcePath(value, label) {
  boundedText(value, label);
  if (
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
    /^[A-Za-z]:\//.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new TypeError(`${label} must be a repo-relative POSIX path without dot/parent segments`);
  }
  return value;
}

function validateSourceEntry(value, label, { roleRequired = false } = {}) {
  exactKeys(value, roleRequired ? ['path','role','artifact'] : ['path','artifact'], label);
  const path = sourcePath(value.path, `${label}.path`);
  if (roleRequired && !['include','asset'].includes(value.role)) {
    throw new TypeError(`${label}.role must be include or asset`);
  }
  const artifact = assertArtifactRef(value.artifact, {
    family:'simulation-source',
    version:'draft-1',
  });
  return Object.freeze({
    path,
    ...(roleRequired ? { role:value.role } : {}),
    artifact,
  });
}

function validateSourceBundle(value) {
  exactKeys(value, ['root','dependencies'], 'source_bundle');
  const root = validateSourceEntry(value.root, 'source_bundle.root');
  if (!Array.isArray(value.dependencies)) {
    throw new TypeError('source_bundle.dependencies must be an array');
  }
  if (value.dependencies.length > MAX_SOURCE_FILES - 1) {
    throw new TypeError(`source_bundle exceeds file-count limit ${MAX_SOURCE_FILES}`);
  }
  const dependencies = value.dependencies.map((entry, index) =>
    validateSourceEntry(entry, `source_bundle.dependencies[${index}]`, { roleRequired:true })
  );
  const seen = new Set([root.path]);
  for (const entry of dependencies) {
    if (seen.has(entry.path)) {
      throw new TypeError(`source_bundle contains duplicate logical path: ${entry.path}`);
    }
    seen.add(entry.path);
  }
  return Object.freeze({ root, dependencies:Object.freeze(dependencies) });
}

function equalJson(a, b) {
  return isDeepStrictEqual(a, b);
}

export function validateMujocoEffectiveHelperRequest(value) {
  exactKeys(value, ['protocol','target','source_bundle','helper_artifact'], 'MuJoCo helper request');
  if (value.protocol !== MUJOCO_EFFECTIVE_HELPER_REQUEST) {
    throw new TypeError('MuJoCo helper request protocol is invalid');
  }
  if (value.target !== 'SIM-mujoco') {
    throw new TypeError('MuJoCo helper request target must be SIM-mujoco');
  }
  const source_bundle = validateSourceBundle(value.source_bundle);
  const helper_artifact = assertArtifactRef(value.helper_artifact, {
    family:'simulation-helper',
    version:'draft-1',
  });
  return Object.freeze({
    protocol:MUJOCO_EFFECTIVE_HELPER_REQUEST,
    target:'SIM-mujoco',
    source_bundle,
    helper_artifact,
  });
}

export function validateMujocoEffectiveHelperResponse(value, { request = null } = {}) {
  plain(value, 'MuJoCo helper response');
  if (value.ok === true) {
    exactKeys(value, ['protocol','ok','effective_model'], 'MuJoCo helper response');
    if (value.protocol !== MUJOCO_EFFECTIVE_HELPER_RESPONSE) {
      throw new TypeError('MuJoCo helper response protocol is invalid');
    }
    const effective_model = validateMujocoEffectiveModelExport(value.effective_model);
    if (effective_model.compiler.version !== MUJOCO_EFFECTIVE_HELPER_ENGINE_VERSION) {
      throw new TypeError(
        `MuJoCo helper response compiler.version must be ${MUJOCO_EFFECTIVE_HELPER_ENGINE_VERSION}`,
      );
    }
    if (request === null) {
      throw new TypeError('MuJoCo helper success response requires exact request binding authority');
    }
    const normalizedRequest = validateMujocoEffectiveHelperRequest(request);
    if (!equalJson(effective_model.source_bundle, normalizedRequest.source_bundle)) {
      throw new TypeError('MuJoCo helper response source_bundle does not match the exact request');
    }
    if (!equalJson(effective_model.compiler.helper_artifact, normalizedRequest.helper_artifact)) {
      throw new TypeError('MuJoCo helper response helper_artifact does not match the exact request');
    }
    return Object.freeze({
      protocol:MUJOCO_EFFECTIVE_HELPER_RESPONSE,
      ok:true,
      effective_model,
    });
  }

  if (value.ok === false) {
    exactKeys(value, ['protocol','ok','error'], 'MuJoCo helper response');
    if (value.protocol !== MUJOCO_EFFECTIVE_HELPER_RESPONSE) {
      throw new TypeError('MuJoCo helper response protocol is invalid');
    }
    exactKeys(value.error, ['code','message'], 'MuJoCo helper response error');
    if (typeof value.error.code !== 'string' || !ERROR_CODE.test(value.error.code)) {
      throw new TypeError('MuJoCo helper response error.code is invalid');
    }
    const message = boundedText(value.error.message, 'MuJoCo helper response error.message');
    return Object.freeze({
      protocol:MUJOCO_EFFECTIVE_HELPER_RESPONSE,
      ok:false,
      error:Object.freeze({ code:value.error.code, message }),
    });
  }

  throw new TypeError('MuJoCo helper response ok must be boolean');
}
