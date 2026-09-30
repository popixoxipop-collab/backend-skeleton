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
    model: {
      entities: [{ id: 'body:base', kind: 'body' }],
      joints: [{ id: 'joint:shoulder' }],
      actuators: [{ id: 'actuator:shoulder' }],
      sensors: [{ id: 'sensor:shoulder' }],
      colliders: [{ id: 'geom:arm', kind: 'geom' }],
    },
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
    /must be produced by capabilityRecord/,
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
