// G6-A: a read-only boundary for game-loop contracts. This is deliberately narrower than GTA's
// Python game-plan compiler: JSON Schema owns shape and this module owns cross-reference integrity;
// expression evaluation and Unreal artifact emission belong to later provider work.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const GAME_CONTRACT_SUFFIX = '.game.json';
const GAME_CONTRACT_SCHEMA_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'game-contract.schema.json',
);

let validator = null;

export class GameContractError extends Error {
	constructor(message, { file = null, errors = [] } = {}) {
		super(message);
		this.name = 'GameContractError';
		this.file = file;
		this.errors = errors;
	}
}

function getValidator() {
	if (validator) return validator;
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const schema = JSON.parse(fs.readFileSync(GAME_CONTRACT_SCHEMA_PATH, 'utf8'));
	validator = ajv.compile(schema);
	return validator;
}

function formatSchemaErrors(errors) {
	return (errors ?? []).map((error) => `${error.instancePath || '(root)'} ${error.message}`);
}

function hasOwn(object, key) {
	return Object.hasOwn(object, key);
}

function sortedEntries(object) {
	return Object.entries(object).sort(([left], [right]) => left.localeCompare(right));
}

function collectTaskIds(objectives, errors) {
	const tasks = new Set();
	for (const [objectiveId, objective] of Object.entries(objectives)) {
		for (const node of objective.nodes) {
			for (const task of node.tasks) {
				if (tasks.has(task.id)) errors.push(`objective task "${task.id}" is declared more than once (latest: ${objectiveId}/${node.id})`);
				tasks.add(task.id);
			}
		}
	}
	return tasks;
}

// The schema cannot express map membership. Keep these checks intentionally referential: G6-A
// does not duplicate GTA's expression grammar/static checker, which remains its authoritative
// semantic implementation until the Unreal provider takes ownership of it.
export function semanticErrors(contract) {
	const errors = [];
	const objectives = new Set(Object.keys(contract.objectives));
	const states = new Set(Object.keys(contract.state));
	const anchors = new Set(Object.keys(contract.anchors));
	const populations = new Set(Object.keys(contract.populations));
	const events = new Set(Object.keys(contract.events));
	const tasks = collectTaskIds(contract.objectives, errors);
	const derives = new Set();

	for (const derive of contract.rules.derive) {
		if (states.has(derive.name) || derives.has(derive.name)) errors.push(`derive "${derive.name}" collides with an existing state or derive name`);
		derives.add(derive.name);
	}
	for (const [eventId, event] of Object.entries(contract.events)) {
		if (['enter', 'exit', 'interact'].includes(event.source) && !anchors.has(event.anchor)) {
			errors.push(`event "${eventId}" references missing anchor "${event.anchor}"`);
		}
		if (event.source === 'state_changed' && !states.has(event.state)) {
			errors.push(`event "${eventId}" references missing state "${event.state}"`);
		}
		if (event.source === 'objective' && !objectives.has(event.objective)) {
			errors.push(`event "${eventId}" references missing objective "${event.objective}"`);
		}
	}
	for (const [populationId, population] of Object.entries(contract.populations)) {
		if (!anchors.has(population.spawn.anchor)) errors.push(`population "${populationId}" references missing anchor "${population.spawn.anchor}"`);
	}
	for (const [objectiveId, objective] of Object.entries(contract.objectives)) {
		for (const prerequisite of objective.prerequisites ?? []) {
			if (!objectives.has(prerequisite)) errors.push(`objective "${objectiveId}" references missing prerequisite "${prerequisite}"`);
		}
	}
	for (const requirement of contract.rules.require) {
		if (requirement.on_violation?.verb === 'fail' && !objectives.has(requirement.on_violation.objective)) {
			errors.push(`requirement "${requirement.id}" fails missing objective "${requirement.on_violation.objective}"`);
		}
	}
	for (const rule of contract.rules.on) {
		if (!events.has(rule.event)) errors.push(`rule "${rule.id}" references missing event "${rule.event}"`);
		for (const effect of rule.effects) {
			if (effect.verb === 'set' && !states.has(effect.state)) errors.push(`rule "${rule.id}" sets missing state "${effect.state}"`);
			if (effect.verb === 'advance' && !tasks.has(effect.objective)) errors.push(`rule "${rule.id}" advances missing task "${effect.objective}"`);
			if (effect.verb === 'fail' && !objectives.has(effect.objective)) errors.push(`rule "${rule.id}" fails missing objective "${effect.objective}"`);
			if (['spawn', 'despawn'].includes(effect.verb) && !populations.has(effect.population_id)) errors.push(`rule "${rule.id}" ${effect.verb}s missing population "${effect.population_id}"`);
			if (['enable', 'disable'].includes(effect.verb) && !anchors.has(effect.anchor)) errors.push(`rule "${rule.id}" ${effect.verb}s missing anchor "${effect.anchor}"`);
		}
	}
	return errors;
}

function normalizeMap(map) {
	return sortedEntries(map).map(([id, value]) => ({ id, ...value }));
}

function normalizeObjectives(objectives) {
	return sortedEntries(objectives).map(([id, objective]) => ({
		id,
		...objective,
		nodes: objective.nodes.map((node) => ({ ...node, tasks: node.tasks.map((task) => ({ ...task })) })),
	}));
}

function normalizeRules(rules) {
	return {
		require: rules.require.map((rule) => ({ ...rule, on_violation: rule.on_violation ? { ...rule.on_violation } : undefined })),
		derive: rules.derive.map((rule) => ({ ...rule })),
		on: [...rules.on]
			.sort((left, right) => left.event.localeCompare(right.event) || left.order - right.order || left.id.localeCompare(right.id))
			.map((rule) => ({ ...rule, effects: rule.effects.map((effect) => ({ ...effect })) })),
	};
}

export function parseGameContract(contract, { file = null } = {}) {
	const validate = getValidator();
	if (!validate(contract)) {
		const errors = formatSchemaErrors(validate.errors);
		throw new GameContractError(`invalid game contract${file ? ` at ${file}` : ''}: ${errors.join('; ')}`, { file, errors });
	}
	const errors = semanticErrors(contract);
	if (errors.length > 0) {
		throw new GameContractError(`invalid game contract references${file ? ` at ${file}` : ''}: ${errors.join('; ')}`, { file, errors });
	}
	const events = normalizeMap(contract.events);
	return {
		schema: 'sbf.gameplay-contract/1',
		file,
		loop_id: contract.loop_id,
		loop_uid: contract.loop_uid,
		source: { ...contract.source },
		state: normalizeMap(contract.state),
		events,
		anchors: normalizeMap(contract.anchors),
		populations: normalizeMap(contract.populations),
		objectives: normalizeObjectives(contract.objectives),
		rules: normalizeRules(contract.rules),
		warnings: contract.warnings.map((warning) => ({ ...warning, detail: warning.detail ? { ...warning.detail } : undefined })),
		completeness: { ...contract.completeness },
		summary: {
			state_count: Object.keys(contract.state).length,
			event_count: events.length,
			timer_event_count: events.filter((event) => event.source === 'timer').length,
			anchor_count: Object.keys(contract.anchors).length,
			population_count: Object.keys(contract.populations).length,
			objective_count: Object.keys(contract.objectives).length,
			rule_count: contract.rules.on.length,
		},
	};
}

function walkGameContracts(root, directory, files) {
	if (!fs.existsSync(directory)) return;
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const candidate = path.join(directory, entry.name);
		if (entry.isDirectory()) walkGameContracts(root, candidate, files);
		else if (entry.isFile() && entry.name.endsWith(GAME_CONTRACT_SUFFIX)) files.push(path.relative(root, candidate));
	}
}

export function listGameContractFiles(repoRoot) {
	const files = [];
	walkGameContracts(repoRoot, path.join(repoRoot, 'specs'), files);
	return files.sort((left, right) => left.localeCompare(right));
}

function assertCanonicalGameContractPath(repoRoot, relativeFile, contract) {
	const parts = relativeFile.split(path.sep);
	if (parts.length !== 4 || parts[0] !== 'specs' || parts[2] !== 'contracts' || parts[1] !== contract.loop_id || parts[3] !== `${contract.loop_id}.game.json`) {
		throw new GameContractError(`game contract path "${relativeFile}" must be specs/<loop_id>/contracts/<loop_id>.game.json`, { file: relativeFile });
	}
	const absolute = path.resolve(repoRoot, relativeFile);
	const root = path.resolve(repoRoot) + path.sep;
	if (!absolute.startsWith(root)) throw new GameContractError(`game contract path escapes repo root: "${relativeFile}"`, { file: relativeFile });
}

export function readGameContracts(repoRoot) {
	const files = listGameContractFiles(repoRoot);
	const contracts = files.map((relativeFile) => {
		const absolute = path.join(repoRoot, relativeFile);
		let document;
		try {
			document = JSON.parse(fs.readFileSync(absolute, 'utf8'));
		} catch (error) {
			throw new GameContractError(`could not read game contract "${relativeFile}": ${error.message}`, { file: relativeFile });
		}
		assertCanonicalGameContractPath(repoRoot, relativeFile, document);
		return parseGameContract(document, { file: relativeFile });
	});
	const loopIds = new Set();
	for (const contract of contracts) {
		if (loopIds.has(contract.loop_id)) throw new GameContractError(`loop_id "${contract.loop_id}" appears in more than one game contract`, { file: contract.file });
		loopIds.add(contract.loop_id);
	}
	return { contracts, files_read: files };
}
