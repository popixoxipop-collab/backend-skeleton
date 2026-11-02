# T19 wave6: six game/source/project original negative-vector representations

Status: **development-only candidate**, stacked on PR #293 exact head `321d9370785c7c01e7a818a0f9ab464f15e212ed`. That PR itself depends on Draft #292 and #291. Protected main and all release/attestation authority remain unchanged.

## Scope

Original planned negative catalog: **79 IDs**. Current main represents **35**; earlier *unmerged* candidates wave3/wave4/wave5 would bring that to **55**. This proposal adds 6 previously unrepresented IDs and 7 executable mutations, yielding **61/79 development representations, 18 still missing**, but only *after* all four stacked proposals are individually accepted and merged. Neither representation count nor a synthetic test constitutes proof of runtime game behavior, signed attestation, or T19-04 MET.

| Vector | Actual first-party behavior tested |
|---|---|
| NEG-PROJ-04 | Moving a same-named source project from `services/api` to `services/api-renamed` changes its repo-local project identity; migration is not silently inferred. |
| NEG-GAME-01 | Adjacent named input listener and movement code remain **effect unknown**; the webgame scan must emit `WEBGAME_INPUT_EFFECT_UNRESOLVED`, without a made-up causal edge. |
| NEG-GAME-02 | A native source export's claims cannot self-certify runtime state transitions or causal behavior. Mutating `causal_edges_verified` to true fails the envelope check. |
| NEG-GAME-03 | Two Godot scenes with the same local node name/path retain **scene-qualified distinct IDs** and do not collapse into a single node. |
| NEG-GAME-06 | A source-only Unreal class with `BlueprintImplementableEvent` keeps `declared-structure-only` status and all runtime verification flags false. No claim is made about unexported Blueprint bodies. |
| NEG-GAME-07 | Unity `m_Script` GUID/fileID is retained in normalized serialized references; changing the GUID invalidates old exact source-byte evidence and changes the new asset identity. Two separate mutants test reference projection and source hash checking. |

Seven tested mutants use the existing T19 product mutation runner on **disposable copies of an exact Git commit**; six are critical and one noncritical according to the original 79-vector catalog. Every original test suite must pass, and every mutant must fail an actual assertion with the **same expected executed test count**, exit1 without timeout/signal/cancelled/skipped/TODO. Syntax/import errors do not count as genuine kills. The latest generic T19 hardening in independent PR #294 is intentionally not embedded here; this candidate's live test applies its own strict assertion evidence controls instead.

Commands from a clean committed checkout with prewarmed npm dependencies:

```sh
node --test --test-concurrency=1 --test-reporter=tap test/conformance-next/wave6-*.test.mjs
node test/conformance-next/product-mutation-runner.mjs --repo-root "$PWD" \
  --source-commit "$(git rev-parse HEAD)" \
  --catalog test/conformance-next/product-mutations-wave6.json \
  --out /absolute/new-wave6-evidence.json
```

No production files, old catalogs, historical receipts, protected CI, source baselines, runtime services, npm publication, or T00 canonical ledger are edited. All additions live under `next/t19/**` and `test/conformance-next/**`, discovered by existing T19 nested CI.

## Limits and admission

The webgame and native exporters statically describe *source-backed declarations only*. Unity GUID source hashing does not prove an external asset exists. Godot identities are scoped to textual scene paths, not live editor instance identity. Unreal Blueprint function declarations are not exported executable Blueprint implementations. Project IDs are repository-relative drafts, not globally stable cross-tool IDs. No real Unity/Unreal/Godot runtime, GPU screenshot, external server, private holdout or physical control is used.

The unresolved independent review quota on PRs #291–#294 is **not** authority to merge. Only after exact-head required CI, independent source review, protected merges in dependency order, actual merged-head replays and strict T00 adjudication can official main coverage or MET change. Until then T19-04 remains PARTIAL, current official T00 r202 remains MET88/PARTIAL143/NOT_MET60.

## Focused exact-mutation test presentation

The initial committed wave6 campaign detected the source changes but its full
12-case integrated test returned **11/12**: Node's bounded legacy mutant-runner
output tail retained the failure's test count yet lost the assertion marker
because later test cases had filled the 1,400-character tail. That result is
preserved as a failure, not promoted to PASS.

This correction adds five single-case oracle files sharing the original five
native/game behavior checks through one local helper module. Each real mutant
uses only its corresponding focused fixture with **one** executed test case;
the complete original comprehensive game test remains discovered by normal
T19 CI. This retains the strict explicit ERR_ASSERTION and exact test-count
requirements, instead of broadening the runner's generic exit-code detector.
The existing generic false-kill hardening is developed separately in PR294 and
is not silently copied into this dependency chain.
