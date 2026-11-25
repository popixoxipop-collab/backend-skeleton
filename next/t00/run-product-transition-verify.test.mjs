import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeWithPathReceipt, exactPrCiRunId, verifyProductWorkflowEvent } from './run-product-transition-verify.mjs';

const repo = { id: 1334919554, full_name: 'popixoxipop-collab/backend-skeleton' };
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const subject = { pr: 395, base, head };
const workflow = '.github/workflows/t00-product-replay.yml';
const actor = { id: 261965176 };
const result = workflow_runs => ({ total_count: workflow_runs.length, workflow_runs });

function ciRun(overrides = {}) {
  return { id: 90, run_number: 100, run_attempt: 1, path: '.github/workflows/ci.yml', head_sha: head,
    event: 'pull_request', repository: repo, head_repository: repo, status: 'completed', conclusion: 'success',
    pull_requests: [{ number: 395, url: `https://api.github.com/repos/${repo.full_name}/pulls/395`,
      head: { sha: head, ref: `dot/t00-publisher/${head}`, repo }, base: { sha: base, ref: 'main', repo } }],
    ...overrides };
}

function upstream(overrides = {}) {
  return { action: 'completed', repository: repo, workflow_run: { id: 92, run_attempt: 1, workflow_id: 430570167,
    path: workflow, status: 'completed', conclusion: 'success', event: 'issue_comment', head_branch: 'main',
    head_sha: base, repository: repo, head_repository: repo, actor, triggering_actor: actor, ...overrides } };
}

test('accepts the expected completed product attempt on the protected base', () => {
  assert.deepEqual(verifyProductWorkflowEvent(upstream(), base), { runId: 92, attempt: 1 });
  for (const changed of [{ head_sha: head }, { workflow_id: 1 }, { event: 'pull_request' }, { conclusion: 'skipped' },
    { triggering_actor: { id: 55 } }, { head_repository: { ...repo, id: 11 } }]) {
    assert.throws(() => verifyProductWorkflowEvent(upstream(changed), base), /HOLD_TRANSITION_VERIFY_EVENT/);
  }
});

test('uses the latest exact PR CI identity and holds on partial listings or ambiguous completion', () => {
  assert.equal(exactPrCiRunId(result([ciRun(), ciRun({ id: 99, run_number: 101 })]), subject), 99);
  assert.throws(() => exactPrCiRunId({ total_count: 2, workflow_runs: [ciRun()] }, subject),
    /HOLD_TRANSITION_VERIFY_CI_LIST/);
  for (const changed of [{ id: 99 }, { id: 99, run_number: 101, status: 'queued', conclusion: null }]) {
    assert.throws(() => exactPrCiRunId(result([ciRun(), ciRun(changed)]), subject),
      /HOLD_TRANSITION_VERIFY_CI_PENDING_OR_AMBIGUOUS/);
  }
});

test('does not use an unrelated run even when the commit or the PR number overlaps', () => {
  for (const changed of [{ event: 'push' }, { head_sha: base }, { path: '.github/workflows/other.yml' },
    { pull_requests: [{ ...ciRun().pull_requests[0], base: { sha: head, ref: 'main', repo } }] },
    { pull_requests: [{ ...ciRun().pull_requests[0], number: 396 }] }]) {
    assert.throws(() => exactPrCiRunId(result([ciRun(changed)]), subject),
      /HOLD_TRANSITION_VERIFY_CI_PENDING_OR_AMBIGUOUS/);
  }
});

test('waits only for the independent path check and preserves time for the signed request', async () => {
  const pending = new Error('HOLD_DOT_TRANSITION_INDEPENDENT_REVIEW');
  let now = 1000;
  const waits = [];
  const options = {
    clock: () => now,
    delay: async milliseconds => {
      waits.push(milliseconds);
      now += milliseconds / 1000;
    },
  };
  let checks = 0;
  const receipt = await authorizeWithPathReceipt(async (candidate, action) => {
    assert.equal(candidate, subject);
    assert.equal(action, 'merge');
    if (++checks === 1) throw pending;
    return { verified: true };
  }, { subject, expiresAt: 1600 }, options);
  assert.deepEqual(receipt, { verified: true });
  assert.equal(checks, 2);
  assert.equal(waits.length, 1);

  waits.length = 0;
  await assert.rejects(authorizeWithPathReceipt(async () => {
    throw pending;
  }, { subject, expiresAt: now + 31 }, options), pending);
  assert.deepEqual(waits, [1000]);

  waits.length = 0;
  const refused = new Error('HOLD_DOT_TRANSITION_PROTECTED_BASE');
  await assert.rejects(authorizeWithPathReceipt(async () => {
    throw refused;
  }, { subject, expiresAt: 1600 }, options), refused);
  assert.deepEqual(waits, []);
});
