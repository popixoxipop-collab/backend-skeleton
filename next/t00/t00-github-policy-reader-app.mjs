import { createPrivateKey, sign } from 'node:crypto';
import { createGitHubProductArtifactReader } from './t00-github-product-artifact.mjs';

const APP_ID = 5923844;
const INSTALLATION_ID = 185830017;
const APP_SLUG = 't00-dot-policy-reader';
const OWNER = 'popixoxipop-collab';
const OWNER_ID = 261965176;
const REPOSITORY = `${OWNER}/backend-skeleton`;
const REPOSITORY_ID = 1334919554;
const API = 'https://api.github.com';
const REPO = `/repos/${REPOSITORY}`;
const MAIN = `${REPO}/branches/main`;
const BRANCH_RULES = `${REPO}/rules/branches/`;
const RULESET = `${REPO}/rulesets/`;
const LIST_INSTALLATION_REPOS = '/installation/repositories?per_page=2';
const METADATA = Object.freeze({ metadata: 'read' });
const ADMIN = Object.freeze({ administration: 'read', ...METADATA });
const ACTIONS = Object.freeze({ actions: 'read', ...METADATA });
const APP_PERMISSIONS = Object.freeze({ administration: 'read', ...ACTIONS });
const PROTECTION = `${MAIN}/protection`;
const QUERY = '?per_page=100';
const MAX_BYTES = 2_000_000;
const ARTIFACT_PUBLIC_CONTENT = new Set([
  '.github/workflows/t00-product-replay.yml', 'next/t00/run-product-replay.mjs',
  'next/t00/product-t03-replay.py', 'next/t00/dot-transition-intent.mjs',
]);
const OWNER_POLICY_PATHS = new Set([REPO, MAIN, PROTECTION, `${PROTECTION}/required_status_checks`, `${BRANCH_RULES}main${QUERY}`]);
const RUNS = `${REPO}/actions/runs/`;
const CI_RUNS = `${REPO}/actions/workflows/ci.yml/runs?`;
const COMMITS = `${REPO}/commits/`;
const COMMENTS = `${REPO}/issues/comments/`;

function requireIt(ok, code) {
  if (!ok) throw new Error(code);
}

const positiveId = value => Number.isSafeInteger(value) && value > 0;
const sameOwner = account => account?.id === OWNER_ID && account.login === OWNER;
const sameRepo = repo => repo?.id === REPOSITORY_ID && repo.full_name === REPOSITORY;

function exactPermissions(actual, expected) {
  return actual && typeof actual === 'object' && !Array.isArray(actual) &&
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && actual[key] === value);
}

function appJwt(privateKeyPem, now) {
  try {
    requireIt(typeof privateKeyPem === 'string' && privateKeyPem.length <= 16384, 'HOLD_POLICY_READER_KEY');
    const key = createPrivateKey(privateKeyPem);
    requireIt(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 2048, 'HOLD_POLICY_READER_KEY');
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const seconds = Math.floor(now / 1000);
    const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: seconds - 60, exp: seconds + 480, iss: String(APP_ID) })}`;
    return `${input}.${sign('RSA-SHA256', input, key).toString('base64url')}`;
  } catch {
    throw new Error('HOLD_POLICY_READER_KEY');
  }
}

async function responseJson(response) {
  // Read a bounded response without relying on a remote Content-Length or printing remote errors.
  requireIt(response?.body, 'HOLD_POLICY_READER_RESPONSE');
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      requireIt(length <= MAX_BYTES, 'HOLD_POLICY_READER_RESPONSE_SIZE');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)));
  } catch (error) {
    if (error.message === 'HOLD_POLICY_READER_RESPONSE_SIZE') throw error;
    throw new Error('HOLD_POLICY_READER_RESPONSE');
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function policyPath(path) {
  if (typeof path !== 'string') return false;
  if (OWNER_POLICY_PATHS.has(path)) return true;
  return (path.startsWith(BRANCH_RULES) && /^dot%2Ft00-publisher%2F[0-9a-f]{40}\?per_page=100$/u.test(path.slice(BRANCH_RULES.length))) ||
    (path.startsWith(RULESET) && /^[1-9]\d{0,15}\?includes_parents=true$/u.test(path.slice(RULESET.length)) &&
      positiveId(Number(path.slice(RULESET.length).split('?')[0])));
}

function publicArtifactEndpoint(url) {
  if (url === `${API}${MAIN}`) return true;
  const comments = `${API}${REPO}/issues/comments/`;
  if (url.startsWith(comments) && /^[1-9]\d{0,15}$/u.test(url.slice(comments.length))) return true;
  const contents = `${API}${REPO}/contents/`;
  if (!url.startsWith(contents)) return false;
  const [path, query, ...extra] = url.slice(contents.length).split('?');
  return extra.length === 0 && ARTIFACT_PUBLIC_CONTENT.has(path) && /^ref=[0-9a-f]{40}$/u.test(query);
}

// Call from the isolated deployment. Private key, tokens, workflow pins and endpoint policy never
// come from a candidate or event. Only the token construction endpoint performs a POST.
export async function createGitHubPolicyReaderApp({ appId, installationId, privateKeyPem,
  productArtifact, fetchImpl = fetch, clock = Date.now }) {
  requireIt(appId === APP_ID && installationId === INSTALLATION_ID && typeof fetchImpl === 'function' &&
    typeof clock === 'function', 'HOLD_POLICY_READER_CONFIGURATION');
  const start = clock();
  requireIt(positiveId(start), 'HOLD_POLICY_READER_CONFIGURATION');
  const jwt = appJwt(privateKeyPem, start);
  const installationPath = `/app/installations/${installationId}`;

  async function request(path, token, body) {
    const url = `${API}${path}`;
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': APP_SLUG };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error',
        cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new Error('HOLD_POLICY_READER_TRANSPORT');
    }
    requireIt(response?.url === url && response.redirected === false, 'HOLD_POLICY_READER_ORIGIN');
    requireIt(response.status === (body === undefined ? 200 : 201), 'HOLD_POLICY_READER_GITHUB_HTTP');
    return responseJson(response);
  }

  const app = await request('/app', jwt);
  requireIt(app?.id === APP_ID && app.slug === APP_SLUG && sameOwner(app.owner) &&
    exactPermissions(app.permissions, APP_PERMISSIONS), 'HOLD_POLICY_READER_APP_IDENTITY');
  const installation = await request(installationPath, jwt);
  requireIt(installation?.id === installationId && installation.app_id === APP_ID && installation.app_slug === APP_SLUG &&
    sameOwner(installation.account) && installation.repository_selection === 'selected' &&
    installation.suspended_at === null && exactPermissions(installation.permissions, APP_PERMISSIONS),
  'HOLD_POLICY_READER_INSTALLATION_IDENTITY');

  async function installationToken(permissions, filtered) {
    const credentials = await request(`${installationPath}/access_tokens`, jwt,
      filtered ? { permissions, repository_ids: [REPOSITORY_ID] } : { permissions });
    const now = clock();
    const expiresAt = typeof credentials?.expires_at === 'string' ? Date.parse(credentials.expires_at) : NaN;
    requireIt(typeof credentials?.token === 'string' && /^ghs_[A-Za-z0-9_.-]{16,8192}$/u.test(credentials.token) &&
      positiveId(now) && expiresAt > now + 60_000 && expiresAt <= now + 65 * 60_000 &&
      credentials.repository_selection === 'selected' && exactPermissions(credentials.permissions, permissions),
    'HOLD_POLICY_READER_TOKEN_SCOPE');
    const scope = await request(LIST_INSTALLATION_REPOS, credentials.token);
    requireIt(scope?.total_count === 1 && Array.isArray(scope.repositories) && scope.repositories.length === 1 &&
      sameRepo(scope.repositories[0]) && scope.repositories[0].private === false, 'HOLD_POLICY_READER_REPOSITORY_SCOPE');
    return { token: credentials.token, expiresAt };
  }

  // The first token is deliberately unfiltered so a second installed repository cannot be hidden.
  await installationToken(METADATA, false);
  const administrator = await installationToken(ADMIN, true);
  function adminRead(path) {
    requireIt(policyPath(path), 'HOLD_POLICY_READER_ENDPOINT');
    requireIt(clock() < administrator.expiresAt - 15_000, 'HOLD_POLICY_READER_TOKEN_EXPIRED');
    // The public branch endpoint can require Contents when using a fine-grained credential.
    return request(path, path === MAIN ? undefined : administrator.token);
  }

  if (productArtifact === undefined) return Object.freeze({ adminRead });
  const actions = await installationToken(ACTIONS, true);
  const readPremerge = createGitHubProductArtifactReader({ actionsReadToken: actions.token,
    policy: productArtifact?.policy, publicKeyDer: productArtifact?.publicKeyDer, clock,
    fetchImpl: (url, options) => {
      if (publicArtifactEndpoint(url)) {
        const headers = { ...options.headers };
        delete headers.Authorization;
        return fetchImpl(url, { ...options, headers });
      }
      return fetchImpl(url, options);
    } });
  function withActionsCredentials() {
    requireIt(clock() < actions.expiresAt - 45_000, 'HOLD_POLICY_READER_TOKEN_EXPIRED');
  }

  return Object.freeze({
    adminRead,
    readProductPremergeReceipt(input) {
      withActionsCredentials();
      return readPremerge(input);
    },
    discoverProductPremergeReceipt(input) {
      withActionsCredentials();
      return readPremerge.discover(input);
    },
    readGitHub(path) {
      withActionsCredentials();
      requireIt(typeof path === 'string', 'HOLD_POLICY_READER_ENDPOINT');
      const actionPath = (path.startsWith(RUNS) && /^[1-9][0-9]{0,15}$/u.test(path.slice(RUNS.length))) ||
        (path.startsWith(CI_RUNS) && /^head_sha=[0-9a-f]{40}&event=pull_request&per_page=50$/u.test(path.slice(CI_RUNS.length)));
      const checksPath = path.startsWith(COMMITS) &&
        /^[0-9a-f]{40}\/check-runs\?filter=latest&per_page=100$/u.test(path.slice(COMMITS.length));
      const commentPath = path.startsWith(COMMENTS) && /^[1-9][0-9]{0,15}$/u.test(path.slice(COMMENTS.length));
      requireIt(actionPath || checksPath || commentPath, 'HOLD_POLICY_READER_ENDPOINT');
      return request(path, actionPath ? actions.token : undefined);
    },
  });
}
