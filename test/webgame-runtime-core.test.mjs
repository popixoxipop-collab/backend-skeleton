import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWebgameRuntimeContract, WebgameRuntimeContractError } from '../webgame/contract.mjs';
import { buildWebgameExecutionPlan } from '../webgame/plan.mjs';
import { evaluateScenarioEvidence } from '../webgame/assertions.mjs';
import { parseProbeSeries, WebgameProbeError } from '../webgame/probe-contract.mjs';
import { executeWebgamePlan } from '../webgame/execution.mjs';

function contract({ trust = 'owned', assertions = null } = {}) {
  return {
    sbf_webgame_runtime: '1',
    project_id: 'owned-singleplayer',
    source: { trust, root: '.' },
    build: { argv: ['npm', 'run', 'build'], output_dir: 'dist' },
    serve: { argv: ['node', 'tools/serve.mjs'], url: 'http://127.0.0.1:4173', ready_path: '/' },
    browser: { name: 'chromium', headless: true },
    probe: { global: '__BSKEL_PROBE__', sample_interval_ms: 50 },
    scenarios: [{
      id: 'move-forward',
      action: { type: 'key', key: 'KeyW', duration_ms: 250 },
      assertions: assertions ?? [
        { type: 'render_frames', min_delta: 2 },
        { type: 'player_displacement', min: 0.2, max: 4 },
        { type: 'camera_only_reject', min_player: 0.2 },
        { type: 'max_step', max: 1.5 },
        { type: 'vertical_bounds', max_drop: 0.5, max_rise: 0.5 },
      ],
    }],
  };
}

function sample(seq, { player = [0, 0, 0], camera = [0, 2, -4], frame = seq * 2, interactions = 0 } = {}) {
  return {
    schema: 'sbf.webgame-probe/1', seq, time_ms: seq * 50, frame,
    player: { position: { x: player[0], y: player[1], z: player[2] }, velocity: { x: 0, y: 0, z: 1 } },
    camera: { position: { x: camera[0], y: camera[1], z: camera[2] } },
    collisions: { active: [] }, interactions: { count: interactions },
  };
}

const healthy = [sample(0), sample(1, { player: [0, 0, 0.25], camera: [0, 2, -3.8] }), sample(2, { player: [0, 0, 0.6], camera: [0, 2, -3.5] })];

test('owned contract normalizes into an executable side-effect-free plan', () => {
  const parsed = parseWebgameRuntimeContract(contract(), { file: 'specs/owned/runtime.json' });
  const plan = buildWebgameExecutionPlan(parsed);
  assert.equal(parsed.execution_trust, 'approved');
  assert.equal(plan.execution.available, true);
  assert.equal(plan.scenarios.length, 1);
});

test('reference source stays inventory-only and cannot become executable through planning', () => {
  const parsed = parseWebgameRuntimeContract(contract({ trust: 'reference' }));
  const plan = buildWebgameExecutionPlan(parsed);
  assert.equal(parsed.execution_trust, 'inventory-only');
  assert.deepEqual(plan.execution.blocked_by, ['source.trust']);
});

test('runtime contract rejects non-loopback servers before execution', () => {
  const value = contract();
  value.serve.url = 'https://example.com/game';
  assert.throws(() => parseWebgameRuntimeContract(value), (error) => error instanceof WebgameRuntimeContractError && /loopback/.test(error.message));
});

test('healthy player movement passes render, displacement and anti-teleport assertions', () => {
  const scenario = contract().scenarios[0];
  const result = evaluateScenarioEvidence(scenario, healthy);
  assert.equal(result.verdict, 'passed');
});

test('camera-only movement is rejected even while frames advance', () => {
  const scenario = contract().scenarios[0];
  const samples = [sample(0), sample(1, { camera: [0, 2, -2] }), sample(2, { camera: [0, 2, 0] })];
  const result = evaluateScenarioEvidence(scenario, samples);
  assert.equal(result.verdict, 'failed');
  assert.equal(result.assertions.find((entry) => entry.type === 'camera_only_reject').passed, false);
});

test('teleport-sized player step is rejected', () => {
  const scenario = contract().scenarios[0];
  const samples = [sample(0), sample(1, { player: [0, 0, 8] }), sample(2, { player: [0, 0, 8.2] })];
  const result = evaluateScenarioEvidence(scenario, samples);
  assert.equal(result.verdict, 'failed');
  assert.equal(result.assertions.find((entry) => entry.type === 'max_step').passed, false);
});

test('vertical fall is rejected', () => {
  const scenario = contract().scenarios[0];
  const samples = [sample(0), sample(1, { player: [0, -0.2, 0.25] }), sample(2, { player: [0, -2, 0.5] })];
  const result = evaluateScenarioEvidence(scenario, samples);
  assert.equal(result.assertions.find((entry) => entry.type === 'vertical_bounds').passed, false);
});

test('wall crossing rejects a player that enters the forbidden half-space', () => {
  const scenario = contract({ assertions: [{ type: 'wall_crossing_reject', plane: { normal: { x: 1, y: 0, z: 0 }, constant: 0 }, allowed_sign: 'positive', tolerance: 0.01 }] }).scenarios[0];
  const samples = [sample(0, { player: [0.2, 0, 0] }), sample(1, { player: [0.05, 0, 0] }), sample(2, { player: [-0.2, 0, 0] })];
  assert.equal(evaluateScenarioEvidence(scenario, samples).verdict, 'failed');
});

test('interaction count detects double-fire', () => {
  const scenario = contract({ assertions: [{ type: 'interaction_count', exact: 1 }] }).scenarios[0];
  const samples = [sample(0, { interactions: 0 }), sample(1, { interactions: 1 }), sample(2, { interactions: 2 })];
  assert.equal(evaluateScenarioEvidence(scenario, samples).verdict, 'failed');
});

test('probe ordering is fail-closed', () => {
  const samples = [sample(1), sample(1, { player: [0, 0, 0.3] })];
  assert.throws(() => parseProbeSeries(samples), WebgameProbeError);
});

test('execution closes the isolated driver after success and returns ungated evidence', async () => {
  const plan = buildWebgameExecutionPlan(parseWebgameRuntimeContract(contract()));
  const events = [];
  const driver = {
    async open() { events.push('open'); },
    async runScenario() { events.push('run'); return healthy; },
    async close() { events.push('close'); },
  };
  const result = await executeWebgamePlan(plan, { driver });
  assert.deepEqual(events, ['open', 'run', 'close']);
  assert.equal(result.verdict, 'passed');
  assert.equal(result.evidence_scope, 'ungated-runtime-evidence');
});

test('execution closes the driver when a scenario throws', async () => {
  const plan = buildWebgameExecutionPlan(parseWebgameRuntimeContract(contract()));
  const events = [];
  const driver = {
    async open() { events.push('open'); },
    async runScenario() { events.push('run'); throw new Error('browser crashed'); },
    async close() { events.push('close'); },
  };
  await assert.rejects(() => executeWebgamePlan(plan, { driver }), /browser crashed/);
  assert.deepEqual(events, ['open', 'run', 'close']);
});
