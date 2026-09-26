export const WEBGAME_PERFORMANCE_STATUSES = Object.freeze(['passed', 'failed', 'not-run', 'unsupported']);

function finite(value) {
	return typeof value === 'number' && Number.isFinite(value);
}

export function evaluateWebgamePerformance(profile, measurement) {
	if (!profile || typeof profile !== 'object') throw new Error('performance profile is required');
	if (!measurement) {
		return { status: 'not-run', passed: false, reasons: ['performance measurement missing'], metrics: {} };
	}
	if (measurement.capability_status === 'unsupported') {
		return { status: 'unsupported', passed: false, reasons: ['required performance capability unsupported'], metrics: {} };
	}
	const reasons = [];
	if (measurement.profile_id !== profile.profile_id) reasons.push('profile_id mismatch');
	const metrics = {};
	for (const [name, rule] of Object.entries(profile.metrics ?? {})) {
		const value = measurement.metrics?.[name];
		let passed = finite(value);
		if (!passed) {
			metrics[name] = { value: value ?? null, passed: false, reason: 'missing_or_non_finite' };
			reasons.push(`metric ${name} missing or non-finite`);
			continue;
		}
		if (finite(rule.min) && value < rule.min) passed = false;
		if (finite(rule.max) && value > rule.max) passed = false;
		metrics[name] = { value, passed, min: rule.min ?? null, max: rule.max ?? null };
		if (!passed) reasons.push(`metric ${name} outside approved range`);
	}
	const passed = reasons.length === 0;
	return { status: passed ? 'passed' : 'failed', passed, reasons, metrics };
}
