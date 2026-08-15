// Integration test for scripts/preflight-base-ref.sh using a local (no-network) origin, so
// this runs in CI/offline. Mirrors the real-world regression oracle we ran by hand against
// Team-IZ-Backend (worktree off a 658-commit-stale origin/main => FAIL, off origin/develop
// => PASS) but with a throwaway fixture repo instead of the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'preflight-base-ref.sh');

function sh(cmd, args, cwd) {
	return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}

function runPreflight(cwd, extraArgs = []) {
	try {
		const stdout = sh(SCRIPT, ['--json', '--no-fetch', ...extraArgs], cwd);
		return { code: 0, json: JSON.parse(stdout) };
	} catch (err) {
		return { code: err.status ?? 1, json: err.stdout ? JSON.parse(err.stdout) : null };
	}
}

function buildFixture() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-preflight-fixture-'));
	const originDir = path.join(base, 'origin.git');
	const workDir = path.join(base, 'work');

	fs.mkdirSync(originDir);
	sh('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], originDir);

	fs.mkdirSync(workDir);
	sh('git', ['init', '--quiet', '--initial-branch=develop'], workDir);
	sh('git', ['config', 'user.email', 'test@example.com'], workDir);
	sh('git', ['config', 'user.name', 'Test'], workDir);
	fs.writeFileSync(path.join(workDir, 'a.txt'), 'first\n');
	sh('git', ['add', 'a.txt'], workDir);
	sh('git', ['commit', '--quiet', '-m', 'chore: first commit'], workDir);
	sh('git', ['remote', 'add', 'origin', originDir], workDir);
	sh('git', ['push', '--quiet', 'origin', 'develop'], workDir);

	// One more commit on develop, pushed, so a clone that stops at the first commit is "behind".
	fs.writeFileSync(path.join(workDir, 'a.txt'), 'second\n');
	sh('git', ['commit', '--quiet', '-am', 'chore: second commit'], workDir);
	sh('git', ['push', '--quiet', 'origin', 'develop'], workDir);

	return { base, originDir, workDir };
}

test('PASS: a checkout at the current tip of the real default branch', () => {
	const { workDir } = buildFixture();
	sh('git', ['fetch', '--quiet', 'origin'], workDir);
	const result = runPreflight(workDir);
	assert.equal(result.code, 0, JSON.stringify(result));
	assert.equal(result.json.verdict, 'PASS');
	assert.equal(result.json.evidence.default_branch, 'develop');
	assert.equal(result.json.evidence.behind, 0);
});

test('FAIL/STALE_BASE: a checkout one commit behind the real default branch', () => {
	const { base, originDir, workDir } = buildFixture();
	const staleClone = path.join(base, 'stale-clone');
	// Clone at the first commit only, before the second commit was pushed.
	const firstCommit = sh('git', ['log', '--format=%H', '--reverse'], workDir).trim().split('\n')[0];
	sh('git', ['clone', '--quiet', originDir, staleClone]);
	sh('git', ['checkout', '--quiet', firstCommit], staleClone);
	sh('git', ['checkout', '--quiet', '-b', 'stale-branch'], staleClone);
	sh('git', ['fetch', '--quiet', 'origin'], staleClone);

	const result = runPreflight(staleClone);
	assert.equal(result.code, 11, JSON.stringify(result));
	assert.equal(result.json.verdict, 'FAIL');
	assert.equal(result.json.reason, 'STALE_BASE');
	assert.equal(result.json.evidence.behind, 1);
});

test('DIRTY: refuses to pass judgment on an uncommitted working tree without --allow-dirty', () => {
	const { workDir } = buildFixture();
	sh('git', ['fetch', '--quiet', 'origin'], workDir);
	fs.writeFileSync(path.join(workDir, 'uncommitted.txt'), 'oops\n');

	const result = runPreflight(workDir);
	assert.equal(result.code, 13);

	const withOverride = runPreflight(workDir, ['--allow-dirty']);
	assert.equal(withOverride.code, 0);
});

test('NOT_A_REPO: exits 10 outside any git repository', () => {
	const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-not-a-repo-'));
	const result = runPreflight(plainDir);
	assert.equal(result.code, 10);
});
