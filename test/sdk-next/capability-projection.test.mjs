import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildSupportEvidenceMatrix,
	projectFiveStateCapabilities,
} from '../../sdk/next/index.mjs';

function artifactRef(seed = 'a') {
	return {
		artifact_ref: 'sbf.artifact-ref/1',
		family: 'capability-evidence',
		version: '1',
		media_type: 'application/json',
		byte_sha256: seed.repeat(64).slice(0, 64),
		size_bytes: 1,
	};
}

function record(name, status, {
	evidenceRefs = status === 'supported' ? [artifactRef()] : [],
	reason = status === 'supported' ? null : status + ' reason',
	conditions = [],
	source = 't03-compatible-test',
} = {}) {
	return { name, status, evidenceRefs, reason, conditions, source };
}

test('five-state records project one-to-one without fabricating conflict', () => {
	const statuses = ['supported', 'partial', 'unsupported', 'unknown', 'not-applicable'];
	for (const status of statuses) {
		const explanation = projectFiveStateCapabilities({
			subject: 'typescript-nestjs:project',
			adapterId: 'typescript-nestjs',
			records: [record('api.routes', status)],
		});
		assert.equal(explanation.capabilities[0].status, status);
		assert.notEqual(explanation.capabilities[0].status, 'conflict');
		assert.match(explanation.notes[1], /T22 does not create a separate supported verdict/);
	}
});

test('conflict arises only when separate evidence explanations disagree', () => {
	const yes = projectFiveStateCapabilities({
		subject: 'typescript-nestjs:source',
		adapterId: 'typescript-nestjs',
		records: [record('api.routes', 'supported', { evidenceRefs: [artifactRef('b')] })],
	});
	const no = projectFiveStateCapabilities({
		subject: 'typescript-nestjs:runtime',
		adapterId: 'typescript-nestjs',
		records: [record('api.routes', 'unsupported', { evidenceRefs: ['runtime:profile'], reason: 'disabled by profile' })],
	});
	const matrix = buildSupportEvidenceMatrix([yes, no]);
	assert.equal(matrix.rows[0].capabilities['api.routes'].status, 'conflict');
});

test('projection preserves evidence, conditions, reason and next actions', () => {
	const explanation = projectFiveStateCapabilities({
		subject: 'python-fastapi:project',
		adapterId: 'python-fastapi',
		records: [record('api.operations', 'partial', {
			evidenceRefs: ['source:router'],
			reason: 'operation identity requires external evidence',
			conditions: ['source scan does not produce runtime operationId'],
			source: 't03-preview',
		})],
		nextActions: {
			'api.operations': ['supply immutable OpenAPI evidence'],
		},
	});
	const cap = explanation.capabilities[0];
	assert.deepEqual(cap.evidenceRefs, ['source:router']);
	assert.deepEqual(cap.constraints, [
		'source scan does not produce runtime operationId',
		'operation identity requires external evidence',
		'source:t03-preview',
	]);
	assert.deepEqual(cap.nextActions, ['supply immutable OpenAPI evidence']);
});

test('projection rejects direct conflict and malformed five-state semantics', () => {
	assert.throws(() => projectFiveStateCapabilities({
		subject: 'x',
		adapterId: 'typescript-nestjs',
		records: [{ name: 'api.routes', status: 'conflict', evidenceRefs: [], reason: 'x', conditions: [], source: 'x' }],
	}), /status must be one of/);

	assert.throws(() => projectFiveStateCapabilities({
		subject: 'x',
		adapterId: 'typescript-nestjs',
		records: [{ name: 'api.routes', status: 'supported', evidenceRefs: [], reason: null, conditions: [], source: 't03-preview' }],
	}), /supported capability requires T01/);

	assert.throws(() => projectFiveStateCapabilities({
		subject: 'x',
		adapterId: 'typescript-nestjs',
		records: [record('api.routes', 'unknown', { reason: null })],
	}), /unknown capability requires a reason/);
});

test('projection rejects duplicate capability names', () => {
	assert.throws(() => projectFiveStateCapabilities({
		subject: 'x',
		adapterId: 'typescript-nestjs',
		records: [record('api.routes', 'partial'), record('api.routes', 'unknown')],
	}), /duplicate capability record/);
});

test('prototype-like capability names remain ordinary data', () => {
	const explanation = projectFiveStateCapabilities({
		subject: 'x',
		adapterId: 'typescript-nestjs',
		records: [
			record('__proto__', 'partial', { evidenceRefs: ['ev:p'], reason: 'partial' }),
			record('constructor', 'unknown', { reason: 'unknown' }),
		],
		nextActions: JSON.parse('{"__proto__":["review proto"],"constructor":["review constructor"]}'),
	});
	assert.equal(Object.prototype.polluted, undefined);
	assert.deepEqual(explanation.capabilities.map((item) => item.name).sort(), ['__proto__', 'constructor']);
	assert.deepEqual(explanation.capabilities.find((item) => item.name === '__proto__').nextActions, ['review proto']);
});


test('supported projection rejects arbitrary string evidenceRefs and accepts T01 ArtifactRef identity only as non-certifying display evidence', () => {
	assert.throws(() => projectFiveStateCapabilities({
		subject: 'x',
		adapterId: 'typescript-nestjs',
		records: [record('api.routes', 'supported', { evidenceRefs: ['display-only-string'] })],
	}), /arbitrary strings are not certification evidence|sbf\.artifact-ref\/1/);

	const explanation = projectFiveStateCapabilities({
		subject: 'x',
		adapterId: 'typescript-nestjs',
		records: [record('api.routes', 'supported', { evidenceRefs: [artifactRef('c')] })],
	});
	assert.equal(explanation.capabilities[0].status, 'supported');
	assert.equal(explanation.capabilities[0].evidenceRefs[0].includes('\"artifact_ref\":\"sbf.artifact-ref/1\"'), true);
	assert.match(explanation.notes[1], /non-certifying|independently verified/);
});

test('explicit legacy boolean supported bridge remains a projection without invented evidence', () => {
	const explanation = projectFiveStateCapabilities({
		subject: 'legacy',
		adapterId: 'java-spring',
		records: [{ name: 'api.routes', status: 'supported', evidenceRefs: [], reason: null, conditions: [], source: 'legacy-adapter-boolean' }],
	});
	assert.equal(explanation.capabilities[0].status, 'supported');
	assert.deepEqual(explanation.capabilities[0].evidenceRefs, []);
});
