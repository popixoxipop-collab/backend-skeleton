import assert from 'node:assert/strict';
import test from 'node:test';

import {
	ACTIVATION_MODE,
	CURRENT_ADAPTER_DESCRIPTOR_CONTRACT,
	SDK_ENTRYPOINT_PROTOCOL,
	SDK_MANIFEST_CONTRACT,
	createAdapterPackageInventory,
	createSupportExplanation,
	reviewAdapterSubmission,
} from '../../sdk/next/index.mjs';

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

function inventory({ includeEntrypoint = true } = {}) {
	const files = [
		{ path: 'fixtures/minimal/input.ts', sha256: 'b'.repeat(64), sizeBytes: 10, kind: 'file' },
	];
	if (includeEntrypoint) {
		files.push({ path: 'adapter-worker.mjs', sha256: 'c'.repeat(64), sizeBytes: 100, kind: 'file' });
	}
	return createAdapterPackageInventory({ packageSha256: 'a'.repeat(64), files });
}

function explanation(status = 'partial') {
	return createSupportExplanation({
		subject: 'typescript-nestjs:project',
		adapterId: 'typescript-nestjs',
		capabilities: [{
			name: 'api.routes',
			status,
			evidenceRefs: status === 'unknown' ? [] : ['source:controller'],
			constraints: status === 'partial' ? ['runtime route snapshot missing'] : [],
			nextActions: status === 'partial' ? ['run approved route exporter'] : [],
		}],
		fields: [],
	});
}

test('ready submission still cannot execute and only advances to execution review', () => {
	const report = reviewAdapterSubmission({
		manifest: manifest(),
		inventory: inventory(),
		explanations: [explanation('partial')],
	});
	assert.equal(report.status, 'ready-for-execution-review');
	assert.equal(report.preExecutionReviewPassed, true);
	assert.equal(report.executable, false);
	assert.equal(report.requiresApproval, true);
	assert.equal(report.packageReview.packageBytesTrusted, false);
	assert.equal(report.supportEvidenceMatrix.rows[0].capabilities['api.routes'].status, 'partial');
	assert.match(report.note, /never authorizes adapter execution/);
});

test('submission without support explanations remains evidence-incomplete', () => {
	const report = reviewAdapterSubmission({
		manifest: manifest(),
		inventory: inventory(),
		explanations: [],
	});
	assert.equal(report.status, 'needs-support-evidence');
	assert.equal(report.preExecutionReviewPassed, false);
	assert.equal(report.executable, false);
	assert.equal(report.diagnostics.some((item) => item.code === 'BSKEL_SUPPORT_EVIDENCE_MISSING'), true);
});

test('missing package references make the submission need fixes', () => {
	const report = reviewAdapterSubmission({
		manifest: manifest(),
		inventory: inventory({ includeEntrypoint: false }),
		explanations: [explanation('partial')],
	});
	assert.equal(report.status, 'needs-fixes');
	assert.equal(report.preExecutionReviewPassed, false);
	assert.equal(report.diagnostics.some((item) => item.code === 'BSKEL_PACKAGE_REFERENCE_MISSING'), true);
});

test('contradictory support evidence becomes support-conflict', () => {
	const yes = explanation('supported');
	const no = explanation('unsupported');
	const report = reviewAdapterSubmission({
		manifest: manifest(),
		inventory: inventory(),
		explanations: [yes, no],
	});
	assert.equal(report.status, 'support-conflict');
	assert.equal(report.preExecutionReviewPassed, false);
	assert.equal(report.supportEvidenceMatrix.rows[0].capabilities['api.routes'].status, 'conflict');
	assert.equal(report.diagnostics.some((item) => item.status === 'conflict'), true);
});

test('invalid explanation objects are reported as needs-fixes instead of throwing', () => {
	const report = reviewAdapterSubmission({
		manifest: manifest(),
		inventory: inventory(),
		explanations: [{ contract: 'wrong' }],
	});
	assert.equal(report.status, 'needs-fixes');
	assert.equal(report.preExecutionReviewPassed, false);
	assert.equal(report.executable, false);
	assert.equal(report.diagnostics.some((item) => item.code === 'BSKEL_SUPPORT_EVIDENCE_INVALID'), true);
});
