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

## Files owned by this T01 slice

- `contracts/next/identity.mjs`
- `schemas/next/artifact-ref.schema.json`
- `schemas/next/identity-envelope.schema.json`
- `schemas/next/identity.golden.json`
- `test/contract-next/contract-identity-next.test.mjs`
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
