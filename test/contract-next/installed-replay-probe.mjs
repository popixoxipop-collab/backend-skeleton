// Run from a disposable installed package, never from this checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, expected] = process.argv.slice(2);
assert.ok(root && ['previous', 'candidate'].includes(expected));
const modulePath = path.join(root, 'contracts/next/identity.mjs');
assert.equal(fs.existsSync(modulePath), expected === 'candidate');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
assert.equal(packageJson.name, 'backend-skeleton');
assert.equal(packageJson.version, '1.9.0');

let vectors = 0;
if (expected === 'candidate') {
  const identity = await import(pathToFileURL(modulePath).href);
  const pack = JSON.parse(fs.readFileSync(path.join(root, 'schemas/next/identity-conformance.json')));
  assert.equal(pack.status, 'candidate-prefreeze');
  for (const vector of pack.positive_cases) {
    assert.deepEqual(identity.readIdentity(vector.input), vector.expected, vector.name);
    vectors++;
  }
  for (const vector of pack.negative_cases) {
    assert.throws(() => identity.readIdentity(vector.input), new RegExp(vector.error_pattern), vector.name);
    vectors++;
  }
  for (const vector of pack.artifact_cases) {
    assert.deepEqual(identity.createArtifactRef(vector.utf8, vector.options), vector.expected_ref, vector.name);
    vectors++;
  }
  assert.notEqual(pack.artifact_cases[0].expected_ref.byte_sha256,
    pack.artifact_cases[1].expected_ref.byte_sha256);
}
if (process.env.T01_TEST_INTERRUPT_PROBE === '1') process.kill(process.pid, 'SIGTERM');
process.stdout.write(JSON.stringify({ expected, vectors, release_authorized: false }) + '\n');
