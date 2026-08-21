// P2 (D-greenfield-bootstrap): `bskel new`'s two stacks.
//
// spring.mjs's real network call (start.spring.io) is deliberately NOT exercised here -- no
// existing test in this suite hits a live external service, and CI must not depend on one. The
// URL-building logic is tested directly (pure function), and the zip-extraction path is tested
// against a committed fixture zip with a mocked global.fetch, so the ONLY untested part is
// "does start.spring.io itself respond the way we assume" -- verified once, by hand, documented
// in DECISIONS.md D-greenfield-bootstrap (a real `bskel new --stack spring` scaffold compiled
// clean via `./gradlew compileJava` before this item was considered done).
//
// fastapi.mjs has no network dependency at all, so it gets a real, full end-to-end test: scaffold
// -> confirm the real scanner adapter's own detect() recognizes the output -> confirm `bskel
// preflight` fails cleanly (no remote yet, not a crash) against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildInitializrUrl, scaffoldSpring } from '../new/spring.mjs';
import { scaffoldFastapi } from '../new/fastapi.mjs';
import { detectPythonFastApiRoot } from '../scanners/adapters/python-fastapi.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');
const FIXTURE_ZIP = path.join(__dirname, 'fixtures', 'spring-initializr-fixture.zip');

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

// ---- buildInitializrUrl (pure) ---------------------------------------------------

test('buildInitializrUrl: hyphens are stripped from the slug for the Java package name (Java identifiers can\'t contain hyphens)', () => {
	const url = buildInitializrUrl({ slug: 'demo-app' });
	const params = new URL(url).searchParams;
	assert.equal(params.get('artifactId'), 'demo-app');
	assert.equal(params.get('packageName'), 'com.example.demoapp');
	assert.equal(params.get('groupId'), 'com.example');
});

test('buildInitializrUrl: requests the pinned dependency set as a stable, reviewable constant', () => {
	const url = buildInitializrUrl({ slug: 'demo' });
	const deps = new URL(url).searchParams.get('dependencies').split(',');
	assert.deepEqual(deps.sort(), ['data-jpa', 'lombok', 'security', 'validation', 'web'].sort());
});

// ---- scaffoldSpring (mocked fetch, real unzip against a committed fixture) -------

test('scaffoldSpring: --offline (via the offline flag) refuses before ever calling fetch, no directory is created', async () => {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-spring-')), 'demo');
	await assert.rejects(() => scaffoldSpring({ dir, slug: 'demo', offline: true }), /requires network access/);
	assert.equal(fs.existsSync(dir), false);
});

test('scaffoldSpring: refuses to scaffold into an existing non-empty directory', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-spring-'));
	fs.writeFileSync(path.join(dir, 'already-here.txt'), 'x');
	await assert.rejects(() => scaffoldSpring({ dir, slug: 'demo', offline: false }), /already exists and is not empty/);
});

test('scaffoldSpring: extracts the downloaded zip into the target directory (mocked fetch, real unzip against a committed fixture)', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ({
		ok: true,
		status: 200,
		statusText: 'OK',
		// Buffer.prototype.buffer is the underlying (possibly larger, pooled) ArrayBuffer, NOT
		// bounded to this Buffer's own byteOffset/byteLength -- must slice, or the "extracted" zip
		// carries whatever else shares that pool, which is exactly what broke here first.
		arrayBuffer: async () => {
			const buf = fs.readFileSync(FIXTURE_ZIP);
			return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		},
	});
	try {
		const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-spring-')), 'demo-app');
		const result = await scaffoldSpring({ dir, slug: 'demo-app', offline: false });
		assert.equal(result.dir, dir);
		assert.ok(fs.existsSync(path.join(dir, 'build.gradle')));
		assert.ok(fs.existsSync(path.join(dir, 'src/main/java/com/example/demoapp/DemoAppApplication.java')));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('scaffoldSpring: a non-ok HTTP response is reported clearly, not as a raw parse failure', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' });
	try {
		const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-spring-')), 'demo');
		await assert.rejects(() => scaffoldSpring({ dir, slug: 'demo', offline: false }), /503/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

// ---- scaffoldFastapi (real, no network) --------------------------------------------

test('scaffoldFastapi: the generated project is recognized by the real python-fastapi scanner adapter\'s own detect()', async () => {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-fastapi-')), 'demo-app');
	await scaffoldFastapi({ dir, slug: 'demo-app' });
	assert.equal(detectPythonFastApiRoot(dir), dir);
});

test('scaffoldFastapi: {{SLUG}} is substituted into pyproject.toml and main.py', async () => {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-fastapi-')), 'demo-app');
	await scaffoldFastapi({ dir, slug: 'demo-app' });
	assert.match(fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8'), /name = "demo-app"/);
	assert.match(fs.readFileSync(path.join(dir, 'app', 'main.py'), 'utf8'), /title="demo-app"/);
	assert.doesNotMatch(fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8'), /\{\{SLUG\}\}/);
});

test('scaffoldFastapi: refuses to scaffold into an existing non-empty directory', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-fastapi-'));
	fs.writeFileSync(path.join(dir, 'already-here.txt'), 'x');
	await assert.rejects(() => scaffoldFastapi({ dir, slug: 'demo' }), /already exists and is not empty/);
});

// ---- CLI: bskel new -----------------------------------------------------------------

test('bskel new: --stack must be spring or fastapi', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const result = run(['new', '--stack', 'django', '--slug', 'demo', '--dir', path.join(dir, 'demo')], dir);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /must be one of: spring, fastapi/);
});

test('bskel new: an invalid --slug is rejected (reuses lib/featureid.mjs\'s requireValidSlug, same validator every other slug-consuming command uses)', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const result = run(['new', '--stack', 'fastapi', '--slug', 'Not_Valid!', '--dir', path.join(dir, 'demo')], dir);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /invalid slug/);
});

test('bskel new --stack fastapi: full CLI path -- scaffolds, git-inits with a real commit, and the freshly created repo cleanly FAILS `bskel preflight` (no remote yet) rather than crashing', () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const dir = path.join(parent, 'demo-app');
	const scaffold = run(['new', '--stack', 'fastapi', '--slug', 'demo-app', '--dir', dir], parent);
	assert.equal(scaffold.code, 0);
	assert.match(scaffold.stdout, /bskel preflight needs a REAL remote/);

	assert.ok(fs.existsSync(path.join(dir, '.git')));
	const log = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' });
	assert.match(log, /scaffold fastapi project via bskel new/);
	const status = execFileSync('git', ['status', '--short'], { cwd: dir, encoding: 'utf8' });
	assert.equal(status.trim(), '', 'the initial commit must include everything -- no leftover untracked/modified files');

	const preflight = run(['preflight'], dir);
	assert.equal(preflight.code, 12, 'WRONG_DEFAULT -- a fresh repo with no remote must fail cleanly, not crash');
});

test('bskel new: refuses to scaffold twice into the same non-empty directory', () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const dir = path.join(parent, 'demo-app');
	const first = run(['new', '--stack', 'fastapi', '--slug', 'demo-app', '--dir', dir], parent);
	assert.equal(first.code, 0);
	const second = run(['new', '--stack', 'fastapi', '--slug', 'demo-app', '--dir', dir], parent);
	assert.notEqual(second.code, 0);
	assert.match(second.stderr, /already exists and is not empty/);
});
