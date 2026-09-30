import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseMjcfSource,
  validateMujocoDependencyGraph,
} from '../../../adapters/sim-next/mujoco/mjcf-source.mjs';

function fixture(extra = '') {
  return Buffer.from(`
<mujoco model="fixture-arm">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <default class="base"><geom friction="1 0.1 0.1"/></default>
  <include file="shared/gripper.xml"/>
  <asset>
    <mesh name="hand_mesh" file="meshes/hand.stl"/>
  </asset>
  <worldbody>
    <body name="base" pos="0 0 0">
      <body name="link1" pos="0 0 0.1">
        <joint name="shoulder" type="hinge" axis="0 0 1" range="-1.57 1.57"/>
        <geom name="link1_collision" type="capsule" size="0.02 0.10" contype="1" conaffinity="1"/>
        <site name="tip" pos="0 0 0.2"/>
      </body>
    </body>
  </worldbody>
  <contact>
    <pair name="tip_table" geom1="link1_collision" geom2="table"/>
    <exclude name="self_exclude" body1="base" body2="link1"/>
  </contact>
  <equality><weld name="fixture_weld" body1="base" body2="link1"/></equality>
  <tendon><fixed name="finger_tendon"><joint joint="shoulder" coef="1"/></fixed></tendon>
  <actuator>
    <position name="z_second" joint="shoulder" ctrlrange="-1 1"/>
    <motor name="a_first" joint="shoulder" gear="2"/>
  </actuator>
  <sensor>
    <jointpos name="shoulder_pos" joint="shoulder"/>
    <actuatorfrc name="shoulder_force" actuator="a_first"/>
  </sensor>
  <keyframe>
    <key name="home" time="0" qpos="0" qvel="0.1" act="0.2" ctrl="0.3 0.4"/>
  </keyframe>
  ${extra}
</mujoco>
`, 'utf8');
}

test('extracts declared MJCF structure without effective/runtime claims', () => {
  const parsed = parseMjcfSource(fixture(), { path: 'models/main.xml' });
  assert.equal(parsed.schema, 'sbf.sim-mujoco-source/draft-1');
  assert.equal(parsed.target, 'SIM-mujoco');
  assert.equal(parsed.model.name, 'fixture-arm');
  assert.equal(parsed.declarations.bodies.length, 2);
  assert.equal(parsed.declarations.joints[0].name, 'shoulder');
  assert.deepEqual(parsed.declarations.joints[0].axis, [0, 0, 1]);
  assert.equal(parsed.declarations.actuators.length, 2);
  assert.equal(parsed.declarations.sensors.length, 2);
  assert.equal(parsed.declarations.contacts.length, 2);
  assert.equal(parsed.declarations.equalities.length, 1);
  assert.equal(parsed.declarations.tendons.length, 1);
  assert.equal(parsed.declarations.keyframes.length, 1);
  assert.equal(parsed.claims.effective_model_verified, false);
  assert.equal(parsed.claims.runtime_behavior_verified, false);
});

test('NEG-SIM-06 keeps include/asset refs unresolved and never fetches them', () => {
  const parsed = parseMjcfSource(fixture(), { path: 'models/main.xml' });
  assert.deepEqual(parsed.dependencies.map((d) => [d.kind, d.path, d.status]), [
    ['include', 'shared/gripper.xml', 'unresolved'],
    ['asset', 'meshes/hand.stl', 'unresolved'],
  ]);
  assert.equal(parsed.diagnostics.filter((d) => d.code === 'MUJOCO_DEPENDENCY_UNRESOLVED').length, 2);
});

test('NEG-SIM-14 actuator source order is retained and never alphabetically redefined', () => {
  const parsed = parseMjcfSource(fixture(), { path: 'models/main.xml' });
  assert.deepEqual(parsed.declarations.actuators.map((a) => [a.source_order, a.name]), [
    [0, 'z_second'],
    [1, 'a_first'],
  ]);
});

test('NEG-SIM-13 qpos and qvel remain distinct keyframe channels', () => {
  const key = parseMjcfSource(fixture(), { path: 'models/main.xml' }).declarations.keyframes[0];
  assert.deepEqual(key.qpos, [0]);
  assert.deepEqual(key.qvel, [0.1]);
  assert.deepEqual(key.act, [0.2]);
  assert.deepEqual(key.ctrl, [0.3, 0.4]);
});

test('stable IDs are deterministic for identical source bytes and path', () => {
  const a = parseMjcfSource(fixture(), { path: 'models/main.xml' });
  const b = parseMjcfSource(fixture(), { path: 'models/main.xml' });
  assert.deepEqual(a, b);
  assert.match(a.declarations.joints[0].id, /^joint:[a-f0-9]{20}$/);
  assert.match(a.declarations.joints[0].source_locator, /worldbody\[1\]\/body\[1\]\/body\[1\]\/joint\[1\]$/);
});

test('NEG-SIM-16 non-finite or non-numeric required numeric literals fail closed', () => {
  const bad = fixture().toString('utf8').replace('timestep="0.002"', 'timestep="NaN"');
  assert.throws(() => parseMjcfSource(bad, { path: 'models/main.xml' }), /finite numeric literal/);
  const badAxis = fixture().toString('utf8').replace('axis="0 0 1"', 'axis="0 inf 1"');
  assert.throws(() => parseMjcfSource(badAxis, { path: 'models/main.xml' }), /finite numeric literal/);
});

test('duplicate explicit identities fail closed rather than first-wins', () => {
  const raw = fixture('<worldbody><body name="base"/></worldbody>');
  assert.throws(() => parseMjcfSource(raw, { path: 'models/main.xml' }), /duplicate body name: base/);
});

test('malformed XML and unsupported declarations fail closed', () => {
  assert.throws(() => parseMjcfSource('<mujoco><worldbody></mujoco>', { path: 'models/main.xml' }), /mismatched closing/);
  assert.throws(() => parseMjcfSource('<!DOCTYPE mujoco><mujoco/>', { path: 'models/main.xml' }), /DOCTYPE or ENTITY/);
  assert.throws(() => parseMjcfSource('<mujoco><![CDATA[x]]></mujoco>', { path: 'models/main.xml' }), /unsupported XML declaration/);
});

test('dependency paths reject traversal, absolute, backslash and URI schemes', () => {
  for (const ref of ['../secret.xml', '/tmp/x.xml', 'C:/x.xml', 'foo\\bar.xml', 'https://example.com/x.xml']) {
    const raw = `<mujoco><include file="${ref}"/></mujoco>`;
    assert.throws(() => parseMjcfSource(raw, { path: 'models/main.xml' }), /repo-relative|parent|URI scheme/);
  }
});

test('NEG-SIM-05 direct self include and dependency graph cycles fail closed', () => {
  assert.throws(
    () => parseMjcfSource('<mujoco><include file="models/main.xml"/></mujoco>', { path: 'models/main.xml' }),
    /directly includes itself/,
  );
  assert.throws(
    () => validateMujocoDependencyGraph({
      rootPath: 'models/a.xml',
      edges: [
        { from: 'models/a.xml', to: 'models/b.xml' },
        { from: 'models/b.xml', to: 'models/a.xml' },
      ],
    }),
    /dependency cycle detected/,
  );
});

test('NEG-SIM-07 byte, depth, element and dependency budgets fail closed', () => {
  assert.throws(() => parseMjcfSource(fixture(), { path: 'models/main.xml', maxBytes: 10 }), /byte budget/);
  assert.throws(() => parseMjcfSource('<mujoco><worldbody><body><body/></body></worldbody></mujoco>', {
    path: 'models/main.xml',
    maxDepth: 2,
  }), /depth budget/);
  assert.throws(() => parseMjcfSource('<mujoco><worldbody><body/><body/><body/></worldbody></mujoco>', {
    path: 'models/main.xml',
    maxElements: 3,
  }), /element budget/);
  assert.throws(() => parseMjcfSource('<mujoco><include file="a.xml"/><include file="b.xml"/></mujoco>', {
    path: 'models/main.xml',
    maxDependencies: 1,
  }), /dependency budget/);
});

test('NEG-SIM-08 source implementation has no child process, network fetch, or dynamic target import surface', async () => {
  const code = await readFile(new URL('../../../adapters/sim-next/mujoco/mjcf-source.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /node:child_process|from ['"]child_process['"]|\bspawn\s*\(|\bexec\s*\(|\bfetch\s*\(/);
  assert.doesNotMatch(code, /import\s*\(\s*[^'"`]/);
});

test('invalid UTF-8 and source path escape fail before structural parsing', () => {
  assert.throws(() => parseMjcfSource(Buffer.from([0xff]), { path: 'models/main.xml' }), /valid UTF-8/);
  assert.throws(() => parseMjcfSource('<mujoco/>', { path: '../main.xml' }), /repo-relative|parent/);
});
