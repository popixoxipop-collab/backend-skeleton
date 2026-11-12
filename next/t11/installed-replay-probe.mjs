#!/usr/bin/env node
// Test-only child: every product import comes from the disposable installation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [consumer, sourceRoot, expected] = process.argv.slice(2);
assert.ok(path.isAbsolute(consumer) && path.isAbsolute(sourceRoot));
assert.ok(expected === 'absent' || expected === 'present');
const product = path.join(consumer, 'node_modules', 'backend-skeleton');
const load = relative => import(pathToFileURL(path.join(product, relative)).href);
const { runScan } = await load('scanners/index.mjs');
const { ADAPTERS } = await load('scanners/registry.mjs');
const ids = ['java-spring', 'ruby-rails', 'python-fastapi', 'typescript-express', 'javascript-express'];
const fixtures = {
  'java-spring': 'test/fixtures/java-spring',
  'ruby-rails': 'test/fixtures/ruby-rails/backend',
  'python-fastapi': 'test/fixtures/python-fastapi/backend',
  'typescript-express': 'test/fixtures/typescript-express/backend',
  'javascript-express': 'test/fixtures/javascript-express/backend',
};
const bin = path.join(consumer, 'node_modules', '.bin',
  process.platform === 'win32' ? 'bskel-t11-observe.cmd' : 'bskel-t11-observe');
assert.equal(fs.existsSync(bin), expected === 'present');
const t11 = expected === 'present' ? {
  baselines: await load('adapters/http-legacy-next/baselines.mjs'),
  bridge: await load('adapters/http-legacy-next/bridge.mjs'),
  parity: await load('adapters/http-legacy-next/parity.mjs'),
} : null;
const observed = [];
for (const id of ids) {
  const fixture = path.join(sourceRoot, fixtures[id]);
  assert.ok(fs.statSync(fixture).isDirectory(), id);
  const report = runScan({ repoRoot: fixture, terms: [] });
  assert.equal(report.schema, 'sbf.scan-report/2', id);
  assert.equal(report.adapter, id);
  assert.equal(report.verdict, 'inventory', id);
  const entry = { id, verdict: report.verdict, modules: report.related_modules.length };
  if (t11) {
    const adapter = ADAPTERS.find(item => item.id === id);
    assert.ok(adapter, id);
    const payload = { adapter: t11.bridge.snapshotLegacyHttpAdapter(adapter), report };
    const child = spawnSync(bin, [], {
      input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, 0, `${id}: ${child.stderr}`);
    assert.equal(child.stderr, '', id);
    const output = JSON.parse(child.stdout);
    assert.equal(output.adapter_id, id);
    assert.deepEqual(output.legacy_summary, t11.baselines.legacyHttpBaseline(id).inventory, id);
    assert.equal(output.legacy_semantic_sha256, t11.parity.legacyHttpSemanticDigest(report), id);
    for (const gate of ['runtime_certified', 'source_authorized', 'promotion_allowed'])
      assert.equal(output[gate], false, `${id}: ${gate}`);
    entry.legacy_semantic_sha256 = output.legacy_semantic_sha256;
  }
  observed.push(entry);
  if (expected === 'present' && observed.length === 1 &&
      process.env.T11_TEST_FAULT_DURING_CANDIDATE_PROBE === '1')
    process.kill(process.pid, 'SIGTERM');
}
console.log(JSON.stringify({ schema: 'bskel.t11-installed-replay-probe/1',
  consumer: expected, adapters: observed, authorized: false }));
