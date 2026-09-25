import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildSupportEvidenceMatrix,
	projectFiveStateCapabilities,
} from '../../sdk/next/index.mjs';

function record(name, status, {
	evidenceRefs = status === 'supported' ? ['ev:' + name] : [],
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
		assert.match(explanation.notes[1], /conflict is intentionally not a record status/);
	}
});

test('conflict arises only when separate evidence explanations disagree', () => {
	const yes = projectFiveStateCapabilities({
		subject: 'typescript-nestjs:source',
		adapterId: 'typescript-nestjs',
		records: [record('api.routes', 'supported', { evidenceRefs: ['source:route'] })],
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
	}), /supported capability requires evidenceRefs/);

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
