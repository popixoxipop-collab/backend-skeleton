// Regression test for the exact bug found while wiring bin/bskel.mjs: passGate's token inputs
// and require's recomputed inputs must be built the same way, or `require` degenerates into
// comparing stored data against itself and can never detect staleness. See D1 in DECISIONS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { passGate, requireGate, forceGate, awaitDispositionGate, EXIT } from '../lib/gates.mjs';
import { getGate, loadState } from '../lib/state.mjs';

function tmpRepoRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gates-test-'));
}

test('require immediately after pass, with identical recomputed inputs, is PASS not STALE', () => {
	const root = tmpRepoRoot();
	const inputs = { head_sha: 'abc123', default_branch: 'develop' };
	passGate(root, '_repo', 'preflight', inputs, { note: 'evidence for humans' });

	const result = requireGate(root, '_repo', 'preflight', inputs);
	assert.equal(result.code, EXIT.PASS);
	assert.equal(result.status, 'pass');
});

test('require with different current inputs than pass-time is STALE', () => {
	const root = tmpRepoRoot();
	passGate(root, '_repo', 'preflight', { head_sha: 'abc123' }, {});

	const result = requireGate(root, '_repo', 'preflight', { head_sha: 'def456' });
	assert.equal(result.code, EXIT.STALE);
	assert.equal(result.status, 'stale');
});

test('require on a gate that was never passed is NOT_PASSED', () => {
	const root = tmpRepoRoot();
	const result = requireGate(root, '_repo', 'scan', {});
	assert.equal(result.code, EXIT.NOT_PASSED);
	assert.equal(result.status, 'not_run');
});

test('an awaiting_disposition gate is reported as such, not silently passed', () => {
	const root = tmpRepoRoot();
	awaitDispositionGate(root, '001-organization-management', 'scan', { spec_hash: 'x' }, { verdict: 'collision' });
	const result = requireGate(root, '001-organization-management', 'scan', { spec_hash: 'x' });
	assert.equal(result.code, EXIT.AWAITING_DISPOSITION);
});

test('force records forced:true and an auditable reason, and always passes require regardless of inputs', () => {
	const root = tmpRepoRoot();
	assert.throws(() => forceGate(root, '_repo', 'scan', ''), /reason/);

	forceGate(root, '_repo', 'scan', 'testing the escape hatch');
	const record = getGate(root, '_repo', 'scan');
	assert.equal(record.forced, true);
	assert.equal(record.reason, 'testing the escape hatch');

	// A forced gate stays passed even against wildly different "current" inputs -- it was an
	// explicit human override of the check entirely, not a claim that specific inputs matched.
	const result = requireGate(root, '_repo', 'scan', { anything: 'goes' });
	assert.equal(result.code, EXIT.PASS);
});

test('saveState is atomic: a concurrent reader never observes a half-written file', () => {
	const root = tmpRepoRoot();
	passGate(root, '001-organization-management', 'preflight', { head_sha: 'abc' }, {});
	const state = loadState(root, '001-organization-management');
	assert.equal(state.schema, 'sbf.state/1');
	assert.equal(state.feature_id, '001-organization-management');
	assert.ok(state.gates.preflight);
});
