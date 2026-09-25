#!/usr/bin/env node
import fs from 'node:fs';

const SHA40 = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const REQUIRED_PACKAGE_PATHS = {
  bskel: ['bin/', 'contracts/', 'scanners/', 'handles/', 'schemas/'],
  becoder: ['bin/', 'docs/', 'renderers/', 'schemas/'],
  beval: ['bin/', 'migrations/', 'schemas/', 'profiles/', 'docs/contract-binding/', 'docs/release/'],
};

function push(errors, code, detail = {}) {
  errors.push({ code, ...detail });
}

export function verifyCompatibilityInventory(inventory) {
  const errors = [];
  if (inventory?.schema !== 'bskel.scale-release-compatibility/1') push(errors, 'INVENTORY_SCHEMA');
  if (inventory?.task_id !== 'T23-01') push(errors, 'TASK_ID');
  if (!Array.isArray(inventory?.repositories)) push(errors, 'REPOSITORIES_REQUIRED');
  const repos = Array.isArray(inventory?.repositories) ? inventory.repositories : [];
  const roles = new Set();
  for (const repo of repos) {
    if (!['bskel', 'becoder', 'beval'].includes(repo?.role)) push(errors, 'UNKNOWN_ROLE', { role: repo?.role ?? null });
    if (roles.has(repo?.role)) push(errors, 'DUPLICATE_ROLE', { role: repo?.role });
    roles.add(repo?.role);
    if (!SHA40.test(repo?.head_sha ?? '')) push(errors, 'UNPINNED_HEAD', { role: repo?.role });
    if (repo?.default_branch !== 'main') push(errors, 'DEFAULT_BRANCH_DRIFT', { role: repo?.role, actual: repo?.default_branch ?? null });
    const pkg = repo?.package ?? {};
    if (!SEMVER.test(pkg.version ?? '')) push(errors, 'PACKAGE_VERSION', { role: repo?.role });
    if (!/^>=\d+/.test(pkg.node_engine ?? '')) push(errors, 'NODE_ENGINE', { role: repo?.role });
    if (!Array.isArray(pkg.bins) || pkg.bins.length === 0) push(errors, 'BIN_SURFACE_MISSING', { role: repo?.role });
    if (pkg.pack_test !== 'npm run test:pack') push(errors, 'PACK_TEST_REQUIRED', { role: repo?.role, actual: pkg.pack_test ?? null });
    const files = new Set(pkg.files ?? []);
    for (const required of REQUIRED_PACKAGE_PATHS[repo?.role] ?? []) {
      if (!files.has(required)) push(errors, 'PACKAGE_RUNTIME_ASSET_MISSING', { role: repo?.role, path: required });
    }
    if (repo?.historical_exact_head_ci?.conclusion !== 'success') push(errors, 'HISTORICAL_CI_NOT_GREEN', { role: repo?.role });
  }
  for (const role of ['bskel', 'becoder', 'beval']) if (!roles.has(role)) push(errors, 'ROLE_MISSING', { role });
  if (inventory?.baseline_dependency?.accepted !== false || inventory?.baseline_dependency?.state !== 'SUBMITTED') {
    push(errors, 'BASELINE_DEPENDENCY_MUST_STAY_PENDING_IN_THIS_SNAPSHOT');
  }
  return { ok: errors.length === 0, errors };
}

export function verifyReleasePlan(plan) {
  const errors = [];
  if (plan?.schema !== 'bskel.scale-release-plan/1') push(errors, 'RELEASE_PLAN_SCHEMA');
  if (plan?.owner_track !== 'T23') push(errors, 'OWNER_TRACK');
  for (const [role, sha] of Object.entries(plan?.baseline ?? {})) {
    if (!['bskel', 'becoder', 'beval'].includes(role) || !SHA40.test(sha ?? '')) push(errors, 'UNPINNED_BASELINE', { role });
  }
  const stages = (plan?.migration_stages ?? []).map((x) => x.id);
  const expected = ['M1-consumer-first', 'M2-shadow', 'M3-opt-in-writer', 'M4-per-profile-default'];
  if (JSON.stringify(stages) !== JSON.stringify(expected)) push(errors, 'MIGRATION_ORDER', { expected, actual: stages });
  const rollback = plan?.rollback_policy ?? {};
  if (rollback.destructive_down_migration_allowed !== false) push(errors, 'DESTRUCTIVE_DOWN_MIGRATION');
  if (rollback.delete_historical_evidence_allowed !== false) push(errors, 'HISTORICAL_EVIDENCE_DELETE');
  if (rollback.old_binary_and_old_artifacts_must_remain_readable !== true) push(errors, 'OLD_READABILITY_REQUIRED');
  if (rollback.old_writer_may_overwrite_next_artifacts !== false) push(errors, 'OLD_WRITER_OVERWRITE');
  if (rollback.new_data_namespace_must_be_isolated_until_default_cutover !== true) push(errors, 'NEW_DATA_ISOLATION');
  const prereq = plan?.prerequisites ?? [];
  const allAccepted = prereq.length > 0 && prereq.every((x) => x.required_state === 'ACCEPTED' && x.observed_state === 'ACCEPTED');
  const blockers = Array.isArray(plan?.blockers) ? plan.blockers : [];
  if (plan?.release_allowed === true && (!allAccepted || blockers.length > 0)) push(errors, 'PREMATURE_RELEASE');
  if (plan?.release_allowed === false && allAccepted && blockers.length === 0) push(errors, 'STALE_RELEASE_BLOCK');
  if (plan?.ci_lane_plan?.workflows_modified_by_T23_01_or_T23_02 !== false) push(errors, 'PREMATURE_WORKFLOW_MUTATION');
  if (plan?.ci_lane_plan?.privileged_pull_request_target_for_untrusted_code !== false) push(errors, 'UNTRUSTED_PRIVILEGED_PR');
  const checks = new Set(plan?.required_release_checks ?? []);
  for (const required of [
    'bskel npm run test:pack',
    'becoder npm run test:pack',
    'beval npm run test:pack',
    'exact-head CI for the final integration SHAs',
    'rollback rehearsal without destructive database downgrade',
  ]) {
    if (!checks.has(required)) push(errors, 'REQUIRED_RELEASE_CHECK_MISSING', { check: required });
  }
  return { ok: errors.length === 0, errors };
}

export function verifyAll(inventory, plan) {
  const inventoryResult = verifyCompatibilityInventory(inventory);
  const planResult = verifyReleasePlan(plan);
  return { ok: inventoryResult.ok && planResult.ok, inventory: inventoryResult, release_plan: planResult };
}

function main() {
  const [command, inventoryPath, planPath] = process.argv.slice(2);
  if (command !== 'verify' || !inventoryPath || !planPath) {
    console.error('usage: node release-policy.mjs verify <compatibility-inventory.json> <release-plan.json>');
    process.exit(1);
  }
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const result = verifyAll(inventory, plan);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 2);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
