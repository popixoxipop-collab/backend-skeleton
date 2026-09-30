import test from 'node:test';
import assert from 'node:assert/strict';

import { artifactRefForBytes } from '../adapters/sim-next/identity.mjs';
import {
  MUJOCO_EFFECTIVE_MODEL_SCHEMA,
  validateMujocoEffectiveModelExport,
} from '../adapters/sim-next/mujoco/effective-model.mjs';
import {
  MUJOCO_EFFECTIVE_HELPER_PLAN,
  buildMujocoEffectiveModelHelperPlan,
} from '../adapters/sim-next/mujoco/helper-requirements.mjs';

const PYTHON='a'.repeat(64);
const HELPER='b'.repeat(64);
const MUJOCO='c'.repeat(64);
const NATIVE='d'.repeat(64);

function artifact(bytes, family, mediaType='application/octet-stream') {
  return artifactRefForBytes(Buffer.from(bytes), {
    family,
    version:'draft-1',
    mediaType,
  });
}

function golden() {
  return {
    schema:MUJOCO_EFFECTIVE_MODEL_SCHEMA,
    target:'SIM-mujoco',
    source_bundle:{
      root:{
        path:'models/main.xml',
        artifact:artifact('<mujoco/>','simulation-source','application/xml'),
      },
      dependencies:[],
    },
    compiler:{
      engine:'mujoco',
      version:'qa-fixture-3.x',
      build:null,
      helper_artifact:artifact('helper','simulation-helper','text/x-python'),
    },
    model:{
      counts:{
        nbody:2,
        njnt:1,
        ngeom:1,
        nsite:1,
        ntendon:0,
        nq:1,
        nv:1,
        na:0,
        nu:1,
        nactuator:1,
        nout:1,
        nsensor:1,
        nsensordata:1,
      },
      options:{
        timestep:0.002,
        gravity:[0,0,-9.81],
        integrator:'Euler',
      },
      bodies:[
        { id:0, name:'world', parent_id:0 },
        { id:1, name:'link', parent_id:0 },
      ],
      joints:[
        {
          id:0,
          name:'hinge',
          body_id:1,
          type:'hinge',
          qpos_adr:0,
          dof_adr:0,
          qpos_width:1,
          dof_width:1,
          limited:true,
          range:[-1,1],
        },
      ],
      geoms:[
        { id:0, name:'g', body_id:1, type:'capsule', contype:1, conaffinity:1 },
      ],
      sites:[
        { id:0, name:'tip', body_id:1 },
      ],
      actuators:[
        {
          id:0,
          name:'m',
          transmission_type:'joint',
          target_ids:[0,-1],
          control_adr:0,
          control_count:1,
          controls:[{ limited:true, range:[-1,1] }],
          output_adr:0,
          output_count:1,
          activation_adr:-1,
          activation_count:0,
        },
      ],
      sensors:[
        { id:0, name:'jp', type:'jointpos', object_type:'joint', object_id:0, adr:0, dim:1 },
      ],
    },
    claims:{
      compiled_model_facts:true,
      source_bundle_bound:true,
      runtime_behavior_verified:false,
      dynamic_state_observed:false,
    },
  };
}

function addSecondActuator(value) {
  value.model.counts.nactuator=2;
  value.model.actuators.push({
    id:1,
    name:'m2',
    transmission_type:'joint',
    target_ids:[0,-1],
    control_adr:1,
    control_count:1,
    controls:[{ limited:false, range:null }],
    output_adr:1,
    output_count:1,
    activation_adr:-1,
    activation_count:0,
  });
  return value;
}

function policy(shas) {
  return {
    schema:'bskel.trust-artifact-policy/1',
    generation:24,
    allow:shas.map((sha256) => ({ usage:'helper', sha256 })),
    revoked:[],
  };
}

function helperBase() {
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

test('Q01 accepts one actuator with two controls, one output, zero activation', () => {
  const value=golden();
  value.model.counts.nu=2;
  value.model.actuators[0].control_count=2;
  value.model.actuators[0].controls=[
    { limited:true, range:[-1,1] },
    { limited:false, range:null },
  ];
  const result=validateMujocoEffectiveModelExport(value);
  assert.equal(result.model.counts.nactuator,1);
  assert.equal(result.model.counts.nu,2);
  assert.equal(result.model.counts.nout,1);
  assert.equal(result.model.counts.na,0);
  assert.equal(result.model.actuators.length,1);
});

test('Q02 zero-width actuator ranges require address -1', () => {
  for (const [countKey, adrKey, field] of [
    ['control_count','control_adr','control'],
    ['output_count','output_adr','output'],
    ['activation_count','activation_adr','activation'],
  ]) {
    const value=golden();
    if (field==='control') {
      value.model.counts.nu=0;
      value.model.actuators[0].controls=[];
    } else if (field==='output') {
      value.model.counts.nout=0;
    } else {
      value.model.counts.na=0;
    }
    value.model.actuators[0][countKey]=0;
    value.model.actuators[0][adrKey]=0;
    assert.throws(() => validateMujocoEffectiveModelExport(value), new RegExp('zero '+field+'_count'));
  }
});

test('Q03 nonzero actuator ranges require nonnegative addresses', () => {
  for (const [adrKey, field] of [
    ['control_adr','control'],
    ['output_adr','output'],
  ]) {
    const value=golden();
    value.model.actuators[0][adrKey]=-1;
    assert.throws(() => validateMujocoEffectiveModelExport(value), new RegExp('nonzero '+field+'_count'));
  }
  const stateful=golden();
  stateful.model.counts.na=1;
  stateful.model.actuators[0].activation_count=1;
  stateful.model.actuators[0].activation_adr=-1;
  assert.throws(() => validateMujocoEffectiveModelExport(stateful), /nonzero activation_count/);
});

test('Q04 control coverage rejects gaps overlaps and out-of-bounds ranges', () => {
  const gap=addSecondActuator(golden());
  gap.model.counts.nu=3;
  gap.model.counts.nout=2;
  gap.model.actuators[1].control_adr=2;
  assert.throws(() => validateMujocoEffectiveModelExport(gap), /control coverage is incomplete/);

  const overlap=addSecondActuator(golden());
  overlap.model.counts.nu=2;
  overlap.model.counts.nout=2;
  overlap.model.actuators[1].control_adr=0;
  assert.throws(() => validateMujocoEffectiveModelExport(overlap), /control ranges overlap/);

  const oob=golden();
  oob.model.actuators[0].control_adr=1;
  assert.throws(() => validateMujocoEffectiveModelExport(oob), /control range exceeds total/);
});

test('Q05 output coverage rejects gaps overlaps and out-of-bounds ranges', () => {
  const gap=addSecondActuator(golden());
  gap.model.counts.nu=2;
  gap.model.counts.nout=3;
  gap.model.actuators[1].output_adr=2;
  assert.throws(() => validateMujocoEffectiveModelExport(gap), /output coverage is incomplete/);

  const overlap=addSecondActuator(golden());
  overlap.model.counts.nu=2;
  overlap.model.counts.nout=2;
  overlap.model.actuators[1].output_adr=0;
  assert.throws(() => validateMujocoEffectiveModelExport(overlap), /output ranges overlap/);

  const oob=golden();
  oob.model.actuators[0].output_adr=1;
  assert.throws(() => validateMujocoEffectiveModelExport(oob), /output range exceeds total/);
});

test('Q06 activation coverage rejects gaps overlaps and out-of-bounds ranges', () => {
  const gap=addSecondActuator(golden());
  gap.model.counts.nu=2;
  gap.model.counts.nout=2;
  gap.model.counts.na=3;
  gap.model.actuators[0].activation_adr=0;
  gap.model.actuators[0].activation_count=1;
  gap.model.actuators[1].activation_adr=2;
  gap.model.actuators[1].activation_count=1;
  assert.throws(() => validateMujocoEffectiveModelExport(gap), /activation coverage is incomplete/);

  const overlap=addSecondActuator(golden());
  overlap.model.counts.nu=2;
  overlap.model.counts.nout=2;
  overlap.model.counts.na=2;
  overlap.model.actuators[0].activation_adr=0;
  overlap.model.actuators[0].activation_count=1;
  overlap.model.actuators[1].activation_adr=0;
  overlap.model.actuators[1].activation_count=1;
  assert.throws(() => validateMujocoEffectiveModelExport(overlap), /activation ranges overlap/);

  const oob=golden();
  oob.model.counts.na=1;
  oob.model.actuators[0].activation_adr=1;
  oob.model.actuators[0].activation_count=1;
  assert.throws(() => validateMujocoEffectiveModelExport(oob), /activation range exceeds total/);
});

test('Q07 free ball slide and hinge widths accept exact qpos-dof cardinalities', () => {
  for (const [type,qpos,dof] of [
    ['free',7,6],
    ['ball',4,3],
    ['slide',1,1],
    ['hinge',1,1],
  ]) {
    const value=golden();
    value.model.joints[0].type=type;
    value.model.joints[0].qpos_width=qpos;
    value.model.joints[0].dof_width=dof;
    value.model.counts.nq=qpos;
    value.model.counts.nv=dof;
    value.model.joints[0].limited=false;
    value.model.joints[0].range=null;
    assert.equal(validateMujocoEffectiveModelExport(value).model.joints[0].type,type);
  }
});

test('Q08 wrong joint widths fail closed for every supported joint type', () => {
  for (const [type,qpos,dof] of [
    ['free',7,6],
    ['ball',4,3],
    ['slide',1,1],
    ['hinge',1,1],
  ]) {
    const value=golden();
    value.model.joints[0].type=type;
    value.model.joints[0].qpos_width=qpos+1;
    value.model.joints[0].dof_width=dof;
    value.model.counts.nq=qpos+1;
    value.model.counts.nv=dof;
    value.model.joints[0].limited=false;
    value.model.joints[0].range=null;
    assert.throws(() => validateMujocoEffectiveModelExport(value), /widths do not match/);
  }
});

test('Q09 qpos coverage rejects gap and overlap independently', () => {
  const gap=golden();
  gap.model.counts.nq=2;
  assert.throws(() => validateMujocoEffectiveModelExport(gap), /qpos coverage is incomplete/);

  const overlap=golden();
  overlap.model.counts.njnt=2;
  overlap.model.counts.nq=2;
  overlap.model.counts.nv=2;
  overlap.model.joints.push({
    id:1,name:'j2',body_id:1,type:'hinge',
    qpos_adr:0,dof_adr:1,qpos_width:1,dof_width:1,limited:false,range:null,
  });
  assert.throws(() => validateMujocoEffectiveModelExport(overlap), /qpos ranges overlap/);
});

test('Q10 qvel coverage rejects gap and overlap independently', () => {
  const gap=golden();
  gap.model.counts.nv=2;
  assert.throws(() => validateMujocoEffectiveModelExport(gap), /qvel coverage is incomplete/);

  const overlap=golden();
  overlap.model.counts.njnt=2;
  overlap.model.counts.nq=2;
  overlap.model.counts.nv=2;
  overlap.model.joints.push({
    id:1,name:'j2',body_id:1,type:'hinge',
    qpos_adr:1,dof_adr:0,qpos_width:1,dof_width:1,limited:false,range:null,
  });
  assert.throws(() => validateMujocoEffectiveModelExport(overlap), /qvel ranges overlap/);
});

test('Q11 joints cannot bind world body or an out-of-range body', () => {
  const world=golden();
  world.model.joints[0].body_id=0;
  assert.throws(() => validateMujocoEffectiveModelExport(world), /non-world body/);

  const oob=golden();
  oob.model.joints[0].body_id=2;
  assert.throws(() => validateMujocoEffectiveModelExport(oob), /non-world body/);
});

test('Q12 limited joint ranges are required and finite', () => {
  const missing=golden();
  missing.model.joints[0].range=null;
  assert.throws(() => validateMujocoEffectiveModelExport(missing), /limited joint requires range/);

  for (const badRange of [[NaN,1],[-1,Infinity]]) {
    const value=golden();
    value.model.joints[0].range=badRange;
    assert.throws(() => validateMujocoEffectiveModelExport(value), /must be finite/);
  }
});

test('Q13 body graph rejects bad world parent self-parent and out-of-range parent', () => {
  const world=golden();
  world.model.bodies[0].parent_id=1;
  assert.throws(() => validateMujocoEffectiveModelExport(world), /world body parent_id must be 0/);

  const self=golden();
  self.model.bodies[1].parent_id=1;
  assert.throws(() => validateMujocoEffectiveModelExport(self), /cannot parent itself/);

  const oob=golden();
  oob.model.bodies[1].parent_id=2;
  assert.throws(() => validateMujocoEffectiveModelExport(oob), /parent_id is out of range/);
});

test('Q14 body graph rejects two-body and longer cycles', () => {
  const two=golden();
  two.model.counts.nbody=3;
  two.model.bodies=[
    { id:0,name:'world',parent_id:0 },
    { id:1,name:'a',parent_id:2 },
    { id:2,name:'b',parent_id:1 },
  ];
  assert.throws(() => validateMujocoEffectiveModelExport(two), /parent graph contains a cycle/);

  const long=golden();
  long.model.counts.nbody=4;
  long.model.bodies=[
    { id:0,name:'world',parent_id:0 },
    { id:1,name:'a',parent_id:2 },
    { id:2,name:'b',parent_id:3 },
    { id:3,name:'c',parent_id:1 },
  ];
  assert.throws(() => validateMujocoEffectiveModelExport(long), /parent graph contains a cycle/);
});

test('Q15 long acyclic body chain succeeds', () => {
  const value=golden();
  const n=4096;
  value.model.counts.nbody=n;
  value.model.bodies=Array.from({ length:n }, (_, id) => ({
    id,
    name:id===0?'world':'b'+id,
    parent_id:id===0?0:id-1,
  }));
  value.model.joints[0].body_id=n-1;
  value.model.geoms[0].body_id=n-1;
  value.model.sites[0].body_id=n-1;
  assert.equal(validateMujocoEffectiveModelExport(value).model.bodies.length,n);
});

test('Q16 unknown actuator transmission fails closed', () => {
  const value=golden();
  value.model.actuators[0].transmission_type='plugin-magic';
  assert.throws(() => validateMujocoEffectiveModelExport(value), /transmission_type is unsupported/);
});

test('Q17 joint and jointinparent targets must index joints with secondary -1', () => {
  for (const type of ['joint','jointinparent']) {
    const ok=golden();
    ok.model.actuators[0].transmission_type=type;
    ok.model.actuators[0].target_ids=[0,-1];
    assert.equal(validateMujocoEffectiveModelExport(ok).model.actuators[0].transmission_type,type);

    const badPrimary=golden();
    badPrimary.model.actuators[0].transmission_type=type;
    badPrimary.model.actuators[0].target_ids=[1,-1];
    assert.throws(() => validateMujocoEffectiveModelExport(badPrimary), /joint transmission target_ids are invalid/);

    const badSecondary=golden();
    badSecondary.model.actuators[0].transmission_type=type;
    badSecondary.model.actuators[0].target_ids=[0,0];
    assert.throws(() => validateMujocoEffectiveModelExport(badSecondary), /joint transmission target_ids are invalid/);
  }
});

test('Q18 tendon and body targets are range checked with secondary -1', () => {
  const tendon=golden();
  tendon.model.counts.ntendon=1;
  tendon.model.actuators[0].transmission_type='tendon';
  tendon.model.actuators[0].target_ids=[0,-1];
  assert.equal(validateMujocoEffectiveModelExport(tendon).model.actuators[0].transmission_type,'tendon');

  const badTendon=golden();
  badTendon.model.actuators[0].transmission_type='tendon';
  badTendon.model.actuators[0].target_ids=[0,-1];
  assert.throws(() => validateMujocoEffectiveModelExport(badTendon), /tendon transmission target_ids are invalid/);

  const body=golden();
  body.model.actuators[0].transmission_type='body';
  body.model.actuators[0].target_ids=[1,-1];
  assert.equal(validateMujocoEffectiveModelExport(body).model.actuators[0].transmission_type,'body');

  const badBody=golden();
  badBody.model.actuators[0].transmission_type='body';
  badBody.model.actuators[0].target_ids=[2,-1];
  assert.throws(() => validateMujocoEffectiveModelExport(badBody), /body transmission target_ids are invalid/);
});

test('Q19 slidercrank requires two valid sites and site allows only optional valid refsite', () => {
  const slider=golden();
  slider.model.actuators[0].transmission_type='slidercrank';
  slider.model.actuators[0].target_ids=[0,0];
  assert.equal(validateMujocoEffectiveModelExport(slider).model.actuators[0].transmission_type,'slidercrank');

  const badSlider=golden();
  badSlider.model.actuators[0].transmission_type='slidercrank';
  badSlider.model.actuators[0].target_ids=[0,-1];
  assert.throws(() => validateMujocoEffectiveModelExport(badSlider), /slidercrank site target_ids are invalid/);

  const site=golden();
  site.model.actuators[0].transmission_type='site';
  site.model.actuators[0].target_ids=[0,-1];
  assert.equal(validateMujocoEffectiveModelExport(site).model.actuators[0].transmission_type,'site');

  const badSite=golden();
  badSite.model.actuators[0].transmission_type='site';
  badSite.model.actuators[0].target_ids=[0,1];
  assert.throws(() => validateMujocoEffectiveModelExport(badSite), /site transmission target_ids are invalid/);
});

test('Q20 target ids reject negative values below documented -1', () => {
  const value=golden();
  value.model.actuators[0].target_ids=[0,-2];
  assert.throws(() => validateMujocoEffectiveModelExport(value), /two integers >= -1/);
});

test('Q21 sensor length address and dimension fail closed', () => {
  const length=golden();
  length.model.counts.nsensor=2;
  assert.throws(() => validateMujocoEffectiveModelExport(length), /model.sensors length must equal 2/);

  const adr=golden();
  adr.model.sensors[0].adr=-1;
  assert.throws(() => validateMujocoEffectiveModelExport(adr), /model.sensors\[0\].adr must be an integer/);

  const dim=golden();
  dim.model.sensors[0].dim=0;
  assert.throws(() => validateMujocoEffectiveModelExport(dim), /model.sensors\[0\].dim must be an integer/);
});

test('Q22 sensor data coverage rejects gaps overlaps and overflow', () => {
  const gap=golden();
  gap.model.counts.nsensor=2;
  gap.model.counts.nsensordata=3;
  gap.model.sensors.push({ id:1,name:'s2',type:'jointvel',object_type:'joint',object_id:0,adr:2,dim:1 });
  assert.throws(() => validateMujocoEffectiveModelExport(gap), /sensordata coverage is incomplete/);

  const overlap=golden();
  overlap.model.counts.nsensor=2;
  overlap.model.counts.nsensordata=2;
  overlap.model.sensors.push({ id:1,name:'s2',type:'jointvel',object_type:'joint',object_id:0,adr:0,dim:1 });
  assert.throws(() => validateMujocoEffectiveModelExport(overlap), /sensordata ranges overlap/);

  const overflow=golden();
  overflow.model.sensors[0].adr=1;
  assert.throws(() => validateMujocoEffectiveModelExport(overflow), /sensordata range exceeds total/);
});

test('Q23 sensor metadata strings and object id are bounded', () => {
  const empty=golden();
  empty.model.sensors[0].type='';
  assert.throws(() => validateMujocoEffectiveModelExport(empty), /bounded non-empty/);

  const control=golden();
  control.model.sensors[0].type='bad\nname';
  assert.throws(() => validateMujocoEffectiveModelExport(control), /bounded non-empty/);

  const object=golden();
  object.model.sensors[0].object_id=-2;
  assert.throws(() => validateMujocoEffectiveModelExport(object), /object_id must be >= -1/);
});

test('Q24 source closure requires root supports only include-asset and rejects duplicate logical paths', () => {
  const missing=golden();
  delete missing.source_bundle.root;
  assert.throws(() => validateMujocoEffectiveModelExport(missing), /missing required fields: root/);

  const role=golden();
  role.source_bundle.dependencies=[{
    path:'models/dep.xml',
    role:'generated',
    artifact:artifact('<mujoco/>','simulation-source','application/xml'),
  }];
  assert.throws(() => validateMujocoEffectiveModelExport(role), /role must be include or asset/);

  const duplicate=golden();
  duplicate.source_bundle.dependencies=[{
    path:'models/main.xml',
    role:'include',
    artifact:artifact('same','simulation-source','application/xml'),
  }];
  assert.throws(() => validateMujocoEffectiveModelExport(duplicate), /duplicate logical path/);
});

test('Q25 identical source bytes at different logical paths are allowed', () => {
  const value=golden();
  value.source_bundle.dependencies=[{
    path:'models/copy.xml',
    role:'include',
    artifact:value.source_bundle.root.artifact,
  }];
  const result=validateMujocoEffectiveModelExport(value);
  assert.equal(result.source_bundle.dependencies[0].artifact.sha256,result.source_bundle.root.artifact.sha256);
  assert.notEqual(result.source_bundle.dependencies[0].path,result.source_bundle.root.path);
});

test('Q26 source paths reject traversal absolute URI control and backslash forms', () => {
  for (const path of [
    '../main.xml',
    '/abs/main.xml',
    'file:main.xml',
    'https://example.com/main.xml',
    'models/bad\n.xml',
    'models\\main.xml',
    'models/./main.xml',
    'models//main.xml',
  ]) {
    const value=golden();
    value.source_bundle.root.path=path;
    assert.throws(() => validateMujocoEffectiveModelExport(value), /repo-relative POSIX path/);
  }
});

test('Q27 source count and ArtifactRef family-version are bounded', () => {
  const tooMany=golden();
  tooMany.source_bundle.dependencies=Array(10_000).fill(null);
  assert.throws(() => validateMujocoEffectiveModelExport(tooMany), /file-count limit/);

  const family=golden();
  family.source_bundle.root.artifact={...family.source_bundle.root.artifact,family:'simulation-contract'};
  assert.throws(() => validateMujocoEffectiveModelExport(family), /ArtifactRef.family must be simulation-source/);

  const version=golden();
  version.source_bundle.root.artifact={...version.source_bundle.root.artifact,version:'draft-2'};
  assert.throws(() => validateMujocoEffectiveModelExport(version), /ArtifactRef.version must be draft-1/);
});

test('Q28 claim boundary forces compiled and bound true while runtime and dynamic stay false', () => {
  const compiled=golden();
  compiled.claims.compiled_model_facts=false;
  assert.throws(() => validateMujocoEffectiveModelExport(compiled), /compiled_model_facts must be true/);

  const bound=golden();
  bound.claims.source_bundle_bound=false;
  assert.throws(() => validateMujocoEffectiveModelExport(bound), /source_bundle_bound must be true/);

  const runtime=golden();
  runtime.claims.runtime_behavior_verified=true;
  assert.throws(() => validateMujocoEffectiveModelExport(runtime), /cannot claim runtime behavior/);

  const dynamic=golden();
  dynamic.claims.dynamic_state_observed=true;
  assert.throws(() => validateMujocoEffectiveModelExport(dynamic), /cannot claim dynamic state observation/);

  const sourceVerified=golden();
  sourceVerified.claims.source_bundle_verified=true;
  assert.throws(() => validateMujocoEffectiveModelExport(sourceVerified), /unsupported fields/);
});

test('Q29 producer self-hash or extra authority fields are rejected', () => {
  const top=golden();
  top.producer_sha256='e'.repeat(64);
  assert.throws(() => validateMujocoEffectiveModelExport(top), /unsupported fields: producer_sha256/);

  const claim=golden();
  claim.claims.helper_execution_verified=true;
  assert.throws(() => validateMujocoEffectiveModelExport(claim), /unsupported fields/);
});

test('Q30 helper plan requires all exact roles and rejects duplicate role ids', () => {
  for (const missing of ['effective-model-helper','mujoco-runtime-closure','mujoco-native-library']) {
    const args=helperBase();
    args.assets=args.assets.filter((asset)=>asset.id!==missing);
    assert.throws(() => buildMujocoEffectiveModelHelperPlan(args), new RegExp(missing));
  }

  const duplicate=helperBase();
  duplicate.assets.push({ id:'effective-model-helper', sha256:HELPER });
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan(duplicate),
    (error) => error?.code === 'FIRST_PARTY_HELPER_ASSET_DUPLICATE',
  );
});

test('Q31 helper required roles and launcher cannot alias the same digest', () => {
  const roleAlias=helperBase();
  roleAlias.assets=roleAlias.assets.map((asset) =>
    asset.id==='mujoco-native-library' ? { ...asset, sha256:MUJOCO } : asset
  );
  assert.throws(() => buildMujocoEffectiveModelHelperPlan(roleAlias), /distinct exact-byte artifacts/);

  const launcherAlias=helperBase();
  launcherAlias.assets=launcherAlias.assets.map((asset) =>
    asset.id==='effective-model-helper' ? { ...asset, sha256:PYTHON } : asset
  );
  assert.throws(() => buildMujocoEffectiveModelHelperPlan(launcherAlias), /launcher bytes must be distinct/);
});

test('Q32 untrusted launcher runtime closure native library and revoked assets fail closed', () => {
  const launcher=helperBase();
  launcher.artifactTrustPolicy=policy([HELPER,MUJOCO,NATIVE]);
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan(launcher),
    (error) => error?.code === 'FIRST_PARTY_HELPER_LAUNCHER_UNTRUSTED',
  );

  for (const digest of [HELPER,MUJOCO,NATIVE]) {
    const args=helperBase();
    args.artifactTrustPolicy=policy([PYTHON,HELPER,MUJOCO,NATIVE].filter((sha)=>sha!==digest));
    assert.throws(
      () => buildMujocoEffectiveModelHelperPlan(args),
      (error) => error?.code === 'FIRST_PARTY_HELPER_ASSET_UNTRUSTED',
    );
  }

  const revoked=helperBase();
  revoked.artifactTrustPolicy={
    schema:'bskel.trust-artifact-policy/1',
    generation:25,
    allow:[
      { usage:'helper', sha256:PYTHON },
      { usage:'helper', sha256:HELPER },
      { usage:'helper', sha256:MUJOCO },
    ],
    revoked:[{ sha256:NATIVE, reason:'revoked by independent QA holdout' }],
  };
  assert.throws(
    () => buildMujocoEffectiveModelHelperPlan(revoked),
    (error) => error?.code === 'FIRST_PARTY_HELPER_ASSET_REVOKED',
  );
});

test('Q33 helper plan is fixed to approved-files deny-by-default runtime permissions', () => {
  const plan=buildMujocoEffectiveModelHelperPlan(helperBase());
  assert.equal(plan.schema,MUJOCO_EFFECTIVE_HELPER_PLAN);
  assert.equal(plan.helper_requirements.helper_class,'compiler-helper');
  assert.equal(plan.helper_requirements.input_mode,'approved-files');
  assert.equal(plan.helper_requirements.executable_now,false);
  assert.equal(plan.helper_requirements.runtime_binding_required,true);
  assert.equal(plan.helper_requirements.evidence_required,true);
  assert.equal(plan.helper_requirements.acquisition,null);
  assert.equal(plan.helper_requirements.target_code_execution,false);
  assert.deepEqual(plan.helper_requirements.runtime.permission_manifest.network,{ mode:'deny', allow:[] });
  assert.deepEqual(plan.helper_requirements.runtime.permission_manifest.write_roots,[]);
  assert.deepEqual(plan.helper_requirements.runtime.permission_manifest.environment,{ allow:[] });
  assert.deepEqual(plan.helper_requirements.runtime.permission_manifest.devices,{ mode:'deny', allow:[] });
  assert.deepEqual(plan.helper_requirements.runtime.permission_manifest.process,{
    mode:'argv-allowlist',
    executables:['python3'],
    max_children:1,
  });
});

test('Q34 unsupported caller widening knobs are rejected before plan construction', () => {
  for (const [field,value] of [
    ['acquisition',{ networkAllow:['example.com'] }],
    ['networkAllow',['example.com']],
    ['writeRoots',['scratch']],
    ['environment',['HOME']],
    ['targetCodeExecution',true],
  ]) {
    const args=helperBase();
    args[field]=value;
    assert.throws(
      () => buildMujocoEffectiveModelHelperPlan(args),
      /MuJoCo helper plan input has unsupported fields/,
    );
  }
});
