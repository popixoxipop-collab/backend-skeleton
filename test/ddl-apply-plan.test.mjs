// D-ddl-apply: pure, no-network unit tests for scanners/db/ddl-apply.mjs's allowlist and table-
// expectation classification -- the parts of this feature that don't require a live Postgres
// connection. `planDdlApply()`/`executeDdlApply()` themselves (both require a real DB) are proven
// end-to-end by the real, CI-wired scripts/ddl-apply-smoke.mjs instead, matching this project's own
// "fast npm test never touches a network" convention (see D-db-schema-plane's own db-introspect
// smoke script for the established precedent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	splitStatements, assertLooksLikeDdl, classifyTableExpectations, classifyIndexExpectations,
	classifySchemaExpectations, requiredConfirmValue, DdlApplyPlanError,
} from '../scanners/db/ddl-apply.mjs';

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

test('classifyTableExpectations: CREATE/DROP INDEX and CREATE/DROP SCHEMA contribute no TABLE expectations (they have their own classifiers -- see below)', () => {
	assert.deepEqual(classifyTableExpectations(['CREATE INDEX idx_x ON widgets (name)']), []);
	assert.deepEqual(classifyTableExpectations(['DROP INDEX idx_x']), []);
	assert.deepEqual(classifyTableExpectations(['CREATE SCHEMA billing']), []);
	assert.deepEqual(classifyTableExpectations(['DROP SCHEMA billing']), []);
});

test('classifyIndexExpectations: CREATE INDEX (plain and UNIQUE) expect the index to be present afterward', () => {
	assert.deepEqual(classifyIndexExpectations(['CREATE INDEX idx_widgets_name ON widgets (name)']), [{ name: 'idx_widgets_name', expect: 'present' }]);
	assert.deepEqual(classifyIndexExpectations(['CREATE UNIQUE INDEX idx_widgets_name ON widgets (name)']), [{ name: 'idx_widgets_name', expect: 'present' }]);
	assert.deepEqual(classifyIndexExpectations(['CREATE INDEX IF NOT EXISTS idx_widgets_name ON widgets (name)']), [{ name: 'idx_widgets_name', expect: 'present' }]);
});

test('classifyIndexExpectations: DROP INDEX expects the index to be absent afterward', () => {
	assert.deepEqual(classifyIndexExpectations(['DROP INDEX idx_widgets_name']), [{ name: 'idx_widgets_name', expect: 'absent' }]);
	assert.deepEqual(classifyIndexExpectations(['DROP INDEX IF EXISTS idx_widgets_name']), [{ name: 'idx_widgets_name', expect: 'absent' }]);
});

test('classifyIndexExpectations: CREATE/DROP TABLE/SCHEMA contribute no index expectations', () => {
	assert.deepEqual(classifyIndexExpectations(['CREATE TABLE widgets (id uuid)']), []);
	assert.deepEqual(classifyIndexExpectations(['CREATE SCHEMA billing']), []);
});

test('classifySchemaExpectations: CREATE SCHEMA expects the schema to be present afterward; DROP SCHEMA expects absent', () => {
	assert.deepEqual(classifySchemaExpectations(['CREATE SCHEMA billing']), [{ name: 'billing', expect: 'present' }]);
	assert.deepEqual(classifySchemaExpectations(['CREATE SCHEMA IF NOT EXISTS billing']), [{ name: 'billing', expect: 'present' }]);
	assert.deepEqual(classifySchemaExpectations(['DROP SCHEMA billing']), [{ name: 'billing', expect: 'absent' }]);
	assert.deepEqual(classifySchemaExpectations(['DROP SCHEMA IF EXISTS billing']), [{ name: 'billing', expect: 'absent' }]);
});

test('classifySchemaExpectations: CREATE/DROP TABLE/INDEX contribute no schema expectations', () => {
	assert.deepEqual(classifySchemaExpectations(['CREATE TABLE widgets (id uuid)']), []);
	assert.deepEqual(classifySchemaExpectations(['CREATE INDEX idx_x ON widgets (name)']), []);
});

function fakeDdlTxn(transactionId, expectedTables) {
	return { transaction_id: transactionId, postcondition: { expected_tables: expectedTables } };
}

test('requiredConfirmValue: a non-drop transaction requires the transaction id, unchanged', () => {
	assert.equal(requiredConfirmValue(fakeDdlTxn('pt-abc', [{ name: 'widgets', expect: 'present' }])), 'pt-abc');
	assert.equal(requiredConfirmValue(fakeDdlTxn('pt-abc', [])), 'pt-abc');
});

test('requiredConfirmValue: a transaction that drops a table requires retyping that table\'s name instead', () => {
	assert.equal(requiredConfirmValue(fakeDdlTxn('pt-abc', [{ name: 'widgets', expect: 'absent' }])), 'widgets');
});

test('requiredConfirmValue: dropping multiple tables requires the sorted, comma-joined list of all of them', () => {
	assert.equal(
		requiredConfirmValue(fakeDdlTxn('pt-abc', [{ name: 'zebras', expect: 'absent' }, { name: 'apples', expect: 'absent' }])),
		'apples,zebras',
	);
});

test('requiredConfirmValue: a mixed batch (some tables created, one dropped) still requires the dropped table name(s), not the transaction id', () => {
	assert.equal(
		requiredConfirmValue(fakeDdlTxn('pt-abc', [{ name: 'gadgets', expect: 'present' }, { name: 'widgets', expect: 'absent' }])),
		'widgets',
	);
});

test('classifyTableExpectations: the same table named by multiple statements collapses to one entry (last classification wins)', () => {
	assert.deepEqual(
		classifyTableExpectations(['CREATE TABLE widgets (id uuid)', 'ALTER TABLE widgets ADD COLUMN name text']),
		[{ name: 'widgets', expect: 'present' }],
	);
});
