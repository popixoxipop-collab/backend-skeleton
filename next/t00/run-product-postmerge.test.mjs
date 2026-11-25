import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { verifyPromotionAuthorization } from './promotion-authority.mjs';
import { buildPostmergeAttestation, verifyPostmergeGitHub, verifyPostmergeReplay, verifyPostmergeTrigger,
  waitForPostmergeCI } from './run-product-postmerge.mjs';

const repo = 'popixoxipop-collab/backend-skeleton';
const repoId = 1334919554;
const repository = { id: repoId, full_name: repo };
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const merge = 'd'.repeat(40);
const baseTree = 'e'.repeat(40);
const movedMain = 'f'.repeat(40);
const hash = value => createHash('sha256').update(value).digest('hex');
const iso = seconds => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
const checks = [{ context: 'test', appId: 15368 }];
const subject = { repo, repositoryId: repoId, pr: 397, task: 'T03-06', scope: 'historical-installed-package-replay',
  base, head, tree };
const permit = { subject, baseTree, productEvidenceSha256: 'a'.repeat(64), receiptSha256: 'f'.repeat(64),
  productRunId: 20, productAttempt: 2, commentId: 25, dotIntentSha256: 'b'.repeat(64),
  independentReviewSha256: 'c'.repeat(64), prCiRunId: 30, verifiedAt: 1010, expiresAt: 1030,
  policy: { requiredChecks: checks } };
const merged = { merge, pr: subject.pr, head, tree, base };
const replayRun = { id: 20, run_attempt: 2, event: 'issue_comment', path: '.github/workflows/t00-product-replay.yml',
  head_branch: 'main', head_sha: base, status: 'completed', conclusion: 'success', repository, updated_at: iso(1005) };
const event = { action: 'completed', repository, workflow_run: replayRun };
const env = { GITHUB_REPOSITORY: repo, GITHUB_REPOSITORY_ID: String(repoId), GITHUB_EVENT_NAME: 'workflow_run',
  GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: repo + '/.github/workflows/t00-product-transition.yml@refs/heads/main',
  GITHUB_SHA: base, GITHUB_RUN_ID: '40', GITHUB_RUN_ATTEMPT: '1' };
const target = verifyPostmergeTrigger({ env, event, permit, merged });
const historicalArchive = '598fb1cbcfd4d0e2e8842b2c120efeac2b76112a25e589b1f14450deea00dc5a';
const reproducedArchive = 'caa66cfd979341fa63e441af3d38184ef52a5e6d73b4749afeb1ebcaefbe5742';
const replay = { schema: 't00.t03-exact-pr-replay/3', phase: 'postmerge', pull_request: target.pr,
  base, base_tree: baseTree, source_head: head, tested_commit: merge, tested_tree: tree,
  historical_archive_sha256: historicalArchive, replayed_historical_archive_sha256: reproducedArchive,
  historical_archive_kind: 'reproduced-from-pinned-historical-tree', base_archive_sha256: reproducedArchive,
  candidate_archive_sha256: reproducedArchive, package_file_bytes_match_official_baseline: true,
  package_members: 424, candidate_tests_executed: false, requires_separate_github_ci_and_authority: true,
  normal_restore: true, sigterm_probe_restore: true, node: 'v26.7.0', npm: '11.19.0',
  release_authorized: false, runtime_certified: false, previous_installed_inventory_sha256: 'd'.repeat(64),
  scope_paths: ['test/capability-next/historical-installed-pair.test.mjs', 'test/capability-next/historical-installed-probe.mjs'],
  outcome: { legacy_policy: 'supported', unknown_policy: 'rejected', runtime_certification: 'rejected' } };
const replayStdout = JSON.stringify(replay) + '\n';

function readFixture(replacements = {}) {
  const apiBot = { id: 361175685, type: 'Bot' };
  const response = {
    '/pulls/397': { number: 397, state: 'closed', merged: true, draft: false, merge_commit_sha: merge, merged_at: iso(1012),
      head: { sha: head, ref: 'dot/t00-publisher/' + head, repo: repository }, base: { ref: 'main', repo: repository },
      user: apiBot, merged_by: apiBot },
    ['/git/commits/' + merge]: { sha: merge, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] },
    ['/git/commits/' + base]: { sha: base, tree: { sha: baseTree } },
    '/branches/main': { name: 'main', protected: true, commit: { sha: movedMain },
      protection: { required_status_checks: { checks: [{ context: 'test', app_id: 15368 }] } } },
    '/actions/runs/20/attempts/2': replayRun,
    '/issues/comments/25': { id: 25 },
    ['/compare/' + merge + '...' + movedMain + '?per_page=1']: { status: 'ahead', merge_base_commit: { sha: merge } },
    ...replacements,
  };
  return async path => {
    assert.ok(Object.hasOwn(response, path), path);
    return response[path];
  };
}

const verifyOriginal = ({ now }) => {
  assert.equal(now, 1012);
  return { commentId: 25, dotIntentSha256: permit.dotIntentSha256, subject };
};

test('accepts only the exact protected workflow and signed premerge run', () => {
  assert.equal(target.merge, merge);
  assert.throws(() => verifyPostmergeTrigger({ env, event, permit, merged: { ...merged, base: movedMain } }),
    /HOLD_POSTMERGE_PERMIT_BINDING/u);
  assert.throws(() => verifyPostmergeTrigger({ env, event: { ...event, workflow_run: { ...replayRun, run_attempt: 3 } },
    permit, merged }), /HOLD_POSTMERGE_WORKFLOW_IDENTITY/u);
});

test('verifies the Bot merge, its still-protected ancestry, and the original Dot intent at merge time', async () => {
  assert.deepEqual(await verifyPostmergeGitHub(readFixture(), target, permit, verifyOriginal),
    { mergedAt: 1012, main: movedMain, required: checks });
  await assert.rejects(verifyPostmergeGitHub(readFixture({
    ['/compare/' + merge + '...' + movedMain + '?per_page=1']: { status: 'diverged', merge_base_commit: { sha: base } },
  }), target, permit, verifyOriginal), /HOLD_POSTMERGE_MERGE_NOT_IN_MAIN/u);
  await assert.rejects(verifyPostmergeGitHub(readFixture(), target, { ...permit, expiresAt: 1012 }, verifyOriginal),
    /HOLD_POSTMERGE_EXACT_BOT_MERGE/u);
});

test('waits for the exact main push CI and its App checks, rejecting a completed failed run', async () => {
  const ciRun = { id: 30, run_attempt: 1, head_sha: head, path: '.github/workflows/ci.yml', event: 'pull_request',
    status: 'completed', conclusion: 'success', repository };
  const mainRun = { ...ciRun, id: 31, head_sha: merge, head_branch: 'main', event: 'push' };
  const check = (runId, sha) => ({ name: 'test', app: { id: 15368 }, head_sha: sha, status: 'completed',
    conclusion: 'success', details_url: 'https://github.com/' + repo + '/actions/runs/' + runId + '/job/1' });
  const path = '/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=' + merge + '&per_page=10';
  function mock(conclusion) {
    let waited = false;
    const read = async endpoint => {
      if (endpoint === path) return { total_count: 1, workflow_runs: [waited ? { ...mainRun, conclusion } :
        { ...mainRun, status: 'in_progress', conclusion: null }] };
      if (endpoint === '/actions/runs/30') return ciRun;
      const sha = endpoint.includes(head) ? head : merge;
      return { total_count: 1, check_runs: [check(sha === head ? 30 : 31, sha)] };
    };
    return { read, wait: async () => { waited = true; } };
  }
  const passing = mock('success');
  assert.deepEqual(await waitForPostmergeCI(passing.read, target, permit, checks, { attempts: 2, wait: passing.wait }),
    { pr: ciRun, main: mainRun });
  const failing = mock('failure');
  await assert.rejects(waitForPostmergeCI(failing.read, target, permit, checks, { attempts: 2, wait: failing.wait }),
    /HOLD_POSTMERGE_MAIN_CI_FAILED/u);
});

test('emits a canonical attestation accepted by the ledger verifier and binds both exact manifests', () => {
  const product = generateKeyPairSync('ed25519');
  const dot = generateKeyPairSync('ed25519');
  const pub = key => key.export({ format: 'der', type: 'spki' }).toString('base64');
  const issuedAt = 1100;
  const result = buildPostmergeAttestation({ target, permit, ci: { pr: { id: 30, run_attempt: 1 },
    main: { id: 31, run_attempt: 2 } }, required: checks, mergedAt: 1012, main: movedMain, replayStdout,
  verifierSha256: 'e'.repeat(64), issuedAt,
  encodedKey: product.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  expectedProductPublicDer: pub(product.publicKey) });
  const promotion = { schema: 't00.met-promotion-request/1', ...target, revision: 264,
    stateSha256: '1'.repeat(64), auditSha256: '2'.repeat(64),
    attestationSha256: result.envelope.attestationSha256, issuedAt, expiresAt: issuedAt + 60 };
  const bytes = Buffer.from(JSON.stringify(promotion));
  const request = { body: bytes.toString('base64url'), signature: sign(null, bytes, dot.privateKey).toString('base64url') };
  const authority = { schema: 't00.met-promotion-authority/1', dotPublicDer: pub(dot.publicKey),
    productPublicDer: pub(product.publicKey),
    scopes: { 'T03-06': { repository: repo, repositoryId: repoId, scope: target.scope } } };
  const accepted = verifyPromotionAuthorization({ envelope: { request, attestation: result.envelope.attestation },
    authority, now: issuedAt });
  assert.equal(accepted.attestation.independentManifestSha256, hash(result.independent));
  assert.equal(accepted.attestation.adjudicationManifestSha256, hash(result.adjudication));
  assert.equal(JSON.parse(result.independent).postmerge.testedCommit, merge);
  assert.equal(JSON.parse(result.adjudication).protectedMain, movedMain);
  assert.throws(() => verifyPostmergeReplay(JSON.stringify({ ...replay, tested_commit: head }) + '\n', target, permit),
    /HOLD_POSTMERGE_PRODUCT_REPLAY/u);
});
