import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactRefForBytes,
  assertArtifactRef,
  assertArtifactRefMatchesBytes,
  assertSimulationItemRef,
  assertSimulationItemRefShape,
} from '../../../adapters/sim-next/identity.mjs';
import {
  assertCoordinateSystem,
  assertQuantity,
  assertSimulationTiming,
  assertSimulationUnit,
} from '../../../adapters/sim-next/units.mjs';
import { fromLegacyBoolean } from '../../../scanners/capability-next/records.mjs';
import {
  CAPABILITY_STATUSES,
  SUPPORT_LEVELS,
  assertNoRuntimeCertificationFromStatic,
  evaluateSupportLevel,
  simulationCapabilityRecord,
} from '../../../adapters/sim-next/capabilities.mjs';

test('T01-compatible ArtifactRef binds exact bytes and rejects extras or stale content', () => {
  const bytes = Buffer.from('{"x":1}\n');
  const ref = artifactRefForBytes(bytes, { family: 'simulation-contract', version: 'draft-1', mediaType: 'application/json' });
  assert.equal(ref.artifact_ref, 'sbf.artifact-ref/1');
  assert.equal(assertArtifactRefMatchesBytes(ref, bytes).byte_sha256, ref.byte_sha256);
  assert.throws(() => assertArtifactRefMatchesBytes(ref, Buffer.from('{"x":1}')), /exact artifact bytes/);
  assert.throws(() => assertArtifactRef({ ...ref, extra: true }), /unsupported fields/);
});

test('SimulationItemRef shape validation is explicitly non-authoritative', () => {
  const contractBytes = Buffer.from('{"simulation_contract":"sbf.simulation-contract/draft-1"}\n');
  const contract_artifact = artifactRefForBytes(contractBytes, {
    family: 'simulation-contract',
    version: 'draft-1',
    mediaType: 'application/json',
  });
  const shaped = assertSimulationItemRefShape({
    simulation_item_ref: 'sbf.simulation-item-ref/draft-1',
    contract_artifact,
    item_kind: 'joint',
    item_id: 'joint:shoulder',
  });
  assert.equal(shaped.item_id, 'joint:shoulder');
  assert.equal(Object.hasOwn(shaped, 'authoritative'), false);
  assert.throws(
    () => assertSimulationItemRef(shaped),
    /authoritative SimulationItemRef requires exact contractBytes/,
  );
});

test('authoritative SimulationItemRef resolves exact membership and kind in the bound contract', () => {
  const contractBytes = Buffer.from(JSON.stringify({
    simulation_contract: 'sbf.simulation-contract/draft-1',
    identity: {
      target: 'SIM-mujoco',
      repository: 'fixture://simulation',
      revision: 'fixture-r1',
      contract_id: 'sim-contract:fixture:r1',
    },
    source_inputs: [{
      path: 'models/main.xml',
      role: 'active',
      artifact: {
        artifact_ref: 'sbf.artifact-ref/1',
        family: 'simulation-source',
        version: 'draft-1',
        media_type: 'application/xml',
        byte_sha256: '1'.repeat(64),
        size_bytes: 1,
      },
    }],
    model: {
      entities: [{ id: 'body:base', kind: 'body', source_locator: 'model/body:base' }],
      joints: [{ id: 'joint:shoulder' }],
      actuators: [{ id: 'actuator:shoulder' }],
      sensors: [{ id: 'sensor:shoulder' }],
      colliders: [{ id: 'geom:arm', kind: 'geom' }],
    },
    mapping: {
      state_channels: [{
        index: 0,
        semantic: 'joint_position',
        item_ref: 'joint:shoulder',
        dtype: 'float64',
        shape: [1],
        unit: 'rad',
      }],
      action_channels: [{
        index: 0,
        semantic: 'position_command',
        item_ref: 'actuator:shoulder',
        dtype: 'float64',
        shape: [1],
        unit: 'rad',
        scale: 1,
        offset: 0,
      }],
    },
    coordinates: {
      world_frame: 'world',
      up_axis: 'Z',
      handedness: 'right',
      quaternion_order: 'wxyz',
    },
    units: { length: 'm', angle: 'rad', force: 'N', torque: 'N*m', time: 's' },
    timing: { physics_dt: 0.002, control_dt: 0.02, decimation: 10, render_dt: null },
    physics: { backend: 'mujoco' },
    support: {
      capabilities: {},
      certification: {
        discovery: 'not-certified',
        contract: 'not-certified',
        runtime_tested: 'not-certified',
      },
      release_approved: false,
    },
    provenance: { producer: 'fixture' },
  }) + '\n');
  const contract_artifact = artifactRefForBytes(contractBytes, {
    family: 'simulation-contract',
    version: 'draft-1',
    mediaType: 'application/json',
  });

  const resolved = assertSimulationItemRef({
    simulation_item_ref: 'sbf.simulation-item-ref/draft-1',
    contract_artifact,
    item_kind: 'joint',
    item_id: 'joint:shoulder',
  }, { contractBytes });
  assert.equal(resolved.authoritative, true);

  assert.throws(
    () => assertSimulationItemRef({
      simulation_item_ref: 'sbf.simulation-item-ref/draft-1',
      contract_artifact,
      item_kind: 'joint',
      item_id: 'joint:not-there',
    }, { contractBytes }),
    /item identity not found/,
  );

  assert.throws(
    () => assertSimulationItemRef({
      simulation_item_ref: 'sbf.simulation-item-ref/draft-1',
      contract_artifact,
      item_kind: 'sensor',
      item_id: 'joint:shoulder',
    }, { contractBytes }),
    /item kind mismatch/,
  );
});

test('authoritative SimulationItemRef requires entity source locators from the frozen draft schema', () => {
  const contract = {
    simulation_contract: 'sbf.simulation-contract/draft-1',
    identity: {
      target: 'SIM-mujoco',
      repository: 'fixture://simulation',
      revision: 'fixture-r1',
      contract_id: 'sim-contract:fixture:r1',
    },
    source_inputs: [{
      path: 'models/main.xml',
      role: 'active',
      artifact: {
        artifact_ref: 'sbf.artifact-ref/1',
        family: 'simulation-source',
        version: 'draft-1',
        media_type: 'application/xml',
        byte_sha256: '1'.repeat(64),
        size_bytes: 1,
      },
    }],
    model: {
      entities: [{ id: 'body:base', kind: 'body' }],
      joints: [{ id: 'joint:shoulder' }],
      actuators: [],
      sensors: [],
      colliders: [],
    },
    mapping: { state_channels: [], action_channels: [] },
    coordinates: { world_frame: 'world', up_axis: 'Z', handedness: 'right', quaternion_order: 'wxyz' },
    units: { length: 'm', angle: 'rad', force: 'N', torque: 'N*m', time: 's' },
    timing: { physics_dt: 0.002, control_dt: 0.02, decimation: 10, render_dt: null },
    physics: { backend: 'mujoco' },
    support: {
      capabilities: {},
      certification: { discovery: 'not-certified', contract: 'not-certified', runtime_tested: 'not-certified' },
      release_approved: false,
    },
    provenance: { producer: 'fixture' },
  };
  const contractBytes = Buffer.from(JSON.stringify(contract) + '\n');
  const contract_artifact = artifactRefForBytes(contractBytes, {
    family: 'simulation-contract',
    version: 'draft-1',
    mediaType: 'application/json',
  });
  assert.throws(
    () => assertSimulationItemRef({
      simulation_item_ref: 'sbf.simulation-item-ref/draft-1',
      contract_artifact,
      item_kind: 'joint',
      item_id: 'joint:shoulder',
    }, { contractBytes }),
    /source_locator/,
  );
});

test('authoritative SimulationItemRef rejects an incomplete draft contract envelope', () => {
  const contractBytes = Buffer.from(JSON.stringify({
    simulation_contract: 'sbf.simulation-contract/draft-1',
    model: {
      entities: [],
      joints: [{ id: 'joint:present' }],
      actuators: [],
      sensors: [],
      colliders: [],
    },
  }) + '\n');
  const contract_artifact = artifactRefForBytes(contractBytes, {
    family: 'simulation-contract',
    version: 'draft-1',
    mediaType: 'application/json',
  });

  assert.throws(
    () => assertSimulationItemRef({
      simulation_item_ref: 'sbf.simulation-item-ref/draft-1',
      contract_artifact,
      item_kind: 'joint',
      item_id: 'joint:present',
    }, { contractBytes }),
    /missing required top-level group|missing required fields/,
  );
});

test('authoritative SimulationItemRef validates nested contract semantics fail-closed', () => {
  const base = {
    simulation_contract: 'sbf.simulation-contract/draft-1',
    identity: {
      target: 'SIM-mujoco',
      repository: 'fixture://simulation',
      revision: 'fixture-r1',
      contract_id: 'sim-contract:fixture:r1',
    },
    source_inputs: [{
      path: 'models/main.xml',
      role: 'active',
      artifact: {
        artifact_ref: 'sbf.artifact-ref/1',
        family: 'simulation-source',
        version: 'draft-1',
        media_type: 'application/xml',
        byte_sha256: '1'.repeat(64),
        size_bytes: 1,
      },
    }],
    model: {
      entities: [],
      joints: [{ id: 'joint:present' }],
      actuators: [],
      sensors: [],
      colliders: [],
    },
    mapping: { state_channels: [], action_channels: [] },
    coordinates: {
      world_frame: 'world',
      up_axis: 'Z',
      handedness: 'right',
      quaternion_order: 'wxyz',
    },
    units: { length: 'm', angle: 'rad', force: 'N', torque: 'N*m', time: 's' },
    timing: { physics_dt: 0.002, control_dt: 0.02, decimation: 10, render_dt: null },
    physics: { backend: 'mujoco' },
    support: {
      capabilities: {},
      certification: {
        discovery: 'not-certified',
        contract: 'not-certified',
        runtime_tested: 'not-certified',
      },
      release_approved: false,
    },
    provenance: { producer: 'fixture' },
  };

  for (const mutate of [
    (contract) => { delete contract.source_inputs[0].artifact; },
    (contract) => { contract.coordinates.up_axis = 'SIDEWAYS'; },
    (contract) => { contract.units.length = 'cm'; },
    (contract) => { contract.support.certification = {}; },
  ]) {
    const contract = structuredClone(base);
    mutate(contract);
    const contractBytes = Buffer.from(JSON.stringify(contract) + '\n');
    const contract_artifact = artifactRefForBytes(contractBytes, {
      family: 'simulation-contract',
      version: 'draft-1',
      mediaType: 'application/json',
    });
    assert.throws(
      () => assertSimulationItemRef({
        simulation_item_ref: 'sbf.simulation-item-ref/draft-1',
        contract_artifact,
        item_kind: 'joint',
        item_id: 'joint:present',
      }, { contractBytes }),
      /artifact|coordinates|units|support|certification|required|invalid/i,
    );
  }
});

test('authoritative SimulationItemRef rejects unsafe source paths and malformed mapping channels', () => {
  const makeBase = () => ({
    simulation_contract: 'sbf.simulation-contract/draft-1',
    identity: {
      target: 'SIM-mujoco',
      repository: 'fixture://simulation',
      revision: 'fixture-r1',
      contract_id: 'sim-contract:fixture:r1',
    },
    source_inputs: [{
      path: 'models/main.xml',
      role: 'active',
      artifact: {
        artifact_ref: 'sbf.artifact-ref/1',
        family: 'simulation-source',
        version: 'draft-1',
        media_type: 'application/xml',
        byte_sha256: '1'.repeat(64),
        size_bytes: 1,
      },
    }],
    model: {
      entities: [],
      joints: [{ id: 'joint:present' }],
      actuators: [],
      sensors: [],
      colliders: [],
    },
    mapping: { state_channels: [], action_channels: [] },
    coordinates: {
      world_frame: 'world',
      up_axis: 'Z',
      handedness: 'right',
      quaternion_order: 'wxyz',
    },
    units: { length: 'm', angle: 'rad', force: 'N', torque: 'N*m', time: 's' },
    timing: { physics_dt: 0.002, control_dt: 0.02, decimation: 10, render_dt: null },
    physics: { backend: 'mujoco' },
    support: {
      capabilities: {},
      certification: {
        discovery: 'not-certified',
        contract: 'not-certified',
        runtime_tested: 'not-certified',
      },
      release_approved: false,
    },
    provenance: { producer: 'fixture' },
  });

  for (const badPath of ['../escape.xml', '/abs/model.xml', 'C:/model.xml', 'models\\main.xml']) {
    const contract = makeBase();
    contract.source_inputs[0].path = badPath;
    const contractBytes = Buffer.from(JSON.stringify(contract) + '\n');
    const contract_artifact = artifactRefForBytes(contractBytes, {
      family: 'simulation-contract',
      version: 'draft-1',
      mediaType: 'application/json',
    });
    assert.throws(
      () => assertSimulationItemRef({
        simulation_item_ref: 'sbf.simulation-item-ref/draft-1',
        contract_artifact,
        item_kind: 'joint',
        item_id: 'joint:present',
      }, { contractBytes }),
      /source_inputs|path|repo-relative|parent|invalid/i,
    );
  }

  const malformed = makeBase();
  malformed.mapping.action_channels = [{
    index: -1,
    semantic: '',
    item_ref: '',
    dtype: '',
    shape: [0],
    unit: 'degrees',
  }];
  const malformedBytes = Buffer.from(JSON.stringify(malformed) + '\n');
  const malformedArtifact = artifactRefForBytes(malformedBytes, {
    family: 'simulation-contract',
    version: 'draft-1',
    mediaType: 'application/json',
  });
  assert.throws(
    () => assertSimulationItemRef({
      simulation_item_ref: 'sbf.simulation-item-ref/draft-1',
      contract_artifact: malformedArtifact,
      item_kind: 'joint',
      item_id: 'joint:present',
    }, { contractBytes: malformedBytes }),
    /mapping|channel|index|semantic|item_ref|dtype|shape|unit|invalid/i,
  );
});

test('units keep length, angle, force, torque and time dimensions distinct', () => {
  assert.equal(assertSimulationUnit('rad', { dimension: 'angle' }), 'rad');
  assert.throws(() => assertSimulationUnit('rad', { dimension: 'force' }), /expected force/);
  assert.throws(() => assertSimulationUnit('cm'), /unsupported simulation unit/);
  assert.deepEqual(assertQuantity({ value: 0.12, unit: 'm', frame: 'world' }, { dimension: 'length', frameRequired: true }), { value: 0.12, unit: 'm', frame: 'world' });
  assert.throws(() => assertQuantity({ value: 12, unit: 'N' }, { dimension: 'length' }), /expected length/);
});

test('coordinate and timing contracts distinguish physics/control/render clocks', () => {
  assert.deepEqual(assertCoordinateSystem({ world_frame: 'world', up_axis: 'Z', handedness: 'right', quaternion_order: 'wxyz' }), { world_frame: 'world', up_axis: 'Z', handedness: 'right', quaternion_order: 'wxyz' });
  assert.deepEqual(assertSimulationTiming({ physics_dt: 0.002, control_dt: 0.02, decimation: 10, render_dt: null }), { physics_dt: 0.002, control_dt: 0.02, decimation: 10, render_dt: null });
  assert.throws(() => assertSimulationTiming({ physics_dt: 0, control_dt: 0.02, decimation: 10 }), /positive finite/);
});

test('T03 status vocabulary is reused and caller-crafted evidence cannot mint supported', () => {
  assert.deepEqual(CAPABILITY_STATUSES, ['supported','partial','unsupported','unknown','not-applicable']);
  assert.deepEqual(SUPPORT_LEVELS, ['discovery','contract','runtime-tested']);

  assert.throws(
    () => simulationCapabilityRecord({
      name: 'simulation.discovery',
      status: 'supported',
      evidence: [{ verified: true, capability: 'simulation.discovery', evidence_id: 'caller-forged' }],
    }),
    /T03 evidence verifier|verified capability evidence receipts|evidence\[0\]/,
  );

  const partial = simulationCapabilityRecord({
    name: 'simulation.runtime',
    status: 'partial',
    reason: 'runtime profile not accepted',
  });
  assert.equal(partial.status, 'partial');
});

test('support evaluation consumes opaque T03-produced records and never accepts partial/unknown', () => {
  const capabilities = {
    'simulation.discovery': simulationCapabilityRecord({
      name: 'simulation.discovery',
      status: 'unknown',
      reason: 'no reviewed semantic verifier has granted supported',
    }),
    'simulation.runtime': simulationCapabilityRecord({
      name: 'simulation.runtime',
      status: 'partial',
      reason: 'runtime profile not accepted',
    }),
  };
  assert.equal(
    evaluateSupportLevel({
      level: 'runtime-tested',
      capabilityNames: ['simulation.discovery','simulation.runtime'],
      capabilities,
    }).ok,
    false,
  );

  assert.throws(
    () => evaluateSupportLevel({
      level: 'discovery',
      capabilityNames: ['simulation.discovery'],
      capabilities: {
        'simulation.discovery': {
          name: 'simulation.discovery',
          status: 'supported',
          evidenceRefs: [],
        },
      },
    }),
    /supported simulation capability|must be produced by capabilityRecord/,
  );
});

test('T03 legacy boolean bridge cannot authorize simulation.* supported state', () => {
  const legacy = fromLegacyBoolean('simulation.discovery', true);
  assert.throws(
    () => evaluateSupportLevel({
      level: 'discovery',
      capabilityNames: ['simulation.discovery'],
      capabilities: { 'simulation.discovery': legacy },
    }),
    /legacy boolean bridges do not authorize simulation/,
  );
});

test('runtime-tested stays blocked even when caller supplies the old magic authority string', () => {
  assert.equal(assertNoRuntimeCertificationFromStatic({ runtimeTested: false, evidenceKind: 'static' }), true);
  assert.throws(
    () => assertNoRuntimeCertificationFromStatic({
      runtimeTested: true,
      evidenceKind: 't16-runtime-plus-t19-acceptance',
    }),
    /runtime-tested requires exact T16 runtime-execution evidence plus independent T19 acceptance/,
  );
});
