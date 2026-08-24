#!/usr/bin/env node
// D-greenfield-parameters (P2b): the ONLY script in this repo that talks to a LIVE external
// service -- start.spring.io itself, not a mock. `npm test`'s own coverage of the java-version/
// group-id/dependency validation is entirely mocked-fetch (D-greenfield-bootstrap's "CI must not
// hit an external service" rule), which proves this repo's own code is correct but says nothing
// about whether Initializr's real, live behavior still matches what P2b measured when it shipped
// (a real, dated validation matrix recorded in DECISIONS.md -- javaVersion=99 returning HTTP 200
// with a project that doesn't compile, groupId=com.new doing the same, dependencies/type/
// packaging/language failing closed with a clean 400). That matrix is explicitly a point-in-time
// measurement, not a permanent contract with a service this project doesn't control.
//
// Run on a schedule (see .github/workflows/ci.yml's `spring-initializr-canary` job), never on a
// push/PR -- a real Initializr outage or behavior change should surface as a scheduled-run
// failure someone notices, not a flaky, blocking PR check nobody asked for.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');

function sh(cmd, args, cwd, opts = {}) {
	return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
}

function fail(message) {
	console.error(`spring-initializr-canary: FAIL -- ${message}`);
	process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-spring-canary-'));
const projectDir = path.join(scratch, 'canary-service');

console.log('spring-initializr-canary: scaffolding a real project via the live start.spring.io API...');
try {
	// Deliberately exercises the two live-validated parameters together: --java-version (the one
	// P2b flag with an on-demand, never-cached live metadata check) and --add-dependencies (a
	// live-validated, server-fails-closed parameter). A non-default value for each is the whole
	// point -- the default path never calls Initializr's metadata endpoint at all.
	sh('node', [
		CLI, 'new', '--stack', 'spring',
		'--slug', 'canary-service',
		'--group-id', 'com.example.canary',
		'--java-version', '21',
		'--add-dependencies', 'actuator',
		'--dir', projectDir,
	], scratch, { quiet: true });
} catch (err) {
	fail(`bskel new --stack spring failed against the live API:\n${err.stdout || err.stderr || err.message}`);
}

if (!fs.existsSync(path.join(projectDir, 'build.gradle'))) {
	fail('bskel new reported success but build.gradle was not written');
}
const buildGradle = fs.readFileSync(path.join(projectDir, 'build.gradle'), 'utf8');
if (!buildGradle.includes('com.example.canary')) {
	fail(`build.gradle does not contain the requested groupId -- Initializr's own request/response contract may have changed:\n${buildGradle}`);
}
if (!buildGradle.includes('spring-boot-starter-actuator')) {
	fail(`build.gradle does not contain the requested --add-dependencies actuator:\n${buildGradle}`);
}
if (!fs.readFileSync(path.join(projectDir, 'build.gradle'), 'utf8').match(/languageVersion\s*=\s*JavaLanguageVersion\.of\(21\)/)) {
	fail('build.gradle does not request Java 21 -- the live javaVersion metadata check may have silently let a bad value through, or Initializr\'s own response shape changed');
}

console.log('spring-initializr-canary: running a real ./gradlew compileJava against the scaffolded project...');
try {
	sh('chmod', ['+x', 'gradlew'], projectDir, { quiet: true });
	sh('./gradlew', ['compileJava', '--console=plain'], projectDir, { quiet: true });
} catch (err) {
	fail(`./gradlew compileJava failed against a project Initializr itself generated:\n${err.stdout || err.stderr || err.message}`);
}

console.log('spring-initializr-canary: PASS -- start.spring.io still accepts these parameters and produces a project that compiles.');
fs.rmSync(scratch, { recursive: true, force: true });
