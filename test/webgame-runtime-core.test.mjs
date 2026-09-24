import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { evaluateScenarioEvidence } from '../webgame/assertions.mjs';
import { parseWebgameRuntimeContract, WebgameRuntimeContractError } from '../webgame/contract.mjs';
import { executeWebgamePlan } from '../webgame/execution.mjs';
import { buildWebgameExecutionPlan } from '../webgame/plan.mjs';
import { createPlaywrightDriver, WebgameBrowserUnavailableError } from '../webgame/playwright-driver.mjs';
import { parseProbeSeries, WebgameProbeError } from '../webgame/probe-contract.mjs';
import { createOwnedProcessSession } from '../webgame/process-session.mjs';
import { runWebgameRuntime, WebgameRuntimeExecutionError } from '../webgame/runtime-runner.mjs';

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

test('Playwright driver samples the declared probe and releases keys/context/browser', async () => {
  const events = [];
  let seq = 0;
  const page = new EventEmitter();
  page.keyboard = {
    async down(key) { events.push(`down:${key}`); },
    async up(key) { events.push(`up:${key}`); },
    async press(key) { events.push(`press:${key}`); },
  };
  page.goto = async (url) => { events.push(`goto:${url}`); return { status: () => 200 }; };
  page.waitForTimeout = async () => {};
  page.evaluate = async () => sample(seq++, { player: [0, 0, seq * 0.25], frame: seq * 2 });
  const context = {
    async route() {},
    async newPage() { return page; },
    async close() { events.push('context-close'); },
  };
  const browser = {
    async newContext() { return context; },
    async close() { events.push('browser-close'); },
  };
  const fakePlaywright = { chromium: { async launch() { events.push('launch'); return browser; } } };
  const plan = buildWebgameExecutionPlan(parseWebgameRuntimeContract(contract()));
  const driver = createPlaywrightDriver({ playwright: fakePlaywright });
  await driver.open(plan);
  const samples = await driver.runScenario(plan.scenarios[0]);
  await driver.close();
  assert.ok(samples.length >= 2);
  assert.ok(events.includes('down:KeyW'));
  assert.ok(events.includes('up:KeyW'));
  assert.deepEqual(events.slice(-2), ['context-close', 'browser-close']);
});

test('Playwright driver refuses reference/inventory-only plans', async () => {
  const plan = buildWebgameExecutionPlan(parseWebgameRuntimeContract(contract({ trust: 'reference' })));
  const driver = createPlaywrightDriver({ playwright: {} });
  await assert.rejects(() => driver.open(plan), /non-executable/);
});

test('Playwright driver reports an unavailable requested browser explicitly', async () => {
  const plan = buildWebgameExecutionPlan(parseWebgameRuntimeContract(contract()));
  const driver = createPlaywrightDriver({ playwright: {} });
  await assert.rejects(() => driver.open(plan), WebgameBrowserUnavailableError);
});

test('Playwright driver rejects a 404 main document instead of treating it as ready', async () => {
  const page = new EventEmitter();
  page.keyboard = { async down() {}, async up() {}, async press() {} };
  page.goto = async () => ({ status: () => 404 });
  page.waitForTimeout = async () => {};
  page.evaluate = async () => sample(1);
  const context = { async route() {}, async newPage() { return page; }, async close() {} };
  const browser = { async newContext() { return context; }, async close() {} };
  const driver = createPlaywrightDriver({ playwright: { chromium: { async launch() { return browser; } } } });
  const plan = buildWebgameExecutionPlan(parseWebgameRuntimeContract(contract()));
  await assert.rejects(() => driver.open(plan), /HTTP 404/);
  await driver.close();
});

test('Playwright driver fails closed when the page raises a runtime error', async () => {
  let seq = 0;
  const page = new EventEmitter();
  page.keyboard = { async down() {}, async up() {}, async press() {} };
  page.goto = async () => ({ status: () => 200 });
  page.waitForTimeout = async () => { if (seq === 1) page.emit('pageerror', new Error('fixture boom')); };
  page.evaluate = async () => sample(seq++);
  const context = { async route() {}, async newPage() { return page; }, async close() {} };
  const browser = { async newContext() { return context; }, async close() {} };
  const driver = createPlaywrightDriver({ playwright: { chromium: { async launch() { return browser; } } } });
  const plan = buildWebgameExecutionPlan(parseWebgameRuntimeContract(contract()));
  await driver.open(plan);
  await assert.rejects(() => driver.runScenario(plan.scenarios[0]), /page error/);
  await driver.close();
});

test('Playwright driver fails when required workers do not appear before timeout', async () => {
  const page = new EventEmitter();
  page.keyboard = { async down() {}, async up() {}, async press() {} };
  page.goto = async () => ({ status: () => 200 });
  page.waitForTimeout = async () => {};
  page.evaluate = async () => sample(1);
  const context = { async route() {}, async newPage() { return page; }, async close() {} };
  const browser = { async newContext() { return context; }, async close() {} };
  const value = contract();
  value.browser.required_workers = 1;
  value.browser.worker_timeout_ms = 1;
  const driver = createPlaywrightDriver({ playwright: { chromium: { async launch() { return browser; } } } });
  const plan = buildWebgameExecutionPlan(parseWebgameRuntimeContract(value));
  await assert.rejects(() => driver.open(plan), /required workers did not start/);
  await driver.close();
});

test('owned process session rejects cwd escape before spawning anything', () => {
  let spawnCount = 0;
  const session = createOwnedProcessSession({ repoRoot: '/repo', spawnImpl() { spawnCount += 1; } });
  assert.throws(() => session.start(['node', 'server.mjs'], { cwd: '/outside' }), /escapes repository root/);
  assert.equal(spawnCount, 0);
});

test('owned process session starts without shell and only tracks its own child', async () => {
  const calls = [];
  class Child extends EventEmitter {
    constructor() { super(); this.pid = 123; this.exitCode = null; this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); }
    kill(signal) { calls.push(['kill', signal]); this.exitCode = 0; this.emit('exit', 0, signal); }
  }
  const child = new Child();
  const session = createOwnedProcessSession({
    repoRoot: '/repo',
    spawnImpl(command, args, options) { calls.push(['spawn', command, args, options.shell]); return child; },
    spawnSyncImpl() {},
  });
  session.start(['node', 'server.mjs']);
  assert.equal(session.ownedCount, 1);
  await session.stopAll();
  assert.deepEqual(calls[0], ['spawn', 'node', ['server.mjs'], false]);
});


test('runtime runner builds, waits for loopback readiness, executes, and always stops owned processes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-webgame-runner-'));
  fs.mkdirSync(path.join(root, 'dist'));
  const plan = buildWebgameExecutionPlan(parseWebgameRuntimeContract(contract()));
  const events = [];
  const session = {
    async run(argv) { events.push(['build', ...argv]); return { code: 0, stdout: '', stderr: '' }; },
    start(argv) { events.push(['serve', ...argv]); return {}; },
    async stopAll() { events.push(['stop']); },
  };
  const driver = {
    async open() { events.push(['open']); },
    async runScenario() { events.push(['scenario']); return healthy; },
    async close() { events.push(['close']); },
  };
  const result = await runWebgameRuntime(plan, { repoRoot: root, processSession: session, driver, fetchImpl: async () => ({ status: 200 }) });
  assert.equal(result.verdict, 'passed');
  assert.deepEqual(events.at(-1), ['stop']);
  assert.ok(events.some((entry) => entry[0] === 'build'));
  assert.ok(events.some((entry) => entry[0] === 'serve'));
});

test('runtime runner fails closed on missing build output and still stops owned processes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-webgame-runner-missing-'));
  const plan = buildWebgameExecutionPlan(parseWebgameRuntimeContract(contract()));
  let stopped = false;
  const session = {
    async run() { return { code: 0, stdout: '', stderr: '' }; },
    start() { throw new Error('must not serve'); },
    async stopAll() { stopped = true; },
  };
  await assert.rejects(
    () => runWebgameRuntime(plan, { repoRoot: root, processSession: session, driver: {}, fetchImpl: async () => ({ status: 200 }) }),
    (error) => error instanceof WebgameRuntimeExecutionError && error.phase === 'build' && /output does not exist/.test(error.message),
  );
  assert.equal(stopped, true);
});


function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

test('runtime runner does not accept HTTP 404 as server readiness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-webgame-runner-404-'));
  fs.mkdirSync(path.join(root, 'dist'));
  const plan = buildWebgameExecutionPlan(parseWebgameRuntimeContract(contract()));
  let stopped = false;
  const session = {
    async run() { return { code: 0, stdout: '', stderr: '' }; },
    start() { return {}; },
    async stopAll() { stopped = true; },
  };
  await assert.rejects(
    () => runWebgameRuntime(plan, { repoRoot: root, processSession: session, driver: {}, fetchImpl: async () => ({ status: 404 }), readyTimeoutMs: 2, readyPollMs: 1 }),
    (error) => error instanceof WebgameRuntimeExecutionError && error.phase === 'serve',
  );
  assert.equal(stopped, true);
});

test('owned fixture performs a real build and loopback server lifecycle before runtime evidence', async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const port = await freeLoopbackPort();
  const value = contract();
  value.source.root = 'fixtures/webgame-runtime/owned-singleplayer';
  value.build = { argv: ['node', 'build.mjs'], output_dir: 'dist' };
  value.serve = { argv: ['node', 'server.mjs', String(port)], url: `http://127.0.0.1:${port}`, ready_path: '/' };
  const plan = buildWebgameExecutionPlan(parseWebgameRuntimeContract(value));
  const driver = {
    async open() {},
    async runScenario() { return healthy; },
    async close() {},
  };
  const result = await runWebgameRuntime(plan, { repoRoot, driver, readyTimeoutMs: 5000 });
  assert.equal(result.verdict, 'passed');
  assert.equal(result.evidence_scope, 'ungated-runtime-evidence');
  assert.ok(fs.existsSync(path.join(repoRoot, value.source.root, 'dist', 'index.html')));
});
