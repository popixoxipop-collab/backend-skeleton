// P1 (D-npm-packaging): "test npm pack plus installation from the tarball" from CATALOG.md's own
// concrete approach. `npm pack` -> install the REAL tarball into a throwaway scratch project ->
// run the INSTALLED `bskel` binary from `node_modules/.bin`, not `node bin/bskel.mjs` -- every
// other test in this suite invokes the CLI by path, so this is the only place a missing `bin`
// entry, a broken shebang, or a runtime asset left out of the published tarball (schemas/*.json,
// handles/providers/*/templates/*.tmpl, scripts/preflight-base-ref.sh, stack/catalog/*.yml) would
// ever actually surface. Deliberately a plain node:test file (this repo has no CI yet), not a
// separate shell script -- also runnable standalone via `npm run test:pack` since a real `npm
// pack`+install round trip is slower than the rest of the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

test('npm pack -> install the real tarball -> the installed bskel binary runs and its runtime assets resolve', () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-package-install-'));
	try {
		const tarballName = execFileSync('npm', ['pack', '--silent', '--pack-destination', scratch], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
		const tarballPath = path.join(scratch, tarballName);
		assert.ok(fs.existsSync(tarballPath), `expected npm pack to produce ${tarballPath}`);

		const installDir = path.join(scratch, 'install');
		fs.mkdirSync(installDir);
		execFileSync('npm', ['init', '--yes', '--silent'], { cwd: installDir, stdio: 'pipe' });
		execFileSync('npm', ['install', '--silent', tarballPath], { cwd: installDir, stdio: 'pipe' });

		const bskelBin = path.join(installDir, 'node_modules', '.bin', 'bskel');
		assert.ok(fs.existsSync(bskelBin), `${bskelBin} was not created (bin entry / package.json "bin" field problem)`);
		const stat = fs.statSync(fs.realpathSync(bskelBin));
		assert.ok(stat.mode & 0o111, 'the installed bskel binary must be executable');

		const versionOut = execFileSync(bskelBin, ['--version', '--json'], { encoding: 'utf8' });
		const versionJson = JSON.parse(versionOut);
		assert.equal(versionJson.name, 'bskel');
		assert.equal(typeof versionJson.version, 'string');

		// A real git repo so `doctor`'s checks resolve normally -- exercises the installed
		// schemas/templates/scripts, not just the entry point.
		const workdir = path.join(scratch, 'workdir');
		fs.mkdirSync(workdir);
		execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: workdir });
		execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workdir });
		execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workdir });

		const doctorOut = execFileSync(bskelBin, ['doctor', '--json'], { cwd: workdir, encoding: 'utf8' });
		const doctorJson = JSON.parse(doctorOut);
		assert.ok(Array.isArray(doctorJson.checks), 'expected doctor --json to report a checks array');
		const nodeCheck = doctorJson.checks.find((c) => c.name === 'Node version');
		assert.ok(nodeCheck, 'expected a "Node version" check');
		assert.equal(nodeCheck.ok, true, 'the Node version running this test must satisfy the installed package\'s own floor');

		// D-java-ast-helper (A2 Phase 2): the ast-helper's committed Gradle wrapper is a real
		// runtime asset (invoked by ast-bridge.mjs at `handles plan --ast` time), not test-only --
		// this is the one place a missing `files` entry would ever actually surface. And a
		// regression guard for a real bug this item's own DECISIONS.md entry found live: npm's
		// `files`-directory walk did not apply the root .gitignore's ignore rules to paths nested
		// inside `handles/`, so the FIRST fix attempt (a root-level .npmignore) still shipped
		// 11+MB of local `.gradle/`/`build/` output -- only a SECOND, local .npmignore placed
		// directly inside ast-helper/ itself (directory-relative patterns) actually worked.
		const astHelperDir = path.join(installDir, 'node_modules', 'backend-skeleton', 'handles', 'providers', 'java-spring', 'ast-helper');
		assert.ok(fs.existsSync(path.join(astHelperDir, 'gradlew')), 'the installed package is missing the ast-helper Gradle wrapper (gradlew)');
		assert.ok(fs.existsSync(path.join(astHelperDir, 'gradle', 'wrapper', 'gradle-wrapper.jar')), 'the installed package is missing gradle-wrapper.jar');
		assert.ok(!fs.existsSync(path.join(astHelperDir, '.gradle')), 'the installed package must NOT ship the local .gradle/ build cache');
		assert.ok(!fs.existsSync(path.join(astHelperDir, 'build')), 'the installed package must NOT ship the local build/ output directory');
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
});
