// S4 (D-gate-history): end-to-end CLI tests for `gate force --max-age-minutes`, `gate revoke`,
// and `gate history` -- lib/gates.mjs's own unit tests (test/gates.test.mjs) cover the primitives
// directly; these confirm the real CLI wiring (flag parsing, exit codes, JSON/human output).
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gate-cli-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gate-cli-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

test('gate force preflight, then a real new commit makes it go STALE -- the actual bug this item fixes', () => {
	const root = buildFixtureRepo();
	const force = run(['gate', 'force', 'preflight', '--reason', 'unblocking local work'], root);
	assert.equal(force.code, 0);

	const stillFresh = run(['gate', 'require', 'preflight'], root);
	assert.equal(stillFresh.code, 0);
	assert.equal(JSON.parse(stillFresh.stdout).status, 'pass (forced)');

	execFileSync('git', ['commit', '--allow-empty', '--quiet', '-m', 'chore: a real commit lands'], { cwd: root });
	const afterCommit = run(['gate', 'require', 'preflight'], root);
	assert.equal(afterCommit.code, 4, 'a forced gate must go STALE once its real bound inputs change, not stay pass forever');
	const result = JSON.parse(afterCommit.stdout);
	assert.equal(result.status, 'stale');
	assert.deepEqual(result.changed_inputs, ['head_sha']);
});

test('gate force --max-age-minutes: expires on time even though inputs still match; without the flag, no time-based expiry', () => {
	const root = buildFixtureRepo();
	run(['gate', 'force', 'preflight', '--reason', 'temporary unblock', '--max-age-minutes', '30'], root);
	const record = JSON.parse(run(['gate', 'show', 'preflight'], root).stdout).record;
	assert.equal(record.evidence.freshness.max_age_minutes, 30);
	// Immediately after forcing, well within the 30-minute window -- still PASS.
	assert.equal(run(['gate', 'require', 'preflight'], root).code, 0);
});

test('gate force --max-age-minutes rejects a non-numeric value cleanly, not a crash', () => {
	const root = buildFixtureRepo();
	const result = run(['gate', 'force', 'preflight', '--reason', 'x', '--max-age-minutes', 'not-a-number'], root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /--max-age-minutes must be a non-negative number/);
});

test('gate revoke: un-passes a gate with an auditable reason; require reports NOT_PASSED/revoked afterward', () => {
	const root = buildFixtureRepo();
	assert.equal(run(['preflight'], root).code, 0);
	assert.equal(run(['gate', 'require', 'preflight'], root).code, 0);

	const revoke = run(['gate', 'revoke', 'preflight', '--reason', 'discovered the check was wrong'], root);
	assert.equal(revoke.code, 2);
	assert.equal(JSON.parse(revoke.stdout).status, 'revoked');

	const after = run(['gate', 'require', 'preflight'], root);
	assert.equal(after.code, 2);
	assert.equal(JSON.parse(after.stdout).status, 'revoked');
});

test('gate revoke requires --reason, same auditability contract as gate force', () => {
	const root = buildFixtureRepo();
	const result = run(['gate', 'revoke', 'preflight'], root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /reason/);
});

test('gate history: records pass, force, and revoke events in order, both human and --json output', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['gate', 'revoke', 'preflight', '--reason', 'oops'], root);
	run(['gate', 'force', 'preflight', '--reason', 'unblock again'], root);

	const human = run(['gate', 'history', 'preflight'], root);
	assert.equal(human.code, 0);
	assert.match(human.stdout, /pass/);
	assert.match(human.stdout, /revoke.*oops/s);
	assert.match(human.stdout, /force.*unblock again/s);

	const jsonResult = run(['gate', 'history', 'preflight', '--json'], root);
	const events = JSON.parse(jsonResult.stdout);
	assert.deepEqual(events.map((e) => e.event), ['pass', 'revoke', 'force']);
});

test('gate history for a gate that never ran reports empty, not an error', () => {
	const root = buildFixtureRepo();
	const result = run(['gate', 'history', 'stack'], root);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /no history recorded/);
});

test('gate history is scoped by gate name -- forcing a different gate does not appear', () => {
	const root = buildFixtureRepo();
	run(['preflight'], root);
	run(['gate', 'force', 'stack', '--reason', 'unrelated'], root);

	const events = JSON.parse(run(['gate', 'history', 'preflight', '--json'], root).stdout);
	assert.equal(events.length, 1);
	assert.equal(events[0].gate, 'preflight');
});
