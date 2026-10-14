import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as base from './baseline-record-lib.mjs';
import * as lib from './interface-receipt-lib.mjs';

// T11-02 (4): the receipt of the interface checks, adapters/http-legacy-next/INTERFACE_RECEIPT.json. The committed file records one run of two commands at a
// named commit and the hashes of the files that run checked. This test recomputes what the file claims (its digest, the live files, the tree and blobs of
// the revision, the revision's place in the history, and the two commands replayed in an export of the revision) and shows on throw-away repositories made
// from copies of the real files that each check refuses the edit it covers. It does not make the receipt independent: the generator wrote the file.
// While T11_RECEIPT_REPLAY is 1 (the generator's runs and the replays set it, because a commit cannot hold the receipt of its own run) the committed file is
// not read: the same tests then run on a receipt built from the working tree's files, say so in a diagnostic, and no test is skipped.
const ROOT = base.REPO_ROOT;
const git = base.runGit;
const replay = lib.isReplay();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 't11-receipt-test-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

const RFC = 'adapters/http-legacy-next/INTERFACE_RFC.md';
const seal = (receipt) => ({ ...receipt, receipt_digest: lib.receiptDigest(receipt) });
const edited = (receipt, edit, { resealed = false } = {}) => { const copy = structuredClone(receipt); edit(copy); return resealed ? seal(copy) : copy; };
const lines = (problems) => problems.join('\n');

// A throw-away repository holding one commit with copies of the real files in `files`.
function repoWith(dir, files = lib.FILES) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'the checked files');
  return { root: dir, revision: git(dir, 'rev-parse', 'HEAD'), tree: git(dir, 'rev-parse', 'HEAD^{tree}') };
}
const fakeRun = (tests) => ({ exit_code: 0, signal: null, timed_out: false, result: { tests, suites: 0, pass: tests, fail: 0, cancelled: 0, skipped: 0, todo: 0 }, summary: [`ℹ tests ${tests}`, 'ℹ suites 0', `ℹ pass ${tests}`, 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0'] });
const sampleOf = (fx) => lib.buildReceipt({ root: fx.root, revision: fx.revision, tree: fx.tree, runs: [fakeRun(9), fakeRun(187)] });
const good = repoWith(path.join(work, 'good'));
const goodReceipt = sampleOf(good);

// A tiny repository with one test file and a command that really runs it, so that the generator and the replay execute real processes.
const TINY = { id: 'tiny', argv: ['node', '--test', '--test-reporter=tap', 'check.test.mjs'] };
const PASSING = "import { test } from 'node:test';\ntest('a', () => {});\ntest('b', () => {});\ntest('c', () => {});\n";
const FAILING = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('a', () => {});\ntest('b', () => assert.equal(1, 2));\n";
const HANGING = "import { test } from 'node:test';\ntest('waits', () => new Promise((resolve) => setTimeout(resolve, 6000)));\n";
const WRITING = "import fs from 'node:fs';\nimport { test } from 'node:test';\ntest('leaves a file behind', () => fs.writeFileSync('stray.txt', 'x'));\n";
// A test that passes only inside the environment the receipt promises: the replay switch on, the unverified override set to `unverified`, and a HOME and
// TMPDIR that are not the ones of the process that started it (their values are written into the file).
const probe = (unverified) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nconst parent = ${JSON.stringify({ home: process.env.HOME ?? null, tmp: process.env.TMPDIR ?? null })};\ntest('environment', () => {\n  assert.equal(process.env.${lib.REPLAY_ENV}, '1');\n  assert.equal(process.env.BASELINE_ALLOW_UNVERIFIED, ${JSON.stringify(unverified)});\n  assert.ok(process.env.HOME && process.env.TMPDIR);\n  assert.notEqual(process.env.HOME, parent.home);\n  assert.notEqual(process.env.TMPDIR, parent.tmp);\n});\n`;
function tinyRepo(name, source) {
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'check.test.mjs'), source);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'a tiny check');
  return { root: dir, revision: git(dir, 'rev-parse', 'HEAD'), tree: git(dir, 'rev-parse', 'HEAD^{tree}') };
}
const tinyOptions = (fx) => ({ root: fx.root, commands: [TINY], files: ['check.test.mjs'], write: false });
// The passing repository is generated once and shared by the tests that replay or regenerate it.
let tinyShared = null;
const tinyPass = () => (tinyShared ??= (async () => {
  const fx = tinyRepo('tiny-pass', PASSING);
  return { fx, ...(await lib.generate(tinyOptions(fx))) };
})());
// A receipt that claims a passing run of `tests` tests of the tiny command at the commit of `fx`.
const claimOf = (fx, tests) => lib.buildReceipt({ root: fx.root, revision: fx.revision, tree: fx.tree, runs: [fakeRun(tests)], commands: [TINY], files: ['check.test.mjs'] });

// What the first three tests check: the committed receipt, or in a replay the receipt built from the working tree's files.
function committed() {
  if (!fs.existsSync(path.join(ROOT, lib.RECEIPT_FILE))) throw new Error(`${lib.RECEIPT_FILE} is missing: run node ${lib.GENERATOR_FILE} on a clean tree and commit the file it writes (${lib.REPLAY_ENV}=1 is only for replaying a revision that cannot hold it)`);
  return lib.readReceipt(ROOT);
}
const subject = () => (replay ? goodReceipt : committed());
const subjectRoot = replay ? good.root : ROOT;
const which = replay ? `${lib.REPLAY_ENV}=1: the committed receipt is not read; this run checks a receipt built from the working tree's copies of the listed files` : 'checking the committed receipt';

test('T11-02 the receipt has the schema, status, both commands, the listed files and limits, and a digest that matches', (t) => {
  t.diagnostic(which);
  const receipt = subject();
  assert.deepEqual(lib.shapeProblems(receipt), []);
  assert.deepEqual(receipt.commands.map((c) => [c.id, c.argv.join(' '), c.exit_code]), [['interface-test', 'node --test --test-reporter=tap test/http-legacy-next/interface-rfc.test.mjs', 0], ['nested-runner', 'node scripts/run-next-nested-tests.mjs T11', 0]]);
  for (const rel of [RFC, 'test/http-legacy-next/interface-rfc.vocabulary.json', 'test/http-legacy-next/interface-rfc.test.mjs', 'adapters/http-legacy-next/BASELINE.json']) assert.ok(receipt.files.some((f) => f.path === rel), `${rel} is hashed`);
});

test('T11-02 every listed file of the working tree equals the receipt, the files of this track included', (t) => {
  t.diagnostic(which);
  const receipt = subject();
  assert.deepEqual(lib.liveFileProblems(receipt, subjectRoot), []);
  for (const rel of [lib.TEST_FILE, lib.GENERATOR_FILE, 'test/http-legacy-next/interface-receipt-lib.mjs', 'test/http-legacy-next/baseline-record-lib.mjs']) assert.ok(receipt.files.some((f) => f.path === rel), `${rel} is hashed, not exempted`);
});

test('T11-02 the revision holds the recorded tree and blobs and is an ancestor of this checkout, or the test says why it could not tell', (t) => {
  t.diagnostic(which);
  const receipt = subject();
  const found = lib.revisionProblems(receipt, subjectRoot);
  t.diagnostic(`revision ${receipt.revision} found via ${found.via}`);
  for (const note of found.notes) t.diagnostic(note);
  assert.deepEqual(found.problems, []);
  assert.equal(found.notes.length, 1, 'exactly one note says which branch ran');
  assert.match(found.notes[0], found.via === 'unverified' ? /so the pinned-commit checks were NOT run/ : /^ancestry (checked|NOT checked)/);
});

test('T11-02 the recorded commands replay in an export of the revision with the recorded exit codes and counts', async (t) => {
  // The driver on a real tiny repository: generated from a run, replayed from an export of its commit.
  const { fx, receipt: tiny } = await tinyPass();
  assert.deepEqual([tiny.commands[0].exit_code, tiny.commands[0].tests, tiny.commands[0].pass, tiny.commands[0].fail], [0, 3, 3, 0]);
  const again = await lib.replayRevision(tiny, fx.root, path.join(work, 'replay-tiny'));
  assert.deepEqual(again.problems, []);
  assert.match(again.lines[0], /^tiny replayed: exit 0, tests 3, pass 3, fail 0, skipped 0 \(recorded: exit 0, tests 3, pass 3, fail 0, skipped 0\)$/);
  if (replay) {
    t.diagnostic(`${lib.REPLAY_ENV}=1: this run is a replay itself, so it does not replay the committed commands again`);
    assert.equal(process.env[lib.REPLAY_ENV], '1');
    return;
  }
  const receipt = committed();
  const found = lib.revisionProblems(receipt, ROOT);
  if (found.via === 'unverified') {
    t.diagnostic(`replay NOT run: ${found.notes[0]}`);
    assert.match(found.notes[0], /NOT run/);
    return;
  }
  assert.deepEqual(found.problems, [], 'the revision must be available before it can be replayed');
  const real = await lib.replayRevision(receipt, ROOT, path.join(work, 'replay-real'));
  for (const line of real.lines) t.diagnostic(line);
  assert.deepEqual(real.problems, []);
});

test('T11-02 the replay refuses a recorded exit code or count that the export does not give, a failing run and a killed run', async () => {
  const { fx, receipt: tiny } = await tinyPass();
  const replayed = (receipt, root, name, ms) => lib.replayRevision(receipt, root, path.join(work, name), ms);
  assert.deepEqual((await replayed(tiny, fx.root, 'cmp-control')).problems, [], 'control: the unedited receipt replays cleanly');
  // The receipt says 1 where the export exits 0, and 4 / 2 / 1 / 1 where it counts 3 / 3 / 0 / 0.
  const exit = await replayed(edited(tiny, (r) => { r.commands[0].exit_code = 1; }), fx.root, 'cmp-exit');
  assert.deepEqual(exit.problems, ['command tiny: exit code 0 != recorded 1']);
  const counts = await replayed(edited(tiny, (r) => Object.assign(r.commands[0], { tests: 4, pass: 2, fail: 1, skipped: 1 })), fx.root, 'cmp-counts');
  assert.deepEqual(counts.problems, ['command tiny: tests 3 != recorded 4', 'command tiny: pass 3 != recorded 2', 'command tiny: fail 0 != recorded 1', 'command tiny: skipped 0 != recorded 1']);
  // A commit whose test fails, claimed as a passing run of two tests.
  const failing = tinyRepo('tiny-fail', FAILING);
  const lied = await replayed(claimOf(failing, 2), failing.root, 'cmp-fail');
  assert.deepEqual(lied.problems, ['command tiny: exit code 1 != recorded 0', 'command tiny: pass 1 != recorded 2', 'command tiny: fail 1 != recorded 0']);
  // A commit whose test outlives the limit is killed and reported, not waited for.
  const hanging = tinyRepo('tiny-hang', HANGING);
  const killed = await replayed(claimOf(hanging, 1), hanging.root, 'cmp-hang', 1200);
  assert.ok(killed.problems.includes('command tiny: killed after the time limit'), lines(killed.problems));
  assert.ok(killed.problems.includes('command tiny: exit code null != recorded 0'), lines(killed.problems));
  // compareRun on its own: cancelled and todo must be 0 and a run that printed no summary matches nothing.
  const recorded = tiny.commands[0];
  const ran = (result, extra = {}) => ({ exit_code: 0, signal: null, timed_out: false, result, summary: [], ...extra });
  assert.deepEqual(lib.compareRun(recorded, ran({ tests: 3, pass: 3, fail: 0, skipped: 0, cancelled: 0, todo: 0 })), []);
  assert.deepEqual(lib.compareRun(recorded, ran({ tests: 3, pass: 3, fail: 0, skipped: 0, cancelled: 1, todo: 2 })), ['command tiny: cancelled 1 != 0', 'command tiny: todo 2 != 0']);
  assert.deepEqual(lib.compareRun(recorded, ran({})), ['command tiny: tests undefined != recorded 3', 'command tiny: pass undefined != recorded 3', 'command tiny: fail undefined != recorded 0', 'command tiny: skipped undefined != recorded 0', 'command tiny: cancelled undefined != 0', 'command tiny: todo undefined != 0']);
  assert.deepEqual(lib.compareRun(recorded, ran({ tests: 3, pass: 3, fail: 0, skipped: 0, cancelled: 0, todo: 0 }, { exit_code: 1 })), ['command tiny: exit code 1 != recorded 0']);
  assert.throws(() => lib.runRecorded({ id: 'x', argv: ['sh', '-c', 'true'] }, work, {}), /command x: argv\[0\] must be node/);
  // The environment inside a replayed run, seen by the probe: the switch on, the override set and a scratch HOME and TMPDIR. The control expects the
  // generator's environment (override empty) and fails, so the probe does look.
  const sees = tinyRepo('cmp-env-1', probe('1'));
  assert.deepEqual((await replayed(claimOf(sees, 1), sees.root, 'cmp-env-1')).problems, []);
  const expects = tinyRepo('cmp-env-0', probe(''));
  assert.deepEqual((await replayed(claimOf(expects, 1), expects.root, 'cmp-env-0')).problems, ['command tiny: exit code 1 != recorded 0', 'command tiny: pass 0 != recorded 1', 'command tiny: fail 1 != recorded 0']);
});

test('T11-02 the shape check names each edit of the receipt that it covers, and an edit that is re-sealed fails only that check', () => {
  assert.deepEqual(lib.shapeProblems(goodReceipt), [], 'control: the unedited sample');
  const entry = (r, rel = RFC) => r.files.find((f) => f.path === rel);
  const rows = [
    ['an exit code of 1, not re-sealed', (r) => { r.commands[1].exit_code = 1; }, false, ['command nested-runner: exit_code must be 0, not 1; a receipt records a passing run', /^receipt_digest [0-9a-f]{64} != [0-9a-f]{64} recomputed from the other keys$/]],
    ['an exit code of 1, re-sealed', (r) => { r.commands[1].exit_code = 1; }, true, ['command nested-runner: exit_code must be 0, not 1; a receipt records a passing run']],
    ['a null exit code (a killed run), re-sealed', (r) => { r.commands[0].exit_code = null; }, true, ['command interface-test: exit_code must be 0, not null; a receipt records a passing run']],
    ['a test count that disagrees with pass_text', (r) => { r.commands[0].tests = 10; }, true, ['command interface-test: tests 10 != 9 in pass_text']],
    ['a count that is not a count', (r) => { r.commands[0].tests = -1; }, true, ['command interface-test: tests must be a count', 'command interface-test: tests -1 != 9 in pass_text']],
    ['a failure in pass_text', (r) => { r.commands[0].fail = 2; r.commands[0].pass_text[3] = 'ℹ fail 2'; }, true, ['command interface-test: pass_text records fail 2, cancelled 0, todo 0; all must be 0']],
    ['a todo in pass_text', (r) => { r.commands[1].pass_text[6] = 'ℹ todo 1'; }, true, ['command nested-runner: pass_text records fail 0, cancelled 0, todo 1; all must be 0']],
    ['no test at all', (r) => { Object.assign(r.commands[0], { tests: 0, pass: 0 }); r.commands[0].pass_text[0] = 'ℹ tests 0'; r.commands[0].pass_text[2] = 'ℹ pass 0'; }, true, ['command interface-test: tests 0 != pass 0 + skipped 0']],
    ['a summary of six lines', (r) => { r.commands[0].pass_text.pop(); }, true, ['command interface-test: pass_text must be the 7 summary lines (tests, suites, pass, fail, cancelled, skipped, todo) as printed']],
    ['a status of final', (r) => { r.status = 'final'; }, true, ['status must be "provisional", not "final"']],
    ['a track of T12', (r) => { r.track = 'T12'; }, true, ['track must be "T11", not "T12"']],
    ['items without T11-02', (r) => { r.items = ['T11-01']; }, true, ['items must be ["T11-01","T11-02"], not ["T11-01"]']],
    ['another schema version', (r) => { r.schema = 'bskel.interface-receipt/2'; }, true, ['schema must be "bskel.interface-receipt/1", not "bskel.interface-receipt/2"']],
    ['a revision that is a branch name', (r) => { r.revision = 'main'; }, true, ['revision must be 40 hex digits']],
    ['an upper case tree id', (r) => { r.tree = r.tree.toUpperCase(); }, true, ['tree must be 40 hex digits']],
    ['a node version without a patch number', (r) => { r.node_version = 'v24'; }, true, ['node_version must look like v24.19.0']],
    ['a key that is not in the schema', (r) => { r.note = 'looks fine'; }, true, ['receipt keys: unexpected note']],
    ['a missing tree id', (r) => { delete r.tree; }, true, ['receipt keys: missing tree', 'tree must be 40 hex digits']],
    ['a digest edited by hand', (r) => { r.receipt_digest = 'f'.repeat(64); }, false, [/^receipt_digest f{64} != [0-9a-f]{64} recomputed from the other keys$/]],
    ['a digest that is not hex', (r) => { r.receipt_digest = 'not a digest'; }, false, ['receipt_digest must be 64 hex digits']],
    ['the RFC dropped from files', (r) => { r.files = r.files.filter((f) => f.path !== RFC); }, true, [`files paths: missing ${RFC}`]],
    ['a file that nobody hashes', (r) => { r.files.push({ ...r.files[0], path: 'adapters/http-legacy-next/extra.md' }); }, true, ['files paths: unexpected adapters/http-legacy-next/extra.md']],
    ['a file listed twice', (r) => { r.files.push({ ...entry(r) }); }, true, [`files paths: repeated ${RFC}`]],
    ['a hash that is not hex', (r) => { entry(r).sha256 = 'zz'; }, true, [`file ${RFC}: bytes, git_blob_sha1 and sha256 must be a count and two hex digests`]],
    ['a file entry with an extra key', (r) => { entry(r).mtime = 1; }, true, [`file ${RFC} keys: unexpected mtime`]],
    ['a path that is a list holding the path', (r) => { entry(r).path = [RFC]; }, true, ['file path must be a string']],
    ['a limit reworded', (r) => { r.limits[2] = 'independent: a reviewer signed it.'; }, true, [/^limits must be \[.*independent: a reviewer signed it\./]],
    ['a limit dropped', (r) => { r.limits.pop(); }, true, [/^limits must be \["self-run: /]],
    ['a command dropped', (r) => { r.commands.pop(); }, true, ['commands must list exactly interface-test and nested-runner']],
    ['an argv changed', (r) => { r.commands[0].argv = ['node', '--test', 'x.mjs']; }, true, ['command interface-test argv must be ["node","--test","--test-reporter=tap","test/http-legacy-next/interface-rfc.test.mjs"], not ["node","--test","x.mjs"]']]
  ];
  for (const [name, edit, resealed, expected] of rows) {
    const problems = lib.shapeProblems(edited(goodReceipt, edit, { resealed }));
    assert.equal(problems.length, expected.length, `${name}: ${lines(problems)}`);
    for (const want of expected) {
      assert.equal(problems.filter((p) => (want instanceof RegExp ? want.test(p) : p === want)).length, 1, `${name}: no single problem like ${want} in:\n${lines(problems)}`);
    }
  }
  // The digest covers every other key: changing any one of them without re-sealing is reported as a digest mismatch, whatever else is reported.
  for (const key of lib.RECEIPT_KEYS.filter((k) => k !== 'receipt_digest')) {
    const changed = lib.shapeProblems(edited(goodReceipt, (r) => { r[key] = [r[key], 'changed']; }));
    assert.equal(changed.filter((p) => /^receipt_digest [0-9a-f]{64} != [0-9a-f]{64} recomputed from the other keys$/.test(p)).length, 1, `${key}: ${lines(changed)}`);
  }
  for (const odd of [null, [], 'text', 3]) assert.deepEqual(lib.shapeProblems(odd), ['receipt: must be an object']);
  // What must not be refused: the other Node line's prefix, another Node version, another key order.
  const other = edited(goodReceipt, (r) => { r.node_version = 'v22.5.1'; r.commands.forEach((c) => { c.pass_text = c.pass_text.map((l) => l.replace('ℹ ', '# ')); }); }, { resealed: true });
  assert.deepEqual(lib.shapeProblems(other), [], 'the TAP prefix and another Node version are accepted');
  assert.deepEqual(lib.shapeProblems(Object.fromEntries(Object.entries(goodReceipt).reverse())), [], 'key order does not change the digest');
  const text = lib.receiptText(goodReceipt);
  assert.ok(text.endsWith('}\n') && !text.endsWith('\n\n'));
  assert.deepEqual(JSON.parse(text), goodReceipt);
  assert.equal(`${JSON.stringify(JSON.parse(text), null, 2)}\n`, text, 'the file is its own canonical rendering');
});

test('T11-02 the live check refuses an edited, an own and a missing file, and the revision check refuses a receipt re-hashed to fit an edit', () => {
  const VOCAB = 'test/http-legacy-next/interface-rfc.vocabulary.json';
  const keys = ['bytes', 'git_blob_sha1', 'sha256'];
  const make = (name) => { const fx = repoWith(path.join(work, name)); return { fx, receipt: sampleOf(fx) }; };
  const head = (p) => p.split(' ').slice(0, 3).join(' ');
  const control = make('live-control');
  assert.deepEqual(lib.liveFileProblems(control.receipt, control.fx.root), [], 'control: the files the receipt was built from');
  // One appended line changes all three values. The RFC, the vocabulary, this test and the receipt library are all compared: none is exempt.
  for (const rel of [RFC, VOCAB, lib.TEST_FILE, 'test/http-legacy-next/interface-receipt-lib.mjs']) {
    const { fx, receipt } = make(`live-${path.basename(rel)}`);
    fs.appendFileSync(path.join(fx.root, rel), '\n');
    const found = lib.liveFileProblems(receipt, fx.root);
    assert.deepEqual(found.map(head), keys.map((key) => `live: ${rel} ${key}`), `${rel}: ${lines(found)}`);
  }
  // An edit that keeps the size is caught by the two hashes alone.
  const same = make('live-same-size');
  const file = path.join(same.fx.root, RFC);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('e', 'E'));
  assert.equal(fs.statSync(file).size, same.receipt.files.find((f) => f.path === RFC).bytes);
  assert.deepEqual(lib.liveFileProblems(same.receipt, same.fx.root).map(head), [`live: ${RFC} git_blob_sha1`, `live: ${RFC} sha256`]);
  // A file that is gone.
  const gone = make('live-missing');
  fs.rmSync(path.join(gone.fx.root, VOCAB));
  assert.deepEqual(lib.liveFileProblems(gone.receipt, gone.fx.root), [`live: cannot read ${VOCAB}`]);
  // An edited RFC committed after the run, with the receipt's entry for it changed to fit and the receipt re-sealed. Its shape and the live files
  // agree, so only the blobs of the recorded revision can refuse it. The unedited receipt is refused by the live check instead.
  const attack = make('rehashed');
  fs.appendFileSync(path.join(attack.fx.root, RFC), 'A sentence added after the run.\n');
  git(attack.fx.root, 'commit', '-q', '-am', 'edit the RFC after the run');
  const rehashed = edited(attack.receipt, (r) => { r.files[r.files.findIndex((f) => f.path === RFC)] = base.fileEntry(attack.fx.root, RFC); }, { resealed: true });
  assert.deepEqual(lib.shapeProblems(rehashed), [], 'the re-hashed receipt is well formed and sealed');
  assert.deepEqual(lib.liveFileProblems(rehashed, attack.fx.root), [], 'and equals the edited file of the working tree');
  const found = lib.revisionProblems(rehashed, attack.fx.root, {});
  assert.deepEqual(found.problems.map(head), keys.map((key) => `revision: ${RFC} ${key}`), lines(found.problems));
  assert.deepEqual(lib.liveFileProblems(attack.receipt, attack.fx.root).map(head), keys.map((key) => `live: ${RFC} ${key}`));
  assert.deepEqual(lib.revisionProblems(attack.receipt, attack.fx.root, {}).problems, [], 'the unedited receipt matches its revision');
});

test('T11-02 the revision check refuses an unknown, a different and an unrelated revision, a file missing at it, and says when a shallow checkout hides the ancestry', () => {
  const VOCAB = 'test/http-legacy-next/interface-rfc.vocabulary.json';
  const keys = ['bytes', 'git_blob_sha1', 'sha256'];
  const head = (p) => p.split(' ').slice(0, 3).join(' ');
  const fx = repoWith(path.join(work, 'revision'));
  const receipt = sampleOf(fx);
  const at = (revision, extra = {}) => edited(receipt, (r) => Object.assign(r, { revision }, extra), { resealed: true });
  const control = lib.revisionProblems(receipt, fx.root, {});
  assert.deepEqual([control.problems, control.via, control.notes], [[], 'checkout', [`ancestry checked: ${fx.revision} is an ancestor of HEAD`]], 'control: an ancestor of HEAD, found in the checkout');
  // A revision this checkout cannot produce fails, naming the fetch; only the explicit override turns it into a note that the checks were NOT run.
  const unknown = '1'.repeat(40);
  const lost = lib.revisionProblems(at(unknown), fx.root, {});
  assert.equal(lost.problems.length, 1, lines(lost.problems));
  assert.match(lost.problems[0], new RegExp(`^pinned commit unavailable: ${unknown} is not in this checkout and \`git fetch --no-tags origin ${unknown}\` failed \\(.+\\); set BASELINE_ALLOW_UNVERIFIED=1 to skip the pinned-commit checks explicitly$`));
  assert.deepEqual([lost.via, lost.notes], [null, []]);
  const skipped = lib.revisionProblems(at(unknown), fx.root, { BASELINE_ALLOW_UNVERIFIED: '1' });
  assert.deepEqual([skipped.problems, skipped.via, skipped.notes.length], [[], 'unverified', 1]);
  assert.match(skipped.notes[0], new RegExp(`^BASELINE_ALLOW_UNVERIFIED=1, so the pinned-commit checks were NOT run: pinned commit unavailable: ${unknown} is not in this checkout`));
  for (const bad of ['main', '--upload-pack=touch x', unknown.slice(1)]) assert.deepEqual(lib.revisionProblems(at(bad), fx.root, {}).problems, ['revision must be 40 hex digits'], bad);
  // The same files on another line of history: the tree and blobs agree, the ancestry does not.
  const other = git(fx.root, 'commit-tree', receipt.tree, '-m', 'the same files on another line of history');
  const unrelated = lib.revisionProblems(at(other), fx.root, {});
  assert.deepEqual([unrelated.problems, unrelated.via], [[`revision ${other} is not an ancestor of HEAD`], 'checkout']);
  // A later commit with an edited RFC, named as the revision: its tree and the blob of the RFC differ from what the receipt recorded.
  fs.appendFileSync(path.join(fx.root, RFC), 'An edit made after the run.\n');
  git(fx.root, 'commit', '-q', '-am', 'edit the RFC');
  const later = git(fx.root, 'rev-parse', 'HEAD');
  const different = lib.revisionProblems(at(later), fx.root, {});
  assert.equal(different.problems[0], `revision ${later} has tree ${git(fx.root, 'rev-parse', 'HEAD^{tree}')}, not the recorded ${receipt.tree}`);
  assert.deepEqual(different.problems.slice(1).map(head), keys.map((key) => `revision: ${RFC} ${key}`));
  // A commit that lacks a listed file, with the receipt's revision and tree id changed to name it: the file cannot be read there.
  const lacking = repoWith(path.join(work, 'lacking'), lib.FILES.filter((rel) => rel !== VOCAB));
  const dropped = lib.revisionProblems(edited(receipt, (r) => Object.assign(r, { revision: lacking.revision, tree: lacking.tree }), { resealed: true }), lacking.root, {});
  assert.deepEqual(dropped.problems, [`revision: cannot read ${VOCAB}`]);
  // A depth-1 checkout lacks the revision the way a CI checkout does: it is fetched, the tree and blobs are checked, and the note says the ancestry was not.
  const up = repoWith(path.join(work, 'upstream'));
  git(up.root, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  fs.writeFileSync(path.join(up.root, 'later.txt'), 'a later commit\n');
  git(up.root, 'add', '-A');
  git(up.root, 'commit', '-q', '-m', 'a later commit');
  git(work, 'clone', '-q', '--depth=1', `file://${up.root}`, 'shallow');
  const shallow = path.join(work, 'shallow');
  assert.equal(base.isShallow(shallow), true);
  assert.equal(base.hasCommit(shallow, up.revision), false);
  const upstreamReceipt = sampleOf(up);
  const fetched = lib.revisionProblems(upstreamReceipt, shallow, {});
  assert.deepEqual([fetched.problems, fetched.via], [[], 'fetch']);
  assert.deepEqual(fetched.notes, [`ancestry NOT checked: this checkout is shallow, so ${up.revision} may be an ancestor of HEAD whose history is cut off; the tree and file checks ran on the commit found here (fetch)`]);
  const forged = edited(upstreamReceipt, (r) => { r.files.find((f) => f.path === RFC).sha256 = 'f'.repeat(64); }, { resealed: true });
  assert.deepEqual(lib.revisionProblems(forged, shallow, {}).problems.map(head), [`revision: ${RFC} sha256`], 'a shallow checkout still compares the blobs');
});

test('T11-02 the generator writes the same bytes twice and refuses an absent or dirty tree, a failing, killed or tree-editing command and a receipt that fails its own check', async () => {
  const { fx, receipt, text } = await tinyPass();
  const receiptPath = (root) => path.join(root, lib.RECEIPT_FILE);
  const refused = (options, message) => assert.rejects(lib.generate(options), { message });
  assert.equal(text, lib.receiptText(receipt));
  assert.equal((await lib.generate(tinyOptions(fx))).text, text, 'the same tree and the same counts give the same bytes');
  assert.equal(fs.existsSync(receiptPath(fx.root)), false, 'write: false leaves no file');
  assert.equal((await lib.generate({ ...tinyOptions(fx), write: true })).text, text);
  assert.equal(fs.readFileSync(receiptPath(fx.root), 'utf8'), text, 'the file holds exactly the bytes the receipt renders to');
  await refused(tinyOptions(fx), /^refusing to write a receipt: the working tree is not clean \(\?\? adapters\/http-legacy-next\/INTERFACE_RECEIPT\.json\)$/);
  // A tree with an edited file, then one with an extra file.
  const dirty = tinyRepo('gen-dirty', PASSING);
  fs.appendFileSync(path.join(dirty.root, 'check.test.mjs'), '// edited after the commit\n');
  await refused(tinyOptions(dirty), /^refusing to write a receipt: the working tree is not clean \( M check\.test\.mjs\)$/);
  git(dirty.root, 'checkout', '-q', '--', 'check.test.mjs');
  fs.writeFileSync(path.join(dirty.root, 'stray.txt'), 'x');
  await refused(tinyOptions(dirty), /^refusing to write a receipt: the working tree is not clean \(\?\? stray\.txt\)$/);
  // A commit whose test fails, one whose test never ends, and one whose test leaves a file behind.
  const failing = tinyRepo('gen-fail', FAILING);
  await refused(tinyOptions(failing), /^refusing to write a receipt: command tiny exited with 1; command tiny counted fail 1, cancelled 0, todo 0; command tiny counted tests 2, pass 1, skipped 0$/);
  const hanging = tinyRepo('gen-hang', HANGING);
  await refused({ ...tinyOptions(hanging), timeoutMs: 1200 }, /^refusing to write a receipt: command tiny was killed after the time limit; command tiny printed 0 summary lines, not 7$/);
  const writing = tinyRepo('gen-write', WRITING);
  await refused(tinyOptions(writing), /^refusing to write a receipt: the commands changed the working tree or HEAD \(\?\? stray\.txt\)$/);
  // The environment of the generator's runs, seen by the probe: the switch on, the override empty and a scratch HOME and TMPDIR.
  const seen = tinyRepo('gen-env', probe(''));
  assert.equal((await lib.generate(tinyOptions(seen))).receipt.commands[0].tests, 1);
  const unexpected = tinyRepo('gen-env-wrong', probe('1'));
  await refused(tinyOptions(unexpected), /^refusing to write a receipt: command tiny exited with 1; command tiny counted fail 1, cancelled 0, todo 0; command tiny counted tests 1, pass 0, skipped 0$/);
  // A root that is not there cannot be shown clean, and a receipt that fails its own shape check is not written: a node version that is not three numbers.
  await refused({ ...tinyOptions(fx), root: path.join(work, 'no-such-repository') }, /^refusing to write a receipt: the working tree is not clean \(git status failed: .*ENOENT.*\)$/);
  const odd = tinyRepo('gen-odd-node', PASSING);
  await refused({ ...tinyOptions(odd), nodeVersion: 'v24' }, /^refusing to write a receipt that fails its own check: node_version must look like v24\.19\.0$/);
  for (const repo of [failing, hanging, writing, dirty, odd]) assert.equal(fs.existsSync(receiptPath(repo.root)), false, 'a refused run writes nothing');
  // The pass rules on their own.
  const outcome = (over) => ({ exit_code: 0, signal: null, timed_out: false, result: { tests: 3, suites: 0, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0 }, summary: fakeRun(3).summary, ...over });
  const result = (over) => ({ result: { tests: 3, suites: 0, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...over } });
  assert.deepEqual(lib.passProblems(TINY, outcome({})), []);
  assert.deepEqual(lib.passProblems(TINY, outcome({ exit_code: 2, signal: 'SIGTERM' })), ['command tiny exited with 2 (SIGTERM)']);
  assert.deepEqual(lib.passProblems(TINY, outcome(result({ tests: 0, pass: 0 }))), ['command tiny counted tests 0, pass 0, skipped 0']);
  assert.deepEqual(lib.passProblems(TINY, outcome(result({ pass: 2, cancelled: 1 }))), ['command tiny counted fail 0, cancelled 1, todo 0', 'command tiny counted tests 3, pass 2, skipped 0']);
  assert.deepEqual(lib.passProblems(TINY, outcome({ summary: [] })), ['command tiny printed 0 summary lines, not 7']);
});

test('T11-02 the replay switch is on only for the value 1, and no workflow or nested runner sets it', () => {
  assert.equal(lib.REPLAY_ENV, 'T11_RECEIPT_REPLAY');
  for (const [value, on] of [['1', true], ['', false], ['0', false], ['true', false], [' 1', false], ['11', false], [undefined, false]]) {
    assert.equal(lib.isReplay({ [lib.REPLAY_ENV]: value }), on, JSON.stringify(value));
  }
  assert.equal(lib.isReplay({}), false);
  assert.equal(lib.isReplay({ T11_REPLAY: '1' }), false, 'only the documented name counts');
  // The places that could switch it on for a whole CI run: every file of the workflow directory and the nested runner.
  const workflows = path.join(ROOT, '.github', 'workflows');
  const runs = [...fs.readdirSync(workflows, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(workflows, e.name)), path.join(ROOT, 'scripts', 'run-next-nested-tests.mjs')];
  assert.ok(runs.length >= 2, 'at least one workflow and the runner were read');
  for (const file of runs) assert.equal(fs.readFileSync(file, 'utf8').includes(lib.REPLAY_ENV), false, `${path.relative(ROOT, file)} must not mention ${lib.REPLAY_ENV}`);
});
