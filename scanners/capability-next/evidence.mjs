import crypto from 'node:crypto';

export const T01_ARTIFACT_REF_VERSION = 'sbf.artifact-ref/1';
export const T01_ARTIFACT_REF_SCHEMA_BLOB = 'd69366533844c4d002de8746140776edfdccbb25';
export const T16_RUNTIME_BINDING_VERSION = 'beval.runtime-binding/1';
export const T16_RUNTIME_EVIDENCE_PAIR_VERSION = 'beval.runtime-evidence-pair/1';

export const REVIEWED_T01_ARTIFACT_REF_SCHEMA = Object.freeze({
	artifact_ref: T01_ARTIFACT_REF_VERSION,
	family: 't01-artifact-ref-schema',
	version: '1',
	media_type: 'application/schema+json',
	byte_sha256: '9c23e23d76937476752b3a3ddc72ee0b0ce24c23ff4b00cf6f18f174400ac8bd',
	size_bytes: 880,
});

export const REVIEWED_T16_RUNTIME_BINDING_SOURCE = Object.freeze({
	artifact_ref: T01_ARTIFACT_REF_VERSION,
	family: 't16-runtime-binding-source',
	version: T16_RUNTIME_BINDING_VERSION,
	media_type: 'text/javascript',
	byte_sha256: '97222d92b6b3450b0c2729aa2b38d27670c4d5e37e0e9d9c693616d02d4ad2ec',
	size_bytes: 5063,
});

export const REVIEWED_T19_RUNTIME_CORE_REVIEW = Object.freeze({
	artifact_ref: T01_ARTIFACT_REF_VERSION,
	family: 't19-runtime-core-review',
	version: '1',
	media_type: 'text/markdown',
	byte_sha256: '4d7fd6d5e234282715f35e01f0da2760ea3c1be28cdeb4dd78caf4feaf2d998f',
	size_bytes: 3270,
});

const SHA256_RE = /^[a-f0-9]{64}$/;
const FAMILY_RE = /^[a-z][a-z0-9.-]*$/;
const MEDIA_TYPE_RE = /^[^\s/]+\/[^\s]+$/;
const EVIDENCE_RECEIPT = Symbol('t03.verified-artifact-evidence');
const EVIDENCE_AUTHORITY = Symbol('t03.evidence-authority');

function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected, label) {
	if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
		throw new TypeError(`${label} must contain exactly: ${wanted.join(', ')}`);
	}
}

function nonEmpty(value, label) {
	if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

function artifactBytes(bytes) {
	if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
	if (Buffer.isBuffer(bytes)) return bytes;
	if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	throw new TypeError('artifact bytes must be a UTF-8 string, Buffer, or Uint8Array');
}

function exactArtifactRefMatch(actual, expected, label) {
	const normalized = assertArtifactRef(actual);
	const expectedNormalized = assertArtifactRef(expected);
	if (artifactRefKey(normalized) !== artifactRefKey(expectedNormalized)) {
		throw new TypeError(`${label} does not match the reviewed exact ArtifactRef`);
	}
	return normalized;
}

function authority({ capabilities = {}, certifications = [] } = {}) {
	const capabilityEntries = Object.entries(capabilities).map(([name, statuses]) => {
		if (!Array.isArray(statuses) || statuses.length === 0) throw new TypeError(`authority capability ${name} must have statuses`);
		return [name, Object.freeze([...statuses])];
	});
	return Object.freeze({
		capabilities: Object.freeze(Object.fromEntries(capabilityEntries)),
		certifications: Object.freeze([...certifications]),
	});
}

function artifactReceipt(ref, auth = authority()) {
	return Object.freeze({
		ref,
		[EVIDENCE_RECEIPT]: true,
		[EVIDENCE_AUTHORITY]: auth,
	});
}

export function assertArtifactRef(ref) {
	exactKeys(ref, ['artifact_ref', 'family', 'version', 'media_type', 'byte_sha256', 'size_bytes'], 'ArtifactRef');
	if (ref.artifact_ref !== T01_ARTIFACT_REF_VERSION) throw new TypeError(`unsupported artifact_ref: ${String(ref.artifact_ref)}`);
	if (typeof ref.family !== 'string' || !FAMILY_RE.test(ref.family)) throw new TypeError('ArtifactRef.family is invalid');
	nonEmpty(ref.version, 'ArtifactRef.version');
	if (typeof ref.media_type !== 'string' || !MEDIA_TYPE_RE.test(ref.media_type)) throw new TypeError('ArtifactRef.media_type is invalid');
	if (typeof ref.byte_sha256 !== 'string' || !SHA256_RE.test(ref.byte_sha256)) throw new TypeError('ArtifactRef.byte_sha256 is invalid');
	if (!Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 0) throw new TypeError('ArtifactRef.size_bytes must be a non-negative safe integer');
	return Object.freeze({
		artifact_ref: ref.artifact_ref,
		family: ref.family,
		version: ref.version,
		media_type: ref.media_type,
		byte_sha256: ref.byte_sha256,
		size_bytes: ref.size_bytes,
	});
}

export function artifactRefKey(ref) {
	const normalized = assertArtifactRef(ref);
	return [
		normalized.artifact_ref,
		normalized.family,
		normalized.version,
		normalized.media_type,
		normalized.byte_sha256,
		String(normalized.size_bytes),
	].join('\u0000');
}

export function artifactRefMatchesBytes(ref, bytes) {
	const normalized = assertArtifactRef(ref);
	const raw = artifactBytes(bytes);
	const digest = crypto.createHash('sha256').update(raw).digest('hex');
	return raw.byteLength === normalized.size_bytes && digest === normalized.byte_sha256;
}

export function assertArtifactRefMatchesBytes(ref, bytes) {
	if (!artifactRefMatchesBytes(ref, bytes)) throw new TypeError('artifact bytes do not match T01 ArtifactRef');
	return assertArtifactRef(ref);
}

// Identity-only receipt. Exact bytes are verified, but no semantic capability/certification authority
// is granted. Callers cannot turn this receipt into supported state by choosing a capability name.
export function verifyArtifactEvidence({ ref, bytes, expectedFamily = null, expectedVersion = null } = {}) {
	const normalized = assertArtifactRefMatchesBytes(ref, bytes);
	if (expectedFamily !== null && normalized.family !== expectedFamily) {
		throw new TypeError(`ArtifactRef.family ${normalized.family} does not match expected family ${expectedFamily}`);
	}
	if (expectedVersion !== null && normalized.version !== expectedVersion) {
		throw new TypeError(`ArtifactRef.version ${normalized.version} does not match expected version ${expectedVersion}`);
	}
	return artifactReceipt(normalized);
}

// Reviewed T01 schema proves only the exact ArtifactRef contract itself.
export function verifyT01ArtifactRefSchemaEvidence({ ref, bytes } = {}) {
	const normalized = exactArtifactRefMatch(ref, REVIEWED_T01_ARTIFACT_REF_SCHEMA, 'T01 ArtifactRef schema');
	assertArtifactRefMatchesBytes(normalized, bytes);
	return artifactReceipt(normalized, authority({
		capabilities: {
			'identity.artifact-ref': ['supported'],
		},
	}));
}

// Reviewed T19 artifact proves only that the T16 immutable runtime core passed independent review;
// it explicitly does not prove any runtime-tested capability.
export function verifyT19RuntimeCoreReviewEvidence({ ref, bytes } = {}) {
	const normalized = exactArtifactRefMatch(ref, REVIEWED_T19_RUNTIME_CORE_REVIEW, 'T19 runtime-core review');
	assertArtifactRefMatchesBytes(normalized, bytes);
	const reviewText = artifactBytes(bytes).toString('utf8');
	if (!reviewText.includes('PASS for immutable binding / process-policy core only')) {
		throw new TypeError('T19 core review text is not the reviewed runtime-core artifact');
	}
	if (!reviewText.includes('any capability as `runtime-tested`')) {
		throw new TypeError('T19 core review does not carry the expected runtime-tested non-claim');
	}
	return artifactReceipt(normalized, authority({
		capabilities: {
			'runtime.certification': ['partial'],
		},
	}));
}

function assertEvidenceReceipt(receipt, label) {
	if (!receipt || typeof receipt !== 'object' || receipt[EVIDENCE_RECEIPT] !== true) {
		throw new TypeError(`${label} must be produced by a T03 evidence verifier from T01 ArtifactRef + matching bytes`);
	}
	return receipt;
}

export function normalizeEvidenceReceipts(value = [], label = 'evidence') {
	if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of verified evidence receipts`);
	const receipts = value.map((receipt, index) => assertEvidenceReceipt(receipt, `${label}[${index}]`));
	const refs = receipts.map((receipt) => receipt.ref);
	const keys = refs.map(artifactRefKey);
	if (new Set(keys).size !== keys.length) throw new TypeError(`${label} must not contain duplicate ArtifactRefs`);
	refs.sort((a, b) => {
		const ak = artifactRefKey(a);
		const bk = artifactRefKey(b);
		return ak < bk ? -1 : ak > bk ? 1 : 0;
	});
	return Object.freeze(refs);
}

export function normalizeCapabilityEvidenceReceipts(value = [], { capability, status } = {}) {
	nonEmpty(capability, 'capability');
	nonEmpty(status, 'status');
	if (!Array.isArray(value)) throw new TypeError('evidence must be an array of verified capability evidence receipts');
	const receipts = value.map((receipt, index) => assertEvidenceReceipt(receipt, `evidence[${index}]`));
	for (const [index, receipt] of receipts.entries()) {
		const allowed = receipt[EVIDENCE_AUTHORITY]?.capabilities?.[capability] ?? [];
		if (!allowed.includes(status)) {
			throw new TypeError(`evidence[${index}] exact bytes do not authorize capability ${capability} status ${status}`);
		}
	}
	return normalizeEvidenceReceipts(receipts);
}

export function normalizeCertificationEvidenceReceipts(value = [], {
	targetId,
	level,
	profile = null,
	codegen = 'none',
} = {}) {
	nonEmpty(targetId, 'targetId');
	nonEmpty(level, 'level');
	nonEmpty(codegen, 'codegen');
	if (!Array.isArray(value)) throw new TypeError('evidence must be an array of independently reviewed certification evidence receipts');
	const receipts = value.map((receipt, index) => assertEvidenceReceipt(receipt, `evidence[${index}]`));
	for (const [index, receipt] of receipts.entries()) {
		const grants = receipt[EVIDENCE_AUTHORITY]?.certifications ?? [];
		const matched = grants.some((grant) => grant
			&& grant.targetId === targetId
			&& grant.level === level
			&& grant.codegen === codegen
			&& (grant.profile ?? null) === (profile ?? null));
		if (!matched) {
			throw new TypeError(`evidence[${index}] does not carry independent certification authority for ${targetId}/${level}/${codegen}/${profile ?? '-'}`);
		}
	}
	return normalizeEvidenceReceipts(receipts);
}

export function runtimeCertificationBlockedReason() {
	return 'runtime-tested requires exact T16 runtime-execution evidence plus independent T19 acceptance for the same target/profile/combination; the current T19 PASS is runtime-core-only and explicitly does not certify any capability as runtime-tested';
}

export function assertCurrentRuntimeCoreReviewIsNotCertification({
	runtimeBindingImplementationRef,
	runtimeBindingImplementationBytes,
	t19ReviewRef,
	t19ReviewBytes,
} = {}) {
	const runtimeRef = exactArtifactRefMatch(
		runtimeBindingImplementationRef,
		REVIEWED_T16_RUNTIME_BINDING_SOURCE,
		'T16 runtime-binding source',
	);
	assertArtifactRefMatchesBytes(runtimeRef, runtimeBindingImplementationBytes);
	verifyT19RuntimeCoreReviewEvidence({ ref: t19ReviewRef, bytes: t19ReviewBytes });
	return Object.freeze({
		eligible: false,
		status: 'blocked',
		code: 'RUNTIME_CERTIFICATION_NOT_REVIEWED',
		reason: runtimeCertificationBlockedReason(),
	});
}
