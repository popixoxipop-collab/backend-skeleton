#!/usr/bin/env node
import fs from 'node:fs';

const SHA40 = /^[0-9a-f]{40}$/;
const ROLES = ['bskel', 'becoder', 'beval'];
const EXPECTED_STAGES = ['M1-consumer-first', 'M2-shadow', 'M3-opt-in-writer', 'M4-per-profile-default'];
const REQUIRED_PREREQUISITES = new Map([
  ['T00-01', 'ACCEPTED'],
  ['T00-04A', 'ACTIVE_CORE_FREEZE'],
  ['T00-05', 'ACCEPTED'],
  ['T01-06', 'ACCEPTED'],
  ['T19-03', 'ACCEPTED'],
  ['T20-03', 'ACCEPTED'],
]);

function push(errors, code, detail = {}) { errors.push({ code, ...detail }); }
function repoMap(inventory) { return new Map((inventory.repositories ?? []).map((x) => [x.role, x])); }

export function observedBlockers(inventory) {
  const blockers = new Set();
  const baseline = inventory?.coordination_baseline ?? {};
  if (baseline.accepted !== true || baseline.state !== 'ACCEPTED') blockers.add('BASELINE_NOT_ACCEPTED');

  for (const repo of inventory?.repositories ?? []) {
    if (baseline?.repositories?.[repo.role] !== repo.head_sha) blockers.add('COORDINATION_BASELINE_DRIFT');
    const v = repo.verification ?? {};
    if (v.status !== 'completed' || v.conclusion !== 'success' || !SHA40.test(v.reviewed_head_sha ?? '') || !SHA40.test(v.ci_head_sha ?? '')) {
      blockers.add('CURRENT_MAIN_CI_NOT_GREEN');
      continue;
    }
    if (v.mode === 'zero-delta-merge-tree-equivalence') {
      if (v.ahead_by !== 1 || v.behind_by !== 0 || v.file_delta_count !== 0 || v.ci_head_sha !== v.reviewed_head_sha) {
        blockers.add('MAIN_TREE_NOT_EQUIVALENT');
      }
    }
    if (v.direct_main_ci !== true || v.ci_head_sha !== repo.head_sha) blockers.add('FINAL_MAIN_PUSH_CI_NOT_DIRECT');
  }

  const evidence = inventory?.promotion_evidence ?? {};
  if (evidence.t01_06?.observed_state !== evidence.t01_06?.required_state) blockers.add('T01_06_NOT_ACCEPTED');
  if (evidence.t19_03?.observed_state !== evidence.t19_03?.required_state) blockers.add('INDEPENDENT_QA_NOT_READY');
  if (evidence.t20_03?.observed_state !== evidence.t20_03?.required_state) blockers.add('TRUST_POLICY_NOT_READY');
  return [...blockers].sort();
}

export function releasePlanBlockers(plan) {
  const blockers = new Set();
  const rehearsal = plan?.release_rehearsal ?? {};
  if (rehearsal.observed_state !== rehearsal.required_state || rehearsal.required_state !== 'PASS') {
    blockers.add('FINAL_RELEASE_REHEARSAL_NOT_RUN');
  }
  return [...blockers].sort();
}

export function verifyCompatibilityInventory(inventory) {
  const errors = [];
  if (inventory?.schema !== 'bskel.scale-release-compatibility/2') push(errors, 'INVENTORY_SCHEMA');
  if (inventory?.coordination_baseline?.state !== 'ACCEPTED' || inventory?.coordination_baseline?.accepted !== true) push(errors, 'BASELINE_ACCEPTANCE');
  for (const role of ROLES) if (!SHA40.test(inventory?.coordination_baseline?.repositories?.[role] ?? '')) push(errors, 'BASELINE_SHA', { role });

  const seen = new Set();
  for (const repo of inventory?.repositories ?? []) {
    if (!ROLES.includes(repo.role)) push(errors, 'UNKNOWN_ROLE', { role: repo.role });
    if (seen.has(repo.role)) push(errors, 'DUPLICATE_ROLE', { role: repo.role });
    seen.add(repo.role);
    if (repo.default_branch !== 'main') push(errors, 'DEFAULT_BRANCH_DRIFT', { role: repo.role });
    if (!SHA40.test(repo.head_sha ?? '')) push(errors, 'HEAD_SHA', { role: repo.role });
    if (repo.coordination_sha !== inventory?.coordination_baseline?.repositories?.[repo.role]) push(errors, 'COORDINATION_SHA_MISMATCH', { role: repo.role });
    if (repo.package?.pack_test !== 'npm run test:pack') push(errors, 'PACK_TEST_REQUIRED', { role: repo.role });
    if (!SHA40.test(repo.package?.package_json_blob ?? '')) push(errors, 'PACKAGE_JSON_BLOB', { role: repo.role });
    if (!SHA40.test(repo.package?.workflow_blob ?? '')) push(errors, 'WORKFLOW_BLOB', { role: repo.role });
    const v=repo.verification ?? {};
    if (!Number.isInteger(v.ci_run)) push(errors, 'CI_RUN_ID', { role: repo.role });
    if (v.status !== 'completed') push(errors, 'CI_STATUS', { role: repo.role });
    if (v.conclusion !== 'success') push(errors, 'CI_CONCLUSION', { role: repo.role });
    if (!SHA40.test(v.reviewed_head_sha ?? '')) push(errors, 'REVIEWED_HEAD_SHA', { role: repo.role });
    if (!SHA40.test(v.ci_head_sha ?? '')) push(errors, 'CI_HEAD_SHA', { role: repo.role });
    if (v.direct_main_ci === true && v.ci_head_sha !== repo.head_sha) push(errors, 'DIRECT_CI_HEAD_MISMATCH', { role: repo.role });
    if (v.mode === 'zero-delta-merge-tree-equivalence') {
      if (v.ahead_by !== 1 || v.behind_by !== 0 || v.file_delta_count !== 0 || v.ci_head_sha !== v.reviewed_head_sha) {
        push(errors, 'TREE_EQUIVALENCE', { role: repo.role });
      }
    }
  }
  for (const role of ROLES) if (!seen.has(role)) push(errors, 'ROLE_MISSING', { role });

  const inv = inventory?.invariants ?? {};
  if (inv.legacy_http_identity_authoritative !== true) push(errors, 'LEGACY_IDENTITY_AUTHORITY');
  if (inv.next_identity_additive !== true) push(errors, 'NEXT_IDENTITY_NOT_ADDITIVE');
  if (inv.default_writer_changed !== false) push(errors, 'PREMATURE_DEFAULT_WRITER');
  if (inv.production_registry_changed !== false) push(errors, 'PREMATURE_REGISTRY_CHANGE');
  if (inv.release_performed !== false) push(errors, 'PREMATURE_RELEASE_OBSERVATION');

  return { ok: errors.length === 0, errors, observed_blockers: observedBlockers(inventory) };
}

function verifyPrerequisites(plan, errors) {
  const items = plan?.prerequisites;
  if (!Array.isArray(items)) {
    push(errors, 'PREREQUISITES_REQUIRED');
    return false;
  }
  const seen = new Set();
  let allAccepted = true;
  for (const item of items) {
    if (!REQUIRED_PREREQUISITES.has(item?.id)) {
      push(errors, 'UNEXPECTED_PREREQUISITE', { id: item?.id ?? null });
      allAccepted = false;
      continue;
    }
    if (seen.has(item.id)) {
      push(errors, 'DUPLICATE_PREREQUISITE', { id: item.id });
      allAccepted = false;
      continue;
    }
    seen.add(item.id);
    const requiredState = REQUIRED_PREREQUISITES.get(item.id);
    if (item.required_state !== requiredState) {
      push(errors, 'PREREQUISITE_REQUIRED_STATE', { id: item.id, expected: requiredState, actual: item.required_state ?? null });
      allAccepted = false;
    }
    if (item.observed_state !== requiredState) allAccepted = false;
  }
  for (const [id, requiredState] of REQUIRED_PREREQUISITES) {
    if (!seen.has(id)) {
      push(errors, 'PREREQUISITE_MISSING', { id, required_state: requiredState });
      allAccepted = false;
    }
  }
  return allAccepted;
}

export function verifyReleasePlan(plan, inventory) {
  const errors = [];
  if (plan?.schema !== 'bskel.scale-release-plan/2') push(errors, 'RELEASE_PLAN_SCHEMA');
  if (plan?.owner_track !== 'T23') push(errors, 'OWNER_TRACK');
  const repos=repoMap(inventory);
  for (const role of ROLES) {
    if (plan?.coordination_baseline?.[role] !== inventory?.coordination_baseline?.repositories?.[role]) push(errors, 'PLAN_BASELINE_STALE', { role });
    if (plan?.observed_current_main?.[role] !== repos.get(role)?.head_sha) push(errors, 'PLAN_MAIN_STALE', { role });
  }
  const stages=(plan?.migration_stages ?? []).map((x)=>x.id);
  if (JSON.stringify(stages)!==JSON.stringify(EXPECTED_STAGES)) push(errors, 'MIGRATION_ORDER');

  const rollback=plan?.rollback_policy ?? {};
  if (rollback.destructive_down_migration_allowed !== false) push(errors, 'DESTRUCTIVE_DOWN_MIGRATION');
  if (rollback.delete_historical_evidence_allowed !== false) push(errors, 'HISTORICAL_EVIDENCE_DELETE');
  if (rollback.old_binary_and_old_artifacts_must_remain_readable !== true) push(errors, 'OLD_READABILITY_REQUIRED');
  if (rollback.old_writer_may_overwrite_next_artifacts !== false) push(errors, 'OLD_WRITER_OVERWRITE');
  if (rollback.new_data_namespace_must_be_isolated_until_default_cutover !== true) push(errors, 'NEW_DATA_ISOLATION');

  const allAccepted=verifyPrerequisites(plan, errors);
  const dynamic=[...observedBlockers(inventory), ...releasePlanBlockers(plan)];
  const declared=new Set(plan?.blockers ?? []);
  for (const code of dynamic) if (!declared.has(code)) push(errors, 'OBSERVED_BLOCKER_NOT_DECLARED', { blocker: code });

  if (plan.release_allowed === true && (!allAccepted || declared.size>0 || dynamic.length>0)) push(errors, 'PREMATURE_RELEASE');
  if (plan.default_activation_allowed === true && plan.release_allowed !== true) push(errors, 'PREMATURE_DEFAULT_ACTIVATION');

  const checks=new Set(plan?.required_release_checks ?? []);
  for (const required of [
    'bskel npm run test:pack','becoder npm run test:pack','beval npm run test:pack',
    'T01-06 accepted consumer-set evidence','direct exact-head CI for final main release SHAs',
    'rollback rehearsal without destructive database downgrade',
    'T19-03 independent QA acceptance','T20-03 externally observed enforcement acceptance'
  ]) if (!checks.has(required)) push(errors, 'REQUIRED_RELEASE_CHECK_MISSING', { check: required });

  const rehearsal=plan?.release_rehearsal ?? {};
  if (rehearsal.required_state !== 'PASS') push(errors, 'REHEARSAL_REQUIRED_STATE');
  if (!Array.isArray(rehearsal.evidence_refs)) push(errors, 'REHEARSAL_EVIDENCE_REFS');
  if (rehearsal.observed_state === 'PASS' && rehearsal.evidence_refs.length === 0) push(errors, 'REHEARSAL_PASS_WITHOUT_EVIDENCE');

  return { ok: errors.length===0, errors };
}

export function verifyAll(inventory, plan) {
  const inventoryResult=verifyCompatibilityInventory(inventory);
  const planResult=verifyReleasePlan(plan, inventory);
  return { ok: inventoryResult.ok && planResult.ok, inventory: inventoryResult, release_plan: planResult };
}

function main() {
  const [command, inventoryPath, planPath]=process.argv.slice(2);
  if (command !== 'verify' || !inventoryPath || !planPath) {
    console.error('usage: node release-policy.mjs verify <compatibility-inventory.json> <release-plan.json>');
    process.exit(1);
  }
  const inventory=JSON.parse(fs.readFileSync(inventoryPath,'utf8'));
  const plan=JSON.parse(fs.readFileSync(planPath,'utf8'));
  const result=verifyAll(inventory,plan);
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  process.exit(result.ok ? 0 : 2);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
