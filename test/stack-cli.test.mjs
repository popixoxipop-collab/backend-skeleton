import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');

function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

function buildFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-stack-cli-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-stack-cli-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('stack apply --choice ngrok: dry-run writes nothing, --apply writes and is idempotent', () => {
	const root = buildFixtureRepo();
	assert.equal(run(['preflight'], root).code, 0);

	const dryRun = run(['stack', 'apply', '--choice', 'ngrok', '--json'], root);
	assert.equal(dryRun.code, 0);
	const plan = JSON.parse(dryRun.stdout);
	assert.equal(plan.alreadyDetected, false);
	assert.ok(plan.files.every((f) => f.action === 'create'));
	assert.ok(!fs.existsSync(path.join(root, 'scripts')), 'dry-run must not write files');

	const apply = run(['stack', 'apply', '--choice', 'ngrok', '--apply', '--json'], root);
	assert.equal(apply.code, 0);
	const result = JSON.parse(apply.stdout);
	assert.deepEqual(result.written.sort(), ['.env.example', 'scripts/_bskel-lib.sh', 'scripts/dev-tunnel.sh'].sort());
	assert.equal(result.gate.status, 'pass');

	const devTunnelPath = path.join(root, 'scripts', 'dev-tunnel.sh');
	assert.ok(fs.existsSync(devTunnelPath));
	const mode = fs.statSync(devTunnelPath).mode & 0o777;
	assert.equal(mode, 0o755, 'dev-tunnel.sh must be executable');
	assert.match(fs.readFileSync(path.join(root, '.env.example'), 'utf8'), /NGROK_AUTHTOKEN=/);

	// Re-running is idempotent: nothing left to write, already-detected.
	const rerun = run(['stack', 'apply', '--choice', 'ngrok', '--json'], root);
	const rerunPlan = JSON.parse(rerun.stdout);
	assert.equal(rerunPlan.alreadyDetected, true);
	assert.ok(rerunPlan.files.every((f) => f.action === 'unchanged'));
});

test('stack apply requires preflight to have passed', () => {
	const root = buildFixtureRepo();
	const result = run(['stack', 'apply', '--choice', 'ngrok'], root);
	assert.equal(result.code, 2);
});

test('stack apply --choice <unknown> fails with the list of known choices', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	const result = run(['stack', 'apply', '--choice', 'not-a-real-choice'], root);
	assert.notEqual(result.code, 0);
});

// D-security-4 regression: `--choice` must never be treated as a path component. Reproduces
// the exact traversal shape the Codex security review used against this code before the fix.
test('stack apply --choice rejects path-traversal-shaped values', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	for (const evil of ['../../../../etc/passwd', '..', './ngrok', '/etc/passwd', 'ngrok/../../evil']) {
		const result = run(['stack', 'apply', '--choice', evil], root);
		assert.notEqual(result.code, 0, `--choice "${evil}" must be rejected`);
	}
});

// D-security-4 regression, catalog-content variant: even a validly-named catalog entry must not
// be able to point its `template`/`path`/`config_check.target` fields outside the intended
// roots. Writes a throwaway malicious catalog file into the real stack/catalog/ dir (there is no
// other way to exercise loadCatalogEntry's real STACK_ROOT-relative resolution), and always
// removes it in `finally` even if an assertion fails.
test('a malicious catalog entry cannot write outside the target repo via template/path traversal', () => {
	const catalogDir = path.join(__dirname, '..', 'stack', 'catalog');
	const evilId = 'bskel-test-evil-traversal';
	const evilCatalogPath = path.join(catalogDir, `${evilId}.yml`);
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-security-test-outside-'));
	try {
		const root = buildFixtureRepo();
		run(['preflight'], root);

		// The escaping path field is computed relative to `root` (what stack/apply.mjs actually
		// joins it against) so this genuinely exercises the traversal, not a path that happens
		// to look dangerous but wouldn't actually resolve outside root.
		const escapingPath = path.relative(root, path.join(outsideDir, 'pwned.txt')).split(path.sep).join('/');
		fs.writeFileSync(evilCatalogPath, `
id: ${evilId}
description: "malicious fixture for a security regression test -- not a real stack choice"
static:
  files:
    - path: "${escapingPath}"
      template: "../../../../../../../../etc/hostname"
runtime:
  script: nonexistent.sh
  produces: []
`);

		const result = run(['stack', 'apply', '--choice', evilId, '--apply'], root);
		assert.notEqual(result.code, 0, 'a traversing catalog entry must be rejected, not applied');
		assert.ok(!fs.existsSync(path.join(outsideDir, 'pwned.txt')), 'must not have written outside the target repo');
	} finally {
		fs.rmSync(evilCatalogPath, { force: true });
		fs.rmSync(outsideDir, { recursive: true, force: true });
	}
});

// D-security-6 regression: a stack-apply dry-run must never read the target repo's .env, even
// read-only. Confirms detection still works via detect.files alone (no functional regression).
test('stack apply dry-run does not read .env, and detection still works via detect.files', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	fs.writeFileSync(path.join(root, '.env'), 'NGROK_AUTHTOKEN=super-secret-value-must-not-appear-anywhere\n');

	const dryRun = run(['stack', 'apply', '--choice', 'ngrok', '--json'], root);
	assert.equal(dryRun.code, 0);
	assert.doesNotMatch(dryRun.stdout, /super-secret-value-must-not-appear-anywhere/);
	const plan = JSON.parse(dryRun.stdout);
	assert.equal(plan.alreadyDetected, false, 'a bare NGROK_AUTHTOKEN in .env alone (no scripts/dev-tunnel.sh yet) should not count as already-applied');

	run(['stack', 'apply', '--choice', 'ngrok', '--apply'], root);
	const rerun = run(['stack', 'apply', '--choice', 'ngrok', '--json'], root);
	assert.equal(JSON.parse(rerun.stdout).alreadyDetected, true, 'detect.files (scripts/dev-tunnel.sh) alone is sufficient once applied');
});
