import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  createConsumerResultTemplate,
  verifyConsumerConformanceResult,
} from '../../contracts/next/consumer-conformance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACK_BYTES = fs.readFileSync(path.join(ROOT, 'schemas', 'next', 'identity-conformance.json'));
const PACK = JSON.parse(PACK_BYTES);
const RESULT_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'next', 'identity-consumer-result.schema.json'), 'utf8'));

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function successfulResult() {
  const result = createConsumerResultTemplate(PACK_BYTES, {
    consumer: 'independent-fixture',
    repository: 'example/consumer',
    commit_sha: 'a'.repeat(40),
    implementation_path: 'lib/next/identity-reader.mjs',
    command: 'node --test test/next/identity-consumer.test.mjs',
  });
  result.execution.exit_code = 0;
  result.cases = [
    ...PACK.positive_cases.map((vector) => ({
      group: 'positive',
      name: vector.name,
      outcome: 'pass',
      observed: JSON.parse(JSON.stringify(vector.expected)),
    })),
    ...PACK.negative_cases.map((vector) => ({
      group: 'negative',
      name: vector.name,
      outcome: 'pass',
      observed: { error: vector.error_pattern.replace('|', ' ') },
    })),
    ...PACK.artifact_cases.map((vector) => ({
      group: 'artifact',
      name: vector.name,
      outcome: 'pass',
      observed: JSON.parse(JSON.stringify(vector.expected_ref)),
    })),
  ];
  result.summary = { total: result.cases.length, passed: result.cases.length, failed: 0, not_run: 0 };
  return result;
}

test('consumer result schema accepts the complete independent result shape', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(RESULT_SCHEMA);
  const result = successfulResult();
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.equal(result.conformance_pack.byte_sha256, sha256(PACK_BYTES));
});

test('consumer verifier accepts every expected vector with key-order-independent observations', () => {
  const result = successfulResult();
  const action = result.cases.find((item) => item.group === 'positive' && item.name === 'legacy-action-ref');
  const original = action.observed;
  action.observed = {
    reference: original.reference,
    reference_kind: original.reference_kind,
    family: original.family,
    reader: original.reader,
  };
  const verified = verifyConsumerConformanceResult(PACK_BYTES, result);
  assert.equal(verified.ok, true);
  assert.equal(verified.verified_cases, 12);
  assert.equal(verified.conformance_pack_sha256, sha256(PACK_BYTES));
});

test('consumer verifier rejects bskel runtime import/spawn claims', () => {
  for (const field of ['bskel_runtime_imported', 'bskel_runtime_spawned']) {
    const result = successfulResult();
    result.execution[field] = true;
    assert.throws(() => verifyConsumerConformanceResult(PACK_BYTES, result), /may not/);
  }
});

test('consumer verifier rejects pack substitution and stale pack hashes', () => {
  const result = successfulResult();
  result.conformance_pack.byte_sha256 = 'f'.repeat(64);
  assert.throws(() => verifyConsumerConformanceResult(PACK_BYTES, result), /pack bytes do not match/);
  const altered = Buffer.concat([PACK_BYTES, Buffer.from('\n')]);
  assert.throws(() => verifyConsumerConformanceResult(altered, successfulResult()), /valid UTF-8 JSON|pack bytes do not match/);
});

test('consumer verifier rejects missing, duplicate, unexpected, and non-passing cases', () => {
  const missing = successfulResult();
  missing.cases.pop();
  assert.throws(() => verifyConsumerConformanceResult(PACK_BYTES, missing), /missing cases/);

  const duplicate = successfulResult();
  duplicate.cases.push({ ...duplicate.cases[0] });
  assert.throws(() => verifyConsumerConformanceResult(PACK_BYTES, duplicate), /duplicate consumer case/);

  const unexpected = successfulResult();
  unexpected.cases[0].name = 'not-a-reviewed-case';
  assert.throws(() => verifyConsumerConformanceResult(PACK_BYTES, unexpected), /unexpected consumer case/);

  const failed = successfulResult();
  failed.cases[0].outcome = 'fail';
  assert.throws(() => verifyConsumerConformanceResult(PACK_BYTES, failed), /did not pass/);
});

test('consumer verifier rejects identity repair and artifact semantic substitution', () => {
  const repaired = successfulResult();
  const noRepair = repaired.cases.find((item) => item.name === 'valid-but-different-operation-id-is-not-repaired');
  noRepair.observed.reference.operation_id = 'getHello';
  assert.throws(() => verifyConsumerConformanceResult(PACK_BYTES, repaired), /positive consumer observation mismatch/);

  const semanticSubstitution = successfulResult();
  const compact = semanticSubstitution.cases.find((item) => item.group === 'artifact' && item.name === 'compact-json');
  const pretty = PACK.artifact_cases.find((item) => item.name === 'pretty-json');
  compact.observed = pretty.expected_ref;
  assert.throws(() => verifyConsumerConformanceResult(PACK_BYTES, semanticSubstitution), /artifact consumer observation mismatch/);
});

test('consumer verifier rejects negative-case error drift and summary tampering', () => {
  const wrongError = successfulResult();
  const negative = wrongError.cases.find((item) => item.group === 'negative');
  negative.observed.error = 'accepted';
  assert.throws(() => verifyConsumerConformanceResult(PACK_BYTES, wrongError), /negative consumer error mismatch/);

  const summary = successfulResult();
  summary.summary.passed -= 1;
  assert.throws(() => verifyConsumerConformanceResult(PACK_BYTES, summary), /summary does not match/);
});
