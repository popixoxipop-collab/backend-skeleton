import { verifyGitHubPathApproval } from './t00-github-path-approval.mjs';

const REPO = 'popixoxipop-collab/backend-skeleton';
const REPO_ID = 1334919554;
const ciWorkflow = '.github/workflows/ci.yml';
const subjectKeys = ['repo', 'repositoryId', 'pr', 'task', 'scope', 'base', 'head', 'tree'];
const digest = /^[a-f0-9]{64}$/u;
const validId = value => Number.isSafeInteger(value) && value > 0;

function requireIt(ok, code) {
  if (!ok) throw new Error(code);
}

// GitHub artifact, comment and main-policy readers are configured by the protected executor.
// The candidate and comment can select only the subject and immutable handle, never the readers.
export function createDotTransitionAuthorizer({ intent, readProductProof, readMainPolicy,
  readGitHub, prCiRunId, clock = () => Math.floor(Date.now() / 1000) }) {
  requireIt(validId(prCiRunId) && digest.test(intent?.dotIntentSha256) && intent.subject?.repo === REPO &&
    validId(intent.expiresAt) && validId(intent.commentId) &&
    [readProductProof, readMainPolicy, readGitHub, clock].every(fn => typeof fn === 'function'),
  'HOLD_DOT_TRANSITION_EVIDENCE_CONFIGURATION');
  const subject = Object.freeze(Object.fromEntries(subjectKeys.map(key => [key, intent.subject[key]])));
  const { dotIntentSha256, expiresAt: intentDeadline, commentId } = intent;

  return async function authorize(target, phase) {
    const started = clock();
    requireIt(target?.repo === REPO && target.repositoryId === REPO_ID && validId(started) && started < intentDeadline &&
      (phase === 'ready' || phase === 'merge') && subjectKeys.every(key => subject[key] === target[key]),
    'HOLD_DOT_TRANSITION_EVIDENCE_TARGET');
    const prefix = `/repos/${REPO}`;
    const [proof, run, checks] = await Promise.all([
      readProductProof(subject), readGitHub(`${prefix}/actions/runs/${prCiRunId}`),
      readGitHub(`${prefix}/commits/${subject.head}/check-runs?filter=latest&per_page=100`),
    ]);
    const receipt = proof?.receipt;
    requireIt(digest.test(proof?.productEvidenceSha256) && receipt?.dotIntentSha256 === dotIntentSha256 &&
      receipt.commentId === commentId && subjectKeys.every(key => receipt.subject?.[key] === subject[key]) &&
      receipt.replay?.phase === 'premerge' && Array.isArray(receipt.replay.scope_paths),
    'HOLD_DOT_TRANSITION_PRODUCT_PROOF');
    requireIt(run?.id === prCiRunId && run.head_sha === subject.head && run.repository?.id === REPO_ID &&
      run.repository.full_name === REPO && run.path?.split('@')[0] === ciWorkflow && run.event === 'pull_request' &&
      run.status === 'completed' && run.conclusion === 'success', 'HOLD_DOT_TRANSITION_EXACT_CI');
    const mainPolicy = await readMainPolicy(subject);
    const required = mainPolicy?.requiredChecks;
    const jobs = checks?.check_runs;
    const jobPrefix = `https://github.com/${REPO}/actions/runs/${prCiRunId}/job/`;
    requireIt(Array.isArray(jobs) && checks.total_count === jobs.length &&
      Array.isArray(required) && required.length > 0 && required.every(gate => jobs.some(job => job.name === gate.context &&
        job.app?.id === gate.appId && job.head_sha === subject.head && job.status === 'completed' &&
        job.conclusion === 'success' && typeof job.details_url === 'string' && job.details_url.startsWith(jobPrefix) &&
        /^[1-9][0-9]*$/u.test(job.details_url.slice(jobPrefix.length)))), 'HOLD_DOT_TRANSITION_REQUIRED_CI');
    const now = clock();
    requireIt(validId(now) && now >= started && now < intentDeadline, 'HOLD_DOT_TRANSITION_EVIDENCE_EXPIRED');
    let pathApproval;
    for (const job of jobs.filter(job => job.app?.id === 5920902 && job.name === 't00-independent-approval/verified')) {
      try { pathApproval = verifyGitHubPathApproval(job, subject, receipt.replay.scope_paths, { now }); break; }
      catch { /* Other checks on the same head can be expired or belong to a different receipt. */ }
    }
    requireIt(pathApproval && mainPolicy.githubRequiredReviewCount === 0, 'HOLD_DOT_TRANSITION_INDEPENDENT_REVIEW');
    const expiresAt = Math.min(now + 300, intentDeadline, pathApproval.expiresAt);
    requireIt(expiresAt > now + 10, 'HOLD_DOT_TRANSITION_EVIDENCE_EXPIRED');
    return { ...subject, verifiedAt: now, expiresAt, dotIntentSha256, productEvidenceSha256: proof.productEvidenceSha256,
      independentReviewSha256: pathApproval.independentReviewSha256,
      policy: { ...mainPolicy, requiredChecksPassed: true, requiredReviewsSatisfied: true } };
  };
}
