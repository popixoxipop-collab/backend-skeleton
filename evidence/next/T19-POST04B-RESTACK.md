# T19 post-04B restack checkpoint — 2026-09-26

Active PR: #118
Head before this checkpoint: `e71f3651ef5f0c67f8698f53d649302aa004ff9d`

## Coordination base

PR #118 was retargeted from `main` to:

`scale/T00/bootstrap-baseline@3e2db88d25da1f11b830e2dd1f24d60f3f291d43`

The compare against that coordination head contains only T19-owned paths:
- `test/conformance-next/**`
- `test/corpus-next/**`
- `evidence/next/T19-*`

No package/workflow/shared schema file is changed by T19.

## Why a new exact-head run is required

The existing run #1187 / `36208983773` was created before the PR base retarget, so it uses the older workflow shape and has no `nested-next` jobs.

T00/T23 shared integration PR #130 landed required nested test lanes on the coordination branch. T19 therefore requires a new PR-head run after this checkpoint and will verify:

1. `nested-next (22.x)` exists and is terminal success;
2. `nested-next (24.x)` exists and is terminal success;
3. the T19 conformance-next step actually executes, rather than reporting NOT_PRESENT;
4. the run head equals the exact T19 PR head;
5. generic root CI remains separate from focused T19 evidence.

This evidence file is intentionally added after the base retarget to trigger that exact-head workflow evaluation.

## Current QA scope

- planned negative vectors: 79
- T19 harness mutants: 7
- product-core mutants represented: 9
- total executable mutation fixtures represented: 16
- latest two independently staged product kills: NEG-GEN-01 and NEG-TRUST-02
- release certification: not claimed
- TypeScript Express holdout issue #119: still open

