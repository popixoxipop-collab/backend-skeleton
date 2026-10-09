import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { SUITES, inspectSuite } from '../../scripts/run-next-nested-tests.mjs';
import * as lib from './baseline-record-lib.mjs';

// BASELINE.json is a record of base_commit. The record is always verified against itself. Each pinned file is then
// compared with the live file by size, sha256 and blob id: all agree (fresh), exactly one hash or only the size
// disagrees (corrupt: the test fails), or neither hash agrees (the tree moved on: live replays are skipped). The
// pinned commit decides every case, so it is mandatory: a checkout that lacks it fetches it once, and the git: tests
// fail with "pinned commit unavailable" when that is impossible unless BASELINE_ALLOW_UNVERIFIED=1 skips them aloud.
// External pins (the Legacy A fixture files) are resolved the same way: each is fetched from the repository it names and
// its blob id compared, with the credentials of the checkout (a private-repository run keeps its token only there).
// The Legacy A commits that carry no blob are declared-not-verified in the limits, not resolved.

const root = lib.REPO_ROOT;
const record = lib.readRecord(root);
const tree = lib.classifyLive(record, root);
const suite = SUITES.find((s) => s.id === record.suite_id);
const testPaths = record.tests.map((e) => e.path);
const sourcePaths = record.sources.map((e) => e.path);
const command = (id) => record.commands.find((c) => c.id === id);
const clone = () => structuredClone(record);
const flip = (hex) => `${hex.startsWith('0') ? '1' : '0'}${hex.slice(1)}`;
const tmpDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function requireFresh(t) {
  if (tree.corrupt.length > 0) assert.fail(`the record disagrees with the live files: ${tree.corrupt.join('; ')}`);
  if (tree.fresh) return true;
  t.skip(`the live tree no longer equals the baseline (${tree.moved.join(', ')}); the live replay is skipped and the pinned commit decides`);
  return false;
}

let cachedVerdict;
function needCommit(t, verdict = (cachedVerdict ??= lib.commitVerdict(root, record.base_commit))) {
  if (verdict.verdict === 'fail') assert.fail(verdict.message);
  if (verdict.verdict === 'unverified') {
    t.skip(verdict.message);
    return false;
  }
  return true;
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
  if (!requireFresh(t)) return;
  const inspected = inspectSuite(suite, root);
  assert.equal(inspected.status, 'READY');
  const collected = inspected.tests.map((p) => path.relative(root, p).split(path.sep).join('/'));
  assert.ok(collected.includes(lib.OWN_FILES[0]), 'the runner must collect this record test');
  const recordedOnly = collected.filter((p) => !lib.OWN_FILES.includes(p));
  assert.deepEqual(recordedOnly, testPaths);
  assert.equal(recordedOnly.length, command('nested-runner').runner_files);
});

test('live: fixture origins cite real lines of the recorded test files', (t) => {
  if (!requireFresh(t)) return;
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
  if (!requireFresh(t)) return;
  const modules = await lib.loadModules(path.join(root, record.source_dir));
  assert.deepEqual(lib.replayProblems(record, lib.replay(record, modules)), []);
});

test('live: the recorded test command reproduces its exit code and counts', (t) => {
  if (!requireFresh(t)) return;
  const recorded = command('direct-tap');
  assert.equal(recorded.command, lib.tapCommand(testPaths));
  const run = lib.runTapTests(root, testPaths);
  assert.equal(run.exit_code, recorded.exit_code);
  assert.deepEqual(run.result, recorded.result);
});

test('live: every recorded test file has its recorded test count', (t) => {
  if (!requireFresh(t)) return;
  for (const entry of record.tests) {
    const run = lib.runTapTests(root, [entry.path]);
    assert.equal(run.exit_code, 0, `${entry.path} failed`);
    assert.equal(run.result.tests, entry.test_count, `${entry.path}: test count`);
    assert.equal(run.result.fail, 0, `${entry.path}: failures`);
  }
});

test('live: the recorded byte count, sha256 and blob id of every pinned file agree with the checkout or the file has moved on entirely', (t) => {
  assert.deepEqual(tree.corrupt, []);
  if (tree.fresh) assert.deepEqual(lib.recomputeProblems([...record.sources, ...record.tests], lib.liveReader(root), 'live'), []);
  else t.diagnostic(`moved since the baseline: ${tree.moved.join(', ')}; the pinned commit decides`);
});

test('git: the recorded byte count, sha256 and blob id are recomputed from the base commit blobs, runner script included', (t) => {
  if (!needCommit(t)) return;
  assert.deepEqual(lib.verifyRecord(record, { read: lib.commitReader(root, record.base_commit), includeRunner: true, label: 'git' }), []);
});

test('git: the base commit has the recorded tree and exactly the recorded source and test files', (t) => {
  if (!needCommit(t)) return;
  assert.equal(lib.treeAtCommit(root, record.base_commit), record.base_tree);
  for (const e of [...record.sources, ...record.tests]) {
    assert.equal(lib.blobAtCommit(root, record.base_commit, e.path), e.git_blob_sha1, `${e.path} differs at ${record.base_commit}`);
  }
  const sourcesThere = lib.listAtCommit(root, record.base_commit, record.source_dir).filter((p) => !p.endsWith('.md'));
  assert.deepEqual(sourcesThere, [...sourcePaths].sort());
  assert.deepEqual(lib.listAtCommit(root, record.base_commit, record.test_dir), [...testPaths].sort());
  assert.equal(lib.blobAtCommit(root, record.base_commit, command('nested-runner').runner_script.path), command('nested-runner').runner_script.git_blob_sha1);
});

test('git: the base commit is an ancestor of the checked-out commit (a shallow checkout is deepened first)', (t) => {
  if (!needCommit(t)) return;
  const verdict = lib.ancestryVerdict(root, record.base_commit);
  if (!needCommit(t, verdict)) return;
  assert.equal(verdict.verdict, 'ok');
});

test('git: every external pin resolves to its recorded blob in the repository it names', (t) => {
  const verdict = lib.externalPinVerdict(record);
  if (!needCommit(t, verdict)) return;
  assert.equal(verdict.resolved, lib.externalBlobPins(record).length);
  assert.ok(verdict.resolved >= 2, 'at least the two Legacy A fixture files are pinned');
});

test('pinned commits that no blob pin resolves are labelled declared-not-verified in the limits', () => {
  const limit = record.limits.find((l) => l.id === lib.DECLARED_LIMIT);
  assert.ok(limit, `limit ${lib.DECLARED_LIMIT} is missing`);
  assert.equal(limit.status, 'NOT_RECORDED');
  assert.match(limit.statement, /NOT resolved/);
  assert.deepEqual(limit.commits, lib.declaredUnverifiedCommits(record));
  assert.ok(limit.commits.includes(record.pins.legacy_a.head_commit) && limit.commits.includes(record.pins.legacy_a.base_commit));
  const resolved = lib.externalBlobPins(record).map((p) => p.commit);
  assert.ok(limit.commits.every((c) => !resolved.includes(c)), 'a commit is resolved by a blob pin or declared, never both');
});

test('git: files extracted from the base commit reproduce every fixture hash', async (t) => {
  if (!needCommit(t)) return;
  const dir = extractBase(t);
  const modules = await lib.loadModules(path.join(dir, record.source_dir));
  assert.deepEqual(lib.replayProblems(record, lib.replay(record, modules)), []);
});

test('git: both recorded commands reproduce their exit codes and counts on the base commit files', (t) => {
  if (!needCommit(t)) return;
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

test('negative: in a depth-1 clone the unmodified record passes once the pinned commit is fetched', (t) => {
  const c = lib.depthOneCase(tmpDir(t, 'baseline-record-d1-'));
  const commit = c.record.base_commit;
  assert.ok(lib.isShallow(c.checkout));
  assert.notEqual(spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: c.checkout }).status, 0, 'the clone must lack the pinned commit');
  const verdict = lib.commitVerdict(c.checkout, commit, {});
  assert.deepEqual([verdict.verdict, verdict.via], ['ok', 'fetch']);
  const found = lib.classifyLive(c.record, c.checkout);
  assert.deepEqual([found.corrupt, found.moved], [[], ['src/a.mjs']]);
  assert.deepEqual(lib.recomputeProblems([...c.record.sources, ...c.record.tests], lib.commitReader(c.checkout, commit), 'git'), []);
});

test('negative: a zeroed blob id alone, a changed sha256 alone or a changed byte count alone fails in a depth-1 clone', (t) => {
  const c = lib.depthOneCase(tmpDir(t, 'baseline-record-d1-'));
  assert.equal(lib.commitVerdict(c.checkout, c.record.base_commit, {}).verdict, 'ok');
  const read = lib.commitReader(c.checkout, c.record.base_commit);
  const damage = {
    'blob id alone': (e) => { e.git_blob_sha1 = '0'.repeat(40); },
    'sha256 alone': (e) => { e.sha256 = flip(e.sha256); },
    'byte count alone': (e) => { e.bytes += 1; }
  };
  for (const [name, change] of Object.entries(damage)) {
    const onFresh = structuredClone(c.record);
    change(onFresh.sources[1]);
    assert.equal(lib.classifyLive(onFresh, c.checkout).corrupt.length, 1, `${name}: a file that is fresh in the checkout makes the record corrupt`);
    const onMoved = structuredClone(c.record);
    change(onMoved.sources[0]);
    assert.deepEqual(lib.classifyLive(onMoved, c.checkout).corrupt, [], `${name}: a moved file is left to the pinned commit`);
    assert.equal(lib.recomputeProblems(onMoved.sources, read, 'git').length, 1, `${name}: the pinned commit rejects the damaged entry`);
  }
  fs.writeFileSync(path.join(c.checkout, 'src/b.mjs'), 'export const b = 3;\n');
  const sameSize = lib.classifyLive(c.record, c.checkout);
  assert.deepEqual([sameSize.corrupt, sameSize.moved], [[], ['src/a.mjs', 'src/b.mjs']], 'a same-size edit changes both hashes, so it is drift');
});

test('negative: a pinned commit that cannot be fetched fails unless BASELINE_ALLOW_UNVERIFIED=1 is set', (t) => {
  const plain = tmpDir(t, 'baseline-record-nogit-');
  const noOrigin = tmpDir(t, 'baseline-record-norigin-');
  assert.equal(spawnSync('git', ['init', '-q', noOrigin]).status, 0);
  for (const dir of [plain, noOrigin]) {
    const verdict = lib.commitVerdict(dir, record.base_commit, {});
    assert.equal(verdict.verdict, 'fail');
    assert.match(verdict.message, /pinned commit unavailable/);
    assert.throws(() => needCommit({ skip: () => assert.fail('an unavailable commit must not skip') }, verdict), /pinned commit unavailable/);
    assert.equal(lib.commitVerdict(dir, record.base_commit, { BASELINE_ALLOW_UNVERIFIED: 'true' }).verdict, 'fail', 'only the value 1 opts out');
    const optOut = lib.commitVerdict(dir, record.base_commit, { BASELINE_ALLOW_UNVERIFIED: '1' });
    assert.equal(optOut.verdict, 'unverified');
    let skipped = '';
    assert.equal(needCommit({ skip: (message) => { skipped = message; } }, optOut), false);
    assert.match(skipped, /NOT run/);
  }
});

test('negative: a pinned commit that exists but is not an ancestor of HEAD fails, and a deepening that fails fails unless BASELINE_ALLOW_UNVERIFIED=1 is set', (t) => {
  const side = lib.depthOneCase(tmpDir(t, 'baseline-record-anc-'));
  assert.ok(lib.isShallow(side.checkout));
  assert.equal(lib.commitVerdict(side.checkout, side.sideCommit, {}).verdict, 'ok', 'the side commit exists and can be fetched');
  const unrelated = lib.ancestryVerdict(side.checkout, side.sideCommit, {});
  assert.equal(unrelated.verdict, 'fail');
  assert.match(unrelated.message, /is not an ancestor of HEAD/);
  assert.throws(() => needCommit({ skip: () => assert.fail('a non-ancestor must not skip') }, unrelated), /is not an ancestor of HEAD/);

  const real = lib.depthOneCase(tmpDir(t, 'baseline-record-anc-'));
  assert.equal(lib.commitVerdict(real.checkout, real.record.base_commit, {}).verdict, 'ok');
  assert.deepEqual(lib.ancestryVerdict(real.checkout, real.record.base_commit, {}), { verdict: 'ok' });
  assert.equal(lib.isShallow(real.checkout), false, 'the shallow checkout was deepened');

  const offline = lib.depthOneCase(tmpDir(t, 'baseline-record-anc-'));
  assert.equal(spawnSync('git', ['remote', 'set-url', 'origin', path.join(offline.checkout, 'no-such-upstream')], { cwd: offline.checkout }).status, 0);
  const commit = offline.record.base_commit;
  const failed = lib.ancestryVerdict(offline.checkout, commit, {});
  assert.equal(failed.verdict, 'fail');
  assert.match(failed.message, /ancestry unavailable/);
  assert.equal(lib.ancestryVerdict(offline.checkout, commit, { BASELINE_ALLOW_UNVERIFIED: 'true' }).verdict, 'fail', 'only the value 1 opts out');
  const optOut = lib.ancestryVerdict(offline.checkout, commit, { BASELINE_ALLOW_UNVERIFIED: '1' });
  assert.equal(optOut.verdict, 'unverified');
  assert.match(optOut.message, /NOT run/);
});

test('negative: a pin that is not the cited commit, or a declared commit missing from the limits, fails the record', () => {
  const pinOf = (r) => r.fixtures.find((f) => f.origin_pin);
  const changes = {
    'a zeroed commit': (pin) => { pin.commit = '0'.repeat(40); },
    'another path': (pin) => { pin.path += '.orig'; },
    'another repository': (pin) => { pin.repository = 'someone/else'; }
  };
  for (const [name, change] of Object.entries(changes)) {
    const bad = clone();
    change(pinOf(bad).origin_pin);
    assert.ok(lib.verifyRecord(bad).some((p) => p.startsWith(`${pinOf(bad).id}: origin_pin is not one of the cited commits`)), name);
  }
  const unlisted = clone();
  unlisted.pins.legacy_a.cited_commits.push({ role: 'added without a blob', commit: '3'.repeat(40) });
  const dropped = clone();
  dropped.limits = dropped.limits.filter((l) => l.id !== lib.DECLARED_LIMIT);
  for (const bad of [unlisted, dropped]) assert.ok(lib.verifyRecord(bad).some((p) => p.includes(`limit ${lib.DECLARED_LIMIT} must list exactly`)));
});

test('negative: an external pin must have its blob in the named repository; a wrong path or blob fails, an unfetchable pin fails unless BASELINE_ALLOW_UNVERIFIED=1', (t) => {
  const dir = tmpDir(t, 'baseline-record-pin-');
  const up = lib.pinUpstream(dir);
  const verdict = (patch, env = {}, url = up.url) => lib.externalPinVerdict({ fixtures: [{ id: 'X', origin_pin: { ...up.pin, ...patch } }] }, { env, urlFor: () => url });
  assert.deepEqual(verdict({}), { verdict: 'ok', resolved: 1 });

  for (const [name, patch] of Object.entries({ 'a wrong path': { path: 'docs/b.txt' }, 'a wrong blob id': { git_blob_sha1: flip(up.pin.git_blob_sha1) } })) {
    for (const env of [{}, { BASELINE_ALLOW_UNVERIFIED: '1' }]) {
      const found = verdict(patch, env);
      assert.equal(found.verdict, 'fail', `${name}: a fetched commit without the recorded blob always fails`);
      assert.match(found.message, /^X: owner\/repo /);
    }
  }
  const cannotFetch = {
    'a zeroed commit': (env) => verdict({ commit: '0'.repeat(40) }, env),
    'an unreachable repository': (env) => verdict({}, env, `file://${path.join(dir, 'no-such-upstream')}`)
  };
  for (const [name, check] of Object.entries(cannotFetch)) {
    const failed = check({});
    assert.equal(failed.verdict, 'fail', name);
    assert.match(failed.message, /external pin unavailable/);
    assert.throws(() => needCommit({ skip: () => assert.fail(`${name} must not skip`) }, failed), /external pin unavailable/);
    assert.equal(check({ BASELINE_ALLOW_UNVERIFIED: 'true' }).verdict, 'fail', `${name}: only the value 1 opts out`);
    const optOut = check({ BASELINE_ALLOW_UNVERIFIED: '1' });
    assert.equal(optOut.verdict, 'unverified', name);
    assert.match(optOut.message, /NOT resolved/);
  }
  const malformed = verdict({ repository: '--upload-pack=x' }, { BASELINE_ALLOW_UNVERIFIED: '1' });
  assert.equal(malformed.verdict, 'fail');
  assert.match(malformed.message, /malformed external pin/);
});

const gitRepo = (dir, name, ...config) => {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo });
  for (const [key, value] of config) assert.equal(spawnSync('git', ['config', '--local', '--add', key, value], { cwd: repo }).status, 0, key);
  return repo;
};

test('credentials: the pin fetch takes the checkout http extraheader, else a token for the server origin only, else none', (t) => {
  const dir = tmpDir(t, 'baseline-record-auth-');
  const url = 'https://github.com/owner/repo.git';
  const scoped = ['http.https://github.com/.extraheader', 'AUTHORIZATION: basic Y2hlY2tvdXQ='];
  const withHeader = gitRepo(dir, 'with-header', scoped);
  assert.deepEqual(lib.fetchCredentials(withHeader, url, {}), { source: 'checkout', config: [scoped] });
  assert.equal(lib.fetchCredentials(withHeader, url, { GITHUB_TOKEN: 'tok' }).source, 'checkout', 'the checkout header wins, so a request never carries two Authorization headers');

  fs.writeFileSync(path.join(dir, 'persisted.config'), '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic aW5jbHVkZWQ=\n');
  const included = gitRepo(dir, 'included', ['include.path', path.join(dir, 'persisted.config')]);
  assert.deepEqual(lib.fetchCredentials(included, url, {}).config, [['http.https://github.com/.extraheader', 'AUTHORIZATION: basic aW5jbHVkZWQ=']], 'a header persisted in an included file is found');

  const bare = gitRepo(dir, 'bare');
  const basic = `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}`;
  assert.deepEqual(lib.fetchCredentials(bare, url, { GITHUB_TOKEN: 'tok' }), { source: 'token', config: [['http.https://github.com/.extraheader', basic]] });
  assert.equal(lib.fetchCredentials(bare, url, { GH_TOKEN: 'tok' }).source, 'token');
  assert.equal(lib.fetchCredentials(bare, 'https://elsewhere.invalid/owner/repo.git', { GITHUB_TOKEN: 'tok' }).source, 'none', 'a token is never sent to another host');
  assert.equal(lib.fetchCredentials(bare, 'file:///tmp/upstream', { GITHUB_TOKEN: 'tok' }).source, 'none');
  assert.equal(lib.fetchCredentials(bare, url, { GITHUB_TOKEN: 'tok', GITHUB_SERVER_URL: 'https://ghe.invalid' }).source, 'none', 'the token belongs to GITHUB_SERVER_URL');
  assert.equal(lib.fetchCredentials(bare, url, {}).source, 'none', 'a public repository is fetched unauthenticated');
  assert.equal(lib.fetchCredentials(gitRepo(dir, 'unscoped', ['http.extraheader', 'AUTHORIZATION: basic eA==']), url, {}).source, 'none', 'an unscoped header would reach every host');
  assert.equal(lib.fetchCredentials(path.join(dir, 'not-a-repository'), url, {}).source, 'none');
});

// spawnSync blocks this process, so the server that records the Authorization header of every request lives in a child.
const RECORDING_SERVER = "const http = require('node:http'), fs = require('node:fs'); http.createServer((q, s) => { fs.appendFileSync(process.argv[1], JSON.stringify(q.headers.authorization ?? null) + '\\n'); s.writeHead(404); s.end(); }).listen(0, '127.0.0.1', function () { console.log(this.address().port); });";

test('credentials on the wire: the pin fetch sends the credentials only to the server they are scoped to and never prints them', async (t) => {
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const was = process.env[key];
    process.env[key] = '127.0.0.1';
    t.after(() => (was === undefined ? delete process.env[key] : (process.env[key] = was)));
  }
  const dir = tmpDir(t, 'baseline-record-wire-');
  const log = path.join(dir, 'authorization.log');
  const server = spawn(process.execPath, ['-e', RECORDING_SERVER, log], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => server.kill());
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
  });
  const origin = `http://127.0.0.1:${port}`;
  const pin = { repository: 'owner/repo', commit: 'a'.repeat(40), path: 'docs/a.txt', git_blob_sha1: 'b'.repeat(40) };
  let n = 0;
  const attempt = (config, env) => {
    fs.rmSync(log, { force: true });
    const repo = gitRepo(dir, `checkout-${n++}`, ...config);
    const verdict = lib.externalPinVerdict({ fixtures: [{ id: 'X', origin_pin: pin }] }, { root: repo, env, urlFor: () => `${origin}/owner/repo.git` });
    const headers = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
    assert.ok(headers.length > 0, 'the server was reached');
    assert.equal(verdict.verdict, 'fail', 'the server has no repository, so the fetch fails and is reported');
    assert.match(verdict.message, /external pin unavailable/);
    return { headers, message: verdict.message };
  };
  const everyRequest = (found, expected) => assert.deepEqual([...new Set(found.headers)], [expected]);

  const fromCheckout = attempt([[`http.${origin}/.extraheader`, 'AUTHORIZATION: basic c2VjcmV0']], {});
  everyRequest(fromCheckout, 'basic c2VjcmV0');
  assert.ok(!fromCheckout.message.includes('c2VjcmV0'), 'the credential is never printed');

  const encoded = Buffer.from('x-access-token:ghs_TESTTOKEN0123').toString('base64');
  const fromToken = attempt([], { GITHUB_TOKEN: 'ghs_TESTTOKEN0123', GITHUB_SERVER_URL: origin });
  everyRequest(fromToken, `basic ${encoded}`);
  assert.ok(!fromToken.message.includes('ghs_TESTTOKEN0123') && !fromToken.message.includes(encoded), 'the token is never printed');

  everyRequest(attempt([['http.https://github.com/.extraheader', 'AUTHORIZATION: basic b3RoZXI=']], {}), null);
  everyRequest(attempt([], { GITHUB_TOKEN: 'ghs_TESTTOKEN0123' }), null);
  everyRequest(attempt([], {}), null);
});

test('negative: a same-length tampered sha256, a wrong byte count or a wrong blob id fails the recomputation', (t) => {
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

  if (tree.fresh) {
    const real = clone();
    real.sources[0].sha256 = flip(real.sources[0].sha256);
    real.tests[0].bytes += 1;
    const found = lib.recomputeProblems([...real.sources, ...real.tests], lib.liveReader(root), 'live');
    assert.ok(found.some((p) => p.includes(`${real.sources[0].path} sha256`)));
    assert.ok(found.some((p) => p.includes(`${real.tests[0].path} bytes`)));
    const zeroed = clone();
    zeroed.sources[0].git_blob_sha1 = '0'.repeat(40);
    assert.equal(lib.classifyLive(zeroed, root).corrupt.length, 1, 'a zeroed blob id on a fresh checkout is corruption, not drift');
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
