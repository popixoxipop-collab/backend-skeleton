import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	createAdapterPackageInventory,
	createAdapterTaskPacket,
	createSupportExplanation,
	diagnosticsToSarif,
	reviewAdapterPackage,
	runAdapterSdkConformance,
	validateAdapterSdkManifest,
} from '../../sdk/next/index.mjs';

import { adapterWorker } from './fixtures/minimal-external-adapter/adapter-worker.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(HERE, 'fixtures/minimal-external-adapter');

function readFixture(relative) {
	return fs.readFileSync(path.join(FIXTURE_ROOT, relative));
}

function sha256(buffer) {
	return crypto.createHash('sha256').update(buffer).digest('hex');
}

test('minimal external adapter walks the full T22 pre-execution onboarding path', async () => {
	const manifest = JSON.parse(readFixture('adapter-sdk.json').toString('utf8'));
	assert.equal(validateAdapterSdkManifest(manifest).ok, true);

	const inventoryFiles = [
		'adapter-sdk.json',
		'adapter-worker.mjs',
		'fixtures/minimal/input.ts',
	].map((relative) => {
		const bytes = readFixture(relative);
		return {
			path: relative,
			sha256: sha256(bytes),
			sizeBytes: bytes.length,
			kind: 'file',
		};
	});
	const syntheticInventoryDigest = sha256(Buffer.from(
		inventoryFiles.map((file) => `${file.path}\0${file.sha256}\0${file.sizeBytes}`).join('\n'),
		'utf8',
	));
	const inventory = createAdapterPackageInventory({
		packageSha256: syntheticInventoryDigest,
		files: inventoryFiles,
	});

	const packageReview = reviewAdapterPackage({ manifest, inventory });
	assert.equal(packageReview.inventoryValid, true);
	assert.equal(packageReview.referencesSatisfied, true);
	assert.equal(packageReview.digestMatch, null);
	assert.equal(packageReview.packageBytesTrusted, false);
	assert.equal(packageReview.executable, false);

	const taskPacket = createAdapterTaskPacket({
		taskId: 'EXAMPLE-minimal-02',
		targetId: 'EXAMPLE-minimal',
		baseSha: '5472a8b82655840d1d3ce76cb926987376e37ca6',
		writeScope: ['adapters/example-minimal/**'],
		fixtures: ['test/sdk-next/fixtures/minimal-external-adapter/**'],
		mandatoryTests: ['node --test test/sdk-next/onboarding-e2e.test.mjs'],
	});
	assert.equal(taskPacket.constraints.some((value) => value.includes('no automatic package install')), true);

	const conformance = await runAdapterSdkConformance({
		manifest,
		snapshotRef: 'fixture:minimal-external-adapter',
		cases: [
			{ operation: 'detect', expectStatus: 'ok' },
			{ operation: 'analyze', expectStatus: 'ok' },
			{ operation: 'diagnostics', expectStatus: 'ok' },
			{ operation: 'read-set', expectStatus: 'ok' },
		],
		invoke: adapterWorker,
	});
	assert.equal(conformance.status, 'pass');
	assert.equal(conformance.observations.length, 4);
	assert.equal(conformance.activation.executable, false);

	const explanation = createSupportExplanation({
		subject: 'example-minimal:/example',
		adapterId: manifest.adapter.id,
		capabilities: [{
			name: 'api.routes',
			status: 'partial',
			summary: 'the synthetic adapter reports one route',
			evidenceRefs: ['fixture:fixtures/minimal/input.ts'],
			constraints: ['synthetic-only; no runtime proof'],
			nextActions: ['obtain an approved isolated runtime profile before runtime-tested status'],
		}],
		fields: [{
			name: 'http.path',
			status: 'partial',
			value: '/example',
			provenanceRefs: ['fixture:fixtures/minimal/input.ts'],
			constraints: ['synthetic-only'],
			nextActions: [],
		}],
	});
	assert.equal(explanation.capabilities[0].status, 'partial');

	const diagnosticsResponse = await adapterWorker({
		contract: 'sbf.adapter-worker/1',
		direction: 'request',
		requestId: 'diagnostics-example',
		operation: 'diagnostics',
		adapterId: manifest.adapter.id,
		snapshotRef: 'fixture:minimal-external-adapter',
		payload: {},
	});
	const sarif = diagnosticsToSarif(diagnosticsResponse.diagnostics.map((diagnostic) => ({
		...diagnostic,
		adapterId: manifest.adapter.id,
		evidenceRefs: ['fixture:fixtures/minimal/input.ts'],
	})));
	assert.equal(sarif.runs[0].results[0].ruleId, 'EXAMPLE_STATIC_ONLY');
	assert.equal(sarif.runs[0].results[0].properties.bskelStatus, 'unknown');

	// This complete source-tree flow still must not manufacture runtime trust.
	assert.equal(packageReview.packageBytesTrusted, false);
	assert.equal(packageReview.executable, false);
	assert.equal(conformance.activation.executable, false);
});
