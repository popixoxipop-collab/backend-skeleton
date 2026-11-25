import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyGitHubMainPolicy } from './t00-github-main-policy.mjs';

const REPO = 'popixoxipop-collab/backend-skeleton';
const PATH = `/repos/${REPO}`;
const TARGET = { repo: REPO, repositoryId: 1334919554, base: 'a'.repeat(40), head: 'b'.repeat(40) };
const NAMESPACE = `dot/t00-publisher/${TARGET.head}`;
const BRANCH_POLICY = `${PATH}/branches/main/protection`;
const CHECK_POLICY = `${BRANCH_POLICY}/required_status_checks`;
const MAIN = `${PATH}/branches/main`;
const MAIN_RULES = `${PATH}/rules/branches/main?per_page=100`;
const HEAD_RULES = `${PATH}/rules/branches/${encodeURIComponent(NAMESPACE)}?per_page=100`;
const NAMESPACE_POLICY = `${PATH}/rulesets/28083525?includes_parents=true`;

function fixture() {
  const checks = [{ context: 'tests (ubuntu)', app_id: 15368 }, { context: 'lint', app_id: 15368 }];
  const rules = ['update', 'non_fast_forward', 'deletion', 'creation'].map(type => ({ type }));
  const current = {
    [PATH]: { id: TARGET.repositoryId, full_name: REPO, default_branch: 'main', allow_merge_commit: true },
    [MAIN]: { name: 'main', protected: true, commit: { sha: TARGET.base },
      protection: { required_status_checks: { checks: structuredClone(checks).reverse() } } },
    [CHECK_POLICY]: { strict: true, contexts: checks.map(entry => entry.context) },
    [BRANCH_POLICY]: { required_status_checks: { contexts: checks.map(entry => entry.context) },
      enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
      required_linear_history: { enabled: false }, lock_branch: { enabled: false },
      required_pull_request_reviews: { required_approving_review_count: 0, require_code_owner_reviews: false,
        require_last_push_approval: false, bypass_pull_request_allowances: { teams: [], users: [], apps: [] } } },
    [MAIN_RULES]: [],
    [HEAD_RULES]: rules.map(rule => ({ ...rule, ruleset_id: 28083525, ruleset_source_type: 'Repository', ruleset_source: REPO })),
    [NAMESPACE_POLICY]: { id: 28083525, source: REPO, source_type: 'Repository', target: 'branch', enforcement: 'active',
      bypass_actors: [{ actor_type: 'Integration', actor_id: 5922170, bypass_mode: 'always' }],
      conditions: { ref_name: { include: ['refs/heads/dot/t00-publisher/*'], exclude: [] } }, rules },
  };
  const requested = [];
  return { current, requested, adminRead(path) {
    requested.push(path);
    assert.ok(Object.hasOwn(current, path), `unexpected GitHub read ${path}`);
    return structuredClone(current[path]);
  } };
}

test('reads classic strict main and grants only the exact scoped GitHub App ownership policy', async () => {
  const { requested, adminRead } = fixture();
  const policy = await verifyGitHubMainPolicy(TARGET, { adminRead });
  assert.deepEqual(policy, { strictCurrentBase: true, mainBlocksForcePushes: true, mainBlocksDeletion: true,
    mainEnforcesAdmins: true, publisherCannotBypassMain: true, publisherOwnsHeadRef: true, githubRequiredReviewCount: 0,
    requiredChecks: [{ context: 'lint', appId: 15368 }, { context: 'tests (ubuntu)', appId: 15368 }] });
  assert.deepEqual(requested, [PATH, MAIN, BRANCH_POLICY, CHECK_POLICY, MAIN_RULES, HEAD_RULES, NAMESPACE_POLICY, MAIN]);
  assert.equal(Object.hasOwn(policy, 'requiredReviewsSatisfied'), false);
});

test('rejects an unpinned repository before making policy reads', async () => {
  const { adminRead, requested } = fixture();
  await assert.rejects(verifyGitHubMainPolicy({ ...TARGET, repositoryId: 42 }, { adminRead }), /HOLD_GITHUB_MAIN_POLICY_TARGET/u);
  assert.deepEqual(requested, []);
});

test('rejects policy responses that weaken classic main or the publishing namespace', async context => {
  const cases = [
    ['loose status check policy', c => { c[CHECK_POLICY].strict = false; }, /HOLD_MAIN_STRICT_CHECKS/u],
    ['contradictory status check summaries', c => { c[BRANCH_POLICY].required_status_checks.strict = false; }, /HOLD_MAIN_STRICT_CHECKS/u],
    ['missing admin enforcement', c => { delete c[BRANCH_POLICY].enforce_admins; }, /HOLD_MAIN_ADMIN_FORCE_DELETE_PROTECTION/u],
    ['force pushes', c => { c[BRANCH_POLICY].allow_force_pushes.enabled = true; }, /HOLD_MAIN_ADMIN_FORCE_DELETE_PROTECTION/u],
    ['deletions', c => { c[BRANCH_POLICY].allow_deletions.enabled = true; }, /HOLD_MAIN_ADMIN_FORCE_DELETE_PROTECTION/u],
    ['linear history', c => { c[BRANCH_POLICY].required_linear_history.enabled = true; }, /HOLD_MAIN_MERGE_COMMIT_PROTECTION/u],
    ['PR requirement absent', c => { c[BRANCH_POLICY].required_pull_request_reviews = null; }, /HOLD_MAIN_CLASSIC_PULL_REQUEST_POLICY/u],
    ['approval count changed', c => { c[BRANCH_POLICY].required_pull_request_reviews.required_approving_review_count = 1; }, /HOLD_MAIN_CLASSIC_PULL_REQUEST_POLICY/u],
    ['additional code-owner review', c => { c[BRANCH_POLICY].required_pull_request_reviews.require_code_owner_reviews = true; }, /HOLD_MAIN_CLASSIC_PULL_REQUEST_POLICY/u],
    ['classic App bypass', c => { c[BRANCH_POLICY].required_pull_request_reviews.bypass_pull_request_allowances.apps.push({ id: 5922170 }); }, /HOLD_MAIN_CLASSIC_PULL_REQUEST_BYPASS/u],
    ['classic user bypass', c => { c[BRANCH_POLICY].required_pull_request_reviews.bypass_pull_request_allowances.users.push({ id: 42 }); }, /HOLD_MAIN_CLASSIC_PULL_REQUEST_BYPASS/u],
    ['unsigned status check source', c => { c[MAIN].protection.required_status_checks.checks[0].app_id = -1; }, /HOLD_MAIN_REQUIRED_CHECK_IDENTITIES/u],
    ['mismatched public protection', c => { c[MAIN].protection.required_status_checks.checks[0].context = 'unknown'; }, /HOLD_MAIN_REQUIRED_CHECK_CONTEXTS/u],
    ['mismatched optional admin check identity', c => { c[CHECK_POLICY].checks = [{ context: 'lint', app_id: 20 }]; }, /HOLD_MAIN_REQUIRED_CHECK_CONTEXTS/u],
    ['redacted namespace actors', c => { delete c[NAMESPACE_POLICY].bypass_actors; }, /HOLD_GITHUB_RULESET_IDENTITY/u],
    ['additional namespace actor', c => { c[NAMESPACE_POLICY].bypass_actors.push({ actor_type: 'User', actor_id: 42, bypass_mode: 'always' }); }, /HOLD_PUBLISHER_NAMESPACE_SCOPE/u],
    ['namespace includes main', c => { c[NAMESPACE_POLICY].conditions.ref_name.include.push('refs/heads/main'); }, /HOLD_PUBLISHER_NAMESPACE_SCOPE/u],
    ['namespace excludes the target branch', c => { c[NAMESPACE_POLICY].conditions.ref_name.exclude.push(`refs/heads/${NAMESPACE}`); }, /HOLD_PUBLISHER_NAMESPACE_SCOPE/u],
    ['namespace creation restriction missing', c => { c[HEAD_RULES] = c[HEAD_RULES].filter(rule => rule.type !== 'creation'); }, /HOLD_PUBLISHER_NAMESPACE_RULES_NOT_APPLIED/u],
    ['namespace rules effective on main', c => { c[MAIN_RULES] = c[HEAD_RULES]; }, /HOLD_PUBLISHER_NAMESPACE_INCLUDES_MAIN/u],
    ['unknown effective page', c => { c[MAIN_RULES] = Array(100).fill(c[HEAD_RULES][0]); }, /HOLD_GITHUB_EFFECTIVE_RULES_UNVERIFIED/u],
  ];
  for (const [description, change, expected] of cases) {
    await context.test(description, async () => {
      const { current, adminRead } = fixture();
      change(current);
      await assert.rejects(verifyGitHubMainPolicy(TARGET, { adminRead }), expected);
    });
  }
});

test('allows a read-only namespace response only for its owner-enrolled exact rule revision', async () => {
  const { current, adminRead } = fixture();
  const namespaceEnrollment = { rulesetId: 28083525, publisherAppId: 5922170, updatedAt: '2026-11-25T14:30:07.856Z' };
  current[NAMESPACE_POLICY].updated_at = namespaceEnrollment.updatedAt;
  delete current[NAMESPACE_POLICY].bypass_actors;
  assert.equal((await verifyGitHubMainPolicy(TARGET, { adminRead, namespaceEnrollment })).publisherOwnsHeadRef, true);
  current[NAMESPACE_POLICY].updated_at = '2026-11-25T14:30:07.857Z';
  await assert.rejects(verifyGitHubMainPolicy(TARGET, { adminRead, namespaceEnrollment }), /HOLD_GITHUB_RULESET_IDENTITY/u);
  current[NAMESPACE_POLICY].updated_at = namespaceEnrollment.updatedAt;
  current[NAMESPACE_POLICY].bypass_actors = [{ actor_type: 'User', actor_id: 42, bypass_mode: 'always' }];
  await assert.rejects(verifyGitHubMainPolicy(TARGET, { adminRead, namespaceEnrollment }), /HOLD_PUBLISHER_NAMESPACE_SCOPE/u);
});

test('checks inherited rulesets for bypass actors instead of trusting the branch-rule summary alone', async () => {
  const { current, adminRead } = fixture();
  const parentPolicy = `${PATH}/rulesets/44?includes_parents=true`;
  current[MAIN_RULES] = [{ type: 'non_fast_forward', ruleset_id: 44, ruleset_source: 'popixoxipop-collab', ruleset_source_type: 'Organization' }];
  current[parentPolicy] = { id: 44, source: 'popixoxipop-collab', source_type: 'Organization',
    enforcement: 'active', target: 'branch', bypass_actors: [] };
  assert.equal((await verifyGitHubMainPolicy(TARGET, { adminRead })).publisherCannotBypassMain, true);
  current[parentPolicy].bypass_actors.push({ actor_type: 'Integration', actor_id: 5922170, bypass_mode: 'pull_request' });
  await assert.rejects(verifyGitHubMainPolicy(TARGET, { adminRead }), /HOLD_GITHUB_MAIN_RULESET_BYPASS/u);
});

test('rechecks exact protected main after all policy reads', async () => {
  const { requested, adminRead } = fixture();
  await assert.rejects(verifyGitHubMainPolicy(TARGET, { async adminRead(path) {
    const result = adminRead(path);
    if (path === MAIN && requested.filter(request => request === MAIN).length === 2) {
      result.commit.sha = 'c'.repeat(40);
    }
    return result;
  } }), /HOLD_GITHUB_MAIN_BASE_OR_CHECKS_CHANGED/u);
});
