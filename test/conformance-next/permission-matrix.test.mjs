import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PERMISSION_MANIFEST_SCHEMA,
  compilePermissionPolicy,
  diffPermissionManifests,
  selectApprovedEnvironment,
  validatePermissionManifest,
} from '../../lib/trust-next/permission-manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(fs.readFileSync(path.join(HERE, 'permission-matrix.json'), 'utf8'));
const vectorIds = new Set(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'corpus-next', 'negative-vectors.json'), 'utf8')).vectors.map((v) => v.id));

const CHECKS = new Set(['decision', 'manifest', 'env-selection', 'env-selection-throws', 'expansion']);
const allCases = () => matrix.cells.flatMap((cell) => [
  ...cell.normal.map((c, index) => ({ cell, kind: 'normal', index, c })),
  ...cell.negative.map((c, index) => ({ cell, kind: 'negative', index, c })),
]);

function evaluate(cell, c) {
  switch (c.check) {
    case 'decision': {
      const policy = compilePermissionPolicy(cell.manifest);
      assert.equal(typeof policy[c.decision], 'function', `${cell.id}: unknown decision function ${c.decision}`);
      return Boolean(policy[c.decision](...c.args)) === c.expect;
    }
    case 'manifest': {
      const result = validatePermissionManifest(c.manifest);
      if (result.ok !== c.expect_ok) return false;
      const codes = new Set(result.errors.map((e) => e.code));
      return (c.expect_codes ?? []).every((code) => codes.has(code));
    }
    case 'env-selection': {
      const selected = selectApprovedEnvironment(cell.manifest, c.ambient);
      assert.deepEqual({ ...selected }, c.expect);
      return Object.getPrototypeOf(selected) === null && Object.isFrozen(selected);
    }
    case 'env-selection-throws':
      assert.throws(() => selectApprovedEnvironment(cell.manifest, c.ambient), (error) => error.code === c.expect_code);
      return true;
    case 'expansion':
      return diffPermissionManifests(c.before, c.after).expanded === c.expect_expanded;
    default:
      throw new Error(`${cell.id}: unknown check ${c.check}`);
  }
}

test('permission matrix: structure, unique cell ids, known vectors and a base manifest that compiles', () => {
  assert.equal(matrix.contract, 'sbf.qa-permission-matrix/1');
  assert.equal(matrix.layer, 'policy-decision');
  assert.ok(Array.isArray(matrix.cells) && matrix.cells.length > 0);
  const ids = new Set();
  for (const cell of matrix.cells) {
    assert.match(cell.id, /^PM-[A-Z0-9-]+$/);
    assert.equal(ids.has(cell.id), false, `duplicate cell id ${cell.id}`);
    ids.add(cell.id);
    for (const key of ['permission', 'manifest_field', 'grant_state']) assert.equal(typeof cell[key], 'string', `${cell.id}.${key}`);
    assert.ok(Array.isArray(cell.vector_ids) && cell.vector_ids.length > 0, `${cell.id} must name at least one negative vector`);
    for (const id of cell.vector_ids) assert.equal(vectorIds.has(id), true, `${cell.id}: unknown negative vector ${id}`);
    assert.ok(Array.isArray(cell.normal) && cell.normal.length >= 1, `${cell.id} needs a normal case`);
    assert.ok(Array.isArray(cell.negative) && cell.negative.length >= 1, `${cell.id} needs a negative case`);
    assert.doesNotThrow(() => compilePermissionPolicy(cell.manifest), `${cell.id}: base manifest must compile`);
    for (const c of [...cell.normal, ...cell.negative]) assert.equal(CHECKS.has(c.check), true, `${cell.id}: unknown check ${c.check}`);
    for (const c of cell.negative) assert.equal(typeof c.why, 'string', `${cell.id}: every negative case states why it must be refused`);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(matrix, 'runtime_enforcement'), false, 'the decision matrix must not claim runtime enforcement');
});

test('permission matrix: every normal case is accepted and every negative case is refused by the real policy', () => {
  for (const { cell, kind, index, c } of allCases()) {
    assert.equal(evaluate(cell, c), true, `${cell.id} ${kind}[${index}] ${JSON.stringify(c).slice(0, 160)}`);
  }
});

test('permission matrix: every decision function has a normal and a negative case and every manifest field has a cell', () => {
  const policy = compilePermissionPolicy({ schema: PERMISSION_MANIFEST_SCHEMA });
  const decisions = Object.keys(policy).filter((key) => /^can[A-Z]/.test(key)).sort();
  assert.ok(decisions.length >= 8, 'the policy exposes the eight reviewed decision functions');
  for (const name of decisions) {
    const allowed = allCases().some(({ kind, c }) => kind === 'normal' && c.check === 'decision' && c.decision === name && c.expect === true);
    const denied = allCases().some(({ kind, c }) => kind === 'negative' && c.check === 'decision' && c.decision === name && c.expect === false);
    assert.equal(allowed, true, `${name} lacks a normal (allowed) case`);
    assert.equal(denied, true, `${name} lacks a negative (denied) case`);
  }
  const fields = Object.keys(validatePermissionManifest({ schema: PERMISSION_MANIFEST_SCHEMA }).value);
  assert.ok(fields.includes('schema') && fields.includes('limits'));
  for (const field of fields) {
    assert.equal(matrix.cells.some((cell) => cell.manifest_field === field), true, `manifest field ${field} has no matrix cell`);
  }
  for (const kind of CHECKS) assert.equal(allCases().some(({ c }) => c.check === kind), true, `check kind ${kind} is unused`);
});

test('permission matrix: a wrong expectation is detected, so the evaluator cannot pass vacuously', () => {
  const cell = matrix.cells.find((x) => x.id === 'PM-FS-READ-GRANTED');
  assert.equal(evaluate(cell, { check: 'decision', decision: 'canRead', args: ['lib/a.js'], expect: false }), true);
  assert.equal(evaluate(cell, { check: 'decision', decision: 'canRead', args: ['lib/a.js'], expect: true }), false);
  assert.equal(evaluate(cell, { check: 'manifest', manifest: { schema: PERMISSION_MANIFEST_SCHEMA }, expect_ok: false }), false);
  assert.equal(evaluate(cell, { check: 'expansion', before: { schema: PERMISSION_MANIFEST_SCHEMA }, after: { schema: PERMISSION_MANIFEST_SCHEMA }, expect_expanded: true }), false);
});
