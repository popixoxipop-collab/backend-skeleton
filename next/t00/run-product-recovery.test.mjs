import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverablePostmergeJob } from './run-product-recovery.mjs';

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
