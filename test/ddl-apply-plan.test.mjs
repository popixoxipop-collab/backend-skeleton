// D-ddl-apply: pure, no-network unit tests for scanners/db/ddl-apply.mjs's allowlist and table-
// expectation classification -- the parts of this feature that don't require a live Postgres
// connection. `planDdlApply()`/`executeDdlApply()` themselves (both require a real DB) are proven
// end-to-end by the real, CI-wired scripts/ddl-apply-smoke.mjs instead, matching this project's own
// "fast npm test never touches a network" convention (see D-db-schema-plane's own db-introspect
// smoke script for the established precedent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitStatements, assertLooksLikeDdl, classifyTableExpectations, DdlApplyPlanError } from '../scanners/db/ddl-apply.mjs';

test('splitStatements: splits on `;`, trims, and drops empty segments (including a trailing `;`)', () => {
	assert.deepEqual(splitStatements('CREATE TABLE a (id uuid);'), ['CREATE TABLE a (id uuid)']);
	assert.deepEqual(
		splitStatements('CREATE TABLE a (id uuid); ALTER TABLE a ADD COLUMN b text;'),
		['CREATE TABLE a (id uuid)', 'ALTER TABLE a ADD COLUMN b text'],
	);
	assert.deepEqual(splitStatements('  ;  ;  '), []);
});

test('assertLooksLikeDdl: accepts every allowlisted statement shape', () => {
	const cases = [
		'CREATE TABLE widgets (id uuid PRIMARY KEY)',
		'CREATE TABLE IF NOT EXISTS widgets (id uuid PRIMARY KEY)',
		'ALTER TABLE widgets ADD COLUMN name text',
		'DROP TABLE widgets',
		'DROP TABLE IF EXISTS widgets',
		'CREATE INDEX idx_widgets_name ON widgets (name)',
		'CREATE UNIQUE INDEX idx_widgets_name ON widgets (name)',
		'DROP INDEX idx_widgets_name',
		'CREATE SCHEMA billing',
		'DROP SCHEMA billing',
	];
	for (const sql of cases) {
		assert.deepEqual(assertLooksLikeDdl(`${sql};`), [sql], `expected "${sql}" to be allowlisted`);
	}
});

test('assertLooksLikeDdl: refuses CREATE/DROP INDEX CONCURRENTLY -- these cannot run inside a transaction block at all', () => {
	assert.throws(() => assertLooksLikeDdl('CREATE INDEX CONCURRENTLY idx_x ON t (c);'), DdlApplyPlanError);
	assert.throws(() => assertLooksLikeDdl('DROP INDEX CONCURRENTLY idx_x;'), DdlApplyPlanError);
});

test('assertLooksLikeDdl: refuses anything outside the CREATE/ALTER/DROP TABLE/INDEX/SCHEMA allowlist', () => {
	const rejected = [
		'GRANT SELECT ON widgets TO app_user',
		'CREATE FUNCTION f() RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql',
		'TRUNCATE widgets',
		"INSERT INTO widgets (id) VALUES ('x')",
		'DROP ROLE app_user',
	];
	for (const sql of rejected) {
		assert.throws(() => assertLooksLikeDdl(`${sql};`), DdlApplyPlanError, `expected "${sql}" to be refused`);
	}
});

test('assertLooksLikeDdl: refuses an empty statement list', () => {
	assert.throws(() => assertLooksLikeDdl(''), DdlApplyPlanError);
	assert.throws(() => assertLooksLikeDdl('   ;  '), DdlApplyPlanError);
});

test('assertLooksLikeDdl: one bad statement among several good ones still refuses the whole batch', () => {
	assert.throws(
		() => assertLooksLikeDdl('CREATE TABLE a (id uuid); GRANT SELECT ON a TO app_user; CREATE TABLE b (id uuid);'),
		DdlApplyPlanError,
	);
});

test('classifyTableExpectations: CREATE TABLE and ALTER TABLE ADD COLUMN expect the table to be present afterward', () => {
	const statements = ['CREATE TABLE widgets (id uuid PRIMARY KEY)', 'ALTER TABLE gadgets ADD COLUMN name text'];
	assert.deepEqual(classifyTableExpectations(statements), [
		{ name: 'gadgets', expect: 'present' },
		{ name: 'widgets', expect: 'present' },
	]);
});

test('classifyTableExpectations: DROP TABLE expects the table to be absent afterward', () => {
	assert.deepEqual(classifyTableExpectations(['DROP TABLE widgets']), [{ name: 'widgets', expect: 'absent' }]);
	assert.deepEqual(classifyTableExpectations(['DROP TABLE IF EXISTS widgets']), [{ name: 'widgets', expect: 'absent' }]);
});

test('classifyTableExpectations: CREATE/DROP INDEX and CREATE/DROP SCHEMA contribute no table expectations -- Slice 1 only checks their effect via the coarser schema-hash-changed check', () => {
	assert.deepEqual(classifyTableExpectations(['CREATE INDEX idx_x ON widgets (name)']), []);
	assert.deepEqual(classifyTableExpectations(['DROP INDEX idx_x']), []);
	assert.deepEqual(classifyTableExpectations(['CREATE SCHEMA billing']), []);
	assert.deepEqual(classifyTableExpectations(['DROP SCHEMA billing']), []);
});

test('classifyTableExpectations: the same table named by multiple statements collapses to one entry (last classification wins)', () => {
	assert.deepEqual(
		classifyTableExpectations(['CREATE TABLE widgets (id uuid)', 'ALTER TABLE widgets ADD COLUMN name text']),
		[{ name: 'widgets', expect: 'present' }],
	);
});
