# Artifact digest / revocation policy draft

Status: pre-T20-04 data-only foundation. **T20-04 remains dependency-blocked by T20-03 and T00-04B runtime integration.**

The policy is deliberately not a downloader, package manager, signature verifier or runtime launcher. It answers one narrow question: whether exact bytes identified by a lowercase SHA-256 are allowed for a declared usage, revoked, or untrusted.

Supported usages:
- adapter
- grammar
- helper
- image
- package
- runner
- schema

Rules:
- mutable names/tags/URLs/versions are not authority inputs;
- trust is exact `usage + sha256`;
- revocation is digest-global and must be removed from the allowlist rather than relying on precedence;
- unknown artifacts are untrusted;
- revocation reason is mandatory;
- duplicate input order normalizes deterministically;
- policy generation rollback, new allow grants, and removing a revocation are privilege expansions;
- adding revocations and removing allows are reductions.

`artifactTrustPolicyDigest()` hashes a T20-specific framed representation:

```text
bskel.trust-artifact-policy-json/1\n
<normalized-json>\n
```

This digest is for T20 trust-policy identity only. It is **not** a ContractRef, ArtifactRef replacement, SLSA attestation, or `beval.binding-json/1` digest.

Signature verification is intentionally absent. A future signature/revocation closeout must reuse the repository's established attestation/key practices or another reviewed signing authority rather than inventing a second cryptographic trust system inside this file.

The future runtime consumer must record both the requested policy digest and the actual runner/package/executable/image digests it enforced. Matching a trust policy does not prove behavior correctness.
