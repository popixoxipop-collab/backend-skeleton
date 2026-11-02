import { sortKeysDeep } from './gates.mjs';

export function evaluateGateProfile(profile, observations = {}) {
	if (!profile || typeof profile !== 'object') throw new Error('gate profile is required');
	const requirements = profile.requirements ?? [];
	const results = requirements.map((requirement) => {
		const observed = observations[requirement.name] ?? 'not-run';
		const allowed = requirement.allowed_statuses ?? ['passed'];
		const satisfied = allowed.includes(observed);
		return {
			name: requirement.name,
			optional: Boolean(requirement.optional),
			observed,
			allowed_statuses: [...allowed].sort(),
			satisfied,
			blocking: !requirement.optional && !satisfied,
		};
	});
	const blocking = results.filter((entry) => entry.blocking);
	return sortKeysDeep({
		profile_id: profile.profile_id ?? null,
		status: blocking.length === 0 ? 'passed' : 'blocked',
		passed: blocking.length === 0,
		requirements: results,
		optional_skips: results.filter((entry) => entry.optional && !entry.satisfied).map((entry) => entry.name),
		blocking_requirements: blocking.map((entry) => entry.name),
	});
}
