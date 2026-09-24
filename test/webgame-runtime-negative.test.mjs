import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { parseWebgameRuntimeContract } from '../webgame/contract.mjs';
import { buildWebgameExecutionPlan } from '../webgame/plan.mjs';
import { createPlaywrightDriver, WebgameBrowserHealthError } from '../webgame/playwright-driver.mjs';

function approvedPlan() {
  const parsed = parseWebgameRuntimeContract({
    sbf_webgame_runtime: '1',
    project_id: 'negative-browser-fixture',
    source: { trust: 'owned', root: '.' },
    build: { argv: ['node', 'build.mjs'], output_dir: 'dist' },
    serve: { argv: ['node', 'server.mjs'], url: 'http://127.0.0.1:4173', ready_path: '/' },
    browser: { name: 'chromium', headless: true },
    probe: { global: '__BSKEL_PROBE__', sample_interval_ms: 50 },
    scenarios: [{
      id: 'negative-browser-check',
      action: { type: 'wait', duration_ms: 50 },
      assertions: [{ type: 'render_frames', min_delta: 1 }],
    }],
  });
  return buildWebgameExecutionPlan(parsed, {
    approval: {
      approval_id: 'negative-browser-test',
      allow_execute: true,
      project_id: parsed.project_id,
      source_root: parsed.source.root,
    },
  });
}

function fakePlaywright(pageSetup) {
  const page = new EventEmitter();
  page.keyboard = { async down() {}, async up() {}, async press() {} };
  page.waitForTimeout = async () => {};
  page.evaluate = async () => ({
    schema: 'sbf.webgame-probe/1',
    seq: 1,
    time_ms: 1,
    frame: 1,
    player: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
    camera: { position: { x: 0, y: 0, z: 0 } },
    collisions: { active: [] },
    interactions: { count: 0 },
  });
  page.goto = async () => {
    await pageSetup(page);
    return { status: () => 200 };
  };
  const context = {
    async route() {},
    async newPage() { return page; },
    async close() {},
  };
  const browser = {
    async newContext() { return context; },
    async close() {},
  };
  return { chromium: { async launch() { return browser; } } };
}

test('blank canvas without a probe cannot pass runtime verification', async () => {
  const playwright = fakePlaywright(async (page) => {
    page.evaluate = async () => null;
  });
  const driver = createPlaywrightDriver({ playwright });
  await assert.rejects(
    () => driver.open(approvedPlan()),
    (error) => error instanceof WebgameBrowserHealthError && /probe .* is not available/.test(error.message),
  );
  await driver.close();
});

test('asset decode failure surfaced as a page error is fail-closed', async () => {
  const playwright = fakePlaywright(async (page) => {
    page.emit('pageerror', new Error('Failed to decode GLTF asset'));
  });
  const driver = createPlaywrightDriver({ playwright });
  await assert.rejects(
    () => driver.open(approvedPlan()),
    (error) => error instanceof WebgameBrowserHealthError && /page error/.test(error.message),
  );
  assert.match(driver.diagnostics.page_errors[0], /decode GLTF asset/);
  await driver.close();
});

test('browser page crash cannot be mistaken for a render pass', async () => {
  const playwright = fakePlaywright(async (page) => {
    page.emit('crash');
  });
  const driver = createPlaywrightDriver({ playwright });
  await assert.rejects(
    () => driver.open(approvedPlan()),
    (error) => error instanceof WebgameBrowserHealthError && /page crash/.test(error.message),
  );
  assert.equal(driver.diagnostics.crashes.length, 1);
  await driver.close();
});
