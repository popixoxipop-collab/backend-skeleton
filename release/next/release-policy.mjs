#!/usr/bin/env node
import fs from 'node:fs';

const SHA40 = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ROLES = ['bskel', 'becoder', 'beval'];
const REQUIRED_PACKAGE_PATHS = {
  bskel: ['bin/', 'contracts/', 'scanners/', 'handles/', 'schemas/'],
  becoder: ['bin/', 'docs/', 'renderers/', 'schemas/'],
  beval: ['bin/', 'migrations/', 'schemas/', 'profiles/', 'docs/contract-binding/', 'docs/release/'],
};

function push(errors, code, detail = {}) { errors.push({ code, ...detail }); }
function mapRepos(inventory) { return new Map((inventory.repositories ?? []).map((r) => [r.role, r])); }

export function observedBlockers(inventory) {
  const blockers = new Set();
  const baseline = inventory?.coordination_baseline;
  if (baseline?.accepted !== true || baseline?.state !== 'ACCEPTED') blockers.add('BASELINE_NOT_ACCEPTED');
  const expected = baseline?.repositories ?? {};
  for (const repo of inventory?.repositories ?? []) {
    if (expected[repo.role] !== repo.head_sha) blockers.add('COORDINATION_BASELINE_DRIFT');
    const ci = repo.exact_head_ci ?? {};
    if (ci.head_sha !== repo.head_sha || ci.status !== 'completed' || ci.conclusion !== 'success') blockers.add('CURRENT_MAIN_CI_NOT_GREEN');
  }
  return [...blockers].sort();
}

export function verifyCompatibilityInventory(inventory) {
  const errors = [];
  if (inventory?.schema !== 'bskel.scale-release-compatibility/1') push(errors, 'INVENTORY_SCHEMA');
  if (inventory?.task_id !== 'T23-01') push(errors, 'TASK_ID');
  const baseline = inventory?.coordination_baseline ?? {};
  if (baseline.task_id !== 'T00-01') push(errors, 'BASELINE_TASK');
  if (!['SUBMITTED', 'ACCEPTED'].includes(baseline.state)) push(errors, 'BASELINE_STATE');
  if (typeof baseline.accepted !== 'boolean') push(errors, 'BASELINE_ACCEPTED_FLAG');
  if ((baseline.state === 'ACCEPTED') !== (baseline.accepted === true)) push(errors, 'BASELINE_STATE_FLAG_MISMATCH');
  for (const role of ROLES) if (!SHA40.test(baseline?.repositories?.[role] ?? '')) push(errors, 'UNPINNED_COORDINATION_BASELINE', { role });

  if (!Array.isArray(inventory?.repositories)) push(errors, 'REPOSITORIES_REQUIRED');
  const repos = Array.isArray(inventory?.repositories) ? inventory.repositories : [];
  const roles = new Set();
  for (const repo of repos) {
    if (!ROLES.includes(repo?.role)) push(errors, 'UNKNOWN_ROLE', { role: repo?.role ?? null });
    if (roles.has(repo?.role)) push(errors, 'DUPLICATE_ROLE', { role: repo?.role });
    roles.add(repo?.role);
    if (!SHA40.test(repo?.head_sha ?? '')) push(errors, 'UNPINNED_HEAD', { role: repo?.role });
    if (!SHA40.test(repo?.coordination_sha ?? '')) push(errors, 'UNPINNED_COORDINATION_SHA', { role: repo?.role });
    if (repo?.coordination_sha !== baseline?.repositories?.[repo?.role]) push(errors, 'COORDINATION_SHA_MISMATCH', { role: repo?.role });
    if (repo?.default_branch !== 'main') push(errors, 'DEFAULT_BRANCH_DRIFT', { role: repo?.role, actual: repo?.default_branch ?? null });
    const pkg = repo?.package ?? {};
    if (!SEMVER.test(pkg.version ?? '')) push(errors, 'PACKAGE_VERSION', { role: repo?.role });
    if (!/^>=\d+/.test(pkg.node_engine ?? '')) push(errors, 'NODE_ENGINE', { role: repo?.role });
    if (!Array.isArray(pkg.bins) || pkg.bins.length === 0) push(errors, 'BIN_SURFACE_MISSING', { role: repo?.role });
    if (pkg.pack_test !== 'npm run test:pack') push(errors, 'PACK_TEST_REQUIRED', { role: repo?.role, actual: pkg.pack_test ?? null });
    if (!SHA40.test(pkg.package_json_blob ?? '')) push(errors, 'PACKAGE_JSON_BLOB', { role: repo?.role });
    if (!SHA40.test(pkg.workflow_blob ?? '')) push(errors, 'WORKFLOW_BLOB', { role: repo?.role });
    const files = new Set(pkg.files ?? []);
    for (const required of REQUIRED_PACKAGE_PATHS[repo?.role] ?? []) {
      if (!files.has(required)) push(errors, 'PACKAGE_RUNTIME_ASSET_MISSING', { role: repo?.role, path: required });
    }
    const ci = repo?.exact_head_ci ?? {};
    if (!Number.isInteger(ci.run_id)) push(errors, 'CI_RUN_ID', { role: repo?.role });
    if (ci.head_sha !== repo?.head_sha) push(errors, 'CI_HEAD_MISMATCH', { role: repo?.role, expected: repo?.head_sha ?? null, actual: ci.head_sha ?? null });
    if (!['queued', 'in_progress', 'completed'].includes(ci.status)) push(errors, 'CI_STATUS', { role: repo?.role });
    if (ci.status === 'completed' && typeof ci.conclusion !== 'string') push(errors, 'CI_CONCLUSION', { role: repo?.role });
    if (ci.status !== 'completed' && ci.conclusion !== null) push(errors, 'CI_NONTERMINAL_CONCLUSION', { role: repo?.role });
  }
  for (const role of ROLES) if (!roles.has(role)) push(errors, 'ROLE_MISSING', { role });
  return { ok: errors.length === 0, errors, observed_blockers: observedBlockers(inventory) };
}

export function verifyReleasePlan(plan, inventory = null) {
  const errors = [];
  if (plan?.schema !== 'bskel.scale-release-plan/1') push(errors, 'RELEASE_PLAN_SCHEMA');
  if (plan?.owner_track !== 'T23') push(errors, 'OWNER_TRACK');
  for (const group of ['coordination_baseline', 'observed_current_main']) {
    for (const role of ROLES) if (!SHA40.test(plan?.[group]?.[role] ?? '')) push(errors, 'UNPINNED_BASELINE', { group, role });
  }
  if (inventory) {
    const repos = mapRepos(inventory);
    for (const role of ROLES) {
      if (plan?.coordination_baseline?.[role] !== inventory?.coordination_baseline?.repositories?.[role]) push(errors, 'PLAN_COORDINATION_BASELINE_STALE', { role });
      if (plan?.observed_current_main?.[role] !== repos.get(role)?.head_sha) push(errors, 'PLAN_OBSERVED_MAIN_STALE', { role });
    }
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
  const allAccepted = prereq.length > 0 && prereq.every((x) => x.required_state === x.observed_state);
  const declared = new Set(Array.isArray(plan?.blockers) ? plan.blockers : []);
  const dynamic = inventory ? observedBlockers(inventory) : [];
  for (const code of dynamic) if (!declared.has(code)) push(errors, 'OBSERVED_BLOCKER_NOT_DECLARED', { blocker: code });
  if (plan?.release_allowed === true && (!allAccepted || declared.size > 0 || dynamic.length > 0)) push(errors, 'PREMATURE_RELEASE');
  if (plan?.release_allowed === false && allAccepted && declared.size === 0 && dynamic.length === 0) push(errors, 'STALE_RELEASE_BLOCK');
  if (plan?.ci_lane_plan?.workflows_modified_by_T23_01_or_T23_02 !== false) push(errors, 'PREMATURE_WORKFLOW_MUTATION');
  if (plan?.ci_lane_plan?.privileged_pull_request_target_for_untrusted_code !== false) push(errors, 'UNTRUSTED_PRIVILEGED_PR');
  const checks = new Set(plan?.required_release_checks ?? []);
  for (const required of ['bskel npm run test:pack','becoder npm run test:pack','beval npm run test:pack','exact-head CI for the final integration SHAs','rollback rehearsal without destructive database downgrade']) {
    if (!checks.has(required)) push(errors, 'REQUIRED_RELEASE_CHECK_MISSING', { check: required });
  }
  return { ok: errors.length === 0, errors };
}

export function verifyAll(inventory, plan) {
  const inventoryResult = verifyCompatibilityInventory(inventory);
  const planResult = verifyReleasePlan(plan, inventory);
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
