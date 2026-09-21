import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'bskel.mjs');

function write(root, relative, contents = '') { const file = path.join(root, ...relative.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); }
function contract(loopId) { return { sbf_game_contract: '1', loop_id: loopId, loop_uid: `uid-${loopId}`, source: { adapter: 'unreal-python', world: 'Lvl_Test', provenance: 'hand-authored' }, state: { active: { scope: 'world', type: 'bool', initial: false } }, events: { E_TIMER: { source: 'timer', period_s: 10, scope: 'world' } }, anchors: { A_START: { kind: 'checkpoint', ref: { world_anchor_id: 'road.test.start' }, tags: [] } }, populations: {}, objectives: { Q_MAIN: { title_key: 'UI.Quest.Main', auto_accept: true, prerequisites: [], nodes: [{ id: 'N_MAIN', sequential: true, required_of: -1, tasks: [{ id: 'T_MAIN', mandatory: true, target: 1, time_limit_s: 0 }] }] } }, rules: { require: [], derive: [], on: [{ id: 'R_TIMER', event: 'E_TIMER', order: 10, effects: [{ verb: 'notify', message_id: 'UI.Msg.Timer' }] }] }, warnings: [], completeness: { status: 'complete', event_count: 1, objective_count: 1, anchor_count: 1 } }; }
function setup(root) {
	const loop = '001-game-loop';
	write(root, `specs/${loop}/contracts/${loop}.game.json`, JSON.stringify(contract(loop)));
	for (const file of ['Example.uproject', 'stage_b_data/scripts/gen_game_plan.py', 'stage_b_data/world_anchors.json', 'emit.py', 'verify.py']) write(root, file, '');
	write(root, `specs/${loop}/runtime/${loop}.runtime.json`, JSON.stringify({ sbf_gameplay_runtime: '1', loop_id: loop, compiler: { script: 'stage_b_data/scripts/gen_game_plan.py', world_anchors: 'stage_b_data/world_anchors.json', output: `specs/${loop}/game_plan.json` }, runtime: { project_file: 'Example.uproject', exclusive_session: 'test-session', emit_steps: [{ id: 'emit', script: 'emit.py', result_file: 'emit.result.txt', writes: [{ kind: 'ue-asset', path: '/Game/Test' }] }], verify_steps: [{ id: 'verify', script: 'verify.py', result_file: 'verify.result.txt', reads: [{ kind: 'ue-asset', path: '/Game/Test' }] }] } }));
}
test('gameplay emit previews the manifest-owned compiler and UE receipts without writing', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gameplay-emit-')); execFileSync('git', ['init', '--quiet'], { cwd: root }); setup(root);
	const before = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
	const output = execFileSync('node', [CLI, 'gameplay', 'emit', '--loop', '001-game-loop', '--json'], { cwd: root, encoding: 'utf8' });
	const plan = JSON.parse(output); assert.equal(plan.schema, 'sbf.gameplay-emit-plan/1'); assert.deepEqual(plan.compiler.args.slice(1, 3), ['--contract', 'specs/001-game-loop/contracts/001-game-loop.game.json']); assert.equal(plan.emit_steps[0].result_file, 'emit.result.txt');
	assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), before);
});

test('gameplay emit refuses apply without its audited reason and explicit editor binary', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gameplay-emit-')); execFileSync('git', ['init', '--quiet'], { cwd: root }); setup(root);
	assert.throws(() => execFileSync('node', [CLI, 'gameplay', 'emit', '--loop', '001-game-loop', '--apply'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }), /requires --reason/);
	assert.throws(() => execFileSync('node', [CLI, 'gameplay', 'emit', '--loop', '001-game-loop', '--apply', '--reason', 'test'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }), /requires --unreal-editor/);
});
