import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectSuite, SUITES } from '../../scripts/run-next-nested-tests.mjs';
import * as lib from './baseline-record-lib.mjs';

// T11-01: BASELINE.json pins what the five legacy HTTP adapters and the T11 modules did at one exact commit. Everything it
// records is recomputed here from real files, real scans and real commands; a well-formed value is never evidence.
const { REPO_ROOT } = lib;
const record = lib.readRecord();
const live = lib.classifyLive(record);
const copy = (edit) => { const r = structuredClone(record); edit(r); return r; };
const reseal = (edit) => { const r = copy(edit); r.artifact_digest.value = lib.artifactDigest(r); return r; };
const STATUSES = { 'no-next-contract-emission': 'UNSUPPORTED', 'shadow-projectors-are-test-doubles': 'UNSUPPORTED', 'cutover-gates-are-hand-written': 'UNKNOWN', 'sparse-checkout-two-adapters-only': 'UNSUPPORTED', 'scanner-pins-are-the-static-closure': 'NOT_RECORDED', 'single-runtime-observed': 'NOT_RECORDED', 'ci-observation-not-recomputable': 'NOT_RECORDED', 'real-repository-corpus': 'UNKNOWN', 'identity-and-capability-interfaces-not-frozen': 'BLOCKED' };
const { flip } = lib;
const inScratch = async (name, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bskel-${name}-`));
  try { await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

// The pinned commit is always required, also while the live tree equals the record: matching file hashes say nothing about
// base_commit, base_tree, ancestry or the archived commands. It is fetched when absent (--depth=1 in a shallow checkout), its
// absence fails, and only BASELINE_ALLOW_UNVERIFIED=1 turns that into a diagnostic.
function pinnedAvailable(t) {
  const v = lib.commitVerdict(REPO_ROOT, record.base_commit);
  if (v.verdict === 'fail') assert.fail(v.message);
  if (v.verdict === 'unverified') t.diagnostic(v.message);
  return v.verdict === 'ok';
}

test('T11-01 the record is consistent, claims nothing as supported, and every pin is recomputed', (t) => {
  assert.deepEqual(lib.verifyRecord(record), []);
  assert.doesNotMatch(JSON.stringify(record), /"(?:SUPPORTED|supported|certified|runtime-tested)"/);
  assert.deepEqual(Object.fromEntries(record.limits.map((l) => [l.id, l.status])), STATUSES, 'each limit keeps the status this test fixes');
  assert.deepEqual(live.corrupt, [], 'a record that disagrees with a file in only one hash is damaged, not moved');
  t.diagnostic(live.fresh ? 'live tree equals the recorded revision' : `live tree moved: ${live.moved.join(', ')}`);
  if (live.fresh) assert.deepEqual(lib.verifyRecord(record, lib.liveReader(REPO_ROOT), 'live'), []);
  else if (pinnedAvailable(t)) assert.deepEqual(lib.verifyRecord(record, lib.commitReader(REPO_ROOT, record.base_commit), 'pinned commit'), []);
});

test('T11-01 the nested runner still collects every recorded test file and this record test', () => {
  const found = inspectSuite(SUITES.find((s) => s.id === record.suite_id), REPO_ROOT);
  assert.equal(found.status, 'READY');
  const collected = found.tests.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'));
  for (const wanted of [...record.tests.map((x) => x.path), 'test/http-legacy-next/baseline-record.test.mjs']) assert.ok(collected.includes(wanted), wanted);
});

test('T11-01 replaying the fixtures on the live tree reproduces every recorded output hash', async (t) => {
  if (!live.fresh) return t.diagnostic('live tree moved: the replay on the pinned commit below decides');
  assert.deepEqual(lib.replayProblems(record, lib.replay(record, await lib.loadModules(REPO_ROOT))), []);
});

test('T11-01 the pinned commit has the recorded tree and files, and an export of it reproduces replay, counts and exit codes', async (t) => {
  if (!pinnedAvailable(t)) return;
  const { base_commit: commit } = record;
  assert.equal(lib.revParse(REPO_ROOT, `${commit}^{tree}`), record.base_tree);
  const listed = (dir, keep) => lib.listAtCommit(REPO_ROOT, commit, dir).filter(keep);
  assert.deepEqual(listed(record.source_dir, (p) => p.endsWith('.mjs')), record.sources.map((x) => x.path).sort());
  assert.deepEqual(listed(record.test_dir, (p) => p.endsWith('.test.mjs')), record.tests.map((x) => x.path).sort());
  assert.deepEqual(listed(record.scanner_dir, (p) => p.endsWith('.mjs')), record.scanner_files.map((x) => x.path).filter((p) => p.startsWith(`${record.scanner_dir}/`)).sort());
  for (const g of record.inputs) {
    assert.equal(lib.revParse(REPO_ROOT, `${commit}:${g.dir}`), g.git_tree_id, g.id);
    assert.deepEqual(listed(g.dir, () => true), g.files.map((x) => x.path).sort(), g.id);
  }
  if (lib.isShallow(REPO_ROOT)) t.diagnostic('shallow checkout: ancestry of the pinned commit is not claimed');
  else assert.ok(lib.isAncestor(REPO_ROOT, commit), 'the pinned commit must be an ancestor of HEAD');

  await inScratch('export', async (dest) => {
    lib.extractTree(REPO_ROOT, commit, dest);
    const files = record.tests.map((x) => x.path);
    const [nested, tap, ...perFile] = await Promise.all([lib.runNestedRunner(dest, record.suite_id), lib.runTapTests(dest, files), ...files.map((f) => lib.runTapTests(dest, [f]))]);
    const command = (id) => record.commands.find((c) => c.id === id);
    for (const [again, c] of [[nested, command('nested-runner')], [tap, command('direct-tap')]]) {
      assert.equal(again.exit_code, c.exit_code, c.id);
      assert.deepEqual(again.result, c.result, c.id);
    }
    assert.equal(nested.stdout_first_line, command('nested-runner').stdout_first_line);
    perFile.forEach((run, i) => assert.equal(run.result.tests, record.tests[i].test_count, files[i]));
    assert.deepEqual(lib.replayProblems(record, lib.replay(record, await lib.loadModules(dest))), []);
  });
});

test('T11-01 negative: edits fail verification re-sealed (recomputed checks) and not re-sealed (the whole-record seal)', () => {
  const checked = [
    ['recorded input', (r) => { r.fixtures[0].input.adapter = 'ruby-rails'; }, /input_sha256/],
    ['failures under exit code 0', (r) => { r.commands[0].result.fail = 1; }, /exit_code 0 contradicts/],
    ['per-file test count', (r) => { r.tests[0].test_count += 1; }, /direct-tap tests/],
    ['runner file count', (r) => { r.commands[0].runner_files = 5; }, /runner_files/],
    ['third command that nothing replays', (r) => { r.commands.push({ ...r.commands[1], id: 'extra' }); }, /exactly nested-runner and direct-tap/],
    ['repeated command id', (r) => { r.commands.push(structuredClone(r.commands[1])); }, /exactly nested-runner and direct-tap/],
    ['base commit', (r) => { r.base_commit = 'abc123'; }, /40-hex commit/],
    ['missing negative fixture', (r) => { r.fixtures = r.fixtures.filter((f) => f.class !== 'negative'); }, /at least one negative/],
    ['negative without a counterexample', (r) => { delete r.fixtures.find((f) => f.class === 'negative').counterexample; }, /counterexample/],
    ['limit that reads as supported', (r) => { r.limits[0].status = 'SUPPORTED'; }, /status SUPPORTED/],
    ['unpinned scanner registry', (r) => { r.scanner_files = r.scanner_files.filter((e) => !e.path.endsWith('registry.mjs')); }, /must pin scanners\/registry/]
  ];
  const paths = [['title'], ['base_commit_note'], ['environment', 'node'], ['artifact_digest', 'covers'], ['ci_observations', 0, 'conclusion'], ['verification', 'not_recomputed', 0],
    ['fixtures', 3, 'output_sha256'], ['fixtures', 0, 'class'], ['fixtures', 0, 'origin'], ['limits', 0, 'statement'], ['limits', 0, 'fixtures', 0]];
  const prose = [
    ...paths.map((at) => [at.join('.'), (r) => { at.slice(0, -1).reduce((x, k) => x[k], r)[at.at(-1)] += ' (edited)'; }]),
    ...record.limits.flatMap((l, i) => ['UNSUPPORTED', 'UNKNOWN', 'BLOCKED', 'NOT_RECORDED'].filter((s) => s !== l.status).map((s) => [`${l.id} -> ${s}`, (r) => { r.limits[i].status = s; }]))
  ];
  assert.deepEqual(lib.verifyRecord(reseal(() => {})), [], 're-sealing an untouched record changes nothing');
  for (const [name, edit, pattern] of checked) assert.match(lib.verifyRecord(reseal(edit)).join('\n'), pattern, `${name}, re-sealed`);
  for (const [name, edit] of [...checked, ...prose]) assert.match(lib.verifyRecord(copy(edit)).join('\n'), /artifact_digest does not match the record/, `${name}, not re-sealed`);
});

test('T11-01 negative: a change to a report field the semantic snapshot omits still changes the recorded scan output hash', async () => {
  const modules = await lib.loadModules(REPO_ROOT);
  const [digest, base] = [(out) => lib.sha256(lib.canonical(out)), lib.scanOutcome(modules, 'java-spring')];
  assert.ok(!JSON.stringify(base.legacy_report).includes(REPO_ROOT) && JSON.stringify(base.legacy_report).includes('<root>'), 'absolute locations are normalized, not dropped');
  for (const [field, edit] of [['rg_available', (r) => { r.rg_available = false; }], ['unknowns', (r) => { r.unknowns.push('added'); }], ['collisions', (r) => { r.collisions = [{ added: true }]; }], ['a future field', (r) => { r.future_field = 1; }]]) {
    const changed = lib.scanOutcome(modules, 'java-spring', edit);
    assert.equal(changed.semantic_sha256, base.semantic_sha256, `${field} is invisible to the semantic snapshot`);
    assert.notEqual(digest(changed), digest(base), `${field} must change the recorded output hash`);
  }
});

test('T11-01 negative: an origin citation must name the line that holds the cited test title', () => {
  const f = record.fixtures[0];
  const [, file, line, title] = /^(\S+):(\d+) \((.+)\)$/.exec(f.origin);
  const read = (rel) => (rel === file ? Buffer.from(`${'\n'.repeat(Number(line) - 1)}test('${title}', () => {`) : null);
  const check = (origin) => lib.originProblems({ tests: record.tests, fixtures: [{ ...f, origin }] }, read);
  assert.deepEqual(check(f.origin), []);
  assert.match(check(f.origin.replace(`:${line} `, `:${Number(line) + 1} `))[0], /does not hold/);
  assert.match(check(f.origin.replace(file, 'test/http-legacy-next/other.test.mjs'))[0], /not a readable recorded test/);
});

test('T11-01 negative: recomputation catches same-length edits that a format check accepts', () => {
  const buf = Buffer.from('export const answer = 42;\n');
  const good = { path: 'x/a.mjs', ...lib.digestsOf(buf) };
  assert.deepEqual(lib.recomputeProblems([good], () => buf, 't'), []);
  for (const key of ['sha256', 'git_blob_sha1']) {
    const bad = { ...good, [key]: flip(good[key]) };
    assert.match(lib.recomputeProblems([bad], () => buf, 't')[0], new RegExp(key));
    assert.equal(lib.classifyEntry(bad, buf).state, 'corrupt');
  }
  assert.match(lib.recomputeProblems([{ ...good, bytes: good.bytes + 1 }], () => buf, 't')[0], /bytes/);
  assert.equal(lib.classifyEntry(good, Buffer.from('export const answer = 43;\n')).state, 'drift');
  assert.equal(lib.classifyEntry(good, null).state, 'missing');
  const same = record.fixtures.map((f) => ({ id: f.id, deterministic: true, output_sha256: f.output_sha256, expected: f.expected }));
  assert.deepEqual(lib.replayProblems(record, same), []);
  const bad = structuredClone(same);
  bad[0].expected.verdict = 'changed';
  bad[1].output_sha256 = flip(bad[1].output_sha256);
  bad[2].deterministic = false;
  assert.equal(lib.replayProblems(record, bad).length, 3);
});

test('T11-01 negative: a re-sealed record with an invented base commit and tree fails in a shallow checkout although every live hash matches', (t) => inScratch('forged', async (dir) => {
  const checkout = lib.forgedCheckout(dir);
  const forged = lib.readRecord(checkout);
  assert.deepEqual(lib.verifyRecord(forged), [], 'the forgery is well-formed and sealed, so only the pinned commit can refuse it');
  assert.equal(lib.isShallow(checkout), true);
  if (!lib.classifyLive(forged, checkout).fresh) return t.diagnostic('live tree moved: this case needs live hashes that match the record');
  const refused = await lib.runPinnedCheck(checkout);
  assert.notEqual(refused.exit_code, 0);
  assert.match(refused.stdout, /pinned commit unavailable/);
  const allowed = await lib.runPinnedCheck(checkout, { BASELINE_ALLOW_UNVERIFIED: '1' });
  assert.equal(allowed.exit_code, 0);
  assert.match(allowed.stdout, /pinned-commit checks were NOT run/);
}));

test('T11-01 negative: a depth-1 checkout fetches the pinned commit, and an unfetchable one fails unless explicitly allowed', () => inScratch('depth1', (dir) => {
  const { checkout, record: small } = lib.depthOneCase(dir);
  assert.equal(lib.isShallow(checkout), true);
  const { moved, corrupt } = lib.classifyLive(small, checkout);
  assert.deepEqual([moved, corrupt], [['src/a.mjs', 'scan/new.mjs'], []], 'a changed source and a new scanner file both mean the tree moved on');
  assert.deepEqual(lib.commitVerdict(checkout, small.base_commit), { verdict: 'ok', via: 'fetch' });
  assert.deepEqual(lib.recomputeProblems(lib.pinnedEntries(small), lib.commitReader(checkout, small.base_commit), 'pinned'), []);
  const absent = '0'.repeat(40);
  assert.equal(lib.commitVerdict(checkout, absent, {}).verdict, 'fail');
  assert.match(lib.commitVerdict(checkout, absent, {}).message, /BASELINE_ALLOW_UNVERIFIED=1/);
  assert.equal(lib.commitVerdict(checkout, absent, { BASELINE_ALLOW_UNVERIFIED: '1' }).verdict, 'unverified');
  assert.equal(lib.commitVerdict(dir, absent, {}).verdict, 'fail', 'not a git work tree');
}));
