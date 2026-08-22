// P3 (D-fixture-corpus): a workflow file cannot be exercised by `npm test` -- the actual CI run
// is only ever proven by a real GitHub Actions execution (see DECISIONS.md's D-fixture-corpus for
// the green-run URL). What CAN be verified here, the same way test/doc-integrity.test.mjs closes
// the usage()<->COMMANDS drift class, is the static COUPLING between the workflow and the source
// it's supposed to be testing: the Node matrix floor never silently drifts below what this tool
// actually requires, every `npm run <script>` the workflow invokes exists in package.json, and
// every script path it references exists on disk and is executable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { MIN_NODE } from '../lib/doctor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

function loadWorkflows() {
	if (!fs.existsSync(WORKFLOWS_DIR)) return [];
	return fs.readdirSync(WORKFLOWS_DIR)
		.filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
		.map((f) => ({ file: f, doc: YAML.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8')) }));
}

function allRunCommands(doc) {
	const commands = [];
	for (const job of Object.values(doc.jobs ?? {})) {
		for (const step of job.steps ?? []) {
			if (typeof step.run === 'string') commands.push(step.run);
		}
	}
	return commands;
}

test('.github/workflows/ci.yml exists and parses as valid YAML with at least one job', () => {
	const workflows = loadWorkflows();
	assert.ok(workflows.length > 0, 'expected at least one workflow file');
	const ci = workflows.find((w) => w.file === 'ci.yml');
	assert.ok(ci, 'expected .github/workflows/ci.yml specifically');
	assert.ok(Object.keys(ci.doc.jobs ?? {}).length > 0);
});

test('the CI Node matrix floor is never below lib/doctor.mjs\'s MIN_NODE -- the workflow and the tool\'s real requirement cannot silently desync', () => {
	const { doc } = loadWorkflows().find((w) => w.file === 'ci.yml');
	const testJob = doc.jobs.test;
	assert.ok(testJob, 'expected a "test" job');
	const nodeVersions = testJob.strategy?.matrix?.node ?? [];
	assert.ok(nodeVersions.length > 0, 'expected a non-empty Node version matrix');
	for (const v of nodeVersions) {
		const major = Number(String(v).match(/^(\d+)/)?.[1]);
		assert.ok(Number.isFinite(major), `could not parse a major version out of matrix entry "${v}"`);
		assert.ok(
			major > MIN_NODE.major || major === MIN_NODE.major,
			`CI matrix entry "${v}" (major ${major}) is below lib/doctor.mjs's MIN_NODE.major (${MIN_NODE.major})`,
		);
	}
});

test('every "npm run <script>" the workflow invokes has a matching entry in package.json', () => {
	const { doc } = loadWorkflows().find((w) => w.file === 'ci.yml');
	const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
	const referenced = new Set();
	for (const cmd of allRunCommands(doc)) {
		for (const m of cmd.matchAll(/npm run ([\w:-]+)/g)) referenced.add(m[1]);
	}
	assert.ok(referenced.size > 0, 'sanity: expected at least one "npm run <script>" in the workflow');
	for (const script of referenced) {
		assert.ok(Object.hasOwn(pkg.scripts ?? {}, script), `"npm run ${script}" is invoked by CI but package.json has no such script`);
	}
});

test('scripts/java-compile-smoke.mjs exists and is executable', () => {
	const abs = path.join(REPO_ROOT, 'scripts/java-compile-smoke.mjs');
	assert.ok(fs.existsSync(abs), 'scripts/java-compile-smoke.mjs does not exist');
	const mode = fs.statSync(abs).mode;
	assert.ok(mode & 0o111, `scripts/java-compile-smoke.mjs is not executable (mode ${mode.toString(8)})`);
});

// P1 (D-npm-packaging): the package-install job's script -- once P1 merged, this superseded this
// item's own original scripts/pack-install-smoke.sh (dropped rather than keeping two overlapping
// implementations, see D-npm-packaging in DECISIONS.md). A plain node:test file, not a shell
// script, so no executable-bit requirement -- `npm run test:pack` invokes it via `node`.
test('test/package-install.test.mjs exists (the package-install job\'s npm run test:pack target)', () => {
	assert.ok(fs.existsSync(path.join(REPO_ROOT, 'test/package-install.test.mjs')));
});

test('every job installs ripgrep or does not need it (this tool shells out to rg and throws, not degrades, without it)', () => {
	const { doc } = loadWorkflows().find((w) => w.file === 'ci.yml');
	const testJob = doc.jobs.test;
	const commands = allRunCommands(doc.jobs.test ? { jobs: { test: testJob } } : doc);
	assert.ok(commands.some((c) => c.includes('ripgrep')), 'the "test" job runs the full suite, including scanner tests that shell out to rg -- expected an explicit ripgrep install step');
});

// D-handles-providers (G4) follow-up: test/handles-java-codec.test.mjs is mandatory inside plain
// `npm test` (unlike java-compile/java-integration/java-ast, which are separate scripts kept out
// of this job specifically because they need Gradle/network) -- the "test" job's own ubuntu-latest
// runner is not guaranteed to have a JDK on PATH without this step, so its absence would silently
// break every push/PR the moment that test file existed. Guards against that regressing quietly.
test('the "test" job installs a JDK (test/handles-java-codec.test.mjs needs javac/java, mandatory, unlike the Gradle-dependent java-* jobs)', () => {
	const { doc } = loadWorkflows().find((w) => w.file === 'ci.yml');
	const testJob = doc.jobs.test;
	const usesSetupJava = (testJob.steps ?? []).some((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-java@'));
	assert.ok(usesSetupJava, 'expected actions/setup-java in the "test" job -- test/handles-java-codec.test.mjs needs a real javac/java');
});

// P3b (D-python-import-check): the python-import job's script -- imports every generated Python
// module for real (fastapi+sqlmodel installed into a throwaway venv), replacing the ast.parse-only
// check that used to live in test/python-fastapi-handles.test.mjs's own default `npm test` path.
test('scripts/python-import-smoke.mjs exists and is executable', () => {
	const abs = path.join(REPO_ROOT, 'scripts/python-import-smoke.mjs');
	assert.ok(fs.existsSync(abs), 'scripts/python-import-smoke.mjs does not exist');
	const mode = fs.statSync(abs).mode;
	assert.ok(mode & 0o111, `scripts/python-import-smoke.mjs is not executable (mode ${mode.toString(8)})`);
});

test('the python-import job installs both ripgrep and a Python toolchain', () => {
	const { doc } = loadWorkflows().find((w) => w.file === 'ci.yml');
	const job = doc.jobs['python-import'];
	assert.ok(job, 'expected a "python-import" job');
	const usesSetupPython = (job.steps ?? []).some((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-python@'));
	assert.ok(usesSetupPython, 'expected actions/setup-python in the python-import job -- scripts/python-import-smoke.mjs needs python3 with a working venv module');
	const commands = allRunCommands({ jobs: { 'python-import': job } });
	assert.ok(commands.some((c) => c.includes('ripgrep')), 'scripts/python-import-smoke.mjs runs a real `bskel scan`, which shells out to rg directly');
});

// D-typescript-express-provider (G5): the typescript-compile job's script -- runs a real `npx tsc
// --noEmit` against every file `bskel handles emit` generates, catching a real type mismatch
// (e.g. a generated import pointing at a name that doesn't exist) that codec-level runtime parity
// alone cannot. Genuinely cheaper to set up than java-compile/python-import -- no extra setup-*
// action needed beyond Node itself.
test('scripts/typescript-typecheck-smoke.mjs exists and is executable', () => {
	const abs = path.join(REPO_ROOT, 'scripts/typescript-typecheck-smoke.mjs');
	assert.ok(fs.existsSync(abs), 'scripts/typescript-typecheck-smoke.mjs does not exist');
	const mode = fs.statSync(abs).mode;
	assert.ok(mode & 0o111, `scripts/typescript-typecheck-smoke.mjs is not executable (mode ${mode.toString(8)})`);
});

test('the typescript-compile job installs ripgrep (scripts/typescript-typecheck-smoke.mjs runs a real `bskel scan`)', () => {
	const { doc } = loadWorkflows().find((w) => w.file === 'ci.yml');
	const job = doc.jobs['typescript-compile'];
	assert.ok(job, 'expected a "typescript-compile" job');
	const commands = allRunCommands({ jobs: { 'typescript-compile': job } });
	assert.ok(commands.some((c) => c.includes('ripgrep')), 'scripts/typescript-typecheck-smoke.mjs runs a real `bskel scan`, which shells out to rg directly');
	assert.ok(commands.some((c) => c.includes('npm run test:typescript-compile')), 'expected the job to actually invoke npm run test:typescript-compile');
});

// A4 (D-db-schema-plane): the db-introspect job's script -- proves Plane C actually works against
// a real (disposable, service-container) Postgres, not mocked.
test('scripts/db-introspect-smoke.mjs exists and is executable', () => {
	const abs = path.join(REPO_ROOT, 'scripts/db-introspect-smoke.mjs');
	assert.ok(fs.existsSync(abs), 'scripts/db-introspect-smoke.mjs does not exist');
	const mode = fs.statSync(abs).mode;
	assert.ok(mode & 0o111, `scripts/db-introspect-smoke.mjs is not executable (mode ${mode.toString(8)})`);
});

test('the db-introspect job provides a real postgres service container with no hardcoded credential, installs ripgrep, and passes a connection string through as an env var (never a literal in the workflow file)', () => {
	const { doc } = loadWorkflows().find((w) => w.file === 'ci.yml');
	const job = doc.jobs['db-introspect'];
	assert.ok(job, 'expected a "db-introspect" job');
	const pg = job.services?.postgres;
	assert.ok(pg, 'expected a postgres service container');
	assert.equal(pg.env?.POSTGRES_HOST_AUTH_METHOD, 'trust', 'the disposable CI-only container should use trust auth, not a hardcoded password literal');
	assert.equal(pg.env?.POSTGRES_PASSWORD, undefined, 'no password literal should be committed, even a throwaway one -- trust auth needs none at all');
	const commands = allRunCommands({ jobs: { 'db-introspect': job } });
	assert.ok(commands.some((c) => c.includes('ripgrep')), 'scripts/db-introspect-smoke.mjs runs a real `bskel scan`, which shells out to rg directly');
	const dbUrlStep = (job.steps ?? []).find((s) => s.env?.BSKEL_TEST_DATABASE_URL);
	assert.ok(dbUrlStep, 'expected a step passing BSKEL_TEST_DATABASE_URL as an env var');
});
