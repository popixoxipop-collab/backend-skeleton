// ROADMAP.md Phase 5a: the fast, deterministic regression guard for
// `scripts/shadow-validation-smoke.mjs` -- `npm test` can run this every time because it never
// touches the network. Reuses `test/fixtures/java-compile` (the same fixture
// `scripts/db-introspect-smoke.mjs` already reuses) and the exact scratch-repo-plus-bare-origin
// convention that script established, then invokes the shadow-validation script's own literal
// git-URL/local-path spec form (its header explains why that form exists) to drive a REAL
// clone -> scan -> preflight -> feature init -> scan --feature -> handles plan sequence against a
// real local git remote -- this is a black-box, subprocess-level test (matching this project's own
// established CLI-test convention, e.g. test/package-manifest.test.mjs), not a reimplementation of
// the script's internals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'shadow-validation-smoke.mjs');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'java-compile');

function sh(cmd, args, cwd) {
	return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

// Builds a real local bare git remote from the java-compile fixture -- same shape
// `db-introspect-smoke.mjs` already builds for the same fixture, so a real `git clone` against it
// behaves exactly like cloning a real GitHub repo, just over the filesystem instead of the network.
function buildLocalOracle() {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-shadow-validation-cli-test-'));
	fs.cpSync(FIXTURE, scratch, { recursive: true });
	fs.writeFileSync(path.join(scratch, '.gitignore'), 'specs/\n.sbf/\n.gradle/\nbuild/\ngradlew\ngradlew.bat\ngradle/wrapper/\n');
	sh('git', ['init', '--quiet', '--initial-branch=develop'], scratch);
	sh('git', ['config', 'user.email', 'test@example.com'], scratch);
	sh('git', ['config', 'user.name', 'Test'], scratch);
	sh('git', ['add', '-A'], scratch);
	sh('git', ['commit', '--quiet', '-m', 'chore: shadow-validation-cli-test fixture'], scratch);

	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-shadow-validation-cli-test-origin-'));
	sh('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], bareOrigin);
	sh('git', ['remote', 'add', 'origin', bareOrigin], scratch);
	sh('git', ['push', '--quiet', 'origin', 'develop'], scratch);

	return { scratch, bareOrigin };
}

// spawnSync (not execFileSync) -- execFileSync's return value only ever carries stdout, even on a
// clean exit, and every assertion below needs the script's stderr summary lines too.
function runScript(args) {
	const r = spawnSync('node', [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
	return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('shadow-validation-smoke: a repo spec with no search terms fails fast (BAD_ARGS-equivalent), never silently broadens to "everything"', () => {
	const r = runScript(['/tmp/does-not-matter-this-should-fail-before-any-clone']);
	assert.equal(r.code, 1);
	assert.match(r.stderr, /no search terms/);
});

test('shadow-validation-smoke: an invalid owner/repo spec is rejected with a clear message', () => {
	const r = runScript(['not-a-valid-spec#term']);
	assert.equal(r.code, 1);
	assert.match(r.stderr, /invalid repo spec/);
});

test('shadow-validation-smoke: a real local-fixture run produces a coherent report and a stderr summary line', () => {
	const { scratch, bareOrigin } = buildLocalOracle();
	const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-shadow-validation-cli-test-out-')), 'report.json');
	try {
		const r = runScript([`${bareOrigin}#widget`, '--out', outPath]);
		assert.equal(r.code, 0, `expected a clean exit -- got code ${r.code}, stderr: ${r.stderr}`);
		assert.match(r.stderr, /shadow-validation-smoke: PASS -- 1 repo\(s\) shadow-validated/);
		assert.match(r.stderr, new RegExp(`shadow-validation-smoke: ${bareOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: adapter=java-spring`));

		const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
		assert.equal(report.length, 1);
		const [entry] = report;
		assert.equal(entry.repo, bareOrigin);
		assert.equal(entry.error, undefined);
		assert.equal(entry.adapter, 'java-spring');
		assert.deepEqual(entry.terms, ['widget']);
		assert.ok(entry.related_modules_count >= 1, `expected at least the widget module -- got ${entry.related_modules_count}`);
		assert.ok(Array.isArray(entry.scan_unknowns));
		assert.ok(Array.isArray(entry.handles));
		const widgetModule = entry.handles.find((m) => m.module === 'widget');
		assert.ok(widgetModule, `expected a "widget" module in the handles report -- got ${JSON.stringify(entry.handles)}`);
		assert.ok(widgetModule.resources_planned >= 1, 'expected the Widget entity to be planned as a resource');
		assert.ok(Array.isArray(widgetModule.notes));
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
		fs.rmSync(bareOrigin, { recursive: true, force: true });
		fs.rmSync(path.dirname(outPath), { recursive: true, force: true });
	}
});

test('shadow-validation-smoke: --out writes the report to a file instead of stdout', () => {
	const { scratch, bareOrigin } = buildLocalOracle();
	const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-shadow-validation-cli-test-out2-')), 'report.json');
	try {
		const r = runScript([`${bareOrigin}#widget`, '--out', outPath]);
		assert.equal(r.code, 0);
		assert.equal(r.stdout, '', 'stdout must stay empty when --out is given -- the report goes to the file, not stdout');
		assert.ok(fs.existsSync(outPath));
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
		fs.rmSync(bareOrigin, { recursive: true, force: true });
		fs.rmSync(path.dirname(outPath), { recursive: true, force: true });
	}
});

// D-oracle-corpus-pinning (ROADMAP.md Phase 5b): --manifest mode's own local, non-network coverage
// -- schema validation and the adapter-mismatch hard-fail, driven by a small synthetic manifest
// pointed at the same local bare-origin fixture every other test in this file already uses.
function writeManifest(dir, adaptersObj) {
	const manifestPath = path.join(dir, 'manifest.json');
	fs.writeFileSync(manifestPath, JSON.stringify({ contract: 'sbf.oracle-manifest/1', adapters: adaptersObj }, null, 2));
	return manifestPath;
}

test('shadow-validation-smoke --manifest: a manifest failing schema validation is rejected with a clear message', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-shadow-validation-cli-test-manifest-'));
	try {
		// Missing the required "terms" field on the one entry.
		const manifestPath = writeManifest(dir, { 'java-spring': [{ id: 'x', owner: 'o', repo: 'r', ref: '0'.repeat(40), note: 'n' }] });
		const r = runScript(['--manifest', manifestPath]);
		assert.equal(r.code, 1);
		assert.match(r.stderr, /failed schema validation/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('shadow-validation-smoke --manifest: --adapter naming an adapter absent from the manifest is rejected', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-shadow-validation-cli-test-manifest-'));
	try {
		const manifestPath = writeManifest(dir, { 'java-spring': [{ id: 'x', owner: 'o', repo: 'r', ref: '0'.repeat(40), terms: ['a'], note: 'n' }] });
		const r = runScript(['--manifest', manifestPath, '--adapter', 'python-fastapi']);
		assert.equal(r.code, 1);
		assert.match(r.stderr, /has no entries in manifest/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('shadow-validation-smoke --manifest: --manifest combined with positional repo specs is rejected', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-shadow-validation-cli-test-manifest-'));
	try {
		const manifestPath = writeManifest(dir, { 'java-spring': [{ id: 'x', owner: 'o', repo: 'r', ref: '0'.repeat(40), terms: ['a'], note: 'n' }] });
		const r = runScript(['--manifest', manifestPath, 'owner/repo#term']);
		assert.equal(r.code, 1);
		assert.match(r.stderr, /cannot be combined with positional repo specs/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('shadow-validation-smoke --manifest: a real run against a local fixture with the correct declared adapter PASSes cleanly', () => {
	const { scratch, bareOrigin } = buildLocalOracle();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-shadow-validation-cli-test-manifest-'));
	try {
		// `owner: null` is the local-test literal form (schemas/oracle-manifest.schema.json) -- repo
		// is used as-is as the clone target, matching parseRepoSpec's own literal-path form.
		const manifestPath = writeManifest(dir, {
			'java-spring': [{ id: 'widget-fixture', owner: null, repo: bareOrigin, ref: null, path: null, terms: ['widget'], note: 'local fixture' }],
		});
		const r = runScript(['--manifest', manifestPath]);
		assert.equal(r.code, 0, `expected a clean exit -- stderr: ${r.stderr}`);
		assert.match(r.stderr, /PASS -- 1 repo\(s\) shadow-validated/);
		const report = JSON.parse(r.stdout);
		assert.equal(report[0].manifestId, 'widget-fixture');
		assert.equal(report[0].expectedAdapter, 'java-spring');
		assert.equal(report[0].adapter, 'java-spring');
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
		fs.rmSync(bareOrigin, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('shadow-validation-smoke --manifest: a declared-adapter mismatch hard-fails with MANIFEST MISMATCH', () => {
	const { scratch, bareOrigin } = buildLocalOracle();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-shadow-validation-cli-test-manifest-'));
	try {
		const manifestPath = writeManifest(dir, {
			'python-fastapi': [{ id: 'widget-fixture', owner: null, repo: bareOrigin, ref: null, path: null, terms: ['widget'], note: 'declares the WRONG adapter on purpose' }],
		});
		const r = runScript(['--manifest', manifestPath]);
		assert.equal(r.code, 1, `expected a hard-fail on adapter mismatch -- stderr: ${r.stderr}`);
		assert.match(r.stderr, /MANIFEST MISMATCH -- declared adapter "python-fastapi" but scan detected "java-spring"/);
		assert.match(r.stderr, /at least one manifest entry declared the wrong adapter/);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
		fs.rmSync(bareOrigin, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
