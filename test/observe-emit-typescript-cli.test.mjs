// D-runtime-conformance-receipts: end-to-end CLI coverage for `bskel observe emit --module ...`
// against the typescript-express provider. Reuses the committed test/fixtures/typescript-express/
// tree (matching every other TS test file's own precedent), the real route
// `/v1/users/:id([0-9]+)` -- --openapi-file is required the same way it was for python-fastapi's
// own observe test, since typescript-express's scanned operationId is always null (`api.operations:
// false`). Unlike this repo's own handles e2e fixture helper (which uses `gate force contract`,
// leaving contract.operations empty), this file runs a REAL `contract emit --openapi-file` so
// observe emit has real operations to project -- otherwise this whole test file would be vacuous.
//
// The openapi.json below is deliberately keyed by the LITERAL Express-colon-syntax path
// (`/v1/users/:id([0-9]+)`), not the OpenAPI-standard `{id}` form -- contracts/openapi.mjs's own
// reconciliation is pure exact-string matching with zero `:id` <-> `{id}` translation (confirmed
// live), so a standards-shaped document would never match this scanned route at all. See the
// Update note in D-runtime-conformance-receipts in DECISIONS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');
const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'typescript-express');
const FEATURE_ID = '001-user-management';

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function buildOpenApiFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-observe-emit-ts-'));
	fs.cpSync(FIXTURE_SRC, root, { recursive: true });
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-observe-emit-ts-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

function runWorkflowThroughContract(root) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'user-management'], root);
	run(['scan', '--feature', FEATURE_ID, '--terms', 'user', '--json'], root);
	run(['scan', 'disposition', '--feature', FEATURE_ID, '--mode', 'extend', '--note', 'test'], root);
	// D-cli-contract convention (matching python's own observe fixture): openapi.json is written
	// AFTER preflight, not before -- an untracked file at repo root would otherwise make
	// preflight's own dirty-tree check fail.
	const openApiPath = path.join(root, 'openapi.json');
	fs.writeFileSync(openApiPath, JSON.stringify({
		openapi: '3.1.0',
		paths: { '/v1/users/:id([0-9]+)': { get: { operationId: 'users-show', responses: {} } } },
	}));
	// A non-empty --path-prefix is required by the CLI's own validation (empty string is rejected
	// outright) -- its actual VALUE is irrelevant to whether this fixture's route matches, since
	// reconcileModule()'s no-operationId branch always tries the bare scanned path as a second
	// candidate regardless of prefix (contracts/openapi.mjs, confirmed live).
	run(['contract', 'emit', '--feature', FEATURE_ID, '--module', 'users', '--openapi-file', openApiPath, '--path-prefix', '/v1'], root);
	run(['scan', 'cross-feature-check', '--feature', FEATURE_ID], root);
}

const OBSERVE_DIR = 'backend/src/observe';
const OBSERVED_SCHEMA_PATH = `${OBSERVE_DIR}/schemas/${FEATURE_ID}.observed-schema.json`;

test('observe emit --module users is blocked before the contract gate has passed', () => {
	const root = buildOpenApiFixtureRepo();
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'user-management'], root);
	const result = run(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'users'], root);
	assert.equal(result.code, 2);
});

test('observe emit writes the three TS infra modules plus the projected observed-schema.json, and never touches handles/ output', () => {
	const root = buildOpenApiFixtureRepo();
	runWorkflowThroughContract(root);

	const result = run(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'users', '--json'], root);
	assert.equal(result.code, 0, result.stderr);
	const body = JSON.parse(result.stdout);
	assert.equal(body.blocked, false);
	assert.deepEqual(
		body.written.slice().sort(),
		[
			`${OBSERVE_DIR}/contractCheck.ts`,
			`${OBSERVE_DIR}/observedSchema.ts`,
			`${OBSERVE_DIR}/observeContract.ts`,
			OBSERVED_SCHEMA_PATH,
		].sort(),
	);
	for (const f of ['contractCheck.ts', 'observedSchema.ts', 'observeContract.ts']) {
		assert.ok(fs.existsSync(path.join(root, OBSERVE_DIR, f)), `expected ${f} to exist`);
	}
	assert.ok(!fs.existsSync(path.join(root, 'backend/src/handles')), 'observe emit must never write anything handles emit owns');

	const schema = JSON.parse(fs.readFileSync(path.join(root, OBSERVED_SCHEMA_PATH), 'utf8'));
	assert.equal(schema.sbf_observed_schema, '1');
	assert.equal(schema.feature_id, FEATURE_ID);
	assert.ok(schema.operations['users-show']);
	assert.equal(schema.operations['users-show'].verb, 'GET');
	// D-openapi-path-params (A9): contracts/emit.mjs's pathParamsSchema() now recognizes Express's
	// own :name/:name(...) segment syntax, not just OpenAPI-style {name} -- closes the gap the O8
	// port's own Finding 2 named as out-of-scope (see the Update note in D-openapi-path-params in
	// DECISIONS.md). The real fixture route is `:id([0-9]+)`, so `id` is now extracted for real.
	assert.deepEqual(schema.operations['users-show'].pathParams.required, ['id']);
});

test('observe emit --module users is idempotent -- re-running rewrites nothing except the always-regenerated observed-schema.json', () => {
	const root = buildOpenApiFixtureRepo();
	runWorkflowThroughContract(root);
	run(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'users'], root);
	const before = fs.readFileSync(path.join(root, OBSERVE_DIR, 'contractCheck.ts'), 'utf8');

	const result = run(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'users', '--json'], root);
	assert.equal(result.code, 0);
	const body = JSON.parse(result.stdout);
	assert.deepEqual(body.written, [OBSERVED_SCHEMA_PATH]);
	assert.ok(body.actions.every((a) => a.action === 'unchanged'));
	assert.equal(fs.readFileSync(path.join(root, OBSERVE_DIR, 'contractCheck.ts'), 'utf8'), before);
});

test('hand-editing a generated observe infra module then re-running exits 15 and leaves the file byte-for-byte untouched', () => {
	const root = buildOpenApiFixtureRepo();
	runWorkflowThroughContract(root);
	run(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'users'], root);

	const checkPath = path.join(root, OBSERVE_DIR, 'contractCheck.ts');
	const edited = `${fs.readFileSync(checkPath, 'utf8')}\n// hand edit\n`;
	fs.writeFileSync(checkPath, edited);

	const result = run(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'users', '--json'], root);
	assert.equal(result.code, 15);
	const body = JSON.parse(result.stdout);
	assert.equal(body.blocked, true);
	assert.ok(body.conflicts.some((c) => c.path === `${OBSERVE_DIR}/contractCheck.ts`));
	assert.equal(fs.readFileSync(checkPath, 'utf8'), edited);
});

test('observe emit --check --diff previews without writing, and reports CHECK_FAILED on a fresh feature', () => {
	const root = buildOpenApiFixtureRepo();
	runWorkflowThroughContract(root);

	const result = run(['observe', 'emit', '--feature', FEATURE_ID, '--module', 'users', '--check', '--diff', '--json'], root);
	assert.equal(result.code, 1);
	const body = JSON.parse(result.stdout);
	assert.ok(body.actions.every((a) => a.action === 'create'));
	assert.ok(!fs.existsSync(path.join(root, OBSERVE_DIR, 'contractCheck.ts')), '--check must not write anything');
	assert.ok(!fs.existsSync(path.join(root, OBSERVED_SCHEMA_PATH)));
});
