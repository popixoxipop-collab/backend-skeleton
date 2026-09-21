import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { GameContractError, parseGameContract, readGameContracts } from '../gameplay/contracts.mjs';
import { runScan } from '../scanners/index.mjs';

function contract() {
	return {
		sbf_game_contract: '1', loop_id: '001-game-loop', loop_uid: 'loop-001',
		source: { adapter: 'unreal-python', world: 'Lvl_Test', provenance: 'hand-authored' },
		state: { flag: { scope: 'player', type: 'bool', initial: false } },
		events: {
			E_ENTER: { source: 'enter', anchor: 'A_START', scope: 'player' },
			E_TIMER: { source: 'timer', period_s: 10, scope: 'world' },
			E_CHANGED: { source: 'state_changed', state: 'flag', scope: 'player' },
			E_OBJECTIVE: { source: 'objective', objective: 'Q_MAIN', status: 'completed', scope: 'player' },
			E_AGENT: { source: 'agent_event', class: 'pedestrian', tag: 'alerted', scope: 'agent_class' },
		},
		anchors: { A_START: { kind: 'checkpoint', ref: { world_anchor_id: 'road.test.lane.leg0' }, tags: ['start'] } },
		populations: { P_CROWD: { config_asset: 'EC_Pedestrian', spawn: { generator: 'zonegraph', anchor: 'A_START', count: 2 } } },
		objectives: { Q_MAIN: { title_key: 'UI.Quest.Main', auto_accept: true, prerequisites: [], nodes: [{ id: 'O_MAIN', sequential: true, required_of: -1, tasks: [{ id: 'T_MAIN', mandatory: true, target: 1, time_limit_s: 0 }] }] } },
		rules: {
			require: [{ id: 'RQ_MAIN', scope: 'global', pred: 'flag == false', on_violation: { verb: 'fail', objective: 'Q_MAIN' } }],
			derive: [{ id: 'DV_MAIN', name: 'main_ready', type: 'bool', expr: 'flag == false' }],
			on: [{ id: 'R_ENTER', event: 'E_ENTER', order: 10, effects: [
				{ verb: 'set', state: 'flag', expr: 'true' }, { verb: 'advance', objective: 'T_MAIN', n: 1 },
				{ verb: 'fail', objective: 'Q_MAIN' }, { verb: 'spawn', population_id: 'P_CROWD' },
				{ verb: 'despawn', population_id: 'P_CROWD' }, { verb: 'enable', anchor: 'A_START' },
				{ verb: 'disable', anchor: 'A_START' }, { verb: 'notify', message_id: 'UI.Msg.Main' },
			]}],
		},
		warnings: [], completeness: { status: 'complete', event_count: 5, objective_count: 1, anchor_count: 1 },
	};
}

test('parseGameContract validates and deterministically normalizes the complete gameplay vocabulary', () => {
	const parsed = parseGameContract(contract(), { file: 'specs/001-game-loop/contracts/001-game-loop.game.json' });
	assert.equal(parsed.schema, 'sbf.gameplay-contract/1');
	assert.deepEqual(parsed.events.map((event) => event.id), ['E_AGENT', 'E_CHANGED', 'E_ENTER', 'E_OBJECTIVE', 'E_TIMER']);
	assert.equal(parsed.summary.timer_event_count, 1);
	assert.equal(parsed.summary.population_count, 1);
	assert.equal(parsed.summary.objective_count, 1);
	assert.equal(parsed.rules.on[0].effects.length, 8);
});

test('parseGameContract fails closed on unknown shape fields', () => {
	const value = contract();
	value.events.E_TIMER.anchor = 'A_START';
	assert.throws(() => parseGameContract(value), (error) => error instanceof GameContractError && error.errors.some((line) => line.includes('must NOT have additional properties')));
});

test('parseGameContract fails closed on cross-reference errors the JSON Schema cannot express', () => {
	const value = contract();
	value.rules.on[0].effects[0].state = 'missing_state';
	assert.throws(() => parseGameContract(value), (error) => error instanceof GameContractError && error.errors.includes('rule "R_ENTER" sets missing state "missing_state"'));
});

test('readGameContracts accepts canonical contract paths and reports the exact read-set', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-game-contract-'));
	const directory = path.join(root, 'specs', '001-game-loop', 'contracts');
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, '001-game-loop.game.json'), JSON.stringify(contract()));
	const result = readGameContracts(root);
	assert.deepEqual(result.files_read, [path.join('specs', '001-game-loop', 'contracts', '001-game-loop.game.json')]);
	assert.equal(result.contracts[0].loop_id, '001-game-loop');
});

test('the Unreal scanner exposes parsed game contracts separately from REST-style modules', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-unreal-game-contract-'));
	const directory = path.join(root, 'specs', '001-game-loop', 'contracts');
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(root, 'Example.uproject'), JSON.stringify({ FileVersion: 3, EngineAssociation: '5.8' }));
	fs.writeFileSync(path.join(directory, '001-game-loop.game.json'), JSON.stringify(contract()));
	const report = runScan({ repoRoot: root, terms: ['game'] });
	assert.equal(report.adapter, 'unreal-python');
	assert.equal(report.game_contracts.length, 1);
	assert.equal(report.game_contracts[0].summary.timer_event_count, 1);
	assert.deepEqual(report.files_read, [
		'Example.uproject',
		path.join('specs', '001-game-loop', 'contracts', '001-game-loop.game.json'),
	]);
});

test('readGameContracts rejects a valid document stored outside the canonical loop path', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-game-contract-'));
	const directory = path.join(root, 'specs', '001-wrong-loop', 'contracts');
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, 'wrong-name.game.json'), JSON.stringify(contract()));
	assert.throws(() => readGameContracts(root), /must be specs\/<loop_id>\/contracts\/<loop_id>\.game\.json/);
});
