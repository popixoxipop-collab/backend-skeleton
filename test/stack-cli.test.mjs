import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listCatalogChoices } from '../stack/apply.mjs';

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

// D-cli-contract (D2): --port used to have zero effect on the rendered script (no {{PORT}}
// substitution site existed in the template at all) -- this is the regression guard for the fix.
test('stack apply --port 9090 actually renders into the deployed script, and an invalid --port is rejected', () => {
	const root = buildFixtureRepo();
	assert.equal(run(['preflight'], root).code, 0);

	const dryRun = run(['stack', 'apply', '--choice', 'ngrok', '--port', '9090', '--json'], root);
	assert.equal(dryRun.code, 0, dryRun.stderr);
	const plan = JSON.parse(dryRun.stdout);
	const devTunnelFile = plan.files.find((f) => f.path === 'scripts/dev-tunnel.sh');
	assert.match(devTunnelFile.content, /PORT="\$\{PORT:-9090\}"/);
	assert.ok(!devTunnelFile.content.includes('{{PORT}}'), 'the {{PORT}} placeholder must not leak into the rendered output');

	for (const bad of ['abc', '0', '70000']) {
		const r = run(['stack', 'apply', '--choice', 'ngrok', '--port', bad], root);
		assert.equal(r.code, 14, `expected --port ${bad} to be rejected`);
	}
});

// S2 (d): the stack gate's token now hashes the CONTENT of every applied file (not just
// .sbf/stack.json's own bytes) -- deleting dev-tunnel.sh after apply used to leave stack.json
// byte-identical and the gate `pass` forever, even though the comment right above the old
// recompute() claimed applied-file drift was covered.
test('deleting an applied file makes the stack gate stale and names the file', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['stack', 'apply', '--choice', 'ngrok', '--apply'], root);
	assert.equal(run(['gate', 'require', 'stack'], root).code, 0);

	const devTunnelPath = path.join(root, 'scripts', 'dev-tunnel.sh');
	const backup = fs.readFileSync(devTunnelPath);
	fs.rmSync(devTunnelPath);

	const stale = run(['gate', 'require', 'stack'], root);
	assert.equal(stale.code, 4);
	const record = JSON.parse(stale.stdout);
	assert.equal(record.stale_reason, 'inputs_changed');
	assert.deepEqual(record.changed_inputs, ['applied_file:scripts/dev-tunnel.sh']);

	fs.writeFileSync(devTunnelPath, backup, { mode: 0o755 });
	assert.equal(run(['gate', 'require', 'stack'], root).code, 0, 'restoring the file must un-stale the gate');
});

// The modification half -- something an existence-only check could never catch, and exactly why
// this is a token-level fix (hashing content) rather than a checkArtifacts()-style existence check.
test('editing an applied file, leaving stack.json byte-identical, still makes the stack gate stale', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['stack', 'apply', '--choice', 'ngrok', '--apply'], root);

	const devTunnelPath = path.join(root, 'scripts', 'dev-tunnel.sh');
	const stackJsonBefore = fs.readFileSync(path.join(root, '.sbf', 'stack.json'), 'utf8');
	fs.appendFileSync(devTunnelPath, '\n# hand edit\n');
	const stackJsonAfter = fs.readFileSync(path.join(root, '.sbf', 'stack.json'), 'utf8');
	assert.equal(stackJsonAfter, stackJsonBefore, 'sanity: editing the applied file does not touch stack.json itself');

	const result = run(['gate', 'require', 'stack'], root);
	assert.equal(result.code, 4);
	const record = JSON.parse(result.stdout);
	assert.deepEqual(record.changed_inputs, ['applied_file:scripts/dev-tunnel.sh']);
});

// Regression for the applied_files-erasure bug found while designing the token change: a second,
// idempotent --apply used to overwrite applied_files with [] (applyPlan() only returns files it
// actually wrote THIS run), silently discarding the only record of what the choice owns.
//
// P4 (D-extension-conformance): genericized to loop over every catalog choice instead of
// hardcoding --choice ngrok, and the assertion is a self-consistency check (first apply's
// applied_files === second apply's) instead of a hardcoded literal file list -- the invariant
// this test protects ("idempotent re-apply must not collapse to []") holds for any catalog
// entry, and a future catalog addition gets this regression coverage for free, with no new test
// code, the same way `bskel catalog lint` (no args) already covers it for free.
test('a second, idempotent stack apply --apply still records the full applied file set', () => {
	for (const choice of listCatalogChoices()) {
		const root = buildFixtureRepo();
		run(['preflight'], root);
		run(['stack', 'apply', '--choice', choice, '--apply'], root);
		const firstRecord = JSON.parse(fs.readFileSync(path.join(root, '.sbf', 'stack.json'), 'utf8'));
		assert.ok(firstRecord.applied_files.length > 0, `${choice}: first apply must record at least one applied file`);

		run(['stack', 'apply', '--choice', choice, '--apply'], root); // idempotent: writes nothing new
		const secondRecord = JSON.parse(fs.readFileSync(path.join(root, '.sbf', 'stack.json'), 'utf8'));
		assert.deepEqual(secondRecord.applied_files.sort(), firstRecord.applied_files.sort(), `${choice}: applied_files must not collapse to [] on an idempotent re-apply`);

		assert.equal(run(['gate', 'require', 'stack'], root).code, 0, `${choice}: the gate must still be satisfiable after the idempotent re-apply`);
	}
});

// S2 (b), the one gate this slice fully closes it for: an unrelated commit must NOT stale the
// stack gate, because its input set is now precisely enumerated (applied files) instead of the
// repo-wide head_sha every other gate still uses.
test('an unrelated commit does not stale the stack gate', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['stack', 'apply', '--choice', 'ngrok', '--apply'], root);
	assert.equal(run(['gate', 'require', 'stack'], root).code, 0);

	fs.writeFileSync(path.join(root, 'UNRELATED.md'), 'nothing to do with the stack choice\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: unrelated commit'], { cwd: root });

	assert.equal(run(['gate', 'require', 'stack'], root).code, 0, 'an unrelated commit must not stale the stack gate -- its inputs no longer include head_sha');
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
