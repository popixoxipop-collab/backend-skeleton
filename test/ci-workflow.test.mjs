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

test('scripts/pack-install-smoke.sh and scripts/java-compile-smoke.mjs exist and are executable', () => {
	for (const rel of ['scripts/pack-install-smoke.sh', 'scripts/java-compile-smoke.mjs']) {
		const abs = path.join(REPO_ROOT, rel);
		assert.ok(fs.existsSync(abs), `${rel} does not exist`);
		const mode = fs.statSync(abs).mode;
		assert.ok(mode & 0o111, `${rel} is not executable (mode ${mode.toString(8)})`);
	}
});

test('every job installs ripgrep or does not need it (this tool shells out to rg and throws, not degrades, without it)', () => {
	const { doc } = loadWorkflows().find((w) => w.file === 'ci.yml');
	const testJob = doc.jobs.test;
	const commands = allRunCommands(doc.jobs.test ? { jobs: { test: testJob } } : doc);
	assert.ok(commands.some((c) => c.includes('ripgrep')), 'the "test" job runs the full suite, including scanner tests that shell out to rg -- expected an explicit ripgrep install step');
});
