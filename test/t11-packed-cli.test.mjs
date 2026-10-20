// T11-02 product-distribution acceptance: build the repository's real npm
// tarball, install it into an isolated consumer without lifecycle scripts or
// network access, and invoke the installed bin rather than the checkout file.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.env.T11_TEST_NPM || 'npm';
let scratch, metadata, installedPackage, installedBin;

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

function input(overrides = {}) {
  return {
    adapter: {
      id: 'java-spring', contract: 'sbf.adapter/2', title: 'Java / Spring Boot',
      specificity: 100, confidence: 'high', verificationBasis: 'production-repo',
      capabilities: {
        'api.operations': true, 'api.request-shape': true,
        'resource.fetch': true, 'codegen.handles': true,
      },
    },
    report: {
      schema: 'sbf.scan-report/2', adapter: 'java-spring', verdict: 'detect-only',
      confidence: 'high', api_surface_source: 'fixture-conservative',
      related_modules: [], files_read: [], path_prefix_signals: [],
      ...overrides,
    },
  };
}

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t11-packed-cli-'));
  const packed = run(NPM, [
    'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', scratch,
  ], ROOT);
  assert.equal(packed.status, 0, packed.stderr);
  [metadata] = JSON.parse(packed.stdout);
  const tarball = path.join(scratch, metadata.filename);
  const consumer = path.join(scratch, 'consumer');
  fs.mkdirSync(consumer);
  const installed = run(NPM, [
    'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--no-save', '--prefix', consumer, tarball,
  ], scratch);
  assert.equal(installed.status, 0, installed.stderr);
  installedPackage = path.join(consumer, 'node_modules', 'backend-skeleton');
  installedBin = path.join(consumer, 'node_modules', '.bin',
    process.platform === 'win32' ? 'bskel-t11-observe.cmd' : 'bskel-t11-observe');
}, { timeout: 90000 });

after(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

test('T11P01 real npm pack contains the CLI and its complete local import closure', () => {
  const names = new Set(metadata.files.map((file) => file.path));
  for (const name of [
    'next/t11/observed-report-cli-v1.mjs',
    'next/t11/observed-bridge-v1.mjs',
    'next/t11/report-observation-v1.mjs',
    'adapters/http-legacy-next/baselines.mjs',
    'adapters/http-legacy-next/bridge.mjs',
    'adapters/http-legacy-next/parity.mjs',
  ]) assert.ok(names.has(name), `missing packed product file: ${name}`);
  assert.equal([...names].some((name) => name.endsWith('.test.mjs')), false);
});

test('T11P02 isolated install exposes the declared executable bin', () => {
  assert.ok(fs.statSync(installedBin).isFile(), `${installedBin} is missing`);
  const manifest = JSON.parse(fs.readFileSync(path.join(installedPackage, 'package.json'), 'utf8'));
  assert.equal(manifest.bin['bskel-t11-observe'], 'next/t11/observed-report-cli-v1.mjs');
});

test('T11P03 installed bin consumes a valid report and keeps promotion disabled', () => {
  const result = run(installedBin, [], scratch, input());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.schema, 'bskel.t11-observed-report-consumer/1');
  assert.equal(output.adapter_id, 'java-spring');
  assert.equal(output.runtime_certified, false);
  assert.equal(output.source_authorized, false);
  assert.equal(output.promotion_allowed, false);
});

test('T11P04 installed bin preserves scalar fail-closed behavior', () => {
  const result = run(installedBin, [], scratch, input({ verdict: { unexpected: true } }));
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.sections.verdict.state, 'invalid_type');
  assert.equal(output.observation_quality, 'incomplete_report_fields');
  assert.equal(output.promotion_allowed, false);
});
