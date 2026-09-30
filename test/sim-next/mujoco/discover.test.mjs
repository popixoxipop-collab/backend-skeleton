import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverMujocoSource } from '../../../adapters/sim-next/mujoco/discover.mjs';

const valid = `<?xml version="1.0"?>\n<!-- fixture -->\n<mujoco model="arm"><worldbody/></mujoco>\n`;

test('discovers only an explicit mujoco root and preserves exact source identity', () => {
  const result = discoverMujocoSource(valid, { path: 'models/arm.xml' });
  assert.equal(result.detected, true);
  assert.equal(result.target, 'SIM-mujoco');
  assert.equal(result.model_name, 'arm');
  assert.match(result.source.byte_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.source.size_bytes, Buffer.byteLength(valid));
  assert.equal(result.claims.runtime_behavior_verified, false);
});

test('does not classify arbitrary XML as MuJoCo', () => {
  const result = discoverMujocoSource('<robot name="x"/>', { path: 'models/robot.xml' });
  assert.equal(result.detected, false);
  assert.equal(result.target, null);
});

test('NEG-SIM-01 rejects path escape, absolute paths and Windows separators', () => {
  for (const path of ['../arm.xml', '/tmp/arm.xml', 'C:/arm.xml', 'models\\arm.xml', 'models//arm.xml']) {
    assert.throws(() => discoverMujocoSource(valid, { path }), /repo-relative|parent|empty/);
  }
});

test('rejects invalid UTF-8 and bounded byte overflow', () => {
  assert.throws(() => discoverMujocoSource(Buffer.from([0xff]), { path: 'models/arm.xml' }), /valid UTF-8/);
  assert.throws(() => discoverMujocoSource(valid, { path: 'models/arm.xml', maxBytes: 4 }), /byte budget/);
});

test('DOCTYPE and ENTITY declarations fail closed before discovery', () => {
  assert.throws(
    () => discoverMujocoSource('<!DOCTYPE mujoco [<!ENTITY x SYSTEM "file:///etc/passwd">]><mujoco/>', { path: 'models/a.xml' }),
    /DOCTYPE or ENTITY/,
  );
});
