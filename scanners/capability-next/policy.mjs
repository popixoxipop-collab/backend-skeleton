import { isCapabilityStatus, normalizeCapabilityMap } from './records.mjs';

const DEFAULT_ACCEPTED = Object.freeze(['supported']);

function requirement(req, index) {
	if (!req || typeof req !== 'object' || Array.isArray(req)) throw new TypeError(`requirements[${index}] must be an object`);
	if (typeof req.capability !== 'string' || req.capability.trim() === '') throw new TypeError(`requirements[${index}].capability must be a non-empty string`);
	const acceptedStatuses = req.acceptedStatuses === undefined ? DEFAULT_ACCEPTED : req.acceptedStatuses;
	if (!Array.isArray(acceptedStatuses) || acceptedStatuses.length === 0) throw new TypeError(`requirements[${index}].acceptedStatuses must be a non-empty array`);
	for (const status of acceptedStatuses) {
		if (!isCapabilityStatus(status)) throw new TypeError(`requirements[${index}] has unknown status ${status}`);
	}
	if (new Set(acceptedStatuses).size !== acceptedStatuses.length) throw new TypeError(`requirements[${index}].acceptedStatuses must not contain duplicates`);
	if (acceptedStatuses.includes('unknown')) throw new TypeError('unknown cannot be an accepted capability status');
	return Object.freeze({ capability: req.capability, acceptedStatuses: Object.freeze([...acceptedStatuses]) });
}

export function evaluateCapabilityPolicy({ capabilities = {}, requirements = [], policyId = 'anonymous-policy' } = {}) {
	if (typeof policyId !== 'string' || policyId.trim() === '') throw new TypeError('policyId must be a non-empty string');
	if (!Array.isArray(requirements)) throw new TypeError('requirements must be an array');
	const caps = normalizeCapabilityMap(capabilities);
	const decisions = requirements.map(requirement).map((req) => {
		const record = caps[req.capability] ?? null;
		if (!record) return Object.freeze({
			capability: req.capability, allowed: false, status: 'unknown',
			reason: 'capability record is missing', acceptedStatuses: req.acceptedStatuses,
			evidenceRefs: Object.freeze([]),
		});
		const allowed = record.status !== 'unknown' && req.acceptedStatuses.includes(record.status);
		return Object.freeze({
			capability: req.capability, allowed, status: record.status,
			reason: allowed ? null : (record.reason ?? `status ${record.status} is not accepted by this policy`),
			acceptedStatuses: req.acceptedStatuses, evidenceRefs: record.evidenceRefs,
		});
	});
	const missing = decisions.filter((x) => !x.allowed);
	return Object.freeze({
		policyId, allowed: missing.length === 0,
		decisions: Object.freeze(decisions), missing: Object.freeze(missing),
	});
}
