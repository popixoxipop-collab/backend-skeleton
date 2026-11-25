const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const PUBLISHER_APP_ID = 5922170;
const PUBLISHER_BOT_ID = 361175685;
const TARGET_FIELDS = ['repo', 'repositoryId', 'pr', 'task', 'scope', 'base', 'head', 'tree'];

const MARK_READY = `mutation MarkExactDotPullRequestReady($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
    pullRequest { id number isDraft headRefOid baseRefOid }
  }
}`;

function requireIt(ok, code) {
  if (!ok) throw new Error(code);
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSha(value) {
  return typeof value === 'string' && SHA.test(value);
}

function checkIds(entries, appIdKey) {
  requireIt(Array.isArray(entries) && entries.length > 0 && entries.every(entry =>
    typeof entry?.context === 'string' && entry.context.length > 0 && positiveId(entry[appIdKey])),
  'HOLD_UNVERIFIED_REQUIRED_CHECKS');
  const checks = entries.map(entry => JSON.stringify([entry.context, entry[appIdKey]])).sort();
  requireIt(new Set(checks).size === entries.length, 'HOLD_UNVERIFIED_REQUIRED_CHECKS');
  return JSON.stringify(checks);
}

function openTransition(target, client, authorize) {
  requireIt(target !== null && typeof target === 'object' &&
    typeof target.repo === 'string' && /^popixoxipop-collab\/[A-Za-z0-9-]{1,80}$/u.test(target.repo) &&
    positiveId(target.repositoryId) && positiveId(target.pr) &&
    typeof target.task === 'string' && /^T[0-9]{2}-[0-9]{2}$/u.test(target.task) &&
    typeof target.scope === 'string' && /^[a-z][a-z0-9-]{0,119}$/u.test(target.scope) &&
    [target.base, target.head, target.tree].every(isSha) && target.base !== target.head,
  'HOLD_EXACT_PR_TARGET');
  requireIt(client?.installationAppId === PUBLISHER_APP_ID && typeof client.rest === 'function' &&
    typeof client.graphql === 'function' && typeof authorize === 'function', 'HOLD_PUBLISHER_TRANSPORT');
  const subject = Object.freeze(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
  const repoPath = `/repos/${subject.repo}`;
  const pullPath = `${repoPath}/pulls/${subject.pr}`;
  const branchPath = `${repoPath}/branches/main`;

  function verifyPullIdentity(pull, nodeId) {
    const isRepo = value => value?.id === subject.repositoryId && value.full_name === subject.repo;
    requireIt(pull?.number === subject.pr && typeof pull.node_id === 'string' && pull.node_id.length > 0 &&
      (nodeId === undefined || pull.node_id === nodeId) && pull.user?.id === PUBLISHER_BOT_ID &&
      pull.user.type === 'Bot' && isRepo(pull.base?.repo) && isRepo(pull.head?.repo) &&
      pull.base.ref === 'main' && pull.head.sha === subject.head &&
      pull.head.ref === `dot/t00-publisher/${subject.head}`, 'HOLD_EXACT_DOT_PR');
  }

  async function preflight(draft, nodeId, requiredChecks) {
    const [pull, branch] = await Promise.all([client.rest('GET', pullPath), client.rest('GET', branchPath)]);
    verifyPullIdentity(pull, nodeId);
    requireIt(pull.state === 'open' && pull.merged === false && pull.draft === draft, 'HOLD_PR_STAGE');
    requireIt(branch?.name === 'main' && branch.protected === true && branch.commit?.sha === subject.base &&
      pull.base.sha === subject.base, 'HOLD_STALE_PROTECTED_BASE');
    const checks = checkIds(branch.protection?.required_status_checks?.checks, 'app_id');
    requireIt(requiredChecks === undefined || checks === requiredChecks, 'HOLD_REQUIRED_CHECKS_CHANGED');
    return { nodeId: pull.node_id, checks, mergeable: pull.mergeable };
  }

  async function prepare(phase) {
    const draft = phase === 'ready';
    const [initial, commit] = await Promise.all([
      preflight(draft), client.rest('GET', `${repoPath}/git/commits/${subject.head}`),
    ]);
    // Strict status checks plus a forward-only main can exclude a base race when the exact head
    // has no candidate ancestor between the authorized base and head. REST's sha pins only head.
    requireIt(commit?.sha === subject.head && commit.tree?.sha === subject.tree &&
      Array.isArray(commit.parents) && commit.parents.length === 1 && commit.parents[0]?.sha === subject.base,
    'HOLD_CANDIDATE_TREE_OR_PARENT');

    // The protected caller verifies signed Dot intent, independent product and review evidence, and
    // fresh GitHub policy/CI. No configuration or proof is accepted from the PR or the job payload.
    const proof = await authorize(subject, phase);
    const policy = proof?.policy;
    requireIt(proof && TARGET_FIELDS.every(key => proof[key] === subject[key]) &&
      [proof.dotIntentSha256, proof.productEvidenceSha256, proof.independentReviewSha256].every(value =>
        typeof value === 'string' && DIGEST.test(value)) &&
      policy?.strictCurrentBase === true && policy.mainBlocksForcePushes === true &&
      policy.publisherCannotBypassMain === true && policy.publisherOwnsHeadRef === true &&
      policy.requiredChecksPassed === true && (draft || policy.requiredReviewsSatisfied === true),
    'HOLD_EXACT_TRANSITION_AUTHORIZATION');
    requireIt(checkIds(policy.requiredChecks, 'appId') === initial.checks, 'HOLD_REQUIRED_CHECKS_CHANGED');
    const current = await preflight(draft, initial.nodeId, initial.checks);
    const now = Math.floor(Date.now() / 1000);
    requireIt(positiveId(proof.verifiedAt) && positiveId(proof.expiresAt) && proof.verifiedAt <= now &&
      now - proof.verifiedAt <= 300 && proof.expiresAt > now && proof.expiresAt - proof.verifiedAt <= 900,
    'HOLD_STALE_TRANSITION_AUTHORIZATION');
    return current;
  }

  return { subject, repoPath, pullPath, preflight, verifyPullIdentity, prepare };
}

// The client supplies `rest(method, path, body?)` and `graphql(query, variables)` and authenticates
// both operations as the protected Dot publisher installation. An ambiguous write is never retried.
export async function readyExactDotPullRequest(target, { client, authorize } = {}) {
  const transition = openTransition(target, client, authorize);
  const { subject, prepare, preflight } = transition;
  const prepared = await prepare('ready');
  let response;
  let ambiguous = false;
  try {
    response = await client.graphql(MARK_READY, { pullRequestId: prepared.nodeId });
  } catch {
    ambiguous = true;
  }
  const returned = response?.data?.markPullRequestReadyForReview?.pullRequest;
  const acknowledged = response?.errors === undefined && returned?.id === prepared.nodeId && returned.number === subject.pr &&
    returned.isDraft === false && returned.headRefOid === subject.head && returned.baseRefOid === subject.base;
  await preflight(false, prepared.nodeId, prepared.checks);
  requireIt(acknowledged || ambiguous, 'HOLD_READY_RESPONSE_MISMATCH');
  return { ...subject, stage: 'ready', acknowledged };
}

export async function mergeExactDotPullRequest(target, { client, authorize } = {}) {
  const transition = openTransition(target, client, authorize);
  const { subject, pullPath, prepare, verifyPullIdentity } = transition;
  const prepared = await prepare('merge');
  requireIt(prepared.mergeable === true, 'HOLD_GITHUB_MERGEABILITY');
  let response;
  let ambiguous = false;
  try {
    response = await client.rest('PUT', `${pullPath}/merge`, { sha: subject.head, merge_method: 'merge' });
  } catch {
    ambiguous = true;
  }
  const pull = await client.rest('GET', pullPath);
  verifyPullIdentity(pull, prepared.nodeId);
  const merge = pull.merge_commit_sha;
  await readConfirmedMerge(transition, client, pull);
  const acknowledged = response?.merged === true && response.sha === merge;
  requireIt(acknowledged || ambiguous, 'HOLD_MERGE_RESPONSE_MISMATCH');
  return { ...subject, stage: 'merged', merge, acknowledged };
}

async function readConfirmedMerge({ subject, repoPath }, client, pull) {
  const merge = pull.merge_commit_sha;
  requireIt(pull.state === 'closed' && pull.merged === true && pull.draft === false && isSha(merge) &&
    merge !== subject.head && merge !== subject.base, 'HOLD_UNCONFIRMED_GITHUB_MERGE');
  requireIt(pull.merged_by?.id === PUBLISHER_BOT_ID && pull.merged_by.type === 'Bot', 'HOLD_GITHUB_MERGE_ACTOR');
  const commit = await client.rest('GET', `${repoPath}/git/commits/${merge}`);
  requireIt(commit?.sha === merge && commit.tree?.sha === subject.tree &&
    Array.isArray(commit.parents) && commit.parents.length === 2 &&
    commit.parents[0]?.sha === subject.base && commit.parents[1]?.sha === subject.head, 'HOLD_GITHUB_MERGE_BINDING');
  return merge;
}

export async function reconcileExactDotMerge(target, { client } = {}) {
  const transition = openTransition(target, client, () => { throw new Error('HOLD_READ_ONLY_RECONCILIATION'); });
  const pull = await client.rest('GET', transition.pullPath);
  transition.verifyPullIdentity(pull);
  if (pull.state === 'open' && pull.merged === false) return null;
  return { ...transition.subject, stage: 'merged', merge: await readConfirmedMerge(transition, client, pull), acknowledged: false };
}
