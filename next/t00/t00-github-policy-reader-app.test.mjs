import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { createGitHubPolicyReaderApp } from './t00-github-policy-reader-app.mjs';

const appId = 5923844;
const installationId = 185830017;
const repo = 'popixoxipop-collab/backend-skeleton';
const repositoryId = 1334919554;
const api = 'https://api.github.com';
const repoPath = `/repos/${repo}`;
const installPath = `/app/installations/${installationId}`;
const slug = 't00-dot-policy-reader';
const now = Date.parse('2026-11-25T16:30:00Z');
const owner = { login: 'popixoxipop-collab', id: 261965176 };
const repository = { id: repositoryId, full_name: repo, private: false };
const metadata = { metadata: 'read' };
const administrator = { administration: 'read', ...metadata };
const actions = { actions: 'read', ...metadata };
const permissions = { ...administrator, ...actions };
const tokens = ['ghs_fixture_METADATA_0123456789', 'ghs_fixture_ADMIN_0123456789', 'ghs_fixture_ACTIONS_0123456789'];
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const head = 'a'.repeat(40);

function response(url, body, status = 200) {
  const result = Response.json(body, { status });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

function scenario({ edit, artifact = false } = {}) {
  const calls = [];
  let time = now;
  let tokenIndex = 0;
  const app = { id: appId, slug, owner, permissions };
  const installation = { id: installationId, app_id: appId, app_slug: slug, account: owner,
    repository_selection: 'selected', suspended_at: null, permissions };
  const jwtPaths = new Set(['/app', installPath, `${installPath}/access_tokens`]);
  const credentials = [metadata, administrator, actions];
  const settings = { appId, installationId, privateKeyPem, clock: () => time,
    async fetchImpl(url, options) {
      assert.ok(url.startsWith(api), url);
      const path = url.slice(api.length);
      const index = tokenIndex;
      const auth = options.headers.Authorization;
      calls.push({ path, options });
      if (jwtPaths.has(path)) {
        const [header, payload, signature] = auth.slice('Bearer '.length).split('.');
        assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
        assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')),
          { iat: now / 1000 - 60, exp: now / 1000 + 480, iss: String(appId) });
        assert.ok(verify('RSA-SHA256', `${header}.${payload}`, publicKey, Buffer.from(signature, 'base64url')));
      }
      let data;
      let status = 200;
      if (path === '/app') data = structuredClone(app);
      else if (path === installPath) data = structuredClone(installation);
      else if (path === `${installPath}/access_tokens`) {
        assert.equal(options.method, 'POST');
        const requested = index === 0 ? { permissions: credentials[index] } :
          { permissions: credentials[index], repository_ids: [repositoryId] };
        assert.deepEqual(JSON.parse(options.body), requested);
        data = { token: tokens[tokenIndex++], expires_at: new Date(now + 3600 * 1000).toISOString(),
          repository_selection: 'selected', permissions: { ...credentials[index] } };
        status = 201;
      } else if (path === '/installation/repositories?per_page=2') {
        assert.equal(auth, `Bearer ${tokens[index - 1]}`);
        data = { total_count: 1, repositories: [{ ...repository }] };
      } else if (path.startsWith(repoPath)) {
        data = { observed: true, path };
        if (path.includes('/actions/')) status = 404;
      } else assert.fail(`unexpected request: ${path}`);
      if (path !== `${installPath}/access_tokens`) {
        assert.equal(options.method, 'GET');
        assert.equal(options.body, undefined);
      }
      assert.equal(options.redirect, 'error');
      const edited = edit?.(path, data, index) ?? {};
      return response(edited.url ?? url, edited.data ?? data, edited.status ?? status);
    } };
  if (artifact) settings.productArtifact = {
    policy: { workflowId: 77, workflowSha256: 'b'.repeat(64), runScriptSha256: 'c'.repeat(64),
      verifierSha256: 'd'.repeat(64), intentVerifierSha256: 'e'.repeat(64) },
  };
  return { settings, calls, setClock(value) { time = value; } };
}

test('verifies exact App and repository selection before returning policy GET only', async () => {
  const { settings, calls } = scenario();
  const reader = await createGitHubPolicyReaderApp(settings);
  assert.ok(Object.isFrozen(reader));
  assert.deepEqual(Object.keys(reader), ['adminRead']);
  const paths = [repoPath, `${repoPath}/branches/main`, `${repoPath}/branches/main/protection`,
    `${repoPath}/branches/main/protection/required_status_checks`, `${repoPath}/rules/branches/main?per_page=100`,
    `${repoPath}/rules/branches/${encodeURIComponent(`dot/t00-publisher/${head}`)}?per_page=100`,
    `${repoPath}/rulesets/28083525?includes_parents=true`];
  for (const path of paths) assert.deepEqual(await reader.adminRead(path), { observed: true, path });
  assert.deepEqual(calls.slice(6).map(({ options }) => options.headers.Authorization),
    paths.map(path => path.endsWith('/branches/main') ? undefined : `Bearer ${tokens[1]}`));
});

test('rejects another App ID or installation, bad key, redirects and wrong read identities', async t => {
  await t.test('before GitHub when owner pins are wrong or key is invalid', async () => {
    const { settings, calls } = scenario();
    for (const overrides of [{ appId: appId + 1 }, { installationId: installationId + 1 }]) {
      await assert.rejects(createGitHubPolicyReaderApp({ ...settings, ...overrides }), /HOLD_POLICY_READER_CONFIGURATION/);
    }
    await assert.rejects(createGitHubPolicyReaderApp({ ...settings, privateKeyPem: 'not a key' }), /HOLD_POLICY_READER_KEY/);
    assert.equal(calls.length, 0);
  });
  for (const [path, changes, failure] of [
    ['/app', { id: appId + 1 }, 'APP_IDENTITY'],
    ['/app', { owner: { ...owner, id: 99 } }, 'APP_IDENTITY'],
    ['/app', { permissions: { ...permissions, contents: 'write' } }, 'APP_IDENTITY'],
    [installPath, { suspended_at: '2026-11-25T16:00:00Z' }, 'INSTALLATION_IDENTITY'],
    [installPath, { permissions: { ...permissions, administration: 'write' } }, 'INSTALLATION_IDENTITY'],
    [installPath, { repository_selection: 'all' }, 'INSTALLATION_IDENTITY'],
  ]) {
    await t.test(`${path} ${Object.keys(changes).join(',')}`, async () => {
      const { settings, calls } = scenario({ edit: (p, data) => p === path ? { data: { ...data, ...changes } } : undefined });
      await assert.rejects(createGitHubPolicyReaderApp(settings), new RegExp(`HOLD_POLICY_READER_${failure}`));
      assert.ok(calls.every(call => call.options.method === 'GET'));
    });
  }
  await t.test('redirection or mismatched response origin', async () => {
    const { settings, calls } = scenario({ edit: () => ({ url: 'https://untrusted.example/app' }) });
    await assert.rejects(createGitHubPolicyReaderApp(settings), /HOLD_POLICY_READER_ORIGIN/);
    assert.equal(calls.length, 1);
  });
});

test('rejects extra scope without using the affected token on any policy endpoint', async t => {
  for (const [changes, failure] of [
    [{ permissions: { metadata: 'read', administration: 'read' } }, 'TOKEN_SCOPE'],
    [{ expires_at: new Date(now + 30_000).toISOString() }, 'TOKEN_SCOPE'],
    [{ repository_selection: 'all' }, 'TOKEN_SCOPE'],
    [{ token: 'gho_not_an_installation_token' }, 'TOKEN_SCOPE'],
  ]) {
    await t.test(Object.keys(changes)[0], async () => {
      const { settings, calls } = scenario({ edit: (path, data) => path.endsWith('/access_tokens')
        ? { data: { ...data, ...changes } } : undefined });
      await assert.rejects(createGitHubPolicyReaderApp(settings), new RegExp(`HOLD_POLICY_READER_${failure}`));
      assert.equal(calls.length, 3);
    });
  }
  await t.test('a broad installation cannot hide behind the explicit single-repo mint', async () => {
    const { settings, calls } = scenario({ edit: (path, data) => path.startsWith('/installation/repositories')
      ? { data: { ...data, total_count: 2 } } : undefined });
    await assert.rejects(createGitHubPolicyReaderApp(settings), /HOLD_POLICY_READER_REPOSITORY_SCOPE/);
    assert.equal(calls.length, 4);
  });
});

test('does not make network calls for arbitrary paths, cross-repo reads or expired tokens', async () => {
  const { settings, calls, setClock } = scenario();
  const reader = await createGitHubPolicyReaderApp(settings);
  for (const path of [`https://other.com${repoPath}`, `${repoPath}/issues`, `${repoPath}/pulls/1/merge`,
    `${repoPath}/branches/main/protection?alternate=true`, `${repoPath}/rules/branches/dot%2Felse?per_page=100`,
    `${repoPath}/rulesets/0?includes_parents=true`, `${repoPath}/rulesets/10?includes_parents=true&other=1`,
    `${repoPath}/rulesets/9999999999999999?includes_parents=true`, `${repoPath}/../other`]) {
    assert.throws(() => reader.adminRead(path), /HOLD_POLICY_READER_ENDPOINT/);
  }
  setClock(now + 3600 * 1000);
  assert.throws(() => reader.adminRead(`${repoPath}/branches/main/protection`), /HOLD_POLICY_READER_TOKEN_EXPIRED/);
  assert.equal(calls.length, 6);
});

test('optional artifact reader retains separate Actions permission and no public read credential', async () => {
  const { settings, calls } = scenario({ artifact: true });
  const reader = await createGitHubPolicyReaderApp(settings);
  assert.deepEqual(Object.keys(reader), ['adminRead', 'readProductPremergeReceipt', 'discoverProductPremergeReceipt', 'readGitHub']);
  const subject = { repo, repositoryId, pr: 397, task: 'T03-06', scope: 'historical-installed-package-replay',
    base: 'b'.repeat(40), head, tree: 'c'.repeat(40) };
  await assert.rejects(reader.readProductPremergeReceipt({ runId: 101, attempt: 1, commentId: 102, subject,
    dotIntentSha256: 'f'.repeat(64) }), /HOLD_PRODUCT_ARTIFACT_GITHUB_404/);
  assert.deepEqual(calls.slice(8).map(({ path, options }) => [path, options.headers.Authorization]), [
    [`${repoPath}/actions/runs/101/attempts/1`, `Bearer ${tokens[2]}`],
    [`${repoPath}/actions/workflows/77`, `Bearer ${tokens[2]}`],
    [`${repoPath}/branches/main`, undefined],
    [`${repoPath}/issues/comments/102`, undefined],
  ]);
});

test('scopes transition discovery reads to Actions and keeps public Checks and issue reads anonymous', async () => {
  const { settings, calls } = scenario({ artifact: true, edit(path) {
    return path.startsWith(`${repoPath}/actions/`) ? { status: 200 } : {};
  } });
  const reader = await createGitHubPolicyReaderApp(settings);
  const paths = [`${repoPath}/actions/workflows/ci.yml/runs?head_sha=${head}&event=pull_request&per_page=50`,
    `${repoPath}/actions/runs/433`, `${repoPath}/commits/${head}/check-runs?filter=latest&per_page=100`,
    `${repoPath}/issues/comments/555`];
  for (const path of paths) assert.deepEqual(await reader.readGitHub(path), { observed: true, path });
  assert.deepEqual(calls.slice(-4).map(({ options }) => options.headers.Authorization), [
    `Bearer ${tokens[2]}`, `Bearer ${tokens[2]}`, undefined, undefined,
  ]);
  const before = calls.length;
  for (const path of [undefined, `${repoPath}/actions/runs/433/attempts/1`, `${repoPath}/issues/comments/555?x=1`]) {
    assert.throws(() => reader.readGitHub(path), /HOLD_POLICY_READER_ENDPOINT/);
  }
  assert.equal(calls.length, before);
});
