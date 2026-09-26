import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
	ARTIFACT_REF_VERSION,
	BINDING_JSON_DOMAIN,
	IDENTITY_ENVELOPE_VERSION,
	artifactRefMatches,
	assertArtifactRefMatches,
	assertIdentityEnvelope,
	bindingDigest,
	bindingJson,
	createArtifactRef,
	readIdentity,
	wrapLegacyIdentity,
} from '../../contracts/next/identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LEGACY_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'contract-identity.schema.json'), 'utf8'));
const LEGACY_GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'contract-identity.golden.json'), 'utf8'));
const ARTIFACT_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'next', 'artifact-ref.schema.json'), 'utf8'));
const ENVELOPE_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'next', 'identity-envelope.schema.json'), 'utf8'));
const NEXT_GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'next', 'identity.golden.json'), 'utf8'));

function validators() {
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	addFormats(ajv);
	ajv.addSchema(LEGACY_SCHEMA);
	return {
		artifact: ajv.compile(ARTIFACT_SCHEMA),
		envelope: ajv.compile(ENVELOPE_SCHEMA),
	};
}

test('production binding serializer reproduces every legacy golden digest byte-for-byte', () => {
	assert.equal(BINDING_JSON_DOMAIN, LEGACY_GOLDEN.binding_json);
	for (const vector of LEGACY_GOLDEN.vectors) {
		assert.equal(bindingDigest(vector.kind, vector.value), vector.digest, vector.name);
	}
	const unicode = LEGACY_GOLDEN.unicode_non_normalization;
	assert.equal(bindingDigest(unicode.kind, unicode.precomposed.value), unicode.precomposed.digest);
	assert.equal(bindingDigest(unicode.kind, unicode.decomposed.value), unicode.decomposed.digest);
	assert.notEqual(unicode.precomposed.digest, unicode.decomposed.digest);
});

test('binding serializer preserves the established two-space/LF framing and rejects non-JSON values', () => {
	assert.match(bindingJson(LEGACY_GOLDEN.vectors[0].value), /^\{\n  "contract_hash"/);
	assert.match(bindingJson(LEGACY_GOLDEN.vectors[0].value), /\n$/);
	assert.throws(() => bindingJson({ x: undefined }), /plain JSON|JSON/);
	assert.throws(() => bindingJson({ x: Number.NaN }), /finite/);
	assert.throws(() => bindingJson(new Date()), /plain JSON/);
	const sparse = [];
	sparse[1] = 'x';
	assert.throws(() => bindingJson(sparse), /sparse/);
});

test('artifact refs bind exact bytes so formatting-only changes remain different artifacts', () => {
	const { artifact: validateArtifact } = validators();
	for (const vector of NEXT_GOLDEN.artifact_vectors) {
		const actual = createArtifactRef(vector.utf8, { family: 'http-contract', version: '9' });
		assert.deepEqual(actual, vector.ref, vector.name);
		assert.equal(validateArtifact(actual), true, JSON.stringify(validateArtifact.errors));
		assert.equal(artifactRefMatches(vector.utf8, actual), true);
	}
	const [compact, pretty] = NEXT_GOLDEN.artifact_vectors;
	assert.notEqual(compact.ref.byte_sha256, pretty.ref.byte_sha256);
	assert.throws(() => assertArtifactRefMatches(pretty.utf8, compact.ref), /do not match/);
});

test('identity envelope wraps existing refs without repairing or renaming them', () => {
	const legacyAction = LEGACY_GOLDEN.vectors.find((vector) => vector.name === 'action-ref').value;
	const wrapped = wrapLegacyIdentity(legacyAction);
	assert.equal(wrapped.identity_envelope, IDENTITY_ENVELOPE_VERSION);
	assert.equal(wrapped.reference_kind, 'action');
	assert.deepEqual(wrapped.reference, legacyAction);
	assert.notEqual(wrapped.reference, legacyAction);
	assert.equal(readIdentity(legacyAction).reference, legacyAction);
	assert.equal(readIdentity(wrapped).reference, wrapped.reference);
});

test('identity envelope schema and production validator agree on the golden vector', () => {
	const { envelope: validateEnvelope } = validators();
	for (const vector of NEXT_GOLDEN.envelope_vectors) {
		assert.equal(validateEnvelope(vector.value), true, `${vector.name}: ${JSON.stringify(validateEnvelope.errors)}`);
		assert.doesNotThrow(() => assertIdentityEnvelope(vector.value));
		assert.equal(bindingDigest(vector.kind, vector.value), vector.digest, vector.name);
	}
});

test('production reader accepts the same UUID form as the legacy schema', () => {
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	addFormats(ajv);
	const validateLegacy = ajv.compile(LEGACY_SCHEMA);
	const base = LEGACY_GOLDEN.vectors.find((vector) => vector.name === 'contract-ref').value;
	const urnUuid = { ...base, feature_uid: `urn:uuid:${base.feature_uid}` };
	assert.equal(validateLegacy(urnUuid), true, JSON.stringify(validateLegacy.errors));
	assert.doesNotThrow(() => readIdentity(urnUuid));
});

test('identity envelope fails closed on mismatched kinds, unsupported families, extra fields and version changes', () => {
	const action = LEGACY_GOLDEN.vectors.find((vector) => vector.name === 'action-ref').value;
	const good = wrapLegacyIdentity(action);
	assert.throws(() => assertIdentityEnvelope({ ...good, reference_kind: 'field' }), /does not match/);
	assert.throws(() => wrapLegacyIdentity(action, { family: 'game' }), /family=http/);
	assert.throws(() => assertIdentityEnvelope({ ...good, label: 'display only' }), /exactly/);
	assert.throws(() => readIdentity({ ...good, identity_envelope: 'sbf.identity-envelope/2' }), /unsupported/);
});

test('legacy identity reader rejects invalid IDs and never repairs valid-but-different operation IDs', () => {
	const action = LEGACY_GOLDEN.vectors.find((vector) => vector.name === 'action-ref').value;
	assert.throws(() => readIdentity({ ...action, operation_id: '' }), /non-empty/);
	const prefixed = { ...action, operation_id: `001-hello:${action.operation_id}` };
	assert.equal(readIdentity(prefixed).reference.operation_id, '001-hello:getHello');
	assert.notEqual(readIdentity(prefixed).reference.operation_id, action.operation_id);
});

test('artifact ref public version is pinned independently of existing contract-ref versions', () => {
	assert.equal(ARTIFACT_REF_VERSION, 'sbf.artifact-ref/1');
	const ref = createArtifactRef(Buffer.from('abc'), { family: 'test', version: '1', media_type: 'application/octet-stream' });
	assert.equal(ref.byte_sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	assert.equal(ref.size_bytes, 3);
});
