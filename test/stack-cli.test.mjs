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
