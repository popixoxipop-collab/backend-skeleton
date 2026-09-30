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
  assert.equal(result.claims.discovery_only, true);
  assert.equal(result.claims.declared_structure_only, false);
  assert.equal(result.claims.runtime_behavior_verified, false);
});

test('discovery of a MuJoCo root does not certify declared structure', () => {
  const result = discoverMujocoSource('<mujoco model="truncated"><worldbody><body', { path: 'models/truncated.xml' });
  assert.equal(result.detected, true);
  assert.equal(result.claims.discovery_only, true);
  assert.equal(result.claims.declared_structure_only, false);
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

test('discovery rejects malformed XML declaration and control characters in source path', () => {
  assert.throws(
    () => discoverMujocoSource('<?xml crap?><mujoco/>', { path: 'models/bad.xml' }),
    /declaration.*invalid|invalid.*declaration/i,
  );
  assert.throws(
    () => discoverMujocoSource('<mujoco/>', { path: 'models/line\nbreak.xml' }),
    /repo-relative|path|control|invalid/i,
  );
});

test('discovery XML declaration must agree with UTF-8 source decoding', () => {
  assert.throws(
    () => discoverMujocoSource('<?xml version="1.0" encoding="ISO-8859-1"?><mujoco/>', { path: 'models/latin.xml' }),
    /encoding.*UTF-8|UTF-8.*encoding/i,
  );
  assert.doesNotThrow(
    () => discoverMujocoSource('<?xml version="1.0" encoding="UTF-8"?><mujoco/>', { path: 'models/utf8.xml' }),
  );
});

test('DOCTYPE and ENTITY declarations fail closed before discovery', () => {
  assert.throws(
    () => discoverMujocoSource('<!DOCTYPE mujoco [<!ENTITY x SYSTEM "file:///etc/passwd">]><mujoco/>', { path: 'models/a.xml' }),
    /DOCTYPE or ENTITY/,
  );
});
