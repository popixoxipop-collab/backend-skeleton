// G6-B: converts the parser's normalized contract IR into an emitter-facing plan without trying
// to duplicate GTA's Python expression semantics or writing a UE asset. Future emit() work must
// consume this contract rather than recover input facts from unvalidated JSON a second time.

const DEFERRED_OUTPUTS = Object.freeze([
	'game_plan.json',
	'stage_e_emit_population.py',
	'stage_e_emit_interactables.py',
	'stage_e_emit_objectives.py',
	'stage_e_emit_ruleset.py',
	'cold_verify_game.py',
]);

function taskCount(objective) {
	return objective.nodes.reduce((count, node) => count + node.tasks.length, 0);
}

function loopPlan(contract) {
	return {
		loop_id: contract.loop_id,
		loop_uid: contract.loop_uid,
		contract_file: contract.file,
		world: contract.source.world,
		provenance: contract.source.provenance,
		completeness: { ...contract.completeness },
		summary: { ...contract.summary },
		events: contract.events.map((event) => ({ id: event.id, source: event.source, scope: event.scope })),
		populations: contract.populations.map((population) => ({
			id: population.id,
			config_asset: population.config_asset,
			generator: population.spawn.generator,
			anchor: population.spawn.anchor,
			count: population.spawn.count,
		})),
		objectives: contract.objectives.map((objective) => ({ id: objective.id, task_count: taskCount(objective) })),
		rules: contract.rules.on.map((rule) => ({
			id: rule.id,
			event: rule.event,
			effect_verbs: rule.effects.map((effect) => effect.verb),
		})),
	};
}

// contracts is supplied by gameplay/contracts.mjs's single canonical read. Reading it again here
// would create two independent read-sets and let a file change between validation and planning.
export function plan({ contracts, loopId = null } = {}) {
	if (!Array.isArray(contracts)) throw new Error('unreal-python gameplay provider requires normalized contracts from gameplay/contracts.mjs');
	const available = contracts.filter((contract) => contract.source.adapter === 'unreal-python');
	const selected = loopId === null ? available : available.filter((contract) => contract.loop_id === loopId);
	if (loopId !== null && selected.length === 0) {
		const known = available.map((contract) => contract.loop_id).join(', ') || '(none)';
		throw new Error(`no unreal-python game contract named "${loopId}" -- known loop ids: ${known}`);
	}
	return {
		schema: 'sbf.gameplay-plan/1',
		provider: 'unreal-python',
		emission: {
			available: false,
			blocked_by: ['codegen.gameplay'],
			deferred_outputs: [...DEFERRED_OUTPUTS],
		},
		loops: selected.map(loopPlan),
		notes: [
			'This is a read-only plan over canonical, schema-validated game contracts; no Unreal file was generated.',
			'Expression evaluation and UE artifact ownership remain with the project pipeline until a manifest-backed emitter is implemented.',
			...(loopId === null && selected.length > 1 ? ['Pass --loop <id> before a future emit command to select exactly one game loop.'] : []),
		],
	};
}
