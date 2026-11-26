import assert from 'node:assert/strict';
import { existsSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [consumer, expected] = process.argv.slice(2);
assert.ok(['present', 'absent'].includes(expected));
const root = realpathSync(path.join(consumer, 'node_modules/backend-skeleton'));
const entry = path.join(root, 'scanners/capability-next/index.mjs');
if (expected === 'absent') {
  assert.equal(existsSync(entry), false);
} else {
  assert.equal(realpathSync(entry), entry);
  const api = await import(pathToFileURL(entry));
  const requirements = [{ capability: 'legacyRoute' }];
  const good = api.evaluateCapabilityPolicy({
    capabilities: api.fromLegacyCapabilities({ legacyRoute: true }), requirements,
  });
  assert.equal(good.allowed, true);
  assert.equal(good.decisions[0].status, 'supported');
  const unknown = api.capabilityRecord({ name: 'legacyRoute', status: 'unknown', reason: 'no target evidence' });
  const bad = api.evaluateCapabilityPolicy({ capabilities: { legacyRoute: unknown }, requirements });
  assert.equal(bad.allowed, false);
  assert.equal(bad.decisions[0].status, 'unknown');
  assert.throws(() => api.certificationRecord({ targetId: 'probe', level: 'runtime-tested' }), TypeError);
  assert.deepEqual(api.buildSupportMatrix(), []);
  if (process.env.T03_TEST_INTERRUPT_PROBE === '1') {
    writeSync(1, 'T03_READY\n');
    process.kill(process.pid, 'SIGTERM');
  }
}
console.log(JSON.stringify({ expected, release_authorized: false, runtime_certified: false }));
