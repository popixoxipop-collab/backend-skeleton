import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../release-policy.mjs';
import { ROLES, clone, goodRun, inventory, repoOf, scriptedFetchRun } from './policy-fixtures.mjs';

const verifyOnline = (...args) => policy.verifyOnline(...args);
const bskelRun = (mutate) => {
  const run = goodRun(inventory, 'bskel');
  mutate(run);
  return scriptedFetchRun(inventory, () => ({ status: 200, body: run }));
};

test('verifyOnline accepts all three pinned roles when every run matches the inventory', async () => {
  const fetchRun = scriptedFetchRun(inventory);
  const before = clone(inventory);
  const result = await verifyOnline(inventory, { fetchRun });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.checked_roles, ROLES);
  assert.deepEqual(result.not_checked_roles, []);
  assert.deepEqual(result.runs.map((r) => [r.role, r.ok]), ROLES.map((role) => [role, true]));
  assert.deepEqual(fetchRun.calls, ROLES.map((role) => ({ repo: repoOf(inventory, role).repo, runId: repoOf(inventory, role).verification.ci_run })));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'the result must be plain JSON');
  assert.deepEqual(inventory, before, 'the inventory must not be mutated');
});

test('forgery 1a: a fabricated ci_run passes offline but fails online with ONLINE_RUN_NOT_FOUND', async () => {
  const forged = clone(inventory);
  repoOf(forged, 'bskel').verification.ci_run = 999999999999;
  assert.equal(policy.verifyCompatibilityInventory(forged).ok, true, 'offline verification cannot see a fabricated run id');
  const fetchRun = scriptedFetchRun(forged, (_req, role) => (role === 'bskel' ? { status: 404, body: { message: 'Not Found' } } : { status: 200, body: goodRun(forged, role) }));
  const result = await verifyOnline(forged, { fetchRun });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => [e.code, e.role]), [['ONLINE_RUN_NOT_FOUND', 'bskel']]);
  assert.equal(typeof result.errors[0].hint, 'string', 'a 404 is ambiguous for private repositories and must say so');
  assert.deepEqual(result.runs.map((r) => [r.role, r.ok]), [['bskel', false], ['becoder', true], ['beval', true]]);
});

test('forgery 1b: a self-consistent fake head passes offline but fails online on head_sha', async () => {
  const fake = 'f'.repeat(40);
  const forged = clone(inventory);
  const repo = repoOf(forged, 'bskel');
  Object.assign(repo, { head_sha: fake, coordination_sha: fake });
  Object.assign(repo.verification, { reviewed_head_sha: fake, ci_head_sha: fake });
  forged.coordination_baseline.repositories.bskel = fake;
  assert.equal(policy.verifyCompatibilityInventory(forged).ok, true, 'the forged head is internally consistent');
  const realRun = goodRun(inventory, 'bskel');
  const fetchRun = scriptedFetchRun(forged, () => ({ status: 200, body: realRun }));
  const result = await verifyOnline(forged, { roles: ['bskel'], fetchRun });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ code: 'ONLINE_RUN_MISMATCH', role: 'bskel', field: 'head_sha', expected: fake, actual: realRun.head_sha }]);
});

const FIELD_CASES = [
  ['repository.full_name', (run) => { run.repository.full_name = 'someone-else/backend-skeleton'; }],
  ['repository.full_name', (run) => { delete run.repository; }],
  ['event', (run) => { run.event = 'pull_request'; }],
  ['event', (run) => { run.event = 'workflow_dispatch'; }],
  ['event', (run) => { run.event = 'schedule'; }],
  ['head_branch', (run) => { run.head_branch = 'feature/forged'; }],
  ['head_branch', (run) => { run.head_branch = 'Main'; }],
  ['head_branch', (run) => { run.head_branch = null; }],
  ['head_sha', (run) => { run.head_sha = 'f'.repeat(40); }],
  ['head_sha', (run) => { run.head_sha = run.head_sha.toUpperCase(); }],
  ['status', (run) => { run.status = 'in_progress'; }],
  ['status', (run) => { run.status = 'queued'; }],
  ['conclusion', (run) => { run.conclusion = 'failure'; }],
  ['conclusion', (run) => { run.conclusion = 'cancelled'; }],
  ['conclusion', (run) => { run.conclusion = 'neutral'; }],
  ['conclusion', (run) => { run.conclusion = null; }],
  ['id', (run) => { run.id += 1; }],
];

test('each run field that disagrees with the pinned inventory is a distinct ONLINE_RUN_MISMATCH', async () => {
  for (const [field, mutate] of FIELD_CASES) {
    const result = await verifyOnline(inventory, { roles: ['bskel'], fetchRun: bskelRun(mutate) });
    assert.equal(result.ok, false, `${field}: ${mutate}`);
    assert.deepEqual(result.errors.map((e) => [e.code, e.role, e.field]), [['ONLINE_RUN_MISMATCH', 'bskel', field]], String(mutate));
  }
});

test('mismatch errors carry expected and actual values', async () => {
  const result = await verifyOnline(inventory, { roles: ['bskel'], fetchRun: bskelRun((run) => { run.event = 'pull_request'; run.conclusion = null; }) });
  assert.deepEqual(result.errors, [
    { code: 'ONLINE_RUN_MISMATCH', role: 'bskel', field: 'event', expected: 'push', actual: 'pull_request' },
    { code: 'ONLINE_RUN_MISMATCH', role: 'bskel', field: 'conclusion', expected: 'success', actual: null },
  ]);
});

test('an empty JSON object body fails every field check instead of crashing', async () => {
  const fetchRun = scriptedFetchRun(inventory, () => ({ status: 200, body: {} }));
  const result = await verifyOnline(inventory, { roles: ['bskel'], fetchRun });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.field).sort(), ['conclusion', 'event', 'head_branch', 'head_sha', 'id', 'repository.full_name', 'status']);
  assert.ok(result.errors.every((e) => e.code === 'ONLINE_RUN_MISMATCH' && e.actual === null));
});

test('ci_run must be a positive safe integer before any request is made', async () => {
  for (const bad of [0, -1, 1.5, 2 ** 53, 1e21, NaN, Infinity, '36652996212', null, undefined, true, [], {}]) {
    const forged = clone(inventory);
    repoOf(forged, 'bskel').verification.ci_run = bad;
    const fetchRun = scriptedFetchRun(forged);
    const result = await verifyOnline(forged, { roles: ['bskel'], fetchRun });
    assert.deepEqual(result.errors.map((e) => [e.code, e.role]), [['ONLINE_CI_RUN_INVALID', 'bskel']], String(bad));
    assert.equal(result.ok, false);
    assert.equal(fetchRun.calls.length, 0, `no request for ci_run ${String(bad)}`);
  }
});

test('the repository must equal the pinned identity before any request is made', async () => {
  const bad = [
    'evil/backend-skeleton', 'popixoxipop-collab/backend-decoder', 'POPIXOXIPOP-COLLAB/backend-skeleton',
    'popixoxipop-collab/backend-skeleton/', 'popixoxipop-collab/backend-skeleton/../backend-decoder',
    'popixoxipop-collab/backend-skeleton?x=1', 'popixoxipop-collab/backend-skeleton#frag', '', null, undefined, 42,
  ];
  for (const repo of bad) {
    const forged = clone(inventory);
    repoOf(forged, 'bskel').repo = repo;
    const fetchRun = scriptedFetchRun(forged);
    const result = await verifyOnline(forged, { roles: ['bskel'], fetchRun });
    assert.deepEqual(result.errors.map((e) => [e.code, e.role]), [['ONLINE_REPOSITORY_NOT_PINNED', 'bskel']], String(repo));
    assert.equal(fetchRun.calls.length, 0, `no request for repo ${String(repo)}`);
  }
});

test('ci_head_sha must be 40 lowercase hex before any request is made', async () => {
  for (const bad of ['', 'abc', 'g'.repeat(40), 'a'.repeat(39), 'A'.repeat(40), null, undefined, 123]) {
    const forged = clone(inventory);
    repoOf(forged, 'bskel').verification.ci_head_sha = bad;
    const fetchRun = scriptedFetchRun(forged);
    const result = await verifyOnline(forged, { roles: ['bskel'], fetchRun });
    assert.deepEqual(result.errors.map((e) => [e.code, e.role]), [['ONLINE_CI_HEAD_SHA_INVALID', 'bskel']], String(bad));
    assert.equal(fetchRun.calls.length, 0);
  }
});

const HTTP_CASES = [
  ['ONLINE_RUN_NOT_FOUND', { status: 404 }], ['ONLINE_RUN_NOT_FOUND', { status: 410 }],
  ['ONLINE_RUN_UNAUTHORIZED', { status: 401 }], ['ONLINE_RUN_UNAUTHORIZED', { status: 403 }],
  ...[429, 500, 502, 503, 504, 599].map((status) => ['ONLINE_RUN_UNREACHABLE', { status }]),
  ['ONLINE_RUN_UNREACHABLE', { fail: new Error('connect ECONNREFUSED 127.0.0.1:443') }],
  ...[201, 204, 301, 302, 304, 307, 308, 400, 405, 422].map((status) => ['ONLINE_RUN_RESPONSE_INVALID', { status }]),
  ...[null, [], 'ok', 42, true].map((body) => ['ONLINE_RUN_RESPONSE_INVALID', { status: 200, body }]),
  ...[undefined, null, 'ok', {}, { status: '200', body: {} }, { status: 200.5, body: {} }].map((raw) => ['ONLINE_RUN_RESPONSE_INVALID', { raw }]),
];

test('every HTTP outcome other than a matching 200 fails closed with its own code', async () => {
  for (const [code, spec] of HTTP_CASES) {
    const fetchRun = async () => {
      if (spec.fail) throw spec.fail;
      return 'raw' in spec ? spec.raw : { status: spec.status, body: spec.body ?? null };
    };
    const result = await verifyOnline(inventory, { roles: ['bskel'], fetchRun });
    assert.equal(result.ok, false, JSON.stringify(spec));
    assert.deepEqual(result.errors.map((e) => [e.code, e.role]), [[code, 'bskel']], JSON.stringify(spec));
    assert.equal(result.runs[0].ok, false);
  }
});

test('one failing role fails the whole online check but the other roles are still reported', async () => {
  const fetchRun = scriptedFetchRun(inventory, (_req, role) => (role === 'becoder' ? { status: 404, body: null } : { status: 200, body: goodRun(inventory, role) }));
  const result = await verifyOnline(inventory, { fetchRun });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => [e.code, e.role]), [['ONLINE_RUN_NOT_FOUND', 'becoder']]);
  assert.deepEqual(result.runs.map((r) => [r.role, r.ok]), [['bskel', true], ['becoder', false], ['beval', true]]);
  assert.equal(fetchRun.calls.length, 3);
});

test('roles select what is fetched and the result names exactly what was not checked', async () => {
  const fetchRun = scriptedFetchRun(inventory);
  const result = await verifyOnline(inventory, { roles: ['beval', 'bskel', 'bskel'], fetchRun });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checked_roles, ['bskel', 'beval']);
  assert.deepEqual(result.not_checked_roles, ['becoder']);
  assert.deepEqual(fetchRun.calls.map((c) => c.repo), [repoOf(inventory, 'bskel').repo, repoOf(inventory, 'beval').repo]);
});

test('unknown roles, an empty role list, a missing inventory role and a missing fetchRun fail closed', async () => {
  const unknown = scriptedFetchRun(inventory);
  const r1 = await verifyOnline(inventory, { roles: ['bskel', 'nope'], fetchRun: unknown });
  assert.deepEqual(r1.errors.map((e) => [e.code, e.role]), [['ONLINE_ROLE_UNKNOWN', 'nope']]);
  assert.equal(unknown.calls.length, 0, 'nothing is fetched when the role selection is invalid');

  const r2 = await verifyOnline(inventory, { roles: [], fetchRun: scriptedFetchRun(inventory) });
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.errors.map((e) => e.code), ['ONLINE_NO_ROLES']);

  const partial = clone(inventory);
  partial.repositories = partial.repositories.filter((r) => r.role !== 'becoder');
  const fetchRun = scriptedFetchRun(partial);
  const r3 = await verifyOnline(partial, { fetchRun });
  assert.deepEqual(r3.errors.map((e) => [e.code, e.role]), [['ONLINE_ROLE_MISSING', 'becoder']]);
  assert.deepEqual(fetchRun.calls.map((c) => c.repo), [repoOf(inventory, 'bskel').repo, repoOf(inventory, 'beval').repo]);

  await assert.rejects(() => verifyOnline(inventory, {}), TypeError);
  await assert.rejects(() => verifyOnline(inventory), TypeError);
});
