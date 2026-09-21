import { plan } from './unreal-python/plan.mjs';

// G6-B. This provider only produces a checked, deterministic planning document. It intentionally
// has no emit() and no codegen.gameplay requirement: later work must add actual, manifest-owned UE
// outputs before the adapter can truthfully advertise code generation.
export const provider = {
	contract: 'sbf.gameplay-provider/1',
	id: 'unreal-python',
	title: 'Unreal Engine game-loop contract planner',
	requiresCapabilities: ['game.events', 'game.population', 'game.objectives'],
	outputs: { spec: [] },
	plan,
};
