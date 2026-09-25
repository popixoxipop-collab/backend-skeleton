import path from 'node:path';
import { runScan } from '../index.mjs';
import { ADAPTERS } from '../registry.mjs';
import { PROJECT_GRAPH_DRAFT, buildProjectScanPlan } from './index.mjs';

function resolveProjectRoot(repoRoot, relativeRoot) {
  const base = path.resolve(repoRoot);
  const target = relativeRoot === '.' ? base : path.resolve(base, relativeRoot);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('project root escapes repository: ' + relativeRoot);
    err.code = 'PROJECT_ROOT_ESCAPE';
    throw err;
  }
  return target;
}

function adapterMap(adapters) {
  const out = new Map();
  for (const adapter of adapters) {
    if (out.has(adapter.id)) throw new Error('duplicate adapter id: ' + adapter.id);
    out.set(adapter.id, adapter);
  }
  return out;
}

// Shadow-only composition path for T02. It reuses legacy runScan() unchanged, one project at a
// time, and wraps each legacy sbf.scan-report/2 with its project identity. It is intentionally
// not wired to the CLI or contract emitter yet.
export function executeProjectScanPlan({
  repoRoot,
  graph,
  terms = [],
  adapters = ADAPTERS,
  rgAvailable = true,
  includeFallback = false,
} = {}) {
  if (!repoRoot) throw new TypeError('repoRoot is required');
  if (!graph || graph.schema !== PROJECT_GRAPH_DRAFT) {
    throw new TypeError('expected ' + PROJECT_GRAPH_DRAFT);
  }
  const base = path.resolve(repoRoot);
  if (path.resolve(graph.repo_root) !== base) {
    const err = new Error('graph repo_root does not match execution repoRoot');
    err.code = 'PROJECT_GRAPH_ROOT_MISMATCH';
    throw err;
  }

  const byId = adapterMap(adapters);
  const plan = buildProjectScanPlan(graph, { includeFallback });
  const results = [];

  for (const item of plan) {
    const adapter = byId.get(item.adapter_id);
    if (!adapter) {
      const err = new Error('planned adapter is unavailable: ' + item.adapter_id);
      err.code = 'PROJECT_ADAPTER_UNAVAILABLE';
      throw err;
    }
    const projectRoot = resolveProjectRoot(base, item.project_root);
    const report = runScan({
      repoRoot: projectRoot,
      terms,
      includeDb: false,
      dbSchema: null,
      adapters: [adapter],
      rgAvailable,
      runtimeRoutes: false,
    });
    if (report.adapter !== item.adapter_id) {
      const err = new Error(
        'project scan selected ' + report.adapter + ' but graph planned ' + item.adapter_id,
      );
      err.code = 'PROJECT_PLAN_DRIFT';
      throw err;
    }
    results.push({
      project_id: item.project_id,
      project_root: item.project_root,
      adapter_id: item.adapter_id,
      mode: item.mode,
      report,
    });
  }

  return {
    schema: 'sbf.project-scan-shadow/draft-1',
    graph_schema: graph.schema,
    terms: [...terms],
    scans: results,
    notes: [
      'shadow-only T02 execution: every nested report is the unchanged legacy sbf.scan-report/2',
      'DB and runtime-route execution are intentionally disabled in this composition slice',
    ],
  };
}
