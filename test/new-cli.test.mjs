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
import { buildInitializrUrl, scaffoldSpring, resolveSpringDependencies, BASE_DEPENDENCIES } from '../new/spring.mjs';
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

// Regression: the first version of `cmdNew`'s git init+commit relied entirely on an
// already-configured global git identity -- worked throughout local development (a real identity
// was already configured), then broke CI outright (a fresh runner has none, `git commit` fails,
// surfaces as a generic BAD_ARGS exit). `HOME` is overridden to an empty temp dir (no
// ~/.gitconfig reachable) and the process environment is otherwise cleared, reproducing exactly
// the "no git identity resolvable from any scope" condition CI hit.
test('bskel new: the initial commit succeeds even with NO git identity configured anywhere (reproduces the exact condition that broke CI)', () => {
	const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-fakehome-'));
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const dir = path.join(parent, 'demo-app');
	const stdout = execFileSync('node', [CLI, 'new', '--stack', 'fastapi', '--slug', 'demo-app', '--dir', dir], {
		cwd: parent, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: fakeHome },
	});
	assert.match(stdout, /scaffolded a new fastapi project/);
	const log = execFileSync('git', ['log', '--format=%an <%ae>'], { cwd: dir, encoding: 'utf8' });
	assert.equal(log.trim(), 'bskel <bskel@localhost>');
});

test('bskel new: a pre-existing real git identity is used for the initial commit, never overridden by the fallback', () => {
	// Explicit, controlled identity via a fake HOME's own ~/.gitconfig -- NOT the ambient
	// environment's identity, which (as the regression test right above proves) can't be assumed
	// present in every environment this test suite runs in (it wasn't, on CI, before this fix).
	const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-fakehome-'));
	fs.writeFileSync(path.join(fakeHome, '.gitconfig'), '[user]\n\temail = real-user@example.com\n\tname = Real User\n');
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const dir = path.join(parent, 'demo-app');
	const stdout = execFileSync('node', [CLI, 'new', '--stack', 'fastapi', '--slug', 'demo-app', '--dir', dir], {
		cwd: parent, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: fakeHome },
	});
	assert.match(stdout, /scaffolded a new fastapi project/);
	const log = execFileSync('git', ['log', '--format=%an <%ae>'], { cwd: dir, encoding: 'utf8' });
	assert.equal(log.trim(), 'Real User <real-user@example.com>');
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

// ============================================================================================
// P2b (D-greenfield-parameters): parameterizing `bskel new`.
// ============================================================================================

// ---- buildInitializrUrl: the default-behavior regression, first ------------------------------
//
// The single most important assertion in this file for P2b: a caller that passes none of the new
// parameters must produce a BYTE-IDENTICAL request to the pre-P2b one, query-parameter order
// included. Pinned as a literal string rather than reconstructed with URLSearchParams, because
// reconstructing it would reproduce whatever bug it was meant to catch.
const PRE_P2B_DEFAULT_URL = 'https://start.spring.io/starter.zip?type=gradle-project&language=java&javaVersion=17&groupId=com.example&artifactId=demo-app&name=demo-app&packageName=com.example.demoapp&dependencies=web%2Cdata-jpa%2Csecurity%2Cvalidation%2Clombok';

test('buildInitializrUrl: with no new parameters the URL is byte-identical to the pre-P2b one, query-parameter ORDER included', () => {
	assert.equal(buildInitializrUrl({ slug: 'demo-app' }), PRE_P2B_DEFAULT_URL);
});

test('buildInitializrUrl: every new Spring parameter lands on its own Initializr query key', () => {
	const url = buildInitializrUrl({
		slug: 'demo-app',
		groupId: 'com.acme',
		artifactId: 'billing-svc',
		packageName: 'com.acme.billing',
		name: 'billing',
		description: 'Billing service',
		projectVersion: '2.0.0',
		javaVersion: '21',
		packaging: 'war',
		dependencies: ['web', 'actuator'],
	});
	const p = new URL(url).searchParams;
	assert.equal(p.get('groupId'), 'com.acme');
	assert.equal(p.get('artifactId'), 'billing-svc');
	assert.equal(p.get('packageName'), 'com.acme.billing');
	assert.equal(p.get('name'), 'billing');
	assert.equal(p.get('description'), 'Billing service');
	// `--project-version` is deliberately NOT named `--version` (that is a global flag); it maps to
	// Initializr's own `version` key.
	assert.equal(p.get('version'), '2.0.0');
	assert.equal(p.get('javaVersion'), '21');
	assert.equal(p.get('packaging'), 'war');
	assert.equal(p.get('dependencies'), 'web,actuator');
	// Never sent, ever -- see the baseDir regression test below, and D-greenfield-bootstrap for boot.
	assert.equal(p.get('bootVersion'), null);
	assert.equal(p.get('baseDir'), null);
});

test('buildInitializrUrl: --group-id alone also moves the DEFAULT package name, preserving P2\'s own "<groupId>.<slug minus hyphens>" derivation', () => {
	const p = new URL(buildInitializrUrl({ slug: 'demo-app', groupId: 'com.acme' })).searchParams;
	assert.equal(p.get('packageName'), 'com.acme.demoapp');
	assert.equal(p.get('artifactId'), 'demo-app', '--group-id must not disturb the artifactId default');
});

test('buildInitializrUrl: an optional parameter left null is OMITTED from the query, never sent empty (Initializr applies its own current default)', () => {
	const url = buildInitializrUrl({ slug: 'demo', packaging: null, description: null, projectVersion: null });
	assert.equal(url.includes('packaging='), false);
	assert.equal(url.includes('description='), false);
	assert.equal(url.includes('version='), false);
});

// P2b: `baseDir` is the parameter that is never exposed AND never sent. With no baseDir the archive
// is flat, which is exactly what scaffoldSpring's `unzip -d dir` assumes and what every downstream
// adapter's detect() needs (build.gradle + src/main/java at the REPO ROOT). This asserts both
// halves: no code path sets it, and the committed fixture the extraction test uses really is flat.
test('baseDir regression: no code path sets baseDir, and the committed fixture archive really is flat (build.gradle at the root)', () => {
	const springSource = fs.readFileSync(path.join(__dirname, '..', 'new', 'spring.mjs'), 'utf8');
	const cliSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cli.mjs'), 'utf8');
	assert.equal(/params\.set\(\s*['"]baseDir['"]/.test(springSource), false, 'baseDir must never be added to the Initializr query');
	assert.equal(/['"]base-dir['"]\s*:/.test(cliSource), false, 'baseDir must never become a bskel new flag');
	const listing = execFileSync('unzip', ['-Z', '-1', FIXTURE_ZIP], { encoding: 'utf8' }).split('\n').filter(Boolean);
	assert.ok(listing.includes('build.gradle'), `expected a FLAT archive with build.gradle at the root, got: ${listing.slice(0, 5).join(', ')}`);
	assert.ok(listing.some((f) => f.startsWith('src/main/java/')), 'expected src/main/java/ at the archive root');
});

// ---- resolveSpringDependencies: replace vs. add, and the warnings that make replace safe ------

test('resolveSpringDependencies: no flags at all yields exactly the baseline set, with no warnings', () => {
	const r = resolveSpringDependencies({});
	assert.deepEqual(r.dependencies, [...BASE_DEPENDENCIES]);
	assert.deepEqual(r.warnings, []);
});

test('resolveSpringDependencies: --add-dependencies EXTENDS the baseline and can never warn (it cannot drop anything)', () => {
	const r = resolveSpringDependencies({ addDependencies: 'actuator,postgresql' });
	assert.deepEqual(r.dependencies, [...BASE_DEPENDENCIES, 'actuator', 'postgresql']);
	assert.deepEqual(r.warnings, []);
	// Re-adding something already in the baseline is a no-op, not a duplicate in the query string.
	assert.deepEqual(resolveSpringDependencies({ addDependencies: 'web' }).dependencies, [...BASE_DEPENDENCIES]);
});

test('resolveSpringDependencies: --dependencies REPLACES the baseline, and a set missing `web` warns specifically about what breaks', () => {
	const r = resolveSpringDependencies({ dependencies: 'data-jpa,validation,web' });
	assert.deepEqual(r.dependencies, ['data-jpa', 'validation', 'web']);
	assert.deepEqual(r.warnings, [], 'security/lombok are baseline but nothing in bskel needs them -- no warning');

	const noWeb = resolveSpringDependencies({ dependencies: 'data-jpa,validation' });
	assert.deepEqual(noWeb.dependencies, ['data-jpa', 'validation']);
	assert.equal(noWeb.warnings.length, 1);
	assert.match(noWeb.warnings[0], /does not include `web`/);
	assert.match(noWeb.warnings[0], /@RestController/, 'the warning must name the actual scanning consequence, not just say "missing"');
	assert.match(noWeb.warnings[0], /Scaffolding anyway/);
});

test('resolveSpringDependencies: a set missing BOTH data-jpa and validation produces both specific warnings, each naming its own consequence', () => {
	const r = resolveSpringDependencies({ dependencies: 'web,actuator' });
	assert.equal(r.warnings.length, 2);
	assert.match(r.warnings[0], /does not include `data-jpa`[\s\S]*@Entity/);
	assert.match(r.warnings[1], /does not include `validation`[\s\S]*jakarta\.validation\.Validator/);
});

test('resolveSpringDependencies: --dependencies and --add-dependencies are mutually exclusive, and an empty list is rejected rather than silently sent', () => {
	assert.throws(() => resolveSpringDependencies({ dependencies: 'web', addDependencies: 'actuator' }), /mutually exclusive/);
	assert.throws(() => resolveSpringDependencies({ dependencies: '' }), /no usable dependency ids/);
	assert.throws(() => resolveSpringDependencies({ dependencies: ' , , ' }), /no usable dependency ids/);
});

// ---- scaffoldSpring: Initializr's own 400 message is surfaced verbatim -------------------------

test('scaffoldSpring: a 400 from Initializr surfaces its own JSON `message` verbatim -- the reason pass-through validation is an honest choice for dependencies/packaging', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ({
		ok: false,
		status: 400,
		statusText: 'Bad Request',
		json: async () => ({ timestamp: '2026-08-23T05:16:12.254Z', status: 400, error: 'Bad Request', message: "Unknown dependency 'not-a-real-dep' check project metadata", path: '/starter.zip' }),
	});
	try {
		const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-spring-')), 'demo');
		await assert.rejects(
			() => scaffoldSpring({ dir, slug: 'demo', offline: false, dependencies: ['not-a-real-dep'] }),
			/it said: Unknown dependency 'not-a-real-dep' check project metadata/,
		);
		assert.equal(fs.existsSync(dir), false, 'a rejected request must leave no directory behind');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

// ---- FastAPI end-to-end: every new parameter, and the invariant that must survive them all -----

test('scaffoldFastapi: every new parameter substitutes into the right file, and the real python-fastapi adapter still detects the result', async () => {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-fastapi-')), 'demo-app');
	await scaffoldFastapi({
		dir, slug: 'demo-app', name: 'billing-svc', description: 'Billing service',
		projectVersion: '2.0.0', requiresPython: '>=3.12', port: '9000', license: 'Apache-2.0', database: 'postgres',
	});
	const pyproject = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8');
	assert.match(pyproject, /^name = "billing-svc"$/m);
	assert.match(pyproject, /^version = "2\.0\.0"$/m);
	assert.match(pyproject, /^description = "Billing service"$/m);
	assert.match(pyproject, /^license = "Apache-2\.0"$/m);
	assert.match(pyproject, /^requires-python = ">=3\.12"$/m);
	assert.match(pyproject, /"psycopg\[binary\]>=3\.2",/);
	assert.match(fs.readFileSync(path.join(dir, 'app', 'main.py'), 'utf8'), /title="billing-svc"/);
	const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
	assert.match(readme, /# billing-svc/);
	assert.match(readme, /--port 9000/);
	assert.match(readme, /## Database/);
	assert.equal(detectPythonFastApiRoot(dir), dir, 'P2\'s own invariant must survive every template edit');
});

test('scaffoldFastapi: detectPythonFastApiRoot() recognizes the output for EVERY parameter combination, not just the default one', async () => {
	const combos = [
		{},
		{ database: 'none' },
		{ database: 'sqlite' },
		{ database: 'postgres' },
		{ license: 'MIT', description: 'x', projectVersion: '9.9.9' },
		{ requiresPython: '>=3.9', port: '1' },
		{ name: 'other-name', requiresPython: '==3.13', port: '65535', license: 'MIT OR Apache-2.0', database: 'postgres', description: 'q' },
	];
	for (const [i, combo] of combos.entries()) {
		const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-fastapi-')), `demo-${i}`);
		await scaffoldFastapi({ dir, slug: 'demo-app', ...combo });
		assert.equal(detectPythonFastApiRoot(dir), dir, `combo ${i} (${JSON.stringify(combo)}) broke adapter detection`);
		assert.doesNotMatch(fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8'), /\{\{/, `combo ${i} left a template token behind`);
	}
});

test('scaffoldFastapi: --database only ever pins a driver -- it never generates engine/session/db wiring', async () => {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-fastapi-')), 'demo-app');
	const result = await scaffoldFastapi({ dir, slug: 'demo-app', database: 'postgres' });
	const files = execFileSync('find', [dir, '-type', 'f'], { encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => path.relative(dir, f)).sort();
	assert.deepEqual(files, ['.gitignore', 'README.md', 'app/__init__.py', 'app/main.py', 'pyproject.toml']);
	assert.match(result.postScaffoldNotes.join('\n'), /NOT done automatically: the engine, session and connection-URL wiring/);
	// sqlite pins nothing extra (CPython ships sqlite3) and `none` changes nothing at all.
	const sqliteDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-fastapi-')), 'demo-app');
	await scaffoldFastapi({ dir: sqliteDir, slug: 'demo-app', database: 'sqlite' });
	assert.doesNotMatch(fs.readFileSync(path.join(sqliteDir, 'pyproject.toml'), 'utf8'), /psycopg/);
});

test('scaffoldFastapi: a description containing a double quote is escaped, not left to break the generated TOML/Python', async () => {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-fastapi-')), 'demo-app');
	await scaffoldFastapi({ dir, slug: 'demo-app', description: 'a "quoted" thing', name: 'a-b' });
	assert.match(fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8'), /^description = "a \\"quoted\\" thing"$/m);
});

test('scaffoldFastapi: an omitted --license leaves NO license key at all (there is no neutral default SPDX id to invent) and no blank line where it would have been', async () => {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-fastapi-')), 'demo-app');
	await scaffoldFastapi({ dir, slug: 'demo-app' });
	const pyproject = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8');
	assert.doesNotMatch(pyproject, /license/);
	assert.match(pyproject, /^version = "0\.1\.0"\ndescription = ""\nrequires-python = ">=3\.11"$/m);
});

// ★ The fail-closed check itself. Written to FAIL against the pre-fix code path (confirmed by
// temporarily removing the check and watching this test go red -- output recorded in DECISIONS.md's
// Verification section), following the maskJsComments() discipline from D-javascript-express-adapter:
// a guard that can only ever pass proves nothing.
test('scaffoldFastapi: a template with an unsubstituted {{VAR}} fails the scaffold CLOSED -- nothing is written at all', async () => {
	const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-broken-template-'));
	fs.writeFileSync(path.join(templateDir, 'pyproject.toml'), '[project]\nname = "{{NAME}}"\nowner = "{{UNDECLARED_VARIABLE}}"\n');
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-fastapi-'));
	const dir = path.join(parent, 'demo-app');
	await assert.rejects(
		() => scaffoldFastapi({ dir, slug: 'demo-app', templateDir }),
		/unsubstituted variable\(s\)[\s\S]*\{\{UNDECLARED_VARIABLE\}\}[\s\S]*Nothing was written/,
	);
	assert.equal(fs.existsSync(dir), false, 'fail-closed means the target directory is never created, not created-then-cleaned');
});

// ---- CLI: cross-stack rejection, refusals, and the warning channel ----------------------------

test('bskel new: a Spring-only flag passed with --stack fastapi exits 14, names the flag AND the stack that takes it, and writes nothing', () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const dir = path.join(parent, 'demo-app');
	const result = run(['new', '--stack', 'fastapi', '--slug', 'demo-app', '--dir', dir, '--group-id', 'com.acme'], parent);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /--group-id is not a `--stack fastapi` parameter -- it applies to --stack spring/);
	assert.equal(fs.existsSync(dir), false);
});

test('bskel new: a FastAPI-only flag passed with --stack spring exits 14 before any network call is attempted', () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const dir = path.join(parent, 'demo-app');
	const result = run(['new', '--stack', 'spring', '--slug', 'demo-app', '--dir', dir, '--database', 'postgres'], parent);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /--database is not a `--stack spring` parameter -- it applies to --stack fastapi/);
	assert.equal(fs.existsSync(dir), false);
});

test('bskel new: --type / --language / --boot-version are refused with their own specific, cited reason -- never a bare "unknown option"', () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const cases = [
		['--type', 'maven-project', /detectJacksonPackage\(\) reads build\.gradle ONLY/],
		['--language', 'kotlin', /globs \*\.java only[\s\S]*generic-grep/],
		['--boot-version', '9.9.9', /HTTP 500[\s\S]*maintenance liability/],
	];
	for (const [flag, value, expected] of cases) {
		const dir = path.join(parent, `demo-${flag.replace(/-/g, '')}`);
		const result = run(['new', '--stack', 'spring', '--slug', 'demo-app', '--dir', dir, flag, value], parent);
		assert.equal(result.code, 14, `${flag} must exit 14`);
		assert.match(result.stderr, expected);
		assert.equal(fs.existsSync(dir), false);
	}
});

test('bskel new: a refused flag stays out of --help and out of the usage() banner (it exists only to answer with a real reason)', () => {
	const help = run(['new', '--help'], os.tmpdir());
	assert.equal(help.code, 0);
	assert.doesNotMatch(help.stdout, /--boot-version/);
	assert.match(help.stdout, /--add-dependencies/);
});

test('bskel new: an invalid --group-id is rejected locally, exit 14, with no network call and nothing written', () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const dir = path.join(parent, 'demo-app');
	const result = run(['new', '--stack', 'spring', '--slug', 'demo-app', '--dir', dir, '--group-id', 'com.new'], parent);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /segment "new" is a Java reserved word/);
	assert.equal(fs.existsSync(dir), false);
});

test('bskel new: --dependencies dropping a baseline dependency WARNS on stderr and still proceeds (it reaches the scaffold, which then refuses only because --offline)', () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const dir = path.join(parent, 'demo-app');
	const result = run(['new', '--stack', 'spring', '--slug', 'demo-app', '--dir', dir, '--dependencies', 'web,actuator', '--offline'], parent);
	assert.match(result.stderr, /does not include `data-jpa`/);
	assert.match(result.stderr, /does not include `validation`/);
	assert.doesNotMatch(result.stderr, /does not include `web`/);
	// The warning is not a refusal: execution continued past it into the scaffolder, which is what
	// then declined for the unrelated --offline reason.
	assert.match(result.stderr, /requires network access/);
	assert.equal(result.code, 2);
});

test('bskel new: --add-dependencies never warns, because it cannot drop a baseline dependency', () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const dir = path.join(parent, 'demo-app');
	const result = run(['new', '--stack', 'spring', '--slug', 'demo-app', '--dir', dir, '--add-dependencies', 'actuator', '--offline'], parent);
	assert.doesNotMatch(result.stderr, /does not include/);
	assert.match(result.stderr, /requires network access/);
});

test('bskel new: --dependencies and --add-dependencies together is BAD_ARGS, not a silent merge', () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const dir = path.join(parent, 'demo-app');
	const result = run(['new', '--stack', 'spring', '--slug', 'demo-app', '--dir', dir, '--dependencies', 'web', '--add-dependencies', 'actuator'], parent);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /mutually exclusive/);
	assert.equal(fs.existsSync(dir), false);
});

test('bskel new --stack fastapi: the full CLI path threads every new flag through, and --port is bounds-checked exactly like `stack apply --port`', () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const dir = path.join(parent, 'demo-app');
	const ok = run(['new', '--stack', 'fastapi', '--slug', 'demo-app', '--dir', dir,
		'--name', 'billing-svc', '--description', 'Billing service', '--project-version', '2.0.0',
		'--python-version', '3.12', '--port', '9000', '--license', 'MIT', '--database', 'postgres'], parent);
	assert.equal(ok.code, 0);
	assert.match(ok.stdout, /--database postgres pinned psycopg\[binary\] in pyproject\.toml\. That is all it did\./);
	const pyproject = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8');
	assert.match(pyproject, /^name = "billing-svc"$/m);
	assert.match(pyproject, /^requires-python = ">=3\.12"$/m);
	assert.match(pyproject, /^license = "MIT"$/m);

	const bad = run(['new', '--stack', 'fastapi', '--slug', 'demo-app', '--dir', path.join(parent, 'x'), '--port', '70000'], parent);
	assert.equal(bad.code, 14);
	assert.match(bad.stderr, /--port must be a whole number >= 1 and <= 65535/);
});

test('bskel new --stack fastapi --json: the payload carries the resolved parameters and the post-scaffold notes, and stdout stays exactly one JSON document', () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const dir = path.join(parent, 'demo-app');
	const result = run(['new', '--stack', 'fastapi', '--slug', 'demo-app', '--dir', dir, '--database', 'sqlite', '--license', 'MIT', '--json'], parent);
	assert.equal(result.code, 0);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.stack, 'fastapi');
	assert.equal(payload.database, 'sqlite');
	assert.equal(payload.license, 'MIT');
	assert.equal(payload.requiresPython, '>=3.11');
	assert.deepEqual(payload.warnings, []);
	assert.equal(payload.postScaffoldNotes.length, 1);
});

// ---- --java-version through the real CLI ------------------------------------------------------
//
// No production test hook is added to drive the metadata fetch from the CLI: D-greenfield-bootstrap's
// test strategy forbids a live external call in this suite, and a `BSKEL_TEST_FETCH` escape hatch in
// shipped code would be worse than the coverage it buys. The fetch behaviour is covered exhaustively
// against a mocked `fetchImpl` in test/new-params.test.mjs; what is asserted HERE is the CLI-level
// contract that the DEFAULT value never triggers a fetch at all.
test('bskel new: --java-version at the default value never triggers a metadata fetch (proved by reaching the scaffolder with no network at all)', () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-new-cli-'));
	const dir = path.join(parent, 'demo-app');
	// --offline makes the scaffold itself refuse, so reaching THAT refusal proves the run got past
	// parameter resolution -- i.e. no metadata fetch was attempted first.
	const result = run(['new', '--stack', 'spring', '--slug', 'demo-app', '--dir', dir, '--java-version', '17', '--offline'], parent);
	assert.equal(result.code, 2);
	assert.match(result.stderr, /requires network access/);
	assert.doesNotMatch(result.stderr, /validate --java-version/);
});
