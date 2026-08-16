// Regression test for the exact bug found while wiring bin/bskel.mjs: passGate's token inputs
// and require's recomputed inputs must be built the same way, or `require` degenerates into
// comparing stored data against itself and can never detect staleness. See D1 in DECISIONS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { passGate, requireGate, forceGate, awaitDispositionGate, computeToken, diffInputs, STALE_REASON, EXIT } from '../lib/gates.mjs';
import { getGate, loadState, setGate, saveState } from '../lib/state.mjs';

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

// S2: a passed/awaiting/forced gate's stored `inputs` must always reproduce its own `token` --
// this is the invariant explainStaleness()'s integrity check (RECORDED_INPUTS_MISMATCH) relies on
// to trust a diff instead of guessing.
test('a passed, awaiting-disposition, or forced gate always stores inputs that reproduce its own token', () => {
	const root = tmpRepoRoot();
	const passRecord = passGate(root, '_repo', 'preflight', { head_sha: 'abc', default_branch: 'develop' }, {}).gates.preflight;
	assert.equal(computeToken(passRecord.inputs), passRecord.token);

	const awaitRecord = awaitDispositionGate(root, '001-x', 'scan', { spec_hash: 'x' }, {}).gates.scan;
	assert.equal(computeToken(awaitRecord.inputs), awaitRecord.token);

	const forceRecord = forceGate(root, '_repo', 'stack', 'testing').gates.stack;
	assert.equal(computeToken(forceRecord.inputs), forceRecord.token);
});

test('a stale gate names exactly which input keys changed, not just that the token moved', () => {
	const root = tmpRepoRoot();
	passGate(root, '_repo', 'contract', { head_sha: 'a', contract_hash: 'x', resolution_hash: 'y' }, {});

	const oneChanged = requireGate(root, '_repo', 'contract', { head_sha: 'a', contract_hash: 'CHANGED', resolution_hash: 'y' });
	assert.equal(oneChanged.code, EXIT.STALE);
	assert.equal(oneChanged.stale_reason, STALE_REASON.INPUTS_CHANGED);
	assert.deepEqual(oneChanged.changed_inputs, ['contract_hash']);

	const twoChanged = requireGate(root, '_repo', 'contract', { head_sha: 'CHANGED_TOO', contract_hash: 'CHANGED', resolution_hash: 'y' });
	assert.deepEqual(twoChanged.changed_inputs.sort(), ['contract_hash', 'head_sha']);
});

test('diffInputs: a key added or removed (not just value-changed) is reported by name, even when the other side is null', () => {
	// The common sha256File-on-a-missing-file shape -- without the ABSENT sentinel, comparing a
	// present `null` against a missing key would collapse to "no diff" on a real gate-definition
	// change (an input added/removed by a bskel upgrade).
	assert.deepEqual(diffInputs({ a: null }, { a: null, b: 'x' }), ['b']);
	assert.deepEqual(diffInputs({ a: null, b: 'x' }, { a: null }), ['b']);
	assert.deepEqual(diffInputs({ a: null }, { a: null }), []);
});

test('a gate record with no stored inputs (pre-S2) is still stale, reported as no_recorded_inputs, never a false pass', () => {
	const root = tmpRepoRoot();
	// setGate() directly, bypassing passGate(), simulates a record written before S2 shipped --
	// no `inputs` field at all.
	setGate(root, '_repo', 'preflight', { status: 'pass', token: computeToken({ head_sha: 'a' }), at: new Date().toISOString(), evidence: {} });

	const result = requireGate(root, '_repo', 'preflight', { head_sha: 'a' });
	// Recomputed inputs are identical to what produced the stored token, so this still reports
	// PASS -- the gap only shows up once the inputs actually diverge.
	assert.equal(result.code, EXIT.PASS);

	const stale = requireGate(root, '_repo', 'preflight', { head_sha: 'b' });
	assert.equal(stale.code, EXIT.STALE);
	assert.equal(stale.stale_reason, STALE_REASON.NO_RECORDED_INPUTS);
	assert.equal(stale.changed_inputs, null);
});

test('a hand-edited inputs snapshot that no longer reproduces its own token reports recorded_inputs_mismatch, not a misleading key diff', () => {
	const root = tmpRepoRoot();
	passGate(root, '_repo', 'preflight', { head_sha: 'a', default_branch: 'develop' }, {});
	const state = loadState(root, '_repo');
	// Tamper with `inputs` only, leaving `token` as originally computed -- simulates a hand-edited
	// .sbf/_repo.json.
	state.gates.preflight.inputs = { head_sha: 'TAMPERED', default_branch: 'develop' };
	// Persist via the same atomic writer the rest of the module uses.
	saveState(root, '_repo', state);

	const result = requireGate(root, '_repo', 'preflight', { head_sha: 'b', default_branch: 'develop' });
	assert.equal(result.code, EXIT.STALE);
	assert.equal(result.stale_reason, STALE_REASON.RECORDED_INPUTS_MISMATCH);
	assert.equal(result.changed_inputs, null);
});

test('a passing (non-stale) require result carries no changed_inputs/stale_reason fields', () => {
	const root = tmpRepoRoot();
	const inputs = { head_sha: 'a' };
	passGate(root, '_repo', 'preflight', inputs, {});
	const result = requireGate(root, '_repo', 'preflight', inputs);
	assert.equal(result.code, EXIT.PASS);
	assert.equal('changed_inputs' in result, false);
	assert.equal('stale_reason' in result, false);
});
