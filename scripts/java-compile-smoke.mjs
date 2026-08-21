#!/usr/bin/env node
// P3 (D-fixture-corpus): the one thing this project has never automated -- proof that
// `bskel handles emit`'s generated Java actually compiles. Runs the full gated workflow against
// test/fixtures/java-compile/ in a scratch copy, then routes the final check through
// `bskel verify --feature ... --build` (not a direct `gradle` call) so this also exercises
// lib/verify.mjs::detectBuildCommand()'s real ./gradlew path end-to-end -- the same code path a
// real user's `bskel verify --build` takes, not a shortcut around it.
//
// Requires `gradle` on PATH (used once, to generate the wrapper -- CI installs it via
// gradle/actions/setup-gradle). Everything after that runs through the generated ./gradlew, the
// same as a real consumer of this tool would have.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'java-compile');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');

function sh(cmd, args, cwd, opts = {}) {
	return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
}

function bskel(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function fail(message) {
	console.error(`java-compile-smoke: FAIL -- ${message}`);
	process.exit(1);
}

console.log('java-compile-smoke: copying fixture to a scratch git repo...');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-compile-smoke-'));
fs.cpSync(FIXTURE, scratch, { recursive: true });
// D-fixture-corpus (P3): `gradle wrapper` (below) runs AFTER this commit and writes gradlew/
// gradlew.bat/gradle/wrapper/* into the scratch repo -- all of that must be gitignored here too
// (matching this skill's own root .gitignore for test/fixtures/java-compile/), or `bskel
// preflight`'s DIRTY check correctly (and unhelpfully, for this throwaway repo) fails on files
// that were never meant to be tracked. Found by direct execution against a real GitHub Actions
// run, not assumed -- confirmed live.
fs.writeFileSync(path.join(scratch, '.gitignore'), 'specs/\n.sbf/\n.gradle/\nbuild/\ngradlew\ngradlew.bat\ngradle/wrapper/\n');

sh('git', ['init', '--quiet', '--initial-branch=develop'], scratch, { quiet: true });
sh('git', ['config', 'user.email', 'test@example.com'], scratch, { quiet: true });
sh('git', ['config', 'user.name', 'Test'], scratch, { quiet: true });
sh('git', ['add', '-A'], scratch, { quiet: true });
sh('git', ['commit', '--quiet', '-m', 'chore: java-compile-smoke fixture'], scratch, { quiet: true });
const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-compile-smoke-origin-'));
sh('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], bareOrigin, { quiet: true });
sh('git', ['remote', 'add', 'origin', bareOrigin], scratch, { quiet: true });
sh('git', ['push', '--quiet', 'origin', 'develop'], scratch, { quiet: true });

console.log('java-compile-smoke: generating the Gradle wrapper (gradle wrapper --gradle-version 8.8)...');
try {
	sh('gradle', ['wrapper', '--gradle-version', '8.8'], scratch, { quiet: true });
} catch (err) {
	fail(`could not generate the Gradle wrapper -- is \`gradle\` on PATH? (${err.message})`);
}

const FEATURE_ID = '001-widget-management';

console.log('java-compile-smoke: preflight -> feature init -> scan -> disposition -> contract emit -> handles emit...');
let r = bskel(['preflight'], scratch);
if (r.code !== 0) fail(`preflight: ${r.stderr || r.stdout}`);

r = bskel(['feature', 'init', '--slug', 'widget-management'], scratch);
if (r.code !== 0) fail(`feature init: ${r.stderr || r.stdout}`);

r = bskel(['scan', '--feature', FEATURE_ID, '--terms', 'widget'], scratch);
if (![0, 3].includes(r.code)) fail(`scan: exit ${r.code}: ${r.stderr || r.stdout}`);

r = bskel(['scan', 'disposition', '--feature', FEATURE_ID, '--mode', 'reuse', '--note', 'java-compile-smoke'], scratch);
if (r.code !== 0) fail(`scan disposition: ${r.stderr || r.stdout}`);

r = bskel(['contract', 'emit', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`contract emit: ${r.stderr || r.stdout}`);

// A3 (D-patch-strategy): approves Widget's two codegen-eligible fields (see
// test/fixtures/java-compile/.../dto/UpdateWidgetRequest.java) BEFORE handles emit, so this smoke
// test proves the real generated switch-case (Validator + ObjectMapper.convertValue + the
// service's real update method) compiles -- not just the "classified but not approved" stub path,
// which every other resource in this corpus already exercises implicitly.
r = bskel(['handles', 'patch', 'approve', '--feature', FEATURE_ID, '--resource', 'Widget', '--field', 'label', '--strategy', 'patch-wrapper', '--reason', 'java-compile-smoke'], scratch);
if (r.code !== 0) fail(`handles patch approve (label): ${r.stderr || r.stdout}`);
r = bskel(['handles', 'patch', 'approve', '--feature', FEATURE_ID, '--resource', 'Widget', '--field', 'capacity', '--strategy', 'null-means-unchanged', '--reason', 'java-compile-smoke'], scratch);
if (r.code !== 0) fail(`handles patch approve (capacity): ${r.stderr || r.stdout}`);

r = bskel(['handles', 'emit', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`handles emit: ${r.stderr || r.stdout}`);

console.log('java-compile-smoke: bskel verify --feature ... --build (real ./gradlew compileJava)...');
r = bskel(['verify', '--feature', FEATURE_ID, '--build', '--json'], scratch);
let report;
try {
	report = JSON.parse(r.stdout);
} catch {
	fail(`verify --build produced no parseable JSON (exit ${r.code}): ${r.stderr || r.stdout}`);
}
if (report.pass !== true) {
	fail(`verify --build reported pass:false -- ${JSON.stringify(report, null, 2)}`);
}

console.log('java-compile-smoke: PASS -- generated Java compiled cleanly via bskel verify --build.');
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
