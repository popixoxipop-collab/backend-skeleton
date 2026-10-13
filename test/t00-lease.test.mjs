// T00-03: the lease model, the lease gate and its recorded runs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LEASE_CODES, LEDGER_CODES, LEDGER_SCHEMA, RESULT_CODES, checkLedger, checkResult, leasePolicy, parseInstant, scopeWithin } from '../next/t00/lease-ledger.mjs';
import { AT, CASES, FIXTURE_FILE, REPORT_FILE, buildReport, verifyReport } from '../next/t00/make-lease-report.mjs';
import { baseModel, twoCommits, writeScaffold } from '../next/t00/make-ownership-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MAP = JSON.parse(read('next/t00/ownership-map.json'));
const POLICY = leasePolicy(MAP);
const fixture = () => JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
const codes = (errors) => [...new Set(errors.map((e) => e.code))].sort();
const BASE = 'ed10b06106dd72ea4e1dac7f784827a29f9c3f90';
const HEAD = '87bcb488dc702484e7c85317b33dd7838cb0e5ab';
const ENV = { PATH: process.env.PATH ?? '' };
const lease = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'next/t00/check-lease.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', env: ENV });
const packet = (over = {}) => ({ claim_id: 'T00-0002', fencing_token: 2, base_sha: BASE, head_sha: HEAD, paths: ['next/t00/a.mjs'], ...over });
const resultArgs = (ledger, claimBase, ...rest) => ['result', '--ledger', ledger, '--at', AT, '--claim', 'T00-0002', '--token', '2', '--base', claimBase, ...rest];
const withTmp = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't00-lease-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('parseInstant accepts a strict UTC instant that exists and nothing else', () => {
  assert.equal(parseInstant('2026-10-09T00:00:00Z'), Date.UTC(2026, 9, 9));
  assert.ok(!Number.isNaN(parseInstant('2028-02-29T23:59:59Z')));
  for (const bad of ['2027-02-29T00:00:00Z', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-09T24:00:00Z', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00+00:00', '2026-10-09 00:00:00Z', '', null, undefined, 5, {}]) {
    assert.ok(Number.isNaN(parseInstant(bad)), String(bad));
  }
});

test('scopeWithin: directories contain, a file never contains a directory, case counts', () => {
  const yes = [['a/b/**', 'a/**'], ['a/**', 'a/**'], ['a/b', 'a/**'], ['a/b', 'a/b']];
  const no = [['a', 'a/**'], ['a/**', 'a'], ['a/b', 'a/c'], ['A/b', 'a/**'], ['a/**', 'a/b/**'], ['a/*', 'a/**'], ['', 'a'], [undefined, 'a/**'], ['a/**', null]];
  for (const [inner, outer] of yes) assert.equal(scopeWithin(inner, outer), true, `${inner} in ${outer}`);
  for (const [inner, outer] of no) assert.equal(scopeWithin(inner, outer), false, `${inner} in ${outer}`);
});

test('the policy is the verified ownership map: one entry per track, every scope of the track', () => {
  assert.equal(Object.keys(POLICY).length, MAP.tracks.length);
  for (const t of MAP.tracks) {
    assert.equal(POLICY[t.track].repository, t.repository);
    assert.deepEqual(POLICY[t.track].scopes, [...t.plan_scopes, ...t.suite_scopes, ...t.extra_scopes]);
  }
  assert.deepEqual(leasePolicy(null), {});
  assert.deepEqual(leasePolicy({ tracks: [null, { track: 'x' }, { track: 'T01', repository: 'bskel', plan_scopes: 'no' }] }), { T01: { repository: 'bskel', scopes: [] } });
});

test('the normal fixture is valid, the same input gives the same errors, a bad instant is an error', () => {
  const f = fixture();
  assert.deepEqual(checkLedger(f, POLICY, AT), []);
  assert.deepEqual(checkLedger(f, POLICY, '2026-10-09T02:30:00Z'), checkLedger(f, POLICY, '2026-10-09T02:30:00Z'));
  for (const bad of ['tomorrow', '', null, undefined, 1760000000000]) {
    assert.deepEqual(codes(checkLedger(f, POLICY, bad)), ['INVALID_LEASE_TIME']);
    assert.deepEqual(codes(checkResult(f, packet(), bad)), ['INVALID_LEASE_TIME']);
  }
});

test('a lease is half-open: live at issued_at, over at expires_at; currency false drops only those two codes', () => {
  const f = fixture();
  assert.deepEqual(checkLedger(f, POLICY, '2026-10-09T00:30:00Z'), []);
  assert.deepEqual(codes(checkLedger(f, POLICY, '2026-10-09T02:00:00Z')), ['LEASE_EXPIRED']);
  assert.deepEqual(codes(checkLedger(f, POLICY, '2026-10-09T00:29:59Z')), ['LEASE_NOT_STARTED']);
  assert.deepEqual(checkLedger(f, POLICY, '2026-10-09T02:00:00Z', { currency: false }), []);
  f.claims[1].path_scopes = [];
  assert.deepEqual(codes(checkLedger(f, POLICY, '2026-10-09T02:00:00Z', { currency: false })), ['MISSING_PATH_SCOPES']);
});

test('scopes conflict only between live ACTIVE claims of one repository; case is ignored', () => {
  const policy = { T01: { repository: 'bskel', scopes: ['a/**'] }, T02: { repository: 'becoder', scopes: ['a/**'] }, T03: { repository: 'bskel', scopes: ['A/**'] } };
  const claim = (id, track, state = 'ACTIVE', scope = 'a/**') => ({ claim_id: id, track, repository: policy[track].repository, worker: 'w', worktree: 'wt', base_sha: BASE, path_scopes: [scope], issued_at: '2026-10-09T00:00:00Z', expires_at: '2026-10-09T02:00:00Z', fencing_token: Number(id.slice(1)), state });
  const ledger = (...claims) => ({ schema: LEDGER_SCHEMA, counters: { T01: 9, T02: 9, T03: 9 }, claims });
  assert.deepEqual(checkLedger(ledger(claim('c1', 'T01'), claim('c2', 'T02')), policy, AT), []);
  assert.deepEqual(checkLedger(ledger(claim('c1', 'T01'), claim('c2', 'T01', 'RELEASED')), policy, AT), []);
  assert.deepEqual(codes(checkLedger(ledger(claim('c1', 'T01'), claim('c2', 'T01')), policy, AT)), ['ACTIVE_SCOPE_CONFLICT']);
  assert.deepEqual(codes(checkLedger(ledger(claim('c1', 'T01'), claim('c2', 'T03', 'ACTIVE', 'A/**')), policy, AT)), ['ACTIVE_SCOPE_CONFLICT']);
});

test('fencing tokens rise in ledger order per track and the counter may stand above the highest token', () => {
  const f = fixture();
  f.counters.T00 = 9;
  assert.deepEqual(checkLedger(f, POLICY, AT), []);
  f.claims.unshift(f.claims.splice(1, 1)[0]);
  assert.deepEqual(codes(checkLedger(f, POLICY, AT)), ['FENCING_TOKEN_REGRESSION']);
  f.counters.T00 = 1;
  assert.deepEqual(codes(checkLedger(f, POLICY, AT)), ['FENCING_TOKEN_REGRESSION', 'LEDGER_COUNTER_BEHIND_CLAIM']);
});

test('the model reports junk instead of throwing', () => {
  const ok = { schema: LEDGER_SCHEMA, counters: {}, claims: [] };
  const ledgers = [null, undefined, 0, 'x', [], {}, { schema: LEDGER_SCHEMA }, { ...ok, claims: [null, 1, 'a', [], {}, { claim_id: 'a', track: '__proto__', path_scopes: [1, null, {}] }] }, { ...ok, counters: { T00: 'x', __proto__x: 1 } }];
  for (const l of ledgers) {
    assert.doesNotThrow(() => checkLedger(l, POLICY, AT));
    assert.ok(checkLedger(l, POLICY, AT).length > 0 || l === ledgers[0] === false);
    for (const p of [null, undefined, {}, packet({ paths: 'x' }), packet({ paths: [null, 5, {}] })]) assert.doesNotThrow(() => checkResult(l, p, AT));
  }
  assert.ok(ledgers.slice(0, 8).every((l) => checkLedger(l, POLICY, AT).length > 0));
});

test('a result is judged path by path: ./ is stripped, NUL, empty, traversal and backslash are refused', () => {
  const f = fixture();
  assert.deepEqual(checkResult(f, packet({ paths: ['./next/t00/a.mjs'] }), AT), []);
  const errors = checkResult(f, packet({ paths: ['next/t00/a.mjs', 'package.json', '../x', 'next/t00/b\0c', '', 'next\\t00\\a.mjs'] }), AT);
  assert.deepEqual(codes(errors), ['INVALID_RESULT_PATH', 'RESULT_PATH_OUTSIDE_CLAIM']);
  assert.equal(errors.filter((e) => e.code === 'INVALID_RESULT_PATH').length, 4);
  assert.deepEqual(errors.filter((e) => e.code === 'RESULT_PATH_OUTSIDE_CLAIM').map((e) => e.subject), ['package.json']);
  assert.deepEqual(codes(checkResult(f, packet({ paths: [] }), AT)), ['INVALID_RESULT_PATH']);
  f.claims.push({ ...f.claims[1] });
  assert.deepEqual(codes(checkResult(f, packet(), AT)), ['UNKNOWN_CLAIM']);
});

test('every ledger and result code is raised by a recorded case, and only those', () => {
  assert.equal(new Set(LEASE_CODES).size, LEASE_CODES.length);
  assert.equal(LEDGER_CODES.length + RESULT_CODES.length, LEASE_CODES.length);
  const report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
  assert.deepEqual([...new Set(report.cases.flatMap((x) => x.codes))].sort(), [...LEASE_CODES].sort());
  assert.deepEqual([0, 1, 2].filter((n) => !report.cases.some((x) => x.exit_code === n)), []);
});

test('the gate prints OK or one FAIL line per error and exits 0, 2 or 1', () => {
  const f = fixture();
  const active = f.claims.filter((x) => x.state === 'ACTIVE').length;
  const ok = lease('ledger', '--ledger', FIXTURE_FILE, '--at', AT);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(ok.stdout.startsWith(`OK lease ledger verified at ${AT}: ${f.claims.length} claims, ${active} active (checks: `), ok.stdout);
  const good = lease(...resultArgs(FIXTURE_FILE, BASE, '--head', HEAD, 'next/t00/a.mjs', 'test/t00-baseline.test.mjs'));
  assert.equal(good.status, 0, good.stdout);
  assert.equal(good.stdout, 'OK the result of claim T00-0002 (token 2, 2 paths) stays inside its lease\n');
  const evil = lease(...resultArgs(FIXTURE_FILE, BASE, '--head', HEAD, 'package.json\nFAIL FAKE x y'));
  assert.equal(evil.status, 2);
  const lines = evil.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^FAIL RESULT_PATH_OUTSIDE_CLAIM package\.json\\x0aFAIL FAKE x y inside no path scope of T00-0002$/);
  const usage = lease('ledger', '--ledger', FIXTURE_FILE);
  assert.equal(usage.status, 1);
  assert.equal(usage.stdout, '');
  assert.match(usage.stderr, /^ledger needs --at\n/);
});

test('the gate judges against the ownership map of --repo-dir and refuses a stale map', () => {
  withTmp((dir) => {
    const good = path.join(dir, 'good');
    const stale = path.join(dir, 'stale');
    fs.mkdirSync(good);
    fs.mkdirSync(stale);
    writeScaffold(good, baseModel());
    const m = baseModel();
    m.map.tracks[0].plan_scopes.push('docs/extra/**');
    writeScaffold(stale, m);
    const args = ['ledger', '--ledger', FIXTURE_FILE, '--at', AT];
    assert.equal(lease('--repo-dir', good, ...args).status, 0);
    const bad = lease('--repo-dir', stale, ...args);
    assert.equal(bad.status, 2);
    assert.ok(bad.stdout.includes('FAIL MAP_NOT_DERIVED'), bad.stdout);
    assert.ok(!bad.stdout.includes('OK'), bad.stdout);
  });
});

test('without paths the result is judged on what git reports between base and head', () => {
  const gitOut = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, HOME: repo } }).trim();
  withTmp((dir) => {
    const made = (name, after, before) => {
      const repo = path.join(dir, name);
      fs.mkdirSync(repo);
      writeScaffold(repo, baseModel());
      twoCommits(repo, { after, before });
      const base = gitOut(repo, 'rev-parse', 'HEAD~1');
      const ledger = fixture();
      ledger.claims[1].base_sha = base;
      const file = path.join(dir, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(ledger));
      const run = (to) => lease('--repo-dir', repo, ...resultArgs(file, base, '--head', to));
      return Object.assign(run(gitOut(repo, 'rev-parse', 'HEAD')), { again: () => run(base) });
    };
    const inside = made('inside', (write) => write('next/t00/lease-new.mjs', 'a\n'));
    assert.equal(inside.status, 0, inside.stdout + inside.stderr);
    assert.match(inside.stdout, /\(token 2, 1 paths\)/);
    const outside = made(
      'outside',
      (write, git) => {
        write('package.json', '{}\n');
        write('next/t00/a\\b.mjs', 'x\n');
        git('mv', 'next/t05/x.mjs', 'next/t00/x.mjs');
      },
      (write) => write('next/t05/x.mjs', 'x\n'),
    );
    assert.equal(outside.status, 2, outside.stdout + outside.stderr);
    assert.deepEqual(outside.stdout.split('\n').filter(Boolean).map((l) => l.split(' ').slice(0, 3).join(' ')), [
      'FAIL INVALID_RESULT_PATH next/t00/a\\b.mjs',
      'FAIL RESULT_PATH_OUTSIDE_CLAIM next/t05/x.mjs',
      'FAIL RESULT_PATH_OUTSIDE_CLAIM package.json',
    ]);
    const same = inside.again();
    assert.equal(same.status, 1);
    assert.equal(same.stdout, '');
    assert.match(same.stderr, /is empty, so there is nothing to check/);
  });
  const none = lease(...resultArgs(FIXTURE_FILE, BASE, '--head', 'abc'));
  assert.equal(none.status, 2);
  assert.deepEqual(codes(none.stdout.split('\n').filter(Boolean).map((l) => ({ code: l.split(' ')[1] }))), ['INVALID_RESULT_HEAD_SHA', 'INVALID_RESULT_PATH']);
});

test('lease-report.json equals the recomputed report and a changed report is detected', async () => {
  const committed = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
  const fresh = await buildReport();
  assert.deepEqual(verifyReport(committed, fresh), []);
  assert.equal(committed.cases.length, CASES.length);
  assert.ok(verifyReport({ ...committed, extra: 1 }, fresh).length > 0);
  assert.ok(verifyReport({ ...committed, cases: committed.cases.slice(1) }, fresh).length > 0);
  const edited = structuredClone(committed);
  edited.cases[3].exit_code = 0;
  assert.deepEqual(verifyReport(edited, fresh), [`case ${edited.cases[3].id}: exit_code differs from the recomputed value`]);
});

test('the protocol document lists every code once and the readme lists the files of this task', () => {
  const doc = read('next/t00/LEASE_PROTOCOL.md');
  const rows = [...doc.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...rows].sort(), [...LEASE_CODES].sort());
  assert.equal(new Set(rows).size, rows.length);
  const readme = read('next/t00/README.md');
  for (const f of ['lease-ledger.mjs', 'check-lease.mjs', 'make-lease-report.mjs', 'lease-report.json', 'fixtures/lease-ledger.json', 'LEASE_PROTOCOL.md']) {
    assert.ok(readme.split('\n').some((l) => l.startsWith('| `') && l.includes(`\`${f}\``)), `${f} is not a row of the readme`);
    assert.ok(fs.existsSync(path.join(ROOT, 'next/t00', f)), `${f} does not exist`);
  }
});
