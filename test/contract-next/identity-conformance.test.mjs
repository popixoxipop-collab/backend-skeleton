import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  artifactRefMatches,
  createArtifactRef,
  readIdentity,
} from '../../contracts/next/identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACK = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'next', 'identity-conformance.json'), 'utf8'));

test('T01 consumer conformance positive cases preserve exact identities', () => {
  for (const vector of PACK.positive_cases) {
    assert.deepEqual(readIdentity(vector.input), vector.expected, vector.name);
  }
});

test('T01 consumer conformance negative cases fail closed', () => {
  for (const vector of PACK.negative_cases) {
    assert.throws(() => readIdentity(vector.input), new RegExp(vector.error_pattern), vector.name);
  }
});

test('T01 exact-byte artifact vectors stay formatting-sensitive', () => {
  for (const vector of PACK.artifact_cases) {
    const actual = createArtifactRef(vector.utf8, vector.options);
    assert.deepEqual(actual, vector.expected_ref, vector.name);
    assert.equal(artifactRefMatches(vector.utf8, actual), true, vector.name);
  }
  assert.notEqual(PACK.artifact_cases[0].expected_ref.byte_sha256, PACK.artifact_cases[1].expected_ref.byte_sha256);
});

test('T01 conformance pack names only reviewed identity surfaces', () => {
  assert.equal(PACK.identity_conformance, 'sbf.identity-conformance/1');
  assert.equal(PACK.status, 'candidate-prefreeze');
  assert.equal(PACK.authority.legacy_schema, 'urn:sbf:contract-identity:1');
  assert.equal(PACK.authority.envelope_schema, 'urn:sbf:identity-envelope:1');
  assert.equal(PACK.authority.artifact_ref_schema, 'urn:sbf:artifact-ref:1');
  assert.equal(PACK.authority.binding_json, 'beval.binding-json/1');
});
