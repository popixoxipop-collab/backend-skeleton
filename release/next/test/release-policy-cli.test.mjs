import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as policy from '../release-policy.mjs';
import {
  IDENTITY_PACK, INVENTORY_PATH, MANIFEST_PATH, PLAN_PATH, ROLES,
  capture, clone, fakeGithubFetch, fileRef, inventory, plan, repoOf,
} from './policy-fixtures.mjs';

const TOKEN = 'ghp_SENTINEL_0123456789abcdef';
const COMMITTED = [INVENTORY_PATH, PLAN_PATH, MANIFEST_PATH];
const urlOf = (role) => `https://api.github.com/repos/${repoOf(inventory, role).repo}/actions/runs/${repoOf(inventory, role).verification.ci_run}`;

// Offline output of the unmodified CLI for the committed files; the CLI may only add keys to it.
const OFFLINE_GOLDEN = {
  evidence_authority: { ok: false, absent: true, ref: null, errors: [] },
  evidence_store: { ok: true, errors: [], resolved_entries: 0 },
  activation_lease: { ok: false, absent: true, errors: [{ code: 'DEFAULT_ACTIVATION_LEASE_REQUIRED' }] },
};

async function run(argv, { env = {}, fetchImpl, sleep = async () => {} } = {}) {
  const io = capture();
  const fetchSpy = fetchImpl ?? fakeGithubFetch(inventory);
  const code = await policy.runCli(argv, { env, fetchImpl: fetchSpy, sleep, stdout: io.stdout, stderr: io.stderr });
  let json = null;
  try { json = JSON.parse(io.out()); } catch { /* usage errors print no JSON */ }
  return { code, json, stdout: io.out(), stderr: io.err(), fetchSpy, sleep };
}

function filesFor(t, inv = inventory, pl = plan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return file;
  };
  return [write('inventory.json', inv), write('plan.json', pl), MANIFEST_PATH];
}

test('offline by default: same verdict and output as before, an explicit online section, no network, no token needed', async () => {
  const r = await run(['verify', ...COMMITTED], { env: { GH_TOKEN: TOKEN } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.fetchSpy.calls.length, 0, 'offline verification must not touch the network');
  assert.equal(r.stdout, JSON.stringify(r.json, null, 2) + '\n');
  assert.deepEqual(Object.keys(r.json).sort(), ['activation_lease', 'evidence_authority', 'evidence_store', 'inventory', 'ok', 'online', 'release_plan']);
  assert.equal(r.json.ok, true);
  for (const [key, expected] of Object.entries(OFFLINE_GOLDEN)) assert.deepEqual(r.json[key], expected, key);
  assert.deepEqual(r.json.release_plan, { ok: true, errors: [] });
  assert.deepEqual(r.json.inventory, { ok: true, errors: [], observed_blockers: ['INDEPENDENT_QA_NOT_READY', 'TRUST_POLICY_NOT_READY'], waived_evidence: [] });
  assert.deepEqual(r.json.online, { enabled: false, checked_roles: [], not_checked_roles: ROLES, runs: [], errors: [] });
});

test('--online checks all three pinned runs in canonical order and reports them', async () => {
  const r = await run(['verify', '--online', ...COMMITTED]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.fetchSpy.calls.map((c) => c.url), ROLES.map(urlOf));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.online.enabled, true);
  assert.equal(r.json.online.ok, true);
  assert.deepEqual(r.json.online.checked_roles, ROLES);
  assert.deepEqual(r.json.online.not_checked_roles, []);
  assert.deepEqual(r.json.online.runs.map((x) => [x.role, x.ok]), ROLES.map((role) => [role, true]));
  assert.deepEqual(r.json.online.errors, []);
});

test('--online-roles limits the check and the output names the roles that were not checked', async () => {
  const forms = [
    [['--online', '--online-roles', 'bskel'], ['bskel'], ['becoder', 'beval']],
    [['--online', '--online-roles=bskel'], ['bskel'], ['becoder', 'beval']],
    [['--online-roles', 'bskel', '--online'], ['bskel'], ['becoder', 'beval']],
    [['--online-roles=bskel,beval', '--online'], ['bskel', 'beval'], ['becoder']],
    [['--online', '--online-roles', 'beval,bskel'], ['bskel', 'beval'], ['becoder']],
    [['--online', '--online-roles', 'bskel,becoder,beval'], ROLES, []],
  ];
  for (const [flags, checked, notChecked] of forms) {
    const r = await run(['verify', ...flags, ...COMMITTED]);
    assert.equal(r.code, 0, `${flags.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.deepEqual(r.fetchSpy.calls.map((c) => c.url), checked.map(urlOf), flags.join(' '));
    assert.deepEqual(r.json.online.checked_roles, checked, flags.join(' '));
    assert.deepEqual(r.json.online.not_checked_roles, notChecked, flags.join(' '));
  }
});

function runBody(field, value) {
  const bskel = repoOf(inventory, 'bskel');
  const body = {
    id: bskel.verification.ci_run,
    repository: { full_name: bskel.repo },
    event: 'push',
    head_branch: 'main',
    head_sha: bskel.verification.ci_head_sha,
    status: 'completed',
    conclusion: 'success',
  };
  body[field] = value;
  return body;
}

test('an online failure exits 2 with ok false and a distinct code, even though the offline checks pass', async () => {
  const cases = [
    ['ONLINE_RUN_NOT_FOUND', { status: 404, body: { message: 'Not Found' } }, 1],
    ['ONLINE_RUN_UNAUTHORIZED', { status: 403, body: { message: 'Resource not accessible by integration' } }, 1],
    ['ONLINE_RUN_UNREACHABLE', { throw: new TypeError('fetch failed') }, 3],
    ['ONLINE_RUN_UNREACHABLE', { status: 503, body: null }, 3],
    ['ONLINE_RUN_MISMATCH', { status: 200, body: runBody('event', 'pull_request') }, 1],
  ];
  for (const [code, override, attempts] of cases) {
    const fetchImpl = fakeGithubFetch(inventory, { bskel: override });
    const sleeps = [];
    const r = await run(['verify', '--online', '--online-roles', 'bskel', ...COMMITTED], { fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(r.code, 2, code);
    assert.equal(r.json.ok, false, code);
    assert.equal(r.json.inventory.ok, true, 'the offline checks themselves still pass');
    assert.equal(r.json.release_plan.ok, true);
    assert.equal(r.json.online.ok, false);
    assert.deepEqual(r.json.online.errors.map((e) => [e.code, e.role]), [[code, 'bskel']], code);
    assert.equal(fetchImpl.calls.length, attempts, `${code}: attempts`);
    assert.equal(sleeps.length, attempts - 1, `${code}: pauses between attempts`);
  }
});

test('the mismatch output names the failing field with expected and actual values', async () => {
  const fetchImpl = fakeGithubFetch(inventory, { bskel: { status: 200, body: runBody('head_branch', 'feature/x') } });
  const r = await run(['verify', '--online', '--online-roles', 'bskel', ...COMMITTED], { fetchImpl });
  assert.equal(r.code, 2);
  assert.deepEqual(r.json.online.errors, [{ code: 'ONLINE_RUN_MISMATCH', role: 'bskel', field: 'head_branch', expected: 'main', actual: 'feature/x' }]);
});

test('an offline failure still exits 2 and --online still reports its section', async (t) => {
  const broken = clone(inventory);
  broken.schema = 'bskel.scale-release-compatibility/0';
  const r = await run(['verify', '--online', '--online-roles', 'bskel', ...filesFor(t, broken)]);
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.inventory.errors.some((e) => e.code === 'INVENTORY_SCHEMA'));
  assert.equal(r.json.online.enabled, true);
  assert.equal(r.json.online.ok, true);
});

test('usage and flag errors exit 1 with no JSON on stdout and no network traffic', async () => {
  const [inv, pl, man] = COMMITTED;
  const cases = [
    [[], 'no command'],
    [['verify'], 'no files'],
    [['verify', inv, pl], 'manifest missing'],
    [['frobnicate', ...COMMITTED], 'unknown command'],
    [['verify', '--online-roles', 'bskel', ...COMMITTED], '--online-roles without --online'],
    [['verify', '--online-roles=bskel', ...COMMITTED], '--online-roles= without --online'],
    [['verify', '--online', '--online-roles'], 'missing --online-roles value'],
    [['verify', '--online', '--online-roles', '', ...COMMITTED], 'empty --online-roles value'],
    [['verify', '--online', '--online-roles=', ...COMMITTED], 'empty --online-roles= value'],
    [['verify', '--online', '--online-roles', 'bskel,nope', ...COMMITTED], 'unknown role'],
    [['verify', '--online', '--online-roles', 'bskel,,beval', ...COMMITTED], 'empty role in the list'],
    [['verify', '--online', '--online-roles', 'BSKEL', ...COMMITTED], 'role names are case sensitive'],
    [['verify', '--frobnicate', ...COMMITTED], 'unknown flag'],
    [['verify', '--online=true', ...COMMITTED], 'unknown flag form'],
    [['verify', inv, pl, man, '--online'], 'flags after the files would be silently ignored'],
    [['verify', inv, '--online', pl, man], 'flags between the files'],
  ];
  for (const [argv, label] of cases) {
    const r = await run(argv);
    assert.equal(r.code, 1, label);
    assert.equal(r.stdout, '', label);
    assert.match(r.stderr, /usage: node release-policy\.mjs verify/, label);
    assert.match(r.stderr, /--online/, `${label}: the usage text documents the new flags`);
    assert.equal(r.fetchSpy.calls.length, 0, label);
  }
});

test('each flag error names its own cause on the first line of stderr', async () => {
  const [inv, pl, man] = COMMITTED;
  const cases = [
    [['verify', '--online', '--online-roles'], /--online-roles needs a value/],
    [['verify', '--online', '--online-roles', 'bskel', '--online-roles', 'beval', ...COMMITTED], /--online-roles was given more than once/],
    [['verify', '--online', '--online-roles=bskel', '--online-roles', 'beval', ...COMMITTED], /--online-roles was given more than once/],
    [['verify', '--online', '--online-roles', 'bskel', '--online-roles=beval', ...COMMITTED], /--online-roles was given more than once/],
    [['verify', '--online-roles', 'bskel', ...COMMITTED], /--online-roles requires --online/],
    [['verify', '--online', '--online-roles', '', ...COMMITTED], /--online-roles has an empty entry/],
    [['verify', '--online', '--online-roles', 'bskel,,beval', ...COMMITTED], /--online-roles has an empty entry/],
    [['verify', '--online', '--online-roles', 'bskel,nope', ...COMMITTED], /unknown role in --online-roles: nope/],
    [['verify', '--frobnicate', ...COMMITTED], /unknown option: --frobnicate/],
    [['verify', inv, pl, man, '--online'], /options must come directly after "verify", before the files: --online/],
    [['verify', '--online'], /verify needs an inventory, a release plan and an evidence manifest/],
    [['frobnicate', ...COMMITTED], /unknown command: frobnicate/],
    [[], /missing command/],
  ];
  for (const [argv, cause] of cases) {
    const r = await run(argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.equal(r.stdout, '', argv.join(' '));
    assert.match(r.stderr.split('\n')[0], cause, argv.join(' '));
    assert.equal(r.fetchSpy.calls.length, 0, argv.join(' '));
  }
});

test('an unreadable or malformed inventory or plan exits 1 with a message on stderr and nothing on stdout', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-cli-bad-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  for (const argv of [
    ['verify', path.join(dir, 'missing.json'), PLAN_PATH, MANIFEST_PATH],
    ['verify', bad, PLAN_PATH, MANIFEST_PATH],
    ['verify', INVENTORY_PATH, bad, MANIFEST_PATH],
  ]) {
    const r = await run(argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.trim().length > 0);
    assert.equal(r.fetchSpy.calls.length, 0);
  }
});

test('the optional authority and lease positionals keep their positions after the flags', async () => {
  const absent = await run(['verify', '--online', '--online-roles', 'bskel', ...COMMITTED]);
  assert.equal(absent.json.evidence_authority.absent, true);
  const given = await run(['verify', '--online', '--online-roles', 'bskel', ...COMMITTED, path.join(os.tmpdir(), 'bskel-no-such-authority.json'), 'sha256:' + '0'.repeat(64)]);
  assert.equal(given.json.evidence_authority.absent, false);
  assert.deepEqual(given.json.evidence_authority.errors.map((e) => e.code), ['EVIDENCE_AUTHORITY_UNREADABLE']);
});

test('the token is sent as a bearer credential and never printed, even when a transport error contains it', async () => {
  for (const env of [{ GITHUB_TOKEN: TOKEN }, { GH_TOKEN: TOKEN }]) {
    const ok = await run(['verify', '--online', ...COMMITTED], { env });
    assert.equal(ok.code, 0);
    assert.equal(ok.fetchSpy.calls.length, 3);
    for (const call of ok.fetchSpy.calls) assert.equal(new Headers(call.init.headers).get('authorization'), `Bearer ${TOKEN}`);
    assert.ok(!ok.stdout.includes(TOKEN) && !ok.stderr.includes(TOKEN));

    const leaky = fakeGithubFetch(inventory, { bskel: { throw: new Error(`socket hang up (Authorization: Bearer ${TOKEN})`) } });
    const failed = await run(['verify', '--online', '--online-roles', 'bskel', ...COMMITTED], { env, fetchImpl: leaky });
    assert.equal(failed.code, 2);
    assert.deepEqual(failed.json.online.errors.map((e) => e.code), ['ONLINE_RUN_UNREACHABLE']);
    assert.ok(!failed.stdout.includes(TOKEN) && !failed.stderr.includes(TOKEN), 'the token must be redacted from every error message');
  }
  const anonymous = await run(['verify', '--online', '--online-roles', 'bskel', ...COMMITTED], { env: {} });
  assert.equal(new Headers(anonymous.fetchSpy.calls[0].init.headers).get('authorization'), null);
});

test('a credential that surfaces anywhere in the report is redacted: offline errors, online mismatches and stderr', async (t) => {
  const leaky = clone(inventory);
  repoOf(leaky, 'bskel').repo = TOKEN;
  const offline = await run(['verify', ...filesFor(t, leaky)], { env: { GH_TOKEN: TOKEN } });
  assert.equal(offline.code, 2);
  assert.ok(offline.json.inventory.errors.some((e) => e.code === 'REPOSITORY_IDENTITY_MISMATCH'), 'the offending value is reported back');
  assert.ok(!offline.stdout.includes(TOKEN), 'the offline sections are redacted too');
  assert.match(offline.stdout, /\[redacted\]/);

  // JSON.stringify escapes both the quote and the backslash, so only redaction before serialization can remove this one.
  const awkward = 'tok"en\\secret-0123456789';
  const echoed = fakeGithubFetch(inventory, { bskel: { status: 200, body: runBody('head_branch', awkward) } });
  const online = await run(['verify', '--online', '--online-roles', 'bskel', ...COMMITTED], { env: { GH_TOKEN: awkward }, fetchImpl: echoed });
  assert.equal(online.code, 2);
  assert.deepEqual(online.json.online.errors.map((e) => [e.code, e.field, e.actual]), [['ONLINE_RUN_MISMATCH', 'head_branch', '[redacted]']]);
  assert.ok(!online.stdout.includes(awkward) && !online.stdout.includes(JSON.stringify(awkward).slice(1, -1)));

  const named = await run(['verify', path.join(os.tmpdir(), `${TOKEN}.json`), PLAN_PATH, MANIFEST_PATH], { env: { GH_TOKEN: TOKEN } });
  assert.equal(named.code, 1);
  assert.match(named.stderr, /cannot read inventory/);
  assert.ok(!named.stderr.includes(TOKEN), 'stderr is redacted too');
});

test('runCli reports through its return value and streams only, never through process.exitCode', async () => {
  const before = process.exitCode;
  await run(['verify', '--online', '--online-roles', 'bskel', ...COMMITTED], { fetchImpl: fakeGithubFetch(inventory, { bskel: { status: 404 } }) });
  await run(['verify']);
  assert.equal(process.exitCode, before);
});

test('forgery 1a through the CLI: a fabricated ci_run passes offline and is rejected by --online', async (t) => {
  const forged = clone(inventory);
  repoOf(forged, 'bskel').verification.ci_run = 999999999999;
  const files = filesFor(t, forged);
  const offline = await run(['verify', ...files]);
  assert.equal(offline.code, 0, 'offline verification cannot see the fabrication');
  const online = await run(['verify', '--online', '--online-roles', 'bskel', ...files]);
  assert.equal(online.code, 2);
  assert.deepEqual(online.json.online.errors.map((e) => [e.code, e.role]), [['ONLINE_RUN_NOT_FOUND', 'bskel']]);
  assert.equal(online.fetchSpy.calls[0].url, 'https://api.github.com/repos/popixoxipop-collab/backend-skeleton/actions/runs/999999999999');
});

test('forgery 1b through the CLI: a self-consistent fake head in both files passes offline and fails --online on head_sha', async (t) => {
  const real = repoOf(inventory, 'bskel').verification.ci_head_sha;
  const fake = 'f'.repeat(40);
  const swap = (doc) => JSON.parse(JSON.stringify(doc).replaceAll(real, fake));
  const files = filesFor(t, swap(inventory), swap(plan));
  const offline = await run(['verify', ...files]);
  assert.equal(offline.code, 0, 'the forged heads are consistent across the inventory and the plan');
  const online = await run(['verify', '--online', '--online-roles', 'bskel', ...files]);
  assert.equal(online.code, 2);
  assert.deepEqual(online.json.online.errors, [{ code: 'ONLINE_RUN_MISMATCH', role: 'bskel', field: 'head_sha', expected: fake, actual: real }]);
});

test('forgery 2 through the CLI: flipping t19_03 and t20_03 to ACCEPTED and un-declaring the blockers no longer passes', async (t) => {
  const forged = clone(inventory);
  for (const key of ['t19_03', 't20_03']) forged.promotion_evidence[key].observed_state = 'ACCEPTED';
  const forgedPlan = clone(plan);
  forgedPlan.blockers = forgedPlan.blockers.filter((b) => b !== 'INDEPENDENT_QA_NOT_READY' && b !== 'TRUST_POLICY_NOT_READY');
  const r = await run(['verify', ...filesFor(t, forged, forgedPlan)]);
  assert.equal(r.code, 2, r.stdout);
  assert.equal(r.json.ok, false);
  assert.deepEqual(r.json.inventory.errors.filter((e) => e.code === 'PROMOTION_EVIDENCE_REF_REQUIRED').map((e) => e.key), ['t19_03', 't20_03']);
  assert.deepEqual(r.json.inventory.observed_blockers, ['INDEPENDENT_QA_NOT_READY', 'TRUST_POLICY_NOT_READY']);
});

test('forgery 3 through the CLI: a wrong t01_06 hash no longer passes', async (t) => {
  const forged = clone(inventory);
  const item = forged.promotion_evidence.t01_06;
  item.evidence_ref = fileRef(IDENTITY_PACK, 'c'.repeat(64));
  item.identity_conformance_sha256 = 'c'.repeat(64);
  const r = await run(['verify', ...filesFor(t, forged)]);
  assert.equal(r.code, 2, r.stdout);
  const codes = r.json.inventory.errors.map((e) => e.code);
  assert.ok(codes.includes('PROMOTION_EVIDENCE_REF_SHA256_MISMATCH'));
  assert.ok(codes.includes('IDENTITY_CONFORMANCE_SHA256_MISMATCH'));
  assert.ok(r.json.inventory.observed_blockers.includes('T01_06_NOT_ACCEPTED'));
});
