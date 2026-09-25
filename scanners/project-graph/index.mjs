import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifyProjectSourceRole } from './source-role.mjs';

// Draft-only internal shape for T02. This is intentionally NOT a stable public SBF contract;
// T01 owns the eventual cross-tool schema/identity vocabulary.
export const PROJECT_GRAPH_DRAFT = 'sbf.project-graph/draft-1';
export const PROJECT_GRAPH_EXECUTION_ROOT = Symbol('sbf.project-graph.execution-root');

const HARD_IGNORES = new Set([
  '.git', '.hg', '.svn', '.bskel', 'node_modules', 'coverage', '.cache', '.turbo',
  'dist', 'build', 'out', '.next', '.svelte-kit', 'vendor', 'third_party', 'third-party',
]);

export function projectGraphExecutionRoot(graph) {
  return graph?.[PROJECT_GRAPH_EXECUTION_ROOT] ?? null;
}

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
    .map(([root, rootMarkers]) => {
      const relativeRoot = posixRel(absRoot, root);
      return {
        root: relativeRoot,
        absolute_root: root,
        project_role: relativeRoot === '.' ? 'active' : classifyProjectSourceRole(relativeRoot),
        markers: rootMarkers.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind)),
      };
    })
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

export function captureAdapterReadSetSnapshot({ repoRoot, projectRoot, adapter }) {
  if (!repoRoot || !projectRoot || !adapter) throw new TypeError('repoRoot, projectRoot, and adapter are required');
  if (typeof adapter.listReadSet !== 'function') return null;

  const absRepo = path.resolve(repoRoot);
  const absProject = path.resolve(projectRoot);
  const listed = adapter.listReadSet(absProject);
  if (!Array.isArray(listed)) {
    throw new TypeError('adapter.listReadSet() must return an array');
  }

  const seen = new Set();
  const files = [];
  for (const rel of listed) {
    if (typeof rel !== 'string' || rel.length === 0) {
      throw new TypeError('adapter.listReadSet() returned an invalid path');
    }
    const abs = path.resolve(absProject, rel);
    const projectDelta = path.relative(absProject, abs);
    if (projectDelta.startsWith('..') || path.isAbsolute(projectDelta)) {
      const err = new Error('adapter read-set path escapes project root: ' + rel);
      err.code = 'PROJECT_READ_SET_ESCAPE';
      throw err;
    }
    const repoDelta = path.relative(absRepo, abs);
    if (repoDelta.startsWith('..') || path.isAbsolute(repoDelta)) {
      const err = new Error('adapter read-set path escapes repository: ' + rel);
      err.code = 'PROJECT_READ_SET_ESCAPE';
      throw err;
    }
    const repoRelativePath = posixRel(absRepo, abs);
    if (seen.has(repoRelativePath)) continue;
    seen.add(repoRelativePath);
    files.push({
      path: repoRelativePath,
      digest: fileDigest(abs),
      role: classifyProjectSourceRole(posixRel(absProject, abs)),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const h = crypto.createHash('sha256');
  for (const file of files) {
    h.update(file.path); h.update('\0');
    h.update(file.digest); h.update('\0');
    h.update(file.role); h.update('\0');
  }

  return {
    adapter_id: adapter.id,
    files,
    fingerprint: 'sha256:' + h.digest('hex'),
  };
}

function childRootsOf(root, allRoots) {
  const prefix = root === '.' ? '' : root + '/';
  return allRoots
    .filter((candidate) => candidate !== root && (root === '.' || candidate.startsWith(prefix)))
    .sort();
}


function readLocalPackageFacts(absRepo, project, unresolved) {
  const marker = project.markers.find((m) => m.kind === 'node-package');
  if (!marker) return null;
  const file = path.resolve(absRepo, marker.path);
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    unresolved.push({
      kind: 'package-metadata-read',
      project_id: project.project_id,
      path: marker.path,
      message: err.message,
    });
    return null;
  }
  const deps = new Set();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const obj = pkg?.[field];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const name of Object.keys(obj)) deps.add(name);
  }
  const rawWorkspaces = Array.isArray(pkg?.workspaces)
    ? pkg.workspaces
    : Array.isArray(pkg?.workspaces?.packages)
      ? pkg.workspaces.packages
      : [];
  return {
    name: typeof pkg?.name === 'string' && pkg.name.length > 0 ? pkg.name : null,
    private: pkg?.private === true,
    dependency_names: [...deps].sort(),
    workspace_patterns: rawWorkspaces.filter((x) => typeof x === 'string').sort(),
    evidence: { path: marker.path, digest: marker.digest },
  };
}

function isDescendantRoot(parent, child) {
  if (parent === child) return false;
  if (parent === '.') return true;
  return child.startsWith(parent + '/');
}

function directParentOf(project, projects) {
  const candidates = projects
    .filter((p) => isDescendantRoot(p.root, project.root))
    .sort((a, b) => b.root.length - a.root.length || a.root.localeCompare(b.root));
  return candidates[0] ?? null;
}

function buildProjectEdges(projects, unresolved) {
  const edges = [];

  for (const project of projects) {
    const parent = directParentOf(project, projects);
    if (parent) {
      edges.push({
        kind: 'contains',
        from_project_id: parent.project_id,
        to_project_id: project.project_id,
        evidence: [],
      });
    }
  }

  const packageOwners = new Map();
  for (const project of projects) {
    const name = project.local_package?.name;
    if (!name) continue;
    if (!packageOwners.has(name)) packageOwners.set(name, []);
    packageOwners.get(name).push(project);
  }
  for (const owners of packageOwners.values()) {
    owners.sort((a, b) => a.root.localeCompare(b.root));
  }

  for (const [name, owners] of [...packageOwners.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (owners.length > 1) {
      unresolved.push({
        kind: 'ambiguous-local-package-name',
        package_name: name,
        project_ids: owners.map((p) => p.project_id),
        message: 'multiple discovered projects declare the same package name; local dependency edges will not guess an owner',
      });
    }
  }

  for (const project of projects) {
    for (const dependencyName of project.local_package?.dependency_names ?? []) {
      const owners = packageOwners.get(dependencyName) ?? [];
      if (owners.length === 0) continue; // external package, not a project edge
      if (owners.length > 1) {
        unresolved.push({
          kind: 'ambiguous-local-package-dependency',
          project_id: project.project_id,
          package_name: dependencyName,
          candidate_project_ids: owners.map((p) => p.project_id),
          message: 'dependency matches more than one local project; no edge was created',
        });
        continue;
      }
      const target = owners[0];
      if (target.project_id === project.project_id) continue;
      edges.push({
        kind: 'local-package-dependency',
        from_project_id: project.project_id,
        to_project_id: target.project_id,
        dependency_name: dependencyName,
        evidence: [project.local_package.evidence],
      });
    }
  }

  return edges.sort((a, b) =>
    a.kind.localeCompare(b.kind) ||
    a.from_project_id.localeCompare(b.from_project_id) ||
    a.to_project_id.localeCompare(b.to_project_id) ||
    (a.dependency_name ?? '').localeCompare(b.dependency_name ?? ''),
  );
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
    let selectedAdapterReadSet = null;
    if (selected) {
      const selectedAdapter = adapters.find((adapter) => adapter.id === selected) ?? null;
      if (!selectedAdapter) {
        unresolved.push({
          kind: 'selected-adapter-missing',
          project_root: candidate.root,
          adapter_id: selected,
          message: 'selected adapter disappeared before read-set capture',
        });
      } else {
        try {
          selectedAdapterReadSet = captureAdapterReadSetSnapshot({
            repoRoot: absRepo,
            projectRoot: candidate.absolute_root,
            adapter: selectedAdapter,
          });
        } catch (err) {
          unresolved.push({
            kind: 'adapter-read-set-error',
            project_root: candidate.root,
            adapter_id: selected,
            message: err.message,
          });
        }
      }
    }

    projects.push({
      project_id: 'project:' + candidate.root,
      root: candidate.root,
      project_role: candidate.project_role,
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
      selected_adapter_read_set: selectedAdapterReadSet,
      child_project_roots: descendants,
      nested_detections: nestedDetections,
    });
  }

  for (const project of projects) {
    project.local_package = readLocalPackageFacts(absRepo, project, unresolved);
  }
  const projectEdges = buildProjectEdges(projects, unresolved);
  const graphFilesRead = [...new Set([
    ...discovery.files_read,
    ...projects.flatMap((project) => project.selected_adapter_read_set?.files.map((file) => file.path) ?? []),
  ])].sort();

  const graph = {
    schema: PROJECT_GRAPH_DRAFT,
    repo_root: '.',
    projects: projects.sort((a, b) => a.root.localeCompare(b.root)),
    project_edges: projectEdges,
    unresolved,
    files_read: graphFilesRead,
    notes: [
      'draft internal T02 graph: project ownership is repo-root scoped; no stable cross-tool identity is claimed yet',
      'serialized repo_root is portable and repo-relative; the absolute execution root is non-enumerable process-local metadata',
      'legacy runScan() is unchanged; selected_adapter is a per-project scan plan hint, not an executed scan result',
      'selected first-party adapter read-sets are content-hashed for project-level freshness; cache/invalidation policy remains T21-owned',
      'reference/generated/template project roots remain visible in the graph but are excluded from the default scan plan',
    ],
  };
  Object.defineProperty(graph, PROJECT_GRAPH_EXECUTION_ROOT, {
    value: absRepo,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return graph;
}

export function buildProjectScanPlan(graph, { includeFallback = false, includeNonActive = false } = {}) {
  if (!graph || graph.schema !== PROJECT_GRAPH_DRAFT || !Array.isArray(graph.projects)) {
    throw new TypeError('expected ' + PROJECT_GRAPH_DRAFT);
  }
  const plan = [];
  for (const project of graph.projects) {
    if (!includeNonActive && project.project_role !== 'active') continue;
    const selected = project.facets?.http?.selected_adapter ?? null;
    if (selected) {
      plan.push({ project_id: project.project_id, project_root: project.root, adapter_id: selected, mode: 'first-class' });
    } else if (includeFallback && project.fallback_adapter && project.kind !== 'aggregate') {
      plan.push({ project_id: project.project_id, project_root: project.root, adapter_id: project.fallback_adapter, mode: 'fallback' });
    }
  }
  return plan.sort((a, b) => a.project_root.localeCompare(b.project_root) || a.adapter_id.localeCompare(b.adapter_id));
}
