import { createPrivateKey, sign } from 'node:crypto';
import { createDotTransitionTransport } from './t00-dot-transition-transport.mjs';

const OWNER = 'popixoxipop-collab';
const OWNER_ID = 261965176;
const REPOSITORY = `${OWNER}/backend-skeleton`;
const REPOSITORY_ID = 1334919554;
const APPROVER_APP_ID = 5920902;
const APPROVER_BOT_ID = 361139581;
const REPO = `/repos/${REPOSITORY}`;
const API = 'https://api.github.com';
const SHA = /^[a-f0-9]{40}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const WRITE_PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read' };
const READ_PERMISSIONS = { metadata: 'read' };
const RULE_TYPES = ['creation', 'update', 'deletion'];
const MAX_RESPONSE_BYTES = 2_000_000;

function expect(ok, code) {
  if (!ok) throw new Error(code);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function sameRepo(value) {
  return value?.id === REPOSITORY_ID && value.full_name === REPOSITORY;
}

function exactPermissions(actual, required) {
  return actual && Object.keys(actual).length === Object.keys(required).length &&
    Object.entries(required).every(([name, access]) => actual[name] === access);
}

function createAppJwt(appId, pem) {
  try {
    const key = createPrivateKey(pem);
    expect(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 2048,
      'HOLD_PUBLISHER_KEY');
    const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const text = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 480, iss: String(appId) })}`;
    return `${text}.${sign('RSA-SHA256', Buffer.from(text), key).toString('base64url')}`;
  } catch {
    throw new Error('HOLD_PUBLISHER_KEY');
  }
}

async function json(response) {
  const reader = response.body?.getReader();
  expect(reader, 'HOLD_PUBLISHER_RESPONSE');
  try {
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      expect(size <= MAX_RESPONSE_BYTES, 'HOLD_PUBLISHER_RESPONSE_SIZE');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function createApi(fetchImpl) {
  return async (path, { token, body, label, allowMissing = false }) => {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const options = { headers, method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000) };
    if (body) {
      options.method = 'POST';
      options.body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    let response;
    try {
      response = await fetchImpl(API + path, options);
    } catch {
      // An ambiguous POST is never automatically attempted again, and no server body is logged.
      throw new Error(`HOLD_GITHUB_${label}`);
    }
    expect(!response.redirected, `HOLD_GITHUB_${label}_REDIRECT`);
    if (allowMissing && response.status === 404) return null;
    expect(response.status === (body ? 201 : 200), `HOLD_GITHUB_${label}_HTTP_${response.status}`);
    return json(response);
  };
}

async function scopedInstallationToken(api, installationPath, jwt, permissions, repositoryIds) {
  const auth = await api(`${installationPath}/access_tokens`, {
    token: jwt,
    body: repositoryIds ? { permissions, repository_ids: repositoryIds } : { permissions },
    label: 'PUBLISHER_INSTALLATION_TOKEN',
  });
  expect(typeof auth?.token === 'string' && /^ghs_[A-Za-z0-9_.-]{16,8192}$/.test(auth.token) &&
    Date.parse(auth.expires_at) > Date.now() && auth.repository_selection === 'selected' &&
    exactPermissions(auth.permissions, permissions), 'HOLD_PUBLISHER_TOKEN_SCOPE');
  const scope = await api('/installation/repositories?per_page=2', {
    token: auth.token, label: 'PUBLISHER_REPOSITORY_SCOPE',
  });
  expect(scope?.total_count === 1 && scope.repositories?.length === 1 && sameRepo(scope.repositories[0]),
    'HOLD_PUBLISHER_REPOSITORY_SCOPE');
  return { token: auth.token, expiresAt: Date.parse(auth.expires_at) };
}

function snapshot(binding) {
  const { base, head, tree, track, paths } = binding ?? {};
  const validPath = (path) => typeof path === 'string' && path.length > 0 && path.length <= 1024 &&
    /^[A-Za-z0-9_.@+/\-]+$/.test(path) && path.split('/').every((part) => part && part !== '.' && part !== '..');
  const validSha = (value) => typeof value === 'string' && SHA.test(value);
  expect(validSha(base) && validSha(head) && validSha(tree) && head !== base &&
    typeof track === 'string' && /^T[0-9]{2}$/.test(track) &&
    Array.isArray(paths) && paths.length > 0 && paths.length <= 1000 &&
    paths.every(validPath) && new Set(paths).size === paths.length &&
    !(binding.repositoryId !== undefined && binding.repositoryId !== REPOSITORY_ID) &&
    !(binding.repository !== undefined && binding.repository !== REPOSITORY),
  'HOLD_PUBLISHER_BINDING');
  return JSON.stringify({ base, head, tree, track, paths: [...paths].sort() });
}

function validateRef(response, ref, head) {
  expect(response?.ref === ref && response.object?.type === 'commit' && response.object.sha === head,
    'HOLD_PUBLISHER_REF_MISMATCH');
}

function validatePull(pull, branch, binding, bot, number) {
  expect(positiveInteger(pull?.number) && (number === undefined || number === pull.number) &&
    pull.state === 'open' && pull.draft === true && pull.merged !== true &&
    pull.user?.id === bot.id && pull.user.type === 'Bot' && pull.user.login === bot.login &&
    sameRepo(pull.base?.repo) && sameRepo(pull.head?.repo) &&
    pull.base.ref === 'main' && pull.base.sha === binding.base &&
    pull.head.ref === branch && pull.head.sha === binding.head &&
    pull.body === `T00-Track: ${binding.track}`, 'HOLD_PUBLISHER_PULL_MISMATCH');
  return pull.number;
}

export async function createPublisher({ appId, installationId, rulesetId, pem, fetchImpl = fetch }) {
  expect(positiveInteger(appId) && appId !== APPROVER_APP_ID &&
    positiveInteger(installationId) && positiveInteger(rulesetId), 'HOLD_PUBLISHER_CONFIGURATION');
  const jwt = createAppJwt(appId, pem);
  const api = createApi(fetchImpl);
  const app = await api('/app', { token: jwt, label: 'PUBLISHER_APP' });
  expect(app?.id === appId && app.owner?.id === OWNER_ID && app.owner.login === OWNER &&
    typeof app.slug === 'string' && SLUG.test(app.slug) &&
    app.slug !== 't00-independent-approval' && exactPermissions(app.permissions, WRITE_PERMISSIONS),
  'HOLD_PUBLISHER_APP_IDENTITY');

  const installationPath = `/app/installations/${installationId}`;
  const install = await api(installationPath, { token: jwt, label: 'PUBLISHER_INSTALLATION' });
  expect(install?.id === installationId && install.app_id === appId && install.app_slug === app.slug &&
    install.account?.id === OWNER_ID && install.account.login === OWNER &&
    install.repository_selection === 'selected' && install.suspended_at === null &&
    exactPermissions(install.permissions, WRITE_PERMISSIONS), 'HOLD_PUBLISHER_INSTALLATION_SCOPE');

  // Use a metadata-only probe without a repo filter to verify the full installation scope.
  const { token: metadataToken } = await scopedInstallationToken(api, installationPath, jwt, READ_PERMISSIONS);

  const botLogin = `${app.slug}[bot]`;
  const bot = await api(`/users/${encodeURIComponent(botLogin)}`, { token: metadataToken, label: 'PUBLISHER_BOT' });
  expect(positiveInteger(bot?.id) && bot.id !== OWNER_ID && bot.id !== APPROVER_BOT_ID && bot.type === 'Bot' &&
    bot.login === botLogin, 'HOLD_PUBLISHER_BOT_IDENTITY');
  const credentials = await scopedInstallationToken(api, installationPath, jwt, WRITE_PERMISSIONS, [REPOSITORY_ID]);
  const { token } = credentials;
  const read = (path, label, allowMissing = false) => api(path, { token, label, allowMissing });

  async function validateRules(branch) {
    const rules = await read(`${REPO}/rules/branches/${encodeURIComponent(branch)}`, 'PUBLISHER_RULES');
    expect(Array.isArray(rules), 'HOLD_PUBLISHER_RULES');
    const applicableRules = rules.filter((rule) => rule.ruleset_source_type === 'Repository' &&
      rule.ruleset_source === REPOSITORY && rule.ruleset_id === rulesetId);
    const guarded = RULE_TYPES.every((type) => applicableRules.some((rule) => rule.type === type));
    expect(guarded, 'HOLD_PUBLISHER_NAMESPACE_UNPROTECTED');
  }

  return {
    botId: bot.id,
    async transitionTransport(subject, pullRequestNodeId) {
      expect(appId === 5922170 && installationId === 185792757 && rulesetId === 28083525 && bot.id === 361175685,
        'HOLD_PUBLISHER_TRANSITION_IDENTITY');
      return createDotTransitionTransport({ subject, pullRequestNodeId, fetchImpl,
        issueInstallationToken: () => ({ appId, installationId, repository: REPOSITORY, repositoryId: REPOSITORY_ID,
          permissions: { ...WRITE_PERMISSIONS }, ...credentials }) });
    },
    async publish(binding, revalidate) {
      expect(typeof revalidate === 'function', 'HOLD_PUBLISHER_REVALIDATOR');
      const initial = snapshot(binding);
      const planned = JSON.parse(initial);
      const branch = `dot/t00-publisher/${planned.head}`;
      const ref = `refs/heads/${branch}`;
      const refPath = `${REPO}/git/ref/heads/${branch}`;
      const pullListPath = `${REPO}/pulls?state=all&head=${encodeURIComponent(`${OWNER}:${branch}`)}&per_page=100`;
      const validateLatest = async () =>
        expect(snapshot(await revalidate()) === initial, 'HOLD_PUBLISHER_BINDING_CHANGED');
      const receipt = (pullNumber, reused) => ({
        pullNumber, ref, head: planned.head, base: planned.base, tree: planned.tree,
        publisherId: bot.id, appId, installationId, reused,
      });

      await validateRules(branch);
      const pulls = await read(pullListPath, 'PUBLISHER_PULL_LIST');
      expect(Array.isArray(pulls) && pulls.length < 2, 'HOLD_PUBLISHER_DUPLICATE_PULL');
      const existing = await read(refPath, 'PUBLISHER_REF_READ', true);
      if (existing) validateRef(existing, ref, planned.head);
      if (pulls.length === 1) {
        expect(existing, 'HOLD_PUBLISHER_REF_MISSING');
        const number = validatePull(pulls[0], branch, planned, bot);
        validatePull(await read(`${REPO}/pulls/${number}`, 'PUBLISHER_PULL_READ'), branch, planned, bot, number);
        await validateLatest();
        return receipt(number, true);
      }

      if (!existing) {
        await validateLatest();
        const created = await api(`${REPO}/git/refs`, {
          token, body: { ref, sha: planned.head }, label: 'PUBLISHER_CREATE_REF',
        });
        validateRef(created, ref, planned.head);
        validateRef(await read(refPath, 'PUBLISHER_REF_READ_BACK'), ref, planned.head);
      }

      await validateRules(branch);
      await validateLatest();
      const created = await api(`${REPO}/pulls`, {
        token, label: 'PUBLISHER_CREATE_PULL',
        body: {
          title: `${planned.track}: Dot candidate ${planned.head.slice(0, 12)}`,
          body: `T00-Track: ${planned.track}`,
          head: branch,
          base: 'main',
          draft: true,
        },
      });
      const number = validatePull(created, branch, planned, bot);
      validatePull(await read(`${REPO}/pulls/${number}`, 'PUBLISHER_PULL_READ_BACK'), branch, planned, bot, number);
      return receipt(number, false);
    },
  };
}
