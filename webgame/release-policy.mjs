function time(receipt) {
	const parsed = Date.parse(receipt?.observed_at);
	return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function evaluateWebgameRelease({
	policy,
	evidenceState,
	performanceResult = null,
	gateProfileResult = null,
	currentProfileDigest = null,
}) {
	if (!policy || typeof policy !== 'object') throw new Error('release policy is required');
	const reasons = [];
	const attestation = evidenceState?.latest_valid_attestation ?? null;
	const failure = evidenceState?.latest_assertion_failure ?? null;
	const attempt = evidenceState?.latest_attempt ?? null;

	if (!attestation) reasons.push('fresh runtime attestation missing');
	if (attestation && attestation.profile_id !== policy.profile_id) reasons.push('runtime attestation profile mismatch');
	if (policy.profile_digest && currentProfileDigest !== policy.profile_digest) reasons.push('approved profile digest mismatch');

	if (failure && (!attestation || time(failure) > time(attestation))) {
		reasons.push('newer runtime assertion failure exists');
	}

	if (attempt && attestation && time(attempt) > time(attestation) &&
		['unsupported', 'not-run', 'blocked'].includes(attempt.verdict)) {
		reasons.push('latest verification attempt is incomplete');
	}

	if (policy.require_performance) {
		if (!performanceResult) reasons.push('required performance evidence missing');
		else if (performanceResult.status !== 'passed') reasons.push(`required performance status is ${performanceResult.status}`);
	}

	if (gateProfileResult && gateProfileResult.status !== 'passed') {
		reasons.push('required gate profile is blocked');
	}

	return {
		status: reasons.length === 0 ? 'passed' : 'blocked',
		passed: reasons.length === 0,
		reasons,
		profile_id: policy.profile_id,
	};
}
