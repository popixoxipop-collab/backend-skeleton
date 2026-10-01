import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MUJOCO_EFFECTIVE_HELPER_PLAN,
  buildMujocoEffectiveModelHelperPlan,
} from '../../../adapters/sim-next/mujoco/helper-requirements.mjs';
import { MUJOCO_EFFECTIVE_MODEL_SCHEMA } from '../../../adapters/sim-next/mujoco/effective-model.mjs';

const PYTHON='a'.repeat(64);
const HELPER='b'.repeat(64);
const MUJOCO='c'.repeat(64);
const NATIVE='d'.repeat(64);

function policy(shas) {
  return {
    schema:'bskel.trust-artifact-policy/1',
    generation:24,
    allow:shas.map((sha256) => ({ usage:'helper', sha256 })),
    revoked:[],
  };
}

function base() {
  return {
    launcher:{ basename:'python3', sha256:PYTHON },
    assets:[
      { id:'effective-model-helper', sha256:HELPER },
      { id:'mujoco-runtime-closure', sha256:MUJOCO },
      { id:'mujoco-native-library', sha256:NATIVE },
    ],
    artifactTrustPolicy:policy([PYTHON,HELPER,MUJOCO,NATIVE]),
    readRoots:['inputs/mujoco'],
    limits:{
      wall_ms:60_000,
      cpu_ms:60_000,
      memory_bytes:1_073_741_824,
      pids:4,
      stdout_bytes:8_388_608,
      stderr_bytes:262_144,
      scratch_bytes:67_108_864,
    },
  };
}

test('MuJoCo compiler helper plan is exact-byte trusted, approved-files, network denied and T16-gated', () => {
  const plan=buildMujocoEffectiveModelHelperPlan(base());
  assert.equal(plan.schema,MUJOCO_EFFECTIVE_HELPER_PLAN);
  assert.equal(plan.output_schema,MUJOCO_EFFECTIVE_MODEL_SCHEMA);
  assert.equal(plan.target,'SIM-mujoco');
  assert.equal(plan.target_code_execution,false);
  assert.equal(plan.runtime_network_allowed,false);
  assert.equal(plan.runtime_behavior_certified,false);
  assert.deepEqual(plan.required_runtime_asset_ids,[
    'effective-model-helper',
    'mujoco-runtime-closure',
    'mujoco-native-library',
  ]);

  const req=plan.helper_requirements;
  assert.equal(req.helper_class,'compiler-helper');
  assert.equal(req.input_mode,'approved-files');
  assert.equal(req.target_code_execution,false);
  assert.equal(req.executable_now,false);
  assert.equal(req.runtime_binding_required,true);
  assert.equal(req.evidence_required,true);
  assert.equal(req.acquisition,null);
  assert.deepEqual(req.runtime.permission_manifest.network,{ mode:'deny', allow:[] });
  assert.deepEqual(req.runtime.permission_manifest.write_roots,[]);
  assert.deepEqual(req.runtime.permission_manifest.environment,{ allow:[] });
  assert.deepEqual(req.runtime.permission_manifest.process.executables,['python3']);
  assert.equal(req.runtime.permission_manifest.process.max_children,1);
});

test('MuJoCo helper plan has no acquisition/network escape hatch', () => {
  const plan=buildMujocoEffectiveModelHelperPlan(base());
  assert.equal(plan.helper_requirements.acquisition,null);
  assert.deepEqual(plan.helper_requirements.runtime.permission_manifest.secret_refs,[]);
  assert.deepEqual(plan.helper_requirements.runtime.permission_manifest.devices,{ mode:'deny', allow:[] });
});

test('MuJoCo helper plan requires explicit helper/runtime/native asset roles', () => {
  for (const missingId of [
    'effective-model-helper',
    'mujoco-runtime-closure',
    'mujoco-native-library',
  ]) {
    const args=base();
    args.assets=args.assets.filter((asset)=>asset.id!==missingId);
    assert.throws(
      () => buildMujocoEffectiveModelHelperPlan(args),
      new RegExp(missingId),
    );
  }
});

test('required MuJoCo runtime roles cannot alias the same trusted bytes', () => {
  const sameRoleBytes=base();
  sameRoleBytes.assets=sameRoleBytes.assets.map((asset) =>
    asset.id==='mujoco-native-library' ? { ...asset, sha256:MUJOCO } : asset
  );
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan(sameRoleBytes),
    /distinct exact-byte artifacts/,
  );

  const launcherAlias=base();
  launcherAlias.assets=launcherAlias.assets.map((asset) =>
    asset.id==='effective-model-helper' ? { ...asset, sha256:PYTHON } : asset
  );
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan(launcherAlias),
    /launcher bytes must be distinct/,
  );
});

test('every launcher/helper/runtime asset must already be trusted as helper bytes', () => {
  const args=base();
  args.artifactTrustPolicy=policy([PYTHON,HELPER,MUJOCO]);
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan(args),
    (error) => error?.code === 'FIRST_PARTY_HELPER_ASSET_UNTRUSTED',
  );
});

test('helper plan has no writable target/scratch roots and requires explicit approved read roots', () => {
  const plan=buildMujocoEffectiveModelHelperPlan(base());
  assert.deepEqual(plan.helper_requirements.runtime.permission_manifest.write_roots,[]);
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan({ ...base(), readRoots:[] }),
    /non-empty string array/,
  );
});

test('helper runtime process allowlist contains only the approved launcher basename', () => {
  const plan=buildMujocoEffectiveModelHelperPlan(base());
  assert.deepEqual(plan.helper_requirements.runtime.permission_manifest.process,{
    mode:'argv-allowlist',
    executables:['python3'],
    max_children:1,
  });
});


test('MuJoCo helper plan rejects caller-controlled permission and execution widening fields', () => {
  for (const [field, value] of [
    ['acquisition',{ networkAllow:['example.com'] }],
    ['networkAllow',['example.com']],
    ['writeRoots',['scratch']],
    ['environment',['HOME']],
    ['targetCodeExecution',true],
  ]) {
    assert.throws(
      () => buildMujocoEffectiveModelHelperPlan({ ...base(), [field]:value }),
      new RegExp(`unsupported fields: ${field}`),
    );
  }
});
