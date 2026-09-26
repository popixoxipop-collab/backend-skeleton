# T19 review — T16/T23 Docker vs chord failure classification

**Overall verdict: PASS for failure-classification semantics; BLOCKED for retrospective chord root-cause certainty**

Reviewed: 2026-09-26

## T23 exact target

Backend-evaluation PR #58:
- head `364df37ece2e7b01361556ea09cd2f8cd7ebc246`
- workflow run `36150923266`
- attempt 1 integration job `108123677119` — **failure**
- attempt 2 integration job `108302328157` — **success**
- attempt 2 next-runtime Node 20/22/24 — **success**
- attempt 2 unit Node 20/22/24 — **success**

## What attempt 1 proves

The attempt-1 integration log contains three different classes that must not be collapsed.

### 1. chord-forward-right

`chord-forward-right` failed with:

```text
actual:   candidate_execution_failed
expected: repaired_and_passed
```

At this revision, `lib/webgame-repair-loop.mjs` returns `candidate_execution_failed` only when:

```text
execution.runtime_state !== 'ready' || !execution.observation
```

The browser evidence comparison is not reached in that branch.

Therefore this is **not evidence of a chord behavior/assertion mismatch**. It is an execution-layer failure.

However the benchmark summary for that case does not persist the returned `runtime_state` or `log`. T19 therefore cannot retrospectively prove which execution failure affected this exact chord case.

Classification:

```text
chord-forward-right attempt-1:
BLOCKED / EXECUTION_INFRASTRUCTURE_UNKNOWN
not PRODUCT_BEHAVIOR_FAILED
not independently attributable to Docker cache corruption
```

### 2. explicit Docker build-cache corruption in the same attempt

The same integration log independently contains:

```text
failed to export image: No such image: sha256:...
NotFound: parent snapshot sha256:... does not exist: not found
```

Those are direct Docker build/cache failures and are independent of chord semantics.

Backend-evaluation PR #65:
- head `14671926d55446b2491854b3f39b80ea5002f56d`
- merged as `1dbdafdcdfe4acb3a15f7e9ca89ce62795f1124a`
- exact-head CI run `36206087532` — **success**

The fix:
- classifies only explicit cache/snapshot signatures as `docker_build_cache_corruption`;
- retries exactly once with `docker build --no-cache` only for those signatures;
- does **not** retry ordinary `build_command_failed`;
- removes the final image with `--no-prune`.

This preserves the failure boundary instead of turning any product build failure into a retry/pass.

### 3. fresh chord execution after the flaky run

Backend-evaluation PR #66:
- head `7ff35ec09a64a2e04165c82de01a0d96ae4a7312`
- CI run `36206449861` — **success**
- integration job `108303908702` — **success**

The PR integration explicitly set:

```text
BEVAL_WEBGAME_REPAIR_CASES=
translate-x-positive,
chord-forward-right,
preserve-visibility-while-translate
```

Observed chord result:

```text
chord-forward-right — repaired_and_passed
```

Benchmark: 3/3 selected cases passed.

This is real Docker/browser execution, not a mock-only unit assertion. It demonstrates that the chord behavior is executable and passes on a fresh run. It does not retroactively identify the exact attempt-1 infrastructure cause.

## T16 semantics check

T16 PR #61 explicitly models:
- original/baseline execution first;
- original infrastructure failure => BLOCKED;
- candidate executor exception => candidate infrastructure BLOCKED;
- candidate comparison failure only after original passes => product FAILED.

Head:
`622109466b95ae1b0da36d4fb215b414ff8b4ae4`

Exact-head CI:
`36153191713` — **success**

T16 PR #62 adds real loopback protocol probes but explicitly does not claim broad Runtime-tested certification:
- head `accce80a4a4c48e8bfc0e32c5d6e42bfd2394956`
- CI `36206061712` — **success**

The T16 failure taxonomy is compatible with the observed Docker/chord distinction.

## T19 decision

Approved classification level:

- Docker cache signatures: **verified infrastructure class**
- PR #65 retry policy: **static/unit + exact-head CI verified**
- selected chord smoke at PR #66: **real integration execution PASS**
- historical chord attempt-1 exact root cause: **BLOCKED / unknown execution-layer cause**
- broad Runtime-tested product certification: **NOT granted**

T19 rejects:
- treating attempt-1 chord as a behavior failure;
- treating all build failures as retryable Docker corruption;
- using attempt-2 success to erase attempt-1 failure evidence;
- claiming broader production/runtime certification from this smoke slice.

No Docker daemon or shared cache was modified by T19 during this review.
