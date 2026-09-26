import crypto from 'node:crypto';

export const T01_ARTIFACT_REF_VERSION = 'sbf.artifact-ref/1';
export const T01_ARTIFACT_REF_SCHEMA_BLOB = 'd69366533844c4d002de8746140776edfdccbb25';
export const T16_RUNTIME_BINDING_VERSION = 'beval.runtime-binding/1';
export const T16_RUNTIME_EVIDENCE_PAIR_VERSION = 'beval.runtime-evidence-pair/1';

const SHA256_RE = /^[a-f0-9]{64}$/;
const FAMILY_RE = /^[a-z][a-z0-9.-]*$/;
const MEDIA_TYPE_RE = /^[^\s/]+\/[^\s]+$/;
const EVIDENCE_RECEIPT = Symbol('t03.verified-artifact-evidence');

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

export function verifyArtifactEvidence({ ref, bytes, expectedFamily = null, expectedVersion = null } = {}) {
	const normalized = assertArtifactRefMatchesBytes(ref, bytes);
	if (expectedFamily !== null && normalized.family !== expectedFamily) {
		throw new TypeError(`ArtifactRef.family ${normalized.family} does not match expected family ${expectedFamily}`);
	}
	if (expectedVersion !== null && normalized.version !== expectedVersion) {
		throw new TypeError(`ArtifactRef.version ${normalized.version} does not match expected version ${expectedVersion}`);
	}
	const receipt = {
		ref: normalized,
		[EVIDENCE_RECEIPT]: true,
	};
	return Object.freeze(receipt);
}

function assertEvidenceReceipt(receipt, label) {
	if (!receipt || typeof receipt !== 'object' || receipt[EVIDENCE_RECEIPT] !== true) {
		throw new TypeError(`${label} must be produced by verifyArtifactEvidence() from T01 ArtifactRef + matching bytes`);
	}
	return receipt;
}

export function normalizeEvidenceReceipts(value = [], label = 'evidence') {
	if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of verified evidence receipts`);
	const receipts = value.map((receipt, index) => assertEvidenceReceipt(receipt, `${label}[${index}]`));
	const refs = receipts.map((receipt) => receipt.ref);
	const keys = refs.map(artifactRefKey);
	if (new Set(keys).size !== keys.length) throw new TypeError(`${label} must not contain duplicate ArtifactRefs`);
	return Object.freeze(refs.sort((a, b) => artifactRefKey(a).localeCompare(artifactRefKey(b))));
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
	assertArtifactRefMatchesBytes(runtimeBindingImplementationRef, runtimeBindingImplementationBytes);
	assertArtifactRefMatchesBytes(t19ReviewRef, t19ReviewBytes);
	const reviewText = artifactBytes(t19ReviewBytes).toString('utf8');
	if (!reviewText.includes('PASS for immutable binding / process-policy core only')) {
		throw new TypeError('T19 core review text is not the reviewed runtime-core artifact');
	}
	if (!reviewText.includes('any capability as `runtime-tested`')) {
		throw new TypeError('T19 core review does not carry the expected runtime-tested non-claim');
	}
	return Object.freeze({
		eligible: false,
		status: 'blocked',
		code: 'RUNTIME_CERTIFICATION_NOT_REVIEWED',
		reason: runtimeCertificationBlockedReason(),
	});
}
