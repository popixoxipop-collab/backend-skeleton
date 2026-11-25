import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeExactDotPullRequest, readyExactDotPullRequest } from './t00-exact-ready-merge.mjs';

const subject = Object.freeze({
  repo: 'popixoxipop-collab/backend-skeleton', repositoryId: 100, pr: 395,
  task: 'T03-06', scope: 'historical-installed-pair-sigterm-rollback-replay',
  base: 'a'.repeat(40), head: 'b'.repeat(40), tree: 'c'.repeat(40),
});
const merge = 'd'.repeat(40);
const other = 'e'.repeat(40);
const appId = 15368;
const nodeId = 'PR_kwDOT5FBgs8AAAABR3_Umg';
const root = `/repos/${subject.repo}`;

function mock({ draft = true, ambiguous = false, replyMismatch = false,
  noServerWrite = false, mergerId = 361175685, mutateAuthorization = () => {} } = {}) {
  const repository = { id: subject.repositoryId, full_name: subject.repo };
  const state = {
    pull: {
      number: subject.pr, node_id: nodeId, state: 'open', draft, merged: false, mergeable: true,
      user: { id: 361175685, type: 'Bot' },
      base: { repo: repository, ref: 'main', sha: subject.base },
      head: { repo: repository, ref: `dot/t00-publisher/${subject.head}`, sha: subject.head },
    },
    branch: {
      name: 'main', protected: true, commit: { sha: subject.base },
      protection: { required_status_checks: { checks: [{ context: 'unit', app_id: appId }] } },
    },
    head: { sha: subject.head, tree: { sha: subject.tree }, parents: [{ sha: subject.base }] },
    merge: { sha: merge, tree: { sha: subject.tree }, parents: [{ sha: subject.base }, { sha: subject.head }] },
  };
  const mutations = [];
  const reads = [];
  const authorize = async (authorizedSubject, phase) => {
    assert.deepEqual(authorizedSubject, subject);
    assert.equal(Object.isFrozen(authorizedSubject), true);
    const now = Math.floor(Date.now() / 1000);
    const proof = {
      ...authorizedSubject, verifiedAt: now, expiresAt: now + 600,
      dotIntentSha256: '1'.repeat(64), productEvidenceSha256: '2'.repeat(64),
      independentReviewSha256: '3'.repeat(64),
      policy: {
        strictCurrentBase: true, mainBlocksForcePushes: true, publisherCannotBypassMain: true,
        publisherOwnsHeadRef: true, requiredChecksPassed: true, requiredReviewsSatisfied: phase === 'merge',
        requiredChecks: [{ context: 'unit', appId }],
      },
    };
    mutateAuthorization(proof, state, phase);
    return proof;
  };
  const client = {
    installationAppId: 5922170,
    async rest(method, path, body) {
      if (method === 'PUT') {
        mutations.push({ method, path, body });
        if (!noServerWrite) {
          Object.assign(state.pull, {
            state: 'closed', merged: true, merge_commit_sha: merge, merged_by: { id: mergerId, type: 'Bot' },
          });
          state.branch.commit.sha = merge;
        }
        if (ambiguous) throw new Error('connection lost');
        return { merged: true, sha: replyMismatch ? other : merge };
      }
      assert.equal(method, 'GET');
      reads.push(path);
      const responses = {
        [`${root}/pulls/${subject.pr}`]: state.pull,
        [`${root}/branches/main`]: state.branch,
        [`${root}/git/commits/${subject.head}`]: state.head,
        [`${root}/git/commits/${merge}`]: state.merge,
      };
      assert.ok(Object.hasOwn(responses, path), `unexpected GET ${path}`);
      return structuredClone(responses[path]);
    },
    async graphql(query, variables) {
      assert.match(query, /markPullRequestReadyForReview/u);
      mutations.push({ method: 'GraphQL', variables });
      if (!noServerWrite) state.pull.draft = false;
      if (ambiguous) throw new Error('connection lost');
      return { data: { markPullRequestReadyForReview: { pullRequest: {
        id: replyMismatch ? 'different-node' : nodeId,
        number: subject.pr, isDraft: false, headRefOid: subject.head, baseRefOid: subject.base,
      } } } };
    },
  };
  return { client, authorize, state, mutations, reads };
}

test('opens exact Dot draft for review, then merges it with head CAS and verifies the result', async () => {
  const github = mock();
  const ready = await readyExactDotPullRequest(subject, github);
  assert.deepEqual(ready, { ...subject, stage: 'ready', acknowledged: true });
  const merged = await mergeExactDotPullRequest(subject, github);
  assert.deepEqual(merged, { ...subject, stage: 'merged', merge, acknowledged: true });
  assert.deepEqual(github.mutations, [
    { method: 'GraphQL', variables: { pullRequestId: nodeId } },
    { method: 'PUT', path: `${root}/pulls/${subject.pr}/merge`, body: { sha: subject.head, merge_method: 'merge' } },
  ]);
  assert.equal(github.reads.at(-1), `${root}/git/commits/${merge}`);
});

test('stale subjects, insufficient protection and missing authorization make zero writes', async t => {
  const cases = [
    ['wrong publisher', ({ pull }) => { pull.user.id += 1; }, /HOLD_EXACT_DOT_PR/u],
    ['stale head', ({ pull }) => { pull.head.sha = other; }, /HOLD_EXACT_DOT_PR/u],
    ['non-Draft', ({ pull }) => { pull.draft = false; }, /HOLD_PR_STAGE/u],
    ['wrong base', ({ branch }) => { branch.commit.sha = other; }, /HOLD_STALE_PROTECTED_BASE/u],
    ['missing expected parent', ({ head }) => { head.parents.push({ sha: other }); }, /HOLD_CANDIDATE_TREE_OR_PARENT/u],
    ['missing app pin', ({ branch }) => { branch.protection.required_status_checks.checks[0].app_id = -1; },
      /HOLD_UNVERIFIED_REQUIRED_CHECKS/u],
  ];
  for (const [name, invalidate, expected] of cases) {
    await t.test(name, async () => {
      const github = mock();
      invalidate(github.state);
      await assert.rejects(readyExactDotPullRequest(subject, github), expected);
      assert.deepEqual(github.mutations, []);
    });
  }
  const proofs = [
    ['different authorized tree', proof => { proof.tree = other; }, /HOLD_EXACT_TRANSITION_AUTHORIZATION/u],
    ['loose status checks', proof => { proof.policy.strictCurrentBase = false; }, /HOLD_EXACT_TRANSITION_AUTHORIZATION/u],
    ['unsafe bypass', proof => { proof.policy.publisherCannotBypassMain = false; }, /HOLD_EXACT_TRANSITION_AUTHORIZATION/u],
    ['pending CI', proof => { proof.policy.requiredChecksPassed = false; }, /HOLD_EXACT_TRANSITION_AUTHORIZATION/u],
    ['missing independent review', proof => { delete proof.independentReviewSha256; }, /HOLD_EXACT_TRANSITION_AUTHORIZATION/u],
    ['missing branch-required review', proof => { proof.policy.requiredReviewsSatisfied = false; },
      /HOLD_EXACT_TRANSITION_AUTHORIZATION/u],
    ['stale verification', proof => { proof.verifiedAt -= 301; proof.expiresAt -= 301; }, /HOLD_STALE_TRANSITION_AUTHORIZATION/u],
    ['check app changed', (proof, { branch }) => { branch.protection.required_status_checks.checks[0].app_id += 1; },
      /HOLD_REQUIRED_CHECKS_CHANGED/u],
    ['base advanced during approval', (proof, { branch }) => { branch.commit.sha = other; }, /HOLD_STALE_PROTECTED_BASE/u],
    ['PR node changed during approval', (proof, { pull }) => { pull.node_id = 'different-node'; }, /HOLD_EXACT_DOT_PR/u],
  ];
  for (const [name, mutateAuthorization, expected] of proofs) {
    await t.test(name, async () => {
      const github = mock({ draft: false, mutateAuthorization });
      await assert.rejects(mergeExactDotPullRequest(subject, github), expected);
      assert.deepEqual(github.mutations, []);
    });
  }
});

test('ambiguous transport reconciles exact state once per write without attributing it', async () => {
  const github = mock({ ambiguous: true });
  assert.deepEqual(await readyExactDotPullRequest(subject, github), { ...subject, stage: 'ready', acknowledged: false });
  assert.deepEqual(await mergeExactDotPullRequest(subject, github), { ...subject, stage: 'merged', merge, acknowledged: false });
  assert.equal(github.mutations.length, 2);
});

test('ambiguous or visibly wrong result is held without retry or a merged receipt', async () => {
  const untouched = mock({ draft: false, ambiguous: true, noServerWrite: true });
  await assert.rejects(mergeExactDotPullRequest(subject, untouched), /HOLD_UNCONFIRMED_GITHUB_MERGE/u);
  assert.equal(untouched.mutations.length, 1);

  const wrongNode = mock({ replyMismatch: true });
  await assert.rejects(readyExactDotPullRequest(subject, wrongNode), /HOLD_READY_RESPONSE_MISMATCH/u);
  assert.equal(wrongNode.mutations.length, 1);

  const wrongParents = mock({ draft: false });
  wrongParents.state.merge.parents.reverse();
  await assert.rejects(mergeExactDotPullRequest(subject, wrongParents), /HOLD_GITHUB_MERGE_BINDING/u);
  assert.equal(wrongParents.mutations.length, 1);

  const wrongTree = mock({ draft: false, ambiguous: true });
  wrongTree.state.merge.tree.sha = other;
  await assert.rejects(mergeExactDotPullRequest(subject, wrongTree), /HOLD_GITHUB_MERGE_BINDING/u);
  assert.equal(wrongTree.mutations.length, 1);

  const otherMerger = mock({ draft: false, ambiguous: true, mergerId: 261965176 });
  await assert.rejects(mergeExactDotPullRequest(subject, otherMerger), /HOLD_GITHUB_MERGE_ACTOR/u);
  assert.equal(otherMerger.mutations.length, 1);
});
