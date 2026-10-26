# T00 MET Conveyor v1 — immutable audit + original dependency DAG

## Purpose
This is a **read-only completion-candidate queue**, not a new auditor, truth source or release authority. It takes the original plan backlog and the independently maintained 291-row T00 adjudication audit. It can plan **what work to do next**; it cannot change a task from PARTIAL/NOT_MET to MET or merge/publish/activate anything.

The true sources for the 2026-10-23 dry run are:
- Plan bundle `BSKEL_SCALE_IMPLEMENTATION_PLAN_2026-09-30_RECOVERED_2.tar.xz`, SHA-256 `def2bc3c2545bb66e66465ea3153fe53b93ea97795eb340a729009c5e7a97bec`. Its `planning/backlog.json` SHA-256 is `ab6a67a5704b674aad6bf04abbdb0761889de9ab49c12cf675aceffaefecb0f3`.
- Official audit `T00_TASK_AUDIT_2026-10-22_POST_PR309_R206.json`, SHA-256 `0217a0120b2d380e25dbe6cb09f801578394bf25c46cbb999154f1963d7aeb10`. Official verdict **92 MET / 140 PARTIAL / 59 NOT_MET**, total 291.
- The backlog contains **744 directly declared depends_on edges**; the earlier planning summary cited 1,009 overall predecessor relationships, which is a **different measure**. Do not claim the 744 direct edges are 1,009 or silently replace the source graph. If a future plan snapshot differs, pin its exact SHA and independently review the graph.

## Actual entrypoint (no API key, network or GitHub write access)

```bash
python3 next/t00/met_conveyor.py \
  --plan /absolute/path/bskel-scale-plan/planning/backlog.json \
  --plan-sha256 ab6a67a5704b674aad6bf04abbdb0761889de9ab49c12cf675aceffaefecb0f3 \
  --audit /absolute/path/T00_TASK_AUDIT_2026-10-22_POST_PR309_R206.json \
  --audit-sha256 0217a0120b2d380e25dbe6cb09f801578394bf25c46cbb999154f1963d7aeb10 \
  --out-dir /absolute/new/nonexistent/directory
```

The directory must not exist. The module rejects wrong SHA-256 pins, count inconsistencies, unknown/duplicate task IDs, missing/duplicate or cyclic edges, mismatched track/kind identity, malformed focus selection and output reuse. It only writes new triage documents to a separate directory. No official audit file, task state or production resource is written.

Output:
- `triage.json`: pinned authority, reconciled counts, DAG dependency-ready and blocked counts, core/target stages, explainable unblocked queue, fanout bottlenecks, five full target-family work packets with the **verbatim audit gap**, formal acceptance and mandatory tests.
- `brief.md`: human-readable version, including dependency blockers.
- `receipt.json`: SHA-256 of the machine triage and input pins, **official_MET delta=0**, not an adjudication.

## Stages, evidence and workflow

1. **Snapshot & validate** original backlog and official 291-row audit; fail closed on any mismatch.
2. **Plan & prioritize** only source-grounded direct dependencies. The score and text-regex gap tags are explicitly **heuristics**, not verified code facts. Dependency-clear merely means all *declared* predecessors are MET in that audit; it does not mean the task itself is done or its dependencies are exhaustive.
3. **Choose five work packets** across Spring, FastAPI, Prisma, WebSocket and Three.js. Each is shown at stages 01→02→03, including exact unmet plan dependencies. Finish a concrete thin, correctly scoped deliverable and negative test rather than spreading effort across 49 incomplete target certs.
4. **Fast checks** after small developer edits: narrowly targeted unit/mutation/fixture checks, no signer or production admission claim. `node --test test/t00-met-conveyor.test.mjs` is the portable policy check. The separate lightweight CI job is advisory only.
5. **Full acceptance** before a scoped MET request: actual packed product + applicable real runtime, exact HEAD CI all required checks, version pin and negative fixture with exit code/log hash, verified review/ownership, source-bound signed independent evidence, postmerge replay. Tests do not waive protection or runtime gaps.
6. **Independent adjudication**: an authorized T00 auditor reopens only a candidate task, checks *every* mandatory plan acceptance clause, produces an immutable evidence receipt and uses the official CAS audit process. **This program does not perform that act**, even if source tests or CI pass.
7. **Publish changes** only if permitted by T23 release gate and real protected-main rule; signed CI evidence with `release_ready=false` is not production authorization.

## Known blockers in the 2026-10-22 audit

Core phase 05 has 3/24 MET; phase 06 has 2/24 MET. Across 49 expansion target families, stage 01 has 24 MET, **stage 02 has zero MET and stage 03 has zero MET**. The five selected work packets are **not** certified products. 13 open tasks have no unmet *direct* plan dependencies, while 186 are dependency-blocked. The 13 figure is a planning queue, **not 13 automatic MET credits**.

T00-05/T20-05/T23-05 release-wide gates do not become MET because BEVAL PR #91 CI passes in a private development branch. BEVAL main-protection Issue #95, database-ordering Issue #93 and secure runner reboot Issue #97 are separately tracked. The original code-owner and external signer requirements remain binding.

## Verification & ownership

Changes to this tool affect *planning advice* only, not stable `bskel` CLI, registry, scanner, packaging or T23 promotion logic. The old full CI suite is unchanged. Test fixtures explicitly include duplicated task IDs, wrong SHA, cycle, forged count and repeated output to prove **no phantom MET**. The independent T00 reviewer must not use a self-generated score, fabricated receipt or draft PR as a mainline release acceptance.

Backlog/audit input bytes, not this documentation, determine verdicts. Refresh this report only with a new exact SHA-pinned audit; never reuse a stale report to grant MET.
