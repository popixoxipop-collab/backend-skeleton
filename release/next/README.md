# T23 release control — integrated-main rebaseline

Status: **REBASELINED_BLOCKED**.

This directory is release-control evidence only. It does not change the stable CLI, package allowlist, production registry, default writer, workflow privileges, or published package version.

Current integrated main anchors:

- backend-skeleton: `1cdd848a5aa97ff558c0574da70fedb899131ff7`
- backend-decoder: `0f0abcea1337335fc44b943932ad3c5f3fbaad6c`
- Backend-evaluation: `020668cdc2f5a836e78dfe05fd845ea58769a0e9`

T00-04A remains authoritative: legacy HTTP identity is the default/authoritative identity and T01 is additive. T01-06 is accepted as a compatibility-shipping gate; it is not a global next-writer cutover.

These anchors were re-pinned on 2026-09-30 (T00-E) to the observed mains; they are pinned, not declared final-frozen. `compatibility-inventory.json` records the direct push CI run on each exact head. Release remains blocked: no check result is PASS because PASS requires T00-pinned, authority-signed evidence, T19-03 and T20-03 are not accepted, and the only rehearsal that exists (backend-evaluation `npm run test:release-rehearsal`) is a partial DB pointer-set rehearsal, not a full release/rollback rehearsal.

Run:

```bash
node --test release/next/test/release-policy.test.mjs
node release/next/release-policy.mjs verify release/next/compatibility-inventory.json release/next/release-plan.json release/next/evidence-manifest.json
```

Evidence references are resolved through `release/next/evidence-manifest.json`. A syntactically valid `sha256:...` string is never sufficient by itself: the verifier reads the referenced artifact bytes, recomputes SHA-256, and requires the artifact to bind the exact release check and all three current release-head SHAs.


## Authenticated release evidence

A content hash alone proves artifact integrity, not who produced the assertion. Release PASS evidence therefore requires an external T00-pinned Ed25519 authority.

Blocked-plan structural verification remains:

```bash
node release/next/release-policy.mjs verify \
  release/next/compatibility-inventory.json \
  release/next/release-plan.json \
  release/next/evidence-manifest.json
```

When PASS evidence exists, T00 must additionally supply an authority file and its independently pinned SHA-256 reference:

```bash
node release/next/release-policy.mjs verify \
  release/next/compatibility-inventory.json \
  release/next/release-plan.json \
  release/next/evidence-manifest.json \
  /path/outside/candidate/release-authority.json \
  sha256:<authority-file-sha256>
```

Every evidence artifact must be signed by a trusted key from that authority and must contain check-specific verifier fields. A self-authored JSON file with correct hashes and `PASS` text is insufficient.

Default activation is a distinct operation. Setting `default_activation_allowed=true` additionally requires a separately signed active `bskel.scale-default-activation-lease/1` bound to the exact three release heads:

```bash
... sha256:<authority-file-sha256> \
  /path/to/signed-default-activation-lease.json \
  <expected-fencing-token> \
  <expected-claim-id>
```

The release plan must also use `READY_FOR_RELEASE` when release is enabled, or `READY_FOR_DEFAULT_ACTIVATION` when default activation is enabled. `REBASELINED_BLOCKED` can never coexist with an enabled release.


The activation lease is accepted only when `issued_at <= now < expires_at`, the public key is Ed25519, and the signed lease's fencing token plus claim ID exactly match values independently pinned by T00. A still-unexpired older lease cannot survive a newer fencing epoch.
