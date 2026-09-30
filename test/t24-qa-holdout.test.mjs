import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  artifactRefForBytes,
  assertArtifactRefMatchesBytes,
  assertSimulationItemRef,
} from '../adapters/sim-next/identity.mjs';
import {
  assertNoRuntimeCertificationFromStatic,
  evaluateSupportLevel,
  simulationCapabilityRecord,
} from '../adapters/sim-next/capabilities.mjs';
import {
  discoverMujocoSource,
} from '../adapters/sim-next/mujoco/discover.mjs';
import {
  parseMjcfSource,
  validateMujocoDependencyGraph,
} from '../adapters/sim-next/mujoco/mjcf-source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function fixture(name) {
  return fs.readFileSync(path.join(HERE, 'sim-next', 'qa', 'fixtures', name));
}

test('Q01 exact-byte simulation identity rejects formatting-only substitution', () => {
  const a = Buffer.from('{"simulation_contract":"draft"}\n', 'utf8');
  const b = Buffer.from('{"simulation_contract":"draft"}', 'utf8');
  const ref = artifactRefForBytes(a, {
    family: 'simulation-contract',
    version: 'draft-1',
    mediaType: 'application/json',
  });
  assert.equal(assertArtifactRefMatchesBytes(ref, a).size_bytes, a.length);
  assert.throws(() => assertArtifactRefMatchesBytes(ref, b), /exact artifact bytes/);
});

test('Q02 capability evidence cannot mint supported/runtime-tested from wrong scope or static proof', () => {
  assert.throws(
    () => simulationCapabilityRecord({
      name: 'simulation.discovery',
      status: 'supported',
      evidence: [{ verified: true, capability: 'simulation.runtime', evidence_id: 'q:wrong-scope' }],
    }),
    /T03 evidence verifier|verified capability evidence receipts|scope mismatch|evidence\[0\]/,
  );

  const caps = {
    'simulation.discovery': {
      name: 'simulation.discovery',
      status: 'supported',
      evidence: [{ verified: true, capability: 'simulation.discovery', evidence_id: 'q:discovery' }],
    },
    'simulation.runtime': {
      name: 'simulation.runtime',
      status: 'unknown',
      reason: 'no runtime execution evidence',
    },
  };
  assert.throws(
    () => evaluateSupportLevel({
      level: 'runtime-tested',
      capabilityNames: ['simulation.discovery', 'simulation.runtime'],
      capabilities: caps,
    }),
    /verifier-issued evidence|legacy boolean bridges|capability record|produced by capabilityRecord/i,
  );
  assert.throws(
    () => assertNoRuntimeCertificationFromStatic({ runtimeTested: true, evidenceKind: 'source-parser' }),
    /T16 runtime execution evidence plus independent T19 acceptance/,
  );
});

test('Q03 nested defaults/freejoint/world geometry stay source declarations only', () => {
  const parsed = parseMjcfSource(fixture('nested-default.xml'), { path: 'holdout/nested-default.xml' });
  assert.equal(parsed.model.name, 'q-nested-default');
  assert.equal(parsed.declarations.defaults.length, 2);
  assert.ok(parsed.declarations.defaults.some((d) =>
    d.class_name === 'root' && d.templates?.some((x) => x.tag === 'joint')));
  assert.ok(parsed.declarations.defaults.some((d) =>
    d.class_name === 'child' && d.templates?.some((x) => x.tag === 'geom')));
  assert.ok(parsed.declarations.joints.some((j) =>
    j.name === 'root_free' && j.joint_type === 'free' && j.source_syntax === 'freejoint'));
  assert.ok(parsed.declarations.geoms.some((g) =>
    g.name === 'floor' && g.parent_scope === 'world' && g.parent_body_id === null));
  assert.equal(parsed.claims.declared_structure_only, true);
  assert.equal(parsed.claims.effective_model_verified, false);
  assert.equal(parsed.claims.runtime_behavior_verified, false);
  assert.equal(parsed.claims.causal_edges_verified, false);
});

test('Q04 include path and asset path semantics are separated instead of guessed together', () => {
  const parsed = parseMjcfSource(fixture('include-assets.xml'), { path: 'models/main.xml' });
  const include = parsed.dependencies.find((d) => d.kind === 'include');
  const asset = parsed.dependencies.find((d) => d.kind === 'asset');
  assert.equal(include.path, 'parts/arm.xml');
  assert.equal(include.resolved_path, 'models/parts/arm.xml');
  assert.equal(include.status, 'unresolved');
  assert.equal(asset.path, 'arm.stl');
  assert.equal(asset.resolution_basis, 'compiler-dependent');
  assert.equal(Object.hasOwn(asset, 'resolved_path'), false);
  const compiler = parsed.declarations.compiler[0].attributes;
  assert.equal(compiler.assetdir, 'assets');
  assert.equal(compiler.meshdir, '../meshes');
  assert.equal(compiler.texturedir, 'textures');
});

test('Q05 include graph uses main-MJCF-relative semantics and still detects a cycle', () => {
  assert.deepEqual(
    validateMujocoDependencyGraph({
      rootPath: 'models/main.xml',
      edges: [
        { from: 'models/main.xml', to: 'parts/a.xml' },
        { from: 'models/parts/a.xml', to: 'parts/b.xml' },
      ],
    }).nodes,
    ['models/main.xml', 'models/parts/a.xml', 'models/parts/b.xml'],
  );

  assert.throws(
    () => validateMujocoDependencyGraph({
      rootPath: 'models/main.xml',
      edges: [
        { from: 'models/main.xml', to: 'parts/a.xml' },
        { from: 'models/parts/a.xml', to: 'main.xml' },
      ],
    }),
    /dependency cycle detected/,
  );
});

test('Q06 high-risk extension/plugin/frame syntax is diagnostic, never executed or promoted', () => {
  const parsed = parseMjcfSource(fixture('high-risk.xml'), { path: 'holdout/high-risk.xml' });
  const risky = new Set(
    parsed.diagnostics
      .filter((d) => d.code === 'MUJOCO_UNMODELED_HIGH_RISK_ELEMENT')
      .map((d) => d.element),
  );
  assert.equal(risky.has('extension'), true);
  assert.equal(risky.has('plugin'), true);
  assert.equal(risky.has('frame'), true);
  assert.equal(parsed.claims.runtime_behavior_verified, false);
});

test('Q07 arbitrary XML is not promoted to SIM-mujoco', () => {
  assert.equal(discoverMujocoSource(
    '<robot name="urdf-like"><link name="base"/></robot>',
    { path: 'models/robot.xml' },
  ).detected, false);
  assert.equal(discoverMujocoSource(
    '<?xml version="1.0"?><!-- q --><mujoco model="yes"/>',
    { path: 'models/real.xml' },
  ).detected, true);
});

test('Q10 ordinary joint and geom types remain undeclared source facts', () => {
  const raw = '<mujoco><worldbody><body name="b"><joint name="j"/><geom name="g" size="0.1"/></body></worldbody></mujoco>';
  const parsed = parseMjcfSource(raw, { path: 'holdout/default-types.xml' });
  assert.equal(parsed.declarations.joints[0].joint_type, null);
  assert.equal(parsed.declarations.geoms[0].geom_type, null);
  assert.equal(parsed.claims.effective_model_verified, false);
});

test('Q08 source slice has no target execution/network surface', () => {
  for (const rel of [
    'adapters/sim-next/mujoco/discover.mjs',
    'adapters/sim-next/mujoco/mjcf-source.mjs',
  ]) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(code, /node:child_process|from ['"]child_process['"]|\bspawn\s*\(|\bexec\s*\(|\bfetch\s*\(/);
  }
});

test('Q11 path policy rejects escape/absolute/backslash/URI while safe dot include normalizes', () => {
  for (const ref of ['../escape.xml', '/tmp/x.xml', 'C:/x.xml', 'x\\y.xml', 'https://example.invalid/x.xml']) {
    assert.throws(
      () => parseMjcfSource(`<mujoco><include file="${ref}"/></mujoco>`, { path: 'holdout/main.xml' }),
      /repo-relative|parent|URI scheme/,
    );
  }
  const safe = parseMjcfSource('<mujoco><include file="./parts.xml"/></mujoco>', { path: 'holdout/main.xml' });
  assert.equal(safe.dependencies[0].resolved_path, 'holdout/parts.xml');
});

test('Q12 invalid UTF-8 and XML external-declaration surfaces fail closed', () => {
  assert.throws(
    () => parseMjcfSource(Buffer.from([0xff, 0xfe]), { path: 'holdout/bad.xml' }),
    /valid UTF-8/,
  );
  assert.throws(
    () => parseMjcfSource('<!DOCTYPE mujoco [<!ENTITY x SYSTEM "file:///etc/passwd">]><mujoco/>', { path: 'holdout/bad.xml' }),
    /DOCTYPE|ENTITY/,
  );
});

test('Q13 parser budgets fail closed instead of silently truncating', () => {
  assert.throws(
    () => parseMjcfSource('<mujoco><worldbody/></mujoco>', { path: 'holdout/b.xml', maxBytes: 4 }),
    /byte budget/,
  );
  assert.throws(
    () => parseMjcfSource('<mujoco><worldbody><body/></worldbody></mujoco>', { path: 'holdout/d.xml', maxDepth: 1 }),
    /depth budget/,
  );
  assert.throws(
    () => parseMjcfSource('<mujoco><worldbody/></mujoco>', { path: 'holdout/e.xml', maxElements: 1 }),
    /element budget/,
  );
  assert.throws(
    () => parseMjcfSource('<mujoco><include file="a.xml"/><include file="b.xml"/></mujoco>', {
      path: 'holdout/deps.xml',
      maxDependencies: 1,
    }),
    /dependency budget/,
  );
});

test('Q14 include graph rejects duplicate target and disconnected subgraph', () => {
  assert.throws(
    () => validateMujocoDependencyGraph({
      rootPath: 'q/main.xml',
      edges: [
        { from: 'q/main.xml', to: 'same.xml' },
        { from: 'q/main.xml', to: 'same.xml' },
      ],
    }),
    /same XML more than once/,
  );
  assert.throws(
    () => validateMujocoDependencyGraph({
      rootPath: 'q/main.xml',
      edges: [
        { from: 'q/main.xml', to: 'a.xml' },
        { from: 'q/orphan.xml', to: 'child.xml' },
      ],
    }),
    /not reachable from root/,
  );
});

test('Q15 all currently high-risk procedural/plugin tags remain diagnostics only', () => {
  const raw = `<mujoco>
    <extension><plugin plugin="q.plugin"/></extension>
    <worldbody><body name="b">
      <frame name="f"/>
      <replicate count="2"/>
      <composite type="rope"/>
      <flexcomp name="fc"/>
      <attach body="x"/>
    </body></worldbody>
  </mujoco>`;
  const parsed = parseMjcfSource(raw, { path: 'holdout/risky-all.xml' });
  const got = new Set(parsed.diagnostics
    .filter((d) => d.code === 'MUJOCO_UNMODELED_HIGH_RISK_ELEMENT')
    .map((d) => d.element));
  for (const tag of ['extension','plugin','frame','replicate','composite','flexcomp','attach']) {
    assert.equal(got.has(tag), true, `missing diagnostic for ${tag}`);
  }
  assert.equal(parsed.claims.runtime_behavior_verified, false);
});

test('Q16 deterministic parse preserves source order rather than alphabetic runtime guesses', () => {
  const raw = `<mujoco><worldbody><body name="b"><joint name="j"/></body></worldbody>
    <actuator><motor name="z_last" joint="j"/><motor name="a_first" joint="j"/></actuator>
    <sensor><jointpos name="z_sensor" joint="j"/><jointvel name="a_sensor" joint="j"/></sensor>
  </mujoco>`;
  const a = parseMjcfSource(raw, { path: 'holdout/order.xml' });
  const b = parseMjcfSource(raw, { path: 'holdout/order.xml' });
  assert.deepEqual(a, b);
  assert.deepEqual(a.declarations.actuators.map((x) => x.name), ['z_last','a_first']);
  assert.deepEqual(a.declarations.sensors.map((x) => x.name), ['z_sensor','a_sensor']);
});

test('Q17 duplicate source identities in a covered class fail closed', () => {
  const raw = `<mujoco><sensor>
    <jointpos name="dup" joint="a"/>
    <jointvel name="dup" joint="b"/>
  </sensor></mujoco>`;
  assert.throws(() => parseMjcfSource(raw, { path: 'holdout/dup.xml' }), /duplicate sensor name/);
});

test('Q18 caller-crafted plain evidence cannot mint supported capability', () => {
  assert.throws(
    () => simulationCapabilityRecord({
      name: 'simulation.discovery',
      status: 'supported',
      evidence: [{
        verified: true,
        capability: 'simulation.discovery',
        evidence_id: 'caller-forged',
      }],
    }),
    /verifier|opaque|authority|receipt/i,
  );
});

test('Q19 magic evidenceKind string cannot mint runtime-tested certification', () => {
  assert.throws(
    () => assertNoRuntimeCertificationFromStatic({
      runtimeTested: true,
      evidenceKind: 't16-runtime-plus-t19-acceptance',
    }),
    /runtime|evidence|certification/i,
  );
});

test('Q20 SimulationItemRef must reject an item id absent from the bound contract', () => {
  const contractBytes = Buffer.from(JSON.stringify({
    simulation_contract: 'sbf.simulation-contract/draft-1',
    model: {
      entities: [],
      joints: [],
      actuators: [],
      sensors: [],
      colliders: [],
    },
  }) + '\n', 'utf8');

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
      item_id: 'joint:not-there',
    }, { contractBytes }),
    /item|identity|contract|not found/i,
  );
});

test('Q21 invalid XML NUL character reference is rejected fail-closed', () => {
  assert.throws(
    () => parseMjcfSource('<mujoco model="&#0;"/>', { path: 'holdout/nul-ref.xml' }),
    /XML|character|codepoint|invalid/i,
  );
});

function qFullDraftContract() {
  return {
    simulation_contract: 'sbf.simulation-contract/draft-1',
    identity: {
      target: 'SIM-mujoco',
      repository: 'fixture://q',
      revision: 'q-r1',
      contract_id: 'sim-contract:q:r1',
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
    provenance: { producer: { id: 'q-fixture' } },
  };
}

test('Q22-positive full frozen draft contract can resolve an authoritative item', () => {
  const contractBytes = Buffer.from(JSON.stringify(qFullDraftContract()) + '\n', 'utf8');
  const contract_artifact = artifactRefForBytes(contractBytes, {
    family: 'simulation-contract',
    version: 'draft-1',
    mediaType: 'application/json',
  });
  const resolved = assertSimulationItemRef({
    simulation_item_ref: 'sbf.simulation-item-ref/draft-1',
    contract_artifact,
    item_kind: 'joint',
    item_id: 'joint:present',
  }, { contractBytes });
  assert.equal(resolved.authoritative, true);
});

test('Q27 authoritative contract requires entity source locators', () => {
  const contract = qFullDraftContract();
  delete contract.model.entities[0].source_locator;
  const contractBytes = Buffer.from(JSON.stringify(contract) + '\n', 'utf8');
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
    /source_locator/,
  );
});

test('Q22a authoritative ItemRef requires source-input ArtifactRef semantics', () => {
  const contract = qFullDraftContract();
  contract.source_inputs = [{ path: 'models/main.xml', role: 'active' }];
  const contractBytes = Buffer.from(JSON.stringify(contract) + '\n', 'utf8');
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
    /source_inputs|artifact|ArtifactRef|required/i,
  );
});

test('Q22b authoritative ItemRef rejects invalid coordinate and unit vocabularies', () => {
  const contract = qFullDraftContract();
  contract.coordinates.up_axis = 'SIDEWAYS';
  contract.units.length = 'cm';
  const contractBytes = Buffer.from(JSON.stringify(contract) + '\n', 'utf8');
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
    /coordinates|up_axis|units|length|enum|invalid/i,
  );
});

test('Q22c authoritative ItemRef requires fail-closed support/certification shape', () => {
  const contract = qFullDraftContract();
  contract.support = { capabilities: {}, certification: {}, release_approved: false };
  const contractBytes = Buffer.from(JSON.stringify(contract) + '\n', 'utf8');
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
    /support|certification|discovery|contract|runtime_tested|required/i,
  );
});

test('Q22d authoritative contract source-input paths are repo-relative and traversal-safe', () => {
  for (const badPath of ['../escape.xml', '/abs/model.xml', 'C:/model.xml', 'models\\main.xml']) {
    const contract = qFullDraftContract();
    contract.source_inputs[0].path = badPath;
    const contractBytes = Buffer.from(JSON.stringify(contract) + '\n', 'utf8');
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
      /source_inputs|path|repo-relative|parent|absolute|invalid/i,
    );
  }
});

test('Q22e authoritative contract rejects malformed mapping channels', () => {
  const contract = qFullDraftContract();
  contract.mapping.action_channels = [{
    index: -1,
    semantic: '',
    item_ref: '',
    dtype: '',
    shape: [0],
    unit: 'degrees',
  }];
  const contractBytes = Buffer.from(JSON.stringify(contract) + '\n', 'utf8');
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
    /mapping|channel|index|semantic|item_ref|dtype|shape|unit|invalid/i,
  );
});

test('Q22 authoritative ItemRef rejects an incomplete draft contract envelope', () => {
  const contractBytes = Buffer.from(JSON.stringify({
    simulation_contract: 'sbf.simulation-contract/draft-1',
    model: {
      entities: [],
      joints: [{ id: 'joint:present' }],
      actuators: [],
      sensors: [],
      colliders: [],
    },
  }) + '\n', 'utf8');

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
    /contract|identity|mapping|coordinates|units|timing|physics|support|provenance|required/i,
  );

  const malformedEnvelopeBytes = Buffer.from(JSON.stringify({
    simulation_contract: 'sbf.simulation-contract/draft-1',
    identity: 'not-an-object',
    source_inputs: [],
    model: {
      entities: [],
      joints: [{ id: 'joint:present' }],
      actuators: [],
      sensors: [],
      colliders: [],
    },
    mapping: null,
    coordinates: [],
    units: 'SI-ish',
    timing: {},
    physics: null,
    support: null,
    provenance: null,
  }) + '\n', 'utf8');

  const malformed_artifact = artifactRefForBytes(malformedEnvelopeBytes, {
    family: 'simulation-contract',
    version: 'draft-1',
    mediaType: 'application/json',
  });

  assert.throws(
    () => assertSimulationItemRef({
      simulation_item_ref: 'sbf.simulation-item-ref/draft-1',
      contract_artifact: malformed_artifact,
      item_kind: 'joint',
      item_id: 'joint:present',
    }, { contractBytes: malformedEnvelopeBytes }),
    /contract|identity|source_inputs|mapping|coordinates|units|timing|physics|support|provenance|object|array/i,
  );
});

test('Q23a XML comment containing internal double-hyphen fails closed', () => {
  assert.throws(
    () => parseMjcfSource('<mujoco><!-- bad -- comment --></mujoco>', { path: 'holdout/bad-comment.xml' }),
    /XML|comment|malformed|invalid/i,
  );
});

test('Q23b misplaced XML declaration/PI target xml fails closed', () => {
  assert.throws(
    () => parseMjcfSource('<mujoco><?xml version="1.0"?></mujoco>', { path: 'holdout/misplaced-declaration.xml' }),
    /XML|declaration|processing|invalid/i,
  );
});

test('Q23d malformed leading XML declaration fails closed', () => {
  assert.throws(
    () => parseMjcfSource('<?xml crap?><mujoco/>', { path: 'holdout/malformed-declaration.xml' }),
    /XML|declaration|processing|invalid|version/i,
  );
});

test('Q23c bare ampersand in XML attribute value fails closed', () => {
  assert.throws(
    () => parseMjcfSource('<mujoco model="a&b"/>', { path: 'holdout/bare-amp.xml' }),
    /XML|entity|ampersand|malformed|invalid/i,
  );
});

test('Q25 source and dependency paths reject control characters', () => {
  assert.throws(
    () => parseMjcfSource('<mujoco/>', { path: 'holdout/line\nbreak.xml' }),
    /path|control|repo-relative|invalid/i,
  );
  assert.throws(
    () => parseMjcfSource('<mujoco><include file="parts/&#10;arm.xml"/></mujoco>', { path: 'holdout/main.xml' }),
    /path|control|dependency|invalid|repo-relative/i,
  );
  assert.throws(
    () => parseMjcfSource('<mujoco><asset><mesh file="meshes/&#9;part.stl"/></asset></mujoco>', { path: 'holdout/main.xml' }),
    /path|control|dependency|invalid|repo-relative/i,
  );
});

test('Q24 discovery-only result must not claim declared-structure support', () => {
  const discovered = discoverMujocoSource(
    '<mujoco model="discovery-only"><worldbody><body',
    { path: 'holdout/discovery-only.xml' },
  );
  assert.equal(discovered.detected, true);
  assert.notEqual(discovered.claims?.declared_structure_only, true);
});

test('Q26 UTF-8-only source rejects a conflicting XML encoding declaration', () => {
  assert.throws(
    () => parseMjcfSource('<?xml version="1.0" encoding="ISO-8859-1"?><mujoco/>', { path: 'holdout/encoding.xml' }),
    /encoding|UTF-8|XML declaration|invalid/i,
  );
  assert.doesNotThrow(
    () => parseMjcfSource('<?xml version="1.0" encoding="UTF-8"?><mujoco/>', { path: 'holdout/utf8.xml' }),
  );
});

test('Q09 current package and stable registry do not expose SIM support', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.files.includes('adapters/'), false);
  assert.equal(pkg.files.some((x) => x.startsWith('adapters/')), false);

  const registry = fs.readFileSync(path.join(ROOT, 'scanners', 'registry.mjs'), 'utf8');
  assert.doesNotMatch(registry, /SIM-mujoco|sim-next/);

  const rootBridge = fs.readFileSync(path.join(HERE, 't24-sim.test.mjs'), 'utf8');
  for (const required of [
    './sim-next/common/interface.test.mjs',
    './sim-next/mujoco/discover.test.mjs',
    './sim-next/mujoco/mjcf-source.test.mjs',
  ]) assert.equal(rootBridge.includes(required), true);
});
