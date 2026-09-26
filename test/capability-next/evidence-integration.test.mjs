import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	CAPABILITY_STATUSES,
	assertArtifactRefMatchesBytes,
	assertCurrentRuntimeCoreReviewIsNotCertification,
	capabilityRecord,
	certificationRecord,
	evaluateCapabilityPolicy,
	externalCapabilityFromLegacySatisfier,
	verifyArtifactEvidence,
} from '../../scanners/capability-next/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(fs.readFileSync(path.join(HERE, 'fixture-source-snapshot.json'), 'utf8'));
const statusFixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixture-status-diagnostics.json'), 'utf8'));
const t01Bytes = fs.readFileSync(path.join(HERE, 'fixture-t01-artifact-ref.schema.json'));
const t16Bytes = fs.readFileSync(path.join(HERE, 'fixture-t16-runtime-binding.mjs.txt'));
const t19Bytes = fs.readFileSync(path.join(HERE, 'fixture-t19-runtime-core-review.md'));

function sha256(bytes) {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

function t01Evidence() {
	return verifyArtifactEvidence({
		ref: snapshot.t01.artifact_ref,
		bytes: t01Bytes,
		expectedFamily: 't01-artifact-ref-schema',
		expectedVersion: '1',
	});
}

test('source snapshots are exact bytes from the reviewed T01/T16/T19 artifacts', () => {
	assert.equal(t01Bytes.length, snapshot.t01.size_bytes);
	assert.equal(sha256(t01Bytes), snapshot.t01.file_sha256);
	assert.equal(t16Bytes.length, snapshot.t16.size_bytes);
	assert.equal(sha256(t16Bytes), snapshot.t16.file_sha256);
	assert.equal(t19Bytes.length, snapshot.t19.size_bytes);
	assert.equal(sha256(t19Bytes), snapshot.t19.file_sha256);
	assert.equal(snapshot.t01.git_blob, 'd69366533844c4d002de8746140776edfdccbb25');
	assert.equal(snapshot.t16.git_blob, '6af4770dbc31ca64dd94ac8ec83ae570bb00104d');
	assert.equal(snapshot.t19.git_blob, '6990553e297b493c3a4a480b1b7bec03b822a6b8');
});

test('T01 ArtifactRef must match exact bytes before it can become T03 evidence', () => {
	const evidence = t01Evidence();
	assert.deepEqual(evidence.ref, snapshot.t01.artifact_ref);
	assert.equal(assertArtifactRefMatchesBytes(snapshot.t01.artifact_ref, t01Bytes).byte_sha256, snapshot.t01.file_sha256);
});

test('stale artifact bytes are rejected even when the ArtifactRef shape is valid', () => {
	const stale = Buffer.concat([t01Bytes, Buffer.from('\n')]);
	assert.throws(() => verifyArtifactEvidence({ ref: snapshot.t01.artifact_ref, bytes: stale }), /do not match/);
});

test('forged ArtifactRef digest is rejected against the real bytes', () => {
	const forged = { ...snapshot.t01.artifact_ref, byte_sha256: '0'.repeat(64) };
	assert.throws(() => verifyArtifactEvidence({ ref: forged, bytes: t01Bytes }), /do not match/);
});

test('wrong ArtifactRef family/version is rejected by a scoped verifier', () => {
	assert.throws(() => verifyArtifactEvidence({
		ref: snapshot.t01.artifact_ref,
		bytes: t01Bytes,
		expectedFamily: 'openapi',
	}), /does not match expected family/);
	assert.throws(() => verifyArtifactEvidence({
		ref: snapshot.t01.artifact_ref,
		bytes: t01Bytes,
		expectedVersion: '2',
	}), /does not match expected version/);
});

test('a string evidence token can no longer create supported capability state', () => {
	assert.throws(() => capabilityRecord({
		name: 'api.routes',
		status: 'supported',
		evidence: ['proof'],
	}), /verifyArtifactEvidence/);
});

test('a raw ArtifactRef object is not enough without exact-byte verification receipt', () => {
	assert.throws(() => capabilityRecord({
		name: 'api.routes',
		status: 'supported',
		evidence: [snapshot.t01.artifact_ref],
	}), /verifyArtifactEvidence/);
});

test('verified exact-byte evidence can support only the explicit static claim', () => {
	const record = capabilityRecord({
		name: 'identity.artifact-ref',
		status: 'supported',
		evidence: [t01Evidence()],
		conditions: ['verified against exact T01 ArtifactRef schema bytes'],
	});
	assert.equal(record.status, 'supported');
	assert.deepEqual(record.evidenceRefs, [snapshot.t01.artifact_ref]);
});

test('legacy OpenAPI satisfier also requires verified exact-byte evidence, not a string or raw ref', () => {
	assert.throws(() => externalCapabilityFromLegacySatisfier({
		capability: 'api.operations',
		flag: 'openapi-file',
		evidence: 'sha256:fake',
	}), /verifyArtifactEvidence/);
	assert.throws(() => externalCapabilityFromLegacySatisfier({
		capability: 'api.operations',
		flag: 'openapi-file',
		evidence: snapshot.t01.artifact_ref,
	}), /verifyArtifactEvidence/);
	const result = externalCapabilityFromLegacySatisfier({
		capability: 'api.operations',
		flag: 'openapi-file',
		evidence: t01Evidence(),
	});
	assert.equal(result.status, 'supported');
	assert.deepEqual(result.evidenceRefs, [snapshot.t01.artifact_ref]);
	assert.match(result.conditions[0], /does not.*certify runtime behavior/);
});

test('unknown can never be accepted by policy', () => {
	assert.throws(() => evaluateCapabilityPolicy({
		requirements: [{ capability: 'api.security.enforced', acceptedStatuses: ['unknown'] }],
	}), /unknown cannot/);
});

test('partial remains partial and is never rewritten to supported', () => {
	const partial = capabilityRecord({
		name: 'runtime.certification',
		status: 'partial',
		evidence: [verifyArtifactEvidence({ ref: snapshot.t19.artifact_ref, bytes: t19Bytes })],
		reason: 'runtime core review is not runtime-execution certification',
	});
	const result = evaluateCapabilityPolicy({
		capabilities: { 'runtime.certification': partial },
		requirements: [{ capability: 'runtime.certification', acceptedStatuses: ['supported', 'partial'] }],
	});
	assert.equal(result.allowed, true);
	assert.equal(result.decisions[0].status, 'partial');
	assert.notEqual(result.decisions[0].status, 'supported');
});

test('conflict is not a T03 capability status and cannot be promoted', () => {
	assert.equal(CAPABILITY_STATUSES.includes('conflict'), false);
	assert.throws(() => capabilityRecord({
		name: 'api.routes',
		status: 'conflict',
		reason: 'source/runtime disagree',
	}), /status must be one of/);
	assert.equal(statusFixture.aggregation_example.status, 'conflict');
	assert.match(statusFixture.aggregation_example.meaning, /not a T03 capability status/);
});

test('current exact T16 + T19 core review is explicitly blocked from runtime-tested certification', () => {
	const result = assertCurrentRuntimeCoreReviewIsNotCertification({
		runtimeBindingImplementationRef: snapshot.t16.artifact_ref,
		runtimeBindingImplementationBytes: t16Bytes,
		t19ReviewRef: snapshot.t19.artifact_ref,
		t19ReviewBytes: t19Bytes,
	});
	assert.deepEqual(result.eligible, false);
	assert.equal(result.status, 'blocked');
	assert.equal(result.code, 'RUNTIME_CERTIFICATION_NOT_REVIEWED');
	assert.match(result.reason, /core-only/);
	assert.equal(snapshot.t19.runtime_tested_certification, false);
});

test('stale or forged T19 review artifacts fail before their review text is considered', () => {
	assert.throws(() => assertCurrentRuntimeCoreReviewIsNotCertification({
		runtimeBindingImplementationRef: snapshot.t16.artifact_ref,
		runtimeBindingImplementationBytes: t16Bytes,
		t19ReviewRef: snapshot.t19.artifact_ref,
		t19ReviewBytes: Buffer.concat([t19Bytes, Buffer.from('\n')]),
	}), /do not match/);
	const forged = { ...snapshot.t19.artifact_ref, byte_sha256: 'f'.repeat(64) };
	assert.throws(() => assertCurrentRuntimeCoreReviewIsNotCertification({
		runtimeBindingImplementationRef: snapshot.t16.artifact_ref,
		runtimeBindingImplementationBytes: t16Bytes,
		t19ReviewRef: forged,
		t19ReviewBytes: t19Bytes,
	}), /do not match/);
});

test('RuntimeBinding presence and a profile string cannot create runtime-tested certification', () => {
	assert.throws(() => certificationRecord({
		targetId: 'python-fastapi',
		level: 'runtime-tested',
		profile: 'python-3.12-linux',
		evidence: [verifyArtifactEvidence({ ref: snapshot.t16.artifact_ref, bytes: t16Bytes })],
	}), /runtime-tested requires exact T16 runtime-execution evidence/);
});

test('different profile/combination-looking runtime inputs cannot bypass the blocked runtime verifier boundary', () => {
	for (const profile of ['python-3.12-linux', 'python-3.13-linux']) {
		assert.throws(() => certificationRecord({
			targetId: 'python-fastapi',
			level: 'contract',
			profile,
			evidence: [t01Evidence()],
			runtimeVerification: { pretend: true },
			combinationHash: 'a'.repeat(64),
		}), /not accepted until the T16\/T19 runtime-execution verifier contract is frozen/);
	}
});

test('behavior-tested codegen cannot be declared from static evidence', () => {
	assert.throws(() => certificationRecord({
		targetId: 'python-fastapi',
		level: 'contract',
		codegen: 'behavior-tested',
		evidence: [t01Evidence()],
	}), /requires verified runtime behavior evidence/);
});

test('discovery/contract and codegen state remain independent without implying runtime-tested', () => {
	const discovery = certificationRecord({
		targetId: 'python-fastapi',
		level: 'discovery',
		codegen: 'none',
		evidence: [t01Evidence()],
	});
	const contract = certificationRecord({
		targetId: 'python-fastapi',
		level: 'contract',
		codegen: 'scaffold',
		evidence: [t01Evidence()],
	});
	assert.equal(discovery.level, 'discovery');
	assert.equal(discovery.codegen, 'none');
	assert.equal(contract.level, 'contract');
	assert.equal(contract.codegen, 'scaffold');
});

test('shared T15/T22 fixture keeps unknown, partial, conflict, runtime and codegen boundaries explicit', () => {
	const byName = Object.fromEntries(statusFixture.records.map((item) => [item.name, item]));
	assert.equal(byName['identity.artifact-ref'].status, 'supported');
	assert.equal(byName['runtime.certification'].status, 'partial');
	assert.equal(byName['api.security.enforced'].status, 'unknown');
	assert.equal(byName['codegen.behavior-tested'].status, 'unsupported');
	assert.equal(statusFixture.certification, null);
	assert.deepEqual(statusFixture.capabilityMap, Object.fromEntries(statusFixture.records.map((item) => [item.name, item])));
	assert.equal(statusFixture.rules.unknown_never_supported, true);
	assert.equal(statusFixture.rules.partial_never_implicitly_supported, true);
	assert.equal(statusFixture.rules.conflict_never_supported, true);
	assert.equal(statusFixture.rules.runtime_binding_presence_is_not_runtime_tested, true);
	assert.equal(statusFixture.rules.mock_success_is_not_runtime_tested, true);
});
