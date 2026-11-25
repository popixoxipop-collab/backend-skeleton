import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { createPublisher } from './dot-publisher-github.mjs';

const appId = 791337;
const installationId = 183332375;
const rulesetId = 10;
const owner = { login: 'popixoxipop-collab', id: 261965176 };
const repository = { full_name: `${owner.login}/backend-skeleton`, id: 1334919554 };
const repo = `/repos/${repository.full_name}`;
const appSlug = 't00-dot-publisher';
const bot = { id: 14905018, login: `${appSlug}[bot]`, type: 'Bot' };
const writePermissions = { contents: 'write', pull_requests: 'write', metadata: 'read' };
const readPermissions = { metadata: 'read' };
const readToken = 'ghs_mockmetadataaaaaaaaaa';
const writeToken = 'ghs_mockappwriterbbbbbbbbb';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' });

const binding = {
  base: '1'.repeat(40), head: '2'.repeat(40), tree: '3'.repeat(40),
  track: 'T03', paths: ['src/b.mjs', 'src/a.mjs'],
};
const branch = `dot/t00-publisher/${binding.head}`;
const ref = `refs/heads/${branch}`;
const number = 81;
const normalRef = { ref, object: { type: 'commit', sha: binding.head } };
const normalPull = {
  number, user: bot, draft: true, state: 'open', body: 'T00-Track: T03',
  base: { ref: 'main', sha: binding.base, repo: repository },
  head: { ref: branch, sha: binding.head, repo: repository },
};

function assertJwt(value) {
  const [header, payload, signature] = value.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  const now = Math.floor(Date.now() / 1000);
  assert.equal(claims.iss, String(appId));
  assert.ok(claims.iat <= now && claims.exp > now && claims.exp - claims.iat <= 600);
  assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), key.publicKey, Buffer.from(signature, 'base64url')));
}

function fixture(options = {}) {
  const calls = [];
  let refData = options.refData;
  let pulls = options.pulls ?? [];
  const fetchImpl = async (url, init) => {
    const uri = new URL(url);
    assert.equal(uri.origin, 'https://api.github.com');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const path = decodeURIComponent(uri.pathname);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const token = init.headers.Authorization?.slice('Bearer '.length);
    calls.push({ path, method: init.method, body });
    if (path === '/app' || path.startsWith('/app/installations/')) assertJwt(token);
    if (path.startsWith(repo)) assert.equal(token, writeToken);
    if (path === '/app') {
      return Response.json({ id: appId, owner, slug: appSlug, permissions: writePermissions, ...options.app });
    }
    if (path === `/app/installations/${installationId}`) {
      return Response.json({
        id: installationId, app_id: appId, app_slug: appSlug, account: owner,
        repository_selection: 'selected', suspended_at: null, permissions: writePermissions,
        ...options.installation,
      });
    }
    if (path === `/app/installations/${installationId}/access_tokens`) {
      const write = Boolean(body.repository_ids);
      assert.deepEqual(body, write ?
        { permissions: writePermissions, repository_ids: [repository.id] } : { permissions: readPermissions });
      return Response.json({
        token: write ? writeToken : readToken,
        permissions: write ? writePermissions : readPermissions,
        repository_selection: 'selected',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }, { status: 201 });
    }
    if (path === '/installation/repositories') {
      const repositories = token === readToken ? (options.installRepositories ?? [repository]) : [repository];
      return Response.json({ total_count: repositories.length, repositories });
    }
    if (path === `/users/${bot.login}`) {
      assert.equal(token, readToken);
      return Response.json({ ...bot, ...options.bot });
    }
    if (path === `${repo}/rules/branches/${branch}`) {
      return Response.json(['creation', 'update', 'deletion'].map((type, index) => ({
        type, ruleset_source_type: 'Repository', ruleset_source: repository.full_name,
        ruleset_id: options.separateRulesets ? rulesetId + index : (options.returnRuleset ?? rulesetId),
      })).filter((rule) => rule.type !== options.missingRule));
    }
    if (path === `${repo}/git/ref/heads/${branch}`) {
      return refData ? Response.json(refData) : new Response(null, { status: 404 });
    }
    if (path === `${repo}/git/refs` && init.method === 'POST') {
      assert.deepEqual(body, { ref, sha: binding.head });
      refData = normalRef;
      return Response.json(refData, { status: 201 });
    }
    if (path === `${repo}/pulls` && init.method === 'GET') {
      assert.equal(uri.searchParams.get('state'), 'all');
      assert.equal(uri.searchParams.get('head'), `${owner.login}:${branch}`);
      return Response.json(pulls);
    }
    if (path === `${repo}/pulls` && init.method === 'POST') {
      assert.deepEqual(body, {
        title: `T03: Dot candidate ${binding.head.slice(0, 12)}`, body: 'T00-Track: T03',
        head: branch, base: 'main', draft: true,
      });
      pulls = [normalPull];
      if (options.ambiguousPost) throw new Error('network failed after accepting the write');
      return Response.json(normalPull, { status: 201 });
    }
    if (path === `${repo}/pulls/${number}`) {
      assert.equal(pulls.length, 1);
      return Response.json({ ...pulls[0], ...options.pullReadBack });
    }
    throw new Error('unexpected request');
  };
  return { calls, publisher: () => createPublisher({ appId, installationId, rulesetId, pem, fetchImpl }) };
}

const mutations = (calls) => calls.filter((call) => call.method === 'POST' && call.path.startsWith(repo));
const fresh = async () => binding;

test('creates the exact ref and Bot Draft after independent revalidation at both writes', async () => {
  const setup = fixture();
  const publisher = await setup.publisher();
  assert.equal(publisher.botId, bot.id);
  const receipt = await publisher.publish(binding, async () => {
    setup.calls.push({ path: 'revalidate' });
    return { ...binding, paths: [...binding.paths].reverse() };
  });
  assert.deepEqual(receipt, {
    pullNumber: number, ref, head: binding.head, base: binding.base, tree: binding.tree,
    publisherId: bot.id, appId, installationId, reused: false,
  });
  assert.deepEqual(mutations(setup.calls).map((call) => call.path), [`${repo}/git/refs`, `${repo}/pulls`]);
  for (const mutation of mutations(setup.calls)) {
    assert.equal(setup.calls[setup.calls.indexOf(mutation) - 1].path, 'revalidate');
  }
  assert.equal(setup.calls.at(-1).path, `${repo}/pulls/${number}`);
});

test('reuses only the matching open Bot Draft and exact immutable ref', async () => {
  const setup = fixture({ refData: normalRef, pulls: [normalPull] });
  const publisher = await setup.publisher();
  assert.equal((await publisher.publish(binding, fresh)).reused, true);
  assert.deepEqual(mutations(setup.calls), []);
});

test('rejects stale bindings before a ref write and again before a Draft write', async () => {
  const first = fixture();
  const firstPublisher = await first.publisher();
  await assert.rejects(firstPublisher.publish(binding, async () => ({ ...binding, base: '4'.repeat(40) })),
    /HOLD_PUBLISHER_BINDING_CHANGED/);
  assert.deepEqual(mutations(first.calls), []);

  const second = fixture();
  const secondPublisher = await second.publisher();
  let validation = 0;
  await assert.rejects(secondPublisher.publish(binding, async () => ++validation === 1 ? binding :
    { ...binding, paths: ['src/other.mjs'] }), /HOLD_PUBLISHER_BINDING_CHANGED/);
  assert.deepEqual(mutations(second.calls).map((call) => call.path), [`${repo}/git/refs`]);
});

test('rejects collisions with a different ref, foreign Draft, closed Draft or duplicate PR', async () => {
  for (const [configuration, code] of [
    [{ refData: { ...normalRef, object: { type: 'commit', sha: '9'.repeat(40) } } }, 'REF_MISMATCH'],
    [{ refData: normalRef, pulls: [{ ...normalPull, user: { ...owner, type: 'User' } }] }, 'PULL_MISMATCH'],
    [{ refData: normalRef, pulls: [{ ...normalPull, state: 'closed' }] }, 'PULL_MISMATCH'],
    [{ refData: normalRef, pulls: [normalPull, normalPull] }, 'DUPLICATE_PULL'],
  ]) {
    const setup = fixture(configuration);
    const publisher = await setup.publisher();
    await assert.rejects(publisher.publish(binding, fresh), new RegExp(`HOLD_PUBLISHER_${code}`));
    assert.deepEqual(mutations(setup.calls), []);
  }
});

test('requires all restrictions to come from the configured active ruleset', async () => {
  for (const rule of [{ missingRule: 'deletion' }, { separateRulesets: true }, { returnRuleset: 999 }]) {
    const setup = fixture(rule);
    const publisher = await setup.publisher();
    await assert.rejects(publisher.publish(binding, fresh), /HOLD_PUBLISHER_NAMESPACE_UNPROTECTED/);
    assert.deepEqual(mutations(setup.calls), []);
  }
});

test('fails before any write token when App, installation or Bot identity is unverified', async () => {
  for (const [configuration, code] of [
    [{ app: { permissions: { ...writePermissions, workflows: 'write' } } }, 'APP_IDENTITY'],
    [{ installation: { repository_selection: 'all' } }, 'INSTALLATION_SCOPE'],
    [{ installRepositories: [repository, { id: 42, full_name: `${owner.login}/other` }] }, 'REPOSITORY_SCOPE'],
    [{ bot: { type: 'User', id: owner.id } }, 'BOT_IDENTITY'],
    [{ bot: { id: 361139581 } }, 'BOT_IDENTITY'],
  ]) {
    const setup = fixture(configuration);
    await assert.rejects(setup.publisher(), new RegExp(`HOLD_PUBLISHER_${code}`));
    assert.ok(!setup.calls.some((call) => call.body?.repository_ids));
    assert.deepEqual(mutations(setup.calls), []);
  }
});

test('does not retry ambiguous publication and reconciles by exact read-back on the next invocation', async () => {
  const setup = fixture({ ambiguousPost: true });
  const publisher = await setup.publisher();
  await assert.rejects(publisher.publish(binding, fresh), /^Error: HOLD_GITHUB_PUBLISHER_CREATE_PULL$/);
  assert.equal(mutations(setup.calls).length, 2);
  assert.equal((await publisher.publish(binding, fresh)).reused, true);
  assert.equal(mutations(setup.calls).length, 2);
});
