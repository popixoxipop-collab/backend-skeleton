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
import { SUITES } from '../scripts/run-next-nested-tests.mjs';

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

// A self-hosted macOS runner can stay online while its Colima VM is stopped (for example after a
// host reboot). The Docker-backed jobs must repair that state before their first `docker run`, not
// rely on a one-time manual `colima start` outside the repository.
test('every Docker-backed job runs the executable Docker recovery helper before starting a container', () => {
	const helper = path.join(REPO_ROOT, 'scripts/ensure-ci-docker.sh');
	assert.ok(fs.existsSync(helper), 'scripts/ensure-ci-docker.sh does not exist');
	const mode = fs.statSync(helper).mode;
	assert.ok(mode & 0o111, `scripts/ensure-ci-docker.sh is not executable (mode ${mode.toString(8)})`);

	const helperSource = fs.readFileSync(helper, 'utf8');
	assert.match(helperSource, /docker[^\n]* info/, 'the helper should accept an already-ready daemon without restarting it');
	assert.match(helperSource, /uname -s/, 'the helper should distinguish macOS recovery from Linux failure');
	assert.match(helperSource, /\/opt\/homebrew\/bin\/colima/, 'the launchd runner needs an explicit Homebrew fallback for Colima');
	assert.match(helperSource, /"\$colima_bin" start/, 'the helper should actually start Colima when Docker is unavailable');

	const { doc } = loadWorkflows().find((w) => w.file === 'ci.yml');
	const dockerJobs = [
		'db-introspect',
		'registry-coverage',
		'ddl-apply',
		'cross-feature-fk',
		'python-integration',
		'java-integration',
	];
	for (const name of dockerJobs) {
		const steps = doc.jobs[name]?.steps ?? [];
		const recoveryIndex = steps.findIndex((step) => step.run === './scripts/ensure-ci-docker.sh');
		const containerIndex = steps.findIndex((step) => typeof step.run === 'string' && step.run.includes('docker run'));
		assert.ok(recoveryIndex >= 0, `${name} should invoke scripts/ensure-ci-docker.sh`);
		assert.ok(containerIndex >= 0, `${name} should start a Docker container`);
		assert.ok(recoveryIndex < containerIndex, `${name} should recover Docker before its first docker run`);
	}
});

// W7: GitHub Actions' native `services:` container is Linux-only ("Container operations are only
// supported on Linux runners") -- found live when this job was first pointed at the self-hosted
// macstudio runner. Replaced with a manual `docker run`/health-poll/`docker rm -f` sequence that
// works identically on ubuntu-latest's preinstalled Docker and macstudio's colima-provided one, so
// this test now checks the run commands directly instead of a services: block.
test('the db-introspect job provides a disposable postgres container with no hardcoded credential, installs ripgrep, and passes a connection string through as an env var (never a literal in the workflow file)', () => {
	const { doc } = loadWorkflows().find((w) => w.file === 'ci.yml');
	const job = doc.jobs['db-introspect'];
	assert.ok(job, 'expected a "db-introspect" job');
	assert.equal(job.services, undefined, 'db-introspect should no longer use a services: container -- it is Linux-only and this job now runs on macstudio too');
	const commands = allRunCommands({ jobs: { 'db-introspect': job } });
	assert.ok(commands.some((c) => c.includes('ripgrep')), 'scripts/db-introspect-smoke.mjs runs a real `bskel scan`, which shells out to rg directly');
	assert.ok(commands.some((c) => c.includes('docker run') && c.includes('postgres:16')), 'expected a step that starts a real disposable postgres container via `docker run`');
	assert.ok(commands.some((c) => c.includes('POSTGRES_HOST_AUTH_METHOD=trust')), 'the disposable CI-only container should use trust auth, not a hardcoded password literal');
	assert.ok(!commands.some((c) => c.includes('POSTGRES_PASSWORD')), 'no password literal should be committed, even a throwaway one -- trust auth needs none at all');
	assert.ok(commands.some((c) => c.includes('pg_isready')), 'expected a health-poll step waiting for the container to become ready before the test step runs');
	const dbUrlStep = (job.steps ?? []).find((s) => s.env?.BSKEL_TEST_DATABASE_URL);
	assert.ok(dbUrlStep, 'expected a step passing BSKEL_TEST_DATABASE_URL as an env var');
});

// Nested next-plane suites gate CI only through steps of the `nested-next` job, each running
// `node scripts/run-next-nested-tests.mjs <id>`. These drifts would leave a suite ungated while every
// test stays green: a suite that exists in the runner but has no step, a suite id listed twice (the
// CLI keeps the last entry, so the other suite never runs), a `needs` on a job that pull requests skip,
// and a track that has neither a suite nor a named owner elsewhere. Tracks T15 (backend-decoder) and
// T16 (Backend-evaluation) run their tests in their own repositories, so they are listed here instead
// of in SUITES. The rule reads ci.yml statically: it does not model step shells, NODE_OPTIONS, matrix
// reductions or workflow path filters.
const NESTED_TRACKS = Array.from({ length: 23 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`);
const NESTED_TRACKS_IN_OTHER_REPOS = ['T15', 'T16'];
const NESTED_STEP_COMMAND = /^node scripts\/run-next-nested-tests\.mjs (T\d\d)$/;

function countIds(ids) {
	const counts = new Map();
	for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
	return counts;
}

function nestedCoverageProblems(doc, suiteIds) {
	const job = doc.jobs?.['nested-next'];
	if (!job) return ['ci.yml has no "nested-next" job'];
	const problems = [];
	if (job['continue-on-error'] || job.if !== undefined) problems.push('the nested-next job must run unconditionally (no "if", no "continue-on-error")');
	if (job.needs !== undefined) problems.push('the nested-next job must not declare "needs": a skipped dependency (macos is skipped on pull requests) skips every nested suite');
	const stepIds = [];
	for (const step of job.steps ?? []) {
		if (typeof step.run !== 'string' || !step.run.includes('run-next-nested-tests')) continue;
		const match = NESTED_STEP_COMMAND.exec(step.run.trim());
		if (!match) {
			problems.push(`nested-next step "${step.name ?? step.run}" must be exactly "node scripts/run-next-nested-tests.mjs T<nn>", not: ${step.run.trim()}`);
			continue;
		}
		if (step['continue-on-error'] || step.if !== undefined) problems.push(`nested-next step "${step.name ?? step.run}" must run unconditionally (no "if", no "continue-on-error")`);
		stepIds.push(match[1]);
	}
	const suiteCounts = countIds(suiteIds);
	const stepCounts = countIds(stepIds);
	for (const [id, count] of suiteCounts) {
		if (count > 1) problems.push(`${id} appears ${count} times in the runner's SUITES; ids must be unique because the CLI keeps only the last entry`);
		if (!stepCounts.has(id)) problems.push(`${id} is in the runner's SUITES but the nested-next job has no step for it`);
	}
	for (const [id, count] of stepCounts) {
		if (count > 1) problems.push(`the nested-next job has ${count} steps for ${id}; it needs exactly one`);
		if (!suiteCounts.has(id)) problems.push(`the nested-next job runs ${id}, which is not in the runner's SUITES`);
	}
	for (const id of NESTED_TRACKS_IN_OTHER_REPOS) {
		if (suiteIds.includes(id)) problems.push(`${id} is listed as running in another repository but the runner also has a suite for it`);
	}
	for (const id of NESTED_TRACKS) {
		if (!suiteIds.includes(id) && !NESTED_TRACKS_IN_OTHER_REPOS.includes(id)) problems.push(`${id} has no runner suite and is not listed as running in another repository`);
	}
	for (const id of suiteIds) {
		if (!NESTED_TRACKS.includes(id)) problems.push(`${id} is in the runner's SUITES but not in this test's track list`);
	}
	return problems;
}

test('the nested-next job runs exactly the suites of scripts/run-next-nested-tests.mjs, and every track is a suite or owned by another repository', () => {
	const { doc } = loadWorkflows().find((w) => w.file === 'ci.yml');
	assert.deepEqual(nestedCoverageProblems(doc, SUITES.map((s) => s.id)), []);
});

test('the nested-next coverage rule reports each listed way a suite can drop out of CI', () => {
	// A synthetic, known-good configuration, so each case below fails because of its own edit and this
	// test stays independent of the real ci.yml and SUITES.
	const ids = NESTED_TRACKS.filter((id) => !NESTED_TRACKS_IN_OTHER_REPOS.includes(id));
	const goodDoc = () => ({
		jobs: { 'nested-next': { steps: [{ run: 'npm ci' }, ...ids.map((id) => ({ name: id, run: `node scripts/run-next-nested-tests.mjs ${id}` }))] } },
	});
	const stepFor = (job, id) => job.steps.find((s) => s.run === `node scripts/run-next-nested-tests.mjs ${id}`);
	assert.deepEqual(nestedCoverageProblems(goodDoc(), ids), [], 'the rule must accept a correct configuration, or none of the cases below prove anything');
	const cases = [
		['a suite without a CI step', (job) => { job.steps = job.steps.filter((s) => s !== stepFor(job, 'T12')); }, ids, /T12 is in the runner's SUITES but the nested-next job has no step for it/],
		['a CI step without a suite', (job) => { job.steps.push({ name: 'T99 nothing', run: 'node scripts/run-next-nested-tests.mjs T99' }); }, ids, /the nested-next job runs T99, which is not in the runner's SUITES/],
		['a step naming two suites', (job) => { stepFor(job, 'T01').run += ' T02'; }, ids, /must be exactly "node scripts\/run-next-nested-tests\.mjs T<nn>"/],
		['a step masking the exit code', (job) => { stepFor(job, 'T01').run += ' || true'; }, ids, /must be exactly "node scripts\/run-next-nested-tests\.mjs T<nn>"/],
		['a step that names no suite', (job) => { stepFor(job, 'T01').run = 'node scripts/run-next-nested-tests.mjs'; }, ids, /must be exactly "node scripts\/run-next-nested-tests\.mjs T<nn>"/],
		['a step with continue-on-error', (job) => { stepFor(job, 'T01')['continue-on-error'] = true; }, ids, /nested-next step ".*" must run unconditionally/],
		['a step behind an if condition', (job) => { stepFor(job, 'T01').if = "github.event_name == 'push'"; }, ids, /nested-next step ".*" must run unconditionally/],
		['a job with continue-on-error', (job) => { job['continue-on-error'] = true; }, ids, /the nested-next job must run unconditionally/],
		['a job behind an if condition', (job) => { job.if = "github.event_name == 'push'"; }, ids, /the nested-next job must run unconditionally/],
		['a job behind if: false', (job) => { job.if = false; }, ids, /the nested-next job must run unconditionally/],
		['a step behind if: false', (job) => { stepFor(job, 'T01').if = false; }, ids, /nested-next step ".*" must run unconditionally/],
		['a job that needs another job', (job) => { job.needs = 'macos'; }, ids, /the nested-next job must not declare "needs"/],
		['a job that needs several jobs', (job) => { job.needs = ['test', 'macos']; }, ids, /the nested-next job must not declare "needs"/],
		['a suite id pasted twice in SUITES', () => {}, [...ids, 'T22'], /T22 appears 2 times in the runner's SUITES/],
		['two CI steps for one suite', (job) => { job.steps.push({ name: 'T12 again', run: 'node scripts/run-next-nested-tests.mjs T12' }); }, ids, /the nested-next job has 2 steps for T12/],
		['a suite dropped from SUITES while its step stays', () => {}, ids.filter((id) => id !== 'T12'), /the nested-next job runs T12, which is not in the runner's SUITES/],
		['a track that is neither a suite nor owned elsewhere', () => {}, ids.filter((id) => id !== 'T12'), /T12 has no runner suite and is not listed as running in another repository/],
		['a suite for a track owned by another repository', () => {}, [...ids, 'T15'], /T15 is listed as running in another repository but the runner also has a suite for it/],
		['a suite outside the known track list', () => {}, [...ids, 'T24'], /T24 is in the runner's SUITES but not in this test's track list/],
	];
	const unreported = [];
	for (const [label, edit, suiteIds, expected] of cases) {
		const doc = goodDoc();
		edit(doc.jobs['nested-next']);
		const problems = nestedCoverageProblems(doc, suiteIds);
		if (!expected.test(problems.join('\n'))) unreported.push(`${label}: the rule reported ${JSON.stringify(problems)}`);
	}
	assert.deepEqual(unreported, [], 'the rule must report each of these edits');
});

// `verify` with fewer than the three release/next files is a usage error (exit 1), so the step must name all three.
const RELEASE_POLICY_VERIFY_COMMAND = 'node release/next/release-policy.mjs verify release/next/compatibility-inventory.json release/next/release-plan.json release/next/evidence-manifest.json';

function releasePolicyVerifyProblems(doc) {
	const job = doc.jobs?.['nested-next'];
	if (!job) return ['ci.yml has no "nested-next" job'];
	const verifySteps = (job.steps ?? []).filter((step) => typeof step.run === 'string' && step.run.trim() === RELEASE_POLICY_VERIFY_COMMAND);
	if (verifySteps.length === 0) return [`the nested-next job has no step that runs exactly: ${RELEASE_POLICY_VERIFY_COMMAND}`];
	if (verifySteps.every((step) => step['continue-on-error'] || step.if !== undefined)) return ['the nested-next release-policy verify step must run unconditionally (no "if", no "continue-on-error")'];
	return [];
}

test('the nested-next job runs the offline release-policy verification over the release/next files', () => {
	const { doc } = loadWorkflows().find((w) => w.file === 'ci.yml');
	assert.deepEqual(releasePolicyVerifyProblems(doc), []);
});

test('the release-policy verify rule reports each listed way the step can drop out of CI', () => {
	const goodDoc = () => ({
		jobs: { 'nested-next': { steps: [{ run: 'npm ci' }, { name: 'T23 release-policy verify', run: RELEASE_POLICY_VERIFY_COMMAND }] } },
	});
	const verifyStep = (doc) => doc.jobs['nested-next'].steps.find((s) => s.run === RELEASE_POLICY_VERIFY_COMMAND);
	assert.deepEqual(releasePolicyVerifyProblems(goodDoc()), [], 'the rule must accept a correct configuration, or none of the cases below prove anything');
	const noStep = /the nested-next job has no step that runs exactly/;
	const notUnconditional = /the nested-next release-policy verify step must run unconditionally/;
	const cases = [
		['no verify step', (doc) => { doc.jobs['nested-next'].steps = doc.jobs['nested-next'].steps.filter((s) => s !== verifyStep(doc)); }, noStep],
		['a bare verify without the release/next files', (doc) => { verifyStep(doc).run = 'node release/next/release-policy.mjs verify'; }, noStep],
		['a verify that names only two of the three files', (doc) => { verifyStep(doc).run = RELEASE_POLICY_VERIFY_COMMAND.replace(' release/next/evidence-manifest.json', ''); }, noStep],
		['a verify over a different plan file', (doc) => { verifyStep(doc).run = RELEASE_POLICY_VERIFY_COMMAND.replace('release-plan.json', 'release-plan.copy.json'); }, noStep],
		['a step masking the exit code', (doc) => { verifyStep(doc).run += ' || true'; }, noStep],
		['a step with continue-on-error', (doc) => { verifyStep(doc)['continue-on-error'] = true; }, notUnconditional],
		['a step behind an if condition', (doc) => { verifyStep(doc).if = "github.event_name == 'push'"; }, notUnconditional],
		['a step behind if: false', (doc) => { verifyStep(doc).if = false; }, notUnconditional],
		['the step moved to another job', (doc) => { const step = verifyStep(doc); doc.jobs['nested-next'].steps = doc.jobs['nested-next'].steps.filter((s) => s !== step); doc.jobs.other = { steps: [step] }; }, noStep],
		['no nested-next job', (doc) => { delete doc.jobs['nested-next']; }, /ci\.yml has no "nested-next" job/],
	];
	const unreported = [];
	for (const [label, edit, expected] of cases) {
		const doc = goodDoc();
		edit(doc);
		const problems = releasePolicyVerifyProblems(doc);
		if (!expected.test(problems.join('\n'))) unreported.push(`${label}: the rule reported ${JSON.stringify(problems)}`);
	}
	assert.deepEqual(unreported, [], 'the rule must report each of these edits');
});
