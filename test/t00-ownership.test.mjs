// T00-02 ownership map. Every number and every identifier asserted here is recomputed from the code, the plan snapshot, the
// nested runner and the files on disk; nothing is compared with a value typed into this test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SUITES } from '../scripts/run-next-nested-tests.mjs';
import { buildMap, FILES, listT00Tests, loadSources, mapContext, mapCounts, serializeMap, verifyMap } from '../next/t00/build-ownership-map.mjs';
import { OWNERSHIP_CODES } from '../next/t00/check-ownership.mjs';
import { buildReport, CASES, REPORT_FILE, verifyReport } from '../next/t00/make-ownership-report.mjs';
import { checkMap, checkPaths, classifyPath, formatError, MAP_CODES, normalizePath, PATH_CODES, scopesOverlap } from '../next/t00/ownership.mjs';
import { diffReports } from '../next/t00/recorded-runs.mjs';
import { planProblems, serializeSnapshot, snapshotDifferences, snapshotPlan } from '../next/t00/snapshot-plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sources = await loadSources(ROOT);
const map = JSON.parse(read(FILES.map));
const ctx = mapContext(sources);
const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'next/t00/check-ownership.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
const probe = (scope) => (scope.endsWith('/**') ? `${scope.slice(0, -3)}/probe.txt` : scope);
const codes = (errors) => [...new Set(errors.map((e) => e.code))].sort();

test('the committed map is the map its inputs derive, and it passes every check', () => {
  assert.deepEqual(sources.problems, []);
  assert.equal(read(FILES.map), serializeMap(buildMap(sources)));
  assert.deepEqual(verifyMap(map, sources), []);
});

test('the counts of the map equal counts taken from the plan snapshot, the nested runner and the rules file', () => {
  const plan = JSON.parse(read(FILES.plan));
  const ids = [...new Set(plan.tasks.map((t) => t.track))].sort();
  assert.deepEqual(map.tracks.map((t) => t.track), ids);
  assert.equal(plan.source.task_count, plan.tasks.length);
  assert.equal(map.inputs.plan_write_scopes.task_count, plan.tasks.length);
  assert.equal(map.inputs.nested_suites.suite_count, SUITES.length);
  assert.deepEqual(map.tracks.filter((t) => t.suite_scopes.length > 0).map((t) => t.track), SUITES.map((s) => s.id).sort());
  assert.equal(map.reserved_hot_paths.length, JSON.parse(read(FILES.rules)).reserved_hot_paths.length);
  const scopes = map.tracks.flatMap((t) => [...t.plan_scopes, ...t.suite_scopes, ...t.extra_scopes]);
  assert.deepEqual(mapCounts(map), { tracks: ids.length, scopes: scopes.length, reserved: map.reserved_hot_paths.length });
  assert.deepEqual(map.tracks.find((t) => t.track === 'T00').extra_scopes, listT00Tests(ROOT).tests);
});

test('every scope is owned by its own track alone, and every nested-runner directory lies in the scope of its suite', () => {
  for (const t of map.tracks) {
    for (const scope of [...t.plan_scopes, ...t.suite_scopes, ...t.extra_scopes]) {
      const c = classifyPath(map, t.repository, probe(scope));
      assert.deepEqual([c.status, c.tracks], ['track', [t.track]], `${t.track} ${scope}`);
    }
  }
  for (const s of sources.suites) {
    for (const dir of [...s.source_paths, ...s.test_dirs]) assert.deepEqual(classifyPath(map, 'bskel', `${dir}/probe.txt`).tracks, [s.id], `${s.id} ${dir}`);
  }
  for (const h of map.reserved_hot_paths.filter((r) => r.repository === 'bskel')) assert.equal(classifyPath(map, 'bskel', probe(h.path)).status, 'hot', h.path);
});

test('the checker CLI accepts the map and the T00 files of this checkout and refuses a reserved or foreign file', () => {
  const ok = cli('map');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, new RegExp(`^OK ownership map verified: ${map.tracks.length} tracks, ${mapCounts(map).scopes} scopes, ${map.reserved_hot_paths.length} reserved paths`));
  const own = fs.readdirSync(path.join(ROOT, 'next/t00'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)));
  assert.equal(cli('paths', '--track', 'T00', ...own, ...map.tracks.find((t) => t.track === 'T00').extra_scopes).status, 0);
  const bad = cli('paths', '--track', 'T00', 'package.json', 'contracts/next/a.json');
  assert.equal(bad.status, 2);
  assert.deepEqual(bad.stdout.split('\n').filter(Boolean).map((l) => l.split(' ')[1]), ['PATH_RESERVED_HOT', 'PATH_OWNED_BY_OTHER_TRACK']);
});

test('each map check fires on a map broken in the way it is named for, and together they cover MAP_CODES', () => {
  const t = (id) => (m) => m.tracks.find((x) => x.track === id);
  const table = {
    MAP_SCHEMA: (m) => { m.schema = 'other'; },
    DUPLICATE_TRACK: (m) => m.tracks.push(structuredClone(t('T05')(m))),
    INVALID_SCOPE: (m) => t('T05')(m).plan_scopes.push('a/*/b/**'),
    SCOPE_COLLISION: (m) => t('T05')(m).plan_scopes.push('contracts/next/**'),
    HOT_PATH_CLAIMED: (m) => t('T05')(m).plan_scopes.push('README.md'),
    PLAN_SCOPE_MISMATCH: (m) => t('T05')(m).plan_scopes.pop(),
    SUITE_UNKNOWN_TRACK: (m) => { m.tracks = m.tracks.filter((x) => x.track !== 'T05'); },
    SUITE_SCOPE_MISSING: (m) => { t('T05')(m).suite_scopes = []; },
  };
  for (const [code, mutate] of Object.entries(table)) {
    const broken = structuredClone(map);
    mutate(broken);
    assert.ok(codes(checkMap(broken, ctx)).includes(code), code);
  }
  assert.deepEqual(codes(checkMap(map, { ...ctx, pathExists: () => false })), ['HOT_PATH_MISSING']);
  assert.deepEqual([...Object.keys(table), 'HOT_PATH_MISSING'].sort(), [...MAP_CODES].sort());
  assert.deepEqual(checkMap(map, ctx), []);
  assert.equal(scopesOverlap('Scanners/Language/**', 'scanners/language/jvm/**'), true);
  assert.equal(scopesOverlap('docs/A.md', 'docs/a.md'), true);
  assert.equal(scopesOverlap('docs/a.md', 'docs/**'), true);
  assert.equal(scopesOverlap('docs/**', 'documents/**'), false);
});

test('each path check fires, a mixed list reports in the order given, and nothing unknown passes', () => {
  const run = (...list) => checkPaths(map, { repository: 'bskel', track: 'T05', paths: list });
  assert.deepEqual(run('scanners/language/jvm/A.mjs', 'test/language-jvm/B.mjs'), []);
  const mixed = run('docs/x.md', 'scanners/language/python/a.py', 'Scanners/Language/JVM/a.mjs', 'package.json', '../x');
  assert.deepEqual(mixed.map((e) => e.code), ['PATH_UNOWNED', 'PATH_OWNED_BY_OTHER_TRACK', 'PATH_CASE_MISMATCH', 'PATH_RESERVED_HOT', 'INVALID_PATH']);
  assert.deepEqual(codes([...mixed, ...checkPaths(map, { repository: 'bskel', track: 'T99', paths: ['a'] })]), [...PATH_CODES].sort());
  assert.deepEqual(checkPaths(map, { repository: 'bskel', track: 'T15', paths: ['next/t15/a.mjs'] }).map((e) => e.code), ['UNKNOWN_TRACK']);
  assert.equal(classifyPath(map, 'becoder', 'next/t15/a.mjs').status, 'track');
  assert.equal(classifyPath(map, 'bskel', 'next/t15/a.mjs').status, 'unowned');
});

test('path spelling: typed backslashes become slashes, git paths keep them as a refusal, dot and absolute forms fail', () => {
  assert.equal(normalizePath('.\\scanners\\language\\jvm\\a.mjs'), 'scanners/language/jvm/a.mjs');
  assert.equal(classifyPath(map, 'bskel', 'scanners\\language\\jvm\\a.mjs').tracks[0], 'T05');
  for (const bad of ['', '/etc/x', 'C:\\x', 'a//b', 'a/./b', 'a/../b', 'a\0b']) assert.throws(() => normalizePath(bad), undefined, JSON.stringify(bad));
  assert.throws(() => normalizePath('root\\file.mjs', { backslash: 'reject' }), /backslash/);
});

test('a file name cannot add a line to the output: control characters are escaped', () => {
  const line = formatError({ code: 'PATH_UNOWNED', subject: 'a\nFAIL FORGED b\r\u007f', detail: 'd' });
  assert.equal(line, 'FAIL PATH_UNOWNED a\\x0aFAIL FORGED b\\x0d\\x7f d');
});

test('the plan snapshot: shape, one-task-per-line round trip, and every kind of change to the backlog is detected', () => {
  const text = read(FILES.plan);
  const snap = JSON.parse(text);
  assert.deepEqual(planProblems(snap), []);
  assert.equal(serializeSnapshot(snap), text);
  const backlog = { schema: 'bskel.scale-backlog/1', tasks: [{ id: 'T01-01', track: 'T01', repository: 'bskel', write_scope: ['next/t01/**'] }, { id: 'T02-01', track: 'T02', repository: 'bskel', write_scope: ['next/t02/**'] }] };
  const fresh = snapshotPlan(Buffer.from(JSON.stringify(backlog)));
  assert.deepEqual(snapshotDifferences(structuredClone(fresh), fresh), []);
  const changes = [
    (s) => { s.tasks[0].write_scope.push('x/**'); },
    (s) => { s.tasks.pop(); },
    (s) => { s.tasks.push({ id: 'T03-01', track: 'T03', repository: 'bskel', write_scope: [] }); },
    (s) => { s.source.sha256 = '0'.repeat(64); },
  ];
  for (const change of changes) {
    const edited = structuredClone(fresh);
    change(edited);
    assert.notDeepEqual(snapshotDifferences(edited, fresh), []);
  }
  assert.throws(() => snapshotPlan(Buffer.from('{"schema":"bskel.scale-backlog/1","tasks":[{"id":"T01-01"}]}')), /lacks a string id/);
  assert.match(planProblems({ ...fresh, tasks: [{ ...fresh.tasks[0], write_scope: ['a/*/b'] }, fresh.tasks[1]] })[0], /write scope/);
});

test('the recorded runs equal a fresh recording of the real CLI, and they exercise every code and every exit code', async () => {
  const committed = JSON.parse(read(path.relative(ROOT, REPORT_FILE)));
  assert.deepEqual(verifyReport(committed, await buildReport()), []);
  assert.deepEqual([...new Set(committed.cases.flatMap((c) => c.codes))].sort(), [...OWNERSHIP_CODES].sort());
  assert.deepEqual([...new Set(committed.cases.map((c) => c.exit_code))].sort(), [0, 1, 2]);
  assert.equal(committed.cases.length, CASES.length);
  for (const c of committed.cases.filter((x) => x.exit_code === 1)) assert.notEqual(c.stderr_head, '', `${c.id} must name its failure`);
});

test('a report that differs from the recomputation in any member, extra or missing, is reported', () => {
  const fresh = { schema: 's', inputs: { a: 1 }, cases: [{ id: 'c', exit_code: 0, codes: [] }] };
  assert.deepEqual(diffReports(structuredClone(fresh), fresh), []);
  for (const edit of [(r) => { r.inputs.a = 2; }, (r) => { r.extra = 1; }, (r) => { delete r.schema; }, (r) => { r.cases[0].extra = 1; }, (r) => { delete r.cases[0].codes; }, (r) => { r.cases.push({}); }]) {
    const edited = structuredClone(fresh);
    edit(edited);
    assert.notDeepEqual(diffReports(edited, fresh), []);
  }
  assert.deepEqual(diffReports([], fresh), ['the report is not an object']);
});

test('the RFC and the README name every file and every code of this track, and the RFC stays short', () => {
  const rfc = read('next/t00/INTERFACE_RFC.md');
  const readme = read('next/t00/README.md');
  assert.ok(rfc.trimEnd().split('\n').length <= 120, `INTERFACE_RFC.md has ${rfc.trimEnd().split('\n').length} lines`);
  const rows = [...rfc.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...rows].sort(), [...OWNERSHIP_CODES, 'PLAN_SNAPSHOT_STALE'].sort());
  for (const h of map.reserved_hot_paths) assert.ok(rfc.includes(`\`${h.path}\``), `the RFC lists ${h.repository} ${h.path}`);
  const owned = fs.readdirSync(path.join(ROOT, 'next/t00'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(path.join(ROOT, 'next/t00'), path.join(e.parentPath, e.name)));
  for (const file of ['ownership.mjs', 'snapshot-plan.mjs', 'build-ownership-map.mjs', 'check-ownership.mjs', 'recorded-runs.mjs', 'make-ownership-report.mjs', 'ownership-map.json', 'ownership-report.json', 'fixtures/plan-write-scopes.json', 'fixtures/ownership-rules.json', 'INTERFACE_RFC.md']) {
    assert.ok(owned.includes(file), `${file} exists`);
    assert.ok(readme.includes(`\`${file}\``), `the README names ${file}`);
  }
});
