import { ADAPTERS, LOAD_ERRORS } from '../registry.mjs';
import { buildProjectGraph, buildProjectScanPlan } from './index.mjs';

export function buildRegisteredProjectGraph(repoRoot, options = {}) {
  const graph = buildProjectGraph({
    repoRoot,
    adapters: options.adapters ?? ADAPTERS,
    ...(options.markerRules ? { markerRules: options.markerRules } : {}),
  });
  return {
    ...graph,
    registry_load_errors: LOAD_ERRORS.map((entry) => ({
      file: entry.file,
      message: entry.message,
    })),
  };
}

export function buildRegisteredProjectScanPlan(repoRoot, { includeFallback = false, ...options } = {}) {
  const graph = buildRegisteredProjectGraph(repoRoot, options);
  return {
    graph,
    plan: buildProjectScanPlan(graph, { includeFallback }),
  };
}
