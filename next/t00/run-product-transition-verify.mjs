import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyDotTransitionIntent } from './dot-transition-intent.mjs';
import { createDotTransitionAuthorizer } from './t00-dot-ready-evidence.mjs';
import { PRODUCT_ARTIFACT_SOURCE_PATHS } from './t00-github-product-artifact.mjs';
import { verifyGitHubMainPolicy } from './t00-github-main-policy.mjs';
import { createGitHubPolicyReaderApp } from './t00-github-policy-reader-app.mjs';
import { issueTransitionPermit } from './transition-permit.mjs';

const REPO = 'popixoxipop-collab/backend-skeleton';
const REPO_ID = 1334919554;
const REPO_PATH = `/repos/${REPO}`;
const INTAKE = 389;
const DOT_ACTOR = 261965176;
const WORKFLOW = '.github/workflows/t00-product-transition.yml';
const PREMERGE_WORKFLOW = '.github/workflows/t00-product-replay.yml';
const PREMERGE_WORKFLOW_ID = 430570167;
const CI_WORKFLOW = '.github/workflows/ci.yml';
const SHA = /^[a-f0-9]{40}$/u;
const NAMESPACE = Object.freeze({ rulesetId: 28083525, publisherAppId: 5922170,
  updatedAt: '2026-11-25T14:30:07.856Z' });
const ROOT = new URL('../../', import.meta.url);
const validId = value => Number.isSafeInteger(value) && value > 0;
const sameRepo = value => value?.id === REPO_ID && value.full_name === REPO;

function requireIt(ok, code) {
  if (!ok) throw new Error(code);
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(new URL(path, ROOT))).digest('hex');
}

function checkCheckout(expected) {
  const actual = execFileSync('/usr/bin/git', ['--no-replace-objects', 'rev-parse', 'HEAD'], {
    cwd: fileURLToPath(ROOT), encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  requireIt(actual === expected, 'HOLD_TRANSITION_VERIFY_CHECKOUT');
}

export function exactPrCiRunId(data, subject) {
  const runs = data?.workflow_runs;
  requireIt(Array.isArray(runs) && data.total_count === runs.length && runs.length > 0 && runs.length <= 50,
    'HOLD_TRANSITION_VERIFY_CI_LIST');
  const matched = runs.filter(run => validId(run?.id) && validId(run.run_number) && validId(run.run_attempt) &&
    run.path?.split('@')[0] === CI_WORKFLOW && run.head_sha === subject.head && run.event === 'pull_request' &&
    sameRepo(run.repository) && sameRepo(run.head_repository) && Array.isArray(run.pull_requests) &&
    run.pull_requests.some(pull => pull.number === subject.pr && pull.url === `https://api.github.com${REPO_PATH}/pulls/${subject.pr}` &&
      pull.head?.sha === subject.head && pull.head.ref === `dot/t00-publisher/${subject.head}` &&
      pull.head.repo?.id === REPO_ID && pull.base?.sha === subject.base && pull.base.ref === 'main' &&
      pull.base.repo?.id === REPO_ID));
  matched.sort((left, right) => right.run_number - left.run_number || right.run_attempt - left.run_attempt);
  const [latest, next] = matched;
  requireIt(latest?.status === 'completed' && latest.conclusion === 'success' &&
    (next === undefined || next.run_number !== latest.run_number), 'HOLD_TRANSITION_VERIFY_CI_PENDING_OR_AMBIGUOUS');
  return latest.id;
}

export function verifyProductWorkflowEvent(event, main) {
  const run = event?.workflow_run;
  requireIt(event?.action === 'completed' && sameRepo(event.repository) && validId(run?.id) &&
    validId(run.run_attempt) && run.workflow_id === PREMERGE_WORKFLOW_ID && run.path === PREMERGE_WORKFLOW &&
    run.status === 'completed' && run.conclusion === 'success' && run.event === 'issue_comment' &&
    run.head_branch === 'main' && run.head_sha === main && sameRepo(run.head_repository) && sameRepo(run.repository) &&
    run.actor?.id === DOT_ACTOR && run.triggering_actor?.id === DOT_ACTOR, 'HOLD_TRANSITION_VERIFY_EVENT');
  return { runId: run.id, attempt: run.run_attempt };
}

async function run(env) {
  requireIt(env.GITHUB_REPOSITORY === REPO && env.GITHUB_REPOSITORY_ID === String(REPO_ID) &&
    env.GITHUB_EVENT_NAME === 'workflow_run' && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_WORKFLOW_REF === `${REPO}/${WORKFLOW}@refs/heads/main` && SHA.test(env.GITHUB_SHA ?? '') &&
    env.GITHUB_EVENT_PATH?.startsWith('/') && env.GITHUB_OUTPUT?.startsWith('/'), 'HOLD_TRANSITION_VERIFY_WORKFLOW');
  const trigger = verifyProductWorkflowEvent(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')), env.GITHUB_SHA);
  checkCheckout(env.GITHUB_SHA);
  const app = await createGitHubPolicyReaderApp({ appId: 5923844, installationId: 185830017,
    privateKeyPem: env.T00_POLICY_READER_APP_PRIVATE_KEY, productArtifact: { policy: {
      workflowId: PREMERGE_WORKFLOW_ID,
      fileSha256s: Object.fromEntries(PRODUCT_ARTIFACT_SOURCE_PATHS.map(source => [source, hashFile(source)])),
    } } });
  const { intent, proof } = await app.discoverProductPremergeReceipt(trigger);
  const { subject, commentId, dotIntentSha256 } = intent;
  requireIt(subject.base === env.GITHUB_SHA, 'HOLD_TRANSITION_VERIFY_BASE');
  const runsPath = `${REPO_PATH}/actions/workflows/ci.yml/runs?head_sha=${subject.head}&event=pull_request&per_page=50`;
  const prCiRunId = exactPrCiRunId(await app.readGitHub(runsPath), subject);
  const authorize = createDotTransitionAuthorizer({ intent, prCiRunId, readProductProof: async () => proof,
    readMainPolicy: target => verifyGitHubMainPolicy(target, { adminRead: app.adminRead, namespaceEnrollment: NAMESPACE }),
    readGitHub: app.readGitHub });
  const authorization = await authorize(subject, 'merge');
  const original = await app.readGitHub(`${REPO_PATH}/issues/comments/${commentId}`);
  const finalIntent = verifyDotTransitionIntent({ repository: REPO, repositoryId: REPO_ID, intake: INTAKE,
    comment: original, now: Math.floor(Date.now() / 1000) });
  requireIt(finalIntent.commentId === commentId && finalIntent.dotIntentSha256 === dotIntentSha256,
    'HOLD_TRANSITION_VERIFY_COMMENT_CHANGED');
  const permit = issueTransitionPermit({ subject, baseTree: proof.receipt.replay.base_tree,
    productEvidenceSha256: proof.productEvidenceSha256, receiptSha256: proof.receiptSha256,
    productRunId: trigger.runId, productAttempt: trigger.attempt, commentId, dotIntentSha256,
    independentReviewSha256: authorization.independentReviewSha256, prCiRunId, policy: authorization.policy,
    verifiedAt: authorization.verifiedAt, expiresAt: authorization.expiresAt,
  }, { privateDerBase64: env.T00_PRODUCT_ED25519_PRIVATE_DER_BASE64 });
  appendFileSync(env.GITHUB_OUTPUT, `permit=${JSON.stringify(permit)}\npr=${subject.pr}\n`);
  console.log(JSON.stringify({ status: 'DOT_PRODUCT_TRANSITION_VERIFIED', pr: subject.pr, commentId,
    productRunId: trigger.runId, prCiRunId, productEvidenceSha256: proof.productEvidenceSha256 }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.env).catch(error => {
    console.error(/^HOLD_[A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'HOLD_TRANSITION_VERIFY_FAILURE');
    process.exitCode = 1;
  });
}
