import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildWebgameFingerprint,
	diffWebgameFingerprints,
	digestWebgameValue,
} from '../webgame/fingerprint.mjs';
import {
	createWebgameReceipt,
	computeWebgameReceiptDigest,
	validateWebgameReceipt,
	selectWebgameEvidenceState,
	buildWebgameRunIndex,
	isFreshPassingReceipt,
} from '../webgame/receipts.mjs';
import { evaluateWebgamePerformance } from '../webgame/performance.mjs';
import { evaluateGateProfile } from '../lib/gate-profiles.mjs';
import { evaluateWebgameRelease } from '../webgame/release-policy.mjs';

function baseInput(overrides = {}) {
	return {
		source_snapshot_digest: 'sha256:source-a',
		source_files: [
			{ path: 'src/main.ts', digest: 'sha256:main-a' },
			{ path: 'src/worker.ts', digest: 'sha256:worker-a' },
		],
		assets: [{ path: 'public/player.glb', digest: 'sha256:asset-a' }],
		runtime_contract_digest: 'sha256:contract-a',
		scenario_digest: 'sha256:scenario-a',
		assertion_policy_digest: 'sha256:assertions-a',
		runner: { id: 'threejs-browser', version: '1.0.0' },
		browser: { name: 'chromium', version: '140.0', revision: 'r123' },
		profile_id: 'desktop-chromium',
		build_artifact_digest: 'sha256:build-a',
		required_capabilities: ['webgl2', 'worker'],
		verified_at: '2000-01-01T00:00:00.000Z',
		...overrides,
	};
}

function fp(overrides = {}) {
	return buildWebgameFingerprint(baseInput(overrides));
}

function receipt({
	fingerprint = fp(),
	verdict = 'passed',
	run_id = 'run-1',
	profile_id = 'desktop-chromium',
	scenario_id = 'movement',
	observed_at = '2026-09-25T00:00:00.000Z',
} = {}) {
	return createWebgameReceipt({
		run_id,
		profile_id,
		scenario_id,
		verdict,
		fingerprint,
		runtime_result_digest: digestWebgameValue({ verdict, run_id, scenario_id }),
		observed_at,
	});
}

test('timestamp-like metadata is not part of the webgame fingerprint', () => {
	const a = buildWebgameFingerprint(baseInput({ verified_at: '2020-01-01T00:00:00Z' }));
	const b = buildWebgameFingerprint(baseInput({ verified_at: '2030-01-01T00:00:00Z' }));
	assert.equal(a.digest, b.digest);
});

test('a one-byte-equivalent source digest change makes prior evidence stale', () => {
	const before = fp();
	const after = fp({ source_snapshot_digest: 'sha256:source-b' });
	assert.notEqual(before.digest, after.digest);
	assert.deepEqual(diffWebgameFingerprints(before, after).changed_components, ['source_snapshot_digest']);
	assert.equal(validateWebgameReceipt(receipt({ fingerprint: before }), { currentFingerprint: after }).status, 'stale');
});

test('adding a worker/source file changes the fingerprint', () => {
	const before = fp();
	const after = fp({
		source_files: [...baseInput().source_files, { path: 'src/new-worker.ts', digest: 'sha256:new-worker' }],
	});
	assert.deepEqual(diffWebgameFingerprints(before, after).changed_components, ['source_files']);
});

test('asset replacement changes the fingerprint', () => {
	const before = fp();
	const after = fp({ assets: [{ path: 'public/player.glb', digest: 'sha256:asset-b' }] });
	assert.deepEqual(diffWebgameFingerprints(before, after).changed_components, ['assets']);
});

test('scenario or assertion-policy weakening cannot reuse the old attestation', () => {
	const before = fp();
	const scenarioChanged = fp({ scenario_digest: 'sha256:scenario-weaker' });
	const assertionsChanged = fp({ assertion_policy_digest: 'sha256:assertions-weaker' });
	assert.equal(isFreshPassingReceipt(receipt({ fingerprint: before }), scenarioChanged, 'desktop-chromium'), false);
	assert.equal(isFreshPassingReceipt(receipt({ fingerprint: before }), assertionsChanged, 'desktop-chromium'), false);
});

test('receipt tampering is rejected even when the verdict still says passed', () => {
	const original = receipt();
	const tampered = structuredClone(original);
	tampered.runtime_result_digest = 'sha256:tampered';
	const result = validateWebgameReceipt(tampered);
	assert.equal(result.status, 'rejected');
	assert.match(result.errors.join(' '), /digest mismatch/);
});

test('embedded fingerprint tampering is rejected even if the outer receipt digest is recomputed', () => {
	const tampered = structuredClone(receipt());
	tampered.fingerprint.material.source_snapshot_digest = 'sha256:forged-source';
	tampered.receipt_digest = computeWebgameReceiptDigest(tampered);
	const result = validateWebgameReceipt(tampered);
	assert.equal(result.status, 'rejected');
	assert.match(result.errors.join(' '), /fingerprint digest mismatch/);
});

test('invalid observed_at is rejected even when the outer receipt digest is recomputed', () => {
	const tampered = structuredClone(receipt());
	tampered.observed_at = 'not-a-time';
	tampered.receipt_digest = computeWebgameReceiptDigest(tampered);
	const result = validateWebgameReceipt(tampered);
	assert.equal(result.status, 'rejected');
	assert.match(result.errors.join(' '), /invalid observed_at/);
});

test('receipt from another run/profile/scenario cannot be reused', () => {
	const value = receipt();
	assert.equal(validateWebgameReceipt(value, { expectedRunId: 'run-2' }).status, 'rejected');
	assert.equal(validateWebgameReceipt(value, { expectedProfileId: 'gpu-chromium' }).status, 'rejected');
	assert.equal(validateWebgameReceipt(value, { expectedScenarioId: 'collision' }).status, 'rejected');
});

test('unsupported and not-run receipts are valid records but never passing attestations', () => {
	for (const verdict of ['unsupported', 'not-run']) {
		const value = receipt({ verdict, run_id: `run-${verdict}` });
		const result = validateWebgameReceipt(value, { currentFingerprint: fp() });
		assert.equal(result.status, 'valid');
		assert.equal(result.passing, false);
	}
});

test('evidence state keeps infrastructure-unavailable separate from assertion failure', () => {
	const current = fp();
	const passed = receipt({ fingerprint: current, observed_at: '2026-09-25T00:00:00Z' });
	const unavailable = receipt({
		fingerprint: current,
		verdict: 'unsupported',
		run_id: 'run-2',
		observed_at: '2026-09-25T00:05:00Z',
	});
	const state = selectWebgameEvidenceState([passed, unavailable], { currentFingerprint: current, profileId: 'desktop-chromium' });
	assert.equal(state.latest_attempt.verdict, 'unsupported');
	assert.equal(state.latest_valid_attestation.verdict, 'passed');
	assert.equal(state.latest_assertion_failure, null);
});

test('a current assertion failure is tracked independently and supersedes an older pass for release', () => {
	const current = fp();
	const passed = receipt({ fingerprint: current, observed_at: '2026-09-25T00:00:00Z' });
	const failed = receipt({
		fingerprint: current,
		verdict: 'failed',
		run_id: 'run-2',
		observed_at: '2026-09-25T00:10:00Z',
	});
	const state = selectWebgameEvidenceState([passed, failed], { currentFingerprint: current, profileId: 'desktop-chromium' });
	assert.equal(state.latest_assertion_failure.verdict, 'failed');
	const release = evaluateWebgameRelease({
		policy: { profile_id: 'desktop-chromium', require_runtime: true, require_performance: false },
		evidenceState: state,
	});
	assert.equal(release.status, 'blocked');
	assert.match(release.reasons.join(' '), /newer runtime assertion failure/);
});

test('run index exposes the same four independent latest-state pointers', () => {
	const current = fp();
	const pass = receipt({ fingerprint: current, observed_at: '2026-09-25T00:00:00Z' });
	const failed = receipt({
		fingerprint: current,
		verdict: 'failed',
		run_id: 'run-2',
		observed_at: '2026-09-25T00:02:00Z',
	});
	const index = buildWebgameRunIndex([pass, failed], { currentFingerprint: current, profileId: 'desktop-chromium' });
	assert.equal(index.latest_attempt.verdict, 'failed');
	assert.equal(index.latest_passing_attempt.verdict, 'passed');
	assert.equal(index.latest_valid_attestation.verdict, 'passed');
	assert.equal(index.latest_assertion_failure.verdict, 'failed');
});

test('a stale historical pass remains latest_passing_attempt but not latest_valid_attestation', () => {
	const oldFingerprint = fp();
	const current = fp({ source_snapshot_digest: 'sha256:new-source' });
	const oldPass = receipt({ fingerprint: oldFingerprint });
	const state = selectWebgameEvidenceState([oldPass], { currentFingerprint: current, profileId: 'desktop-chromium' });
	assert.equal(state.latest_passing_attempt?.verdict, 'passed');
	assert.equal(state.latest_valid_attestation, null);
});

test('required gate profile cannot be bypassed by deletion/downgrade to not-run', () => {
	const profile = {
		profile_id: 'release-desktop',
		requirements: [
			{ name: 'webgame_runtime', allowed_statuses: ['passed'] },
			{ name: 'webgame_performance', allowed_statuses: ['passed'] },
			{ name: 'diagnostics', allowed_statuses: ['passed'], optional: true },
		],
	};
	const result = evaluateGateProfile(profile, { webgame_runtime: 'passed' });
	assert.equal(result.status, 'blocked');
	assert.deepEqual(result.blocking_requirements, ['webgame_performance']);
	assert.deepEqual(result.optional_skips, ['diagnostics']);
});

test('missing or unsupported performance measurement never counts as performance PASS', () => {
	const profile = { profile_id: 'gpu', metrics: { fps: { min: 60 }, frame_ms_p95: { max: 20 } } };
	assert.equal(evaluateWebgamePerformance(profile, null).status, 'not-run');
	assert.equal(evaluateWebgamePerformance(profile, { profile_id: 'gpu', capability_status: 'unsupported' }).status, 'unsupported');
});

test('performance thresholds are measured, profile-bound, and fail closed', () => {
	const profile = { profile_id: 'gpu', metrics: { fps: { min: 60 }, frame_ms_p95: { max: 20 } } };
	assert.equal(evaluateWebgamePerformance(profile, {
		profile_id: 'gpu',
		metrics: { fps: 75, frame_ms_p95: 16 },
	}).status, 'passed');
	assert.equal(evaluateWebgamePerformance(profile, {
		profile_id: 'gpu',
		metrics: { fps: 55, frame_ms_p95: 16 },
	}).status, 'failed');
	assert.equal(evaluateWebgamePerformance(profile, {
		profile_id: 'other-profile',
		metrics: { fps: 75, frame_ms_p95: 16 },
	}).status, 'failed');
});

test('release requires a fresh attestation and required performance evidence', () => {
	const current = fp();
	const state = selectWebgameEvidenceState([receipt({ fingerprint: current })], {
		currentFingerprint: current,
		profileId: 'desktop-chromium',
	});
	const policy = { profile_id: 'desktop-chromium', require_runtime: true, require_performance: true };
	assert.equal(evaluateWebgameRelease({ policy, evidenceState: state }).status, 'blocked');
	const performance = { status: 'passed', passed: true };
	assert.equal(evaluateWebgameRelease({ policy, evidenceState: state, performanceResult: performance }).status, 'passed');
});

test('profile digest changes require re-approval', () => {
	const current = fp();
	const state = selectWebgameEvidenceState([receipt({ fingerprint: current })], {
		currentFingerprint: current,
		profileId: 'desktop-chromium',
	});
	const policy = {
		profile_id: 'desktop-chromium',
		profile_digest: 'sha256:approved',
		require_runtime: true,
		require_performance: false,
	};
	const result = evaluateWebgameRelease({
		policy,
		evidenceState: state,
		currentProfileDigest: 'sha256:changed',
	});
	assert.equal(result.status, 'blocked');
	assert.match(result.reasons.join(' '), /profile digest mismatch/);
});

test('release policy can explicitly omit runtime without inventing a missing-attestation failure', () => {
	const policy = { profile_id: 'docs-only', require_runtime: false, require_performance: false };
	const result = evaluateWebgameRelease({ policy, evidenceState: {} });
	assert.equal(result.status, 'passed');
	assert.deepEqual(result.reasons, []);
});
