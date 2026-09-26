function requireSafeBytes(name, value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
	return value;
}

function requireFraction(name, value) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
		throw new TypeError(`${name} must be a finite number in [0, 1)`);
	}
	return value;
}

// Pure admission calculation: callers provide the observed host/container memory limit. This does
// not call os.totalmem() because a process may be inside a container/cgroup with a lower effective
// ceiling. The reserve is never silently violated to make work start.
export function deriveMemoryAdmission({
	totalBytes,
	reserveFraction = 0.25,
	minReserveBytes = 8 * 1024 * 1024 * 1024,
	maxAdmissionBytes = null,
} = {}) {
	requireSafeBytes('totalBytes', totalBytes);
	requireFraction('reserveFraction', reserveFraction);
	requireSafeBytes('minReserveBytes', minReserveBytes);
	if (maxAdmissionBytes !== null) requireSafeBytes('maxAdmissionBytes', maxAdmissionBytes);

	const fractionalReserve = Math.ceil(totalBytes * reserveFraction);
	const requiredReserveBytes = Math.max(fractionalReserve, minReserveBytes);
	const availableAfterReserve = Math.max(0, totalBytes - requiredReserveBytes);
	const admissionBytes = maxAdmissionBytes === null
		? availableAfterReserve
		: Math.min(availableAfterReserve, maxAdmissionBytes);

	return {
		schema: 'sbf.scan-memory-admission/1',
		status: admissionBytes > 0 ? 'ready' : 'blocked',
		total_bytes: totalBytes,
		reserve_fraction: reserveFraction,
		fractional_reserve_bytes: fractionalReserve,
		min_reserve_bytes: minReserveBytes,
		required_reserve_bytes: requiredReserveBytes,
		admission_bytes: admissionBytes,
		max_admission_bytes: maxAdmissionBytes,
		...(admissionBytes > 0 ? {} : { reason: 'INSUFFICIENT_MEMORY_AFTER_RESERVE' }),
	};
}
