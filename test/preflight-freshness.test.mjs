// D-preflight-freshness (S3): end-to-end tests for the two halves of this item --
//   S3a: local remote-tracking movement detection (origin_tip_sha added to the preflight gate's
//        recomputed inputs)
//   S3b: the TTL that makes an old-but-still-token-matching preflight pass go stale on its own
// Fixture conventions copied from test/status-next-cli.test.mjs (buildFixtureRepo/run) and
// test/preflight.test.mjs (buildClonedFixture -- a real `git clone` so refs/remotes/origin/HEAD
// is set locally the way it is for every real-world checkout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');

// spawnSync (not execFileSync) so stderr is captured on the SUCCESS path too -- execFileSync only
// exposes stderr via the thrown error on a non-zero exit.
function run(args, cwd) {
	const result = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
	return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function sh(cmd, args, cwd) {
	return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}

// Two clones off the same bare origin -- `work` is the fixture under test, `pusher` simulates
// "someone else" advancing the remote out from under it. Both are real `git clone`s (not
// init+remote-add+push) so `refs/remotes/origin/HEAD` resolves locally without any network call,
// matching what a real checkout looks like.
function buildTwoCloneFixture() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-preflight-freshness-'));
	const originDir = path.join(base, 'origin.git');
	fs.mkdirSync(originDir);
	sh('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], originDir);

	const seed = path.join(base, 'seed');
	fs.mkdirSync(seed);
	sh('git', ['init', '--quiet', '--initial-branch=develop'], seed);
	sh('git', ['config', 'user.email', 'test@example.com'], seed);
	sh('git', ['config', 'user.name', 'Test'], seed);
	fs.writeFileSync(path.join(seed, '.gitignore'), 'specs/\n.sbf/\n');
	fs.writeFileSync(path.join(seed, 'a.txt'), 'first\n');
	sh('git', ['add', '-A'], seed);
	sh('git', ['commit', '--quiet', '-m', 'chore: first commit'], seed);
	sh('git', ['remote', 'add', 'origin', originDir], seed);
	sh('git', ['push', '--quiet', 'origin', 'develop'], seed);

	const workDir = path.join(base, 'work');
	const pusherDir = path.join(base, 'pusher');
	sh('git', ['clone', '--quiet', originDir, workDir]);
	sh('git', ['config', 'user.email', 'test@example.com'], workDir);
	sh('git', ['config', 'user.name', 'Test'], workDir);
	sh('git', ['clone', '--quiet', originDir, pusherDir]);
	sh('git', ['config', 'user.email', 'test@example.com'], pusherDir);
	sh('git', ['config', 'user.name', 'Test'], pusherDir);

	return { base, originDir, workDir, pusherDir };
}

function pushOneMoreCommit(pusherDir) {
	fs.writeFileSync(path.join(pusherDir, 'a.txt'), 'second\n');
	sh('git', ['commit', '--quiet', '-am', 'chore: second commit'], pusherDir);
	sh('git', ['push', '--quiet', 'origin', 'develop'], pusherDir);
}

function backdatePreflightAt(root, minutes) {
	const statePath = path.join(root, '.sbf', '_repo.json');
	const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
	state.gates.preflight.at = new Date(Date.now() - minutes * 60_000).toISOString();
	fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

test('local remote-tracking movement: a local fetch after preflight passed is caught by gate require', () => {
	const { workDir, pusherDir } = buildTwoCloneFixture();
	assert.equal(run(['preflight', '--json'], workDir).code, 0);

	pushOneMoreCommit(pusherDir);
	// Something ELSE fetches into `work` -- not `bskel preflight` itself (which never re-fetches
	// on `require`, only on its own run). This is the exact "nothing forces this to happen"
	// mechanism the design comments describe.
	sh('git', ['fetch', '--quiet', 'origin'], workDir);

	const result = run(['gate', 'require', 'preflight', '--json'], workDir);
	const report = JSON.parse(result.stdout);
	assert.equal(report.status, 'stale');
	assert.equal(report.stale_reason, 'inputs_changed');
	assert.deepEqual(report.changed_inputs, ['origin_tip_sha']);
});

// D-preflight-freshness: the honesty test -- this mechanism is purely local (git rev-parse
// against the already-fetched remote-tracking ref, never a network call of its own). If nothing
// else fetches, the remote-tracking ref is unchanged locally and `require` has no way to know the
// real remote moved. This limitation is deliberate (see DECISIONS.md) and is pinned here so it
// can never silently start claiming more than it actually detects.
test('honesty: without an intervening local fetch, a stale-but-undetected remote still reports PASS', () => {
	const { workDir, pusherDir } = buildTwoCloneFixture();
	assert.equal(run(['preflight', '--json'], workDir).code, 0);

	pushOneMoreCommit(pusherDir);
	// No `git fetch` in `work` this time.

	const result = run(['gate', 'require', 'preflight', '--json'], workDir);
	const report = JSON.parse(result.stdout);
	assert.equal(report.status, 'pass');
});

test('TTL expiry blocks a feature-scoped scan, naming `bskel preflight` as the next action', () => {
	const { workDir } = buildTwoCloneFixture();
	assert.equal(run(['preflight', '--json'], workDir).code, 0);
	backdatePreflightAt(workDir, 35);

	const result = run(['scan', '--feature', '001-widget-management', '--terms', 'widget', '--json'], workDir);
	const report = JSON.parse(result.stdout);
	assert.equal(result.code, 4);
	assert.equal(report.code, 4);
	assert.equal(report.reason, 'GATE_STALE');
	assert.equal(report.next_actions[0].command, 'bskel preflight');
});

test('--max-age-minutes 0 disables the TTL: the same 35-minute-old pass is not blocked', () => {
	const { workDir } = buildTwoCloneFixture();
	assert.equal(run(['preflight', '--max-age-minutes', '0', '--json'], workDir).code, 0);
	backdatePreflightAt(workDir, 35);

	const result = run(['gate', 'require', 'preflight', '--json'], workDir);
	const report = JSON.parse(result.stdout);
	assert.equal(report.status, 'pass');
});

// D-preflight-freshness: origin/HEAD not being set locally (buildFixture()-style init+remote-add,
// never a real `git clone`/`git remote set-head`) must not break preflight -- origin_tip_sha is
// simply null, and require still functions (just without local-movement detection for this repo).
test('a repo whose local origin/HEAD was never set still passes, with origin_tip_sha null', () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-preflight-freshness-nohead-'));
	const originDir = path.join(base, 'origin.git');
	fs.mkdirSync(originDir);
	sh('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], originDir);

	const workDir = path.join(base, 'work');
	fs.mkdirSync(workDir);
	sh('git', ['init', '--quiet', '--initial-branch=develop'], workDir);
	sh('git', ['config', 'user.email', 'test@example.com'], workDir);
	sh('git', ['config', 'user.name', 'Test'], workDir);
	fs.writeFileSync(path.join(workDir, '.gitignore'), 'specs/\n.sbf/\n');
	fs.writeFileSync(path.join(workDir, 'a.txt'), 'first\n');
	sh('git', ['add', '-A'], workDir);
	sh('git', ['commit', '--quiet', '-m', 'chore: first commit'], workDir);
	sh('git', ['remote', 'add', 'origin', originDir], workDir);
	sh('git', ['push', '--quiet', 'origin', 'develop'], workDir);

	const result = run(['preflight', '--json'], workDir);
	assert.equal(result.code, 0, JSON.stringify(result));
	assert.match(result.stderr, /origin\/HEAD is not set locally/);

	const gateShow = run(['gate', 'show', 'preflight', '--json'], workDir);
	const record = JSON.parse(gateShow.stdout);
	assert.equal(record.record.inputs.origin_tip_sha, null);
});
