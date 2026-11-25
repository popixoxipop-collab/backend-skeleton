import assert from 'node:assert/strict';
import test from 'node:test';
import { createDotTransitionTransport } from './t00-dot-transition-transport.mjs';
import { mergeExactDotPullRequest, readyExactDotPullRequest } from './t00-exact-ready-merge.mjs';

const subject = { repo: 'popixoxipop-collab/backend-skeleton', repositoryId: 1334919554, pr: 395,
  task: 'T03-06', scope: 'historical-installed-package-replay', base: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40) };
const now = 1_795_622_400_000;
const merge = 'd'.repeat(40);
const nodeId = 'PR_test_395';
const token = 'ghs_' + 'x'.repeat(32);
const api = 'https://api.github.com';
const repoPath = `/repos/${subject.repo}`;
const pullPath = `${repoPath}/pulls/${subject.pr}`;
const mergePath = `${pullPath}/merge`;
const mergeCommitPath = `${repoPath}/git/commits/${merge}`;
const put = { sha: subject.head, merge_method: 'merge' };
const markReady = `mutation MarkExactDotPullRequestReady($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
    pullRequest { id number isDraft headRefOid baseRefOid }
  }
}`;
const variables = { pullRequestId: nodeId };

function mock({ draft = true, writeResponseLost = false, authChange = {}, pullChange = {},
  onRequest = () => undefined } = {}) {
  const repository = { id: subject.repositoryId, full_name: subject.repo };
  const pull = { number: subject.pr, node_id: nodeId, state: 'open', draft, merged: false, mergeable: true,
    user: { id: 361175685, type: 'Bot' }, base: { repo: repository, ref: 'main', sha: subject.base },
    head: { repo: repository, ref: `dot/t00-publisher/${subject.head}`, sha: subject.head }, ...pullChange };
  const branch = { name: 'main', protected: true, commit: { sha: subject.base },
    protection: { required_status_checks: { checks: [{ context: 'unit', app_id: 15368 }] } } };
  const requests = [];
  const issueInstallationToken = async expected => {
    assert.deepEqual(expected, { appId: 5922170, installationId: 185792757, repository: subject.repo,
      repositoryId: subject.repositoryId, permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } });
    assert.ok(Object.isFrozen(expected) && Object.isFrozen(expected.permissions));
    return { ...expected, token, expiresAt: now + 3600, ...authChange };
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.ok(options.signal instanceof AbortSignal);
    const injected = onRequest(url, options);
    if (injected) return injected;
    if (options.method === 'POST' && url === `${api}/graphql`) {
      assert.deepEqual(JSON.parse(options.body), { query: markReady, variables });
      pull.draft = false;
      if (writeResponseLost) throw new Error('transport closed');
      return Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { id: nodeId,
        number: subject.pr, isDraft: false, headRefOid: subject.head, baseRefOid: subject.base } } } });
    }
    if (options.method === 'PUT' && url === `${api}${mergePath}`) {
      assert.deepEqual(JSON.parse(options.body), put);
      Object.assign(pull, { state: 'closed', merged: true, merge_commit_sha: merge, merged_by: { id: 361175685, type: 'Bot' } });
      branch.commit.sha = merge;
      if (writeResponseLost) throw new Error('transport closed');
      return Response.json({ merged: true, sha: merge });
    }
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    switch (url) {
    case `${api}${pullPath}`: return Response.json(pull);
    case `${api}${repoPath}/branches/main`: return Response.json(branch);
    case `${api}${repoPath}/git/commits/${subject.head}`:
      return Response.json({ sha: subject.head, tree: { sha: subject.tree }, parents: [{ sha: subject.base }] });
    case `${api}${mergeCommitPath}`:
      return Response.json({ sha: merge, tree: { sha: subject.tree }, parents: [{ sha: subject.base }, { sha: subject.head }] });
    default: assert.fail(`unexpected request to ${url}`);
    }
  };
  return { create: (overrides = {}) => createDotTransitionTransport({ subject, pullRequestNodeId: nodeId,
    issueInstallationToken, fetchImpl, clock: () => now, ...overrides }), requests, pull };
}

async function authorize(authorizedSubject, phase) {
  assert.deepEqual(authorizedSubject, subject);
  const verifiedAt = Math.floor(Date.now() / 1000);
  return { ...subject, verifiedAt, expiresAt: verifiedAt + 300, dotIntentSha256: '1'.repeat(64),
    productEvidenceSha256: '2'.repeat(64), independentReviewSha256: '3'.repeat(64),
    policy: { strictCurrentBase: true, mainBlocksForcePushes: true, publisherCannotBypassMain: true,
      publisherOwnsHeadRef: true, requiredChecksPassed: true, requiredReviewsSatisfied: phase === 'merge',
      requiredChecks: [{ context: 'unit', appId: 15368 }] } };
}

test('outer exact executor can read, open, merge and read back using only the scoped transport', async () => {
  const github = mock();
  const client = await github.create();
  assert.deepEqual(Object.keys(client), ['installationAppId', 'rest', 'graphql']);
  assert.ok(Object.isFrozen(client));
  assert.deepEqual(await readyExactDotPullRequest(subject, { client, authorize }), { ...subject, stage: 'ready', acknowledged: true });
  assert.deepEqual(await mergeExactDotPullRequest(subject, { client, authorize }), { ...subject, stage: 'merged', merge, acknowledged: true });
  const writes = github.requests.filter(({ options }) => options.method !== 'GET');
  assert.deepEqual(writes.map(({ url, options }) => [url, options.method]), [[`${api}/graphql`, 'POST'], [`${api}${mergePath}`, 'PUT']]);
  assert.equal(github.requests.at(-1).url, `${api}${mergeCommitPath}`);
});

test('rejects unsupported destinations, verbs, cross-target data, trailing headers, and alternate GraphQL', async () => {
  const github = mock();
  const client = await github.create();
  const invalid = [
    () => client.rest('GET', `https://example.org${pullPath}`),
    () => client.rest('GET', `${pullPath}?per_page=1`),
    () => client.rest('GET', pullPath, { headers: {} }),
    () => client.rest('GET', pullPath, undefined, { headers: {} }),
    () => client.rest('GET', `${repoPath}/pulls/396`),
    () => client.rest('GET', '/repos/other/backend-skeleton/branches/main'),
    () => client.rest('GET', mergeCommitPath),
    () => client.rest('GET', `${repoPath}/branches/other`),
    () => client.rest('PATCH', pullPath, { draft: false }),
    () => client.rest('POST', mergePath, put),
    () => client.rest('PUT', `${repoPath}/pulls/396/merge`, put),
    () => client.rest('PUT', mergePath, { ...put, sha: merge }),
    () => client.rest('PUT', mergePath, { ...put, merge_method: 'squash' }),
    () => client.rest('PUT', mergePath, { ...put, commit_message: 'unsafe' }),
    () => client.graphql(markReady + '\nmutation Other { anything }', variables),
    () => client.graphql(markReady, { pullRequestId: 'PR_test_396' }),
    () => client.graphql(markReady, { ...variables, headers: {} }),
    () => client.graphql(markReady, variables, { headers: {} }),
  ];
  for (const call of invalid) await assert.rejects(call, /HOLD_DOT_TRANSITION_TRANSPORT_REQUEST/u);
  assert.deepEqual(github.requests, []);
});

test('requires a fresh exact pull read and refuses a wrong node or wrong head without any writes', async () => {
  const github = mock({ pullChange: { node_id: 'PR_other' } });
  const client = await github.create();
  await assert.rejects(() => client.graphql(markReady, variables), /HOLD_DOT_TRANSITION_TRANSPORT_STAGE/u);
  await assert.rejects(() => client.rest('PUT', mergePath, put), /HOLD_DOT_TRANSITION_TRANSPORT_STAGE/u);
  await assert.rejects(() => client.rest('GET', pullPath), /HOLD_DOT_TRANSITION_EXACT_PULL/u);
  assert.equal(github.requests.length, 1);
  assert.equal(github.requests[0].options.method, 'GET');
});

test('reconciles an ambiguous write through the outer executor and does not repeat it', async () => {
  const github = mock({ writeResponseLost: true });
  const client = await github.create();
  assert.equal((await readyExactDotPullRequest(subject, { client, authorize })).acknowledged, false);
  assert.equal((await mergeExactDotPullRequest(subject, { client, authorize })).acknowledged, false);
  await assert.rejects(() => client.graphql(markReady, variables), /HOLD_DOT_TRANSITION_TRANSPORT_STAGE/u);
  await assert.rejects(() => client.rest('PUT', mergePath, put), /HOLD_DOT_TRANSITION_TRANSPORT_STAGE/u);
  assert.equal(github.requests.filter(r => r.options.method !== 'GET').length, 2);
});

test('checks exact credential scope and expiry, masks issuer errors, and prevents token injection', async () => {
  for (const authChange of [{ appId: 1 }, { installationId: 1 }, { repositoryId: 1 }, { repository: 'other/repo' },
    { token: 'ghp_bad' }, { token: `${token}\nauthorization: other` }, { expiresAt: now },
    { permissions: { contents: 'write', pull_requests: 'write', metadata: 'read', administration: 'read' } }]) {
    await assert.rejects(() => mock({ authChange }).create(), /HOLD_DOT_TRANSITION_TOKEN_SCOPE/u);
  }
  await assert.rejects(() => mock().create({ subject: { ...subject, pr: 389 } }), /HOLD_DOT_TRANSITION_TRANSPORT_SCOPE/u);
  await assert.rejects(() => mock().create({ issueInstallationToken: undefined, token }), /HOLD_DOT_TRANSITION_TOKEN_ISSUER/u);
  await assert.rejects(() => mock().create({ issueInstallationToken: async () => { throw new Error(token); } }),
    { message: 'HOLD_DOT_TRANSITION_TOKEN_ISSUER' });
  let clock = now;
  const github = mock();
  const client = await github.create({ clock: () => clock });
  clock += 3600;
  await assert.rejects(() => client.rest('GET', pullPath), /HOLD_DOT_TRANSITION_EXPIRED_TOKEN/u);
  assert.deepEqual(github.requests, []);
});

test('rejects redirects, wrong endpoints, oversized and invalid replies', async () => {
  const wrongEndpoint = new Response('{}');
  Object.defineProperty(wrongEndpoint, 'url', { value: 'https://example.org/' });
  const responses = [
    [Response.redirect('https://example.org'), /HOLD_DOT_TRANSITION_GITHUB_RESPONSE/u],
    [wrongEndpoint, /HOLD_DOT_TRANSITION_GITHUB_RESPONSE/u],
    [new Response('x'.repeat(1_048_577)), /HOLD_DOT_TRANSITION_RESPONSE/u],
    [new Response(new Uint8Array([195, 1])), /HOLD_DOT_TRANSITION_RESPONSE/u],
  ];
  for (const [response, expected] of responses) {
    const client = await mock({ onRequest: () => response }).create();
    await assert.rejects(() => client.rest('GET', pullPath), expected);
  }
});
