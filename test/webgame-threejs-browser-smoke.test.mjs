import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseWebgameRuntimeContract } from '../webgame/contract.mjs';
import { buildWebgameExecutionPlan } from '../webgame/plan.mjs';
import { createPlaywrightDriver } from '../webgame/playwright-driver.mjs';
import { runWebgameRuntime } from '../webgame/runtime-runner.mjs';

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

function browserCandidates() {
  const env = process.env;
  return [
    env.BSKEL_CHROMIUM_PATH || null,
    env.PROGRAMFILES ? path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    env['PROGRAMFILES(X86)'] ? path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    env.PROGRAMFILES ? path.join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    env['PROGRAMFILES(X86)'] ? path.join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean);
}

test('owned Three.js fixture renders and moves under a real Chromium session when local tooling is available', async (t) => {
  let playwright;
  try {
    playwright = await import('playwright-core');
  } catch (error) {
    t.skip(`playwright-core unavailable: ${error.code ?? error.name}`);
    return;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const threeModule = path.join(repoRoot, 'node_modules', 'three', 'build', 'three.module.js');
  if (!fs.existsSync(threeModule)) {
    t.skip('approved local Three.js module unavailable');
    return;
  }

  const executablePath = browserCandidates().find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    t.skip('no approved local Chromium executable found');
    return;
  }

  const port = await freeLoopbackPort();
  const raw = {
    sbf_webgame_runtime: '1',
    project_id: 'owned-threejs-browser',
    source: { trust: 'owned', root: 'fixtures/webgame-runtime/threejs-owned' },
    build: { argv: ['node', 'build.mjs'], output_dir: 'dist' },
    serve: { argv: ['node', 'server.mjs', String(port)], url: `http://127.0.0.1:${port}`, ready_path: '/' },
    browser: { name: 'chromium', headless: true },
    probe: { global: '__BSKEL_PROBE__', sample_interval_ms: 50 },
    scenarios: [{
      id: 'move-threejs-player',
      action: { type: 'key', key: 'KeyW', duration_ms: 300 },
      assertions: [
        { type: 'render_frames', min_delta: 2 },
        { type: 'player_displacement', min: 0.15, max: 2 },
        { type: 'camera_only_reject', min_player: 0.15 },
        { type: 'max_step', max: 0.5 },
        { type: 'vertical_bounds', max_drop: 0.1, max_rise: 0.1 },
      ],
    }],
  };
  const parsed = parseWebgameRuntimeContract(raw);
  const plan = buildWebgameExecutionPlan(parsed, {
    approval: {
      approval_id: 'local-threejs-browser-smoke',
      allow_execute: true,
      project_id: parsed.project_id,
      source_root: parsed.source.root,
    },
  });
  const driver = createPlaywrightDriver({ playwright, browserExecutablePath: executablePath });
  const result = await runWebgameRuntime(plan, { repoRoot, driver, readyTimeoutMs: 5000 });

  assert.equal(result.verdict, 'passed');
  assert.equal(result.scenarios[0].verdict, 'passed');
  const renderAssertion = result.scenarios[0].assertions.find((entry) => entry.type === 'render_frames');
  assert.equal(renderAssertion.passed, true);
  assert.ok(renderAssertion.observed >= 2);
  assert.deepEqual(driver.diagnostics.page_errors, []);
  assert.deepEqual(driver.diagnostics.request_failures, []);
  assert.deepEqual(driver.diagnostics.crashes, []);
});
