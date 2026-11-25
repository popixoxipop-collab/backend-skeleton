const REPO = 'popixoxipop-collab/backend-skeleton';
const REPO_ID = 1334919554;
const APP_ID = 5922170;
const INSTALLATION_ID = 185792757;
const BOT_ID = 361175685;
const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const PERMISSIONS = Object.freeze({ contents: 'write', pull_requests: 'write', metadata: 'read' });
const INSTALLATION_SCOPE = Object.freeze({ appId: APP_ID, installationId: INSTALLATION_ID,
  repository: REPO, repositoryId: REPO_ID, permissions: PERMISSIONS });
const SHA = /^[a-f0-9]{40}$/u;
const GRAPHQL_NODE_ID = /^[A-Za-z0-9_+\/=-]{1,160}$/u;
const GITHUB_INSTALLATION_TOKEN = /^ghs_[A-Za-z0-9_.-]{16,8192}$/u;

// Literal allowlist for the only GraphQL operation sent by the exact transition executor.
const MARK_READY = `mutation MarkExactDotPullRequestReady($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
    pullRequest { id number isDraft headRefOid baseRefOid }
  }
}`;

function requireIt(ok, code) {
  if (!ok) throw new Error(code);
}

function isSha(value) {
  return typeof value === 'string' && SHA.test(value);
}

function hasOnly(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function sameRepo(repo) {
  return repo?.id === REPO_ID && repo.full_name === REPO;
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  requireIt(reader, 'HOLD_DOT_TRANSITION_RESPONSE');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireIt(size <= MAX_RESPONSE_BYTES, 'HOLD_DOT_TRANSITION_RESPONSE');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    throw new Error('HOLD_DOT_TRANSITION_RESPONSE');
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// The protected caller injects the issuer that has checked GitHub App/installation identity,
// the complete selected repository scope and exact permissions when minting the token.
export async function createDotTransitionTransport({ subject, pullRequestNodeId, issueInstallationToken,
  fetchImpl = fetch, clock = Date.now } = {}) {
  const { repo, repositoryId, pr, base, head, tree } = subject ?? {};
  requireIt(repo === REPO && repositoryId === REPO_ID && Number.isSafeInteger(pr) && pr > 0 && pr !== 389 &&
    [base, head, tree].every(isSha) && base !== head && typeof pullRequestNodeId === 'string' &&
    GRAPHQL_NODE_ID.test(pullRequestNodeId), 'HOLD_DOT_TRANSITION_TRANSPORT_SCOPE');
  requireIt(typeof issueInstallationToken === 'function' && typeof fetchImpl === 'function' &&
    typeof clock === 'function', 'HOLD_DOT_TRANSITION_TOKEN_ISSUER');

  let auth;
  try {
    auth = await issueInstallationToken(INSTALLATION_SCOPE);
  } catch {
    throw new Error('HOLD_DOT_TRANSITION_TOKEN_ISSUER');
  }
  const { token, expiresAt, permissions } = auth ?? {};
  const permissionNames = Object.keys(PERMISSIONS);
  const now = clock();
  requireIt(auth?.appId === APP_ID && auth.installationId === INSTALLATION_ID && auth.repositoryId === REPO_ID &&
    auth.repository === REPO && typeof token === 'string' && GITHUB_INSTALLATION_TOKEN.test(token) &&
    Number.isSafeInteger(now) && Number.isSafeInteger(expiresAt) && expiresAt > now &&
    hasOnly(permissions, permissionNames) && permissionNames.every(name => permissions[name] === PERMISSIONS[name]),
  'HOLD_DOT_TRANSITION_TOKEN_SCOPE');

  const repoPath = `/repos/${REPO}`;
  const pullPath = `${repoPath}/pulls/${pr}`;
  const candidateCommitPath = `${repoPath}/git/commits/${head}`;
  let exactPull;
  let pinnedMergeCommitPath;
  let readyAttempted = false;
  let mergeAttempted = false;

  async function send(method, path, body) {
    requireIt(clock() < expiresAt, 'HOLD_DOT_TRANSITION_EXPIRED_TOKEN');
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION,
      Authorization: `Bearer ${token}` };
    const request = { method, headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(body);
    }
    const url = API + path;
    let response;
    try {
      response = await fetchImpl(url, request);
    } catch {
      throw new Error('HOLD_DOT_TRANSITION_GITHUB_REQUEST');
    }
    requireIt(response?.redirected === false && (!response.url || response.url === url) &&
      response.status === 200, 'HOLD_DOT_TRANSITION_GITHUB_RESPONSE');
    return boundedJson(response);
  }

  async function readPull() {
    exactPull = undefined;
    pinnedMergeCommitPath = undefined;
    const pull = await send('GET', pullPath);
    requireIt(pull?.number === pr && pull.node_id === pullRequestNodeId &&
      sameRepo(pull.base?.repo) && sameRepo(pull.head?.repo) && pull.base.ref === 'main' &&
      pull.head.ref === `dot/t00-publisher/${head}` && pull.head.sha === head &&
      pull.user?.id === BOT_ID && pull.user.type === 'Bot', 'HOLD_DOT_TRANSITION_EXACT_PULL');
    exactPull = { state: pull.state, draft: pull.draft, merged: pull.merged };
    const merge = pull.merge_commit_sha;
    if (pull.state === 'closed' && pull.merged === true && pull.draft === false &&
      pull.merged_by?.id === BOT_ID && pull.merged_by.type === 'Bot' && isSha(merge) && merge !== base && merge !== head) {
      pinnedMergeCommitPath = `${repoPath}/git/commits/${merge}`;
    }
    return pull;
  }

  return Object.freeze({
    installationAppId: APP_ID,
    async rest(method, path, body, ...extra) {
      requireIt(extra.length === 0, 'HOLD_DOT_TRANSITION_TRANSPORT_REQUEST');
      if (method === 'GET' && body === undefined) {
        if (path === pullPath) return readPull();
        if (path === `${repoPath}/branches/main` || path === candidateCommitPath ||
          (pinnedMergeCommitPath !== undefined && path === pinnedMergeCommitPath)) return send('GET', path);
      }
      requireIt(method === 'PUT' && path === `${pullPath}/merge` && hasOnly(body, ['sha', 'merge_method']) &&
        body.sha === head && body.merge_method === 'merge', 'HOLD_DOT_TRANSITION_TRANSPORT_REQUEST');
      requireIt(!mergeAttempted && exactPull?.state === 'open' && exactPull.draft === false &&
        exactPull.merged === false, 'HOLD_DOT_TRANSITION_TRANSPORT_STAGE');
      mergeAttempted = true;
      return send('PUT', path, { sha: head, merge_method: 'merge' });
    },
    async graphql(query, variables, ...extra) {
      requireIt(extra.length === 0 && query === MARK_READY && hasOnly(variables, ['pullRequestId']) &&
        variables.pullRequestId === pullRequestNodeId, 'HOLD_DOT_TRANSITION_TRANSPORT_REQUEST');
      requireIt(!readyAttempted && exactPull?.state === 'open' && exactPull.draft === true &&
        exactPull.merged === false, 'HOLD_DOT_TRANSITION_TRANSPORT_STAGE');
      readyAttempted = true;
      return send('POST', '/graphql', { query: MARK_READY, variables: { pullRequestId: pullRequestNodeId } });
    },
  });
}
