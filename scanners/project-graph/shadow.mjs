import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runScan } from '../index.mjs';
import { ADAPTERS } from '../registry.mjs';
import { PROJECT_GRAPH_DRAFT, buildProjectScanPlan, captureAdapterReadSetSnapshot } from './index.mjs';

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

function resolveRepoFile(repoRoot, relativePath) {
  const base = path.resolve(repoRoot);
  const target = path.resolve(base, relativePath);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('graph marker escapes repository: ' + relativePath);
    err.code = 'PROJECT_MARKER_ESCAPE';
    throw err;
  }
  return target;
}

function sha256File(file) {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verifyProjectMarkers(repoRoot, project) {
  for (const marker of project.markers ?? []) {
    const file = resolveRepoFile(repoRoot, marker.path);
    let actual;
    try {
      actual = sha256File(file);
    } catch (err) {
      const stale = new Error('project marker is missing or unreadable: ' + marker.path + ': ' + err.message);
      stale.code = 'PROJECT_GRAPH_STALE';
      stale.project_id = project.project_id;
      stale.marker_path = marker.path;
      throw stale;
    }
    if (actual !== marker.digest) {
      const stale = new Error('project marker changed after graph discovery: ' + marker.path);
      stale.code = 'PROJECT_GRAPH_STALE';
      stale.project_id = project.project_id;
      stale.marker_path = marker.path;
      stale.expected_digest = marker.digest;
      stale.actual_digest = actual;
      throw stale;
    }
  }
}

function adapterMap(adapters) {
  const out = new Map();
  for (const adapter of adapters) {
    if (out.has(adapter.id)) throw new Error('duplicate adapter id: ' + adapter.id);
    out.set(adapter.id, adapter);
  }
  return out;
}

function verifySelectedAdapterReadSet(repoRoot, projectRoot, project, adapter) {
  const expected = project.selected_adapter_read_set ?? null;
  if (!expected) return;

  let current;
  try {
    current = captureAdapterReadSetSnapshot({ repoRoot, projectRoot, adapter });
  } catch (err) {
    const stale = new Error('could not reproduce selected adapter read-set: ' + err.message);
    stale.code = 'PROJECT_GRAPH_STALE';
    stale.stale_kind = 'adapter-read-set';
    stale.project_id = project.project_id;
    stale.adapter_id = adapter.id;
    stale.cause = err;
    throw stale;
  }

  if (!current || current.adapter_id !== expected.adapter_id || current.fingerprint !== expected.fingerprint) {
    const stale = new Error('selected adapter read-set changed after graph discovery: ' + project.project_id);
    stale.code = 'PROJECT_GRAPH_STALE';
    stale.stale_kind = 'adapter-read-set';
    stale.project_id = project.project_id;
    stale.adapter_id = adapter.id;
    stale.expected_fingerprint = expected.fingerprint ?? null;
    stale.actual_fingerprint = current?.fingerprint ?? null;
    stale.expected_files = expected.files?.map((file) => file.path) ?? [];
    stale.actual_files = current?.files?.map((file) => file.path) ?? [];
    throw stale;
  }
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
  const projectsById = new Map(graph.projects.map((project) => [project.project_id, project]));
  const plan = buildProjectScanPlan(graph, { includeFallback });
  const results = [];

  for (const item of plan) {
    const project = projectsById.get(item.project_id);
    if (!project) {
      const err = new Error('planned project is unavailable in graph: ' + item.project_id);
      err.code = 'PROJECT_PLAN_INVALID';
      throw err;
    }
    verifyProjectMarkers(base, project);

    const adapter = byId.get(item.adapter_id);
    if (!adapter) {
      const err = new Error('planned adapter is unavailable: ' + item.adapter_id);
      err.code = 'PROJECT_ADAPTER_UNAVAILABLE';
      throw err;
    }
    const projectRoot = resolveProjectRoot(base, item.project_root);
    verifySelectedAdapterReadSet(base, projectRoot, project, adapter);
    let report;
    try {
      report = runScan({
        repoRoot: projectRoot,
        terms,
        includeDb: false,
        dbSchema: null,
        adapters: [adapter],
        rgAvailable,
        runtimeRoutes: false,
      });
    } catch (err) {
      const stale = new Error(
        'project scan no longer satisfies its planned adapter ' + item.adapter_id + ': ' + err.message,
      );
      stale.code = 'PROJECT_PLAN_STALE';
      stale.cause = err;
      stale.project_id = item.project_id;
      stale.adapter_id = item.adapter_id;
      throw stale;
    }
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
      'project marker digests and the selected adapter read-set are rechecked immediately before execution; stale graph inputs fail closed',
      'DB and runtime-route execution are intentionally disabled in this composition slice',
    ],
  };
}
