import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Draft-only internal shape for T02. This is intentionally NOT a stable public SBF contract;
// T01 owns the eventual cross-tool schema/identity vocabulary.
export const PROJECT_GRAPH_DRAFT = 'sbf.project-graph/draft-1';

const HARD_IGNORES = new Set([
  '.git', '.hg', '.svn', '.bskel', 'node_modules', 'coverage', '.cache', '.turbo',
  'dist', 'build', 'out', '.next', '.svelte-kit', 'vendor', 'third_party', 'third-party',
]);

const DEFAULT_MARKER_RULES = Object.freeze([
  { kind: 'node-package', test: (name) => name === 'package.json' },
  { kind: 'python-project', test: (name) => name === 'pyproject.toml' || /^requirements(?:[.-].*)?\.txt$/i.test(name) },
  { kind: 'jvm-build', test: (name) => name === 'pom.xml' || name === 'build.gradle' || name === 'build.gradle.kts' },
  { kind: 'jvm-workspace', test: (name) => name === 'settings.gradle' || name === 'settings.gradle.kts' },
  { kind: 'ruby-bundle', test: (name) => name === 'Gemfile' },
  // Forward-compatible discovery only. These markers do not imply that a matching adapter exists.
  { kind: 'go-module', test: (name) => name === 'go.mod' },
  { kind: 'rust-package', test: (name) => name === 'Cargo.toml' },
  { kind: 'php-package', test: (name) => name === 'composer.json' },
  { kind: 'dotnet-project', test: (name) => /\.(?:cs|fs|vb)proj$/i.test(name) },
]);

function posixRel(root, target) {
  const rel = path.relative(root, target).split(path.sep).join('/');
  return rel || '.';
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fileDigest(file) {
  return 'sha256:' + sha256(fs.readFileSync(file));
}

function markerKind(name, markerRules) {
  return markerRules.find((rule) => rule.test(name))?.kind ?? null;
}

function walkForMarkers(repoRoot, markerRules, unresolved) {
  const stack = [repoRoot];
  const markers = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      unresolved.push({ kind: 'directory-read', path: posixRel(repoRoot, dir), message: err.message });
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    // Reverse push so DFS visit order is deterministic ascending after pop(). Final output is sorted too.
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!HARD_IGNORES.has(entry.name)) stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = markerKind(entry.name, markerRules);
      if (!kind) continue;
      try {
        markers.push({ abs, kind, digest: fileDigest(abs) });
      } catch (err) {
        unresolved.push({ kind: 'marker-read', path: posixRel(repoRoot, abs), message: err.message });
      }
    }
  }
  return markers.sort((a, b) => a.abs.localeCompare(b.abs) || a.kind.localeCompare(b.kind));
}

export function discoverProjectRoots(repoRoot, { markerRules = DEFAULT_MARKER_RULES } = {}) {
  const absRoot = path.resolve(repoRoot);
  const unresolved = [];
  const markers = walkForMarkers(absRoot, markerRules, unresolved);
  const byRoot = new Map();

  for (const marker of markers) {
    const root = path.dirname(marker.abs);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push({
      path: posixRel(absRoot, marker.abs),
      kind: marker.kind,
      digest: marker.digest,
    });
  }

  // No marker must still preserve the legacy possibility that generic-grep can inspect the repo.
  if (byRoot.size === 0) byRoot.set(absRoot, []);

  const roots = [...byRoot.entries()]
    .map(([root, rootMarkers]) => ({
      root: posixRel(absRoot, root),
      absolute_root: root,
      markers: rootMarkers.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind)),
    }))
    .sort((a, b) => a.root.localeCompare(b.root));

  return {
    repo_root: absRoot,
    roots,
    unresolved,
    files_read: markers.map((m) => posixRel(absRoot, m.abs)).sort(),
  };
}

function stripJavaSourceRoot(abs) {
  const parts = path.resolve(abs).split(path.sep);
  const n = parts.length;
  if (n >= 3 && parts[n - 3] === 'src' && parts[n - 2] === 'main' && parts[n - 1] === 'java') {
    return parts.slice(0, n - 3).join(path.sep) || path.parse(abs).root;
  }
  return null;
}

export function inferDetectionProjectRoot(detection) {
  if (typeof detection === 'string' && detection.length > 0) {
    return stripJavaSourceRoot(detection) ?? path.resolve(detection);
  }
  if (!detection || typeof detection !== 'object') return null;
  if (typeof detection.projectRoot === 'string' && detection.projectRoot.length > 0) {
    return path.resolve(detection.projectRoot);
  }
  if (typeof detection.srcRoot === 'string' && detection.srcRoot.length > 0) {
    return stripJavaSourceRoot(detection.srcRoot) ?? path.resolve(detection.srcRoot);
  }
  return null;
}

function adapterSummary(adapter) {
  return {
    adapter_id: adapter.id,
    title: adapter.title ?? adapter.id,
    specificity: Number.isFinite(adapter.specificity) ? adapter.specificity : 0,
    confidence: adapter.confidence ?? 'unknown',
    verification_basis: adapter.verificationBasis ?? 'unknown',
    capabilities: { ...(adapter.capabilities ?? {}) },
  };
}

function isFallbackAdapter(adapter) {
  return adapter.id === 'generic-grep' || adapter.specificity === 0;
}

function childRootsOf(root, allRoots) {
  const prefix = root === '.' ? '' : root + '/';
  return allRoots
    .filter((candidate) => candidate !== root && (root === '.' || candidate.startsWith(prefix)))
    .sort();
}

export function buildProjectGraph({ repoRoot, adapters, markerRules = DEFAULT_MARKER_RULES } = {}) {
  if (!repoRoot) throw new TypeError('repoRoot is required');
  if (!Array.isArray(adapters)) throw new TypeError('adapters must be an array');

  const discovery = discoverProjectRoots(repoRoot, { markerRules });
  const absRepo = discovery.repo_root;
  const allRoots = discovery.roots.map((p) => p.root);
  const unresolved = [...discovery.unresolved];
  const projects = [];

  for (const candidate of discovery.roots) {
    const firstClass = [];
    const nestedDetections = [];
    let fallback = null;

    for (const adapter of [...adapters].sort((a, b) => (b.specificity ?? 0) - (a.specificity ?? 0) || a.id.localeCompare(b.id))) {
      let detection;
      try {
        detection = adapter.detect(candidate.absolute_root);
      } catch (err) {
        unresolved.push({
          kind: 'adapter-detect-error', project_root: candidate.root, adapter_id: adapter.id,
          message: err.message,
        });
        continue;
      }
      if (detection == null || detection === false) continue;

      if (isFallbackAdapter(adapter)) {
        fallback = adapterSummary(adapter);
        continue;
      }

      const detectedRoot = inferDetectionProjectRoot(detection);
      if (!detectedRoot) {
        unresolved.push({
          kind: 'unlocated-detection', project_root: candidate.root, adapter_id: adapter.id,
          message: 'adapter detected the candidate but returned no recognized project-root shape; T02 refuses to guess ownership',
        });
        continue;
      }
      const relDetected = posixRel(absRepo, detectedRoot);
      if (path.resolve(detectedRoot) !== path.resolve(candidate.absolute_root)) {
        // Existing adapters recurse. On an aggregate root they may find a child service. Preserve the
        // fact for diagnostics, but do not let the parent steal the child facet.
        const relFromCandidate = path.relative(candidate.absolute_root, detectedRoot);
        const nested = relFromCandidate && !relFromCandidate.startsWith('..') && !path.isAbsolute(relFromCandidate);
        if (nested) {
          nestedDetections.push({ adapter_id: adapter.id, detected_root: relDetected });
          continue;
        }
        unresolved.push({
          kind: 'out-of-scope-detection', project_root: candidate.root, adapter_id: adapter.id,
          detected_root: relDetected,
          message: 'adapter detection escaped the candidate project root',
        });
        continue;
      }
      firstClass.push(adapterSummary(adapter));
    }

    firstClass.sort((a, b) => b.specificity - a.specificity || a.adapter_id.localeCompare(b.adapter_id));
    nestedDetections.sort((a, b) => a.adapter_id.localeCompare(b.adapter_id) || a.detected_root.localeCompare(b.detected_root));
    const topSpecificity = firstClass[0]?.specificity ?? null;
    const tied = topSpecificity == null ? [] : firstClass.filter((a) => a.specificity === topSpecificity);
    const selected = tied.length === 1 ? tied[0].adapter_id : null;
    const descendants = childRootsOf(candidate.root, allRoots);
    const kind = selected ? 'application' : tied.length > 1 ? 'ambiguous' : descendants.length > 0 ? 'aggregate' : 'unrecognized';

    projects.push({
      project_id: 'project:' + candidate.root,
      root: candidate.root,
      kind,
      markers: candidate.markers,
      facets: {
        http: {
          candidates: firstClass,
          selected_adapter: selected,
          selection_reason: tied.length > 1 ? 'specificity-tie' : selected ? 'unique-highest-specificity' : 'no-first-class-adapter',
          ambiguous_adapter_ids: tied.length > 1 ? tied.map((a) => a.adapter_id) : [],
        },
      },
      fallback_adapter: firstClass.length === 0 ? fallback?.adapter_id ?? null : null,
      child_project_roots: descendants,
      nested_detections: nestedDetections,
    });
  }

  return {
    schema: PROJECT_GRAPH_DRAFT,
    repo_root: absRepo,
    projects: projects.sort((a, b) => a.root.localeCompare(b.root)),
    unresolved,
    files_read: discovery.files_read,
    notes: [
      'draft internal T02 graph: project ownership is repo-root scoped; no stable cross-tool identity is claimed yet',
      'legacy runScan() is unchanged; selected_adapter is a per-project scan plan hint, not an executed scan result',
    ],
  };
}

export function buildProjectScanPlan(graph, { includeFallback = false } = {}) {
  if (!graph || graph.schema !== PROJECT_GRAPH_DRAFT || !Array.isArray(graph.projects)) {
    throw new TypeError('expected ' + PROJECT_GRAPH_DRAFT);
  }
  const plan = [];
  for (const project of graph.projects) {
    const selected = project.facets?.http?.selected_adapter ?? null;
    if (selected) {
      plan.push({ project_id: project.project_id, project_root: project.root, adapter_id: selected, mode: 'first-class' });
    } else if (includeFallback && project.fallback_adapter && project.kind !== 'aggregate') {
      plan.push({ project_id: project.project_id, project_root: project.root, adapter_id: project.fallback_adapter, mode: 'fallback' });
    }
  }
  return plan.sort((a, b) => a.project_root.localeCompare(b.project_root) || a.adapter_id.localeCompare(b.adapter_id));
}
