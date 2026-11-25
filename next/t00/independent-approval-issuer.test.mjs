import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { createIssuer } from './independent-approval-issuer.mjs';

const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = generateKeyPairSync('ed25519');
const repository = { id: 1334919554, full_name: 'popixoxipop-collab/backend-skeleton' };
const owner = { id: 261965176, login: 'popixoxipop-collab' };
const app = { id: 5920902, owner };
const installationId = 185763944;
const token = 'ghs_test_token_only_has_check_scope';
const candidate = {
  repository: repository.full_name,
  repositoryId: repository.id,
  number: 387,
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  tree: 'c'.repeat(40),
  track: 'T12',
  paths: ['next/one', 'next/two'],
  publisherId: 192233,
  extra: { policySha: 'd'.repeat(64), evidenceIds: [7, 9] },
};

function fixture(replace = () => undefined) {
  const calls = [];
  const issuer = createIssuer({
    appPrivateKey: appKey.privateKey,
    signingKey: signer.privateKey,
    publicKeyDer: signer.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    async fetchImpl(url, options) {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.github.com');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      const path = parsed.pathname;
      const bearer = options.headers.Authorization.split(' ')[1];
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, method: options.method, body });
      if (path === '/app' || path.startsWith('/app/installations/')) {
        const [header, claims, signature] = bearer.split('.');
        const payload = JSON.parse(Buffer.from(claims, 'base64url'));
        assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
        assert.equal(payload.iss, String(app.id));
        assert.ok(payload.iat <= Date.now() / 1000 && payload.exp - payload.iat <= 600);
        assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`),
          appKey.publicKey, Buffer.from(signature, 'base64url')));
      } else {
        assert.equal(bearer, token);
      }
      const custom = await replace(path, body);
      if (custom) return custom;
      switch (path) {
        case '/app':
          return Response.json(app);
        case `/app/installations/${installationId}`:
          return Response.json({
            id: installationId, app_id: app.id, account: owner, repository_selection: 'selected',
            permissions: { checks: 'write', metadata: 'read' }, suspended_at: null,
          });
        case `/app/installations/${installationId}/access_tokens`:
          return Response.json({
            token, repository_selection: 'selected', permissions: { checks: 'write', metadata: 'read' },
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }, { status: 201 });
        case '/installation/repositories':
          return Response.json({ total_count: 1, repositories: [repository] });
        case `/repos/${repository.full_name}/check-runs`:
          return Response.json({ id: 930, app, ...body }, { status: 201 });
        default:
          throw new Error('Unexpected API request');
      }
    },
  });
  return { issuer, calls };
}

function checkPosts(calls) {
  return calls.filter(call => call.method === 'POST' && call.path.endsWith('/check-runs'));
}

test('signs the complete exact binding and writes one scoped, verified Check Run', async () => {
  const { issuer, calls } = fixture();
  const result = await issuer.publish(candidate, () => {
    calls.push({ path: 'revalidate' });
    return Object.fromEntries(Object.entries(candidate).reverse());
  });
  assert.deepEqual(calls.map(x => x.path), [
    '/app',
    `/app/installations/${installationId}`,
    `/app/installations/${installationId}/access_tokens`,
    '/installation/repositories',
    'revalidate',
    `/repos/${repository.full_name}/check-runs`,
  ]);
  assert.deepEqual(calls[2].body, { repository_ids: [repository.id], permissions: { checks: 'write' } });
  const { body } = checkPosts(calls)[0];
  assert.equal(body.head_sha, candidate.head);
  assert.equal(body.name, 't00-independent-approval/verified');
  assert.equal(body.status, 'completed');
  assert.equal(body.conclusion, 'success');
  const { receipt, signature } = JSON.parse(body.output.text);
  assert.deepEqual(receipt.binding, candidate);
  assert.equal(receipt.issuer, `github:app:${app.id}`);
  assert.equal(receipt.installationId, installationId);
  assert.equal(receipt.expiresAt - receipt.issuedAt, 900);
  assert.ok(verify(null, Buffer.from(JSON.stringify(receipt)), signer.publicKey, Buffer.from(signature, 'base64')));
  const digest = createHash('sha256').update(body.output.text).digest('hex');
  assert.equal(body.external_id, digest);
  assert.deepEqual(result, {
    checkRunId: 930, appId: app.id, installationId, head: candidate.head, receiptSha256: digest,
  });
  const check = { id: result.checkRunId, app, ...body };
  assert.equal(issuer.isCurrentReceipt(check, candidate, 300), true);
  assert.equal(issuer.isCurrentReceipt(check, candidate, 900), false);
  assert.equal(issuer.isCurrentReceipt(check, { ...candidate, number: 390 }), false);
  assert.equal(issuer.isCurrentReceipt({ ...check, app: { id: 99 } }, candidate), false);
  const badText = JSON.stringify({ receipt, signature: Buffer.alloc(64).toString('base64') });
  assert.equal(issuer.isCurrentReceipt({
    ...check,
    external_id: createHash('sha256').update(badText).digest('hex'),
    output: { text: badText },
  }, candidate), false);
});

test('rejects an absent callback or invalid candidate before any request', async () => {
  const { issuer, calls } = fixture();
  await assert.rejects(issuer.publish(candidate), /callback required/);
  await assert.rejects(issuer.publish({ ...candidate, repositoryId: 123 }, () => candidate),
    /binding identity/);
  assert.deepEqual(calls, []);
});

test('rejects changed head and any changed nested evidence without Check Run writes', async () => {
  for (const updated of [
    { ...candidate, head: 'e'.repeat(40) },
    { ...candidate, extra: { ...candidate.extra, evidenceIds: [7, 8] } },
  ]) {
    const { issuer, calls } = fixture();
    await assert.rejects(issuer.publish(candidate, () => updated), /binding changed/);
    assert.equal(checkPosts(calls).length, 0);
  }
});

test('rejects the wrong Ed25519 key and redacts malformed key input', () => {
  const wrong = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
  const options = { appPrivateKey: appKey.privateKey, signingKey: signer.privateKey, publicKeyDer: wrong };
  assert.throws(() => createIssuer(options), /keys do not match policy/);
  assert.throws(() => createIssuer({ ...options, signingKey: 'pretend-sensitive-key' }),
    error => error.message === 'Independent approval keys do not match policy');
});

test('rejects an incorrect App or unexpected token repository before candidate revalidation', async () => {
  const wrongApp = fixture(path => path === '/app' ? Response.json({ id: 1, owner }) : undefined);
  await assert.rejects(wrongApp.issuer.publish(candidate, () => candidate), /App identity/);
  assert.equal(wrongApp.calls.length, 1);
  const wrongRepo = fixture(path => path === '/installation/repositories' ?
    Response.json({ total_count: 2, repositories: [repository, { id: 42 }] }) : undefined);
  let revalidated = false;
  await assert.rejects(wrongRepo.issuer.publish(candidate, () => {
    revalidated = true;
    return candidate;
  }), /repository scope/);
  assert.equal(revalidated, false);
  assert.equal(checkPosts(wrongRepo.calls).length, 0);
});

test('requires the Check Run grant without accepting additional App permissions', async () => {
  for (const permissions of [
    { metadata: 'read' },
    { checks: 'write', metadata: 'read', contents: 'write' },
  ]) {
    const { issuer, calls } = fixture(path => path === `/app/installations/${installationId}` ?
      Response.json({
        id: installationId, app_id: app.id, account: owner, repository_selection: 'selected',
        permissions, suspended_at: null,
      }) : undefined);
    await assert.rejects(issuer.publish(candidate, () => candidate), /App installation/);
    assert.equal(calls.length, 2);
    assert.equal(checkPosts(calls).length, 0);
  }
});

test('does not retry or leak text after an ambiguous publication failure', async () => {
  const { issuer, calls } = fixture(path => {
    if (path.endsWith('/check-runs')) throw new Error(token);
  });
  await assert.rejects(issuer.publish(candidate, () => candidate),
    error => error.message === 'GitHub Check Run publication could not be verified');
  assert.equal(checkPosts(calls).length, 1);
});

test('does not accept or retry a Check Run reported by a different app', async () => {
  const { issuer, calls } = fixture((path, body) => path.endsWith('/check-runs') ?
    Response.json({ id: 930, app: { id: 1 }, ...body }, { status: 201 }) : undefined);
  await assert.rejects(issuer.publish(candidate, () => candidate), /Check Run result/);
  assert.equal(checkPosts(calls).length, 1);
});
