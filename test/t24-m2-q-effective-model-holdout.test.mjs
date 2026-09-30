import test from 'node:test';
import assert from 'node:assert/strict';

import { artifactRefForBytes } from '../adapters/sim-next/identity.mjs';
import {
  MUJOCO_EFFECTIVE_MODEL_SCHEMA,
  validateMujocoEffectiveModelExport,
} from '../adapters/sim-next/mujoco/effective-model.mjs';

function artifact(bytes, family, mediaType='application/octet-stream') {
  return artifactRefForBytes(Buffer.from(bytes), {
    family,
    version:'draft-1',
    mediaType,
  });
}

function baseModel() {
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
      version:'3.12.0',
      build:null,
      helper_artifact:artifact('helper','simulation-helper','text/x-python'),
    },
    model:{
      counts:{
        nbody:2,
        njnt:1,
        ngeom:1,
        nsite:2,
        ntendon:1,
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
          name:'j',
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
        { id:0, name:'s0', body_id:1 },
        { id:1, name:'s1', body_id:1 },
      ],
      actuators:[
        {
          id:0,
          name:'a',
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
        { id:0, name:'q', type:'jointpos', object_type:'joint', object_id:0, adr:0, dim:1 },
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

test('Q-M2 holdout: one actuator may carry two controls, one output and zero activation state', () => {
  const value=baseModel();
  value.model.counts.nu=2;
  value.model.counts.nactuator=1;
  value.model.counts.nout=1;
  value.model.counts.na=0;
  value.model.actuators[0].control_count=2;
  value.model.actuators[0].controls=[
    { limited:true, range:[-1,1] },
    { limited:false, range:null },
  ];
  const got=validateMujocoEffectiveModelExport(value);
  assert.equal(got.model.actuators.length,1);
  assert.equal(got.model.counts.nu,2);
  assert.equal(got.model.counts.nout,1);
  assert.equal(got.model.counts.na,0);
});

test('Q-M2 holdout: zero-width actuator ranges require adr=-1 for control/output/activation', () => {
  const valid=baseModel();
  valid.model.counts.nu=0;
  valid.model.counts.nout=0;
  valid.model.actuators[0].control_adr=-1;
  valid.model.actuators[0].control_count=0;
  valid.model.actuators[0].controls=[];
  valid.model.actuators[0].output_adr=-1;
  valid.model.actuators[0].output_count=0;
  assert.doesNotThrow(() => validateMujocoEffectiveModelExport(valid));

  for (const field of ['control','output','activation']) {
    const bad=structuredClone(valid);
    bad.model.actuators[0][field+'_adr']=0;
    assert.throws(
      () => validateMujocoEffectiveModelExport(bad),
      new RegExp('zero '+field+'_count must use '+field+'_adr=-1'),
    );
  }
});

test('Q-M2 holdout: nonzero actuator ranges reject negative adr', () => {
  for (const field of ['control','output']) {
    const bad=baseModel();
    bad.model.actuators[0][field+'_adr']=-1;
    assert.throws(
      () => validateMujocoEffectiveModelExport(bad),
      new RegExp('nonzero '+field+'_count requires '+field+'_adr'),
    );
  }
  const activation=baseModel();
  activation.model.counts.na=1;
  activation.model.actuators[0].activation_count=1;
  activation.model.actuators[0].activation_adr=-1;
  assert.throws(
    () => validateMujocoEffectiveModelExport(activation),
    /nonzero activation_count requires activation_adr/,
  );
});

function twoActuatorModel() {
  const value=baseModel();
  value.model.counts.nactuator=2;
  value.model.counts.nu=2;
  value.model.counts.nout=2;
  value.model.actuators[0].control_adr=0;
  value.model.actuators[0].output_adr=0;
  value.model.actuators.push({
    ...structuredClone(value.model.actuators[0]),
    id:1,
    name:'a1',
    control_adr:1,
    output_adr:1,
  });
  return value;
}

test('Q-M2 holdout: actuator control coverage rejects overlap and gaps', () => {
  const overlap=twoActuatorModel();
  overlap.model.actuators[1].control_adr=0;
  assert.throws(() => validateMujocoEffectiveModelExport(overlap), /control ranges overlap/);

  const gap=twoActuatorModel();
  gap.model.counts.nu=3;
  gap.model.actuators[1].control_adr=2;
  assert.throws(() => validateMujocoEffectiveModelExport(gap), /control coverage is incomplete/);
});

test('Q-M2 holdout: actuator output coverage rejects overlap, gaps and overflow', () => {
  const overlap=twoActuatorModel();
  overlap.model.actuators[1].output_adr=0;
  assert.throws(() => validateMujocoEffectiveModelExport(overlap), /output ranges overlap/);

  const gap=twoActuatorModel();
  gap.model.counts.nout=3;
  gap.model.actuators[1].output_adr=2;
  assert.throws(() => validateMujocoEffectiveModelExport(gap), /output coverage is incomplete/);

  const overflow=baseModel();
  overflow.model.actuators[0].output_adr=1;
  assert.throws(() => validateMujocoEffectiveModelExport(overflow), /output range exceeds total/);
});

test('Q-M2 holdout: free ball slide hinge joint widths are accepted exactly', () => {
  for (const [type,qpos,dof] of [
    ['free',7,6],
    ['ball',4,3],
    ['slide',1,1],
    ['hinge',1,1],
  ]) {
    const value=baseModel();
    value.model.joints[0].type=type;
    value.model.joints[0].qpos_width=qpos;
    value.model.joints[0].dof_width=dof;
    value.model.counts.nq=qpos;
    value.model.counts.nv=dof;
    assert.doesNotThrow(() => validateMujocoEffectiveModelExport(value), type);
  }
});

test('Q-M2 holdout: joint body/world, finite range and qpos/qvel exact coverage fail closed', () => {
  const world=baseModel();
  world.model.joints[0].body_id=0;
  assert.throws(() => validateMujocoEffectiveModelExport(world), /non-world body/);

  const oob=baseModel();
  oob.model.joints[0].body_id=2;
  assert.throws(() => validateMujocoEffectiveModelExport(oob), /non-world body/);

  const limited=baseModel();
  limited.model.joints[0].range=null;
  assert.throws(() => validateMujocoEffectiveModelExport(limited), /limited joint requires range/);

  const inf=baseModel();
  inf.model.joints[0].range=[-1,Infinity];
  assert.throws(() => validateMujocoEffectiveModelExport(inf), /must be finite/);

  const qposGap=baseModel();
  qposGap.model.counts.nq=2;
  assert.throws(() => validateMujocoEffectiveModelExport(qposGap), /qpos coverage is incomplete/);

  const qvelGap=baseModel();
  qvelGap.model.counts.nv=2;
  assert.throws(() => validateMujocoEffectiveModelExport(qvelGap), /qvel coverage is incomplete/);
});

test('Q-M2 holdout: body graph rejects invalid world parent, self-parent, cycles and out-of-range parent', () => {
  const world=baseModel();
  world.model.bodies[0].parent_id=1;
  assert.throws(() => validateMujocoEffectiveModelExport(world), /world body parent_id must be 0/);

  const self=baseModel();
  self.model.bodies[1].parent_id=1;
  assert.throws(() => validateMujocoEffectiveModelExport(self), /cannot parent itself/);

  const cycle=baseModel();
  cycle.model.counts.nbody=3;
  cycle.model.bodies=[
    { id:0,name:'world',parent_id:0 },
    { id:1,name:'b1',parent_id:2 },
    { id:2,name:'b2',parent_id:1 },
  ];
  assert.throws(() => validateMujocoEffectiveModelExport(cycle), /parent graph contains a cycle/);

  const oob=baseModel();
  oob.model.bodies[1].parent_id=2;
  assert.throws(() => validateMujocoEffectiveModelExport(oob), /parent_id is out of range/);
});

test('Q-M2 holdout: long acyclic body chain is accepted without recursion', () => {
  const value=baseModel();
  const n=5000;
  value.model.counts.nbody=n;
  value.model.bodies=Array.from({length:n},(_,id)=>({
    id,
    name:id===0?'world':`b${id}`,
    parent_id:id===0?0:id-1,
  }));
  value.model.joints[0].body_id=n-1;
  value.model.geoms[0].body_id=n-1;
  value.model.sites[0].body_id=n-1;
  value.model.sites[1].body_id=n-1;
  assert.equal(validateMujocoEffectiveModelExport(value).model.bodies.length,n);
});

test('Q-M2 holdout: reviewed transmission subset accepts exact target semantics', () => {
  const cases=[
    ['joint',[0,-1]],
    ['jointinparent',[0,-1]],
    ['tendon',[0,-1]],
    ['slidercrank',[0,1]],
    ['site',[0,-1]],
    ['site',[0,1]],
    ['body',[1,-1]],
  ];
  for (const [type,target_ids] of cases) {
    const value=baseModel();
    value.model.actuators[0].transmission_type=type;
    value.model.actuators[0].target_ids=target_ids;
    assert.doesNotThrow(() => validateMujocoEffectiveModelExport(value), type);
  }
});

test('Q-M2 holdout: unknown or malformed transmission targets fail closed', () => {
  const unknown=baseModel();
  unknown.model.actuators[0].transmission_type='plugin';
  assert.throws(() => validateMujocoEffectiveModelExport(unknown), /transmission_type is unsupported/);

  const jointSecondary=baseModel();
  jointSecondary.model.actuators[0].target_ids=[0,0];
  assert.throws(() => validateMujocoEffectiveModelExport(jointSecondary), /joint transmission target_ids are invalid/);

  const sliderMissing=baseModel();
  sliderMissing.model.actuators[0].transmission_type='slidercrank';
  sliderMissing.model.actuators[0].target_ids=[0,-1];
  assert.throws(() => validateMujocoEffectiveModelExport(sliderMissing), /slidercrank site target_ids are invalid/);

  const siteOob=baseModel();
  siteOob.model.actuators[0].transmission_type='site';
  siteOob.model.actuators[0].target_ids=[2,-1];
  assert.throws(() => validateMujocoEffectiveModelExport(siteOob), /site transmission target_ids are invalid/);
});

test('Q-M2 holdout: sensor metadata and sensordata coverage fail closed', () => {
  const badAdr=baseModel();
  badAdr.model.sensors[0].adr=-1;
  assert.throws(() => validateMujocoEffectiveModelExport(badAdr), /adr must be an integer/);

  const badDim=baseModel();
  badDim.model.sensors[0].dim=0;
  assert.throws(() => validateMujocoEffectiveModelExport(badDim), /dim must be an integer/);

  const badType=baseModel();
  badType.model.sensors[0].type='';
  assert.throws(() => validateMujocoEffectiveModelExport(badType), /bounded non-empty/);

  const badObject=baseModel();
  badObject.model.sensors[0].object_id=-2;
  assert.throws(() => validateMujocoEffectiveModelExport(badObject), /object_id must be >= -1/);

  const gap=baseModel();
  gap.model.counts.nsensordata=2;
  assert.throws(() => validateMujocoEffectiveModelExport(gap), /sensordata coverage is incomplete/);
});

test('Q-M2 holdout: source closure is path plus ArtifactRef and rejects path escapes', () => {
  const same=baseModel();
  same.source_bundle.dependencies=[{
    path:'models/copy.xml',
    role:'include',
    artifact:same.source_bundle.root.artifact,
  }];
  assert.doesNotThrow(() => validateMujocoEffectiveModelExport(same));

  const duplicate=baseModel();
  duplicate.source_bundle.dependencies=[{
    path:'models/main.xml',
    role:'asset',
    artifact:artifact('x','simulation-source'),
  }];
  assert.throws(() => validateMujocoEffectiveModelExport(duplicate), /duplicate logical path/);

  for (const path of ['../main.xml','/tmp/main.xml','file:main.xml','models//x.xml','models/./x.xml','models/\u0001x.xml','C:/tmp/x.xml']) {
    const bad=baseModel();
    bad.source_bundle.root.path=path;
    assert.throws(() => validateMujocoEffectiveModelExport(bad), /repo-relative POSIX path/);
  }
});

test('Q-M2 holdout: source ArtifactRef family/version and dependency roles fail closed', () => {
  const family=baseModel();
  family.source_bundle.root.artifact={...family.source_bundle.root.artifact,family:'simulation-contract'};
  assert.throws(() => validateMujocoEffectiveModelExport(family), /ArtifactRef.family must be simulation-source/);

  const version=baseModel();
  version.source_bundle.root.artifact={...version.source_bundle.root.artifact,version:'draft-2'};
  assert.throws(() => validateMujocoEffectiveModelExport(version), /ArtifactRef.version must be draft-1/);

  const role=baseModel();
  role.source_bundle.dependencies=[{
    path:'models/dep.xml',
    role:'generated',
    artifact:artifact('x','simulation-source'),
  }];
  assert.throws(() => validateMujocoEffectiveModelExport(role), /role must be include or asset/);
});

test('Q-M2 holdout: claim boundary rejects runtime/dynamic/source-verification authority and extra fields', () => {
  const runtime=baseModel();
  runtime.claims.runtime_behavior_verified=true;
  assert.throws(() => validateMujocoEffectiveModelExport(runtime), /cannot claim runtime behavior/);

  const dynamic=baseModel();
  dynamic.claims.dynamic_state_observed=true;
  assert.throws(() => validateMujocoEffectiveModelExport(dynamic), /cannot claim dynamic state observation/);

  const sourceVerified=baseModel();
  sourceVerified.claims.source_bundle_verified=true;
  assert.throws(() => validateMujocoEffectiveModelExport(sourceVerified), /unsupported fields/);

  const producerHash=baseModel();
  producerHash.producer_sha256='0'.repeat(64);
  assert.throws(() => validateMujocoEffectiveModelExport(producerHash), /unsupported fields/);
});
