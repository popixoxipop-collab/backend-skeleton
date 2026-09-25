export {
	CAPABILITY_STATUSES,
	isCapabilityStatus,
	capabilityRecord,
	fromLegacyBoolean,
	fromLegacyCapabilities,
	normalizeCapabilityMap,
} from './records.mjs';

export { evaluateCapabilityPolicy } from './policy.mjs';
export { NON_WAIVABLE_FAILURE_CODES, evaluateWaiver } from './waiver.mjs';
export {
	SUPPORT_LEVELS,
	CODEGEN_STATES,
	certificationRecord,
	buildSupportMatrix,
} from './certification.mjs';

export {
	legacyCommandRequirements,
	legacyProviderRequirements,
	legacySatisfierHints,
	externalCapabilityFromLegacySatisfier,
	evaluateLegacyCommandPolicy,
	evaluateLegacyProviderPolicy,
	buildLegacyCompatibilityView,
} from './compatibility.mjs';

export { policyDiagnostics, renderPolicyExplain } from './diagnostics.mjs';
