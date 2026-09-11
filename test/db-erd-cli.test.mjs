// D-db-erd: CLI-level tests for `bskel db erd` that don't need a real Postgres -- Plane A
// (migration-file) diagrams, usage-mistake refusals, and --out/--json/stdout shapes. The real
// Plane C round trip (including the composite-FK ambiguity E4 is built around) is
// scripts/db-erd-smoke.mjs, wired into the existing db-introspect CI job. `db erd` is
// repo-independent (no --feature, no preflight) -- only a real `.git` directory is needed, so this
// file builds its own minimal fixture rather than reusing test/_contract-fixture.mjs's
// preflight/scan-disposition machinery, which this command never touches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout, stderr: '' };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

// spawnSync (not execFileSync) -- a success-path stderr note (--json-is-a-no-op, degraded-diagram
// warning) is only observable this way, same reasoning as test/_contract-fixture.mjs's own
// runCapturingStderr / the pattern-cli.test.mjs fix earlier this session.
function runCapturingStderr(args, cwd) {
	const result = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function bareRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-db-erd-cli-'));
	execFileSync('git', ['init', '--quiet'], { cwd: root });
	return root;
}

function repoWithFlywayFixture() {
	const root = bareRepo();
	const dir = path.join(root, 'src/main/resources/db/migration');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'V1__create.sql'), 'CREATE TABLE organizations (id UUID PRIMARY KEY, name VARCHAR(255));\n');
	fs.writeFileSync(path.join(dir, 'V2__widgets.sql'), 'CREATE TABLE widgets (id UUID PRIMARY KEY, organization_id UUID REFERENCES organizations (id));\n');
	return root;
}

// ---- Plane A happy path ------------------------------------------------------------------------

test('no --database-url-env, real Flyway migration files present -> a degraded Plane A diagram, with the degradation disclosed on stderr', () => {
	const root = repoWithFlywayFixture();
	const result = runCapturingStderr(['db', 'erd'], root);
	assert.equal(result.code, 0, `db erd must succeed against real migration files: ${result.stderr}`);
	assert.match(result.stdout, /^%% source: flyway migration file/m);
	assert.match(result.stdout, /erDiagram/);
	assert.match(result.stdout, /\torganizations \{/);
	assert.match(result.stdout, /\t\tunknown id\n/);
	assert.match(result.stderr, /DEGRADED -- built from migration files/);
});

// ---- refusals ------------------------------------------------------------------------------------

test('no --database-url-env and no migration files at all -> exit 14, "no schema to draw"', () => {
	const root = bareRepo();
	const result = run(['db', 'erd'], root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /no schema to draw: no Flyway\/Liquibase migration files found/);
});

test('--database-url-env naming an unset environment variable is exit 14 with the canonical D-db-schema-plane message', () => {
	const root = bareRepo();
	const result = run(['db', 'erd', '--database-url-env', 'BSKEL_DB_ERD_TEST_UNSET_VAR'], root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /BSKEL_DB_ERD_TEST_UNSET_VAR names an environment variable that isn't set/);
	assert.match(result.stderr, /never read from \.env directly/);
});

test('Liquibase changelogs detected but none are plain .sql -> a distinct, specific message naming the gap', () => {
	const root = bareRepo();
	const dir = path.join(root, 'src/main/resources/db/changelog');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'changelog-1.xml'), '<databaseChangeLog></databaseChangeLog>\n');
	const result = run(['db', 'erd'], root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /Liquibase changelogs were detected/);
	assert.match(result.stderr, /XML\/YAML changelog parsing is not supported/);
});

// ---- --out / --json / stdout shapes (E10) --------------------------------------------------------

test('--out writes the .mmd file and prints a human summary; --json with --out prints the sbf.db-erd/1 summary', () => {
	const root = repoWithFlywayFixture();
	const human = run(['db', 'erd', '--out', 'schema.mmd'], root);
	assert.equal(human.code, 0);
	const written = fs.readFileSync(path.join(root, 'schema.mmd'), 'utf8');
	assert.match(written, /^erDiagram/m);
	assert.match(human.stdout, /wrote schema\.mmd -- 2 entity\(ies\), 1 relationship\(s\), plane: migrations \(degraded\)/);

	const jsonRun = run(['db', 'erd', '--out', 'schema2.mmd', '--json'], root);
	assert.equal(jsonRun.code, 0);
	const summary = JSON.parse(jsonRun.stdout);
	assert.equal(summary.schema, 'sbf.db-erd/1');
	assert.equal(summary.plane, 'migrations');
	assert.equal(summary.entity_count, 2);
	assert.equal(summary.relationship_count, 1);
	assert.equal(summary.degraded, true);
});

// The `%% source: ... scanned <timestamp>` header line is stamped fresh by scanMigrations() at
// EACH invocation -- two separate `bskel db erd` calls are genuinely allowed to differ by that one
// timestamp (see test/db-migrations.test.mjs's own generated_at precedent: asserted by format, not
// value). Stripped here before the byte-identity comparison so this test isn't flaky-by-design.
function stripScanTimestamp(text) {
	return text.replace(/scanned \d{4}-\d{2}-\d{2}T[\d:.]+Z/, 'scanned <TIMESTAMP>');
}

test('without --out, the diagram itself is the only thing on stdout, byte-identical (modulo the scan timestamp) to what --out would write', () => {
	const root = repoWithFlywayFixture();
	const toFile = run(['db', 'erd', '--out', 'schema.mmd'], root);
	const fileContent = fs.readFileSync(path.join(root, 'schema.mmd'), 'utf8');
	const toStdout = run(['db', 'erd'], root);
	assert.equal(stripScanTimestamp(toStdout.stdout), stripScanTimestamp(fileContent));
});

test('--json without --out is a loud no-op: the diagram still goes to stdout, stderr explains why --json did nothing', () => {
	const root = repoWithFlywayFixture();
	const result = runCapturingStderr(['db', 'erd', '--json'], root);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /^%% source:/m);
	assert.match(result.stderr, /--json has no effect without --out/);
});

// ---- --help ------------------------------------------------------------------------------------

test('--help renders without crashing and documents every real flag', () => {
	const help = run(['db', 'erd', '--help'], os.tmpdir());
	assert.equal(help.code, 0);
	assert.match(help.stdout, /usage: bskel db erd/);
	assert.match(help.stdout, /--database-url-env/);
	assert.match(help.stdout, /--schema/);
});

test('`bskel db` with no subcommand falls through to usage() and exits 14, like `feature`/`handles`/`observe`', () => {
	const result = run(['db'], os.tmpdir());
	assert.equal(result.code, 14);
	assert.match(result.stderr, /bskel db erd/);
});
