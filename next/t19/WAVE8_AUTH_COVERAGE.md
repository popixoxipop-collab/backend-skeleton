# T19 Wave8 — OpenAPI security declarations vs runtime enforcement

This is an **additive T19 QA candidate stacked on Draft PR #296** at exact head `3d0f177a4180ec806074517e0f33a9b52ad50cc9`. It tests source-declaration fidelity **only**; it does NOT test authenticated HTTP execution, user roles, tenant boundaries, or token validation.

## Four originally planned negative vectors (five live source mutations)

| Vector | Executed behavior |
|---|---|
| NEG-AUTH-02 | A source OpenAPI `security` array is accurately copied as `sourceSecurity`. It must never create `runtimeEnforced`, `securityVerified`, `authzPassed` or another claim of actually verifying a credential. An absent operation declaration is not fabricated. |
| NEG-AUTH-04 | Per-operation `security: []` remains explicit public-source metadata, `security: [{bearerAuth:[]}]` remains protected-source metadata, and absent operation security stays *unknown*, even with a global security declaration. No global rule is blindly overwritten onto every operation. |
| NEG-AUTH-05 | A single requirement object `[{bearerAuth:[],apiKeyAuth:[]}]` (source AND) is not rewritten as two alternative objects (source OR), and vice versa. Both referenced schemes remain present and separate. Two mutations exercise the AND→OR and OR→AND regressions. |

| NEG-PROJ-05 | Two equal-priority recognizers see one shared source marker. Both candidates remain visible and no exclusive project facet is selected. |

The mutation runner inserts **four critical and one noncritical source mutations** into a fresh, disposable, source-committed Git snapshot, with each oracle a one-test first-party fixture. Required evidence: green original, changed exit1 from a real assertion with matching case count, no signal/timeout/skip/cancel/TODO or syntax-only false kill. Source file `contracts/openapi.mjs` is **never edited in the PR**—it is changed only inside the temporary mutation scratch tree. Prior T19 catalogs, T00 sources, protected CI and live infrastructure are unchanged.

## Scope and limitations

These are **source declaration** checks, not authorization. The existing OpenAPI reconciler deliberately uses the name `sourceSecurity`, does not execute an HTTP endpoint, cannot verify whether any bearer/API key token is actually accepted, and cannot infer wrong role, cross-tenant scope or missing-token runtime denial. The actual NEG-AUTH-01/03/DB-05 and other runtime-sensitive vectors are **not** closed by this slice.

Original T19 negative corpus: 79 vector IDs. Protected main remains **35/79** represented. Across separately reviewed and merged Wave3–7 Draft PRs, the stacked **candidate** was 67/79. This Wave8 would add **3 representations**, making **71/79 candidate with 8 still unrepresented**. A represented development test is not a proof of complete safety or T19-04 MET; Node18/20, other OS and prospective holdout remain pending.

No independent reviewer approval is inferred from the test result; Codex quota was previously blocked. Any publication is a Draft; future exact-head CI, authorized review, normal protected merge, actual merged source replay and scoped T00 adjudication are separate. Official T00 remains **r202 MET88/PARTIAL143/NOT_MET60**, global release blocked.

## Original RED candidate and strict noncritical gate

The initial four critical source mutations were detected by real assertions, but the original T19 acceptance gate correctly returned FAIL with no executable noncritical mutant. Retained job: job_a23d0ce95cde228f13f21efdc436f21d. The new noncritical project-ambiguity test fulfills that independent gate requirement without weakening it.
