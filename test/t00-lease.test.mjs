// T00-03: the lease model, the lease gate, the seal tool, the mutation check and their recorded runs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLAIM_FIELDS, GENESIS_DIGEST, LEASE_CODES, LEDGER_CODES, LEDGER_SCHEMA, RESULT_CODES, checkLedger, checkResult, leasePolicy, parseInstant, scopeWithin, sealLedger } from '../next/t00/lease-ledger.mjs';
import { MUTANTS, runMutants } from '../next/t00/lease-mutants.mjs';
import { AT, CASES, FIXTURE_FILE, REPORT_FILE, buildReport, verifyReport } from '../next/t00/make-lease-report.mjs';
import { baseModel, twoCommits, writeScaffold } from '../next/t00/make-ownership-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MAP = JSON.parse(read('next/t00/ownership-map.json'));
const POLICY = leasePolicy(MAP);
const fixture = () => JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
// The digests are part of every ledger, so a test that edits a ledger on purpose seals it again before it asks the model.
const reseal = (ledger) => {
  const sealed = sealLedger(ledger);
  assert.equal(sealed.problem, undefined, sealed.problem);
  return sealed.ledger;
};
const codes = (errors) => [...new Set(errors.map((e) => e.code))].sort();
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const BASE = 'ed10b06106dd72ea4e1dac7f784827a29f9c3f90';
const HEAD = '87bcb488dc702484e7c85317b33dd7838cb0e5ab';
// The child processes get PATH and the temporary-directory variables, nothing else of this environment: a child that makes a temporary
// directory (the mutation check does) then makes it where this process looks for what it left behind.
const ENV = { PATH: process.env.PATH ?? '', ...Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])) };
const run = (script, args) => spawnSync(process.execPath, [path.join(ROOT, 'next/t00', script), ...args], { cwd: ROOT, encoding: 'utf8', env: ENV });
const lease = (...args) => run('check-lease.mjs', args);
const seal = (...args) => run('seal-lease-ledger.mjs', args);
const lines = (result) => result.stdout.split('\n').filter(Boolean);
const HOLDER = { worker: 'wp-t00', worktree: 'agents/t00' };
const packet = (over = {}) => ({ claim_id: 'T00-0002', ...HOLDER, fencing_token: 2, base_sha: BASE, head_sha: HEAD, paths: ['next/t00/a.mjs'], ...over });
const resultArgs = (ledger, claimBase, ...rest) => ['result', '--ledger', ledger, '--at', AT, '--claim', 'T00-0002', '--worker', HOLDER.worker, '--worktree', HOLDER.worktree, '--token', '2', '--base', claimBase, ...rest];
const withTmp = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't00-lease-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const writeLedger = (dir, name, ledger) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
  return file;
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
  assert.deepEqual(codes(checkLedger(reseal(f), POLICY, '2026-10-09T02:00:00Z', { currency: false })), ['MISSING_PATH_SCOPES']);
});

test('scopes conflict only between live ACTIVE claims of one repository; case is ignored', () => {
  const policy = { T01: { repository: 'bskel', scopes: ['a/**'] }, T02: { repository: 'becoder', scopes: ['a/**'] }, T03: { repository: 'bskel', scopes: ['A/**'] } };
  const claim = (id, track, state = 'ACTIVE', scope = 'a/**') => ({ claim_id: id, track, repository: policy[track].repository, worker: 'w', worktree: 'wt', base_sha: BASE, path_scopes: [scope], issued_at: '2026-10-09T00:00:00Z', expires_at: '2026-10-09T02:00:00Z', fencing_token: Number(id.slice(1)), state });
  const ledger = (...claims) => reseal({ schema: LEDGER_SCHEMA, counters: { T01: 9, T02: 9, T03: 9 }, claims });
  assert.deepEqual(checkLedger(ledger(claim('c1', 'T01'), claim('c2', 'T02')), policy, AT), []);
  assert.deepEqual(checkLedger(ledger(claim('c1', 'T01'), claim('c2', 'T01', 'RELEASED')), policy, AT), []);
  assert.deepEqual(codes(checkLedger(ledger(claim('c1', 'T01'), claim('c2', 'T01')), policy, AT)), ['ACTIVE_SCOPE_CONFLICT']);
  assert.deepEqual(codes(checkLedger(ledger(claim('c1', 'T01'), claim('c2', 'T03', 'ACTIVE', 'A/**')), policy, AT)), ['ACTIVE_SCOPE_CONFLICT']);
});

test('fencing tokens rise in ledger order per track and the counter may stand above the highest token', () => {
  const f = fixture();
  f.counters.T00 = 9;
  assert.deepEqual(checkLedger(reseal(f), POLICY, AT), []);
  f.claims.unshift(f.claims.splice(1, 1)[0]);
  assert.deepEqual(codes(checkLedger(reseal(f), POLICY, AT)), ['FENCING_TOKEN_REGRESSION']);
  f.counters.T00 = 1;
  assert.deepEqual(codes(checkLedger(reseal(f), POLICY, AT)), ['FENCING_TOKEN_REGRESSION', 'LEDGER_COUNTER_BEHIND_CLAIM']);
});

test('a result carries the token of its claim: a lower, higher, malformed or superseded token is refused', () => {
  const f = fixture();
  assert.deepEqual(checkResult(f, packet(), AT), []);
  assert.deepEqual(codes(checkResult(f, packet({ fencing_token: 1 }), AT)), ['RESULT_FENCING_TOKEN_MISMATCH', 'RESULT_STALE_FENCING_TOKEN']);
  assert.deepEqual(codes(checkResult(f, packet({ fencing_token: 3 }), AT)), ['RESULT_FENCING_TOKEN_MISMATCH']);
  for (const bad of ['2', 2.5, NaN, null, undefined]) assert.deepEqual(codes(checkResult(f, packet({ fencing_token: bad }), AT)), ['RESULT_FENCING_TOKEN_MISMATCH'], String(bad));
  f.counters.T00 = 3;
  assert.deepEqual(codes(checkResult(f, packet(), AT)), ['RESULT_STALE_FENCING_TOKEN']);
});

test('a result names the holder of its claim: worker and worktree must both be the ones of the claim', () => {
  const f = fixture();
  const gave = (over) => checkResult(f, packet(over), AT).map((e) => e.code);
  assert.deepEqual(gave({}), []);
  assert.deepEqual(gave({ worker: 'wp-t05' }), ['RESULT_WRONG_HOLDER']);
  assert.deepEqual(gave({ worktree: 'agents/t05' }), ['RESULT_WRONG_HOLDER']);
  assert.deepEqual(gave({ worker: 'wp-t05', worktree: 'agents/t05' }), ['RESULT_WRONG_HOLDER', 'RESULT_WRONG_HOLDER']);
  for (const other of [undefined, null, '', 'WP-T00', ' wp-t00', 'wp-t00 ', 5, ['wp-t00'], {}]) {
    assert.deepEqual(gave({ worker: other }), ['RESULT_WRONG_HOLDER'], `worker ${JSON.stringify(other)}`);
    assert.deepEqual(gave({ worktree: other }), ['RESULT_WRONG_HOLDER'], `worktree ${JSON.stringify(other)}`);
  }
  // The names of another live claim do not help: the claim is judged against its own holder.
  assert.deepEqual(gave({ worker: f.claims[2].worker, worktree: f.claims[2].worktree }), ['RESULT_WRONG_HOLDER', 'RESULT_WRONG_HOLDER']);
  const run1 = lease('result', '--ledger', FIXTURE_FILE, '--at', AT, '--claim', 'T00-0002', '--worker', 'wp-t05', '--worktree', 'agents/t05', '--token', '2', '--base', BASE, '--head', HEAD, 'next/t00/a.mjs');
  assert.equal(run1.status, 2, run1.stdout + run1.stderr);
  assert.deepEqual(lines(run1), [
    'FAIL RESULT_WRONG_HOLDER T00-0002 the result names worker "wp-t05", the lease is held by worker "wp-t00"',
    'FAIL RESULT_WRONG_HOLDER T00-0002 the result names worktree "agents/t05", the lease is held by worktree "agents/t00"',
  ]);
});

test('the model reports junk instead of throwing', () => {
  const ok = { schema: LEDGER_SCHEMA, counters: {}, claims: [] };
  const ledgers = [null, undefined, 0, 'x', [], {}, { schema: LEDGER_SCHEMA }, { ...ok, claims: [null, 1, 'a', [], {}, { claim_id: 'a', track: '__proto__', path_scopes: [1, null, {}] }] }, { ...ok, counters: { T00: 'x', __proto__x: 1 } }];
  for (const l of ledgers) {
    let errors;
    assert.doesNotThrow(() => { errors = checkLedger(l, POLICY, AT); });
    assert.ok(errors.length > 0, `${JSON.stringify(l)} passed`);
    for (const p of [null, undefined, {}, packet({ paths: 'x' }), packet({ paths: [null, 5, {}] })]) assert.doesNotThrow(() => checkResult(l, p, AT));
  }
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
  assert.deepEqual([0, 1, 2, 3].filter((n) => !report.cases.some((x) => x.exit_code === n)), []);
  assert.deepEqual([...new Set(report.cases.map((x) => x.exit_code))].sort(), [0, 1, 2, 3]);
  // Exit code 3 is the one for another ledger version, and that error never travels with another one.
  for (const x of report.cases) assert.equal(x.exit_code === 3, x.codes.includes('LEDGER_VERSION_UNSUPPORTED'), x.id);
  for (const x of report.cases.filter((c) => c.exit_code === 3)) assert.deepEqual(x.codes, ['LEDGER_VERSION_UNSUPPORTED'], x.id);
});

test('every recorded case holds its command, its exit code and the hash of its output, and no local path', () => {
  const report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
  assert.equal(new Set(report.cases.map((x) => x.id)).size, report.cases.length);
  assert.deepEqual(report.cases.filter((x) => !/^node next\/t00\/check-lease\.mjs (ledger|result) /.test(x.command)).map((x) => x.id), ['usage-unknown-command']);
  for (const x of report.cases) {
    assert.match(x.command, /^node next\/t00\/check-lease\.mjs [a-z]+ /, x.id);
    assert.ok(Number.isInteger(x.exit_code) && x.exit_code >= 0 && x.exit_code <= 3, x.id);
    assert.match(x.stdout_sha256, /^[0-9a-f]{64}$/, x.id);
    assert.equal(typeof x.stderr_head, 'string', x.id);
  }
  const text = fs.readFileSync(REPORT_FILE, 'utf8');
  // The two home-like prefixes are built from pieces so that this file does not itself hold the text it forbids.
  for (const local of ['/Us' + 'ers/', '/pri' + 'vate/', '/var/folders', '/tmp/', os.tmpdir()]) assert.ok(!text.includes(local), `the report holds the local path ${local}`);
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
  const out = evil.stdout.split('\n').filter(Boolean);
  assert.equal(out.length, 1);
  assert.match(out[0], /^FAIL RESULT_PATH_OUTSIDE_CLAIM package\.json\\x0aFAIL FAKE x y inside no path scope of T00-0002$/);
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
      fs.writeFileSync(file, JSON.stringify(reseal(ledger)));
      const go = (to) => lease('--repo-dir', repo, ...resultArgs(file, base, '--head', to));
      const unknownBase = () => lease('--repo-dir', repo, ...resultArgs(file, '1'.repeat(40), '--head', gitOut(repo, 'rev-parse', 'HEAD')));
      return Object.assign(go(gitOut(repo, 'rev-parse', 'HEAD')), { again: () => go(base), unknownBase });
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
    // A base commit that the checkout does not hold, as in a shallow clone, is no pass and no silent exit: git's own failure is reported.
    const unknown = inside.unknownBase();
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stdout, '');
    assert.match(unknown.stderr, /^git diff 1{40} [0-9a-f]{40} failed in /m);
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

// ---------------------------------------------------------------------------------------------------------------------------------
// Another schema version
// ---------------------------------------------------------------------------------------------------------------------------------

test('a ledger of another schema version gets its own error and exit code 3, and nothing else of it is judged', () => {
  const family = 'bskel.t00-lease-ledger/';
  assert.equal(LEDGER_SCHEMA, `${family}1`);
  const bodies = [fixture(), { entries: 'x', claims: 'not a list', counters: [] }, {}, { claims: [null] }];
  for (const version of ['0', '2', '1.1', '10', '1 ', '01', '', '1/x', '2026']) {
    for (const body of bodies) {
      const errors = checkLedger({ ...body, schema: `${family}${version}` }, POLICY, AT);
      assert.deepEqual(errors.map((e) => e.code), ['LEDGER_VERSION_UNSUPPORTED'], `version ${JSON.stringify(version)}`);
    }
  }
  for (const schema of ['bskel.t00-lease-ledger', 'Bskel.t00-lease-ledger/1', ' bskel.t00-lease-ledger/1', 'bskel.t00-lease-ledgers/1', 'other/1', '', null, 1, ['x'], {}, undefined]) {
    assert.deepEqual(checkLedger({ ...fixture(), schema }, POLICY, AT).map((e) => e.code), ['LEDGER_SCHEMA'], `schema ${JSON.stringify(schema)}`);
  }
  withTmp((dir) => {
    const file = path.join(dir, 'other-version.json');
    fs.writeFileSync(file, JSON.stringify({ schema: `${family}2`, entries: 'x', claims: 'not a list' }));
    const pin = 'a'.repeat(64);
    for (const args of [['ledger', '--ledger', file, '--at', AT], ['ledger', '--ledger', file, '--at', AT, '--head-digest', pin], resultArgs(file, BASE, '--head', HEAD, 'next/t00/a.mjs')]) {
      const result = lease(...args);
      assert.equal(result.status, 3, result.stdout + result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(lines(result), ['FAIL LEDGER_VERSION_UNSUPPORTED ledger schema "bskel.t00-lease-ledger/2" is another version; this gate reads bskel.t00-lease-ledger/1 only and judges nothing else of that ledger']);
    }
    fs.writeFileSync(file, JSON.stringify({ schema: 'other/2', claims: [] }));
    const foreign = lease('ledger', '--ledger', file, '--at', AT);
    assert.equal(foreign.status, 2);
    assert.match(foreign.stdout, /^FAIL LEDGER_SCHEMA ledger expected an object with schema bskel\.t00-lease-ledger\/1/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Tampering: the hash chain, the head digest and the pin
// ---------------------------------------------------------------------------------------------------------------------------------

test('the digests of the fixture follow the documented formula, recomputed here without the model', () => {
  const f = fixture();
  assert.equal(GENESIS_DIGEST, '0'.repeat(64));
  assert.deepEqual(CLAIM_FIELDS, ['claim_id', 'track', 'repository', 'worker', 'worktree', 'base_sha', 'path_scopes', 'issued_at', 'expires_at', 'fencing_token', 'state']);
  let tip = '0'.repeat(64);
  for (const claim of f.claims) {
    assert.equal(claim.prev_digest, tip, claim.claim_id);
    const hashed = {};
    for (const key of [...CLAIM_FIELDS, 'prev_digest']) hashed[key] = claim[key];
    assert.equal(claim.entry_digest, sha256(JSON.stringify(hashed)), claim.claim_id);
    tip = claim.entry_digest;
  }
  const counters = Object.keys(f.counters).sort().map((track) => [track, f.counters[track]]);
  assert.equal(f.head_digest, sha256(JSON.stringify([LEDGER_SCHEMA, f.claims.length, tip, counters])));
  // The order of the members in the file is not part of the digest.
  const shuffled = fixture();
  shuffled.claims = shuffled.claims.map((claim) => Object.fromEntries(Object.entries(claim).reverse()));
  assert.deepEqual(checkLedger(shuffled, POLICY, AT), []);
});

test('editing any one field of a sealed claim breaks the entry digest of that claim and of no other', () => {
  const other = { claim_id: 'T00-0009', track: 'T05', repository: 'becoder', worker: 'wp-other', worktree: 'agents/other', base_sha: 'f'.repeat(40), path_scopes: ['next/t00/**', 'package.json'], issued_at: '2026-10-09T00:00:01Z', expires_at: '2026-10-09T05:00:00Z', fencing_token: 3, state: 'RELEASED' };
  assert.deepEqual(Object.keys(other), CLAIM_FIELDS);
  for (const field of CLAIM_FIELDS) {
    const f = fixture();
    assert.notDeepEqual(f.claims[1][field], other[field], field);
    f.claims[1][field] = other[field];
    const errors = checkLedger(f, POLICY, AT);
    assert.equal(errors.filter((e) => e.code === 'LEDGER_ENTRY_DIGEST_MISMATCH').length, 1, `${field}: ${codes(errors)}`);
    assert.ok(!errors.some((e) => e.code === 'LEDGER_CHAIN_BROKEN' || e.code === 'LEDGER_HEAD_DIGEST_MISMATCH'), field);
  }
});

test('removing, truncating, reordering or adding claims, or changing a counter, is caught by the chain or the head digest', () => {
  const want = (edit, expected, label) => {
    const f = fixture();
    edit(f);
    assert.deepEqual(codes(checkLedger(f, POLICY, AT)), expected, label);
  };
  want((f) => f.claims.splice(1, 1), ['LEDGER_CHAIN_BROKEN', 'LEDGER_HEAD_DIGEST_MISMATCH'], 'the claim in the middle removed');
  want((f) => f.claims.pop(), ['LEDGER_HEAD_DIGEST_MISMATCH'], 'the last claim removed: the chain alone cannot see it, the head can');
  want((f) => { f.claims = []; }, ['LEDGER_HEAD_DIGEST_MISMATCH'], 'every claim removed');
  want((f) => f.claims.reverse(), ['FENCING_TOKEN_REGRESSION', 'LEDGER_CHAIN_BROKEN', 'LEDGER_HEAD_DIGEST_MISMATCH'], 'the claims reversed');
  want((f) => { f.counters.T07 = 5; }, ['LEDGER_HEAD_DIGEST_MISMATCH'], 'a counter raised');
  want((f) => { f.counters.T05 = 0; }, ['LEDGER_COUNTER_BEHIND_CLAIM', 'LEDGER_HEAD_DIGEST_MISMATCH'], 'a counter lowered below a token');
  want((f) => { delete f.counters.T07; }, ['LEDGER_COUNTER_BEHIND_CLAIM', 'LEDGER_HEAD_DIGEST_MISMATCH'], 'a counter removed');
  want((f) => { f.counters.T09 = 1; }, ['LEDGER_HEAD_DIGEST_MISMATCH'], 'a counter added for a track of the map');
  want((f) => { f.counters.T99 = 1; }, ['LEDGER_HEAD_DIGEST_MISMATCH', 'UNKNOWN_TRACK'], 'a counter added for a track the map does not hold');
  want((f) => f.claims.push({ ...f.claims[3] }), ['DUPLICATE_CLAIM_ID', 'FENCING_TOKEN_REGRESSION', 'LEDGER_CHAIN_BROKEN', 'LEDGER_HEAD_DIGEST_MISMATCH'], 'a claim copied to the end');
});

test('every single edit of the sealed fixture is reported by the model, and none makes it throw', () => {
  const edits = [];
  const alternatives = (value) => [null, 0, -1, 1.5, '', 'x', true, [], {}, typeof value === 'number' ? value + 1 : `${value}0`].filter((alt) => JSON.stringify(alt) !== JSON.stringify(value));
  const at = (root, trail) => trail.reduce((node, key) => node[key], root);
  const visit = (node, trail) => {
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        edits.push({
          label: `remove ${[...trail, key].join('.')}`,
          apply: (root) => {
            const parent = at(root, trail);
            if (Array.isArray(parent)) parent.splice(Number(key), 1);
            else delete parent[key];
          },
        });
        visit(node[key], [...trail, key]);
      }
      edits.push({
        label: `add a member to ${trail.join('.') || 'the ledger'}`,
        apply: (root) => {
          const parent = at(root, trail);
          if (Array.isArray(parent)) parent.push('extra');
          else parent.extra = 1;
        },
      });
      return;
    }
    for (const alt of alternatives(node)) {
      edits.push({ label: `set ${trail.join('.')} to ${JSON.stringify(alt)}`, apply: (root) => { at(root, trail.slice(0, -1))[trail[trail.length - 1]] = structuredClone(alt); } });
    }
  };
  visit(fixture(), []);
  assert.ok(edits.length > 500, `only ${edits.length} edits were tried`);
  const missed = [];
  for (const { label, apply } of edits) {
    const ledger = fixture();
    apply(ledger);
    let errors;
    assert.doesNotThrow(() => { errors = checkLedger(ledger, POLICY, AT); }, label);
    if (errors.length === 0) missed.push(label);
  }
  assert.deepEqual(missed, []);
});

test('a ledger rewritten and sealed anew passes without the pin and fails with it, in the model and in the gate', () => {
  const original = fixture();
  const stretched = fixture();
  stretched.claims[1].expires_at = '2026-10-09T05:00:00Z';
  const rewritten = reseal(stretched);
  assert.notEqual(rewritten.head_digest, original.head_digest);
  assert.deepEqual(checkLedger(rewritten, POLICY, AT), []);
  assert.deepEqual(checkLedger(rewritten, POLICY, AT, { pin: rewritten.head_digest }), []);
  assert.deepEqual(codes(checkLedger(rewritten, POLICY, AT, { pin: original.head_digest })), ['LEDGER_HEAD_PIN_MISMATCH']);
  assert.deepEqual(checkLedger(original, POLICY, AT, { pin: original.head_digest }), []);
  withTmp((dir) => {
    const file = writeLedger(dir, 'rewritten.json', rewritten);
    const unpinned = lease('ledger', '--ledger', file, '--at', AT);
    assert.equal(unpinned.status, 0, unpinned.stdout);
    assert.ok(unpinned.stdout.endsWith(`; head ${rewritten.head_digest} is not pinned (a ledger rewritten and sealed anew would pass too)\n`), unpinned.stdout);
    const pinned = lease('ledger', '--ledger', file, '--at', AT, '--head-digest', original.head_digest);
    assert.equal(pinned.status, 2, pinned.stdout);
    assert.deepEqual(lines(pinned).map((l) => l.split(' ').slice(0, 3).join(' ')), ['FAIL LEDGER_HEAD_PIN_MISMATCH head_digest']);
    const viaResult = lease(...resultArgs(file, BASE, '--head-digest', original.head_digest, '--head', HEAD, 'next/t00/a.mjs'));
    assert.equal(viaResult.status, 2, viaResult.stdout);
    assert.match(viaResult.stdout, /^FAIL LEDGER_HEAD_PIN_MISMATCH head_digest /);
    const same = lease('ledger', '--ledger', FIXTURE_FILE, '--at', AT, '--head-digest', original.head_digest);
    assert.equal(same.status, 0, same.stdout);
    assert.ok(same.stdout.endsWith(`; head ${original.head_digest} equals the pin\n`), same.stdout);
    for (const bad of ['', 'abc', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
      const refused = lease('ledger', '--ledger', FIXTURE_FILE, '--at', AT, '--head-digest', bad);
      assert.equal(refused.status, 1, JSON.stringify(bad));
      assert.equal(refused.stdout, '');
      assert.match(refused.stderr, /^--head-digest must be 64 lowercase hex digits, got /);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The seal tool
// ---------------------------------------------------------------------------------------------------------------------------------

test('the seal tool reproduces the fixture byte for byte, replaces stale digests and judges nothing', () => {
  const sealed = sealLedger(fixture());
  assert.equal(sealed.problem, undefined);
  assert.deepEqual(sealed.ledger, fixture());
  assert.deepEqual(sealLedger(sealed.ledger).ledger, sealed.ledger);
  const edited = fixture();
  edited.claims[1].worker = 'someone-else';
  const resealed = sealLedger(edited).ledger;
  assert.notEqual(resealed.claims[1].entry_digest, edited.claims[1].entry_digest);
  assert.deepEqual(checkLedger(resealed, POLICY, AT), []);
  // Sealing signs what it is given: a claim that breaks every rule is sealed, and the check then reports it.
  const junk = sealLedger({ schema: LEDGER_SCHEMA, counters: {}, claims: [{ claim_id: 5, state: 'x' }] });
  assert.equal(junk.problem, undefined);
  assert.ok(checkLedger(junk.ledger, POLICY, AT).length > 0);
  assert.ok(!checkLedger(junk.ledger, POLICY, AT).some((e) => e.code.includes('DIGEST') || e.code === 'LEDGER_CHAIN_BROKEN'));
  const printed = seal(FIXTURE_FILE);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stderr, '');
  assert.equal(printed.stdout, fs.readFileSync(FIXTURE_FILE, 'utf8'));
});

test('sealing is how a ledger is edited on purpose: the edit fails the gate, the sealed copy passes, the input is untouched', () => {
  withTmp((dir) => {
    const edited = fixture();
    edited.claims[1].expires_at = '2026-10-09T01:30:00Z';
    edited.counters.T00 = 7;
    const text = `${JSON.stringify(edited, null, 2)}\n`;
    const file = path.join(dir, 'edited.json');
    fs.writeFileSync(file, text);
    const before = lease('ledger', '--ledger', file, '--at', AT);
    assert.equal(before.status, 2, before.stdout);
    assert.deepEqual(codes(lines(before).map((l) => ({ code: l.split(' ')[1] }))), ['LEDGER_ENTRY_DIGEST_MISMATCH', 'LEDGER_HEAD_DIGEST_MISMATCH']);
    const printed = seal(file);
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.deepEqual(fs.readdirSync(dir), ['edited.json']);
    const sealedFile = path.join(dir, 'sealed.json');
    fs.writeFileSync(sealedFile, printed.stdout);
    const after = lease('ledger', '--ledger', sealedFile, '--at', AT);
    assert.equal(after.status, 0, after.stdout);
    assert.deepEqual(JSON.parse(printed.stdout).claims[1].expires_at, '2026-10-09T01:30:00Z');
  });
});

test('the seal tool refuses what it cannot sign or read: exit 1, a message on stderr, nothing on stdout', () => {
  withTmp((dir) => {
    const put = (name, text) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text);
      return file;
    };
    const claim = () => fixture().claims[0];
    const cannotSeal = [
      ['a member a ledger does not have', JSON.stringify({ ...fixture(), extra: 1 }), /: "extra" is not a member of a ledger\n/],
      ['a counter that is not a count', JSON.stringify({ ...fixture(), counters: { T00: '2' } }), /: a counter is not a non-negative integer\n/],
      ['a claim that is not an object', JSON.stringify({ ...fixture(), claims: [1] }), /: claims\[0\] is not an object whose members are plain values\n/],
      ['a claim with a nested object', JSON.stringify({ ...fixture(), claims: [{ ...claim(), path_scopes: [{}] }] }), /: claims\[0\] is not an object whose members are plain values\n/],
      ['a claim member that is not a field', JSON.stringify({ ...fixture(), claims: [{ ...claim(), extra: 1 }] }), /: claims\[0\] has the member "extra", which a claim does not have\n/],
      ['another schema', JSON.stringify({ ...fixture(), schema: 'bskel.t00-lease-ledger/2' }), /: expected an object with schema bskel\.t00-lease-ledger\/1, an object counters and an array claims\n/],
      ['a list', '[]', /: expected an object with schema /],
      ['null', 'null', /: expected an object with schema /],
    ];
    for (const [what, text, pattern] of cannotSeal) {
      const result = seal(put('in.json', text));
      assert.equal(result.status, 1, what);
      assert.equal(result.stdout, '', what);
      assert.match(result.stderr, /^cannot seal the lease ledger .*in\.json/, what);
      assert.match(result.stderr, pattern, what);
      assert.match(result.stderr, /\nusage: node next\/t00\/seal-lease-ledger\.mjs <ledger\.json>\n/, what);
    }
    const cannotRead = [
      ['no argument', [], /^usage: node next\/t00\/seal-lease-ledger\.mjs /],
      ['two arguments', [FIXTURE_FILE, FIXTURE_FILE], /^usage: /],
      ['a flag', ['--write'], /^usage: /],
      ['a missing file', [path.join(dir, 'absent.json')], /^cannot read the lease ledger .*absent\.json: ENOENT\n/],
      ['a directory', [dir], /^cannot read the lease ledger .*: EISDIR\n/],
      ['text that is not JSON', [put('bad.json', '{"schema": ')], /^cannot read the lease ledger .*bad\.json: /],
    ];
    for (const [what, args, pattern] of cannotRead) {
      const result = seal(...args);
      assert.equal(result.status, 1, what);
      assert.equal(result.stdout, '', what);
      assert.match(result.stderr, pattern, what);
    }
  });
  for (const bad of [null, undefined, 0, 'x', [], {}, { schema: LEDGER_SCHEMA }, { schema: LEDGER_SCHEMA, counters: [], claims: [] }, { schema: LEDGER_SCHEMA, counters: {}, claims: {} }]) {
    const sealed = sealLedger(bad);
    assert.equal(typeof sealed.problem, 'string', JSON.stringify(bad));
    assert.equal(sealed.ledger, undefined);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Permissions and what the gates leave behind
// ---------------------------------------------------------------------------------------------------------------------------------

// A process that can read a file of mode 000 (root, or any other permission bypass) cannot be given an unreadable ledger, so the test
// that needs one is reported as skipped, with this reason. For an ordinary user it runs. The rule is tested by itself below.
const UNREADABLE_SKIP_REASON = 'this process can read a file of mode 000 (root or a permission bypass), so the unreadable ledger is not available';
const unreadableSkip = (platform, access, file) => {
  if (platform === 'win32') return 'mode bits do not make a file unreadable on Windows';
  try {
    access(file, fs.constants.R_OK);
  } catch {
    return false;
  }
  return UNREADABLE_SKIP_REASON;
};
const LOCKED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't00-lease-locked-'));
const LOCKED = path.join(LOCKED_DIR, 'locked-ledger.json');
fs.writeFileSync(LOCKED, `${JSON.stringify(fixture(), null, 2)}\n`);
fs.chmodSync(LOCKED, 0o000);
process.on('exit', () => {
  try {
    fs.chmodSync(LOCKED, 0o600);
    fs.rmSync(LOCKED_DIR, { recursive: true, force: true });
  } catch {
    // nothing left to clean
  }
});
const LOCKED_SKIP = unreadableSkip(process.platform, fs.accessSync, LOCKED);

test('a ledger the process may not read is an unreadable input, not a verdict: exit 1, nothing on stdout (skipped with a reason where a mode 000 file stays readable)', { skip: LOCKED_SKIP }, () => {
  const asLedger = lease('ledger', '--ledger', LOCKED, '--at', AT);
  const asResult = lease(...resultArgs(LOCKED, BASE, '--head', HEAD, 'next/t00/a.mjs'));
  const asSeal = seal(LOCKED);
  for (const [what, result] of [['ledger', asLedger], ['result', asResult], ['seal', asSeal]]) {
    assert.equal(result.status, 1, `${what}: ${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, '', what);
    assert.match(result.stderr, /^cannot read the lease ledger .*locked-ledger\.json: EACCES\n/, what);
  }
});

test('the unreadable-ledger test is skipped with a reason where a mode 000 file stays readable, and runs where it does not', () => {
  const denied = () => {
    throw Object.assign(new Error('EACCES: permission denied, access'), { code: 'EACCES' });
  };
  const seen = [];
  assert.equal(unreadableSkip('linux', (file, mode) => { seen.push([file, mode]); denied(); }, 'f'), false);
  assert.deepEqual(seen, [['f', fs.constants.R_OK]]);
  assert.equal(unreadableSkip('darwin', denied, 'f'), false);
  const readable = unreadableSkip('linux', () => undefined, 'f');
  assert.equal(readable, UNREADABLE_SKIP_REASON);
  assert.match(readable, /mode 000/);
  assert.match(readable, /root/);
  assert.match(unreadableSkip('win32', denied, 'f'), /Windows/);
  assert.ok(LOCKED_SKIP === false || typeof LOCKED_SKIP === 'string');
  if (process.platform !== 'win32') {
    let canRead = true;
    try {
      fs.accessSync(LOCKED, fs.constants.R_OK);
    } catch {
      canRead = false;
    }
    assert.equal(typeof LOCKED_SKIP === 'string', canRead, 'the test is skipped exactly where the process can read the locked file');
  }
});

// Every file under dir with its size and content hash, in a fixed order. The walk is by hand: Node 18 has no recursive readdir.
function snapshot(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(full);
      } else {
        out.push(`${rel} ${fs.statSync(full).size} ${sha256(fs.readFileSync(full))}`);
      }
    }
  };
  walk(dir);
  return out;
}

function setModes(root, dirMode, fileMode) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) setModes(full, dirMode, fileMode);
    else fs.chmodSync(full, fileMode);
  }
  fs.chmodSync(root, dirMode);
}

test('the gates and the seal tool only read: on a read-only copy they judge as before and change nothing', () => {
  withTmp((dir) => {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    writeScaffold(repo, baseModel());
    const good = writeLedger(dir, 'good.json', fixture());
    const bad = writeLedger(dir, 'bad.json', { ...fixture(), extra: 1 });
    const runs = () => [
      lease('--repo-dir', repo, 'ledger', '--ledger', good, '--at', AT),
      lease('--repo-dir', repo, 'ledger', '--ledger', bad, '--at', AT),
      lease('--repo-dir', repo, ...resultArgs(good, BASE, '--head', HEAD, 'next/t00/a.mjs')),
      lease('--repo-dir', repo, ...resultArgs(good, BASE, '--head', HEAD, 'package.json')),
      lease('--repo-dir', repo, 'ledger'),
      seal(good),
      seal(bad),
    ].map((r) => [r.status, r.stdout, r.stderr]);
    const writable = runs();
    assert.deepEqual(writable.map((r) => r[0]), [0, 2, 0, 2, 1, 0, 1]);
    const before = snapshot(dir);
    const lock = process.platform !== 'win32';
    let readOnly;
    try {
      if (lock) setModes(dir, 0o555, 0o444);
      readOnly = runs();
    } finally {
      if (lock) setModes(dir, 0o755, 0o644);
    }
    assert.deepEqual(readOnly, writable);
    assert.deepEqual(snapshot(dir), before);
  });
});

test('the checks of one ledger do not depend on what the process does around them: no clock, no write in the model and the gates', () => {
  for (const file of ['lease-ledger.mjs', 'check-lease.mjs', 'seal-lease-ledger.mjs']) {
    const source = read(`next/t00/${file}`);
    assert.ok(!/Date\.now\(|new Date\(\)|performance\.now|hrtime|Math\.random/.test(source), `${file} reads a clock or a random source`);
    assert.ok(!/(write|append|create(Write)?Stream|mkdtemp|mkdir|rm|unlink|rename|copyFile|chmod|truncate|symlink|utimes)(File|Sync|Stream)?\(/.test(source.replace(/\/\/.*$/gm, '').replace(/\b(readFileSync|readdirSync|existsSync)\(/g, '')), `${file} calls a function that writes`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Output cannot be forged
// ---------------------------------------------------------------------------------------------------------------------------------

test('a control character in the name of a ledger or claim member cannot add a line to the output', () => {
  withTmp((dir) => {
    const key = 'x\nFAIL FAKE a b\x1b[31m\x7f\0z';
    const ledger = fixture();
    ledger[key] = 1;
    ledger.claims[1][key] = 1;
    const file = writeLedger(dir, 'evil.json', ledger);
    const result = lease('ledger', '--ledger', file, '--at', AT);
    assert.equal(result.status, 2, result.stdout);
    const out = lines(result);
    assert.equal(out.length, 2, result.stdout);
    assert.ok(out.every((l) => l.startsWith('FAIL UNKNOWN_LEDGER_MEMBER ')), result.stdout);
    assert.ok(!/[\x00-\x09\x0b-\x1f\x7f]/.test(result.stdout), 'a raw control character reached stdout');
    assert.ok(out.every((l) => l.includes('x\\x0aFAIL FAKE a b\\x1b[31m\\x7f\\x00z')), result.stdout);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The mutation check
// ---------------------------------------------------------------------------------------------------------------------------------

test('every mutant of the gate is killed by a recorded case, the runner can tell a survivor from a kill, and it writes nothing here', async () => {
  const entries = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('t00-mutants-'));
  const copiesBefore = entries();
  const tree = snapshot(path.join(ROOT, 'next/t00'));
  assert.equal(new Set(MUTANTS.map((x) => x.id)).size, MUTANTS.length);
  for (const x of MUTANTS) {
    assert.ok(x.cases.length > 0 && x.cases.every((id) => CASES.some((c) => c.id === id)), `${x.id} names a case that does not exist`);
  }
  const full = run('lease-mutants.mjs', []);
  assert.equal(full.status, 0, full.stdout + full.stderr);
  const out = lines(full);
  assert.equal(out.length, MUTANTS.length + 1, full.stdout);
  MUTANTS.forEach((x, i) => assert.ok(out[i].startsWith(`killed ${x.id} by `), out[i]));
  assert.equal(out[out.length - 1], `OK ${MUTANTS.length} mutants, each killed by a recorded case; an unchanged copy passes the same cases`);

  const neutral = { id: 'neutral', file: 'lease-ledger.mjs', find: 'export const SHA = /^[0-9a-f]{40}$/;', replace: 'export const SHA = /^[0-9a-f]{40}$/; // same check', cases: ['result-base-short'] };
  const absent = { id: 'absent', file: 'lease-ledger.mjs', find: 'a text that no source holds', replace: 'x', cases: ['result-base-short'] };
  const twice = { id: 'twice', file: 'lease-ledger.mjs', find: 'const ', replace: 'let ', cases: ['result-base-short'] };
  const same = { id: 'same', file: 'lease-ledger.mjs', find: 'export const SHA = /^[0-9a-f]{40}$/;', replace: 'export const SHA = /^[0-9a-f]{40}$/;', cases: ['result-base-short'] };
  const killing = { id: 'killing', file: 'lease-ledger.mjs', find: 'export const SHA = /^[0-9a-f]{40}$/;', replace: 'export const SHA = /^[0-9a-f]{39}$/;', cases: ['ledger-normal'] };
  const probe = await runMutants([neutral, absent, twice, same, killing]);
  assert.equal(probe.control, null);
  assert.deepEqual(probe.results.map((r) => [r.id, r.outcome]), [['neutral', 'survived'], ['absent', 'not_applied'], ['twice', 'not_applied'], ['same', 'not_applied'], ['killing', 'killed']]);
  assert.match(probe.results[1].detail, /occurs 0 times in lease-ledger\.mjs, not once/);
  assert.match(probe.results[2].detail, /occurs \d+ times in lease-ledger\.mjs, not once/);
  assert.match(probe.results[3].detail, /the replacement equals the text it replaces/);

  const ghost = await runMutants([{ ...neutral, id: 'ghost', cases: ['no-such-case'] }]);
  assert.ok(ghost.control !== null && ghost.control.id === 'no-such-case', 'a mutant that names no recorded case makes the control fail');
  assert.deepEqual(ghost.results.map((r) => r.outcome), ['not_killed_by_a_case']);

  assert.deepEqual(snapshot(path.join(ROOT, 'next/t00')), tree);
  assert.deepEqual(entries().filter((n) => !copiesBefore.includes(n)), [], 'a mutant copy was left behind');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// What the documents say
// ---------------------------------------------------------------------------------------------------------------------------------

test('the protocol document lists every code once and the readme lists the files of this task', () => {
  const doc = read('next/t00/LEASE_PROTOCOL.md');
  const rows = [...doc.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...rows].sort(), [...LEASE_CODES].sort());
  assert.equal(new Set(rows).size, rows.length);
  const readme = read('next/t00/README.md');
  for (const f of ['lease-ledger.mjs', 'check-lease.mjs', 'seal-lease-ledger.mjs', 'make-lease-report.mjs', 'lease-mutants.mjs', 'lease-report.json', 'fixtures/lease-ledger.json', 'LEASE_PROTOCOL.md']) {
    assert.ok(readme.split('\n').some((l) => l.startsWith('| `') && l.includes(`\`${f}\``)), `${f} is not a row of the readme`);
    assert.ok(fs.existsSync(path.join(ROOT, 'next/t00', f)), `${f} does not exist`);
  }
});

test('the commands of the protocol document use the flags the gate prints in its usage text, and no others', () => {
  const doc = read('next/t00/LEASE_PROTOCOL.md');
  const block = doc.split('## Commands')[1].split('```')[1];
  assert.ok(block.includes('node next/t00/check-lease.mjs'), block);
  const flags = (text) => [...new Set(text.match(/--[a-z][a-z-]*/g))].sort();
  const usage = lease();
  assert.equal(usage.status, 1);
  assert.deepEqual(flags(block), flags(usage.stderr));
  assert.deepEqual(flags(usage.stderr), ['--at', '--base', '--claim', '--head', '--head-digest', '--ledger', '--repo-dir', '--token', '--worker', '--worktree']);
  assert.ok(doc.includes('node next/t00/seal-lease-ledger.mjs'));
});

test('what the documents say of the CI is true: no workflow runs a T00 gate, the test job runs npm test on Node 22 and 24, and nothing runs Node 18', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const workflows = fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n));
  assert.ok(workflows.includes('ci.yml'));
  const changeThem = 'LEASE_PROTOCOL.md, README.md and INTERFACE_RFC.md say so, so change them with the workflow';
  let seen = 0;
  for (const name of workflows) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.ok(!/check-lease|check-ownership|seal-lease-ledger|lease-mutants|make-lease-report|next\/t00/.test(text), `${name} runs a T00 gate: ${changeThem}`);
    assert.ok(!/7b517e7a|bootstrap-baseline/.test(text), `${name} refers to the coordination branch or commit that the documents say no workflow refers to`);
    const versions = [...text.matchAll(/node-version:[ \t]*(.+)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, ''));
    assert.ok(versions.every((v) => v === '22.x' || v === '24.x' || v === '${{ matrix.node }}'), `${name} runs a Node version the README does not name: ${versions.join(' ')}`);
    seen += versions.length;
    const matrices = [...text.matchAll(/^[ \t]+node:[ \t]*(.+)$/gm)].map((m) => m[1].trim());
    assert.ok(matrices.every((v) => v === "['22.x', '24.x']"), `${name} has a Node matrix other than 22.x and 24.x: ${matrices.join(' ')}`);
  }
  assert.ok(seen > 0, 'no node-version line was found, so the check above judged nothing');
  // The job named test is the one the documents mean: its own lines, up to the next job key, hold the matrix and the npm test step.
  const ciLines = fs.readFileSync(path.join(dir, 'ci.yml'), 'utf8').split('\n');
  const first = ciLines.findIndex((l) => /^ {2}test:\s*$/.test(l));
  assert.ok(first >= 0, `ci.yml has no job named test: ${changeThem}`);
  const next = ciLines.findIndex((l, i) => i > first && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  const testJob = ciLines.slice(first, next < 0 ? undefined : next).join('\n');
  assert.match(testJob, /^\s+npm test\b/m, `the test job of ci.yml has no step that runs npm test: ${changeThem}`);
  assert.match(testJob, /^\s+node: \['22\.x', '24\.x'\]\s*$/m, `the matrix of the test job of ci.yml is no longer Node 22.x and 24.x: ${changeThem}`);
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.test, /test\/\*\.test\.mjs/);
  assert.ok(/^>=18/.test(pkg.engines.node), pkg.engines.node);
  const doc = read('next/t00/LEASE_PROTOCOL.md');
  assert.match(doc, /No workflow calls `check-lease\.mjs`/);
  assert.match(doc, /not wired into CI/);
  assert.match(read('next/t00/README.md'), /not wired into CI/);
  assert.match(read('next/t00/INTERFACE_RFC.md'), /not wired into CI/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Node 18 (engines >=18; CI runs 22.x and 24.x)
// ---------------------------------------------------------------------------------------------------------------------------------

// Names of APIs that Node 18 does not have, each in two pieces so that this file does not contain a name itself. A list of known names
// found in the text, not a proof: the T00 files were run on Node 24 here, and Node 18 and 22 were not available to run them on.
const NEWER_THAN_NODE_18 = [
  ['to', 'Sorted('], ['to', 'Reversed('], ['to', 'Spliced('], ['.', 'with('], ['Object.group', 'By('], ['Map.group', 'By('], ['Promise.with', 'Resolvers'], ['Array.from', 'Async('],
  ['URL.can', 'Parse('], ['crypto.', 'hash('], ['glob', 'Sync('], ['fs.cp', 'Sync('], ['import.meta.dir', 'name'], ['import.meta.file', 'name'], ['.parent', 'Path'],
  ['AbortSignal.', 'any('], ['is', 'WellFormed('], ['style', 'Text('], ['load', 'EnvFile('], ['getBuiltin', 'Module('], ['open', 'AsBlob('], ['node:', 'sqlite'],
  ['.union', '('], ['.intersection', '('], ['.difference', '('], ['.symmetricDifference', '('], ['.isSubsetOf', '('], ['.isSupersetOf', '('], ['.isDisjointFrom', '('], ['Iterator.', 'from('],
].map((pieces) => pieces.join(''));

// The recursive option of a directory read is judged call by call: the text between the parentheses of the read is searched, so a
// recursive mkdir next to a plain read is not taken for it.
function newerApis(text) {
  const found = NEWER_THAN_NODE_18.filter((name) => text.includes(name));
  const opener = new RegExp('read' + 'dir(Sync)?\\(', 'g');
  const option = 'recur' + 'sive';
  for (let m = opener.exec(text); m !== null; m = opener.exec(text)) {
    let depth = 1;
    let end = opener.lastIndex;
    while (end < text.length && depth > 0) {
      if (text[end] === '(') depth += 1;
      if (text[end] === ')') depth -= 1;
      end += 1;
    }
    if (text.slice(opener.lastIndex, end).includes(option)) found.push(`line ${text.slice(0, m.index).split('\n').length}: a directory read with the recursive option`);
  }
  return found;
}

test('no T00 file uses an API that Node 18 lacks, and the scan finds what it is meant to find', () => {
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'next/t00')).filter((n) => n.endsWith('.mjs')).map((n) => `next/t00/${n}`),
    ...fs.readdirSync(path.join(ROOT, 'test')).filter((n) => /^t00-.*\.test\.mjs$/.test(n)).map((n) => `test/${n}`),
  ];
  for (const must of ['test/t00-lease.test.mjs', 'test/t00-ownership.test.mjs', 'test/t00-baseline.test.mjs', 'next/t00/lease-ledger.mjs', 'next/t00/check-lease.mjs', 'next/t00/seal-lease-ledger.mjs', 'next/t00/lease-mutants.mjs', 'next/t00/recorded-runs.mjs']) {
    assert.ok(files.includes(must), `${must} is not scanned: ${files.join(' ')}`);
  }
  for (const rel of files) assert.deepEqual(newerApis(read(rel)), [], rel);
  assert.deepEqual(newerApis(`const sorted = list.${'to'}${'Sorted'}();`), [`${'to'}${'Sorted('}`]);
  assert.deepEqual(newerApis(`fs.${'read'}${'dir'}Sync(d, { ${'recur'}${'sive'}: true });`), ['line 1: a directory read with the recursive option']);
  assert.deepEqual(newerApis('fs.readdirSync(d, { withFileTypes: true }); fs.mkdirSync(d, { recursive: true });'), []);
  assert.deepEqual(newerApis(`const a = 1;\nfs.${'read'}${'dir'}Sync(\n  join(d, 'x'),\n  { ${'recur'}${'sive'}: true },\n);`), ['line 2: a directory read with the recursive option']);
  assert.deepEqual(newerApis('// Node 18 has no recursive readdir, so the walk is by hand.\nfs.readdirSync(d);'), []);
});
