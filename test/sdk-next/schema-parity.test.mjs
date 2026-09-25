import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import {
	ACTIVATION_MODE,
	CURRENT_ADAPTER_DESCRIPTOR_CONTRACT,
	SDK_ENTRYPOINT_PROTOCOL,
	SDK_MANIFEST_CONTRACT,
	buildSupportMatrix,
	createAdapterPackageInventory,
	createAdapterTaskPacket,
	createSupportExplanation,
	makeSdkRequest,
	reviewAdapterSubmission,
	runAdapterSdkConformance,
	SDK_SCHEMA_FILES,
	SDK_SCHEMA_IDS,
	validateAdapterSdkManifest,
	validateSdkRequest,
} from '../../sdk/next/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS = path.resolve(HERE, '../../sdk/next/schemas');

function load(name) {
	return JSON.parse(fs.readFileSync(path.join(SCHEMAS, name), 'utf8'));
}

function validators() {
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	return {
		manifest: ajv.compile(load('adapter-sdk-manifest.schema.json')),
		request: ajv.compile(load('adapter-worker-request.schema.json')),
		response: ajv.compile(load('adapter-worker-response.schema.json')),
		explain: ajv.compile(load('support-explanation.schema.json')),
		task: ajv.compile(load('adapter-task-packet.schema.json')),
		conformance: ajv.compile(load('adapter-sdk-conformance.schema.json')),
		packageInventory: ajv.compile(load('adapter-package-inventory.schema.json')),
		supportMatrix: ajv.compile(load('support-matrix.schema.json')),
		submissionReview: ajv.compile(load('adapter-submission-review.schema.json')),
	};
}

function manifest() {
	return {
		contract: SDK_MANIFEST_CONTRACT,
		adapter: {
			id: 'typescript-nestjs',
			title: 'NestJS',
			version: '0.1.0',
			descriptorContract: CURRENT_ADAPTER_DESCRIPTOR_CONTRACT,
		},
		compatibility: { bskel: { minInclusive: '1.9.0', maxExclusive: '2.0.0' } },
		entrypoint: { protocol: SDK_ENTRYPOINT_PROTOCOL, path: 'adapter-worker.mjs', export: 'adapterWorker' },
		permissions: {
			readRoots: ['.', 'src'],
			writeRoots: [],
			network: 'deny-by-default',
			environment: ['NODE_ENV'],
			subprocess: 'deny-by-default',
		},
		fixtures: ['fixtures/minimal'],
		verificationBasis: 'synthetic-only',
		activation: { mode: ACTIVATION_MODE },
	};
}

test('all SDK schemas compile and accept values emitted/accepted by the runtime library', async () => {
	const v = validators();
	const m = manifest();
	assert.equal(validateAdapterSdkManifest(m).ok, true);
	assert.equal(v.manifest(m), true, JSON.stringify(v.manifest.errors));

	const request = makeSdkRequest({
		requestId: 'case-1',
		operation: 'detect',
		adapterId: m.adapter.id,
		snapshotRef: 'sha256:example',
		payload: {},
	});
	assert.equal(validateSdkRequest(request).ok, true);
	assert.equal(v.request(request), true, JSON.stringify(v.request.errors));

	const response = {
		contract: SDK_ENTRYPOINT_PROTOCOL,
		direction: 'response',
		requestId: request.requestId,
		adapterId: request.adapterId,
		status: 'ok',
		result: { detected: true },
		diagnostics: [],
	};
	assert.equal(v.response(response), true, JSON.stringify(v.response.errors));

	const explain = createSupportExplanation({
		subject: 'project/api/users#get',
		adapterId: m.adapter.id,
		capabilities: [{
			name: 'api.routes',
			status: 'partial',
			summary: 'literal routes discovered',
			evidenceRefs: ['source:controller'],
			constraints: ['global prefix unresolved'],
			nextActions: ['supply an approved runtime route snapshot'],
		}],
		fields: [],
	});
	assert.equal(v.explain(explain), true, JSON.stringify(v.explain.errors));

	const packet = createAdapterTaskPacket({
		taskId: 'HTTP-typescript-nestjs-02',
		targetId: 'HTTP-typescript-nestjs',
		baseSha: '5472a8b82655840d1d3ce76cb926987376e37ca6',
		writeScope: ['adapters/http-wave-a/typescript-nestjs/**'],
		fixtures: ['test/fixtures/typescript-nestjs/minimal'],
		mandatoryTests: ['node --test test/typescript-nestjs.test.mjs'],
	});
	assert.equal(v.task(packet), true, JSON.stringify(v.task.errors));

	const conformance = await runAdapterSdkConformance({
		manifest: m,
		snapshotRef: 'sha256:example',
		cases: [{ operation: 'detect', expectStatus: 'ok' }],
		invoke: async (req) => ({
			contract: SDK_ENTRYPOINT_PROTOCOL,
			direction: 'response',
			requestId: req.requestId,
			adapterId: req.adapterId,
			status: 'ok',
			result: {},
			diagnostics: [],
		}),
	});
	assert.equal(v.conformance(conformance), true, JSON.stringify(v.conformance.errors));

	const inventory = createAdapterPackageInventory({
		packageSha256: 'a'.repeat(64),
		files: [
			{ path: 'adapter-worker.mjs', sha256: 'b'.repeat(64), sizeBytes: 100, kind: 'file' },
			{ path: 'fixtures/minimal/input.ts', sha256: 'c'.repeat(64), sizeBytes: 20, kind: 'file' },
		],
	});
	assert.equal(v.packageInventory(inventory), true, JSON.stringify(v.packageInventory.errors));

	const matrix = buildSupportMatrix([explain]);
	assert.equal(v.supportMatrix(matrix), true, JSON.stringify(v.supportMatrix.errors));

	const submission = reviewAdapterSubmission({
		manifest: m,
		inventory,
		explanations: [explain],
	});
	assert.equal(v.submissionReview(submission), true, JSON.stringify(v.submissionReview.errors));
});

test('manifest schema and runtime validator both reject obvious execution/path escapes', () => {
	const v = validators();
	for (const mutate of [
		(m) => { m.entrypoint.path = '../worker.mjs'; },
		(m) => { m.permissions.readRoots = ['/etc']; },
		(m) => { m.permissions.writeRoots = ['C:\\temp']; },
		(m) => { m.permissions.network = 'allow'; },
		(m) => { m.permissions.environment = ['TOKEN=secret']; },
	]) {
		const m = manifest();
		mutate(m);
		assert.equal(validateAdapterSdkManifest(m).ok, false);
		assert.equal(v.manifest(m), false, JSON.stringify(m));
	}
});

test('runtime performs semantic SemVer checks that JSON Schema intentionally cannot express', () => {
	const v = validators();
	const m = manifest();
	m.compatibility.bskel = { minInclusive: '2.0.0', maxExclusive: '1.9.0' };
	assert.equal(v.manifest(m), true, 'the structural schema does not compare two semantic-version fields');
	assert.equal(validateAdapterSdkManifest(m).ok, false, 'runtime validator must enforce interval ordering');
});


test('support explanation schema rejects the same contradictory field states as runtime code', () => {
	const v = validators();
	const base = {
		contract: 'sbf.support-explanation/1',
		subject: 'project/api/users#get',
		adapterId: 'typescript-nestjs',
		capabilities: [],
		fields: [],
		notes: [],
	};

	const unknownWithValue = structuredClone(base);
	unknownWithValue.fields.push({
		name: 'http.path',
		status: 'unknown',
		value: '/users',
		provenanceRefs: [],
		conflicts: [],
		constraints: [],
		nextActions: [],
	});
	assert.equal(v.explain(unknownWithValue), false);

	const conflictWithOneCandidate = structuredClone(base);
	conflictWithOneCandidate.fields.push({
		name: 'http.path',
		status: 'conflict',
		provenanceRefs: ['source:a'],
		conflicts: [{ value: '/users' }],
		constraints: [],
		nextActions: [],
	});
	assert.equal(v.explain(conflictWithOneCandidate), false);
});


test('schema catalog IDs and package-relative files match the checked-in JSON schemas', () => {
	for (const [key, relative] of Object.entries(SDK_SCHEMA_FILES)) {
		assert.equal(typeof SDK_SCHEMA_IDS[key], 'string', key);
		const schema = load(path.basename(relative));
		assert.equal(schema.$id, SDK_SCHEMA_IDS[key], key);
		assert.equal(relative.startsWith('schemas/'), true, key);
	}
	assert.deepEqual(Object.keys(SDK_SCHEMA_FILES).sort(), Object.keys(SDK_SCHEMA_IDS).sort());
});
