const REPOSITORY = 'popixoxipop-collab/backend-skeleton';
const REPOSITORY_ID = 1334919554;
const PUBLISHER_APP_ID = 5922170;
const NAMESPACE_RULESET_ID = 28083525;
const NAMESPACE = 'dot/t00-publisher/';
const NAMESPACE_RULES = ['creation', 'deletion', 'non_fast_forward', 'update'];
const SHA = /^[a-f0-9]{40}$/u;
const PAGE_SIZE = 100;

function requireIt(condition, code) {
  if (!condition) throw new Error(code);
}

function sameList(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checks(value, appKey) {
  requireIt(Array.isArray(value) && value.length > 0 && value.every(entry =>
    typeof entry?.context === 'string' && entry.context.length > 0 && positiveId(entry[appKey])) &&
    new Set(value.map(entry => entry.context)).size === value.length, 'HOLD_MAIN_REQUIRED_CHECK_IDENTITIES');
  return value.map(entry => ({ context: entry.context, appId: entry[appKey] }))
    .sort((left, right) => left.context === right.context ? 0 : left.context < right.context ? -1 : 1);
}

function verifyClassicProtection(protection, strictStatus, requiredChecks) {
  const summary = protection?.required_status_checks;
  const reviews = protection?.required_pull_request_reviews;
  const bypass = reviews?.bypass_pull_request_allowances;
  requireIt(strictStatus?.strict === true && (summary?.strict === undefined || summary.strict === true),
    'HOLD_MAIN_STRICT_CHECKS');
  requireIt(protection.enforce_admins?.enabled === true && protection.allow_force_pushes?.enabled === false &&
    protection.allow_deletions?.enabled === false, 'HOLD_MAIN_ADMIN_FORCE_DELETE_PROTECTION');
  requireIt(protection.required_linear_history?.enabled !== true && protection.lock_branch?.enabled !== true,
    'HOLD_MAIN_MERGE_COMMIT_PROTECTION');
  // An object with a zero approval count still requires a PR. A missing review object would
  // leave the PR requirement unverified. Independent evidence remains a separate gate.
  requireIt(isObject(reviews) && reviews.required_approving_review_count === 0 &&
    reviews.require_code_owner_reviews === false && reviews.require_last_push_approval === false,
  'HOLD_MAIN_CLASSIC_PULL_REQUEST_POLICY');
  requireIt(bypass === undefined || bypass === null || (isObject(bypass) &&
    Object.entries(bypass).every(([key, actors]) => ['users', 'teams', 'apps'].includes(key) &&
      Array.isArray(actors) && actors.length === 0)), 'HOLD_MAIN_CLASSIC_PULL_REQUEST_BYPASS');
  // The aggregate protection endpoint may omit strict and app IDs. The dedicated endpoint
  // supplies strict; require both sets of contexts to agree with the app-pinned branch snapshot.
  const contexts = requiredChecks.map(entry => entry.context);
  requireIt([summary, strictStatus].every(status => Array.isArray(status?.contexts) &&
    sameList([...status.contexts].sort(), contexts) && (status.checks === undefined ||
      sameList(checks(status.checks, 'app_id'), requiredChecks))), 'HOLD_MAIN_REQUIRED_CHECK_CONTEXTS');
}

function verifyRulesetIdentity(ruleset, expected) {
  requireIt(typeof expected.source === 'string' && expected.source.length > 0 &&
    ['Repository', 'Organization', 'Enterprise'].includes(expected.sourceType) &&
    ruleset?.id === expected.id && ruleset.source === expected.source &&
    ruleset.source_type === expected.sourceType && ruleset.enforcement === 'active' &&
    ruleset.target === 'branch', 'HOLD_GITHUB_RULESET_IDENTITY');
}

function verifyNamespace(ruleset, headRules, enrollment) {
  verifyRulesetIdentity(ruleset, { id: NAMESPACE_RULESET_ID, source: REPOSITORY, sourceType: 'Repository' });
  const condition = ruleset.conditions?.ref_name;
  const actors = ruleset.bypass_actors;
  const pin = enrollment?.updatedAt;
  if (Array.isArray(actors)) {
    requireIt(actors.length === 1 && actors[0]?.actor_type === 'Integration' &&
      actors[0].actor_id === PUBLISHER_APP_ID && actors[0].bypass_mode === 'always', 'HOLD_PUBLISHER_NAMESPACE_SCOPE');
  } else {
    // Only this head-only namespace has an enrolled sole actor. Recheck its public rule
    // revision on each use so an administrative edit also invalidates the read-only credential's proof.
    requireIt(actors === undefined && enrollment?.rulesetId === NAMESPACE_RULESET_ID &&
      enrollment.publisherAppId === PUBLISHER_APP_ID && typeof pin === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(pin) &&
      pin === ruleset.updated_at, 'HOLD_GITHUB_RULESET_IDENTITY');
  }
  requireIt(sameList(condition?.include, [`refs/heads/${NAMESPACE}*`]) && sameList(condition?.exclude, []),
    'HOLD_PUBLISHER_NAMESPACE_SCOPE');
  requireIt(Array.isArray(ruleset.rules) &&
    sameList(ruleset.rules.map(rule => rule?.type).sort(), NAMESPACE_RULES), 'HOLD_PUBLISHER_NAMESPACE_RULES');
  const applicable = headRules.filter(rule => rule.ruleset_id === NAMESPACE_RULESET_ID);
  requireIt(sameList(applicable.map(rule => rule.type).sort(), NAMESPACE_RULES) &&
    applicable.every(rule => rule.ruleset_source === REPOSITORY && rule.ruleset_source_type === 'Repository'),
  'HOLD_PUBLISHER_NAMESPACE_RULES_NOT_APPLIED');
}

// adminRead is supplied by the trusted service. It performs GET only and returns the parsed
// GitHub REST body. The App publisher's own credential remains separate. If GitHub redacts the
// head namespace actors, an enrollment from the owner service must match that rule's revision.
export async function verifyGitHubMainPolicy(target, { adminRead, namespaceEnrollment } = {}) {
  requireIt(target?.repo === REPOSITORY && target.repositoryId === REPOSITORY_ID &&
    typeof target.base === 'string' && SHA.test(target.base) && typeof target.head === 'string' &&
    SHA.test(target.head) && target.base !== target.head && typeof adminRead === 'function',
  'HOLD_GITHUB_MAIN_POLICY_TARGET');
  const repo = `/repos/${REPOSITORY}`;
  const mainPath = `${repo}/branches/main`;
  const read = async path => {
    try {
      return await adminRead(path);
    } catch {
      throw new Error('HOLD_GITHUB_MAIN_POLICY_READ');
    }
  };
  const forBranch = branch => `${repo}/rules/branches/${encodeURIComponent(branch)}?per_page=${PAGE_SIZE}`;
  const rulesetPath = id => `${repo}/rulesets/${id}?includes_parents=true`;
  const [metadata, branch, protection, strictStatus, mainRules, headRules, namespace] = await Promise.all([
    read(repo), read(mainPath), read(`${mainPath}/protection`),
    read(`${mainPath}/protection/required_status_checks`), read(forBranch('main')),
    read(forBranch(`${NAMESPACE}${target.head}`)), read(rulesetPath(NAMESPACE_RULESET_ID)),
  ]);
  requireIt(metadata?.id === REPOSITORY_ID && metadata.full_name === REPOSITORY &&
    metadata.default_branch === 'main' && metadata.allow_merge_commit === true,
  'HOLD_GITHUB_MAIN_REPOSITORY_POLICY');
  const requiredChecks = checks(branch?.protection?.required_status_checks?.checks, 'app_id');
  verifyClassicProtection(protection, strictStatus, requiredChecks);
  const assertMain = value => requireIt(value?.name === 'main' && value.protected === true &&
    value.commit?.sha === target.base &&
    sameList(checks(value.protection?.required_status_checks?.checks, 'app_id'), requiredChecks),
  'HOLD_GITHUB_MAIN_BASE_OR_CHECKS_CHANGED');
  assertMain(branch);
  requireIt([mainRules, headRules].every(rules => Array.isArray(rules) && rules.length < PAGE_SIZE &&
    rules.every(rule => positiveId(rule?.ruleset_id) && typeof rule.type === 'string')),
  'HOLD_GITHUB_EFFECTIVE_RULES_UNVERIFIED');
  verifyNamespace(namespace, headRules, namespaceEnrollment);
  requireIt(!mainRules.some(rule => rule.ruleset_id === NAMESPACE_RULESET_ID), 'HOLD_PUBLISHER_NAMESPACE_INCLUDES_MAIN');

  const uniqueMainRulesets = new Set(mainRules.map(rule => rule.ruleset_id));
  await Promise.all([...uniqueMainRulesets].map(async id => {
    const effective = mainRules.filter(rule => rule.ruleset_id === id);
    const ruleset = await read(rulesetPath(id));
    verifyRulesetIdentity(ruleset, { id, source: effective[0].ruleset_source, sourceType: effective[0].ruleset_source_type });
    requireIt(Array.isArray(ruleset.bypass_actors) && ruleset.bypass_actors.length === 0 && effective.every(rule =>
      rule.ruleset_source === ruleset.source && rule.ruleset_source_type === ruleset.source_type),
    'HOLD_GITHUB_MAIN_RULESET_BYPASS');
    for (const rule of effective) {
      const params = rule.parameters;
      if (rule.type === 'pull_request') {
        requireIt(params?.required_approving_review_count === 0 && params.require_code_owner_review === false &&
          params.require_last_push_approval === false, 'HOLD_MAIN_RULESET_PULL_REQUEST_POLICY');
      }
      if (rule.type === 'required_status_checks') {
        const rulesetChecks = checks(params?.required_status_checks, 'integration_id');
        requireIt(rulesetChecks.every(ruleCheck => requiredChecks.some(classicCheck =>
          classicCheck.context === ruleCheck.context && classicCheck.appId === ruleCheck.appId)),
        'HOLD_MAIN_RULESET_REQUIRED_CHECKS');
      }
    }
  }));
  assertMain(await read(mainPath));
  return {
    strictCurrentBase: true, mainBlocksForcePushes: true, mainBlocksDeletion: true, mainEnforcesAdmins: true,
    publisherCannotBypassMain: true, publisherOwnsHeadRef: true, githubRequiredReviewCount: 0, requiredChecks,
  };
}
