# T14 provider composition layer: interface RFC

Status: draft, shadow only. T14 is not declared complete and nothing here is active by default. This document describes the code of `handles/composition-next` as it is at the base commit `15a38e923cb5e079c6f8e2a4c2a9386406c41f52`, defects included; it fixes none of them and promotes nothing.
Companions: `BASELINE.json` (behaviour pinned by T14-01: file hashes, replayable fixtures, observed limits), `interface-rfc.vocabulary.json` (every name, status, code and key used here) and `interface-rfc.test.mjs`, which fails when the tables, headings, backticked names or rule statements of this text, the vocabulary or the code drift apart; the sentences between them are not machine checked. Keep the checked parts literal.

## 1. Purpose and non-goals

The layer decides, for one combination of a legacy handles provider, a persistence layer and a key type, whether a generation may be previewed and how far it is certified. The three legacy providers stay authoritative. The layer audits what they declare (`auditLegacyProviders`), calls their `emit` function in dry-run mode (`previewGeneration`), takes a conservative decision per resource (`describeResourceGeneration`), and checks the evidence of each certification level (`evaluateCompositionCertification`). It applies nothing: every plan and every certification result carries `applyAllowed` false, blocked or not.

This RFC fixes what other tracks may rely on: the identity of a provider, a combination, a plan, a certification and the evidence it binds (section 4); the exact words in which the layer says that something is unknown, partial or unsupported (section 5); the gates between the certification levels (section 6); and who owns which file (section 7).

Non-goals:

- It is not a design for new behaviour. Where the code has a defect the defect is described as observed and listed as a limit (section 8); none is fixed here.
- It does not define the documents of other tracks. The persistence hand-off and the runtime evidence are described only as far as the inspectors of this layer read them.
- It does not cover a packed artifact, real input of the neighbour tracks, the promotion of the layer or a rollback.
- It does not run a real provider. The tests drive the preview with stub providers (limit `real-provider-emit-is-not-replayed`).
- It does not compile, install, start or run generated code, and the layer itself performs no file or network access: the preview hands `emit` the dry-run arguments (rule `preview-is-a-dry-run`) and the six modules import nothing but each other and `node:crypto` (rule `isolated-modules`).

## 2. Scope and files

The layer is the six modules of `handles/composition-next`; the record and this document sit next to them, and the tests are in `test/provider-composition-next`.

| file | role | exported names |
| --- | --- | --- |
| `BASELINE.json` | baseline record of this layer: file hashes, replayable fixtures, observed limits, commands and results | - |
| `INTERFACE_RFC.md` | this document | - |
| `catalog.mjs` | the closed list of approved provider, persistence layer and key type combinations | `APPROVED_COMBINATIONS`, `listApprovedCombinations`, `resolveApprovedCombination` |
| `certification.mjs` | the certification gate: evidence required per level, blockers, never allows apply | `evaluateCompositionCertification`, `requiredEvidenceFor` |
| `evidence-boundary.mjs` | byte-level checks of evidence artifacts and of the persistence and runtime hand-offs of other tracks | `inspectPersistenceHandoff`, `inspectRuntimeBehaviorProjection`, `t16HashJson`, `validateBoundCertificationEvidence` |
| `legacy-baseline.mjs` | audit of the declared contract, capabilities and outputs of the three legacy providers | `LEGACY_PROVIDER_IDS`, `auditLegacyProviders` |
| `plan.mjs` | dry-run preview of a generation: calls the provider emit with dryRun true and reports writes, actions and blockers | `previewGeneration` |
| `safety-profile.mjs` | conservative per-provider generation profile and the per-resource decisions taken from it | `describeResourceGeneration` |

Each module imports only sibling modules and `node:crypto`. None has a computed import, a require call or a createRequire call, and none reads a clock, a random source or the process, prints or is asynchronous (rule `isolated-modules`). The layer imports none of the three provider files.

| module | imports | computed imports |
| --- | --- | --- |
| `catalog.mjs` | none | 0 |
| `safety-profile.mjs` | none | 0 |
| `legacy-baseline.mjs` | none | 0 |
| `plan.mjs` | `./catalog.mjs`, `./safety-profile.mjs` | 0 |
| `certification.mjs` | `./catalog.mjs`, `./evidence-boundary.mjs` | 0 |
| `evidence-boundary.mjs` | `node:crypto` | 0 |

The two test files that exist at the base commit are pinned by file hash in the record. The other files of the test directory check the record and this document.

| test file | tests | covers |
| --- | --- | --- |
| `evidence-boundary.test.mjs` | 7 | artifact-bound evidence, the persistence hand-off, the runtime projection and the refusals at behavior level |
| `legacy-provider-composition.test.mjs` | 18 | catalog, legacy audit, preview with stub providers, safety labels against the real resolver templates, certification levels and refusals |

| file | role |
| --- | --- |
| `baseline-record-lib.mjs` | helpers of the baseline record test: hashing, fixture replay, record checks, figures stated in this document |
| `baseline-record.test.mjs` | checks BASELINE.json: file hashes, replay of the fixtures, commands, counts, limits and the figures of this document |
| `interface-rfc.test.mjs` | checks this document: derives the vocabulary from the code, compares it with the vocabulary file and with the tables, headings, names and rule statements of the text |
| `interface-rfc.vocabulary.json` | the pinned vocabulary: what the code emits (derived) and what it means (narrative) |

The suite runs in two ways. The root `npm test` does not run it (limit `root-npm-test-does-not-run-the-suite`); the nested runner and a direct `node --test` call do. The record holds the result of both at the base commit:

| command id | command | result at the base commit |
| --- | --- | --- |
| `direct-tap` | `node --test test/provider-composition-next/evidence-boundary.test.mjs test/provider-composition-next/legacy-provider-composition.test.mjs` | exit 0; 25 tests, 25 pass, 0 fail, 0 skipped |
| `nested-runner` | `node scripts/run-next-nested-tests.mjs T14` | exit 0; 25 tests, 25 pass, 0 fail, 0 skipped; first line `NESTED_SUITE T14 RUN 2 files` |

## 3. Inputs and outputs

Every function takes one object, except `listApprovedCombinations` (no argument), `auditLegacyProviders` (a list of providers and an options object) and the hash function of the evidence module (one value; it is defined for JSON values only, see rule `hash-input-domain`). Called without an argument, or with null, the functions of the crash table in section 5 throw a TypeError of the JavaScript engine, not an error of the layer. The errors that the layer throws itself are in the thrown table of section 5.

| function | module | inputs, defaults as written |
| --- | --- | --- |
| `listApprovedCombinations` | `catalog.mjs` | none |
| `resolveApprovedCombination` | `catalog.mjs` | `{ providerId, persistenceId, keyType }` |
| `describeResourceGeneration` | `safety-profile.mjs` | `{ providerId, handlesPlan, resourceFilter = null }` |
| `auditLegacyProviders` | `legacy-baseline.mjs` | `providers, { revision = null } = {}` |
| `previewGeneration` | `plan.mjs` | `{ provider, repoRoot, featureId, revision = null, handlesPlan, persistenceId, keyType, resourceFilter = null, enforceRegistry = false }` |
| `evaluateCompositionCertification` | `certification.mjs` | `{ providerId, persistenceId, keyType, revision, profileId = null, level, providerBaselineAudit, generationPreview, evidence = [], persistenceHandoff = null, runtimeBehavior = null }` |
| `requiredEvidenceFor` | `certification.mjs` | `{ providerId, level }` |
| `inspectPersistenceHandoff` | `evidence-boundary.mjs` | `{ expected, handoffBytes, handoffRef, provenance }` |
| `inspectRuntimeBehaviorProjection` | `evidence-boundary.mjs` | `{ expected, bindingBytes, bindingRef, pairBytes, pairRef, oracleEvidenceBytes, oracleEvidenceRef, candidateEvidenceBytes, candidateEvidenceRef, projection }` |
| `t16HashJson` | `evidence-boundary.mjs` | `value` |
| `validateBoundCertificationEvidence` | `evidence-boundary.mjs` | `{ expectedKind, revision, providerId, combinationId, profileId, evidence }` |

`listApprovedCombinations` returns an array of copies of the catalog entries, `resolveApprovedCombination` one copy or null, and the hash function of the evidence module a string of 64 lowercase hexadecimal characters whenever it returns (it throws for some values and gives one shared hash to others: rule `hash-input-domain`). Every other result is a plain object, or for `requiredEvidenceFor` an array of strings. The keys come out in the order of the table, and the schema ids are draft vocabulary (limit `outputs-are-draft-0-vocabulary`). A plan has three shapes: the short shape for a combination outside the catalog (no safety check, `emit` not called), the preflight shape when the resource check fails (`emit` not called) and the full shape after `emit`. `validateBoundCertificationEvidence` has two shapes: the short one, in which `ok` is always false, when the evidence is missing, its bytes or its reference cannot be read, or the bytes are not one JSON document, and the long one for every other outcome, whose `accepted` holds the reduced evidence when `ok` is true and is null when it is false.

| function | schema id | status values | keys, in the order the code writes them |
| --- | --- | --- | --- |
| `auditLegacyProviders` | `sbf.handles-provider-baseline-audit/0` | `ok=false`, `ok=true` | `schema, revision, ok, expectedProviderIds, observed, errors` |
| `describeResourceGeneration` | - | - | `decisions, generatedResourceTypes, skippedResourceTypes, requestedMissing, manualCompletions` |
| `evaluateCompositionCertification` | `sbf.handles-composition-certification/0` | `blocked`, `certified` | `schema, status, requestedLevel, certifiedLevel, revision, profileId, combination, applyAllowed, acceptedEvidence, crossTrackEvidence, blockers` |
| `inspectPersistenceHandoff` | - | `blocked`, `eligible` | `status, blockers` |
| `inspectRuntimeBehaviorProjection` | - | `blocked`, `eligible` | `status, blockers, bindingHash` |
| `previewGeneration` (emit was called with dryRun true) | `sbf.handles-composition-plan/0` | `blocked`, `ready` | `schema, status, applyAllowed, providerId, featureId, revision, combination, resourceDecisions, manualCompletions, plannedWrites, forcedWrites, actions, blockers, notes` |
| `previewGeneration` (resource checks failed before emit: emit not called) | `sbf.handles-composition-plan/0` | `blocked` | `schema, status, applyAllowed, providerId, featureId, revision, combination, plannedWrites, actions, resourceDecisions, manualCompletions, blockers, notes` |
| `previewGeneration` (combination not in the catalog: no safety check, emit not called) | `sbf.handles-composition-plan/0` | `blocked` | `schema, status, applyAllowed, providerId, featureId, revision, combination, plannedWrites, actions, blockers, notes` |
| `requiredEvidenceFor` | - | - | an `array` of strings, the evidence kinds |
| `validateBoundCertificationEvidence` | - | `ok=false` | `ok, blockers` |
| `validateBoundCertificationEvidence` | - | `ok=false`, `ok=true` | `ok, blockers, accepted` |

For each of the three legacy providers the audit checks that it is present, its contract id, its `requiresCapabilities` and its `outputs.spec`, and that `plan` and `emit` are functions. Its errors are written from the templates below, and a provider with another id is not looked at (limit `legacy-audit-sees-only-three-ids`):

| audit error, as the code writes it |
| --- |
| `${id}: contract changed from ${expected.contract} to ${String(provider.contract)}` |
| `${id}: outputs.spec changed from [${expected.outputsSpec.join(', ')}] to [${Array.isArray(provider.outputs?.spec) ? provider.outputs.spec.join(', ') : String(provider.outputs?.spec)}]` |
| `${id}: provider missing` |
| `${id}: provider.emit is not a function` |
| `${id}: provider.plan is not a function` |
| `${id}: requiresCapabilities changed from [${expected.requiresCapabilities.join(', ')}] to [${Array.isArray(provider.requiresCapabilities) ? provider.requiresCapabilities.join(', ') : String(provider.requiresCapabilities)}]` |

The safety profile of a provider is a fixed row. A resource is generated only when the provider plan says `willGenerateResolver` true; every column of a resource that is not generated reads `not-generated`. A primary key that is explicitly not a UUID (`idFieldIsUuid` false) adds a reason to the decision but does not stop the generation (limit `safety-profile-gaps`). The words of the profile and the keys of its results:

| provider | fetch | authorization | patch | recover |
| --- | --- | --- | --- | --- |
| `java-spring` | `provider-backed-read` | `provider-policy` | `provider-policy` | `provider-policy` |
| `python-fastapi` | `provider-backed-read` | `fail-closed-stub` | `fail-closed-stub` | `gated-by-access-stub` |
| `typescript-express` | `provider-backed-read` | `fail-closed-stub` | `fail-closed-stub` | `gated-by-access-stub` |

| kind | value |
| --- | --- |
| column word | `fail-closed-stub` |
| column word | `gated-by-access-stub` |
| column word | `not-generated` |
| column word | `provider-backed-read` |
| column word | `provider-policy` |
| decision reason | `provider plan did not mark this resource as safe for resolver generation` |
| decision reason | `resource primary key is explicitly non-UUID` |
| manual completion area | `authorization` |
| manual completion area | `patch` |
| manual completion reason | `generated access check intentionally denies until the target application wires its own authorization semantics` |
| manual completion reason | `generated patch path intentionally returns/throws not-implemented until the target application wires its own update semantics` |
| result keys | `decisions, generatedResourceTypes, skippedResourceTypes, requestedMissing, manualCompletions` |
| decision keys | `resourceType, generated, fetch, authorization, patch, recover, reasons` |
| manual completion keys | `resourceType, area, required, reason` |

## 4. Identity

### 4.1 Provider and combination

A provider is the string in `provider.id` (the plan) or `providerId` (everything else), and two ids are the same provider when the strings are equal. The layer knows three providers, and it knows them through four separate tables: the catalog, the legacy audit, the safety profiles and the build evidence kinds. Any other string is unknown to the layer, with one defect: names that every object inherits (`constructor`, `toString`, `hasOwnProperty`) pass as provider ids (limit `inherited-names-pass-as-provider-ids`, rule `inherited-names`).

A combination is the triple provider id, persistence id and key type. It exists only as one of the three entries of the closed catalog, and its id joins the three parts with plus signs. A part that is changed, empty or missing gives null from `resolveApprovedCombination`, and a combination is never composed from parts of two entries (rule `closed-catalog`). The two catalog functions hand out copies (rule `catalog-copies`).

| id | providerId | language | framework | persistenceId | keyType | status |
| --- | --- | --- | --- | --- | --- | --- |
| `java-spring+jpa-hibernate+uuid` | `java-spring` | `java` | `spring` | `jpa-hibernate` | `uuid` | `legacy-provider` |
| `python-fastapi+sqlalchemy-sqlmodel+uuid` | `python-fastapi` | `python` | `fastapi` | `sqlalchemy-sqlmodel` | `uuid` | `legacy-provider` |
| `typescript-express+typeorm+uuid` | `typescript-express` | `typescript` | `express` | `typeorm` | `uuid` | `legacy-provider` |

### 4.2 Plan

A plan is identified by the provider id, the feature id and the revision it echoes. `previewGeneration` takes the provider from `provider.id`; when the handles plan names a provider the two must be equal, else an Error is thrown, and a handles plan without a provider passes. `featureId` and `repoRoot` must be non-empty strings and nothing more is checked. `revision` is echoed and not validated: the plan accepts any string and null, and the value becomes an identity only where the certification compares it. `emit` is called once, and only after the resource check has passed, with `{ repoRoot, featureId, plan, resourceFilter, force, reason, dryRun, computeDiff, enforceRegistry }`, where `force` is false, `reason` is empty, `dryRun` is true and `computeDiff` is false (rule `preview-is-a-dry-run`). What `emit` returns is read loosely (limit `plan-trusts-provider-output-loosely`): a missing result is an empty result, and only the lists of conflicts, orphans and registration gaps can block.

### 4.3 Certification

A certification result is identified by its request: provider id, persistence id, key type, level, revision and, at behavior level, the profile id. `revision` must be exactly 40 lowercase hexadecimal characters, and the provider audit, the plan and every evidence entry that is used must carry the identical string, compared with strict equality (rule `exact-revision`). The result echoes `combination` (a copy of the catalog entry, or null), the requested level and `certifiedLevel`, which is the requested level when the status is `certified` and null otherwise. At behavior level the result also carries `crossTrackEvidence`, the two inspections `persistence` and `runtime`; at the other levels it is null.

`acceptedEvidence` is derived and not passed through. For each required kind the first entry with the exact revision, status success and the provider id and combination id of the request in its `scope` is reduced to `kind`, `revision`, `source`, `runId` and `artifactRef`; absent values become null. At preview and build level no artifact reference is read: an entry with an invalid reference still certifies, and `validateBoundCertificationEvidence`, which would refuse it, is not called (rule `plain-evidence`, limit `certification-accepts-plain-evidence`).

### 4.4 Evidence boundary

`evidence-boundary.mjs` holds the only byte-level checks of the layer: an evidence document or a hand-off is judged from its bytes and its artifact reference. A reference (`sbf.artifact-ref/1`) has exactly six fields, and two references are equal only when all six are equal (rule `reference-equality`). `byte_sha256` is the sha256 of the exact bytes and `size_bytes` their length.

The hash rule of the evidence module is the sha256 of the value written with sorted keys at every depth, two-space indentation and one final newline (rule `hash-rule`). It is the rule for JSON values; for other inputs the function throws or gives a shared hash (rule `hash-input-domain`). The same rule has a second copy in another track that no test compares with this one (limit `hash-rule-has-a-second-copy`). Three kinds of hash must not be confused. The hash of bytes (`byte_sha256`) belongs to the artifact as stored. The hash of a parsed document under the hash rule (`bindingHash`, `oracle_evidence_hash`, `candidate_evidence_hash`) belongs to the canonical text of the parsed JSON, whatever the original bytes were. The plain hashes that other tracks put into the binding (`candidate_hash`, `oracle_profile_approval_hash`, `contract_hash`) are only compared. An evidence document of the internal kind has to be written in the canonical form of the hash rule as well; other bytes give `evidence-bytes-noncanonical`.

The persistence hand-off passes only with a provenance record whose status is `accepted`. The status `bound`, which the persistence track writes, is refused (rule `bound-is-not-accepted`), and nothing in the repository writes `accepted` (limit `accepted-handoffs-have-no-producer`). The runtime inspector compares values and checks the format of `candidate_hash` only (rule `values-are-compared`, limit `runtime-values-are-compared-not-validated`); no other producer of the runtime evidence document exists in the repository (limit `runtime-evidence-document-has-no-other-producer`).

| field | module | what identifies or binds |
| --- | --- | --- |
| `providerId` | `catalog.mjs` | first part of the identity of a combination: the id of a legacy provider, compared by string equality; the plan takes it from provider.id |
| `persistenceId` | `catalog.mjs` | second part: the id of the persistence layer, compared by string equality |
| `keyType` | `catalog.mjs` | third part: the key type; uuid in every catalog entry |
| `combination` | `plan.mjs` | in a plan and in a certification result: a copy of the catalog entry, or null when the three parts are not one entry; the id of an entry joins the three parts with plus signs |
| `featureId` | `plan.mjs` | a non-empty string, echoed in the plan and passed to emit; nothing else is checked |
| `willGenerateResolver` | `safety-profile.mjs` | field of a resource in the provider plan: only the value true makes the decision generated; any other value, or a missing field, gives not-generated and a reason |
| `idFieldIsUuid` | `safety-profile.mjs` | field of a resource in the provider plan: the value false adds a reason to the decision and does not stop generation; any other value adds nothing |
| `revision` | `plan.mjs` | echoed in the plan (null when not given) and not checked there; the certification compares it with strict equality |
| `revision` | `certification.mjs` | exactly 40 lowercase hexadecimal characters; the provider audit, the plan and every evidence entry must carry the identical string |
| `profileId` | `certification.mjs` | a non-empty string at behavior level (else profile-missing), handed to both inspectors as the expected profile; at the other levels it is only echoed |
| `scope` | `certification.mjs` | field of an evidence entry: its providerId and combinationId must equal the request, else the entry is not valid evidence |
| `acceptedEvidence` | `certification.mjs` | derived, not passed through: for each required kind the first matching entry (revision, status success, provider id, combination id) is reduced to kind, revision, source, runId and artifactRef |
| `byte_sha256` | `evidence-boundary.mjs` | field of an artifact reference: sha256 of the exact bytes, 64 lowercase hexadecimal characters; compared with the hash of the bytes passed in (artifact-bytes-mismatch) |
| `size_bytes` | `evidence-boundary.mjs` | field of an artifact reference: the byte length of the artifact, a non-negative safe integer; compared with the length of the bytes passed in |
| `combinationId` | `evidence-boundary.mjs` | the id of a catalog entry as a hand-off names it; the expectation takes expected.combinationId, else expected.id |
| `provenance` | `evidence-boundary.mjs` | record handed in next to the persistence hand-off: status accepted, producerRevision of 40 hexadecimal characters, candidateRevision equal to the expected revision, combinationId, profileId, executionRef and an artifactRef equal to the reference of the hand-off field by field |
| `bindingHash` | `evidence-boundary.mjs` | result key of the runtime inspector: t16HashJson of the parsed binding document (its canonical text, not the bytes passed in), null when the binding is not JSON |
| `runtime_binding_hash` | `evidence-boundary.mjs` | field of the evidence pair: must equal bindingHash, else pair-binding-mismatch |
| `oracle_evidence_hash` | `evidence-boundary.mjs` | field of the evidence pair: t16HashJson of the parsed oracle evidence document; compared only when truthy (see runtime-values-are-compared-not-validated) |
| `candidate_evidence_hash` | `evidence-boundary.mjs` | field of the evidence pair: t16HashJson of the parsed candidate evidence document; compared only when truthy |
| `candidate_hash` | `evidence-boundary.mjs` | field of the runtime binding: 64 lowercase hexadecimal characters (else candidate-artifact-unbound); candidateArtifactSha256 of the projection must equal it |
| `oracle_profile_approval_hash` | `evidence-boundary.mjs` | field of the runtime binding: profileApprovalHash of the projection must equal it, together with the profile id |
| `contract_hash` | `evidence-boundary.mjs` | field of the runtime binding: both execution evidence documents must repeat it |
| `run_id` | `evidence-boundary.mjs` | field of the runtime binding: runId of the projection must equal it (run-id-mismatch) |
| `attempt_nonce` | `evidence-boundary.mjs` | field of the binding and of the pair, and attemptNonce of the projection: the three must be equal, but the pair value is not compared when the binding value is empty (limit `runtime-values-are-compared-not-validated`) |
| `runtimeBindingArtifactSha256` | `evidence-boundary.mjs` | field of the projection: must equal byte_sha256 of the binding reference that was passed in |
| `evidencePairArtifactSha256` | `evidence-boundary.mjs` | field of the projection: must equal byte_sha256 of the pair reference that was passed in |
| `oracleEvidenceArtifactSha256` | `evidence-boundary.mjs` | field of the projection: must equal byte_sha256 of the oracle evidence reference that was passed in |
| `candidateEvidenceArtifactSha256` | `evidence-boundary.mjs` | field of the projection: must equal byte_sha256 of the candidate evidence reference that was passed in |
| `executionRef` | `evidence-boundary.mjs` | a non-empty string in the projection and in the provenance (execution_ref in the bound evidence document); only its presence is checked |
| `producerApproval` | `evidence-boundary.mjs` | field of the projection: accepted is the only value that passes (runtime-handoff-not-approved); no file outside the layer writes it (see accepted-handoffs-have-no-producer) |

| contract or schema id | role | found in |
| --- | --- | --- |
| `sbf.handles-provider/1` | contract string that each of the three legacy providers must declare; the audit compares it by equality | `legacy-baseline.mjs` |
| `sbf.handles-provider-baseline-audit/0` | schema id of the result of auditLegacyProviders | `legacy-baseline.mjs` |
| `sbf.handles-composition-plan/0` | schema id of the result of previewGeneration, in all three shapes | `plan.mjs` |
| `sbf.handles-composition-certification/0` | schema id of the result of evaluateCompositionCertification | `certification.mjs` |
| `bskel.internal.handles-composition-evidence/0` | value of the evidence field of the bound evidence document that validateBoundCertificationEvidence reads; an internal id, no file outside the layer contains it | `evidence-boundary.mjs` |
| `sbf.artifact-ref/1` | artifact reference: the six-field record that ties a byte string to its sha256 and its size | `evidence-boundary.mjs` |
| `sbf.persistence-generation-handoff/1` | contract field of the persistence hand-off document that inspectPersistenceHandoff expects from the persistence track | `evidence-boundary.mjs` |
| `beval.runtime-binding/1` | runtime binding document: run id, hashes of case, profile approval, contract, flow, config and candidate, and the attempt nonce | `evidence-boundary.mjs` |
| `beval.runtime-evidence-pair/1` | runtime evidence pair: ties the oracle and the candidate execution evidence to one binding and one attempt | `evidence-boundary.mjs` |
| `beval.execution-evidence/1` | execution evidence of the oracle and of the candidate: operations, exchanges and flow runs | `evidence-boundary.mjs` |

| name | keys | used by |
| --- | --- | --- |
| artifact reference | `artifact_ref, family, version, media_type, byte_sha256, size_bytes` | exact key set of every `sbf.artifact-ref/1`; two references are equal only when all six fields are equal |
| bound evidence document | `evidence, kind, revision, status, provider_id, combination_id, profile_id, execution_ref, assertions` | exact key set of the document that `validateBoundCertificationEvidence` reads |
| execution evidence, required keys | `execution_evidence, target, contract_hash, operations, exchanges, flow_runs` | keys that the oracle and the candidate document of `beval.execution-evidence/1` must have |
| execution evidence, allowed keys | `execution_evidence, target, contract_hash, operations, exchanges, flow_runs, state_hash` | the same document may add state_hash and nothing else |
| assertion summary | `expected, executed, passed, failed, unresolved` | exact key set of the assertion counts in bound evidence and in the runtime projection; every count is a non-negative safe integer |
| blocking exchange verdicts | `invalid, error` | schema_verdict values of a candidate exchange that raise candidate-exchange-invalid |
| runtime binding | `runtime_binding, run_id, case_revision_hash, oracle_profile_approval_hash, contract_hash, flow_hash, config_hash, candidate_hash, original_hash, runner_implementation_hash, runtime_execution_policy_hash, artifacts, attempt_nonce` | exact key set of `beval.runtime-binding/1` |
| runtime evidence pair | `runtime_evidence_pair, family, runtime_binding_hash, attempt_nonce, oracle_evidence_hash, candidate_evidence_hash` | exact key set of `beval.runtime-evidence-pair/1`; the family must be http |

## 5. Unknown, partial and unsupported

The layer has no status unknown and no status partial. The status words of its results are `blocked`, `ready`, `certified` and `eligible` and nothing else, and `blocked` is the only way in which it says that it cannot decide (rule `no-unknown-status`). The words UNSUPPORTED, UNKNOWN, BLOCKED and NOT_RECORDED are the statuses of the limits in the record; the layer never emits them.

- Unsupported is a combination outside the catalog (`unsupported-combination`), a level that is not one of the three or a provider without a build evidence profile (`unsupported-certification-level`), and the behavior level as a whole (`behavior-handoff-not-integrated`). Each is reported as a blocker, or as a thrown error when `describeResourceGeneration` or `requiredEvidenceFor` is called directly, and never as a silent skip.
- Unknown is an input that the layer cannot place. A hand-off or runtime input that was not passed is reported as `persistence-handoff-missing` or `runtime-handoff-missing` inside the reasons of an invalid hand-off. A provider that the audit does not list is not seen at all (limit `legacy-audit-sees-only-three-ids`), and a preview-tested request for a provider outside the catalog is blocked by `unsupported-combination` plus one `missing-evidence` blocker per evidence kind, not by one statement that the provider is unknown (limit `unknown-provider-preview-evidence-is-listed`).
- Partial exists only as a ready plan that leaves resources out. Without a `resourceFilter`, a resource that the provider plan did not approve is listed in `resourceDecisions` with `not-generated` in every column and a reason, and the plan stays `ready` while at least one resource is generated. With a `resourceFilter`, a resource that is skipped blocks the plan (`requested-resource-not-generatable`). A certification is never partial: `certified` means no blocker at the requested level.

Every word of this vocabulary, where the code writes it and what it means:

| word | found at | meaning |
| --- | --- | --- |
| `unsupported-combination` | `results/codes/previewGeneration.short`, `results/codes/evaluateCompositionCertification` | provider, persistence layer and key type are not one catalog entry, or one of the three is missing; the plan returns its short blocked shape and never calls emit, the certification adds the blocker and goes on |
| `requested-resource-missing` | `results/codes/previewGeneration.preflight` | a type named in resourceFilter does not occur in the handles plan |
| `requested-resource-not-generatable` | `results/codes/previewGeneration.preflight` | a resourceFilter is set and a selected resource was not approved by the provider plan |
| `no-generatable-resources` | `results/codes/previewGeneration.preflight` | after the filter no resource is approved for resolver generation; also the answer when the handles plan lists no resources |
| `not-generated` | `safety/columns` | fetch, authorization, patch and recover of a resource the provider plan did not approve |
| `provider-backed-read` | `safety/columns` | fetch of a generated resource: the read path of the provider itself (all three providers) |
| `provider-policy` | `safety/columns` | java-spring: authorization, patch and recover follow the policy of the provider; no manual completion is listed |
| `fail-closed-stub` | `safety/columns` | python-fastapi and typescript-express authorization and patch: generated code that denies or throws until the target application wires its own semantics; one manual completion per generated resource and area |
| `gated-by-access-stub` | `safety/columns` | python-fastapi and typescript-express recover: gated by the access stub; no manual completion of its own |
| `blocked` | `results/statuses/previewGeneration`, `results/statuses/evaluateCompositionCertification`, `results/statuses/inspectPersistenceHandoff`, `results/statuses/inspectRuntimeBehaviorProjection` | at least one blocker; the result cannot be used for the next step. This is the only way the layer says that it cannot decide: there is no status unknown and no status partial |
| `ready` | `results/statuses/previewGeneration` | a plan without blockers; it may still skip resources the provider plan did not approve, which then show as not generated in resourceDecisions (a partial generation is a ready plan) |
| `certified` | `results/statuses/evaluateCompositionCertification` | no blocker at the requested level: certifiedLevel equals requestedLevel and applyAllowed is still false |
| `eligible` | `results/statuses/inspectPersistenceHandoff`, `results/statuses/inspectRuntimeBehaviorProjection` | the inspector found no blocker; eligible is not certified, and at behavior level the certification stays blocked anyway |
| `legacy-provider` | `catalog/entries/status` | the only catalog status: the combination is served by an existing provider module |
| `unsupported-certification-level` | `results/codes/evaluateCompositionCertification` | requiredEvidenceFor threw: the level is not one of the three, or the provider has no build evidence profile; the message of the error is copied into the blocker |
| `missing-evidence` | `results/codes/evaluateCompositionCertification` | no evidence entry of a required kind was passed in (extra field kind) |
| `invalid-evidence` | `results/codes/evaluateCompositionCertification` | entries of a required kind exist but none has the exact revision, the status success, the provider id and the combination id (extra field kind) |
| `profile-missing` | `results/codes/evaluateCompositionCertification` | behavior-tested was requested without a non-empty profile id |
| `behavior-handoff-not-integrated` | `results/codes/evaluateCompositionCertification` | appended at every behavior-tested request, whatever the hand-offs contain: the level never certifies |
| `persistence-handoff-missing` | `results/codes/evaluateCompositionCertification.reasons` | no persistence hand-off input was passed at behavior level (only inside the reasons of persistence-handoff-invalid) |
| `runtime-handoff-missing` | `results/codes/evaluateCompositionCertification.reasons`, `results/codes/inspectRuntimeBehaviorProjection` | no runtime input was passed at behavior level, or the projection given to the inspector is not a plain object |
| `handoff-not-approved` | `results/codes/inspectPersistenceHandoff` | the provenance record is missing or its status is not accepted (a status bound is refused) |
| `runtime-handoff-not-approved` | `results/codes/inspectRuntimeBehaviorProjection` | producerApproval of the projection is not accepted |

A blocker is an object with `code` and `message` and, for the codes below, the extra fields of the second table. The message text is not pinned. The first table lists every code that the code can emit, by function and family.

| function | family | codes |
| --- | --- | --- |
| `validateBoundCertificationEvidence` | the artifact reference and its bytes | `artifact-bytes-invalid`, `artifact-bytes-mismatch`, `artifact-family-invalid`, `artifact-hash-invalid`, `artifact-media-type-invalid`, `artifact-ref-contract-invalid`, `artifact-ref-invalid`, `artifact-size-invalid`, `artifact-version-invalid` |
| `validateBoundCertificationEvidence` | the evidence document and what it is bound to | `evidence-bytes-noncanonical`, `evidence-combination-mismatch`, `evidence-contract-invalid`, `evidence-envelope-missing`, `evidence-execution-ref-missing`, `evidence-json-invalid`, `evidence-kind-mismatch`, `evidence-profile-mismatch`, `evidence-provider-mismatch`, `evidence-revision-mismatch`, `evidence-shape-invalid`, `evidence-status-failed` |
| `validateBoundCertificationEvidence` | the assertion summary of the document | `assertion-count-invalid`, `assertion-summary-invalid` |
| `inspectPersistenceHandoff` | the hand-off artifact reference and bytes (the artifact codes with the prefix handoff-) | `handoff-artifact-bytes-invalid`, `handoff-artifact-bytes-mismatch`, `handoff-artifact-family-invalid`, `handoff-artifact-hash-invalid`, `handoff-artifact-media-type-invalid`, `handoff-artifact-ref-contract-invalid`, `handoff-artifact-ref-invalid`, `handoff-artifact-size-invalid`, `handoff-artifact-version-invalid` |
| `inspectPersistenceHandoff` | the content of the hand-off document | `handoff-blockers-invalid`, `handoff-combination-mismatch`, `handoff-contract-invalid`, `handoff-has-blockers`, `handoff-json-invalid`, `handoff-not-ready`, `handoff-resource-binding-missing` |
| `inspectPersistenceHandoff` | the provenance record that must accept the hand-off | `candidate-revision-mismatch`, `execution-ref-missing`, `handoff-not-approved`, `producer-revision-invalid`, `profile-mismatch`, `provenance-artifact-mismatch`, `provenance-combination-mismatch` |
| `inspectRuntimeBehaviorProjection` | artifact references and bytes of the binding, the pair and the two evidence documents (the artifact codes with a prefix) | `binding-artifact-bytes-invalid`, `binding-artifact-bytes-mismatch`, `binding-artifact-family-invalid`, `binding-artifact-hash-invalid`, `binding-artifact-media-type-invalid`, `binding-artifact-ref-contract-invalid`, `binding-artifact-ref-invalid`, `binding-artifact-size-invalid`, `binding-artifact-version-invalid`, `candidate-evidence-artifact-bytes-invalid`, `candidate-evidence-artifact-bytes-mismatch`, `candidate-evidence-artifact-family-invalid`, `candidate-evidence-artifact-hash-invalid`, `candidate-evidence-artifact-media-type-invalid`, `candidate-evidence-artifact-ref-contract-invalid`, `candidate-evidence-artifact-ref-invalid`, `candidate-evidence-artifact-size-invalid`, `candidate-evidence-artifact-version-invalid`, `oracle-evidence-artifact-bytes-invalid`, `oracle-evidence-artifact-bytes-mismatch`, `oracle-evidence-artifact-family-invalid`, `oracle-evidence-artifact-hash-invalid`, `oracle-evidence-artifact-media-type-invalid`, `oracle-evidence-artifact-ref-contract-invalid`, `oracle-evidence-artifact-ref-invalid`, `oracle-evidence-artifact-size-invalid`, `oracle-evidence-artifact-version-invalid`, `pair-artifact-bytes-invalid`, `pair-artifact-bytes-mismatch`, `pair-artifact-family-invalid`, `pair-artifact-hash-invalid`, `pair-artifact-media-type-invalid`, `pair-artifact-ref-contract-invalid`, `pair-artifact-ref-invalid`, `pair-artifact-size-invalid`, `pair-artifact-version-invalid` |
| `inspectRuntimeBehaviorProjection` | shape and contract of the binding and the pair, and the links between them | `attempt-mismatch`, `binding-contract-invalid`, `binding-shape-invalid`, `pair-binding-mismatch`, `pair-contract-invalid`, `pair-shape-invalid` |
| `inspectRuntimeBehaviorProjection` | the oracle and the candidate execution evidence documents | `candidate-evidence-contract-invalid`, `candidate-evidence-contract-mismatch`, `candidate-evidence-exchanges-missing`, `candidate-evidence-flow-runs-missing`, `candidate-evidence-hash-mismatch`, `candidate-evidence-json-invalid`, `candidate-evidence-operations-missing`, `candidate-evidence-shape-invalid`, `candidate-evidence-target-mismatch`, `oracle-evidence-contract-invalid`, `oracle-evidence-contract-mismatch`, `oracle-evidence-exchanges-missing`, `oracle-evidence-flow-runs-missing`, `oracle-evidence-hash-mismatch`, `oracle-evidence-json-invalid`, `oracle-evidence-operations-missing`, `oracle-evidence-shape-invalid`, `oracle-evidence-target-mismatch` |
| `inspectRuntimeBehaviorProjection` | assertions and exchanges found in the candidate evidence | `assertion-count-invalid`, `assertion-list-invalid`, `assertion-summary-invalid`, `assertions-missing`, `assertions-not-all-passed`, `candidate-exchange-invalid` |
| `inspectRuntimeBehaviorProjection` | the projection compared with the bound artifacts, run and attempt | `candidate-artifact-mismatch`, `candidate-artifact-unbound`, `projection-attempt-mismatch`, `projection-binding-artifact-mismatch`, `projection-binding-mismatch`, `projection-candidate-evidence-mismatch`, `projection-oracle-evidence-mismatch`, `projection-pair-mismatch`, `run-id-mismatch` |
| `inspectRuntimeBehaviorProjection` | the projection compared with the expected revision, combination and profile | `candidate-revision-mismatch`, `execution-ref-missing`, `profile-mismatch`, `runtime-combination-mismatch` |
| `inspectRuntimeBehaviorProjection` | the verdict and approval of the projection | `assertion-summary-mismatch`, `assertions-incomplete`, `runtime-failed`, `runtime-handoff-missing`, `runtime-handoff-not-approved` |
| `previewGeneration.short` | the combination is not in the catalog | `unsupported-combination` |
| `previewGeneration.preflight` | the requested resources, checked before emit | `no-generatable-resources`, `requested-resource-missing`, `requested-resource-not-generatable` |
| `previewGeneration.full` | what the provider emit reported | `generated-file-conflict`, `generated-file-orphan`, `registry-bootstrap-gap` |
| `evaluateCompositionCertification` | the request itself | `invalid-revision`, `unsupported-combination` |
| `evaluateCompositionCertification` | the legacy provider audit that was passed in | `provider-baseline-drift`, `provider-baseline-revision-mismatch` |
| `evaluateCompositionCertification` | the plan preview that was passed in | `generation-preview-not-ready`, `generation-preview-revision-mismatch`, `preview-combination-mismatch`, `preview-provider-mismatch`, `unsafe-preview-contract` |
| `evaluateCompositionCertification` | the level and the evidence it requires | `invalid-evidence`, `missing-evidence`, `profile-missing`, `unsupported-certification-level` |
| `evaluateCompositionCertification` | the hand-offs of other tracks, behavior level only | `behavior-handoff-not-integrated`, `persistence-handoff-invalid`, `runtime-handoff-invalid` |

| code | extra fields next to code and message |
| --- | --- |
| `assertion-count-invalid` | `field` |
| `generated-file-conflict` | `path` |
| `generated-file-orphan` | `path` |
| `invalid-evidence` | `kind` |
| `missing-evidence` | `kind` |
| `persistence-handoff-invalid` | `reasons` |
| `registry-bootstrap-gap` | `path`, `resourceType` |
| `runtime-handoff-invalid` | `reasons` |

The layer throws the errors below itself (the probes reach each of them), and the functions of the crash table throw an engine TypeError for input that is not an object or has a malformed nested value. This RFC records only the class of the engine errors; `BASELINE.json` pins the message of three of them, so another engine wording fails the replay of those three fixtures (limit `engine-error-text-in-three-fixtures`).

| module | message, with placeholders as written | reached by the probes |
| --- | --- | --- |
| `safety-profile.mjs` | `Error: no conservative generation profile for provider ${providerId}` | yes |
| `plan.mjs` | `Error: provider mismatch: handles plan belongs to ${handlesPlan.provider}, got ${provider.id}` | yes |
| `plan.mjs` | `TypeError: featureId is required` | yes |
| `plan.mjs` | `TypeError: handlesPlan is required` | yes |
| `plan.mjs` | `TypeError: provider ${provider.id}: emit must be a function` | yes |
| `plan.mjs` | `TypeError: provider is required` | yes |
| `plan.mjs` | `TypeError: provider.id is required` | yes |
| `plan.mjs` | `TypeError: repoRoot is required` | yes |
| `certification.mjs` | `Error: no build evidence profile for provider ${providerId}` | yes |
| `certification.mjs` | `Error: unknown certification level "${String(level)}"` | yes |

| function | error class | cause |
| --- | --- | --- |
| `describeResourceGeneration` | `TypeError` | no argument or null: the parameter list destructures its single object argument |
| `evaluateCompositionCertification` | `TypeError` | no argument or null, and an evidence value that is not an array (null, a number, a string, an object, a boolean) at a level with required evidence kinds |
| `inspectPersistenceHandoff` | `TypeError` | no argument or null: the parameter list destructures its single object argument |
| `inspectRuntimeBehaviorProjection` | `TypeError` | no argument or null, and a candidate evidence document whose exchanges value is neither missing, null nor an array |
| `previewGeneration` | `TypeError` | no argument or null: the parameter list destructures its single object argument |
| `requiredEvidenceFor` | `TypeError` | no argument or null: the parameter list destructures its single object argument |
| `resolveApprovedCombination` | `TypeError` | no argument or null: the parameter list destructures its single object argument |
| `validateBoundCertificationEvidence` | `TypeError` | no argument or null: the parameter list destructures its single object argument |

## 6. Promotion gates

There are three levels, `preview-tested`, `build-tested` and `behavior-tested`, and each asks for the evidence kinds below, in this order. The kind that differs per provider is the build evidence.

| level | provider | required evidence kinds, in order |
| --- | --- | --- |
| `preview-tested` | `java-spring` | `composition-unit`, `package-install` |
| `preview-tested` | `python-fastapi` | `composition-unit`, `package-install` |
| `preview-tested` | `typescript-express` | `composition-unit`, `package-install` |
| `build-tested` | `java-spring` | `composition-unit`, `package-install`, `java-integration` |
| `build-tested` | `python-fastapi` | `composition-unit`, `package-install`, `python-integration` |
| `build-tested` | `typescript-express` | `composition-unit`, `package-install`, `typescript-compile` |
| `behavior-tested` | `java-spring` | `composition-unit`, `package-install`, `java-integration`, `persistence-conformance`, `runtime-behavior` |
| `behavior-tested` | `python-fastapi` | `composition-unit`, `package-install`, `python-integration`, `persistence-conformance`, `runtime-behavior` |
| `behavior-tested` | `typescript-express` | `composition-unit`, `package-install`, `typescript-compile`, `persistence-conformance`, `runtime-behavior` |

Besides evidence every level asks for two inputs: a legacy provider audit that passed, and a plan preview that is ready, has `applyAllowed` false and belongs to the provider and the combination of the request. Both must carry the identical revision. The blockers are `provider-baseline-drift`, `provider-baseline-revision-mismatch`, `generation-preview-not-ready`, `generation-preview-revision-mismatch`, `unsafe-preview-contract`, `preview-combination-mismatch` and `preview-provider-mismatch`. At behavior level a non-empty profile id is required as well (`profile-missing`), and both hand-offs are inspected.

What the certification returns for a complete and valid input at each level:

| level | status | certified level | blocker codes |
| --- | --- | --- | --- |
| `preview-tested` | `certified` | `preview-tested` | - |
| `build-tested` | `certified` | `build-tested` | - |
| `behavior-tested` | `blocked` | null | `behavior-handoff-not-integrated` |

Preview and build level can end `certified`. Behavior level cannot: `behavior-handoff-not-integrated` is added at every behavior request, whatever the hand-offs contain, and `certifiedLevel` stays null (rule `behavior-never-certifies`, limit `behavior-handoff-not-integrated`). The gate opens only when accepted persistence hand-offs and runtime evidence documents exist for the exact revision, profile and combination, and then only by a change of the code of the layer together with this RFC and its tests. An `eligible` inspection is not a certification.

Apply is not a gate of this layer. `applyAllowed` is false at every level and for every status (rule `shadow-only`, limit `shadow-only-apply-is-not-supported`). This RFC defines no promotion from shadow mode and no rollback.

## 7. File ownership and neighbours

The plan scope of T14 is `next/t14/**`, and its suite scopes are `handles/composition-next/**` and `test/provider-composition-next/**`. Every file named in section 2 belongs to T14. The table is the verdict of `node next/t00/check-ownership.mjs paths --track T14` for the files around the layer; the test calls the checker, so the table cannot drift from `next/t00/ownership-map.json`.

| path | owner verdict | relation to this layer |
| --- | --- | --- |
| `handles/composition-next/plan.mjs` | OK | a source file of the layer; every file in the two T14 directories is owned by T14 |
| `test/provider-composition-next/interface-rfc.test.mjs` | OK | a test of the layer; the same holds for every file of the test directory |
| `next/t14/PLAN.md` | OK | the plan scope of T14; the checker judges a path by its name, the file need not exist |
| `handles/providers/java-spring.mjs` | PATH_UNOWNED | a legacy provider: the audit pins its contract, the preview calls its emit; the layer imports none of the three provider files, the existing tests do |
| `handles/registry.mjs` | PATH_UNOWNED | the provider registry; it does not import the layer |
| `test/package-install.test.mjs` | PATH_UNOWNED | packs and installs the npm package, whose files include handles/ and therefore the layer; it does not run the layer |
| `scanners/persistence-next/generation-handoff.mjs` | PATH_OWNED_BY_OTHER_TRACK (T10) | defines the hand-off contract `sbf.persistence-generation-handoff/1` that inspectPersistenceHandoff expects, and a provenance record whose status is bound, not accepted |
| `adapters/protocol-next/docs/T18_TO_T16_PROTOCOL_EVIDENCE_BINDING.md` | PATH_OWNED_BY_OTHER_TRACK (T18) | the only file outside the layer that contains the word execution-evidence (in its title); the repository holds no producer of the document |
| `contracts/reconciliation-next/t16-runtime-evidence.mjs` | PATH_OWNED_BY_OTHER_TRACK (T09) | defines the other function named t16HashJson; the two copies of the hash rule are not compared by any test |
| `scanners/project-graph/INTERFACE_RFC.md` | PATH_OWNED_BY_OTHER_TRACK (T02) | lists handles/composition-next as owned by T14 |
| `next/t00/ownership-map.json` | PATH_OWNED_BY_OTHER_TRACK (T00) | defines the scopes of T14 |
| `scripts/run-next-nested-tests.mjs` | PATH_RESERVED_HOT | the nested runner that runs the suite of this layer; reserved for the coordinator |
| `.github/workflows/ci.yml` | PATH_RESERVED_HOT | the CI job that runs the nested runner; reserved for the coordinator |
| `package.json` | PATH_RESERVED_HOT | its test script does not run the suite of this layer; reserved for the coordinator |

Nothing outside the two directories imports the layer at the base commit (limit `layer-is-not-consumed-outside-its-directories`). The only things that touch it are the tests of the two directories, the nested runner and the CI job that run them, and the npm package, whose file list includes `handles/`. The layer calls the three provider files only through the provider object that a caller passes in, and it reads the documents of the persistence and runtime tracks only as bytes. Other tracks name T14 in their documents (limit `neighbour-tracks-name-t14`). A path owned by another track changes only with that owner, and the reserved files only with the coordinator.

## 8. Observed limits and how this document is checked

The record lists every limit that the baseline found. BLOCKED is a gate that the layer keeps closed, UNSUPPORTED is something the layer does not do or does wrongly, UNKNOWN is something that cannot be established from the repository, and NOT_RECORDED is something that the baseline did not capture. The statement of each limit and the fixtures that demonstrate it are in `BASELINE.json`.

| limit id | status |
| --- | --- |
| `behavior-handoff-not-integrated` | `BLOCKED` |
| `unlisted-combinations-are-unsupported` | `UNSUPPORTED` |
| `shadow-only-apply-is-not-supported` | `UNSUPPORTED` |
| `caller-expected-replaces-the-layer-expectation` | `UNSUPPORTED` |
| `safety-profile-gaps` | `UNSUPPORTED` |
| `inherited-names-pass-as-provider-ids` | `UNSUPPORTED` |
| `runtime-values-are-compared-not-validated` | `UNSUPPORTED` |
| `outputs-are-draft-0-vocabulary` | `UNSUPPORTED` |
| `root-npm-test-does-not-run-the-suite` | `UNSUPPORTED` |
| `unknown-provider-preview-evidence-is-listed` | `UNKNOWN` |
| `legacy-audit-sees-only-three-ids` | `UNKNOWN` |
| `certification-accepts-plain-evidence` | `UNKNOWN` |
| `plan-trusts-provider-output-loosely` | `UNKNOWN` |
| `layer-is-not-consumed-outside-its-directories` | `UNKNOWN` |
| `neighbour-tracks-name-t14` | `UNKNOWN` |
| `runtime-evidence-document-has-no-other-producer` | `UNKNOWN` |
| `accepted-handoffs-have-no-producer` | `UNKNOWN` |
| `hash-rule-has-a-second-copy` | `UNKNOWN` |
| `engine-error-text-in-three-fixtures` | `NOT_RECORDED` |
| `real-provider-emit-is-not-replayed` | `NOT_RECORDED` |
| `packed-artifact-and-real-t10-t16-input` | `NOT_RECORDED` |
| `installed-packages-are-not-hashed` | `NOT_RECORDED` |
| `fixtures-are-minimal-synthetic-inputs` | `NOT_RECORDED` |
| `hashes-generated-on-one-platform` | `NOT_RECORDED` |

The test derives the vocabulary from the code. It imports the six modules, calls every exported function with inputs built to reach each branch, and scans the sources for contracts, thrown messages and message templates. The result must equal the `derived` part of `interface-rfc.vocabulary.json`, the probes must reach every code and thrown message that the sources contain, and the sources must contain every code that the probes reach. The `narrative` part must fit the derived part: every code belongs to exactly one family, every word is found where it says, and every field of the identity table occurs in the module it names. Each table of this document is the rendering of the vocabulary, character for character. Headings, backticked names, the forbidden text and the ownership table are checked as well, and every rule below is proven by a test that calls the real code. A change of a module that changes an exported name, a status, a code, a key set or a thrown message therefore fails the test with the paths that differ; the vocabulary file and this document change in the same patch.

| rule | what the document claims | checked by |
| --- | --- | --- |
| `shadow-only` | The layer is shadow only: applyAllowed is false in every plan shape and in every certification result, blocked or certified. | test "rule shadow-only" |
| `isolated-modules` | Each of the six modules imports only sibling modules of the layer and node:crypto; none of them has a computed import, a require call or a createRequire call, and none reads a clock, a random source or the process, prints or is asynchronous. | test "rule isolated-modules" |
| `closed-catalog` | A combination is approved only when provider id, persistence id and key type together equal one of the three catalog entries; a changed, empty or missing part gives null, and parts taken from two entries are not approved. | test "rule closed-catalog" |
| `catalog-copies` | The catalog hands out copies: changing an entry that listApprovedCombinations or resolveApprovedCombination returned changes nothing, and APPROVED_COMBINATIONS itself is frozen. | test "rule catalog-copies" |
| `preview-is-a-dry-run` | previewGeneration calls the emit function of the provider once, with force false, an empty reason, dryRun true and computeDiff false; for a combination outside the catalog and for a failed resource check it does not call emit at all. | test "rule preview-is-a-dry-run" |
| `behavior-never-certifies` | The levels preview-tested and build-tested can end certified, but behavior-tested always ends blocked with behavior-handoff-not-integrated and certifiedLevel null, even when both hand-off inspections say eligible. | test "rule behavior-never-certifies" |
| `exact-revision` | A revision is exactly 40 lowercase hexadecimal characters: a branch name, an upper-case sha, a shorter or longer string, an empty string, null or a missing value gives invalid-revision, and an evidence entry of another revision gives invalid-evidence. | test "rule exact-revision" |
| `plain-evidence` | At preview and build level the certification reads plain evidence entries (kind, revision, status success and a scope with provider id and combination id) and copies what an entry names as its artifact without checking it; it does not call validateBoundCertificationEvidence, which refuses the same entries. | test "rule plain-evidence" |
| `bound-is-not-accepted` | The persistence hand-off passes only with a provenance status accepted; bound, pending, null and a missing status all give handoff-not-approved. | test "rule bound-is-not-accepted" |
| `hash-rule` | For a value that JSON can write, the hash of t16HashJson is the sha256 of the value written with sorted keys at every depth, two-space indentation and one final newline; the runtime inspector reports that hash of the binding document as bindingHash. | test "rule hash-rule" |
| `hash-input-domain` | t16HashJson does not hash every value. A BigInt (as the value, as an array element or as an enumerable string-keyed property, also when nested in other values) throws a TypeError. A cycle through plain objects and arrays, or a nesting deep enough to exhaust the stack, throws a RangeError, and a cycle through a class instance or an object without prototype throws a TypeError. Undefined, a function, a symbol and a call without an argument throw nothing and share one hash, that of the text undefined with a final newline; NaN, Infinity and null share one hash as well. Whenever it returns, the result is a string of 64 lowercase hexadecimal characters. | test "rule hash-input-domain" |
| `reference-equality` | An artifact reference has exactly six fields and is compared field by field: a changed field, a changed size or a seventh field blocks the hand-off. | test "rule reference-equality" |
| `values-are-compared` | The runtime inspector compares the values of the binding, the pair, the evidence documents and the projection with each other and checks the format of candidate_hash only: an empty run id, an empty attempt nonce or a null contract hash stays eligible when every document repeats it, and a pair hash that is empty, null or 0 skips the comparison with the evidence document. | test "rule values-are-compared" |
| `no-unknown-status` | The status words are blocked, ready, certified and eligible and nothing else: no function of the layer answers unknown or partial. | test "rule no-unknown-status" |
| `fail-closed-profiles` | For python-fastapi and typescript-express, authorization and patch of a generated resource are fail-closed stubs with one manual completion per resource and area, and recover is gated by the access stub; java-spring follows its provider policy and lists no manual completion. | test "rule fail-closed-profiles" |
| `inherited-names` | Observed defect, not fixed: provider ids are looked up in plain objects, so the inherited names constructor, toString and hasOwnProperty pass; describeResourceGeneration then returns a generated decision whose fetch, authorization, patch and recover are undefined, and requiredEvidenceFor lists a function where an evidence kind belongs. | test "rule inherited-names" |
