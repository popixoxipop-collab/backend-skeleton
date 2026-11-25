import { appendFileSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublisher } from './dot-publisher-github.mjs';
import { mergeExactDotPullRequest, readyExactDotPullRequest, reconcileExactDotMerge } from './t00-exact-ready-merge.mjs';
import { verifyTransitionPermit } from './transition-permit.mjs';

const repo = 'popixoxipop-collab/backend-skeleton';
const repoId = 1334919554;
const approvedWorkflowId = 430570167;
const workflowPath = '.github/workflows/t00-product-transition.yml';

function requireIt(ok, code) {
  if (!ok) throw new Error(code);
}

async function run() {
  const env = process.env;
  requireIt(env.GITHUB_REPOSITORY === repo && env.GITHUB_REPOSITORY_ID === String(repoId) &&
    env.GITHUB_WORKFLOW_REF === `${repo}/${workflowPath}@refs/heads/main` && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_EVENT_NAME === 'workflow_run' && env.GITHUB_EVENT_PATH?.startsWith('/') &&
    env.GITHUB_OUTPUT?.startsWith('/') && typeof env.T00_TRANSITION_PERMIT === 'string' &&
    env.T00_TRANSITION_PERMIT.length <= 6500, 'HOLD_TRANSITION_MERGE_WORKFLOW');
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const permit = JSON.parse(env.T00_TRANSITION_PERMIT);
  const prior = verifyTransitionPermit(permit, { allowExpired: true });
  const { subject, productRunId, productAttempt } = prior;
  const source = event.workflow_run;
  requireIt(event.action === 'completed' && event.repository?.id === repoId && event.repository.full_name === repo &&
    source?.workflow_id === approvedWorkflowId && source.id === productRunId && source.run_attempt === productAttempt &&
    source.event === 'issue_comment' && source.conclusion === 'success' && source.head_branch === 'main' &&
    source.head_sha === subject.base && subject.base === env.GITHUB_SHA, 'HOLD_TRANSITION_MERGE_PROVENANCE');
  const pullPath = `/repos/${repo}/pulls/${subject.pr}`;
  const response = await fetch(`https://api.github.com${pullPath}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 't00-exact-dot-transition' },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  requireIt(response.ok && !response.redirected, 'HOLD_TRANSITION_PULL_READ');
  const observed = await response.json();
  requireIt(observed.number === subject.pr && observed.head?.sha === subject.head &&
    observed.user?.id === 361175685 && observed.head.repo?.id === repoId &&
    /^PR_[A-Za-z0-9_-]+$/u.test(observed.node_id), 'HOLD_TRANSITION_PULL_READ');
  const publisher = await createPublisher({ appId: 5922170, installationId: 185792757, rulesetId: 28083525,
    pem: env.T00_PUBLISHER_APP_KEY });
  const client = await publisher.transitionTransport(subject, observed.node_id);
  const authorize = async () => {
    const current = verifyTransitionPermit(permit);
    return { ...current.subject, verifiedAt: current.verifiedAt, expiresAt: current.expiresAt,
      dotIntentSha256: current.dotIntentSha256, productEvidenceSha256: current.productEvidenceSha256,
      independentReviewSha256: current.independentReviewSha256, policy: current.policy };
  };

  let merged = await reconcileExactDotMerge(subject, { client });
  if (!merged) {
    verifyTransitionPermit(permit);
    const current = await client.rest('GET', pullPath);
    if (current.draft === true) await readyExactDotPullRequest(subject, { client, authorize });
    // GitHub can report mergeable:null immediately after a Ready transition. Wait for its computation.
    for (let count = 0; count < 5; count++) {
      const pull = await client.rest('GET', pullPath);
      if (pull.mergeable === true || pull.mergeable === false) break;
      await delay(2000);
    }
    merged = await mergeExactDotPullRequest(subject, { client, authorize });
  }
  const { merge, pr, head, tree, base } = merged;
  appendFileSync(env.GITHUB_OUTPUT, `proof=${JSON.stringify({ permit, merged: { merge, pr, head, tree, base } })}\n`);
  console.log(`Verified Dot Bot merge for PR ${pr} at ${merge}`);
}

run().catch(error => {
  console.error(/^HOLD_[A-Z_0-9]+$/u.test(error?.message ?? '') ? error.message : 'HOLD_TRANSITION_MERGE_UNEXPECTED');
  process.exitCode = 1;
});
