import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { fileURLToPath } from 'node:url';
import { readGameContracts } from '../gameplay/contracts.mjs';
import { provider as unrealProvider } from '../gameplay/providers/unreal-python.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');

function contract(loopId = '001-game-loop') {
	return {
		sbf_game_contract: '1', loop_id: loopId, loop_uid: `uid-${loopId}`,
		source: { adapter: 'unreal-python', world: 'Lvl_Test', provenance: 'hand-authored' },
		state: { active: { scope: 'world', type: 'bool', initial: false } },
		events: { E_TIMER: { source: 'timer', period_s: 10, scope: 'world' } },
		anchors: { A_START: { kind: 'checkpoint', ref: { world_anchor_id: 'road.test.start' }, tags: [] } },
		populations: { P_CROWD: { config_asset: 'EC_Pedestrian', spawn: { generator: 'zonegraph', anchor: 'A_START', count: 2 } } },
		objectives: { Q_MAIN: { title_key: 'UI.Quest.Main', auto_accept: true, prerequisites: [], nodes: [{ id: 'N_MAIN', sequential: true, required_of: -1, tasks: [{ id: 'T_MAIN', mandatory: true, target: 1, time_limit_s: 0 }] }] } },
		rules: { require: [], derive: [], on: [{ id: 'R_TIMER', event: 'E_TIMER', order: 10, effects: [{ verb: 'notify', message_id: 'UI.Msg.Timer' }] }] },
		warnings: [], completeness: { status: 'complete', event_count: 1, objective_count: 1, anchor_count: 1 },
	};
}

function addContract(root, loopId) {
	const dir = path.join(root, 'specs', loopId, 'contracts');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${loopId}.game.json`), JSON.stringify(contract(loopId)));
}

function tmpRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gameplay-plan-'));
	execFileSync('git', ['init', '--quiet'], { cwd: root });
	return root;
}

function run(args, cwd) {
	try {
		return { code: 0, stdout: execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' }) };
	} catch (error) {
		return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
	}
}

test('Unreal gameplay planner turns normalized contracts into an explicit non-emitting plan', () => {
	const root = tmpRepo();
	addContract(root, '001-game-loop');
	const { contracts } = readGameContracts(root);
	const plan = unrealProvider.plan({ contracts });
	assert.equal(plan.schema, 'sbf.gameplay-plan/1');
	assert.equal(plan.emission.available, false);
	assert.deepEqual(plan.emission.blocked_by, ['codegen.gameplay']);
	assert.equal(plan.loops[0].events[0].id, 'E_TIMER');
	assert.deepEqual(plan.loops[0].rules[0].effect_verbs, ['notify']);
	assert.equal(plan.loops[0].objectives[0].task_count, 1);

	const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'gameplay-plan.schema.json'), 'utf8'));
	const validate = new Ajv2020({ strict: false }).compile(schema);
	assert.equal(validate(plan), true, JSON.stringify(validate.errors));
});

test('gameplay plan CLI reads every canonical contract, can select one loop, and writes nothing', () => {
	const root = tmpRepo();
	addContract(root, '001-game-loop');
	addContract(root, '002-game-loop');
	const before = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
	const all = run(['gameplay', 'plan', '--json'], root);
	assert.equal(all.code, 0, all.stderr);
	const result = JSON.parse(all.stdout);
	assert.equal(result.schema, 'sbf.gameplay-plans/1');
	assert.equal(result.files_read.length, 2);
	assert.equal(result.plans.length, 1);
	assert.deepEqual(result.runtime_manifests, []);
	assert.deepEqual(result.plans[0].loops.map((loop) => loop.loop_id), ['001-game-loop', '002-game-loop']);
	const planSchema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'gameplay-plan.schema.json'), 'utf8'));
	const plansSchema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'gameplay-plans.schema.json'), 'utf8'));
	const validate = new Ajv2020({ strict: false });
	validate.addSchema(planSchema);
	assert.equal(validate.compile(plansSchema)(result), true, JSON.stringify(validate.errors));
	const single = run(['gameplay', 'plan', '--loop', '002-game-loop', '--json'], root);
	assert.equal(single.code, 0, single.stderr);
	assert.deepEqual(JSON.parse(single.stdout).plans[0].loops.map((loop) => loop.loop_id), ['002-game-loop']);
	const after = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
	assert.equal(after, before);
});

test('gameplay plan refuses an unknown loop instead of silently planning every contract', () => {
	const root = tmpRepo();
	addContract(root, '001-game-loop');
	const result = run(['gameplay', 'plan', '--loop', 'missing-loop', '--json'], root);
	assert.equal(result.code, 14);
	assert.match(result.stderr, /known loop ids: 001-game-loop/);
});
