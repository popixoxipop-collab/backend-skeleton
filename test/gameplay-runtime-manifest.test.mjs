import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readGameContracts } from '../gameplay/contracts.mjs';
import { GameRuntimeManifestError, readGameRuntimeManifests } from '../gameplay/runtime-manifest.mjs';

function contract(loopId) {
	return {
		sbf_game_contract: '1', loop_id: loopId, loop_uid: `uid-${loopId}`,
		source: { adapter: 'unreal-python', world: 'Lvl_Test', provenance: 'hand-authored' },
		state: { active: { scope: 'world', type: 'bool', initial: false } },
		events: { E_TIMER: { source: 'timer', period_s: 10, scope: 'world' } },
		anchors: { A_START: { kind: 'checkpoint', ref: { world_anchor_id: 'road.test.start' }, tags: [] } },
		populations: {},
		objectives: { Q_MAIN: { title_key: 'UI.Quest.Main', auto_accept: true, prerequisites: [], nodes: [{ id: 'N_MAIN', sequential: true, required_of: -1, tasks: [{ id: 'T_MAIN', mandatory: true, target: 1, time_limit_s: 0 }] }] } },
		rules: { require: [], derive: [], on: [{ id: 'R_TIMER', event: 'E_TIMER', order: 10, effects: [{ verb: 'notify', message_id: 'UI.Msg.Timer' }] }] },
		warnings: [], completeness: { status: 'complete', event_count: 1, objective_count: 1, anchor_count: 1 },
	};
}

function write(root, relative, contents = '') {
	const file = path.join(root, ...relative.split('/'));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, contents);
}

function addContract(root, loopId) {
	write(root, `specs/${loopId}/contracts/${loopId}.game.json`, JSON.stringify(contract(loopId)));
}

function manifest(loopId, { session = 'shared-lvl-thirdperson', writePath = '/Game/Game/DT_Rules', script = 'stage_e_emit_ruleset.py' } = {}) {
	return {
		sbf_gameplay_runtime: '1',
		loop_id: loopId,
		compiler: {
			script: 'stage_b_data/scripts/gen_game_plan.py',
			world_anchors: 'stage_b_data/world_anchors.json',
			output: `specs/${loopId}/game_plan.json`,
		},
		runtime: {
			project_file: 'Example.uproject',
			exclusive_session: session,
			emit_steps: [{ id: 'ruleset', script, writes: [{ kind: 'ue-asset', path: writePath }] }],
			verify_steps: [{ id: 'cold-read', script: 'cold_verify_ruleset.py', reads: [{ kind: 'ue-asset', path: writePath }] }],
		},
	};
}

function prepare(root, loopId) {
	addContract(root, loopId);
	write(root, 'Example.uproject', '{}');
	write(root, 'stage_b_data/scripts/gen_game_plan.py');
	write(root, 'stage_b_data/world_anchors.json', '{"anchors":[]}');
	write(root, 'stage_e_emit_ruleset.py');
	write(root, 'cold_verify_ruleset.py');
}

function parsedContracts(root) {
	return readGameContracts(root).contracts;
}

test('runtime manifests normalize an explicit, canonical game-plan compiler and ordered UE write boundary', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gameplay-runtime-'));
	prepare(root, '001-game-loop');
	write(root, 'specs/001-game-loop/runtime/001-game-loop.runtime.json', JSON.stringify(manifest('001-game-loop')));
	const result = readGameRuntimeManifests(root, { contracts: parsedContracts(root) });
	assert.deepEqual(result.files_read, [path.join('specs', '001-game-loop', 'runtime', '001-game-loop.runtime.json')]);
	assert.equal(result.manifests[0].schema, 'sbf.gameplay-runtime/1');
	assert.equal(result.manifests[0].compiler.output, path.join('specs', '001-game-loop', 'game_plan.json'));
	assert.equal(result.manifests[0].runtime.emit_steps[0].writes[0].path, '/Game/Game/DT_Rules');
	assert.equal(result.manifests[0].summary.write_target_count, 1);
});

test('runtime manifests reject a declared loop without a validated game contract', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gameplay-runtime-'));
	prepare(root, '001-game-loop');
	write(root, 'specs/999-missing/runtime/999-missing.runtime.json', JSON.stringify(manifest('999-missing')));
	assert.throws(
		() => readGameRuntimeManifests(root, { contracts: parsedContracts(root) }),
		(error) => error instanceof GameRuntimeManifestError && /has no validated game contract/.test(error.message),
	);
});

test('runtime manifests reject escaping script paths and missing script files', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gameplay-runtime-'));
	prepare(root, '001-game-loop');
	const value = manifest('001-game-loop');
	value.runtime.emit_steps[0].script = '../outside.py';
	write(root, 'specs/001-game-loop/runtime/001-game-loop.runtime.json', JSON.stringify(value));
	assert.throws(
		() => readGameRuntimeManifests(root, { contracts: parsedContracts(root) }),
		(error) => error instanceof GameRuntimeManifestError && /invalid gameplay runtime manifest/.test(error.message),
	);
});

test('a shared UE target is allowed only when every loop declares the same exclusive session', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gameplay-runtime-'));
	prepare(root, '001-game-loop');
	prepare(root, '002-game-loop');
	write(root, 'specs/001-game-loop/runtime/001-game-loop.runtime.json', JSON.stringify(manifest('001-game-loop', { session: 'first' })));
	write(root, 'specs/002-game-loop/runtime/002-game-loop.runtime.json', JSON.stringify(manifest('002-game-loop', { session: 'second' })));
	assert.throws(
		() => readGameRuntimeManifests(root, { contracts: parsedContracts(root) }),
		(error) => error instanceof GameRuntimeManifestError && /different exclusive_session values/.test(error.message),
	);
});
