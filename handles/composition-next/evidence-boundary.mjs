import crypto from 'node:crypto';

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const MEDIA_TYPE_RE = /^[^\s/]+\/[^\s]+$/;
const FAMILY_RE = /^[a-z][a-z0-9.-]*$/;
const INTERNAL_EVIDENCE = 'bskel.internal.handles-composition-evidence/0';
const ARTIFACT_REF = 'sbf.artifact-ref/1';

function isPlainObject(value) {
	return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected) {
	if (!isPlainObject(value)) return false;
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sha256Bytes(bytes) {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

function toBytes(value) {
	if (typeof value === 'string') return Buffer.from(value, 'utf8');
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	return null;
}

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (isPlainObject(value)) {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
	}
	return value;
}

function canonicalJsonBytes(value) {
	return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
}

// Independent consumer implementation of the T16 hashJson byte rule. This does not replace
// beval's runtime binding verifier; it only lets T14 reject a pair that visibly names a different
// binding before any cross-track handoff can be considered.
export function t16HashJson(value) {
	return sha256Bytes(canonicalJsonBytes(value));
}

function inspectArtifactRef(bytes, ref) {
	const blockers = [];
	const raw = toBytes(bytes);
	if (!raw) {
		blockers.push({ code: 'artifact-bytes-invalid', message: 'artifact bytes must be a string, Buffer, or Uint8Array' });
		return { ok: false, blockers };
	}
	if (!exactKeys(ref, ['artifact_ref', 'family', 'version', 'media_type', 'byte_sha256', 'size_bytes'])) {
		blockers.push({ code: 'artifact-ref-invalid', message: 'ArtifactRef must contain the exact sbf.artifact-ref/1 field set' });
		return { ok: false, blockers };
	}
	if (ref.artifact_ref !== ARTIFACT_REF) blockers.push({ code: 'artifact-ref-contract-invalid', message: 'unsupported artifact_ref' });
	if (typeof ref.family !== 'string' || !FAMILY_RE.test(ref.family)) blockers.push({ code: 'artifact-family-invalid', message: 'ArtifactRef.family is invalid' });
	if (typeof ref.version !== 'string' || !ref.version) blockers.push({ code: 'artifact-version-invalid', message: 'ArtifactRef.version is required' });
	if (typeof ref.media_type !== 'string' || !MEDIA_TYPE_RE.test(ref.media_type)) blockers.push({ code: 'artifact-media-type-invalid', message: 'ArtifactRef.media_type is invalid' });
	if (typeof ref.byte_sha256 !== 'string' || !SHA256_RE.test(ref.byte_sha256)) blockers.push({ code: 'artifact-hash-invalid', message: 'ArtifactRef.byte_sha256 is invalid' });
	if (!Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 0) blockers.push({ code: 'artifact-size-invalid', message: 'ArtifactRef.size_bytes is invalid' });
	if (blockers.length === 0 && (raw.length !== ref.size_bytes || sha256Bytes(raw) !== ref.byte_sha256)) {
		blockers.push({ code: 'artifact-bytes-mismatch', message: 'artifact bytes do not match ArtifactRef' });
	}
	return { ok: blockers.length === 0, blockers, raw };
}

function parseJson(raw) {
	try { return JSON.parse(raw.toString('utf8')); }
	catch { return null; }
}

function expectedCombinationId(expected) {
	return expected?.combinationId ?? expected?.id ?? null;
}

function nonEmptyString(value) {
	return typeof value === 'string' && value.length > 0;
}

function sameArtifactRef(left, right) {
	if (!left || !right) return false;
	const fields = ['artifact_ref', 'family', 'version', 'media_type', 'byte_sha256', 'size_bytes'];
	return exactKeys(left, fields)
		&& exactKeys(right, fields)
		&& fields.every((field) => left[field] === right[field]);
}

function inspectAssertionSummary(assertions) {
	const blockers = [];
	if (!exactKeys(assertions, ['expected', 'executed', 'passed', 'failed', 'unresolved'])) {
		blockers.push({ code: 'assertion-summary-invalid', message: 'assertion summary has an invalid shape' });
		return blockers;
	}
	for (const key of ['expected', 'executed', 'passed', 'failed', 'unresolved']) {
		if (!Number.isSafeInteger(assertions[key]) || assertions[key] < 0) {
			blockers.push({ code: 'assertion-count-invalid', field: key, message: `${key} must be a non-negative safe integer` });
		}
	}
	return blockers;
}

// Preview/build evidence is T14-owned and intentionally internal. It is not a new stable schema.
// The caller must supply the exact JSON bytes and a T01 sbf.artifact-ref/1 for those bytes.
// Plain JavaScript objects are no longer accepted as evidence.
export function validateBoundCertificationEvidence({
	expectedKind,
	revision,
	providerId,
	combinationId,
	profileId,
	evidence,
}) {
	const blockers = [];
	if (!evidence || typeof evidence !== 'object') {
		return { ok: false, blockers: [{ code: 'evidence-envelope-missing', message: 'bound evidence envelope is required' }] };
	}
	const artifact = inspectArtifactRef(evidence.bytes, evidence.artifactRef);
	blockers.push(...artifact.blockers);
	const doc = artifact.raw ? parseJson(artifact.raw) : null;
	if (!doc) {
		blockers.push({ code: 'evidence-json-invalid', message: 'evidence artifact must be one JSON document' });
		return { ok: false, blockers };
	}
	if (!exactKeys(doc, ['evidence', 'kind', 'revision', 'status', 'provider_id', 'combination_id', 'profile_id', 'execution_ref', 'assertions'])) {
		blockers.push({ code: 'evidence-shape-invalid', message: 'evidence artifact contains missing or unexpected fields' });
	}
	if (doc.evidence !== INTERNAL_EVIDENCE) blockers.push({ code: 'evidence-contract-invalid', message: 'unsupported T14 evidence contract' });
	if (doc.kind !== expectedKind) blockers.push({ code: 'evidence-kind-mismatch', message: `expected ${expectedKind}, got ${String(doc.kind)}` });
	if (!GIT_SHA_RE.test(doc.revision ?? '') || doc.revision !== revision) blockers.push({ code: 'evidence-revision-mismatch', message: 'evidence is not bound to the exact code revision' });
	if (doc.status !== 'success') blockers.push({ code: 'evidence-status-failed', message: 'evidence did not report success' });
	if (doc.provider_id !== providerId) blockers.push({ code: 'evidence-provider-mismatch', message: 'evidence addresses another provider' });
	if (doc.combination_id !== combinationId) blockers.push({ code: 'evidence-combination-mismatch', message: 'evidence addresses another combination' });
	if (!nonEmptyString(profileId) || doc.profile_id !== profileId) blockers.push({ code: 'evidence-profile-mismatch', message: 'evidence addresses another or missing profile' });
	if (!nonEmptyString(doc.execution_ref)) blockers.push({ code: 'evidence-execution-ref-missing', message: 'evidence has no exact execution reference' });
	if (doc.assertions !== null) blockers.push(...inspectAssertionSummary(doc.assertions));

	// Canonical internal bytes make duplicate-key/format substitutions fail closed without
	// changing the semantics of external T01/T10/T16 artifacts.
	if (artifact.ok && !canonicalJsonBytes(doc).equals(artifact.raw)) {
		blockers.push({ code: 'evidence-bytes-noncanonical', message: 'internal T14 evidence bytes are not canonical' });
	}

	return {
		ok: blockers.length === 0,
		blockers,
		accepted: blockers.length === 0 ? {
			kind: doc.kind,
			revision: doc.revision,
			providerId: doc.provider_id,
			combinationId: doc.combination_id,
			profileId: doc.profile_id,
			executionRef: doc.execution_ref,
			artifactRef: evidence.artifactRef,
		} : null,
	};
}

// T10 lookup tuple inspection. An otherwise-ready handoff is NOT certification evidence unless an
// external accepted provenance record binds the exact bytes to producer/candidate revisions,
// combination and profile. Current T10 PR #84 does not yet satisfy this boundary.
export function inspectPersistenceHandoff({ expected, handoffBytes, handoffRef, provenance }) {
	const blockers = [];
	const artifact = inspectArtifactRef(handoffBytes, handoffRef);
	blockers.push(...artifact.blockers.map((item) => ({ ...item, code: `handoff-${item.code}` })));
	const handoff = artifact.raw ? parseJson(artifact.raw) : null;
	if (!handoff) blockers.push({ code: 'handoff-json-invalid', message: 'T10 handoff is not JSON' });
	if (handoff?.contract !== 'sbf.persistence-generation-handoff/1') blockers.push({ code: 'handoff-contract-invalid', message: 'unsupported T10 handoff contract' });
	if (handoff?.status !== 'ready') blockers.push({ code: 'handoff-not-ready', message: 'T10 handoff is not ready' });
	if (!Array.isArray(handoff?.blockers)) blockers.push({ code: 'handoff-blockers-invalid', message: 'T10 handoff blockers must be an array' });
	else if (handoff.blockers.length > 0) blockers.push({ code: 'handoff-has-blockers', message: 'T10 handoff contains blockers' });
	if (!nonEmptyString(handoff?.resourceId) || !nonEmptyString(handoff?.entityId)) {
		blockers.push({ code: 'handoff-resource-binding-missing', message: 'T10 resource/entity binding is incomplete' });
	}
	if (
		handoff?.providerId !== expected?.providerId
		|| handoff?.persistenceId !== expected?.persistenceId
		|| handoff?.keyType !== expected?.keyType
	) {
		blockers.push({ code: 'handoff-combination-mismatch', message: 'T10 tuple differs from T14 approved combination' });
	}
	if (!provenance || provenance.status !== 'accepted') blockers.push({ code: 'handoff-not-approved', message: 'T10 handoff has no accepted provenance record' });
	if (!GIT_SHA_RE.test(provenance?.producerRevision ?? '')) blockers.push({ code: 'producer-revision-invalid', message: 'T10 producer revision missing or invalid' });
	if (!GIT_SHA_RE.test(expected?.candidateRevision ?? '') || provenance?.candidateRevision !== expected?.candidateRevision) {
		blockers.push({ code: 'candidate-revision-mismatch', message: 'T10 evidence addresses a different candidate revision' });
	}
	if (provenance?.combinationId !== expectedCombinationId(expected)) blockers.push({ code: 'provenance-combination-mismatch', message: 'T10 provenance addresses another combination' });
	if (!nonEmptyString(expected?.profileId) || provenance?.profileId !== expected?.profileId) blockers.push({ code: 'profile-mismatch', message: 'T10 provenance addresses another or missing target/profile identity' });
	if (!nonEmptyString(provenance?.executionRef)) blockers.push({ code: 'execution-ref-missing', message: 'T10 live verification execution reference missing' });
	if (!sameArtifactRef(provenance?.artifactRef, handoffRef)) {
		blockers.push({ code: 'provenance-artifact-mismatch', message: 'T10 provenance does not bind this exact handoff artifact' });
	}
	return { status: blockers.length === 0 ? 'eligible' : 'blocked', blockers };
}

function inspectRuntimeEvidenceArtifact({
	bytes,
	ref,
	target,
	binding,
	expectedHash,
	prefix,
}) {
	const blockers = [];
	const artifact = inspectArtifactRef(bytes, ref);
	blockers.push(...artifact.blockers.map((item) => ({ ...item, code: `${prefix}-evidence-${item.code}` })));
	const doc = artifact.raw ? parseJson(artifact.raw) : null;
	if (!doc || !isPlainObject(doc)) {
		blockers.push({ code: `${prefix}-evidence-json-invalid`, message: `${target} runtime evidence is not one JSON object` });
		return { blockers, doc: null };
	}
	const allowed = new Set(['execution_evidence', 'target', 'contract_hash', 'operations', 'exchanges', 'flow_runs', 'state_hash']);
	const required = ['execution_evidence', 'target', 'contract_hash', 'operations', 'exchanges', 'flow_runs'];
	if (Object.keys(doc).some((key) => !allowed.has(key)) || required.some((key) => !Object.prototype.hasOwnProperty.call(doc, key))) {
		blockers.push({ code: `${prefix}-evidence-shape-invalid`, message: `${target} runtime evidence contains missing or unexpected fields` });
	}
	if (doc.execution_evidence !== 'beval.execution-evidence/1') blockers.push({ code: `${prefix}-evidence-contract-invalid`, message: `${target} runtime evidence contract is invalid` });
	if (doc.target !== target) blockers.push({ code: `${prefix}-evidence-target-mismatch`, message: `${target} runtime evidence has the wrong target` });
	if (doc.contract_hash !== binding?.contract_hash) blockers.push({ code: `${prefix}-evidence-contract-mismatch`, message: `${target} runtime evidence addresses another contract` });
	if (!Array.isArray(doc.operations) || doc.operations.length === 0) blockers.push({ code: `${prefix}-evidence-operations-missing`, message: `${target} runtime evidence has no operations` });
	if (!Array.isArray(doc.exchanges) || doc.exchanges.length === 0) blockers.push({ code: `${prefix}-evidence-exchanges-missing`, message: `${target} runtime evidence has no exchanges` });
	if (!Array.isArray(doc.flow_runs) || doc.flow_runs.length === 0) blockers.push({ code: `${prefix}-evidence-flow-runs-missing`, message: `${target} runtime evidence has no flow runs` });
	if (expectedHash && t16HashJson(doc) !== expectedHash) blockers.push({ code: `${prefix}-evidence-hash-mismatch`, message: `${target} runtime evidence bytes do not match the hash bound by the evidence pair` });
	return { blockers, doc };
}

function summarizeCandidateAssertions(candidate) {
	const blockers = [];
	if (!candidate || !Array.isArray(candidate.flow_runs)) return { blockers: [{ code: 'assertions-missing', message: 'candidate runtime evidence has no flow runs' }], summary: null };
	let expected = 0;
	let passed = 0;
	let failed = 0;
	let unresolved = 0;
	for (const flow of candidate.flow_runs) {
		if (!flow || !Array.isArray(flow.assertions)) {
			blockers.push({ code: 'assertion-list-invalid', message: 'candidate flow assertions must be an array' });
			continue;
		}
		for (const assertion of flow.assertions) {
			expected += 1;
			if (assertion?.passed === true) passed += 1;
			else if (assertion?.passed === false) failed += 1;
			else unresolved += 1;
		}
	}
	const summary = { expected, executed: expected, passed, failed, unresolved };
	if (expected <= 0) blockers.push({ code: 'assertions-missing', message: 'candidate runtime evidence contains no assertions' });
	if (failed !== 0 || unresolved !== 0 || passed !== expected) blockers.push({ code: 'assertions-not-all-passed', message: 'candidate runtime evidence includes failed or unresolved assertions' });
	return { blockers, summary };
}

// This is only a structural consumer for a future accepted T16/T19 behavior handoff. It cannot
// itself produce behavior-tested certification. The current merged T16 core proves immutable
// RuntimeBinding/evidence-pair semantics but has no T19-approved HTTP behavior-success fixture.
export function inspectRuntimeBehaviorProjection({
	expected,
	bindingBytes,
	bindingRef,
	pairBytes,
	pairRef,
	oracleEvidenceBytes,
	oracleEvidenceRef,
	candidateEvidenceBytes,
	candidateEvidenceRef,
	projection,
}) {
	const blockers = [];
	const bindingArtifact = inspectArtifactRef(bindingBytes, bindingRef);
	const pairArtifact = inspectArtifactRef(pairBytes, pairRef);
	blockers.push(...bindingArtifact.blockers.map((item) => ({ ...item, code: `binding-${item.code}` })));
	blockers.push(...pairArtifact.blockers.map((item) => ({ ...item, code: `pair-${item.code}` })));
	const binding = bindingArtifact.raw ? parseJson(bindingArtifact.raw) : null;
	const pair = pairArtifact.raw ? parseJson(pairArtifact.raw) : null;

	const bindingFields = [
		'runtime_binding', 'run_id', 'case_revision_hash', 'oracle_profile_approval_hash',
		'contract_hash', 'flow_hash', 'config_hash', 'candidate_hash', 'original_hash',
		'runner_implementation_hash', 'runtime_execution_policy_hash', 'artifacts', 'attempt_nonce',
	];
	const pairFields = [
		'runtime_evidence_pair', 'family', 'runtime_binding_hash', 'attempt_nonce',
		'oracle_evidence_hash', 'candidate_evidence_hash',
	];
	if (!exactKeys(binding, bindingFields)) blockers.push({ code: 'binding-shape-invalid', message: 'RuntimeBinding contains missing or unexpected fields' });
	if (binding?.runtime_binding !== 'beval.runtime-binding/1') blockers.push({ code: 'binding-contract-invalid', message: 'unsupported RuntimeBinding' });
	if (!exactKeys(pair, pairFields)) blockers.push({ code: 'pair-shape-invalid', message: 'runtime evidence pair contains missing or unexpected fields' });
	if (pair?.runtime_evidence_pair !== 'beval.runtime-evidence-pair/1' || pair?.family !== 'http') blockers.push({ code: 'pair-contract-invalid', message: 'unsupported HTTP runtime evidence pair' });

	const bindingHash = binding ? t16HashJson(binding) : null;
	if (bindingHash && pair?.runtime_binding_hash !== bindingHash) blockers.push({ code: 'pair-binding-mismatch', message: 'evidence pair addresses another RuntimeBinding' });
	if (binding?.attempt_nonce && pair?.attempt_nonce !== binding.attempt_nonce) blockers.push({ code: 'attempt-mismatch', message: 'evidence pair addresses another attempt' });
	if (!SHA256_RE.test(binding?.candidate_hash ?? '')) blockers.push({ code: 'candidate-artifact-unbound', message: 'RuntimeBinding does not bind a candidate artifact hash' });

	const oracle = inspectRuntimeEvidenceArtifact({
		bytes: oracleEvidenceBytes,
		ref: oracleEvidenceRef,
		target: 'oracle',
		binding,
		expectedHash: pair?.oracle_evidence_hash,
		prefix: 'oracle',
	});
	const candidate = inspectRuntimeEvidenceArtifact({
		bytes: candidateEvidenceBytes,
		ref: candidateEvidenceRef,
		target: 'candidate',
		binding,
		expectedHash: pair?.candidate_evidence_hash,
		prefix: 'candidate',
	});
	blockers.push(...oracle.blockers, ...candidate.blockers);

	const actualAssertions = summarizeCandidateAssertions(candidate.doc);
	blockers.push(...actualAssertions.blockers);
	if (candidate.doc?.exchanges?.some((exchange) => ['invalid', 'error'].includes(exchange?.schema_verdict))) {
		blockers.push({ code: 'candidate-exchange-invalid', message: 'candidate runtime evidence contains invalid/error schema verdicts' });
	}

	if (!projection || !isPlainObject(projection)) {
		blockers.push({ code: 'runtime-handoff-missing', message: 'verifier-produced runtime behavior projection is missing' });
		return { status: 'blocked', blockers, bindingHash };
	}
	if (projection.runtimeBindingHash !== bindingHash) blockers.push({ code: 'projection-binding-mismatch', message: 'runtime projection does not address exact RuntimeBinding' });
	if (projection.runtimeBindingArtifactSha256 !== bindingRef?.byte_sha256) blockers.push({ code: 'projection-binding-artifact-mismatch', message: 'runtime projection does not bind the exact RuntimeBinding artifact bytes' });
	if (projection.evidencePairArtifactSha256 !== pairRef?.byte_sha256) blockers.push({ code: 'projection-pair-mismatch', message: 'runtime projection does not address exact evidence-pair artifact' });
	if (projection.oracleEvidenceArtifactSha256 !== oracleEvidenceRef?.byte_sha256) blockers.push({ code: 'projection-oracle-evidence-mismatch', message: 'runtime projection does not bind exact oracle evidence bytes' });
	if (projection.candidateEvidenceArtifactSha256 !== candidateEvidenceRef?.byte_sha256) blockers.push({ code: 'projection-candidate-evidence-mismatch', message: 'runtime projection does not bind exact candidate evidence bytes' });
	if (projection.candidateArtifactSha256 !== binding?.candidate_hash) blockers.push({ code: 'candidate-artifact-mismatch', message: 'runtime projection does not address the bound candidate artifact' });
	if (!GIT_SHA_RE.test(expected?.candidateRevision ?? '') || projection.candidateRevision !== expected?.candidateRevision) blockers.push({ code: 'candidate-revision-mismatch', message: 'runtime result addresses another code revision' });
	if (projection.combinationId !== expectedCombinationId(expected)) blockers.push({ code: 'runtime-combination-mismatch', message: 'runtime result addresses another composition' });
	if (!nonEmptyString(expected?.profileId) || projection.profileId !== expected?.profileId || projection.profileApprovalHash !== binding?.oracle_profile_approval_hash) blockers.push({ code: 'profile-mismatch', message: 'runtime result addresses another profile or approval' });
	if (projection.runId !== binding?.run_id) blockers.push({ code: 'run-id-mismatch', message: 'runtime result addresses another run' });
	if (projection.attemptNonce !== binding?.attempt_nonce) blockers.push({ code: 'projection-attempt-mismatch', message: 'runtime result addresses another attempt' });
	if (!nonEmptyString(projection.executionRef)) blockers.push({ code: 'execution-ref-missing', message: 'runtime verifier execution reference missing' });
	if (projection.verdict !== 'success') blockers.push({ code: 'runtime-failed', message: 'runtime verifier did not report success' });
	if (projection.producerApproval !== 'accepted') blockers.push({ code: 'runtime-handoff-not-approved', message: 'runtime projection is not from an accepted verifier handoff' });

	const assertionBlockers = inspectAssertionSummary(projection.assertions);
	blockers.push(...assertionBlockers);
	if (assertionBlockers.length === 0) {
		const a = projection.assertions;
		if (a.expected <= 0) blockers.push({ code: 'assertions-missing', message: 'runtime verifier has no positive expected assertion count' });
		if (a.executed !== a.expected) blockers.push({ code: 'assertions-incomplete', message: 'not all expected assertions executed' });
		if (a.failed !== 0 || a.unresolved !== 0 || a.passed !== a.expected) {
			blockers.push({ code: 'assertions-not-all-passed', message: 'runtime assertions are failed, unresolved, or incomplete' });
		}
		if (actualAssertions.summary && Object.keys(a).some((key) => a[key] !== actualAssertions.summary[key])) {
			blockers.push({ code: 'assertion-summary-mismatch', message: 'runtime projection assertion summary does not match exact candidate evidence' });
		}
	}

	return { status: blockers.length === 0 ? 'eligible' : 'blocked', blockers, bindingHash };
}
