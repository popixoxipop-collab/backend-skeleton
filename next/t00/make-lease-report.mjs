#!/usr/bin/env node
// Builds lease-report.json by running the real check-lease CLI on the normal ledger fixture and on copies of it with one thing
// broken. Nothing in the report is typed by hand: the exit code, the error codes and the stdout hash of every case are what the
// CLI printed, and a case whose run differs from its declaration throws, so no report is written unless every case behaved as declared.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { diffReports, runAll, sha256 } from './recorded-runs.mjs';
import { canonicalSha256 } from './verify-baseline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..', '..');
export const REPORT_FILE = path.join(here, 'lease-report.json');
export const FIXTURE_FILE = path.join(here, 'fixtures', 'lease-ledger.json');
export const REPORT_SCHEMA = 'bskel.t00-lease-report/1';
const CLI = path.join(here, 'check-lease.mjs');
const TOOL_FILES = ['check-lease.mjs', 'lease-ledger.mjs', 'ownership.mjs', 'build-ownership-map.mjs'];
const LEDGER = '<ledger>';
export const AT = '2026-10-09T01:00:00Z';
const BASE = 'ed10b06106dd72ea4e1dac7f784827a29f9c3f90';
const HEAD = '87bcb488dc702484e7c85317b33dd7838cb0e5ab';
const OWN = ['next/t00/lease-ledger.mjs'];

const fixture = () => JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
const claim = (l, id) => l.claims.find((x) => x.claim_id === id);
const ledgerAt = (at = AT) => ['ledger', '--ledger', LEDGER, '--at', at];
const resultOf = ({ at = AT, id = 'T00-0002', token = '2', base = BASE, head = HEAD, paths = OWN } = {}) => ['result', '--ledger', LEDGER, '--at', at, '--claim', id, '--token', token, '--base', base, '--head', head, ...paths];
// A third claim of T00, issued at 00:30, that a case then changes.
const third = (extra) => (l) => {
  l.claims.push({ ...claim(l, 'T00-0002'), claim_id: 'T00-0003', fencing_token: 3, issued_at: '2026-10-09T00:30:00Z', ...extra });
  l.counters.T00 = 3;
};
const set = (id, fields) => (l) => Object.assign(claim(l, id), fields);
const c = (id, mutation, exit, codes, args, change) => ({ id, mutation, exit, codes, args, change });
const only = (path0) => ({ paths: [path0] });

export const CASES = [
  c('ledger-normal', 'none: the normal fixture', 0, [], ledgerAt()),
  c('ledger-empty', 'no claims and no counters', 0, [], ledgerAt(), (l) => { l.claims = []; l.counters = {}; }),
  c('ledger-schema-wrong', 'schema name changed', 2, ['LEDGER_SCHEMA'], ledgerAt(), (l) => { l.schema = 'bskel.t00-lease-ledger/0'; }),
  c('ledger-claims-not-array', 'claims is an object', 2, ['LEDGER_SCHEMA'], ledgerAt(), (l) => { l.claims = {}; }),
  c('claim-not-object', 'a claim is the number 7', 2, ['INVALID_CLAIM'], ledgerAt(), (l) => { l.claims.push(7); }),
  c('claim-id-space', 'claim id holds a space', 2, ['INVALID_CLAIM'], ledgerAt(), set('T05-0001', { claim_id: 'T05 0001' })),
  c('worker-missing', 'worker removed', 2, ['INVALID_CLAIM'], ledgerAt(), (l) => { delete claim(l, 'T05-0001').worker; }),
  c('duplicate-id', 'a released claim repeated with token 2', 2, ['DUPLICATE_CLAIM_ID'], ledgerAt(), (l) => { l.claims.push({ ...claim(l, 'T07-0001'), fencing_token: 2 }); l.counters.T07 = 2; }),
  c('unknown-track', 'claim names track T99', 2, ['UNKNOWN_TRACK'], ledgerAt(), set('T05-0001', { track: 'T99' })),
  c('counter-unknown-track', 'counter for track T99', 2, ['UNKNOWN_TRACK'], ledgerAt(), (l) => { l.counters.T99 = 1; }),
  c('repository-mismatch', 'T05 claimed in becoder', 2, ['TRACK_REPO_MISMATCH'], ledgerAt(), set('T05-0001', { repository: 'becoder' })),
  c('base-sha-short', 'base sha is abc', 2, ['INVALID_BASE_SHA'], ledgerAt(), set('T05-0001', { base_sha: 'abc' })),
  c('base-sha-uppercase', 'base sha in upper case', 2, ['INVALID_BASE_SHA'], ledgerAt(), set('T05-0001', { base_sha: BASE.toUpperCase() })),
  c('token-zero', 'fencing token 0', 2, ['INVALID_FENCING_TOKEN'], ledgerAt(), set('T05-0001', { fencing_token: 0 })),
  c('token-string', 'fencing token "1"', 2, ['INVALID_FENCING_TOKEN'], ledgerAt(), set('T05-0001', { fencing_token: '1' })),
  c('time-format', 'issued_at without T and Z', 2, ['INVALID_LEASE_TIME'], ledgerAt(), set('T05-0001', { issued_at: '2026-10-09 00:30:00' })),
  c('time-nonexistent-date', 'expires_at on 30 February', 2, ['INVALID_LEASE_TIME'], ledgerAt(), set('T05-0001', { expires_at: '2026-02-30T00:00:00Z' })),
  c('interval-empty', 'expires_at equals issued_at', 2, ['INVALID_LEASE_INTERVAL'], ledgerAt(), set('T05-0001', { expires_at: '2026-10-09T00:30:00Z', state: 'RELEASED' })),
  c('state-unknown', 'state CLAIMED', 2, ['INVALID_CLAIM_STATE'], ledgerAt(), set('T05-0001', { state: 'CLAIMED' })),
  c('scopes-empty', 'no path scopes', 2, ['MISSING_PATH_SCOPES'], ledgerAt(), set('T05-0001', { path_scopes: [] })),
  c('scope-glob', 'a glob other than /**', 2, ['INVALID_CLAIM_SCOPE'], ledgerAt(), set('T05-0001', { path_scopes: ['scanners/language/jvm/*.mjs'] })),
  c('scope-backslash', 'scope with backslashes', 2, ['INVALID_CLAIM_SCOPE'], ledgerAt(), set('T05-0001', { path_scopes: ['scanners\\language\\jvm\\**'] })),
  c('scope-other-track', 'T05 claims a scope of T07', 2, ['SCOPE_OUTSIDE_OWNERSHIP'], ledgerAt(), set('T05-0001', { path_scopes: ['next/t07/**'] })),
  c('scope-wider-than-owned', 'T05 claims scanners/** (wider than its own)', 2, ['SCOPE_OUTSIDE_OWNERSHIP'], ledgerAt(), set('T05-0001', { path_scopes: ['scanners/**'] })),
  c('scope-case-differs', 'scope differs from the owned one in case', 2, ['SCOPE_OUTSIDE_OWNERSHIP'], ledgerAt(), set('T05-0001', { path_scopes: ['Scanners/language/jvm/**'] })),
  c('scope-hot-path', 'T00 claims package.json', 2, ['SCOPE_OUTSIDE_OWNERSHIP'], ledgerAt(), (l) => { claim(l, 'T00-0002').path_scopes.push('package.json'); }),
  c('token-regression', 'second T00 claim with the token of the first', 2, ['FENCING_TOKEN_REGRESSION'], ledgerAt(), set('T00-0002', { fencing_token: 1 })),
  c('counter-behind-claim', 'counter of T05 is 0', 2, ['LEDGER_COUNTER_BEHIND_CLAIM'], ledgerAt(), (l) => { l.counters.T05 = 0; }),
  c('counter-missing', 'counter of T05 removed', 2, ['LEDGER_COUNTER_BEHIND_CLAIM'], ledgerAt(), (l) => { delete l.counters.T05; }),
  c('lease-expired', 'judged 30 minutes after the end of an ACTIVE claim', 2, ['LEASE_EXPIRED'], ledgerAt('2026-10-09T02:30:00Z')),
  c('lease-ends-exactly-now', 'judged at the instant a lease ends (the end is exclusive)', 2, ['LEASE_EXPIRED'], ledgerAt('2026-10-09T02:00:00Z')),
  c('lease-not-started', 'judged before an ACTIVE claim was issued', 2, ['LEASE_NOT_STARTED'], ledgerAt('2026-10-09T00:15:00Z')),
  c('expired-other-claim', 'a released claim of T07 set back to ACTIVE after its end', 2, ['LEASE_EXPIRED'], ledgerAt(), set('T07-0001', { state: 'ACTIVE' })),
  c('conflict-same-track', 'a second live claim of T00 inside the first', 2, ['ACTIVE_SCOPE_CONFLICT'], ledgerAt(), third({ path_scopes: ['next/t00/fixtures/**'] })),
  c('conflict-case-insensitive', 'the same, written with other case', 2, ['ACTIVE_SCOPE_CONFLICT', 'SCOPE_OUTSIDE_OWNERSHIP'], ledgerAt(), third({ path_scopes: ['Next/T00/fixtures/**'] })),
  c('no-conflict-released', 'the same second claim, RELEASED', 0, [], ledgerAt(), third({ path_scopes: ['next/t00/fixtures/**'], state: 'RELEASED' })),
  c('result-normal', 'none: two paths inside the claim', 0, [], resultOf({ paths: [...OWN, 'test/t00-baseline.test.mjs'] })),
  c('result-ignores-expired-other-claim', 'an expired ACTIVE claim of another track does not block a result', 0, [], resultOf(), set('T07-0001', { state: 'ACTIVE' })),
  c('result-unknown-claim', 'claim id T00-9999', 2, ['UNKNOWN_CLAIM'], resultOf({ id: 'T00-9999' })),
  c('result-claim-released', 'result of a RELEASED claim', 2, ['RESULT_CLAIM_NOT_ACTIVE'], resultOf({ at: '2026-10-09T00:45:00Z', id: 'T07-0001', token: '1', base: HEAD, ...only('next/t07/a.mjs') })),
  c('result-after-expiry', 'result judged 30 minutes after the lease ended', 2, ['RESULT_AFTER_LEASE_EXPIRY'], resultOf({ at: '2026-10-09T02:30:00Z' })),
  c('result-at-expiry', 'result judged at the instant the lease ends', 2, ['RESULT_AFTER_LEASE_EXPIRY'], resultOf({ at: '2026-10-09T02:00:00Z' })),
  c('result-before-lease', 'result judged before the lease was issued', 2, ['LEASE_NOT_STARTED'], resultOf({ at: '2026-10-09T00:15:00Z', id: 'T05-0001', token: '1', base: HEAD, ...only('scanners/language/jvm/a.mjs') })),
  c('result-token-lower', 'result carries token 1 for a claim with token 2', 2, ['RESULT_FENCING_TOKEN_MISMATCH', 'RESULT_STALE_FENCING_TOKEN'], resultOf({ token: '1' })),
  c('result-token-higher', 'result carries token 3 for a claim with token 2', 2, ['RESULT_FENCING_TOKEN_MISMATCH'], resultOf({ token: '3' })),
  c('result-token-superseded', 'token 2 matches its claim but 3 was issued since', 2, ['RESULT_STALE_FENCING_TOKEN'], resultOf(), (l) => { l.counters.T00 = 3; }),
  c('result-base-other', 'result made on another base', 2, ['RESULT_BASE_SHA_MISMATCH'], resultOf({ base: HEAD })),
  c('result-base-short', 'result base is abc', 2, ['INVALID_BASE_SHA'], resultOf({ base: 'abc' })),
  c('result-head-short', 'result head is abc', 2, ['INVALID_RESULT_HEAD_SHA'], resultOf({ head: 'abc' })),
  c('result-path-other-track', 'path of track T05', 2, ['RESULT_PATH_OUTSIDE_CLAIM'], resultOf(only('next/t05/a.mjs'))),
  c('result-path-hot', 'path package.json', 2, ['RESULT_PATH_OUTSIDE_CLAIM'], resultOf(only('package.json'))),
  c('result-path-case', 'path in other case', 2, ['RESULT_PATH_OUTSIDE_CLAIM'], resultOf(only('Next/t00/a.mjs'))),
  c('result-path-directory-itself', 'the directory name of a /** scope', 2, ['RESULT_PATH_OUTSIDE_CLAIM'], resultOf(only('next/t00'))),
  c('result-path-traversal', 'path ../x', 2, ['INVALID_RESULT_PATH'], resultOf(only('../x'))),
  c('result-path-backslash', 'path with backslashes', 2, ['INVALID_RESULT_PATH'], resultOf(only('next\\t00\\a.mjs'))),
  c('result-path-absolute', 'absolute path', 2, ['INVALID_RESULT_PATH'], resultOf(only('/etc/passwd'))),
  c('result-ledger-invalid', 'the result is fine but the ledger holds a conflict', 2, ['ACTIVE_SCOPE_CONFLICT'], resultOf(), third({ path_scopes: ['next/t00/fixtures/**'] })),
  c('usage-unknown-command', 'command verify', 1, [], ['verify', '--ledger', LEDGER, '--at', AT]),
  c('usage-no-ledger-flag', 'no --ledger', 1, [], ['ledger', '--at', AT]),
  c('usage-no-at', 'no --at', 1, [], ['ledger', '--ledger', LEDGER]),
  c('usage-bad-at', '--at tomorrow', 1, [], ledgerAt('tomorrow')),
  { ...c('usage-ledger-file-missing', 'the ledger file does not exist', 1, [], ledgerAt()), missing: true },
  { ...c('usage-ledger-not-json', 'the ledger file is not JSON', 1, [], ledgerAt()), raw: '{ not json' },
  c('usage-no-claim-flag', 'result without --claim', 1, [], ['result', '--ledger', LEDGER, '--at', AT, '--token', '2', '--base', BASE, '--head', HEAD, ...OWN]),
  c('usage-token-not-number', '--token two', 1, [], resultOf({ token: 'two' })),
  c('usage-ledger-with-paths', 'ledger command given a path', 1, [], [...ledgerAt(), 'next/t00/a.mjs']),
];

function prepare(x, dir) {
  const file = path.join(dir, 'ledger.json');
  if (x.raw !== undefined) fs.writeFileSync(file, x.raw);
  else if (!x.missing) {
    const ledger = fixture();
    x.change?.(ledger);
    fs.writeFileSync(file, JSON.stringify(ledger));
  }
  return {
    argv: x.args.map((a) => (a === LEDGER ? file : a)),
    display: ['node', 'next/t00/check-lease.mjs', ...x.args].join(' '),
    scrub: [file, path.join(fs.realpathSync(dir), 'ledger.json')],
    placeholder: LEDGER,
  };
}

export async function buildReport(cases = CASES) {
  return {
    schema: REPORT_SCHEMA,
    task_id: 'T00-03',
    generator: 'node next/t00/make-lease-report.mjs --write',
    inputs: {
      ownership_map_sha256: canonicalSha256(JSON.parse(fs.readFileSync(path.join(here, 'ownership-map.json'), 'utf8'))),
      lease_ledger_fixture_sha256: canonicalSha256(fixture()),
      tool_sha256: Object.fromEntries(TOOL_FILES.map((f) => [f, sha256(fs.readFileSync(path.join(here, f)))])),
    },
    cases: await runAll(CLI, cases.map((x) => ({ ...x, prepare: (dir) => prepare(x, dir) }))),
  };
}

export const verifyReport = diffReports;

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const mode = process.argv[2];
  if (mode === '--write') {
    fs.writeFileSync(REPORT_FILE, `${JSON.stringify(await buildReport(), null, 2)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), REPORT_FILE)}`);
  } else if (mode === '--check') {
    let committed;
    try {
      committed = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
    } catch (e) {
      console.error(`cannot read ${REPORT_FILE}: ${e.message}`);
      process.exit(1);
    }
    const errors = verifyReport(committed, await buildReport());
    for (const e of errors) console.log(`FAIL ${e}`);
    if (errors.length === 0) console.log('OK lease-report.json equals the recomputed report');
    process.exitCode = errors.length === 0 ? 0 : 2;
  } else {
    console.error('usage: node next/t00/make-lease-report.mjs --write | --check');
    process.exitCode = 1;
  }
}
