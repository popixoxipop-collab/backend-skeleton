import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MUJOCO_EFFECTIVE_HELPER_PLAN,
  buildMujocoEffectiveModelHelperPlan,
} from '../adapters/sim-next/mujoco/helper-requirements.mjs';

const PYTHON='a'.repeat(64);
const HELPER='b'.repeat(64);
const MUJOCO='c'.repeat(64);
const NATIVE='d'.repeat(64);

function policy(shas=[PYTHON,HELPER,MUJOCO,NATIVE]) {
  return {
    schema:'bskel.trust-artifact-policy/1',
    generation:31,
    allow:shas.map((sha256)=>({usage:'helper',sha256})),
    revoked:[],
  };
}

function base() {
  return {
    launcher:{basename:'python3',sha256:PYTHON},
    assets:[
      {id:'effective-model-helper',sha256:HELPER},
      {id:'mujoco-runtime-closure',sha256:MUJOCO},
      {id:'mujoco-native-library',sha256:NATIVE},
    ],
    artifactTrustPolicy:policy(),
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

test('Q-M2 trust holdout: baseline is compiler-helper approved-files with deny-by-default runtime', () => {
  const plan=buildMujocoEffectiveModelHelperPlan(base());
  assert.equal(plan.schema,MUJOCO_EFFECTIVE_HELPER_PLAN);
  assert.equal(plan.target,'SIM-mujoco');
  assert.equal(plan.source_bytes_preapproved,true);
  assert.equal(plan.runtime_network_allowed,false);
  assert.equal(plan.target_code_execution,false);
  assert.equal(plan.runtime_behavior_certified,false);
  assert.equal(plan.effective_model_only,true);

  const req=plan.helper_requirements;
  assert.equal(req.helper_class,'compiler-helper');
  assert.equal(req.input_mode,'approved-files');
  assert.equal(req.target_code_execution,false);
  assert.equal(req.executable_now,false);
  assert.equal(req.runtime_binding_required,true);
  assert.equal(req.evidence_required,true);
  assert.equal(req.acquisition,null);
  assert.deepEqual(req.runtime.permission_manifest.network,{mode:'deny',allow:[]});
  assert.deepEqual(req.runtime.permission_manifest.write_roots,[]);
  assert.deepEqual(req.runtime.permission_manifest.environment,{allow:[]});
  assert.deepEqual(req.runtime.permission_manifest.devices,{mode:'deny',allow:[]});
  assert.deepEqual(req.runtime.permission_manifest.process,{
    mode:'argv-allowlist',
    executables:['python3'],
    max_children:1,
  });
});

test('Q-M2 trust holdout: every required runtime role is mandatory', () => {
  for (const id of [
    'effective-model-helper',
    'mujoco-runtime-closure',
    'mujoco-native-library',
  ]) {
    const args=base();
    args.assets=args.assets.filter((x)=>x.id!==id);
    assert.throws(() => buildMujocoEffectiveModelHelperPlan(args), new RegExp(id));
  }
});

test('Q-M2 trust holdout: duplicate role ids fail closed even when required roles remain present', () => {
  const args=base();
  args.assets.push({id:'effective-model-helper',sha256:'e'.repeat(64)});
  args.artifactTrustPolicy=policy([PYTHON,HELPER,MUJOCO,NATIVE,'e'.repeat(64)]);
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan(args),
    (error)=>error?.code==='FIRST_PARTY_HELPER_ASSET_DUPLICATE',
  );
});

test('Q-M2 trust holdout: required role digests are mutually distinct', () => {
  const args=base();
  args.assets=args.assets.map((x)=>
    x.id==='mujoco-native-library'?{...x,sha256:MUJOCO}:x
  );
  assert.throws(() => buildMujocoEffectiveModelHelperPlan(args), /distinct exact-byte artifacts/);
});

test('Q-M2 trust holdout: launcher digest cannot alias a required runtime role', () => {
  const args=base();
  args.assets=args.assets.map((x)=>
    x.id==='effective-model-helper'?{...x,sha256:PYTHON}:x
  );
  assert.throws(() => buildMujocoEffectiveModelHelperPlan(args), /launcher bytes must be distinct/);
});

test('Q-M2 trust holdout: untrusted launcher/runtime/native bytes fail closed', () => {
  const launcher=base();
  launcher.artifactTrustPolicy=policy([HELPER,MUJOCO,NATIVE]);
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan(launcher),
    (error)=>error?.code==='FIRST_PARTY_HELPER_LAUNCHER_UNTRUSTED',
  );

  for (const missing of [MUJOCO,NATIVE]) {
    const args=base();
    args.artifactTrustPolicy=policy([PYTHON,HELPER,MUJOCO,NATIVE].filter((x)=>x!==missing));
    assert.throws(
      () => buildMujocoEffectiveModelHelperPlan(args),
      (error)=>error?.code==='FIRST_PARTY_HELPER_ASSET_UNTRUSTED',
    );
  }
});

test('Q-M2 trust holdout: revoked policy entries prevent plan construction', () => {
  const args=base();
  args.artifactTrustPolicy={
    schema:'bskel.trust-artifact-policy/1',
    generation:31,
    allow:[
      {usage:'helper',sha256:PYTHON},
      {usage:'helper',sha256:HELPER},
      {usage:'helper',sha256:MUJOCO},
    ],
    revoked:[{sha256:NATIVE,reason:'revoked by independent M2 QA'}],
  };
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan(args),
    (error)=>error?.code==='FIRST_PARTY_HELPER_ASSET_REVOKED',
  );
});

test('Q-M2 trust holdout: empty read roots fail closed', () => {
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan({...base(),readRoots:[]}),
    /non-empty string array/,
  );
});

test('Q-M2 trust holdout: acquisition permission expansion request must be rejected, not silently ignored', () => {
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan({
      ...base(),
      acquisition:{networkAllow:['pypi.org']},
    }),
    /unsupported|acquisition|argument|field/i,
  );
});

test('Q-M2 trust holdout: runtime network allowlist expansion request must be rejected, not silently ignored', () => {
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan({
      ...base(),
      networkAllow:['example.com'],
    }),
    /unsupported|network|argument|field/i,
  );
});

test('Q-M2 trust holdout: environment expansion request must be rejected, not silently ignored', () => {
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan({
      ...base(),
      environment:['PYTHONPATH'],
    }),
    /unsupported|environment|argument|field/i,
  );
});

test('Q-M2 trust holdout: writable-root expansion request must be rejected, not silently ignored', () => {
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan({
      ...base(),
      writeRoots:['scratch'],
    }),
    /unsupported|write|argument|field/i,
  );
});

test('Q-M2 trust holdout: targetCodeExecution=true request must be rejected, not silently ignored', () => {
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan({
      ...base(),
      targetCodeExecution:true,
    }),
    /unsupported|target|execution|argument|field/i,
  );
});
