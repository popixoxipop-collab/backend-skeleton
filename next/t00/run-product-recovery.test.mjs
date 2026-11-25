import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverablePostmergeJob, recoveryCILineage } from './run-product-recovery.mjs';

const repositoryId = 1334919554;
const workflowId = 430570999;
const created_at = '2026-11-25T16:48:00Z';
const updated_at = '2026-11-25T17:03:00Z';
const now = Date.parse('2026-11-25T17:11:00Z');
const scope = { workflowId, now };
const run = { id: 91, workflow_id: workflowId, path: '.github/workflows/t00-product-transition.yml',
  event: 'workflow_run', head_branch: 'main', repository: { id: repositoryId }, head_repository: { id: repositoryId },
  status: 'completed', conclusion: 'failure', run_attempt: 2, head_sha: 'a'.repeat(40), created_at, updated_at };
const merge = { name: 'merge', id: 20, run_id: run.id, status: 'completed', conclusion: 'success',
  run_attempt: 1, head_sha: run.head_sha };
const postmerge = { ...merge, name: 'postmerge', id: 35, conclusion: 'timed_out', run_attempt: 2 };
const listing = (...jobs) => ({ total_count: jobs.length, jobs });

test('only the failed postmerge job of a recent merged transition is recoverable', () => {
  assert.equal(recoverablePostmergeJob(run, listing(merge, postmerge), scope), postmerge.id);
  assert.equal(recoverablePostmergeJob(run, listing(postmerge), scope), null);
  assert.equal(recoverablePostmergeJob(run, listing({ ...merge, conclusion: 'failure' }, postmerge), scope), null);
  assert.equal(recoverablePostmergeJob(run, listing(merge, { ...postmerge, conclusion: 'success' }), scope), null);
  assert.equal(recoverablePostmergeJob(run, listing(merge, { ...postmerge, run_id: 92 }), scope), null);
  assert.equal(recoverablePostmergeJob(run, listing(merge, postmerge, { ...postmerge, id: 36 }), scope), null);
});

test('recovery holds foreign runs, partial pagination, old evidence and excessive retries', () => {
  const complete = listing(merge, postmerge);
  for (const update of [{ event: 'pull_request' }, { workflow_id: 21 }, { head_repository: { id: 134 } },
    { status: 'in_progress' }, { run_attempt: 3 }, { created_at: '2026-11-24T16:00:00Z' }]) {
    assert.equal(recoverablePostmergeJob({ ...run, ...update }, complete, scope), null);
  }
  assert.equal(recoverablePostmergeJob(run, { ...complete, total_count: 3 }, scope), null);
});

const repo = { id: repositoryId, full_name: 'popixoxipop-collab/backend-skeleton' };
const bot = { id: 361175685, login: 't00-dot-draft-publisher[bot]', type: 'Bot' };
const owner = { id: 261965176, login: 'popixoxipop-collab', type: 'User' };
const ciWorkflowId = 338234334;
const base = run.head_sha;
const head = 'b'.repeat(40);
const merged = 'c'.repeat(40);
const tree = 'd'.repeat(40);
const laterMain = 'e'.repeat(40);
const merged_at = '2026-11-25T17:02:10Z';
const ci = { id: 78, workflow_id: ciWorkflowId, path: '.github/workflows/ci.yml', event: 'push',
  status: 'completed', conclusion: 'success', actor: bot, triggering_actor: bot, repository: repo,
  head_repository: repo, head_branch: 'main', head_sha: merged, run_attempt: 1,
  created_at: '2026-11-25T17:02:10Z', updated_at: '2026-11-25T17:10:00Z' };
const event = { action: 'completed', repository: repo, workflow_run: ci };
const pull = { number: 400, state: 'closed', merged: true, draft: false, merge_commit_sha: merged, merged_at,
  user: bot, merged_by: bot, base: { ref: 'main', repo }, head: { ref: 'dot/t00-publisher/' + head, sha: head, repo } };
const pullPath = '/pulls/400';
const ancestryPath = '/compare/' + merged + '...' + laterMain + '?per_page=1';
const candidatePath = '/git/commits/' + head;

function githubFixture(changes = {}) {
  const responses = {
    '/actions/workflows/ci.yml': { id: ciWorkflowId, name: 'CI', path: ci.path, state: 'active' },
    '/actions/runs/78': ci,
    ['/git/commits/' + merged]: { sha: merged, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] },
    ['/commits/' + merged + '/pulls?per_page=100']: [{ number: 400, merge_commit_sha: merged, base: { ref: 'main' } }],
    '/branches/main': { name: 'main', protected: true, commit: { sha: laterMain } },
    [pullPath]: pull,
    [candidatePath]: { sha: head, parents: [{ sha: base }], tree: { sha: tree } },
    [ancestryPath]: { status: 'ahead', merge_base_commit: { sha: merged } },
    ...changes,
  };
  return async path => {
    assert.ok(Object.hasOwn(responses, path), 'unexpected GET ' + path);
    return responses[path];
  };
}

test('successful exact Bot push CI selects only a bounded failed postmerge of the same merge window', async () => {
  const ciLineage = await recoveryCILineage(event, githubFixture(), now);
  assert.deepEqual(ciLineage, { base, head, merge: merged, mergedAt: Date.parse(merged_at), ciRunId: 78, ciAttempt: 1, pr: 400 });
  const original = { ...merge, started_at: '2026-11-25T17:02:00Z', completed_at: '2026-11-25T17:02:25Z' };
  const job = recoverablePostmergeJob(run, listing(original, postmerge), { ...scope, ciLineage });
  assert.equal(job, postmerge.id);
  assert.equal(recoverablePostmergeJob(run, listing({ ...original, completed_at: '2026-11-25T17:02:00Z' }, postmerge),
    { ...scope, ciLineage }), null);
  assert.equal(recoverablePostmergeJob(run, listing(original, postmerge), { ...scope, ciLineage: {
    ...ciLineage, base: 'f'.repeat(40),
  } }), null);
});

test('PR, owner, failed, and unrelated workflow events stop before any GitHub reads', async () => {
  for (const change of [{ event: 'pull_request' }, { actor: owner }, { conclusion: 'failure' },
    { workflow_id: 430570167 }, { path: '.github/workflows/other.yml' }, { head_branch: 'topic' },
    { head_repository: { ...repo, id: 5 } }]) {
    await assert.rejects(recoveryCILineage({ ...event, workflow_run: { ...ci, ...change } },
      () => { throw new Error('unexpected GitHub read'); }, now), /HOLD_POSTMERGE_RECOVERY_CI_EVENT/u);
  }
});

test('latest GitHub identity, Bot merger, candidate tree, and protected ancestry must match', async () => {
  await assert.rejects(recoveryCILineage(event, githubFixture({
    '/actions/runs/78': { ...ci, run_attempt: 2 },
  }), now), /HOLD_POSTMERGE_RECOVERY_CI_PROOF/u);
  await assert.rejects(recoveryCILineage(event, githubFixture({
    '/actions/runs/78': { ...ci, triggering_actor: owner },
  }), now), /HOLD_POSTMERGE_RECOVERY_CI_PROOF/u);
  await assert.rejects(recoveryCILineage(event, githubFixture({
    [pullPath]: { ...pull, merged_by: owner },
  }), now), /HOLD_POSTMERGE_RECOVERY_CI_MERGE/u);
  await assert.rejects(recoveryCILineage(event, githubFixture({
    [candidatePath]: { sha: head, parents: [{ sha: base }], tree: { sha: base } },
  }), now), /HOLD_POSTMERGE_RECOVERY_CI_MERGE/u);
  await assert.rejects(recoveryCILineage(event, githubFixture({
    [ancestryPath]: { status: 'diverged', merge_base_commit: { sha: base } },
  }), now), /HOLD_POSTMERGE_RECOVERY_CI_LINEAGE/u);
});
