// T11-05: exercise the installed product's scanner and observation consumer
// together, against the five committed legacy HTTP fixtures. This is an
// opt-in shadow path; it does not register a new adapter or authorize cutover.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NPM = process.env.T11_TEST_NPM || 'npm';
let scratch;
let installedPackage;
let installedBin;
let installed;

function run(program, args, cwd, input, timeout = 45000) {
  const result = spawnSync(program, args, {
    cwd,
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      npm_config_progress: 'false',
    },
  });
  assert.equal(result.error, undefined, String(result.error));
  return result;
}

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t11-cross-packed-'));
  const packed = run(NPM, [
    'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', scratch,
  ], ROOT);
  assert.equal(packed.status, 0, packed.stderr);
  const [metadata] = JSON.parse(packed.stdout);
  assert.ok(metadata.files.some((file) => file.path === 'scanners/index.mjs'));
  assert.ok(metadata.files.some((file) => file.path === 'next/t11/observed-report-cli-v1.mjs'));
  const consumer = path.join(scratch, 'consumer');
  fs.mkdirSync(consumer);
  const result = run(NPM, [
    'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--no-save', '--prefix', consumer, path.join(scratch, metadata.filename),
  ], scratch);
  assert.equal(result.status, 0, result.stderr);
  installedPackage = path.join(consumer, 'node_modules', 'backend-skeleton');
  installedBin = path.join(consumer, 'node_modules', '.bin',
    process.platform === 'win32' ? 'bskel-t11-observe.cmd' : 'bskel-t11-observe');
  const load = (relative) => import(pathToFileURL(path.join(installedPackage, relative)).href);
  const [scanner, registry, baselines, bridge, parity] = await Promise.all([
    load('scanners/index.mjs'),
    load('scanners/registry.mjs'),
    load('adapters/http-legacy-next/baselines.mjs'),
    load('adapters/http-legacy-next/bridge.mjs'),
    load('adapters/http-legacy-next/parity.mjs'),
  ]);
  installed = { scanner, registry, baselines, bridge, parity };
}, { timeout: 90000 });

after(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

test('T11-05 installed scanner to installed CLI consumes real reports for all five legacy adapters', () => {
  const { scanner, registry, baselines, bridge, parity } = installed;
  assert.notEqual(path.resolve(installedPackage), ROOT);
  for (const id of baselines.LEGACY_HTTP_ADAPTER_IDS) {
    const baseline = baselines.legacyHttpBaseline(id);
    const fixture = path.join(ROOT, baseline.fixture);
    assert.ok(fs.statSync(fixture).isDirectory(), id);
    const descriptor = registry.ADAPTERS.find((entry) => entry.id === id);
    assert.ok(descriptor, id);
    const report = scanner.runScan({ repoRoot: fixture, terms: [] });
    assert.equal(report.schema, 'sbf.scan-report/2', id);
    assert.equal(report.adapter, id);
    assert.equal(report.verdict, 'inventory', id);
    const payload = { adapter: bridge.snapshotLegacyHttpAdapter(descriptor), report };
    const result = run(installedBin, [], scratch, payload);
    assert.equal(result.status, 0, `${id}: ${result.stderr}`);
    assert.equal(result.stderr, '', id);
    const output = JSON.parse(result.stdout);
    assert.equal(output.schema, 'bskel.t11-observed-report-consumer/1', id);
    assert.equal(output.adapter_id, id);
    assert.deepEqual(output.legacy_summary, baseline.inventory, id);
    assert.equal(output.legacy_semantic_sha256, parity.legacyHttpSemanticDigest(report), id);
    assert.equal(output.presence_only, true, id);
    assert.equal(output.runtime_certified, false, id);
    assert.equal(output.source_authorized, false, id);
    assert.equal(output.promotion_allowed, false, id);
  }
}, { timeout: 90000 });

test('T11-05 installed consumer rejects a real report under the wrong adapter identity', () => {
  const { scanner, registry, baselines, bridge } = installed;
  const spring = baselines.legacyHttpBaseline('java-spring');
  const report = scanner.runScan({ repoRoot: path.join(ROOT, spring.fixture), terms: [] });
  const rails = registry.ADAPTERS.find((entry) => entry.id === 'ruby-rails');
  const result = run(installedBin, [], scratch, {
    adapter: bridge.snapshotLegacyHttpAdapter(rails), report,
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /T11_CONSUMER_REJECTED/);
}, { timeout: 45000 });
