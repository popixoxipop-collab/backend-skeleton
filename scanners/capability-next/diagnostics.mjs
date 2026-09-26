function assertPolicyResult(result) {
	if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('policy result must be an object');
	if (typeof result.policyId !== 'string' || result.policyId.trim() === '') throw new TypeError('policy result requires policyId');
	if (!Array.isArray(result.decisions) || !Array.isArray(result.missing)) throw new TypeError('policy result requires decisions and missing arrays');
	return result;
}

function diagnosticCode(decision) {
	if (decision.reason === 'capability record is missing') return 'CAPABILITY_MISSING';
	if (decision.status === 'unknown') return 'CAPABILITY_UNKNOWN';
	return 'CAPABILITY_STATUS_REJECTED';
}

export function policyDiagnostics(result) {
	assertPolicyResult(result);
	return Object.freeze(result.missing.map((decision) => Object.freeze({
		code: diagnosticCode(decision),
		severity: 'blocked',
		policyId: result.policyId,
		capability: decision.capability,
		status: decision.status,
		acceptedStatuses: Object.freeze([...(decision.acceptedStatuses ?? [])]),
		evidenceRefs: Object.freeze([...(decision.evidenceRefs ?? [])]),
		reason: decision.reason,
		nextAction: decision.status === 'unknown'
			? 'supply evidence that can produce a non-unknown capability record, or choose a command/profile that does not require this capability'
			: 'use a policy that explicitly accepts this status only when the operation semantics genuinely allow it',
	})));
}

export function renderPolicyExplain(result) {
	assertPolicyResult(result);
	if (result.allowed) return `policy ${result.policyId}: allowed`;
	const lines = [`policy ${result.policyId}: blocked (${result.missing.length} capability requirement(s) not satisfied)`];
	for (const item of policyDiagnostics(result)) {
		lines.push(`- [${item.code}] ${item.capability}: ${item.status}; accepted=${item.acceptedStatuses.join(',')}; ${item.reason}`);
	}
	return lines.join('\n');
}
