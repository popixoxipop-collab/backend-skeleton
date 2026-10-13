#!/usr/bin/env node
// Builds lease-report.json by running the real check-lease CLI on the normal ledger fixture and on copies of it with one thing
// broken. Nothing in the report is typed by hand: the exit code, the error codes and the stdout hash of every case are what the
// CLI printed, and a case whose run differs from its declaration throws, so no report is written unless every case behaved as declared.
// A changed copy is sealed anew before it runs, so that only the check under test can fail; a case with `seal: false` is run with
// the digests exactly as the edit left them, which is how the tamper cases show that an edit is seen.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { entryDigest, sealLedger } from './lease-ledger.mjs';
import { diffReports, runAll, sha256 } from './recorded-runs.mjs';
import { canonicalSha256 } from './verify-baseline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..', '..');
export const REPORT_FILE = path.join(here, 'lease-report.json');
export const FIXTURE_FILE = path.join(here, 'fixtures', 'lease-ledger.json');
export const REPORT_SCHEMA = 'bskel.t00-lease-report/1';
const CLI = path.join(here, 'check-lease.mjs');
const TOOL_FILES = ['check-lease.mjs', 'lease-ledger.mjs', 'ownership.mjs', 'build-ownership-map.mjs', 'check-ownership.mjs'];
const LEDGER = '<ledger>';
export const AT = '2026-10-09T01:00:00Z';
const BASE = 'ed10b06106dd72ea4e1dac7f784827a29f9c3f90';
const HEAD = '87bcb488dc702484e7c85317b33dd7838cb0e5ab';
const OWN = ['next/t00/lease-ledger.mjs'];

const fixture = () => JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
export const FIXTURE_HEAD = fixture().head_digest;
const holders = Object.fromEntries(fixture().claims.map((x) => [x.claim_id, { worker: x.worker, worktree: x.worktree }]));
const holder = (id) => holders[id] ?? holders['T00-0002'];
const claim = (l, id) => l.claims.find((x) => x.claim_id === id);
const ledgerAt = (at = AT, pin) => ['ledger', '--ledger', LEDGER, '--at', at, ...(pin === undefined ? [] : ['--head-digest', pin])];
const resultOf = ({ at = AT, id = 'T00-0002', worker = holder(id).worker, worktree = holder(id).worktree, token = '2', base = BASE, head = HEAD, paths = OWN } = {}) => [
  'result', '--ledger', LEDGER, '--at', at, '--claim', id, '--worker', worker, '--worktree', worktree, '--token', token, '--base', base, '--head', head, ...paths,
];
const without = (args, flag) => args.filter((_, i) => i !== args.indexOf(flag) && i !== args.indexOf(flag) + 1);
// A third claim of T00, issued at 00:30, that a case then changes.
const third = (extra) => (l) => {
  l.claims.push({ ...claim(l, 'T00-0002'), claim_id: 'T00-0003', fencing_token: 3, issued_at: '2026-10-09T00:30:00Z', ...extra });
  l.counters.T00 = 3;
};
const set = (id, fields) => (l) => Object.assign(claim(l, id), fields);
const c = (id, mutation, exit, codes, args, change, extra = {}) => ({ id, mutation, exit, codes, args, change, ...extra });
const only = (path0) => ({ paths: [path0] });
const AS_EDITED = { seal: false };
const LATER = { expires_at: '2026-10-09T04:00:00Z' };

export const CASES = [
  c('ledger-normal', 'none: the normal fixture', 0, [], ledgerAt()),
  c('ledger-empty', 'no claims and no counters', 0, [], ledgerAt(), (l) => { l.claims = []; l.counters = {}; }),
  c('ledger-schema-wrong', 'schema of another family: other-ledger/1', 2, ['LEDGER_SCHEMA'], ledgerAt(), (l) => { l.schema = 'other-ledger/1'; }, AS_EDITED),
  c('ledger-schema-missing', 'schema removed', 2, ['LEDGER_SCHEMA'], ledgerAt(), (l) => { delete l.schema; }, AS_EDITED),
  c('ledger-claims-not-array', 'claims is an object', 2, ['LEDGER_SCHEMA'], ledgerAt(), (l) => { l.claims = {}; }, AS_EDITED),
  c('ledger-json-null', 'the ledger file holds null', 2, ['LEDGER_SCHEMA'], ledgerAt(), undefined, { raw: 'null' }),
  c('ledger-json-array', 'the ledger file holds an array', 2, ['LEDGER_SCHEMA'], ledgerAt(), undefined, { raw: '[]' }),
  c('ledger-unknown-member', 'a member "note" added to the ledger', 2, ['UNKNOWN_LEDGER_MEMBER'], ledgerAt(), (l) => { l.note = 'x'; }, AS_EDITED),
  c('claim-not-object', 'a claim is the number 7', 2, ['INVALID_CLAIM', 'LEDGER_HEAD_DIGEST_MISMATCH'], ledgerAt(), (l) => { l.claims.push(7); }, AS_EDITED),
  c('claim-unknown-member', 'a member "owner" added to T05-0001', 2, ['UNKNOWN_LEDGER_MEMBER'], ledgerAt(), set('T05-0001', { owner: 'x' }), AS_EDITED),
  c('claim-id-space', 'claim id holds a space', 2, ['INVALID_CLAIM'], ledgerAt(), set('T05-0001', { claim_id: 'T05 0001' })),
  c('worker-missing', 'worker removed', 2, ['INVALID_CLAIM'], ledgerAt(), (l) => { delete claim(l, 'T05-0001').worker; }),
  c('worktree-empty', 'worktree is an empty string', 2, ['INVALID_CLAIM'], ledgerAt(), set('T05-0001', { worktree: '' })),
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
  c('interval-reversed', 'expires_at three hours before issued_at', 2, ['INVALID_LEASE_INTERVAL'], ledgerAt(), set('T05-0001', { issued_at: '2026-10-09T03:30:00Z', expires_at: '2026-10-09T00:30:00Z', state: 'RELEASED' })),
  c('state-unknown', 'state CLAIMED', 2, ['INVALID_CLAIM_STATE'], ledgerAt(), set('T05-0001', { state: 'CLAIMED' })),
  c('scopes-empty', 'no path scopes', 2, ['MISSING_PATH_SCOPES'], ledgerAt(), set('T05-0001', { path_scopes: [] })),
  c('scope-glob', 'a glob other than /**', 2, ['INVALID_CLAIM_SCOPE'], ledgerAt(), set('T05-0001', { path_scopes: ['scanners/language/jvm/*.mjs'] })),
  c('scope-backslash', 'scope with backslashes', 2, ['INVALID_CLAIM_SCOPE'], ledgerAt(), set('T05-0001', { path_scopes: ['scanners\\language\\jvm\\**'] })),
  c('scope-other-track', 'T05 claims a scope of T07', 2, ['SCOPE_OUTSIDE_OWNERSHIP'], ledgerAt(), set('T05-0001', { path_scopes: ['next/t07/**'] })),
  c('scope-wider-than-owned', 'T05 claims scanners/** (wider than its own)', 2, ['SCOPE_OUTSIDE_OWNERSHIP'], ledgerAt(), set('T05-0001', { path_scopes: ['scanners/**'] })),
  c('scope-case-differs', 'scope differs from the owned one in case', 2, ['SCOPE_OUTSIDE_OWNERSHIP'], ledgerAt(), set('T05-0001', { path_scopes: ['Scanners/language/jvm/**'] })),
  c('scope-below-owned-differs-in-case', 'a scope below an owned directory, written with other case', 2, ['SCOPE_OUTSIDE_OWNERSHIP'], ledgerAt(), set('T05-0001', { path_scopes: ['Scanners/language/jvm/src/**'] })),
  c('scope-file-differs-in-case', 'T00 claims an owned file with other case', 2, ['SCOPE_OUTSIDE_OWNERSHIP'], ledgerAt(), (l) => { claim(l, 'T00-0002').path_scopes[1] = 'Test/t00-baseline.test.mjs'; }),
  c('scope-hot-path', 'T00 claims package.json', 2, ['SCOPE_OUTSIDE_OWNERSHIP'], ledgerAt(), (l) => { claim(l, 'T00-0002').path_scopes.push('package.json'); }),
  c('token-regression', 'second T00 claim with the token of the first', 2, ['FENCING_TOKEN_REGRESSION'], ledgerAt(), set('T00-0002', { fencing_token: 1 })),
  c('token-reused-by-new-claim', 'a third T00 claim, RELEASED, with token 2 again', 2, ['FENCING_TOKEN_REGRESSION'], ledgerAt(), third({ fencing_token: 2, state: 'RELEASED' })),
  c('counter-behind-claim', 'counter of T05 is 0', 2, ['LEDGER_COUNTER_BEHIND_CLAIM'], ledgerAt(), (l) => { l.counters.T05 = 0; }),
  c('counter-missing', 'counter of T05 removed', 2, ['LEDGER_COUNTER_BEHIND_CLAIM'], ledgerAt(), (l) => { delete l.counters.T05; }),
  c('counter-negative', 'counters.T07 is -1', 2, ['LEDGER_COUNTER_BEHIND_CLAIM', 'LEDGER_SCHEMA'], ledgerAt(), (l) => { l.counters.T07 = -1; }, AS_EDITED),
  c('counter-fraction', 'counters.T07 is 1.5', 2, ['LEDGER_COUNTER_BEHIND_CLAIM', 'LEDGER_SCHEMA'], ledgerAt(), (l) => { l.counters.T07 = 1.5; }, AS_EDITED),

  c('ledger-version-0', 'schema bskel.t00-lease-ledger/0', 3, ['LEDGER_VERSION_UNSUPPORTED'], ledgerAt(), (l) => { l.schema = 'bskel.t00-lease-ledger/0'; }, AS_EDITED),
  c('ledger-version-2', 'schema bskel.t00-lease-ledger/2', 3, ['LEDGER_VERSION_UNSUPPORTED'], ledgerAt(), (l) => { l.schema = 'bskel.t00-lease-ledger/2'; }, AS_EDITED),
  c('ledger-version-1-1', 'schema bskel.t00-lease-ledger/1.1', 3, ['LEDGER_VERSION_UNSUPPORTED'], ledgerAt(), (l) => { l.schema = 'bskel.t00-lease-ledger/1.1'; }, AS_EDITED),
  c('ledger-version-2-other-body', 'schema /2 and the members of another layout: entries instead of counters, claims and head_digest', 3, ['LEDGER_VERSION_UNSUPPORTED'], ledgerAt(), (l) => {
    for (const key of Object.keys(l)) delete l[key];
    Object.assign(l, { schema: 'bskel.t00-lease-ledger/2', entries: [] });
  }, AS_EDITED),

  c('tamper-claim-edited', 'T00-0002 expires_at moved two hours later; digests left as they were', 2, ['LEDGER_ENTRY_DIGEST_MISMATCH'], ledgerAt(), set('T00-0002', LATER), AS_EDITED),
  c('tamper-claim-edited-entry-digest-redone', 'the same edit and the entry_digest of that claim recomputed; the claim after it still names the old one', 2, ['LEDGER_CHAIN_BROKEN'], ledgerAt(), (l) => {
    const edited = Object.assign(claim(l, 'T00-0002'), LATER);
    edited.entry_digest = entryDigest(edited);
  }, AS_EDITED),
  c('tamper-claim-removed-middle', 'T05-0001 removed from the middle', 2, ['LEDGER_CHAIN_BROKEN', 'LEDGER_HEAD_DIGEST_MISMATCH'], ledgerAt(), (l) => { l.claims = l.claims.filter((x) => x.claim_id !== 'T05-0001'); }, AS_EDITED),
  c('tamper-claim-removed-last', 'T07-0001, the last claim, removed', 2, ['LEDGER_HEAD_DIGEST_MISMATCH'], ledgerAt(), (l) => { l.claims.pop(); }, AS_EDITED),
  c('tamper-ledger-emptied', 'every claim removed', 2, ['LEDGER_HEAD_DIGEST_MISMATCH'], ledgerAt(), (l) => { l.claims = []; }, AS_EDITED),
  c('tamper-claims-reordered', 'T00-0002 and T05-0001 swapped', 2, ['LEDGER_CHAIN_BROKEN'], ledgerAt(), (l) => { l.claims = [l.claims[0], l.claims[2], l.claims[1], l.claims[3]]; }, AS_EDITED),
  c('tamper-claim-appended-unsealed', 'a valid-looking fifth claim appended without digests', 2, ['INVALID_LEDGER_DIGEST'], ledgerAt(), (l) => {
    third({ state: 'RELEASED' })(l);
    const added = l.claims[l.claims.length - 1];
    delete added.prev_digest;
    delete added.entry_digest;
  }, AS_EDITED),
  c('tamper-counter-raised', 'counters.T00 raised from 2 to 3; head_digest left as it was', 2, ['LEDGER_HEAD_DIGEST_MISMATCH'], ledgerAt(), (l) => { l.counters.T00 = 3; }, AS_EDITED),
  c('tamper-counter-lowered', 'counters.T00 lowered from 3 to 2 in a ledger sealed with 3, which every other check accepts', 2, ['LEDGER_HEAD_DIGEST_MISMATCH'], ledgerAt(), (l) => {
    l.counters.T00 = 3;
    Object.assign(l, sealLedger(l).ledger);
    l.counters.T00 = 2;
  }, AS_EDITED),
  c('tamper-entry-digest-malformed', 'entry_digest of T05-0001 is xyz', 2, ['INVALID_LEDGER_DIGEST'], ledgerAt(), set('T05-0001', { entry_digest: 'xyz' }), AS_EDITED),
  c('tamper-prev-digest-missing', 'prev_digest of T05-0001 removed', 2, ['INVALID_LEDGER_DIGEST'], ledgerAt(), (l) => { delete claim(l, 'T05-0001').prev_digest; }, AS_EDITED),
  c('tamper-head-digest-missing', 'head_digest removed', 2, ['INVALID_LEDGER_DIGEST'], ledgerAt(), (l) => { delete l.head_digest; }, AS_EDITED),
  c('tamper-head-digest-uppercase', 'head_digest in upper case', 2, ['INVALID_LEDGER_DIGEST'], ledgerAt(), (l) => { l.head_digest = l.head_digest.toUpperCase(); }, AS_EDITED),
  c('tamper-head-digest-replaced', 'head_digest replaced by 64 zeros', 2, ['LEDGER_HEAD_DIGEST_MISMATCH'], ledgerAt(), (l) => { l.head_digest = '0'.repeat(64); }, AS_EDITED),

  c('pin-matches', 'none: the head digest of the fixture given as the pin', 0, [], ledgerAt(AT, FIXTURE_HEAD)),
  c('reseal-rewrite-unpinned', 'T00-0002 expires_at moved two hours later and the ledger sealed anew; no pin given', 0, [], ledgerAt(), set('T00-0002', LATER)),
  c('reseal-rewrite-pinned', 'the same rewrite, judged with the head digest of the original as the pin', 2, ['LEDGER_HEAD_PIN_MISMATCH'], ledgerAt(AT, FIXTURE_HEAD), set('T00-0002', LATER)),

  c('lease-expired', 'judged 30 minutes after the end of an ACTIVE claim', 2, ['LEASE_EXPIRED'], ledgerAt('2026-10-09T02:30:00Z')),
  c('lease-ends-exactly-now', 'judged at the instant a lease ends (the end is exclusive)', 2, ['LEASE_EXPIRED'], ledgerAt('2026-10-09T02:00:00Z')),
  c('lease-starts-exactly-now', 'judged at the instant a lease starts (the start is inclusive)', 0, [], ledgerAt('2026-10-09T00:30:00Z')),
  c('lease-not-started', 'judged before an ACTIVE claim was issued', 2, ['LEASE_NOT_STARTED'], ledgerAt('2026-10-09T00:15:00Z')),
  c('expired-other-claim', 'a released claim of T07 set back to ACTIVE after its end', 2, ['LEASE_EXPIRED'], ledgerAt(), set('T07-0001', { state: 'ACTIVE' })),

  c('conflict-same-track', 'a second live claim of T00 inside the first', 2, ['ACTIVE_SCOPE_CONFLICT'], ledgerAt(), third({ path_scopes: ['next/t00/fixtures/**'] })),
  c('conflict-case-insensitive', 'the same, written with other case', 2, ['ACTIVE_SCOPE_CONFLICT', 'SCOPE_OUTSIDE_OWNERSHIP'], ledgerAt(), third({ path_scopes: ['Next/T00/fixtures/**'] })),
  c('conflict-case-insensitive-earlier', 'the first claim is written with other case', 2, ['ACTIVE_SCOPE_CONFLICT', 'SCOPE_OUTSIDE_OWNERSHIP'], ledgerAt(), (l) => {
    claim(l, 'T00-0002').path_scopes[0] = 'Next/T00/**';
    third({ path_scopes: ['next/t00/fixtures/**'] })(l);
  }),
  c('conflict-file-inside-directory', 'a second live claim of T00 for one file inside the directory of the first', 2, ['ACTIVE_SCOPE_CONFLICT'], ledgerAt(), third({ path_scopes: ['next/t00/lease-ledger.mjs'] })),
  c('conflict-other-track', 'T05 claims next/t00/**, which T00-0002 holds', 2, ['ACTIVE_SCOPE_CONFLICT', 'SCOPE_OUTSIDE_OWNERSHIP'], ledgerAt(), set('T05-0001', { path_scopes: ['next/t00/**'] })),
  c('no-conflict-released', 'the same second claim, RELEASED', 0, [], ledgerAt(), third({ path_scopes: ['next/t00/fixtures/**'], state: 'RELEASED' })),
  c('no-conflict-disjoint-scopes', 'a second live claim of T00 for a file that the first does not hold', 0, [], ledgerAt(), third({ path_scopes: ['test/t00-lease.test.mjs'] })),

  c('result-normal', 'none: two paths inside the claim', 0, [], resultOf({ paths: [...OWN, 'test/t00-baseline.test.mjs'] })),
  c('result-path-dot-slash', 'a path with a leading ./', 0, [], resultOf(only(`./${OWN[0]}`))),
  c('result-last-second', 'result judged one second before the lease ends', 0, [], resultOf({ at: '2026-10-09T01:59:59Z' })),
  c('result-ignores-expired-other-claim', 'an expired ACTIVE claim of another track does not block a result', 0, [], resultOf(), set('T07-0001', { state: 'ACTIVE' })),
  c('result-unknown-claim', 'claim id T00-9999', 2, ['UNKNOWN_CLAIM'], resultOf({ id: 'T00-9999' })),
  c('result-claim-released', 'result of a RELEASED claim', 2, ['RESULT_CLAIM_NOT_ACTIVE'], resultOf({ at: '2026-10-09T00:45:00Z', id: 'T07-0001', token: '1', base: HEAD, ...only('next/t07/a.mjs') })),
  c('result-claim-expired-zombie', 'a worker presents the EXPIRED claim T00-0001 with its old token 1 after T00-0002 was issued', 2, ['RESULT_AFTER_LEASE_EXPIRY', 'RESULT_CLAIM_NOT_ACTIVE', 'RESULT_STALE_FENCING_TOKEN'], resultOf({ id: 'T00-0001', token: '1' })),
  c('result-after-expiry', 'result judged 30 minutes after the lease ended', 2, ['RESULT_AFTER_LEASE_EXPIRY'], resultOf({ at: '2026-10-09T02:30:00Z' })),
  c('result-at-expiry', 'result judged at the instant the lease ends', 2, ['RESULT_AFTER_LEASE_EXPIRY'], resultOf({ at: '2026-10-09T02:00:00Z' })),
  c('result-before-lease', 'result judged before the lease was issued', 2, ['LEASE_NOT_STARTED'], resultOf({ at: '2026-10-09T00:15:00Z', id: 'T05-0001', token: '1', base: HEAD, ...only('scanners/language/jvm/a.mjs') })),
  c('result-wrong-worker', 'worker wp-t05 presents the claim held by wp-t00', 2, ['RESULT_WRONG_HOLDER'], resultOf({ worker: 'wp-t05' })),
  c('result-wrong-worktree', 'worktree agents/t05 presents the claim held in agents/t00', 2, ['RESULT_WRONG_HOLDER'], resultOf({ worktree: 'agents/t05' })),
  c('result-holder-in-other-case', 'worker WP-T00, the holder written with other case', 2, ['RESULT_WRONG_HOLDER'], resultOf({ worker: 'WP-T00' })),
  c('result-token-lower', 'result carries token 1 for a claim with token 2', 2, ['RESULT_FENCING_TOKEN_MISMATCH', 'RESULT_STALE_FENCING_TOKEN'], resultOf({ token: '1' })),
  c('result-token-higher', 'result carries token 3 for a claim with token 2', 2, ['RESULT_FENCING_TOKEN_MISMATCH'], resultOf({ token: '3' })),
  c('result-token-superseded', 'token 2 matches its claim but 3 was issued since', 2, ['RESULT_STALE_FENCING_TOKEN'], resultOf(), (l) => { l.counters.T00 = 3; }),
  c('result-base-other', 'result made on another base', 2, ['RESULT_BASE_SHA_MISMATCH'], resultOf({ base: HEAD })),
  c('result-base-short', 'result base is abc', 2, ['INVALID_BASE_SHA'], resultOf({ base: 'abc' })),
  c('result-head-short', 'result head is abc', 2, ['INVALID_RESULT_HEAD_SHA'], resultOf({ head: 'abc' })),
  c('result-no-paths', 'a result with a bad head that names no path', 2, ['INVALID_RESULT_HEAD_SHA', 'INVALID_RESULT_PATH'], resultOf({ head: 'abc', paths: [] })),
  c('result-path-other-track', 'path of track T05', 2, ['RESULT_PATH_OUTSIDE_CLAIM'], resultOf(only('next/t05/a.mjs'))),
  c('result-path-hot', 'path package.json', 2, ['RESULT_PATH_OUTSIDE_CLAIM'], resultOf(only('package.json'))),
  c('result-path-owned-not-leased', 'a test file that T00 owns and the claim does not lease', 2, ['RESULT_PATH_OUTSIDE_CLAIM'], resultOf(only('test/t00-ownership.test.mjs'))),
  c('result-path-sibling-prefix', 'next/t00x/a.mjs, a name that starts like the leased directory', 2, ['RESULT_PATH_OUTSIDE_CLAIM'], resultOf(only('next/t00x/a.mjs'))),
  c('result-path-one-of-two-outside', 'one path inside the claim and package.json', 2, ['RESULT_PATH_OUTSIDE_CLAIM'], resultOf({ paths: [...OWN, 'package.json'] })),
  c('result-path-case', 'path in other case', 2, ['RESULT_PATH_OUTSIDE_CLAIM'], resultOf(only('Next/t00/a.mjs'))),
  c('result-path-directory-itself', 'the directory name of a /** scope', 2, ['RESULT_PATH_OUTSIDE_CLAIM'], resultOf(only('next/t00'))),
  c('result-path-traversal', 'path ../x', 2, ['INVALID_RESULT_PATH'], resultOf(only('../x'))),
  c('result-path-backslash', 'path with backslashes', 2, ['INVALID_RESULT_PATH'], resultOf(only('next\\t00\\a.mjs'))),
  c('result-path-absolute', 'absolute path', 2, ['INVALID_RESULT_PATH'], resultOf(only('/etc/passwd'))),
  c('result-ledger-invalid', 'the result is fine but the ledger holds a conflict', 2, ['ACTIVE_SCOPE_CONFLICT'], resultOf(), third({ path_scopes: ['next/t00/fixtures/**'] })),
  c('result-ledger-tampered', 'the result is fine but T00-0002 was edited after it was sealed', 2, ['LEDGER_ENTRY_DIGEST_MISMATCH'], resultOf(), set('T00-0002', LATER), AS_EDITED),
  c('result-ledger-version-2', 'the result is fine but the ledger has schema /2', 3, ['LEDGER_VERSION_UNSUPPORTED'], resultOf(), (l) => { l.schema = 'bskel.t00-lease-ledger/2'; }, AS_EDITED),

  c('usage-unknown-command', 'command verify', 1, [], ['verify', '--ledger', LEDGER, '--at', AT]),
  c('usage-no-ledger-flag', 'no --ledger', 1, [], ['ledger', '--at', AT]),
  c('usage-no-at', 'no --at', 1, [], ['ledger', '--ledger', LEDGER]),
  c('usage-bad-at', '--at tomorrow', 1, [], ledgerAt('tomorrow')),
  c('usage-bad-head-digest', '--head-digest abc', 1, [], ledgerAt(AT, 'abc')),
  c('usage-no-claim-flag', 'result without --claim', 1, [], without(resultOf(), '--claim')),
  c('usage-no-worker-flag', 'result without --worker', 1, [], without(resultOf(), '--worker')),
  c('usage-no-worktree-flag', 'result without --worktree', 1, [], without(resultOf(), '--worktree')),
  c('usage-token-not-number', '--token two', 1, [], resultOf({ token: 'two' })),
  c('usage-ledger-with-paths', 'ledger command given a path', 1, [], [...ledgerAt(), 'next/t00/a.mjs']),
  c('usage-ledger-file-missing', 'the ledger file does not exist', 1, [], ledgerAt(), undefined, { missing: true }),
  c('usage-ledger-is-a-directory', 'the ledger path is a directory', 1, [], ledgerAt(), undefined, { directory: true }),
  c('usage-ledger-under-a-file', 'the ledger path goes through a regular file', 1, [], ['ledger', '--ledger', `${LEDGER}/under.json`, '--at', AT]),
  c('usage-ledger-empty-file', 'the ledger file is empty', 1, [], ledgerAt(), undefined, { raw: '' }),
  c('usage-ledger-not-json', 'the ledger file is not JSON', 1, [], ledgerAt(), undefined, { raw: '{ not json' }),
];

function ledgerText(x) {
  const ledger = fixture();
  x.change?.(ledger);
  if (x.seal === false) return JSON.stringify(ledger);
  const sealed = sealLedger(ledger);
  if (sealed.problem !== undefined) throw new Error(`${x.id}: the changed ledger cannot be sealed (${sealed.problem}); declare it with seal: false`);
  return JSON.stringify(sealed.ledger);
}

function prepare(x, dir) {
  const file = path.join(dir, 'ledger.json');
  if (x.directory) fs.mkdirSync(file);
  else if (x.raw !== undefined) fs.writeFileSync(file, x.raw);
  else if (!x.missing) fs.writeFileSync(file, ledgerText(x));
  return {
    argv: x.args.map((a) => a.replaceAll(LEDGER, file)),
    display: ['node', 'next/t00/check-lease.mjs', ...x.args].join(' '),
    scrub: [file, path.join(fs.realpathSync(dir), 'ledger.json')],
    placeholder: LEDGER,
  };
}

// Runs the cases against the CLI at `cli` (this checkout's, or a copy under test) and returns what each one printed.
export const recordCases = (cli, cases) => runAll(cli, cases.map((x) => ({ ...x, prepare: (dir) => prepare(x, dir) })));

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
    cases: await recordCases(CLI, cases),
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
