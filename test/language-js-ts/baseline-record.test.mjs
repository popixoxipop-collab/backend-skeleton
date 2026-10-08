import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { SUITES, inspectSuite } from '../../scripts/run-next-nested-tests.mjs';
import * as lib from './baseline-record-lib.mjs';

// BASELINE.json is a record of base_commit. The checks form a ladder: the record is always verified against
// itself; it is replayed against the live tree only while that tree still equals the recorded blobs; the
// pinned-commit checks need the commit in the checkout (a shallow checkout skips them with a message).

const root = lib.REPO_ROOT;
const record = lib.readRecord(root);
const live = lib.liveTreeState(record, root);
const history = lib.historyState(root, record.base_commit);
const suite = SUITES.find((s) => s.id === record.suite_id);
const testPaths = record.tests.map((e) => e.path);
const sourcePaths = record.sources.map((e) => e.path);
const command = (id) => record.commands.find((c) => c.id === id);
const clone = () => structuredClone(record);

function requireUnchangedTree(t) {
  if (live.sourcesUnchanged && live.testsUnchanged) return true;
  const drift = [...live.sourcesChanged, ...live.testsChanged].join(', ');
  t.skip(`the live tree no longer equals the baseline (${drift}); the record is history, so the live replay is skipped and the pinned-commit checks apply`);
  return false;
}

function requireHistory(t) {
  if (history.kind === 'present') return true;
  if (history.kind === 'missing') assert.fail(history.note);
  t.skip(`${history.note}; the pinned-commit checks need a full clone`);
  return false;
}

function extractBase(t, extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  lib.extractCommit(root, record.base_commit, [...sourcePaths, ...testPaths, ...extra], dir);
  return dir;
}

test('baseline record is self-consistent: schema, digests, commands, fixtures and limits', () => {
  assert.deepEqual(lib.verifyRecord(record), []);
});

test('baseline record names the suite that the nested runner executes', () => {
  assert.ok(suite, `${lib.RUNNER_SCRIPT} has no suite ${record.suite_id}`);
  assert.ok(suite.sourcePaths.includes(record.source_dir));
  assert.equal(suite.testDir, record.test_dir);
  assert.equal(command('nested-runner').command, `node ${lib.RUNNER_SCRIPT} ${suite.id}`);
});

test('baseline record does not mark unsupported or unknown input as supported', () => {
  for (const f of record.fixtures) {
    const e = f.expected;
    if (e.threw) continue;
    for (const key of ['syntaxValidated', 'sourceSyntaxValidated']) {
      if (key in e) assert.equal(e[key], false, `${f.id}: ${key} must stay false`);
    }
    if (e.complete === false) {
      for (const key of ['edges', 'files', 'graph', 'resolutions']) {
        if (key in e) assert.deepEqual(e[key], [], `${f.id}: an incomplete result must not expose partial ${key}`);
      }
      assert.ok(e.diagnostics.length > 0, `${f.id}: an incomplete result needs a diagnostic`);
    }
    const statuses = e.resolutions ?? e.graph;
    if (statuses && 'allResolved' in e) {
      const expected = e.complete === true && statuses.every((s) => s.includes('=> resolved:'));
      assert.equal(e.allResolved, expected, `${f.id}: allResolved must mean a complete result with every entry resolved`);
    }
  }
  assert.ok(record.limits.every((l) => ['UNSUPPORTED', 'UNKNOWN', 'BLOCKED', 'NOT_RECORDED'].includes(l.status)));
});

test('live: the nested runner collects exactly the recorded test files plus this record test', (t) => {
  if (!requireUnchangedTree(t)) return;
  const inspected = inspectSuite(suite, root);
  assert.equal(inspected.status, 'READY');
  const collected = inspected.tests.map((p) => path.relative(root, p).split(path.sep).join('/'));
  assert.ok(collected.includes(lib.OWN_FILES[0]), 'the runner must collect this record test');
  const recordedOnly = collected.filter((p) => !lib.OWN_FILES.includes(p));
  assert.deepEqual(recordedOnly, testPaths);
  assert.equal(recordedOnly.length, command('nested-runner').runner_files);
});

test('live: fixture origins cite real lines of the recorded test files', (t) => {
  if (!requireUnchangedTree(t)) return;
  let cited = 0;
  for (const f of record.fixtures) {
    const m = /^(\S+\.mjs):(\d+) \((.+)\)$/.exec(f.origin);
    if (!m) continue;
    assert.ok(testPaths.includes(m[1]), `${f.id}: ${m[1]} is not a recorded test file`);
    const line = fs.readFileSync(path.join(root, m[1]), 'utf8').split('\n')[Number(m[2]) - 1] ?? '';
    assert.ok(line.replace('#', '').includes(m[3]), `${f.id}: line ${m[2]} of ${m[1]} is not the test "${m[3]}"`);
    cited += 1;
  }
  assert.ok(cited > 0, 'at least one fixture must cite a recorded test');
});

test('live: replaying every fixture reproduces the recorded output hashes and summaries', async (t) => {
  if (!requireUnchangedTree(t)) return;
  const modules = await lib.loadModules(path.join(root, record.source_dir));
  assert.deepEqual(lib.replayProblems(record, lib.replay(record, modules)), []);
});

test('live: the recorded test command reproduces its exit code and counts', (t) => {
  if (!requireUnchangedTree(t)) return;
  const recorded = command('direct-tap');
  assert.equal(recorded.command, lib.tapCommand(testPaths));
  const run = lib.runTapTests(root, testPaths);
  assert.equal(run.exit_code, recorded.exit_code);
  assert.deepEqual(run.result, recorded.result);
});

test('live: every recorded test file has its recorded test count', (t) => {
  if (!requireUnchangedTree(t)) return;
  for (const entry of record.tests) {
    const run = lib.runTapTests(root, [entry.path]);
    assert.equal(run.exit_code, 0, `${entry.path} failed`);
    assert.equal(run.result.tests, entry.test_count, `${entry.path}: test count`);
    assert.equal(run.result.fail, 0, `${entry.path}: failures`);
  }
});

test('live: the recorded byte count, sha256 and blob id of every source and test file are recomputed from the checkout', (t) => {
  if (!requireUnchangedTree(t)) return;
  assert.deepEqual(lib.verifyRecord(record, { read: lib.liveReader(root), label: 'live' }), []);
});

test('git: the recorded byte count, sha256 and blob id are recomputed from the base commit blobs, runner script included', (t) => {
  if (!requireHistory(t)) return;
  assert.deepEqual(lib.verifyRecord(record, { read: lib.commitReader(root, record.base_commit), includeRunner: true, label: 'git' }), []);
});

test('git: the base commit has the recorded tree and exactly the recorded source and test files', (t) => {
  if (!requireHistory(t)) return;
  assert.equal(lib.treeAtCommit(root, record.base_commit), record.base_tree);
  for (const e of [...record.sources, ...record.tests]) {
    assert.equal(lib.blobAtCommit(root, record.base_commit, e.path), e.git_blob_sha1, `${e.path} differs at ${record.base_commit}`);
  }
  const sourcesThere = lib.listAtCommit(root, record.base_commit, record.source_dir).filter((p) => !p.endsWith('.md'));
  assert.deepEqual(sourcesThere, [...sourcePaths].sort());
  assert.deepEqual(lib.listAtCommit(root, record.base_commit, record.test_dir), [...testPaths].sort());
  assert.equal(lib.blobAtCommit(root, record.base_commit, command('nested-runner').runner_script.path), command('nested-runner').runner_script.git_blob_sha1);
});

test('git: the base commit is an ancestor of the checked-out commit', (t) => {
  if (!requireHistory(t)) return;
  assert.ok(lib.isAncestor(root, record.base_commit), `${record.base_commit} is not an ancestor of HEAD`);
});

test('git: files extracted from the base commit reproduce every fixture hash', async (t) => {
  if (!requireHistory(t)) return;
  const dir = extractBase(t);
  const modules = await lib.loadModules(path.join(dir, record.source_dir));
  assert.deepEqual(lib.replayProblems(record, lib.replay(record, modules)), []);
});

test('git: both recorded commands reproduce their exit codes and counts on the base commit files', (t) => {
  if (!requireHistory(t)) return;
  const dir = extractBase(t, [lib.RUNNER_SCRIPT]);
  const direct = lib.runTapTests(dir, testPaths);
  assert.equal(direct.exit_code, command('direct-tap').exit_code);
  assert.deepEqual(direct.result, command('direct-tap').result);
  const runner = command('nested-runner');
  const nested = lib.runNestedRunner(dir, record.suite_id);
  assert.equal(nested.exit_code, runner.exit_code);
  assert.equal(nested.stdout_first_line, runner.stdout_first_line);
  assert.deepEqual(nested.result, runner.result);
});

test('negative: a tampered fixture output hash fails the record and the replay', () => {
  const bad = clone();
  const first = bad.fixtures[0];
  first.output_sha256 = `${first.output_sha256.startsWith('0') ? '1' : '0'}${first.output_sha256.slice(1)}`;
  assert.ok(lib.verifyRecord(bad).some((p) => p.includes('artifact_digest')));
  const agreeing = record.fixtures.map((f) => ({ id: f.id, deterministic: true, output_sha256: f.output_sha256, expected: f.expected }));
  assert.deepEqual(lib.replayProblems(record, agreeing), []);
  assert.ok(lib.replayProblems(bad, agreeing).some((p) => p.startsWith(`${first.id}: output sha256`)));
});

test('negative: a tampered expected summary fails the replay', () => {
  const bad = clone();
  const target = bad.fixtures.find((f) => f.expected.edges?.length);
  target.expected.edges = [...target.expected.edges, 'import ./invented L99 [0,1)'];
  const agreeing = record.fixtures.map((f) => ({ id: f.id, deterministic: true, output_sha256: f.output_sha256, expected: f.expected }));
  assert.ok(lib.replayProblems(bad, agreeing).some((p) => p.startsWith(`${target.id}: expected summary differs`)));
});

test('negative: a tampered fixture input fails the input hash and the pinned blob check', () => {
  const plain = clone();
  const normal = plain.fixtures.find((f) => f.class === 'normal' && typeof f.input.source === 'string');
  normal.input.source += ' ';
  assert.ok(lib.verifyRecord(plain).some((p) => p.startsWith(`${normal.id}: input_sha256`)));

  const pinned = clone();
  const withPin = pinned.fixtures.find((f) => f.origin_pin);
  assert.ok(withPin, 'the record must pin at least one external fixture file');
  withPin.input.source += '\n';
  withPin.input_sha256 = lib.sha256(lib.canonical(withPin.input));
  assert.ok(lib.verifyRecord(pinned).some((p) => p.startsWith(`${withPin.id}: input bytes are not the pinned blob`)));
});

test('negative: a source or test blob that differs from the record counts as drift', () => {
  const bad = clone();
  bad.sources[0].git_blob_sha1 = '0'.repeat(40);
  bad.tests[0].git_blob_sha1 = '1'.repeat(40);
  const state = lib.liveTreeState(bad, root);
  assert.equal(state.sourcesUnchanged, false);
  assert.equal(state.testsUnchanged, false);
  assert.ok(state.sourcesChanged.includes(bad.sources[0].path));
  assert.ok(state.testsChanged.includes(bad.tests[0].path));
});

test('negative: a same-length tampered sha256, a wrong byte count or a wrong blob id fails the recomputation', (t) => {
  const flip = (hex) => `${hex.startsWith('0') ? '1' : '0'}${hex.slice(1)}`;
  const runnerPath = command('nested-runner').runner_script.path;
  // Synthetic file contents keep this test independent of the live tree, so it also runs after a deliberate change.
  const files = new Map([...record.sources, ...record.tests, { path: runnerPath }].map((e, i) => [e.path, Buffer.from(`synthetic file ${i}\n`)]));
  const read = (rel) => files.get(rel) ?? null;
  const entryOf = (rel) => ({ bytes: files.get(rel).length, git_blob_sha1: lib.blobSha1(files.get(rel)), sha256: lib.sha256(files.get(rel)) });
  const consistent = clone();
  const consistentRunner = consistent.commands.find((c) => c.id === 'nested-runner').runner_script;
  for (const e of [...consistent.sources, ...consistent.tests, consistentRunner]) Object.assign(e, entryOf(e.path));
  const problemsOf = (r, includeRunner = false) => lib.verifyRecord(r, { read, includeRunner, label: 'synthetic' }).filter((p) => p.startsWith('synthetic:'));
  assert.deepEqual(problemsOf(consistent, true), []);

  const sha = structuredClone(consistent);
  sha.sources[0].sha256 = flip(sha.sources[0].sha256);
  assert.ok(problemsOf(sha).some((p) => p.includes(`${sha.sources[0].path} sha256`)), 'a tampered source sha256 of the same length must fail');

  const size = structuredClone(consistent);
  size.tests[0].bytes += 1;
  assert.ok(problemsOf(size).some((p) => p.includes(`${size.tests[0].path} bytes`)), 'a wrong test byte count must fail');

  const blob = structuredClone(consistent);
  blob.tests[0].git_blob_sha1 = flip(blob.tests[0].git_blob_sha1);
  assert.ok(problemsOf(blob).some((p) => p.includes(`${blob.tests[0].path} git_blob_sha1`)), 'a wrong blob id must fail');

  const runner = structuredClone(consistent);
  const script = runner.commands.find((c) => c.id === 'nested-runner').runner_script;
  script.sha256 = flip(script.sha256);
  assert.deepEqual(problemsOf(runner, false), [], 'the runner script is only recomputed when includeRunner is set');
  assert.ok(problemsOf(runner, true).some((p) => p.includes(`${runnerPath} sha256`)), 'a tampered runner script sha256 must fail');

  const missing = structuredClone(consistent);
  missing.sources[0].path = `${record.source_dir}/not-recorded.mjs`;
  assert.ok(problemsOf(missing).some((p) => p.includes('cannot read')));

  if (live.sourcesUnchanged && live.testsUnchanged) {
    const real = clone();
    real.sources[0].sha256 = flip(real.sources[0].sha256);
    real.tests[0].bytes += 1;
    const found = lib.verifyRecord(real, { read: lib.liveReader(root), label: 'live' });
    assert.ok(found.some((p) => p.includes(`${real.sources[0].path} sha256`)));
    assert.ok(found.some((p) => p.includes(`${real.tests[0].path} bytes`)));
  } else {
    t.diagnostic('the live tree differs from the record, so only the synthetic half of this negative test ran');
  }
});

test('negative: inconsistent counts, exit codes and commands are rejected', () => {
  const counts = clone();
  counts.tests[0].test_count += 1;
  assert.ok(lib.verifyRecord(counts).some((p) => p.includes('sum of per-file test_count')));

  const exit = clone();
  exit.commands[0].result.fail = 1;
  assert.ok(lib.verifyRecord(exit).some((p) => p.includes('exit_code 0 contradicts failing tests')));

  const files = clone();
  files.commands.find((c) => c.id === 'direct-tap').command = lib.tapCommand(testPaths.slice(1));
  assert.ok(lib.verifyRecord(files).some((p) => p.includes('does not list exactly the recorded test files')));

  const revision = clone();
  revision.commands[1].revision = '2'.repeat(40);
  assert.ok(lib.verifyRecord(revision).some((p) => p.includes('revision is not the base commit')));

  const runnerFiles = clone();
  runnerFiles.commands[0].runner_files += 1;
  assert.ok(lib.verifyRecord(runnerFiles).some((p) => p.includes('runner_files')));
});

test('negative: a malformed commit, a missing negative fixture and a supported-looking limit are rejected', () => {
  const commit = clone();
  commit.base_commit = 'abc';
  assert.ok(lib.verifyRecord(commit).some((p) => p.includes('base_commit must be a 40-hex commit id')));

  const noNegative = clone();
  noNegative.fixtures = noNegative.fixtures.filter((f) => f.class !== 'negative');
  assert.ok(lib.verifyRecord(noNegative).some((p) => p.includes('at least one negative fixture')));

  const supported = clone();
  supported.limits[0].status = 'SUPPORTED';
  assert.ok(lib.verifyRecord(supported).some((p) => p.includes('is not one of UNSUPPORTED/UNKNOWN/BLOCKED/NOT_RECORDED')));

  const noLimits = clone();
  noLimits.limits = [];
  assert.ok(lib.verifyRecord(noLimits).some((p) => p.includes('limits must record')));
});

test('negative: a commit that is not in the history is never reported as present', (t) => {
  assert.notEqual(lib.historyState(root, '0'.repeat(40)).kind, 'present');
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git is not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-record-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
  assert.equal(lib.historyState(dir, record.base_commit).kind, 'missing');
});
