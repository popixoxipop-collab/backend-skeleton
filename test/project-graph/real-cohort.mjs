import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { runScan } from '../../scanners/index.mjs';
import { buildRegisteredProjectGraph, buildRegisteredProjectScanPlan } from '../../scanners/project-graph/registered.mjs';
import { executeProjectScanPlan } from '../../scanners/project-graph/shadow.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'real-cohort-manifest.json'), 'utf8'));

const [caseId, checkoutArg] = process.argv.slice(2);
if (!caseId || !checkoutArg) {
  console.error('usage: node test/project-graph/real-cohort.mjs <case-id> <checkout-path>');
  process.exit(2);
}
const entry = manifest.cases.find((item) => item.id === caseId);
if (!entry) throw new Error('unknown cohort case: ' + caseId);

const repoRoot = path.resolve(checkoutArg);
const actualCommit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(actualCommit, entry.commit, 'checkout must match the pinned cohort commit');

const graph = buildRegisteredProjectGraph(repoRoot);
const serialized = JSON.stringify(graph);
assert.ok(!serialized.includes(repoRoot), 'serialized ProjectGraph must not contain the absolute checkout root');

const planned = buildRegisteredProjectScanPlan(repoRoot);
const planPairs = planned.plan.map((item) => [item.project_root, item.adapter_id]);
assert.deepEqual(planPairs, entry.expected_plan);

const legacy = runScan({
  repoRoot,
  terms: [],
  includeDb: false,
  dbSchema: null,
  adapters: ADAPTERS,
  rgAvailable: true,
  runtimeRoutes: false,
});
assert.equal(legacy.adapter, entry.expected_legacy_adapter);

const shadow = executeProjectScanPlan({ repoRoot, graph, terms: [], adapters: ADAPTERS });
assert.deepEqual(
  shadow.scans.map((item) => [item.project_root, item.adapter_id]),
  entry.expected_plan,
);
assert.ok(shadow.scans.every((item) => item.report.schema === 'sbf.scan-report/2'));

const digest = 'sha256:' + crypto.createHash('sha256').update(serialized).digest('hex');
console.log(JSON.stringify({
  schema: 't02.real-project-cohort-result/1',
  certification: false,
  case_id: caseId,
  repository: entry.repository,
  commit: actualCommit,
  graph_digest: digest,
  legacy_adapter: legacy.adapter,
  project_count: graph.projects.length,
  projects: graph.projects.map((project) => ({
    root: project.root,
    kind: project.kind,
    selected_adapter: project.facets.http.selected_adapter,
    candidates: project.facets.http.candidates.map((candidate) => candidate.adapter_id),
    selected_read_set_files: project.selected_adapter_read_set?.files.length ?? 0,
  })),
  plan: planPairs,
  graph_files_read: graph.files_read.length,
  project_edges: graph.project_edges.length,
  unresolved_kinds: [...new Set(graph.unresolved.map((item) => item.kind))].sort(),
}));
