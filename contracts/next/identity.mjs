import crypto from 'node:crypto';

export const BINDING_JSON_DOMAIN = 'beval.binding-json/1';
export const ARTIFACT_REF_VERSION = 'sbf.artifact-ref/1';
export const IDENTITY_ENVELOPE_VERSION = 'sbf.identity-envelope/1';

const SHA256_RE = /^[a-f0-9]{64}$/;
const FEATURE_ID_RE = /^[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_POINTER_RE = /^(?:|\/.*)$/;
const MEDIA_TYPE_RE = /^[^\s/]+\/[^\s]+$/;
const FAMILY_RE = /^[a-z][a-z0-9.-]*$/;

function fail(message) {
	throw new TypeError(message);
}

function isPlainObject(value) {
	return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, required, label) {
	if (!isPlainObject(value)) fail(`${label} must be a plain JSON object`);
	const actual = Object.keys(value).sort();
	const expected = [...required].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		fail(`${label} must contain exactly: ${expected.join(', ')}`);
	}
}

function jsonCopy(value, seen = new Set()) {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) fail('identity JSON numbers must be finite');
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length !== Object.keys(value).length) fail('identity JSON arrays must not be sparse');
		return value.map((item) => jsonCopy(item, seen));
	}
	if (!isPlainObject(value)) fail('identity JSON accepts only plain JSON objects');
	if (seen.has(value)) fail('identity JSON must not contain cycles');
	seen.add(value);
	const result = {};
	for (const key of Object.keys(value)) result[key] = jsonCopy(value[key], seen);
	seen.delete(value);
	return result;
}

function canonical(value, seen = new Set()) {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) fail('binding JSON numbers must be finite');
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length !== Object.keys(value).length) fail('binding JSON arrays must not be sparse');
		return value.map((item) => canonical(item, seen));
	}
	if (!isPlainObject(value)) fail('binding JSON accepts only plain JSON objects');
	if (seen.has(value)) fail('binding JSON must not contain cycles');
	seen.add(value);
	const result = Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], seen)]));
	seen.delete(value);
	return result;
}

function toBytes(bytes) {
	if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
	if (Buffer.isBuffer(bytes)) return bytes;
	if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	fail('artifact bytes must be a UTF-8 string, Buffer, or Uint8Array');
}

function requireString(value, label) {
	if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
	return value;
}

export function bindingJson(value) {
	return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

export function bindingDigest(kind, value) {
	requireString(kind, 'binding kind');
	return crypto.createHash('sha256').update(`${BINDING_JSON_DOMAIN}\n${kind}\n${bindingJson(value)}`, 'utf8').digest('hex');
}

export function sha256Bytes(bytes) {
	return crypto.createHash('sha256').update(toBytes(bytes)).digest('hex');
}

export function createArtifactRef(bytes, { family, version, media_type = 'application/json' } = {}) {
	const raw = toBytes(bytes);
	requireString(family, 'artifact family');
	requireString(version, 'artifact version');
	requireString(media_type, 'artifact media_type');
	if (!FAMILY_RE.test(family)) fail('artifact family must be a lowercase stable identifier');
	if (!MEDIA_TYPE_RE.test(media_type)) fail('artifact media_type must be a media type');
	return {
		artifact_ref: ARTIFACT_REF_VERSION,
		family,
		version,
		media_type,
		byte_sha256: sha256Bytes(raw),
		size_bytes: raw.byteLength,
	};
}

export function assertArtifactRef(ref) {
	exactKeys(ref, ['artifact_ref', 'family', 'version', 'media_type', 'byte_sha256', 'size_bytes'], 'ArtifactRef');
	if (ref.artifact_ref !== ARTIFACT_REF_VERSION) fail(`unsupported artifact_ref: ${String(ref.artifact_ref)}`);
	if (typeof ref.family !== 'string' || !FAMILY_RE.test(ref.family)) fail('ArtifactRef.family is invalid');
	requireString(ref.version, 'ArtifactRef.version');
	if (typeof ref.media_type !== 'string' || !MEDIA_TYPE_RE.test(ref.media_type)) fail('ArtifactRef.media_type is invalid');
	if (typeof ref.byte_sha256 !== 'string' || !SHA256_RE.test(ref.byte_sha256)) fail('ArtifactRef.byte_sha256 is invalid');
	if (!Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 0) fail('ArtifactRef.size_bytes must be a non-negative safe integer');
	return ref;
}

export function artifactRefMatches(bytes, ref) {
	assertArtifactRef(ref);
	const raw = toBytes(bytes);
	return raw.byteLength === ref.size_bytes && sha256Bytes(raw) === ref.byte_sha256;
}

export function assertArtifactRefMatches(bytes, ref) {
	if (!artifactRefMatches(bytes, ref)) fail('artifact bytes do not match ArtifactRef');
	return ref;
}

function assertContractRef(ref) {
	exactKeys(ref, ['contract_ref', 'contract_hash', 'sbf_contract', 'feature_id', 'feature_uid'], 'ContractRef');
	if (ref.contract_ref !== 'sbf.contract-ref/1') fail(`unsupported contract_ref: ${String(ref.contract_ref)}`);
	if (typeof ref.contract_hash !== 'string' || !SHA256_RE.test(ref.contract_hash)) fail('ContractRef.contract_hash is invalid');
	if (typeof ref.sbf_contract !== 'string' || !/^[0-9]+$/.test(ref.sbf_contract)) fail('ContractRef.sbf_contract is invalid');
	if (typeof ref.feature_id !== 'string' || !FEATURE_ID_RE.test(ref.feature_id)) fail('ContractRef.feature_id is invalid');
	if (typeof ref.feature_uid !== 'string' || !UUID_RE.test(ref.feature_uid)) fail('ContractRef.feature_uid is invalid');
	return 'contract';
}

function assertActionRef(ref) {
	exactKeys(ref, ['action_ref', 'contract', 'operation_id'], 'ActionRef');
	if (ref.action_ref !== 'sbf.action-ref/1') fail(`unsupported action_ref: ${String(ref.action_ref)}`);
	assertContractRef(ref.contract);
	requireString(ref.operation_id, 'ActionRef.operation_id');
	return 'action';
}

function assertFieldRef(ref) {
	exactKeys(ref, ['field_ref', 'action', 'location', 'pointer'], 'FieldRef');
	if (ref.field_ref !== 'sbf.field-ref/1') fail(`unsupported field_ref: ${String(ref.field_ref)}`);
	assertActionRef(ref.action);
	if (!['path', 'query', 'header', 'cookie', 'body'].includes(ref.location)) fail('FieldRef.location is invalid');
	if (typeof ref.pointer !== 'string' || !JSON_POINTER_RE.test(ref.pointer)) fail('FieldRef.pointer is invalid');
	return 'field';
}

export function assertLegacyIdentityRef(ref) {
	if (!isPlainObject(ref)) fail('identity reference must be a plain JSON object');
	if (Object.prototype.hasOwnProperty.call(ref, 'contract_ref')) return assertContractRef(ref);
	if (Object.prototype.hasOwnProperty.call(ref, 'action_ref')) return assertActionRef(ref);
	if (Object.prototype.hasOwnProperty.call(ref, 'field_ref')) return assertFieldRef(ref);
	fail('unsupported legacy identity reference');
}

export function wrapLegacyIdentity(reference, { family = 'http' } = {}) {
	const reference_kind = assertLegacyIdentityRef(reference);
	if (family !== 'http') fail('sbf.identity-envelope/1 currently permits legacy ContractRef identities only in family=http');
	return {
		identity_envelope: IDENTITY_ENVELOPE_VERSION,
		family,
		reference_kind,
		reference: jsonCopy(reference),
	};
}

export function assertIdentityEnvelope(envelope) {
	exactKeys(envelope, ['identity_envelope', 'family', 'reference_kind', 'reference'], 'IdentityEnvelope');
	if (envelope.identity_envelope !== IDENTITY_ENVELOPE_VERSION) fail(`unsupported identity_envelope: ${String(envelope.identity_envelope)}`);
	if (envelope.family !== 'http') fail('sbf.identity-envelope/1 currently supports family=http only');
	if (!['contract', 'action', 'field'].includes(envelope.reference_kind)) fail('IdentityEnvelope.reference_kind is invalid');
	const actualKind = assertLegacyIdentityRef(envelope.reference);
	if (actualKind !== envelope.reference_kind) fail(`IdentityEnvelope.reference_kind=${envelope.reference_kind} does not match ${actualKind} reference`);
	return envelope;
}

export function readIdentity(value) {
	if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'identity_envelope')) {
		assertIdentityEnvelope(value);
		return {
			reader: IDENTITY_ENVELOPE_VERSION,
			family: value.family,
			reference_kind: value.reference_kind,
			reference: value.reference,
		};
	}
	const reference_kind = assertLegacyIdentityRef(value);
	return {
		reader: 'legacy-identity/1',
		family: 'http',
		reference_kind,
		reference: value,
	};
}
