// D-contract-history: `bskel contract history` is a pure read over whatever git already recorded
// for a feature's contract file -- these tests build small, controlled git histories directly
// (no need to route every revision through a real scan/emit cycle) plus one full real-CLI
// round-trip to prove a genuinely emitted contract's history reads back correctly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run, buildFixtureRepo, initThroughScanDisposition, contractSchemaPath } from './_contract-fixture.mjs';

const FEATURE = '001-widget-management';

function git(args, cwd) {
	execFileSync('git', args, { cwd });
}

function minimalContract({ operations = {}, sbf_contract = '8' } = {}) {
	return {
		sbf_contract, feature_id: FEATURE, feature_uid: '4c8de69b-2a4a-40c0-9749-491bc3c41ae2',
		source: { adapter: 'java-spring', module: 'widgets', provenance: 'scan' },
		operations, warnings: [],
		completeness: { status: 'complete', operation_count: Object.keys(operations).length, endpoint_count: Object.keys(operations).length },
	};
}

// Builds a bare git repo (no bskel involvement at all) with the contract file committed at N
// controlled revisions -- the fastest, most precise way to test the history READER itself,
// independent of whatever a real scan/emit cycle happens to produce.
function repoWithContractHistory(revisions) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-contract-history-'));
	git(['init', '--quiet', '--initial-branch=main'], root);
	git(['config', 'user.email', 'test@example.com'], root);
	git(['config', 'user.name', 'Test'], root);
	const contractDir = path.join(root, 'specs', FEATURE, 'contracts');
	fs.mkdirSync(contractDir, { recursive: true });
	const contractFile = path.join(contractDir, `${FEATURE}.schema.json`);
	for (const [i, contract] of revisions.entries()) {
		fs.writeFileSync(contractFile, JSON.stringify(contract, null, 2));
		git(['add', '-A'], root);
		git(['commit', '--quiet', '-m', `revision ${i}`], root);
	}
	return root;
}

test('no git history at all: exits 0 with an honest "never committed" message, not an error', () => {
	const root = repoWithContractHistory([]); // repo exists, contract file never written/committed
	const result = run(['contract', 'history', '--feature', FEATURE], root);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /no git history/);
	assert.match(result.stdout, /never committed|specs\/ isn't tracked/);
});

test('--json with no history: revisions is an empty array, not omitted or null', () => {
	const root = repoWithContractHistory([]);
	const result = run(['contract', 'history', '--feature', FEATURE, '--json'], root);
	assert.equal(result.code, 0);
	const parsed = JSON.parse(result.stdout);
	assert.equal(parsed.feature_id, FEATURE);
	assert.deepEqual(parsed.revisions, []);
});

test('a single committed revision is read back with its real sbf_contract/completeness/operation_count', () => {
	const root = repoWithContractHistory([
		minimalContract({ operations: { findWidget: {}, createWidget: {} } }),
	]);
	const result = run(['contract', 'history', '--feature', FEATURE, '--json'], root);
	assert.equal(result.code, 0);
	const { revisions } = JSON.parse(result.stdout);
	assert.equal(revisions.length, 1);
	assert.equal(revisions[0].sbf_contract, '8');
	assert.equal(revisions[0].completeness_status, 'complete');
	assert.equal(revisions[0].operation_count, 2);
	// First revision: every operation is "added" relative to nothing before it.
	assert.deepEqual(revisions[0].operations_added.sort(), ['createWidget', 'findWidget']);
	assert.deepEqual(revisions[0].operations_removed, []);
});

test('operations added/removed across revisions are diffed correctly, oldest first', () => {
	const root = repoWithContractHistory([
		minimalContract({ operations: { findWidget: {} } }),
		minimalContract({ operations: { findWidget: {}, createWidget: {} } }), // createWidget added
		minimalContract({ operations: { createWidget: {} } }), // findWidget removed
	]);
	const result = run(['contract', 'history', '--feature', FEATURE, '--json'], root);
	const { revisions } = JSON.parse(result.stdout);
	assert.equal(revisions.length, 3);
	assert.deepEqual(revisions[0].operations_added, ['findWidget']);
	assert.deepEqual(revisions[1].operations_added, ['createWidget']);
	assert.deepEqual(revisions[1].operations_removed, []);
	assert.deepEqual(revisions[2].operations_added, []);
	assert.deepEqual(revisions[2].operations_removed, ['findWidget']);
	// Chronological order (git log is newest-first internally; the command must reverse it).
	const dates = revisions.map((r) => r.date);
	assert.deepEqual(dates, [...dates].sort());
});

test('a revision with unparseable content at that point in history is marked parse_error, not a crash', () => {
	const root = repoWithContractHistory([minimalContract({})]);
	// Corrupt the SECOND revision directly (bypassing minimalContract's own valid-JSON guarantee)
	// to simulate a hand-edited or pre-JSON-era commit.
	const contractFile = path.join(root, 'specs', FEATURE, 'contracts', `${FEATURE}.schema.json`);
	fs.writeFileSync(contractFile, 'not valid json{{{');
	git(['add', '-A'], root);
	git(['commit', '--quiet', '-m', 'revision 1 (corrupt)'], root);

	const result = run(['contract', 'history', '--feature', FEATURE, '--json'], root);
	assert.equal(result.code, 0);
	const { revisions } = JSON.parse(result.stdout);
	assert.equal(revisions.length, 2);
	assert.equal(revisions[0].parse_error, undefined);
	assert.equal(revisions[1].parse_error, true);
});

test('text mode renders a human-readable one-line-per-revision summary with the operation delta', () => {
	const root = repoWithContractHistory([
		minimalContract({ operations: { findWidget: {} } }),
		minimalContract({ operations: { findWidget: {}, createWidget: {} } }),
	]);
	const result = run(['contract', 'history', '--feature', FEATURE], root);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /sbf_contract=8/);
	assert.match(result.stdout, /completeness=complete/);
	assert.match(result.stdout, /\+createWidget/);
});

test('a real bskel contract emit, once committed, round-trips through contract history correctly', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	// The shared fixture's own .gitignore excludes specs/ -- override that ONE line for this test
	// so a real emitted contract can actually be committed, matching a target repo that chose to
	// track its own specs/ (bskel never requires this, but doesn't forbid it either).
	fs.writeFileSync(path.join(root, '.gitignore'), '.sbf/\n');
	git(['add', '-A'], root);
	git(['commit', '--quiet', '-m', 'chore: track specs/'], root);

	initThroughScanDisposition(root);
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 0);
	git(['add', '-A'], root);
	git(['commit', '--quiet', '-m', 'contract: first emit'], root);

	const result = run(['contract', 'history', '--feature', FEATURE, '--json'], root);
	assert.equal(result.code, 0);
	const { revisions } = JSON.parse(result.stdout);
	assert.equal(revisions.length, 1);
	assert.equal(revisions[0].parse_error, undefined, 'a real emitted contract must always parse cleanly');
	const realContract = JSON.parse(fs.readFileSync(contractSchemaPath(root), 'utf8'));
	assert.equal(revisions[0].sbf_contract, realContract.sbf_contract);
	assert.equal(revisions[0].operation_count, realContract.completeness.operation_count);
	assert.ok(revisions[0].operations_added.length > 0, 'the real fixture has real operations');
});

test('an unknown --feature id is refused the same way every other contract subcommand refuses one', () => {
	const root = repoWithContractHistory([]);
	const result = run(['contract', 'history', '--feature', 'not-a-valid-id'], root);
	assert.notEqual(result.code, 0);
});
