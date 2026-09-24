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
	write(root, `specs/${loop}/runtime/${loop}.runtime.json`, JSON.stringify({ sbf_gameplay_runtime: '1', loop_id: loop, compiler: { script: 'stage_b_data/scripts/gen_game_plan.py', world_anchors: 'stage_b_data/world_anchors.json', output: `specs/${loop}/game_plan.json` }, runtime: { project_file: 'Example.uproject', exclusive_session: 'test-session', emit_steps: [{ id: 'emit', script: 'emit.py', args: [`specs/${loop}/game_plan.json`], result_file: 'emit.result.txt', writes: [{ kind: 'ue-asset', path: '/Game/Test' }] }], verify_steps: [{ id: 'verify', script: 'verify.py', args: [], result_file: 'verify.result.txt', reads: [{ kind: 'ue-asset', path: '/Game/Test' }] }] } }));
}
function prepareApplyFixture(root) {
	write(root, 'Example.uproject', "const fs=require('node:fs');const cmd=process.argv.find(a=>a.startsWith('-ExecCmds='))||'';if(cmd.includes('emit.py'))fs.writeFileSync('emit.result.txt','SCRIPT_DONE_OK\\n');if(cmd.includes('verify.py'))fs.writeFileSync('verify.result.txt','SCRIPT_DONE_OK\\n');");
	write(root, 'stage_b_data/scripts/gen_game_plan.py', "const fs=require('node:fs'),path=require('node:path');const i=process.argv.indexOf('--output');if(i>=0){const out=process.argv[i+1];fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,'{}\\n');}");
}
function applyFixture(root, extraArgs = [], env = {}) {
	prepareApplyFixture(root);
	return execFileSync('node', [CLI, 'gameplay', 'emit', '--loop', '001-game-loop', '--apply', '--reason', 'test fixture', '--unreal-editor', process.execPath, '--python', process.execPath, '--timeout-sec', '5', '--json', ...extraArgs], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
}
function gameplayReceipt(root, step) {
	return path.join(root, '.sbf', 'gameplay-receipts', '001-game-loop', `${step}.json`);
}
test('gameplay emit previews the manifest-owned compiler and UE receipts without writing', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gameplay-emit-')); execFileSync('git', ['init', '--quiet'], { cwd: root }); setup(root);
	const before = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
	const output = execFileSync('node', [CLI, 'gameplay', 'emit', '--loop', '001-game-loop', '--json'], { cwd: root, encoding: 'utf8' });
	const plan = JSON.parse(output); assert.equal(plan.schema, 'sbf.gameplay-emit-plan/1'); assert.deepEqual(plan.compiler.args.slice(1, 3), ['--contract', 'specs/001-game-loop/contracts/001-game-loop.game.json']); assert.equal(plan.emit_steps[0].result_file, 'emit.result.txt');
	assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), before);
});

test('gameplay emit accepts the headless --nullrhi execution option in preview mode', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gameplay-nullrhi-')); execFileSync('git', ['init', '--quiet'], { cwd: root }); setup(root);
	const output = execFileSync('node', [CLI, 'gameplay', 'emit', '--loop', '001-game-loop', '--nullrhi', '--json'], { cwd: root, encoding: 'utf8' });
	assert.equal(JSON.parse(output).loop_id, '001-game-loop');
});

test('gameplay emit refuses apply without its audited reason and explicit editor binary', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gameplay-emit-')); execFileSync('git', ['init', '--quiet'], { cwd: root }); setup(root);
	assert.throws(() => execFileSync('node', [CLI, 'gameplay', 'emit', '--loop', '001-game-loop', '--apply'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }), /requires --reason/);
	assert.throws(() => execFileSync('node', [CLI, 'gameplay', 'emit', '--loop', '001-game-loop', '--apply', '--reason', 'test'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }), /requires --unreal-editor/);
});

test('gameplay emit adopts a fresh external verify receipt during resume', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gameplay-adopt-')); execFileSync('git', ['init', '--quiet'], { cwd: root }); setup(root);
	applyFixture(root);
	fs.rmSync(gameplayReceipt(root, 'verify'));
	const external = path.join(root, 'verify.result.txt');
	const fresh = new Date(Date.now() + 2000);
	fs.utimesSync(external, fresh, fresh);
	applyFixture(root, ['--resume'], { BSKEL_ADOPT_EXISTING_RECEIPTS: '1' });
	const receipt = JSON.parse(fs.readFileSync(gameplayReceipt(root, 'verify'), 'utf8'));
	assert.equal(receipt.execution_mode, 'external-interactive');
	assert.match(fs.readFileSync(external, 'utf8'), /SCRIPT_DONE_OK/);
});

test('gameplay emit refuses to adopt an external verify receipt older than emit evidence', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gameplay-adopt-old-')); execFileSync('git', ['init', '--quiet'], { cwd: root }); setup(root);
	applyFixture(root);
	fs.rmSync(gameplayReceipt(root, 'verify'));
	const external = path.join(root, 'verify.result.txt');
	const old = new Date(946684800000);
	fs.utimesSync(external, old, old);
	let caught = null;
	try { applyFixture(root, ['--resume'], { BSKEL_ADOPT_EXISTING_RECEIPTS: '1' }); } catch (error) { caught = error; }
	assert.ok(caught);
	assert.match(String(caught.stderr ?? ''), /external receipt predates/);
	assert.match(String(caught.stdout ?? ''), /ADOPT_RECEIPT_TOO_OLD/);
});

test('gameplay emit adopts fresh external emit and verify receipts in all mode', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-gameplay-adopt-all-')); execFileSync('git', ['init', '--quiet'], { cwd: root }); setup(root);
	applyFixture(root);
	fs.rmSync(gameplayReceipt(root, 'emit'));
	fs.rmSync(gameplayReceipt(root, 'verify'));
	const emitExternal = path.join(root, 'emit.result.txt');
	const verifyExternal = path.join(root, 'verify.result.txt');
	const emitTime = new Date(Date.now() + 2000);
	const verifyTime = new Date(Date.now() + 3000);
	fs.utimesSync(emitExternal, emitTime, emitTime);
	fs.utimesSync(verifyExternal, verifyTime, verifyTime);
	applyFixture(root, ['--resume'], { BSKEL_ADOPT_EXISTING_RECEIPTS: 'all' });
	const emitReceipt = JSON.parse(fs.readFileSync(gameplayReceipt(root, 'emit'), 'utf8'));
	const verifyReceipt = JSON.parse(fs.readFileSync(gameplayReceipt(root, 'verify'), 'utf8'));
	assert.equal(emitReceipt.execution_mode, 'external-commandlet');
	assert.equal(verifyReceipt.execution_mode, 'external-interactive');
});
