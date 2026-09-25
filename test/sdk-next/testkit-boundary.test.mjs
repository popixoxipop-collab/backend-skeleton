import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	ACTIVATION_MODE,
	CURRENT_ADAPTER_DESCRIPTOR_CONTRACT,
	SDK_ENTRYPOINT_PROTOCOL,
	SDK_MANIFEST_CONTRACT,
	runAdapterSdkConformance,
} from '../../sdk/next/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK_DIR = path.resolve(HERE, '../../sdk/next');

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
			readRoots: ['.'],
			writeRoots: [],
			network: 'deny-by-default',
			environment: [],
			subprocess: 'deny-by-default',
		},
		fixtures: ['fixtures/minimal'],
		verificationBasis: 'synthetic-only',
		activation: { mode: ACTIVATION_MODE },
	};
}

test('conformance harness uses only a caller-supplied invoke function', async () => {
	let calls = 0;
	const report = await runAdapterSdkConformance({
		manifest: manifest(),
		snapshotRef: 'sha256:fixture',
		cases: [
			{ operation: 'detect', payload: {}, expectStatus: 'ok' },
			{ operation: 'analyze', payload: {}, expectStatus: 'unknown' },
		],
		invoke: async (request) => {
			calls += 1;
			return {
				contract: SDK_ENTRYPOINT_PROTOCOL,
				direction: 'response',
				requestId: request.requestId,
				adapterId: request.adapterId,
				status: request.operation === 'analyze' ? 'unknown' : 'ok',
				result: {},
				diagnostics: [],
			};
		},
	});
	assert.equal(calls, 2);
	assert.equal(report.status, 'pass');
	assert.equal(report.executed, true);
	assert.equal(report.activation.executable, false);
	assert.match(report.activation.note, /never spawned or imported adapter code/);
});

test('invalid manifest stops before invoke', async () => {
	const bad = manifest();
	bad.activation.mode = 'auto';
	let called = false;
	const report = await runAdapterSdkConformance({
		manifest: bad,
		snapshotRef: 'sha256:fixture',
		cases: [{ operation: 'detect' }],
		invoke: async () => { called = true; },
	});
	assert.equal(called, false);
	assert.equal(report.status, 'invalid-manifest');
	assert.equal(report.executed, false);
});

test('SDK source has no process spawning, environment reads, dynamic import, or core-internal imports', () => {
	const files = fs.readdirSync(SDK_DIR).filter((name) => name.endsWith('.mjs')).sort();
	assert.ok(files.length > 0);
	for (const name of files) {
		const source = fs.readFileSync(path.join(SDK_DIR, name), 'utf8');
		assert.doesNotMatch(source, /node:child_process|child_process|spawnSync|execFileSync|process\.env/);
		assert.doesNotMatch(source, /\bimport\s*\(/);
		assert.doesNotMatch(source, /\.\.\/(?:\.\.\/)*(?:scanners|contracts|handles|lib|bin)\//);
	}
});
