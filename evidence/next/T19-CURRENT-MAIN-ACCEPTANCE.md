# T19 current-main independent QA acceptance slice

Observed: 2026-09-27 KST  
Branch: `t00/t19-current-main-qa-r1`  
Base: `backend-skeleton@bb18182c54a3a8f682ed2d1a6bac26749fcf267e`

## Scope

This is a clean current-main resubmission of T19-owned QA surfaces only:

- `test/conformance-next/**`
- `test/corpus-next/**`
- this status document

The QA engine/corpus bytes were restacked from historical T19 PR #118 head
`1a4e4da3b62bf0113d240c32bfede06f7884966d` without importing the stale
coordination base or historical T19 evidence files.

No package, workflow, registry, stable schema, production writer, or product implementation is changed.

## Direct EOE validation

Focused suites on current main:

- harness: **14/14 PASS** — request `d207194c-0d98-4aec-b2cd-14bdc2361bc9`
- certification/holdout semantics: **14/14 PASS** — request `0e704916-ff58-454c-95ec-10638e88a41c`
- T19-owned mutation-runner regressions: **4/4 PASS** — request `cd64d503-4219-437a-9b4f-0d4868e95857`
- product security invariants: **4/4 PASS** — request `6bbdc727-7797-4380-b627-02b8b2fe3484`

Total ordinary focused tests: **36 PASS / 0 FAIL / 0 SKIP**.

The full 13-mutant product campaign exceeds the Tailnet single-exec 10s ceiling, so the exact same mutation runner was executed in bounded subsets. Every product mutant was independently observed as `killed`:

- first 3 adapter mutants: **3/3 killed** — request `1ca00b01-9a8a-475a-a192-78c58e5c8713`
- capability mutants: **3/3 killed** — request `eaf8dd3f-e17f-41ca-b0a1-e326e6ec2bd0`
- scan/generated/traversal mutants: **3/3 killed** — request `2b7612c7-fbeb-4e0a-99c3-538d5fde26c0`
- exact-byte hashing mutant: **killed** — request `21926831-15ac-45aa-b93d-38633b9caacf`
- exact-head attestation mutant: **killed** with a targeted invariant execution — request `5949a7eb-6155-44d7-9104-f27dd9a09aaf`
- private-key mode mutant: **killed** with a targeted invariant execution — request `ffd2463f-846e-4d5d-bda4-aba7e0dc87a8`
- TypeScript access fail-closed mutant: **killed** — request `443981db-f1c5-44bc-801d-f18587dab7f7`

Subset runs containing only critical mutants can report a local gate failure because the noncritical denominator is empty; that is not a surviving mutant. The exact-head GitHub T19 nested lane must still run the full catalog as the integration proof.

Shared main already contains:

- `.github/workflows/ci.yml` step `T19 conformance-next`
- `scripts/run-next-nested-tests.mjs T19`

so this PR does not modify shared CI merely to obtain coverage.

## Release-certification boundary

The checked-in public reference corpus deliberately has **no holdout entries**.

The certifier therefore behaves fail-closed:

- fully passing reference-corpus validation with the default release behavior => **BLOCKED**
- `--allow-no-holdout` => internal/reference validation only
- a non-public independent `sbf.qa-holdout/1` may be injected at certification time
- a holdout that leaks a reference-corpus source family is rejected

Accordingly, this slice does **not** satisfy T19-03 release acceptance by itself.

Current disposition:

- T19 QA engine on current main: **INTEGRATION CANDIDATE**
- current-main focused QA: **PASS**
- product mutation observations: **13/13 killed**
- independent/private holdout: **MISSING**
- trusted independent holdout attestor: **MISSING** (`test/conformance-next/holdout-attestors.json` has no active keys)
- T19-03 release certification: **BLOCKED(PRIVATE_HOLDOUT_AND_TRUSTED_ATTESTOR_REQUIRED)**
- product release/default activation: **NOT AUTHORIZED**

A later T19-03 acceptance packet must bind a non-public holdout, a separately reviewed trusted attestor key from the committed registry, final release heads, terminal exact-head CI, and content-addressed release evidence. Caller-generated keys cannot authorize release certification.