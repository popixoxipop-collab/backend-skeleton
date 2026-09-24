export const WEBGAME_GATE_NAMES = Object.freeze({
	INVENTORY: 'webgame_inventory',
	RUNTIME: 'webgame_runtime',
	PERFORMANCE: 'webgame_performance',
	RELEASE: 'webgame_release',
});

export const WEBGAME_REQUIRED_PASS_STATUS = 'passed';

export function webgameGateRequirement(name, { optional = false, allowed_statuses = ['passed'] } = {}) {
	return {
		name,
		optional,
		allowed_statuses: [...new Set(allowed_statuses)].sort(),
	};
}
