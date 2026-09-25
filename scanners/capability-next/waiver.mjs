const NON_WAIVABLE = Object.freeze(new Set([
	'identity.hash-mismatch',
	'trust.sandbox-escape',
	'trust.secret-leak',
	'evidence.replay',
	'contract.unknown-major',
]));

export const NON_WAIVABLE_FAILURE_CODES = Object.freeze([...NON_WAIVABLE].sort());

function nonEmpty(value, name) {
	if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
	return value;
}

export function evaluateWaiver({ waiver, failureCode, now = new Date() } = {}) {
	nonEmpty(failureCode, 'failureCode');
	if (NON_WAIVABLE.has(failureCode)) return Object.freeze({
		allowed: false, reason: `${failureCode} is non-waivable`, failureCode,
	});
	if (!waiver || typeof waiver !== 'object' || Array.isArray(waiver)) {
		return Object.freeze({ allowed: false, reason: 'no waiver supplied', failureCode });
	}
	for (const field of ['scope', 'reason', 'approver', 'expiresAt']) nonEmpty(waiver[field], `waiver.${field}`);
	if (!Array.isArray(waiver.failureCodes) || waiver.failureCodes.some((x) => typeof x !== 'string' || x.trim() === '')) {
		throw new TypeError('waiver.failureCodes must be an array of non-empty strings');
	}
	if (!waiver.failureCodes.includes(failureCode)) return Object.freeze({
		allowed: false, reason: `waiver does not cover ${failureCode}`, failureCode,
	});
	if (waiver.failureCodes.some((code) => NON_WAIVABLE.has(code))) return Object.freeze({
		allowed: false, reason: 'waiver attempts to cover a non-waivable failure code', failureCode,
	});
	const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
	const expiresMs = new Date(waiver.expiresAt).getTime();
	if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid date');
	if (!Number.isFinite(expiresMs)) throw new TypeError('waiver.expiresAt must be a valid date-time');
	if (expiresMs <= nowMs) return Object.freeze({ allowed: false, reason: 'waiver is expired', failureCode });
	return Object.freeze({
		allowed: true, reason: null, failureCode,
		scope: waiver.scope, approver: waiver.approver, expiresAt: waiver.expiresAt,
	});
}
