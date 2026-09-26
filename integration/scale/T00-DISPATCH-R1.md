# T00 Dispatch R1 — 2026-09-25

Authority: T00 integration coordinator for the BSKEL scale plan.

## Provisional baseline

- bskel: `5472a8b82655840d1d3ce76cb926987376e37ca6`
- becoder: `a575679b7d9e6df69c95c6c4f71cfdcf8e67c11e`
- beval: `f87d442949be1ac81d00d47ab49fc0beccfc0424`
- T00-01 PR: backend-skeleton #65, head `48efe1ca5f8a94a6fa71d85563ffc3762ff6410e`

This baseline is **SUBMITTED, not ACCEPTED** until exact-head CI and independent review complete. No downstream task may cite T00-01 as ACCEPTED yet.

## Global orders for every project chat / worker

1. Keep every scale PR **Draft**. Do not merge or mark ready without T00 integration approval.
2. Do not edit shared hot files owned by integration/release: existing CLI entrypoints, stable schemas, package manifests/lockfiles, existing gate/workflow files, or cross-tool identity serializers. Submit a change request instead.
3. Until T00-04 interface freeze, work only in track-owned paths on:
   - read-only audit / corpus / fixtures,
   - conservative shadow implementations,
   - negative tests,
   - result packets and change requests.
4. Existing ContractRef / ActionRef / FieldRef exact-byte identity remains authoritative. Do not replace it with a new semantic identity.
5. Do not reinterpret game/protocol items as HTTP operations.
6. Unknown/partial/unsupported are distinct. Do not turn missing evidence into false or safe.
7. Do not use queued CI as pass, old-head CI as latest-head evidence, or PR prose as execution evidence.
8. Do not weaken isolation, secret boundaries, or fail-closed behavior to make a test green.
9. If another open PR overlaps your implementation, stop the overlapping slice and produce a reconciliation note rather than duplicating it.
10. Every submission must include exact base/head SHA, changed-file hashes, exact test commands/exit codes, skipped/blocked reasons, remaining limitations, rollback, and dependency/change requests.

## Existing-work reconciliation orders

### Webgame legacy parallel work
- PR #63 Track A: **FREEZE implementation; RECONCILE.** No new code. Produce a mapping of its project/source-role/JS-TS/game facts to T02/T04/T17/T18 and identify unique pieces vs duplicates.
- PR #62 Track C: **FREEZE implementation; RECONCILE.** No shared CLI/gate wiring. Map evidence/freshness/release-policy pieces to T19/T20/T23 and identify unique pieces vs duplicates.
- historical Track B `feature/webgame-b-runtime`: preserve existing runtime evidence; do not create a competing runtime path. Reconcile with beval #39 and T16.

### becoder / beval webgame chain
- becoder PR #6 is already merged into main `a575679...`; all T15/game consumer work starts from this state.
- becoder PR #7: verification-only. **Do not merge.** Treat only as evidence for beval #39/#40.
- beval #39 Browser Oracle: **VERIFY/DEFER.** No merge until exact latest-head unit + real Docker/Chromium integration are green. Do not weaken internal-network/CDP isolation.
- beval #40 Repair Loop: **HOLD stacked on #39.** Static validation may continue; do not merge/rebase to main before #39 is accepted.
- beval #41 T16 runtime binding: continue only in T16-owned paths. Next security priority is environment/credential isolation; preserve existing RunBinding/profile/evidence semantics.

## Scale-track orders

- T01 / PR #82: continue audit + backward-compatible identity lane. Preserve exact-byte ContractRef/ActionRef/FieldRef; no stable writer/schema cutover before T00-04.
- T02 / PR #72: continue project graph in shadow mode. Reconcile nested-project/read-set overlap with PR #63; no legacy `runScan()` replacement yet.
- T03 / PR #81: continue conditional capability policy in isolated path. Do not mutate current four-name stable capability schema before freeze.
- T04 / PR #73: continue conservative JS/TS source facts and parser comparison. Reconcile parser/provenance overlap with #63; no package dependency/lockfile changes.
- T05: begin only T05-01/02 audit + fixtures/RFC. No JVM common-interface implementation until T00-04.
- T06 / PR #75: continue static Python facts; no target import/execution, no FastAPI stable wiring before freeze.
- T07 / PR #69: continue conservative Ruby/PHP DSL facts; dynamic DSL stays unknown; no stable operation semantics.
- T08 / PR #76: continue language backend ADR/transport and isolated slices; installed runtime absence is not support.
- T09 / PR #83: continue shadow reconciliation only; stable OpenAPI writer remains authoritative; preserve none/unknown/security inheritance distinctions.
- T10 / PR #84: continue persistence normalization read-only; no name-similarity auto-binding, no DDL/write enablement.
- T11 / PR #77: continue legacy baseline/bridge only; T11 normalized projection waits for T00-04.
- T12 / PR #66: continue Wave A as leaf-only experimental adapter. No registry/stable capability/codegen advertisement before interface/QA/security gates.
- T13 / PR #67: same rule for Wave B/C. Hono remains synthetic/experimental until independent corpus certification.
- T14 / PR #71: continue provider composition preview only; no global handles/capability mutation before freeze.
- T15: audit current becoder main `a575679...` first. Preserve deterministic projection boundary; no backend business-code generator expansion. T15-01/02 only until freeze.
- T16 / PR #41: continue immutable runtime binding and isolation; coordinate with #39/#40, do not duplicate Browser Oracle/repair code.
- T17 / PR #68: continue game bridge only. Reconcile with #63 and current webgame/1. Native Unreal/Unity/Godot exporters wait until T00-04/T20 permission boundary; no causal inference.
- T18 / PR #70: continue static/spec-first protocol plane. No runtime certification or cross-family identity repair.
- T19 / PR #74: continue independent corpus/negative vectors. No candidate-generated expected outputs; no certification until reviewer evidence exists.
- T20 / PR #79: continue deny-by-default permission model. Do not create user-controlled dynamic-import adapter execution.
- T21 / PR #80: continue measurement/cache/DAG primitives in isolation. No cache correctness claim without source/resolver/config/parser/adapter/schema/policy fingerprints.
- T22 / PR #85: continue data-only SDK/diagnostics/test kit. No auto-install or execution; package shipping waits T20/T23 approval.
- T23 / PR #78: continue inventory/runbook only. Do not change package allowlists, workflows, release/defaults, or DB migrations until T00 approves the integration request.

## Required response from each worker

Post one concise status packet to its PR/branch:
- current task IDs actually covered,
- exact head SHA,
- current exact-head CI state,
- overlap with other PRs,
- files/schemas/CLI/package changes it needs from another owner,
- next safe task that stays within current dependency state.

If a task depends on T00-01 ACCEPTED or T00-04, mark it BLOCKED and stop at the dependency boundary.
