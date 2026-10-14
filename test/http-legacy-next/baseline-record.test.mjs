import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectSuite, SUITES } from '../../scripts/run-next-nested-tests.mjs';
import * as lib from './baseline-record-lib.mjs';

// T11-01: BASELINE.json pins what the five legacy HTTP adapters and the T11 modules did at one exact commit. Everything is recomputed
// from real files, scans and commands; every list and key set is compared with the literal tables of the library (EXPECTED).
const { REPO_ROOT, flip } = lib;
const record = lib.readRecord();
const live = lib.classifyLive(record);
const copy = (edit) => { const r = structuredClone(record); edit(r); return r; };
const reseal = (edit) => { const r = copy(edit); r.artifact_digest.value = lib.artifactDigest(r); return r; };
const at = (r, p) => p.split('.').filter(Boolean).reduce((x, k) => x[k], r);
const inScratch = async (name, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bskel-${name}-`));
  try { await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
const replayOf = async (dir) => { const m = await lib.loadModules(dir); return [...lib.expectationProblems(m), ...lib.replayProblems(record, lib.replay(record, m))]; };

// The pinned commit is always required: matching live hashes say nothing about base_commit, base_tree, ancestry or the archived commands.
// It is fetched when absent (--depth=1 in a shallow checkout), its absence fails, and only BASELINE_ALLOW_UNVERIFIED=1 makes that a diagnostic.
function pinnedAvailable(t) {
  const v = lib.commitVerdict(REPO_ROOT, record.base_commit);
  if (v.verdict === 'fail') assert.fail(v.message);
  if (v.verdict === 'unverified') t.diagnostic(v.message);
  return v.verdict === 'ok';
}

test('T11-01 the record is consistent, claims nothing as supported, and every pin is recomputed', (t) => {
  assert.deepEqual(lib.verifyRecord(record), []);
  assert.doesNotMatch(JSON.stringify(record), /"(?:SUPPORTED|supported|certified|runtime-tested)"/);
  assert.deepEqual(live.corrupt, [], 'a record that disagrees with a file in only one hash is damaged, not moved');
  t.diagnostic(live.pinsMoved.length === 0 ? `every pinned file equals the record; ${live.moved.length} files that no pin covers sit beside them` : `pinned files moved: ${live.pinsMoved.join(', ')}`);
  const pinnedRead = pinnedAvailable(t) ? lib.commitReader(REPO_ROOT, record.base_commit) : null;
  const { problems, compared } = lib.pinProblems(record, { live, liveRead: lib.liveReader(REPO_ROOT), pinnedRead });
  t.diagnostic(`pins compared with: ${compared.length > 0 ? compared.join(' and ') : 'nothing'}`);
  assert.deepEqual(problems, []);
  if (process.env.BASELINE_ALLOW_UNVERIFIED !== '1') assert.ok(compared.includes('pinned commit blobs'), 'without the explicit override the pinned commit decides, fresh live tree or not');
});

test('T11-01 the nested runner still collects every recorded test file and this record test', () => {
  const found = inspectSuite(SUITES.find((s) => s.id === record.suite_id), REPO_ROOT);
  assert.equal(found.status, 'READY');
  const collected = found.tests.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'));
  for (const wanted of [...record.tests.map((x) => x.path), 'test/http-legacy-next/baseline-record.test.mjs']) assert.ok(collected.includes(wanted), wanted);
});

test('T11-01 replaying the fixtures on the live tree reproduces every recorded output hash', async (t) => {
  // Files that no pin covers sit in the live tree (other tracks add them), but only a moved pin, a scanner adapter or a fixture
  // file can change a replay (the scenario test below runs both kinds), so the replay runs unless one of those moved.
  if (live.replayMoved.length > 0) return t.diagnostic(`live replay NOT run, files that change a replay moved: ${live.replayMoved.join(', ')}; the export of the pinned commit decides`);
  t.diagnostic(`live replay runs; ${live.moved.length} files that no pin covers cannot change it`);
  assert.deepEqual(lib.importProblems(record, lib.liveReader(REPO_ROOT)), [], 'the modules load only each other and node: built-ins');
  assert.deepEqual(await replayOf(REPO_ROOT), []);
});

test('T11-01 the pinned commit has the recorded tree and files, and an export of it reproduces replay, counts and exit codes', async (t) => {
  if (!pinnedAvailable(t)) return;
  const { base_commit: commit } = record;
  assert.equal(lib.revParse(REPO_ROOT, `${commit}^{tree}`), record.base_tree);
  const tree = lib.commitTree(REPO_ROOT, commit);
  assert.deepEqual(lib.treeProblems(record, tree), [], 'modules, tests, scanner files and closure, and the five fixture trees equal the tables');
  const edited = (dir, edit) => ({ ...tree, list: (d) => (d === dir ? edit(tree.list(d)) : tree.list(d)) });
  const registry = (p) => (p === 'scanners/registry.mjs' ? Buffer.concat([tree.read(p), Buffer.from("\nimport './extra.mjs';\n")]) : tree.read(p));
  for (const [dir, edit] of [[record.source_dir, (l) => [...l, 'extra.mjs']], [record.test_dir, (l) => l.slice(1)], [record.scanner_dir, (l) => [...l, 'extra.mjs']], [record.inputs[0].dir, (l) => l.slice(1)]]) assert.notDeepEqual(lib.treeProblems(record, edited(dir, edit)), [], dir);
  assert.match(lib.treeProblems(record, { ...tree, read: registry }).join('\n'), /scanner closure: unexpected scanners\/extra.mjs/);
  assert.notDeepEqual(lib.treeProblems(record, { ...tree, id: () => 'f'.repeat(40) }), [], 'a wrong tree id');
  if (lib.isShallow(REPO_ROOT)) t.diagnostic('shallow checkout: ancestry of the pinned commit is not claimed');
  else assert.ok(lib.isAncestor(REPO_ROOT, commit), 'the pinned commit must be an ancestor of HEAD');

  await inScratch('export', async (dest) => {
    lib.extractTree(REPO_ROOT, commit, dest);
    const exported = lib.classifyLive(record, dest);
    assert.deepEqual([exported.corrupt, exported.moved], [[], []], 'every pin equals its file in the pinned commit, and the commit holds no file that no pin covers: the forged checkout below starts from this export');
    const files = record.tests.map((x) => x.path);
    const [nested, tap, ...perFile] = await Promise.all([lib.runNestedRunner(dest, record.suite_id), lib.runTapTests(dest, files), ...files.map((f) => lib.runTapTests(dest, [f]))]);
    const command = (id) => record.commands.find((c) => c.id === id);
    for (const [again, c] of [[nested, command('nested-runner')], [tap, command('direct-tap')]]) {
      assert.equal(again.exit_code, c.exit_code, c.id);
      assert.deepEqual(again.result, c.result, c.id);
    }
    assert.equal(nested.stdout_first_line, command('nested-runner').stdout_first_line);
    perFile.forEach((run, i) => assert.equal(run.result.tests, record.tests[i].test_count, files[i]));
    assert.deepEqual(await replayOf(dest), []);
  });
});

test('T11-01 negative: edits fail verification re-sealed (recomputed and exact checks) and not re-sealed (the whole-record seal)', () => {
  const checked = [
    ['recorded input', (r) => { r.fixtures[0].input.adapter = 'ruby-rails'; }, /input_sha256/],
    ['failures under exit code 0', (r) => { r.commands[0].result.fail = 1; }, /exit_code 0 contradicts/],
    ['per-file test count', (r) => { r.tests[0].test_count += 1; }, /direct-tap tests/],
    ['runner file count', (r) => { r.commands[0].runner_files = 5; }, /runner_files/],
    ['base commit', (r) => { r.base_commit = 'abc123'; }, /40-hex commit/],
    ['negative without a counterexample', (r) => { delete r.fixtures.find((f) => f.class === 'negative').counterexample; }, /counterexample/],
    ['limit that reads as supported', (r) => { r.limits[0].status = 'SUPPORTED'; }, /limits \(id status\): unexpected no-next-contract-emission SUPPORTED/],
    ['fixtures removed, one normal and one negative kept', (r) => { r.fixtures = [r.fixtures[0], r.fixtures.at(-1)]; }, /fixtures \(id api class\): missing scan-ruby-rails/],
    ['a normal fixture re-classed', (r) => { r.fixtures[0].class = 'negative'; }, /missing scan-java-spring scan normal/],
    ['one of the five fixture trees kept', (r) => { r.inputs.splice(1); }, /inputs ids: missing ruby-rails, python-fastapi, typescript-express, javascript-express/],
    ['a file dropped from a fixture tree', (r) => { r.inputs[0].files.pop(); }, /java-spring must pin exactly 37 files/],
    ['artifact_digest without its covers text', (r) => { delete r.artifact_digest.covers; }, /artifact_digest keys: missing covers/]
  ];
  // One generated negative per exactness check: every list loses or repeats its first item, every object loses its last key or gains one.
  const lists = 'sources tests scanner_files inputs inputs.4.files commands fixtures limits limits.0.fixtures ci_observations ci_observations.0.jobs verification.not_recomputed'.split(' ');
  const objects = ['', 'environment', 'environment.package_lock', 'sources.0', 'tests.0', 'scanner_files.0', 'inputs.0', 'inputs.0.files.0', 'commands.0', 'commands.0.runner_script', 'commands.1', 'fixtures.0', 'fixtures.10', 'limits.0', 'limits.5', 'ci_observations.0', 'ci_observations.0.jobs.0', 'verification'];
  const family = /: (?:missing|unexpected|repeated) |must pin exactly|must hold exactly|must be exactly/;
  const sweep = [
    ...lists.flatMap((p) => [[`${p} minus its first item`, (r) => at(r, p).shift(), family], [`${p} with its first item repeated`, (r) => at(r, p).push(structuredClone(at(r, p)[0])), family]]),
    ...objects.flatMap((p) => [[`${p || 'record'} minus its last key`, (r) => { const o = at(r, p); delete o[Object.keys(o).at(-1)]; }, / keys: missing /], [`${p || 'record'} plus a key`, (r) => { at(r, p).extra = 1; }, / keys: unexpected extra/]])
  ];
  const paths = 'title base_commit_note environment.node artifact_digest.covers ci_observations.0.conclusion verification.not_recomputed.0 fixtures.3.output_sha256 fixtures.0.class fixtures.0.origin limits.0.statement limits.0.fixtures.0'.split(' ');
  const prose = [
    ...paths.map((p) => [p, (r) => { at(r, p.replace(/\.?[^.]+$/, ''))[p.split('.').at(-1)] += ' (edited)'; }]),
    ...record.limits.flatMap((l, i) => ['UNSUPPORTED', 'UNKNOWN', 'BLOCKED', 'NOT_RECORDED'].filter((s) => s !== l.status).map((s) => [`${l.id} -> ${s}`, (r) => { r.limits[i].status = s; }]))
  ];
  assert.deepEqual(lib.verifyRecord(reseal(() => {})), [], 're-sealing an untouched record changes nothing');
  for (const [name, edit, pattern] of [...checked, ...sweep]) assert.match(lib.verifyRecord(reseal(edit)).join('\n'), pattern, `${name}, re-sealed`);
  for (const [name, edit] of [...checked, ...prose, ...sweep]) assert.match(lib.verifyRecord(copy(edit)).join('\n'), /artifact_digest/, `${name}, not re-sealed`);
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
  assert.match(lib.replayProblems(record, same.slice(0, 2)).join('\n'), /replayed fixture ids: missing/);
  assert.match(lib.replayProblems({ ...record, fixtures: record.fixtures.slice(0, 2) }, same.slice(0, 2)).join('\n'), /replayed fixture ids: missing/, 'a record that lost fixtures replays only the survivors, which is not enough');
});

test('T11-01 negative: a re-sealed record with an invented base commit and tree fails in a shallow checkout although every live hash matches', (t) => inScratch('forged', async (dir) => {
  // The checkout is built from the real pinned commit, which has to be available here (fetched when absent, a failure otherwise).
  if (!pinnedAvailable(t)) return;
  const checkout = lib.forgedCheckout(dir);
  const forged = lib.readRecord(checkout);
  assert.deepEqual(lib.verifyRecord(forged), [], 'the forgery is well-formed and sealed, so only the pinned commit can refuse it');
  assert.equal(lib.isShallow(checkout), true);
  assert.notEqual(forged.base_commit, record.base_commit, 'the record names a commit that exists nowhere');
  assert.equal(lib.hasCommit(checkout, forged.base_commit), false);
  const state = lib.classifyLive(forged, checkout);
  assert.deepEqual([state.corrupt, state.moved], [[], []], 'every live hash matches the forged record, so the cases below run on any working tree and cannot be skipped');
  assert.equal(state.fresh, true);
  const refused = await lib.runPinnedCheck(checkout);
  assert.notEqual(refused.exit_code, 0);
  assert.match(refused.stdout, /pinned commit unavailable/);
  const allowed = await lib.runPinnedCheck(checkout, { BASELINE_ALLOW_UNVERIFIED: '1' });
  assert.equal(allowed.exit_code, 0);
  assert.match(allowed.stdout, /pinned-commit checks were NOT run/);
}));

test('T11-01 negative: a pin edited together with its file and re-sealed passes on the live files alone and is refused by the pinned commit', (t) => inScratch('pins', async (dir) => {
  if (!pinnedAvailable(t)) return;
  // Two exports of the pinned commit: `pristine` stands for the commit's blobs, `edited` for a live tree whose file was changed.
  const [pristine, edited] = ['pristine', 'edited'].map((name) => { const d = path.join(dir, name); fs.mkdirSync(d); lib.exportCommit(REPO_ROOT, record.base_commit, d); return d; });
  const kinds = [
    ['T11 source', (r) => r.sources[0]],
    ['test file', (r) => r.tests[0]],
    ['scanner file', (r) => r.scanner_files[0]],
    ['fixture file', (r) => r.inputs[0].files[0]],
    ['runner script', (r) => r.commands[0].runner_script],
    ['lock file', (r) => r.environment.package_lock]
  ];
  const genuine = lib.pinProblems(record, { live: lib.classifyLive(record, pristine), liveRead: lib.liveReader(pristine), pinnedRead: lib.liveReader(pristine) });
  assert.deepEqual(genuine, { problems: [], compared: ['live files', 'pinned commit blobs'] }, 'the genuine record passes both comparisons');
  for (const [kind, pick] of kinds) {
    const rel = pick(record).path;
    const original = fs.readFileSync(path.join(edited, rel));
    fs.appendFileSync(path.join(edited, rel), '\n');
    try {
      const forged = reseal((r) => Object.assign(pick(r), lib.digestsOf(fs.readFileSync(path.join(edited, rel)))));
      const state = lib.classifyLive(forged, edited);
      assert.equal(state.fresh, true, `${kind}: the edited pin and the edited file agree, so the live tree looks fresh`);
      assert.deepEqual(lib.verifyRecord(forged), [], `${kind}: the forged record is well-formed and sealed`);
      assert.deepEqual(lib.verifyRecord(forged, lib.liveReader(edited), 'live'), [], `${kind}: the live files alone accept it`);
      const { problems, compared } = lib.pinProblems(forged, { live: state, liveRead: lib.liveReader(edited), pinnedRead: lib.liveReader(pristine) });
      assert.deepEqual(compared, ['live files', 'pinned commit blobs'], kind);
      assert.deepEqual(problems.filter((p) => p.startsWith('live:')), [], `${kind}: nothing is wrong with the live files`);
      assert.ok(problems.some((p) => p.startsWith(`pinned commit: ${rel} sha256 `)), `${kind}: the pinned commit refuses the pin of ${rel}: ${problems.join(' | ')}`);
    } finally {
      fs.writeFileSync(path.join(edited, rel), original);
    }
  }
  // Which comparisons run: a moved pin ends the comparison with the live files, a missing commit ends the one with its blobs.
  const idle = { live: { pinsMoved: [] }, liveRead: () => null, pinnedRead: null };
  assert.deepEqual(lib.pinProblems({}, { ...idle, live: { pinsMoved: ['x'] } }), { problems: [], compared: [] });
  assert.deepEqual(lib.pinProblems({}, { ...idle, live: { pinsMoved: ['x'] }, pinnedRead: () => null }).compared, ['pinned commit blobs']);
  assert.deepEqual(lib.pinProblems({}, idle).compared, ['live files']);
}));

test('T11-01 the live replay stops for a moved pin, a scanner adapter or a fixture file, and ignores unpinned T11 sources and tests that no module imports', (t) => inScratch('replay', async (dir) => {
  if (!pinnedAvailable(t)) return;
  lib.extractTree(REPO_ROOT, record.base_commit, dir);
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const clean = lib.classifyLive(record, dir);
  assert.deepEqual([clean.moved, clean.replayMoved, clean.fresh], [[], [], true], 'the pinned commit itself');
  // Files like the ones other tracks add beside the baseline: a replay on this tree is the live replay of the main branch.
  const beside = ['adapters/http-legacy-next/python-fastapi/other.mjs', 'adapters/http-legacy-next/scope/other.json', 'test/http-legacy-next/fixtures/target-scope/other.json', 'test/http-legacy-next/other.test.mjs'];
  for (const rel of beside) put(rel, 'export const unpinned = true;\n');
  const ignored = lib.classifyLive(record, dir);
  assert.deepEqual(ignored.unpinned, { source: beside.slice(0, 2), scanner: [], tests: beside.slice(2), fixtures: [] });
  assert.deepEqual([ignored.moved.length, ignored.replayMoved, ignored.fresh], [4, [], false], 'the tree moved, the replay inputs did not');
  assert.deepEqual(lib.importProblems(record, lib.liveReader(dir)), []);
  assert.deepEqual(await replayOf(dir), [], 'unpinned T11 sources and tests change no recorded output');
  const stops = (rel, text, where) => {
    put(rel, text);
    const state = lib.classifyLive(record, dir);
    assert.deepEqual(state.replayMoved, [rel], where);
    return state;
  };
  stops('scanners/adapters/another-adapter.mjs', 'export const id = "another";\n', 'a scanner adapter the registry would load');
  fs.rmSync(path.join(dir, 'scanners/adapters/another-adapter.mjs'));
  const fixture = `${record.inputs[0].dir}/src/main/java/extra/Extra.java`;
  stops(fixture, 'package extra;\npublic class Extra {}\n', 'a file inside a fixture tree');
  assert.notDeepEqual(await replayOf(dir), [], 'a file in a fixture tree does change the replay, so it must stop it');
  fs.rmSync(path.join(dir, fixture));
  const module = record.sources[0].path;
  fs.appendFileSync(path.join(dir, module), '\n');
  const moved = lib.classifyLive(record, dir);
  assert.deepEqual([moved.pinsMoved, moved.replayMoved], [[module], [module]], 'a pinned module that changed');
}));

test('T11-01 negative: the live replay is only sound while the pinned modules load nothing but each other and node: built-ins', () => {
  const [first, second] = record.sources.map((s) => s.path);
  // The first module is replaced by `text` (or made unreadable by null); every other module is an import-free stand-in.
  const check = (text) => lib.importProblems(record, (rel) => (rel !== first ? Buffer.from('export const unrelated = 1;\n') : text === null ? null : Buffer.from(text)));
  assert.deepEqual(lib.importProblems(record, lib.liveReader(REPO_ROOT)), [], 'the six modules as they are');
  assert.deepEqual(check(`import fs from 'node:fs';\nimport { x } from './${path.posix.basename(second)}';\nexport * from './${path.posix.basename(second)}';`), []);
  for (const [text, pattern] of [
    ["import x from './python-fastapi/adapter.mjs';", /imports \.\/python-fastapi\/adapter\.mjs, which is neither a pinned T11 module nor a node: built-in/],
    ["export * from '../../scanners/index.mjs';", /imports \.\.\/\.\.\/scanners\/index\.mjs, which is neither/],
    ["import left from 'left-pad';", /imports left-pad, which is neither/],
    ["import fs from 'fs';", /imports fs, which is neither/],
    ["import './not-a-module.mjs';", /imports \.\/not-a-module\.mjs, which is neither/],
    ['const m = await import(name);', /loads a module that cannot be listed \(import\(\)/],
    ["const r = require('./x.cjs');", /loads a module that cannot be listed \(require\(\)/],
    [null, /imports: cannot read /]
  ]) assert.match(check(text).join('\n'), pattern, String(text));
});

test('T11-01 negative: a depth-1 checkout fetches the pinned commit, and an unfetchable one fails unless explicitly allowed', () => inScratch('depth1', (dir) => {
  const { checkout, record: small } = lib.depthOneCase(dir);
  assert.equal(lib.isShallow(checkout), true);
  const { moved, corrupt } = lib.classifyLive(small, checkout, []);
  assert.deepEqual([moved, corrupt], [['src/a.mjs', 'scan/new.mjs'], []], 'a changed source and a new scanner file both mean the tree moved on');
  assert.deepEqual(lib.commitVerdict(checkout, small.base_commit), { verdict: 'ok', via: 'fetch' });
  assert.deepEqual(lib.recomputeProblems(lib.pinnedEntries(small), lib.commitReader(checkout, small.base_commit), 'pinned'), []);
  const absent = '0'.repeat(40);
  assert.equal(lib.commitVerdict(checkout, absent, {}).verdict, 'fail');
  assert.match(lib.commitVerdict(checkout, absent, {}).message, /BASELINE_ALLOW_UNVERIFIED=1/);
  assert.equal(lib.commitVerdict(checkout, absent, { BASELINE_ALLOW_UNVERIFIED: '1' }).verdict, 'unverified');
  assert.equal(lib.commitVerdict(dir, absent, {}).verdict, 'fail', 'not a git work tree');
}));
