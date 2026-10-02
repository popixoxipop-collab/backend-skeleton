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

A result carries the consumer repository + a 40-hex commit, implementation path, exact SHA-256 of the conformance-pack bytes, command/exit code (self-declared), and one observation for every reviewed vector. The verifier checks the pack SHA-256 and the observations against the reviewed pack, but checks the commit only for format (40 lowercase hex characters) and the command only as a non-empty string, so neither is tied to the run that produced the observations (see the T01 task mapping section below). It must explicitly state that bskel was neither imported nor spawned at runtime.

The verifier rejects stale/substituted pack bytes, missing/duplicate/unexpected vectors, operation-ID repair, exact-byte artifact substitution, negative cases that no longer fail closed, summary tampering, and any result that declares a bskel runtime import or spawn (`execution.exit_code` and the two `bskel_runtime_*` fields are constants written by the result builders, not observations, and the verifier only compares them with 0 and false; see the T01 task mapping section below). JSON object key order is not identity; ArtifactRef and the pack SHA-256 preserve exact-byte boundaries separately.

This result contract is **candidate pre-freeze**. A valid result shows, as reported by the consumer, conformance to these reviewed vectors for the exact pack bytes it names; the verifier does not run the consumer, and it checks the consumer commit the result names for format only (see the T01 task mapping section below). It does not by itself grant T00-04 activation or runtime/business-behavior certification.

When more than one independent consumer is required, `verifyRequiredConsumerSet()` combines already-verified results into `sbf.identity-consumer-set/1`. It rejects duplicate repositories and, when a required repository list is supplied, rejects both missing and unexpected consumers. The generated summary is described by `schemas/next/identity-consumer-set.schema.json`. For T01-05, the intended required set is becoder + beval, each result naming a commit (the function checks it for format only, see the T01 task mapping section below); the function itself is generic and does not hardcode repository names.

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

| Task | State | Evidence |
|---|---|---|
| T01-01 existing wire contract audit | implemented as baseline assertions | existing golden digests replayed by production serializer |
| T01-02 vNext boundary RFC | implemented as opt-in artifact ref + HTTP-only envelope | this document and schemas |
| T01-03 dual reader + schema | implemented | `readIdentity`, schema tests |
| T01-04 identity/hash golden vectors | implemented for this slice | legacy replay + exact-byte artifact + envelope vectors |
| T01-05 consumer contract tests | PASS on the T00 coordination record (additive, candidate pre-freeze); re-run 2026-10-02 | `gates.T01.verdict` in `integration/scale/T00-05-execution-state.json` on the branch `scale/T00/bootstrap-baseline`, first at commit `b9b5ee7180123b93271529fcfcd0896444ce3d34`; `release/next/compatibility-inventory.json` `promotion_evidence.t01_06.current_rerun` |
| T01-06 compatibility promotion evidence | ACCEPTED on the T00 coordination record (additive only, candidate pre-freeze); re-run 2026-10-02 | `promotion_gate.t01_06` in the same file, first at commit `2d226b1b14f533ba181300ca955ff4969dba0c66`; `release/next/release-plan.json` `coordination_ref` |

The unit tests in this directory do not decide T01-05 or T01-06 by themselves. The decision is recorded on the coordination branch `scale/T00/bootstrap-baseline` of this repository (the commits named above) and is not merged to main; `release/next/release-plan.json` carries the exact commit and blob SHAs, and `release-policy.mjs verify` does not check them.

The acceptance covers additive consumer compatibility against the **candidate pre-freeze** pack only:

- It is not a final freeze. The T00-04A core freeze pins `contracts/next/identity.mjs`, `schemas/next/artifact-ref.schema.json`, `schemas/next/identity-envelope.schema.json` and `schemas/next/identity.golden.json`; the conformance pack, the verifier and the result and set schemas are not named there.
- It is not signed release evidence: `release/next/evidence-manifest.json` has no entries.
- It is not a release, a default-writer change or a cutover, and legacy HTTP identity stays authoritative.
- The 2026-10-02 re-run was done by one Claude Code session on one host; it is not an independent review. `test/contract-next/t01-compatibility-evidence.json` keeps the 2026-09-25 observation and adds its `current_state`.
- No rollback material for T01-06 was found. The scale plan's track description defines the T01-06 deliverable as support scope, constraints, rollback and replay material. The replay part is covered by the re-run; the word rollback does not occur in the T01 paths of the three repositories at their mains of 2026-10-02, nor in `integration/scale/T00-05-execution-state.json` at the branch tip. The rollback text in `release/next/release-plan.json` (`migration_stages[].rollback` and `rollback_policy`) and the closing rollback sentence of `release/next/migration-runbook.md` are release-wide policy, not T01-06 evidence. Details are in `current_state.not_established` of the evidence file above.
- The consumer commits are not bound to the replayed bytes. `verifyRequiredConsumerSet()` checks each `commit_sha` only as 40 lowercase hex characters (forty zeros were still accepted), and `execution.exit_code`, `execution.bskel_runtime_imported` and `execution.bskel_runtime_spawned` in a consumer result are constants written by the result builders, not observations. See `current_state.requirements_note` in the same file.
