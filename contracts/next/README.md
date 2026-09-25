# T01 — contract identity compatibility lane

Status: experimental, opt-in, backward-compatible. This document describes the T01 branch only; it does not change `sbf_contract: "9"` or the existing identity versions.

## Baseline

T01 starts from backend-skeleton commit `5472a8b82655840d1d3ce76cb926987376e37ca6`.

Existing identity contracts remain authoritative:

- `sbf.contract-ref/1`
- `sbf.action-ref/1`
- `sbf.field-ref/1`
- `beval.binding-json/1`

The existing `contract_hash` remains SHA-256 of the exact UTF-8 contract bytes. Reformatting the contract therefore creates a different artifact even when parsed JSON is semantically equivalent. T01 does not replace this with a semantic hash.

## New opt-in primitives

### `sbf.artifact-ref/1`

`ArtifactRef` is a family-neutral exact-byte reference for immutable artifacts that do not already have a dedicated identity reference. It stores:

- family
- family version
- media type
- SHA-256 of the exact bytes
- byte length

It is intentionally not a semantic-equivalence digest, provenance attestation, signature, or execution approval.

### `sbf.identity-envelope/1`

Version 1 only wraps the existing HTTP identity family. It carries one existing ContractRef, ActionRef, or FieldRef without changing, repairing, prefixing, or renaming it.

```json
{
  "identity_envelope": "sbf.identity-envelope/1",
  "family": "http",
  "reference_kind": "action",
  "reference": {
    "action_ref": "sbf.action-ref/1",
    "contract": { "...": "existing ContractRef" },
    "operation_id": "getHello"
  }
}
```

A future game/protocol/persistence identity family must define and validate its own reference type instead of placing an HTTP ContractRef inside this envelope under a different family name.

## Dual reader

`contracts/next/identity.mjs` accepts either:

1. an existing ContractRef/ActionRef/FieldRef; or
2. an `sbf.identity-envelope/1` containing one of those references.

The reader returns the exact referenced operation/field identity. It does not look at display labels, aliases, profiles, case IDs, or neighboring contracts. A syntactically valid but different operation ID remains different; the reader never strips or adds feature prefixes to make it match.

## Canonical binding extraction

The canonical `beval.binding-json/1` serializer/digest algorithm previously pinned by `test/contract-identity.test.mjs` is exported by `contracts/next/identity.mjs` without changing its rules. The new tests replay every existing golden digest before testing the new envelope.

This extraction is deliberately narrow: existing contract hashes, becoder hashes, beval artifact hashes, and historical binding bytes are not rewritten.

## Exact-byte regression vectors

`schemas/next/identity.golden.json` contains two JSON strings that parse to the same object but use different formatting. Their `ArtifactRef.byte_sha256` and `size_bytes` differ. This is an explicit regression check that formatting-only changes remain different artifacts.

Unicode non-normalization continues to use the existing golden vectors. Precomposed and decomposed strings must retain different binding digests.

## Consumer conformance pack

`schemas/next/identity-conformance.json` is a data-only pack for T15/T16 and future independent consumers. A consumer passes it only by running the vectors through its own reader. Importing or spawning bskel to obtain the answer is not conformance.

The pack contains legacy ContractRef/ActionRef/FieldRef cases, the HTTP-only envelope, a valid-but-different operation ID that must remain different, fail-closed negatives, and exact-byte artifact vectors.

## Independent consumer result

T15/T16 and future consumers must not report only a boolean pass. The reviewed handoff consists of:

- `schemas/next/identity-conformance.json` — the exact input/expected vectors;
- `schemas/next/identity-consumer-result.schema.json` — the consumer-owned execution result shape;
- `contracts/next/consumer-conformance.mjs` — the T01 verifier used after a consumer submits its result.

A result binds the consumer repository + exact 40-hex commit, implementation path, exact SHA-256 of the conformance-pack bytes, command/exit code, and one observation for every reviewed vector. It must explicitly state that bskel was neither imported nor spawned at runtime.

The verifier rejects stale/substituted pack bytes, missing/duplicate/unexpected vectors, operation-ID repair, exact-byte artifact substitution, negative cases that no longer fail closed, summary tampering, and any bskel runtime dependency. JSON object key order is not identity; ArtifactRef and the pack SHA-256 preserve exact-byte boundaries separately.

This result contract is **candidate pre-freeze**. A valid result proves conformance to these reviewed vectors at the named consumer commit; it does not by itself grant T00-04 activation or runtime/business-behavior certification.

When more than one independent consumer is required, `verifyRequiredConsumerSet()` combines already-verified results into `sbf.identity-consumer-set/1`. It rejects duplicate repositories and, when a required repository list is supplied, rejects both missing and unexpected consumers. The generated summary is described by `schemas/next/identity-consumer-set.schema.json`. For T01-05, the intended required set is becoder + beval at exact commits; the function itself is generic and does not hardcode repository names.

## Files owned by this T01 slice

- `contracts/next/identity.mjs`
- `contracts/next/consumer-conformance.mjs`
- `schemas/next/artifact-ref.schema.json`
- `schemas/next/identity-envelope.schema.json`
- `schemas/next/identity.golden.json`
- `schemas/next/identity-conformance.json`
- `schemas/next/identity-consumer-result.schema.json`
- `schemas/next/identity-consumer-set.schema.json`
- `test/contract-next/contract-identity-next.test.mjs`
- `test/contract-next/identity-conformance.test.mjs`
- `test/contract-next/consumer-conformance.test.mjs`
- `test/contract-next/package-identity-next.test.mjs`
- `test/contract-next/t01-compatibility-evidence.json`
- `contracts/next/README.md`

No stable writer, CLI entry point, adapter descriptor, package lock, `sbf_contract: "9"` schema, or existing identity file is modified by this slice.

## T01 task mapping

| Task | State after this slice | Evidence |
|---|---|---|
| T01-01 existing wire contract audit | implemented as baseline assertions | existing golden digests replayed by production serializer |
| T01-02 vNext boundary RFC | implemented as opt-in artifact ref + HTTP-only envelope | this document and schemas |
| T01-03 dual reader + schema | implemented | `readIdentity`, schema tests |
| T01-04 identity/hash golden vectors | implemented for this slice | legacy replay + exact-byte artifact + envelope vectors |
| T01-05 consumer contract tests | not complete | becoder/beval independent readers still need cross-repo work |
| T01-06 compatibility promotion evidence | not complete | requires packed artifacts and cross-repo replay |

T01-05 and T01-06 are intentionally not marked complete by backend-skeleton unit tests alone.
