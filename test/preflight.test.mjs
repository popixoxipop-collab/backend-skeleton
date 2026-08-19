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

// D-cli-contract (D2): a non-numeric --max-behind used to make `[ "$BEHIND" -gt "$MAX_BEHIND" ]`
// fail with a bash arithmetic error that `set -euo pipefail` does NOT catch (it's inside a `[ ]`
// test, not a bare statement), silently treating the comparison as false -- disabling this
// script's entire stale-base check instead of refusing the bad argument. Exercises the script
// directly (bskel itself now also validates --max-behind before ever invoking it, but this
// script is documented as reusable standalone and must not rely on that caller alone).
test('a non-numeric --max-behind is rejected outright (exit 14), not silently treated as "not stale"', () => {
	const { workDir } = buildFixture();
	sh('git', ['fetch', '--quiet', 'origin'], workDir);
	for (const bad of ['abc', '-1', '1.5', '']) {
		const result = runPreflight(workDir, ['--max-behind', bad]);
		assert.equal(result.code, 14, `expected --max-behind ${JSON.stringify(bad)} to be rejected`);
		assert.equal(result.json, null, 'a rejected argument must not produce a verdict JSON document at all');
	}
});

// D-preflight-freshness (S3): a real `git clone` (not the hand-assembled init+remote-add+push
// buildFixture() above) so `refs/remotes/origin/HEAD` gets set locally exactly the way it does
// for every real-world checkout -- required for the exit-18 tests below, where the default
// branch must resolve from the LOCAL symbolic-ref alone (the whole point is that origin is
// unreachable when the freshness fetch runs).
function buildClonedFixture() {
	const { base, originDir } = buildFixture();
	const cloneDir = path.join(base, 'clone');
	sh('git', ['clone', '--quiet', originDir, cloneDir]);
	sh('git', ['config', 'user.email', 'test@example.com'], cloneDir);
	sh('git', ['config', 'user.name', 'Test'], cloneDir);
	return { base, originDir, cloneDir };
}

function runPreflightNoAutoOffline(cwd, extraArgs = []) {
	try {
		const stdout = sh(SCRIPT, ['--json', ...extraArgs], cwd);
		return { code: 0, json: JSON.parse(stdout) };
	} catch (err) {
		return { code: err.status ?? 1, json: err.stdout ? JSON.parse(err.stdout) : null };
	}
}

test('PASS: evidence carries every S3 field with the outcomes a real fetch produces', () => {
	const { cloneDir } = buildClonedFixture();
	const result = runPreflightNoAutoOffline(cloneDir);
	assert.equal(result.code, 0, JSON.stringify(result));
	const { evidence } = result.json;
	assert.equal(evidence.fetch, 'ok');
	assert.match(evidence.origin_tip_sha, /^[0-9a-f]{40}$/);
	assert.match(evidence.checked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
	assert.equal(evidence.worktree_dirty, false);
	assert.deepEqual(evidence.policy, { max_behind: 0, allow_dirty: false, offline: false, fetch_timeout_seconds: 60 });
	assert.equal(evidence.cross_check.symbolic_ref, 'ok');
	assert.ok(evidence.cross_check.sources_ok >= 1);
});

test('REFRESH_FAILED (exit 18): fetch attempted, origin unreachable, --offline not given', () => {
	const { cloneDir } = buildClonedFixture();
	sh('git', ['remote', 'set-url', 'origin', '/definitely/not/a/repo'], cloneDir);

	const result = runPreflightNoAutoOffline(cloneDir);
	assert.equal(result.code, 18, JSON.stringify(result));
	assert.equal(result.json.verdict, 'FAIL');
	assert.equal(result.json.reason, 'REFRESH_FAILED');
	assert.match(result.json.message, /--offline/);
	// D-preflight-freshness: a REFRESH_FAILED exit is payload-less by design (we could not even
	// determine current evidence) -- there is no `evidence` object to check, unlike STALE_BASE.
	assert.equal(result.json.evidence, undefined);
});

test('--offline (and its --no-fetch alias) skip the fetch and produce byte-identical evidence', () => {
	const { cloneDir } = buildClonedFixture();
	sh('git', ['remote', 'set-url', 'origin', '/definitely/not/a/repo'], cloneDir);

	const offline = runPreflightNoAutoOffline(cloneDir, ['--offline']);
	const noFetch = runPreflightNoAutoOffline(cloneDir, ['--no-fetch']);
	assert.equal(offline.code, 0, JSON.stringify(offline));
	assert.equal(noFetch.code, 0, JSON.stringify(noFetch));
	assert.equal(offline.json.evidence.fetch, 'skipped');
	// checked_at ticks between the two invocations -- compare everything else field-by-field.
	const { checked_at: _a, ...offlineRest } = offline.json.evidence;
	const { checked_at: _b, ...noFetchRest } = noFetch.json.evidence;
	assert.deepEqual(offlineRest, noFetchRest);
});

// D-preflight-freshness: documents PRE-EXISTING behavior (unchanged by S3) -- when
// `refs/remotes/origin/HEAD` was never set locally (buildFixture()'s init+remote-add+push never
// sets it, unlike a real `git clone`) and the URL is also broken, `git remote show origin` fails
// too, leaving zero of the three default-branch sources resolvable. That check runs BEFORE the
// new freshness-fetch step, so this is WRONG_DEFAULT (12), never REFRESH_FAILED (18) -- the
// script cannot fail to refresh a default branch it was never able to name in the first place.
test('WRONG_DEFAULT (exit 12), not REFRESH_FAILED: origin unreachable AND origin/HEAD was never set locally', () => {
	const { workDir } = buildFixture();
	sh('git', ['remote', 'set-url', 'origin', '/definitely/not/a/repo'], workDir);

	const result = runPreflightNoAutoOffline(workDir);
	assert.equal(result.code, 12, JSON.stringify(result));
	assert.equal(result.json.reason, 'WRONG_DEFAULT');
});

test('worktree_dirty is recorded accurately regardless of --allow-dirty', () => {
	const { workDir } = buildFixture();
	sh('git', ['fetch', '--quiet', 'origin'], workDir);
	assert.equal(runPreflight(workDir).json.evidence.worktree_dirty, false);

	fs.writeFileSync(path.join(workDir, 'uncommitted.txt'), 'oops\n');
	const dirtyResult = runPreflight(workDir, ['--allow-dirty']);
	assert.equal(dirtyResult.code, 0);
	assert.equal(dirtyResult.json.evidence.worktree_dirty, true);
});
