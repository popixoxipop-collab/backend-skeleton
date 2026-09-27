# T23 release control — integrated-main rebaseline

Status: **REBASELINED_BLOCKED**.

This directory is release-control evidence only. It does not change the stable CLI, package allowlist, production registry, default writer, workflow privileges, or published package version.

Current integrated main anchors:

- backend-skeleton: `bb18182c54a3a8f682ed2d1a6bac26749fcf267e`
- backend-decoder: `eb8164560ddd343306234a9140dc89c001519792`
- Backend-evaluation: `f7189e4208f04867b493c7d874a77325ad84afa3`

T00-04A remains authoritative: legacy HTTP identity is the default/authoritative identity and T01 is additive. T01-06 is accepted as a compatibility-shipping gate; it is not a global next-writer cutover.

The three integrated main trees are byte-equivalent to their reviewed integration heads, but release policy deliberately distinguishes that from **direct exact-head main release CI**. Release therefore remains blocked until direct final-main evidence and the remaining T19/T20/rehearsal gates are present.

Run:

```bash
node --test release/next/test/release-policy.test.mjs
node release/next/release-policy.mjs verify release/next/compatibility-inventory.json release/next/release-plan.json release/next/evidence-manifest.json release/next/evidence-manifest.json
```

Evidence references are resolved through `release/next/evidence-manifest.json`. A syntactically valid `sha256:...` string is never sufficient by itself: the verifier reads the referenced artifact bytes, recomputes SHA-256, and requires the artifact to bind the exact release check and all three current release-head SHAs.
