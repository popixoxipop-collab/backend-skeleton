import { ADAPTERS, LOAD_ERRORS } from '../registry.mjs';
import { buildProjectGraph, buildProjectScanPlan } from './index.mjs';

export function portableRegistryLoadErrors(entries) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  return entries.map((entry) => {
    const rawFile = typeof entry?.file === 'string' ? entry.file : '';
    const normalizedFile = rawFile.replace(/\\/g, '/');
    const slash = normalizedFile.lastIndexOf('/');
    const file = slash >= 0 ? normalizedFile.slice(slash + 1) : normalizedFile || '(unknown)';
    const rawDir = rawFile && rawFile.length > file.length
      ? rawFile.slice(0, rawFile.length - file.length).replace(/[\\/]$/, '')
      : '';
    const normalizedDir = slash >= 0 ? normalizedFile.slice(0, slash) : '';
    let message = String(entry?.message ?? '');
    if (rawDir) message = message.replaceAll(rawDir, '<adapter-dir>');
    if (normalizedDir) message = message.replaceAll(normalizedDir, '<adapter-dir>');
    message = message.replace(/\\/g, '/');
    return { file, message };
  }).sort((a, b) => a.file.localeCompare(b.file) || a.message.localeCompare(b.message));
}

export function buildRegisteredProjectGraph(repoRoot, options = {}) {
  const graph = buildProjectGraph({
    repoRoot,
    adapters: options.adapters ?? ADAPTERS,
    ...(options.markerRules ? { markerRules: options.markerRules } : {}),
  });
  graph.registry_load_errors = portableRegistryLoadErrors(LOAD_ERRORS);
  return graph;
}

export function buildRegisteredProjectScanPlan(repoRoot, { includeFallback = false, ...options } = {}) {
  const graph = buildRegisteredProjectGraph(repoRoot, options);
  return {
    graph,
    plan: buildProjectScanPlan(graph, { includeFallback }),
  };
}
