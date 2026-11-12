#!/usr/bin/env node
// Probe only the disposable installed package, never a checkout product import.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [consumer, sourceRoot, fixtureRoot, expected] = process.argv.slice(2);
assert.ok(path.isAbsolute(consumer) && path.isAbsolute(sourceRoot) && path.isAbsolute(fixtureRoot));
assert.ok(expected === 'absent' || expected === 'present');
const product = path.join(consumer, 'node_modules', 'backend-skeleton');
const load = rel => import(pathToFileURL(path.join(product, rel)).href);
const graphPath = path.join(product, 'scanners/project-graph/registered.mjs');
const cachePath = path.join(product, 'lib/scan-scheduler-next/project-cache-plan.mjs');
assert.equal(fs.existsSync(graphPath), expected === 'present');
assert.equal(fs.existsSync(cachePath), expected === 'present');

const { runScan } = await load('scanners/index.mjs');
const stable = runScan({ repoRoot: path.join(sourceRoot, 'test/fixtures/java-spring'), terms: [] });
assert.equal(stable.schema, 'sbf.scan-report/2');
assert.equal(stable.adapter, 'java-spring');

let graphProof = null;
if (expected === 'present') {
  const { buildRegisteredProjectScanPlan } = await load('scanners/project-graph/registered.mjs');
  const { buildProjectCachePlan } = await load('lib/scan-scheduler-next/project-cache-plan.mjs');
  const { graph, plan } = buildRegisteredProjectScanPlan(fixtureRoot);
  const selected = [
    ['services/express', 'typescript-express'],
    ['services/express-js', 'javascript-express'],
    ['services/fastapi', 'python-fastapi'],
    ['services/rails', 'ruby-rails'],
    ['services/spring', 'java-spring'],
  ];
  assert.deepEqual(graph.registry_load_errors, []);
  assert.deepEqual(plan.map(item => [item.project_root, item.adapter_id]), selected);
  const cachePlan = buildProjectCachePlan(graph);
  assert.deepEqual(cachePlan.projects.map(item => [item.project_root, item.adapter_id]), selected);
  assert.ok(cachePlan.projects.every(item => /^[0-9a-f]{64}$/.test(item.cache_namespace)));
  graphProof = { graph_schema: graph.schema, cache_schema: cachePlan.schema,
    selected_adapters: selected.map(([, id]) => id), project_count: graph.projects.length };
}

if (expected === 'present' && process.env.T02_TEST_INTERRUPT_PROBE === '1')
  process.kill(process.pid, 'SIGTERM');
console.log(JSON.stringify({ schema: 'bskel.t02-installed-replay-probe/1', expected,
  stable_adapter: stable.adapter, graph: graphProof, release_authorized: false }));
