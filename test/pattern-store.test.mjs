// D-pattern-accrual: pure, DB-free unit tests for patterns/store.mjs's aggregation logic and
// new/index.mjs's reusableParamsFor() -- the two pieces of this feature that don't need a real
// Postgres to verify. The real-database round trip (recordPattern -> listPatterns/getPattern
// against a live table) is covered by scripts/pattern-db-smoke.mjs instead (see D-pattern-accrual
// in DECISIONS.md for why: a unit test with a fake pg.Client would only prove the mock behaves as
// mocked, never that a real INSERT/SELECT against real JSONB round-trips correctly).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMissingPatternTable, summarizePatternFrequency } from '../patterns/store.mjs';
import { STACKS, reusableParamsFor } from '../new/index.mjs';

// ---- isMissingPatternTable --------------------------------------------------

test('isMissingPatternTable: true for Postgres 42P01 (relation does not exist)', () => {
	assert.equal(isMissingPatternTable({ code: '42P01' }), true);
});

test('isMissingPatternTable: false for any other error code, and for no code at all', () => {
	assert.equal(isMissingPatternTable({ code: '23505' }), false);
	assert.equal(isMissingPatternTable({ message: 'connection refused' }), false);
	assert.equal(isMissingPatternTable(null), false);
});

// ---- reusableParamsFor -------------------------------------------------------

test('reusableParamsFor: spring never includes per-project-identity params (slug/name/description/project-version/artifact-id/package-name)', () => {
	const params = reusableParamsFor('spring');
	for (const identity of ['slug', 'name', 'description', 'project-version', 'artifact-id', 'package-name']) {
		assert.ok(!params.includes(identity), `expected spring's reusableParams to exclude --${identity}, got ${JSON.stringify(params)}`);
	}
	assert.deepEqual([...params].sort(), ['add-dependencies', 'dependencies', 'group-id', 'java-version', 'packaging']);
});

test('reusableParamsFor: fastapi never includes per-project-identity params, and every entry is a real acceptedParams member', () => {
	const params = reusableParamsFor('fastapi');
	assert.deepEqual([...params].sort(), ['database', 'license', 'port', 'python-version']);
	for (const p of params) assert.ok(STACKS.fastapi.acceptedParams.includes(p), `--${p} is in fastapi's reusableParams but not its own acceptedParams`);
});

test('reusableParamsFor: unknown stack id returns an empty array, not a throw', () => {
	assert.deepEqual(reusableParamsFor('django'), []);
});

// ---- summarizePatternFrequency -----------------------------------------------

test('summarizePatternFrequency: no records -> empty summary', () => {
	assert.deepEqual(summarizePatternFrequency([], ['java-version', 'group-id']), []);
});

test('summarizePatternFrequency: a param never set in any record is excluded entirely, not reported as 0/N', () => {
	const records = [{ params: { 'java-version': '21' } }, { params: { 'java-version': '21' } }];
	const summary = summarizePatternFrequency(records, ['java-version', 'group-id']);
	assert.deepEqual(summary.map((s) => s.param), ['java-version']);
});

test('summarizePatternFrequency: denominator is the FULL record count, not just the runs that set the param', () => {
	const records = [
		{ params: { 'group-id': 'com.acme' } },
		{ params: {} }, // this run never passed --group-id at all
		{ params: { 'group-id': 'com.acme' } },
	];
	const summary = summarizePatternFrequency(records, ['group-id']);
	assert.deepEqual(summary, [{ param: 'group-id', values: [{ value: 'com.acme', count: 2, total: 3 }] }]);
});

test('summarizePatternFrequency: multiple observed values are ranked by count descending, never collapsed to one answer', () => {
	const records = [
		{ params: { 'java-version': '21' } },
		{ params: { 'java-version': '21' } },
		{ params: { 'java-version': '17' } },
	];
	const summary = summarizePatternFrequency(records, ['java-version']);
	assert.deepEqual(summary, [{
		param: 'java-version',
		values: [
			{ value: '21', count: 2, total: 3 },
			{ value: '17', count: 1, total: 3 },
		],
	}]);
});

test('summarizePatternFrequency: a genuine tie is broken deterministically (lexicographic), not by insertion order', () => {
	const records = [{ params: { license: 'MIT' } }, { params: { license: 'Apache-2.0' } }];
	const summary = summarizePatternFrequency(records, ['license']);
	assert.deepEqual(summary[0].values.map((v) => v.value), ['Apache-2.0', 'MIT']);
});
