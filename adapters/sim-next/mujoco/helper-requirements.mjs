import { buildFirstPartyHelperRequirements } from '../../../lib/trust-next/first-party-helper-requirements.mjs';
import { MUJOCO_EFFECTIVE_MODEL_SCHEMA } from './effective-model.mjs';

export const MUJOCO_EFFECTIVE_HELPER_PLAN = 'sbf.sim-mujoco-effective-helper-plan/draft-1';

function nonEmptyArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item)) {
    throw new TypeError(`${label} must be a non-empty string array`);
  }
  return [...value];
}

function plain(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

export function buildMujocoEffectiveModelHelperPlan({
  launcher,
  assets,
  artifactTrustPolicy,
  readRoots,
  limits,
}) {
  plain(launcher, 'launcher');
  if (!Array.isArray(assets) || assets.length === 0) throw new TypeError('assets must contain trusted helper/runtime bytes');
  const reads = nonEmptyArray(readRoots, 'readRoots');
  plain(limits, 'limits');

  const helperRequirements = buildFirstPartyHelperRequirements({
    helperId: 't24-mujoco-effective-model',
    helperClass: 'compiler-helper',
    inputMode: 'approved-files',
    launcher,
    assets,
    artifactTrustPolicy,
    executableBasenames: [launcher.basename],
    readRoots: reads,
    writeRoots: [],
    environment: [],
    maxChildren: 1,
    limits,
    acquisition: null,
    targetCodeExecution: false,
  });

  return Object.freeze({
    schema: MUJOCO_EFFECTIVE_HELPER_PLAN,
    target: 'SIM-mujoco',
    output_schema: MUJOCO_EFFECTIVE_MODEL_SCHEMA,
    helper_requirements: helperRequirements,
    source_bytes_preapproved: true,
    runtime_network_allowed: false,
    target_code_execution: false,
    effective_model_only: true,
    runtime_behavior_certified: false,
    note: 'This plan describes trust/runtime prerequisites only. T16/T00 must still bind the actual execution and evidence before helper output is accepted for promotion.',
  });
}
