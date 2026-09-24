import { createHash } from 'node:crypto';
import { sortKeysDeep } from '../lib/gates.mjs';
import { WEBGAME_FINGERPRINT_SCHEMA, isWebgameFingerprintCurrent } from './fingerprint.mjs';

export const WEBGAME_RECEIPT_SCHEMA = 'sbf.webgame-receipt/1';
export const WEBGAME_VERDICTS = Object.freeze(['passed', 'failed', 'blocked', 'unsupported', 'not-run']);

function requiredString(value, name) {
	if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`);
	return value;
}

function canonicalDigest(value) {
	return `sha256:${createHash('sha256').update(JSON.stringify(sortKeysDeep(value))).digest('hex')}`;
}

export function receiptPayload(receipt) {
	const { receipt_digest: _ignored, ...payload } = receipt ?? {};
	return sortKeysDeep(payload);
}

export function computeWebgameReceiptDigest(receipt) {
	return canonicalDigest(receiptPayload(receipt));
}

export function createWebgameReceipt({
	run_id,
	profile_id,
	scenario_id,
	verdict,
	fingerprint,
	runtime_result_digest,
	observed_at = new Date().toISOString(),
	assertion_failure = null,
	capability_status = 'available',
	evidence = {},
}) {
	requiredString(run_id, 'run_id');
	requiredString(profile_id, 'profile_id');
	requiredString(scenario_id, 'scenario_id');
	requiredString(runtime_result_digest, 'runtime_result_digest');
	if (!WEBGAME_VERDICTS.includes(verdict)) throw new Error(`unsupported verdict: ${verdict}`);
	if (!fingerprint || fingerprint.schema !== WEBGAME_FINGERPRINT_SCHEMA || typeof fingerprint.digest !== 'string') {
		throw new Error('fingerprint must be an sbf.webgame-fingerprint/1 object');
	}
	if (!Number.isFinite(Date.parse(observed_at))) throw new Error('observed_at must be an ISO timestamp');
	const receipt = {
		schema: WEBGAME_RECEIPT_SCHEMA,
		run_id,
		profile_id,
		scenario_id,
		verdict,
		fingerprint,
		runtime_result_digest,
		observed_at,
		capability_status,
		assertion_failure,
		evidence,
	};
	return { ...receipt, receipt_digest: computeWebgameReceiptDigest(receipt) };
}

export function validateWebgameReceipt(receipt, {
	expectedRunId = null,
	expectedProfileId = null,
	expectedScenarioId = null,
	currentFingerprint = null,
} = {}) {
	const errors = [];
	if (!receipt || typeof receipt !== 'object') return { ok: false, status: 'rejected', errors: ['receipt must be an object'] };
	if (receipt.schema !== WEBGAME_RECEIPT_SCHEMA) errors.push('schema mismatch');
	if (!WEBGAME_VERDICTS.includes(receipt.verdict)) errors.push('invalid verdict');
	if (!receipt.receipt_digest || computeWebgameReceiptDigest(receipt) !== receipt.receipt_digest) errors.push('receipt digest mismatch');
	if (expectedRunId != null && receipt.run_id !== expectedRunId) errors.push('run_id mismatch');
	if (expectedProfileId != null && receipt.profile_id !== expectedProfileId) errors.push('profile_id mismatch');
	if (expectedScenarioId != null && receipt.scenario_id !== expectedScenarioId) errors.push('scenario_id mismatch');
	if (errors.length > 0) return { ok: false, status: 'rejected', errors };

	if (currentFingerprint && !isWebgameFingerprintCurrent(receipt.fingerprint, currentFingerprint)) {
		return {
			ok: true,
			status: 'stale',
			errors: [],
			passing: false,
			stale_reason: 'fingerprint_changed',
		};
	}
	return {
		ok: true,
		status: 'valid',
		errors: [],
		passing: receipt.verdict === 'passed',
		stale_reason: null,
	};
}

function timestamp(receipt) {
	const value = Date.parse(receipt?.observed_at);
	return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function newest(receipts) {
	return [...receipts].sort((a, b) => timestamp(b) - timestamp(a))[0] ?? null;
}

function sameCurrentFingerprint(receipt, currentFingerprint) {
	return !currentFingerprint || isWebgameFingerprintCurrent(receipt?.fingerprint, currentFingerprint);
}

export function selectWebgameEvidenceState(receipts, {
	currentFingerprint = null,
	profileId = null,
} = {}) {
	const accepted = (receipts ?? []).filter((receipt) => {
		const validation = validateWebgameReceipt(receipt);
		return validation.ok && validation.status === 'valid' && (!profileId || receipt.profile_id === profileId);
	});
	const current = accepted.filter((receipt) => sameCurrentFingerprint(receipt, currentFingerprint));
	const latestAttempt = newest(current);
	const latestPassingAttempt = newest(accepted.filter((receipt) => receipt.verdict === 'passed'));
	const latestValidAttestation = newest(current.filter((receipt) => receipt.verdict === 'passed'));
	const latestAssertionFailure = newest(current.filter((receipt) => receipt.verdict === 'failed'));
	return {
		latest_attempt: latestAttempt,
		latest_passing_attempt: latestPassingAttempt,
		latest_valid_attestation: latestValidAttestation,
		latest_assertion_failure: latestAssertionFailure,
	};
}

export function isFreshPassingReceipt(receipt, currentFingerprint, expectedProfileId = null) {
	const result = validateWebgameReceipt(receipt, {
		expectedProfileId,
		currentFingerprint,
	});
	return result.ok && result.status === 'valid' && result.passing === true;
}
