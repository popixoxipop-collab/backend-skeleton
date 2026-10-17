/**
 * T13 Next.js monorepo product candidate — deterministic discovery and opt-in
 * selection over ONE verified pinned Git snapshot.
 *
 * The caller-selected Git executable/object store is NOT an operating trust
 * authority. No runtime method/schema/auth evidence is inferred. Never reads
 * mutable target worktree source, executes target app JS, loads child configs,
 * or signs/grants a source snapshot. Not registered as a product adapter.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { requireVerifiedSnapshot } from './git-snapshot.mjs';
import { makeSnapshotFs } from './virtual-fs.mjs';
import { createNextScanner, ORIGINAL_T13_NEXT_SOURCE_SHA256 } from './next-static-factory.mjs';

const MAX_NEXT_PROJECTS = 64;
const MAX_WARNINGS = 100;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.git', 'coverage']);
const INPUT_ROUTE = /^(?:app|src\/app)\/(?:.*\/)?route\.(?:js|ts)$/;
const INPUT_PAGE = /^(?:pages\/api|src\/pages\/api)\/.+\.(?:js|jsx|ts|tsx)$/;
const hash = obj => crypto.createHash('sha256').update(
  Buffer.from(JSON.stringify(obj), 'utf8')).digest('hex');
const lex = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export class NextMonorepoError extends Error {
  constructor(code) {
    super(code);
    this.name = 'NextMonorepoError';
    this.code = code;
  }
}
function skipped(parts) { return parts.some(part => SKIP_DIRS.has(part)); }
export function validProjectId(value) {
  if (value === '.') return true;
  return typeof value === 'string' && value.length > 0 && value.length <= 500 &&
    !value.includes('\\') && !value.includes('\0') &&
    !value.startsWith('/') && !value.endsWith('/') &&
    value.split('/').every(part => part !== '.' && part !== '..' &&
      /^[\p{L}\p{N}_@.-]+$/u.test(part));
}
function declaresNext(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return false;
  }
  return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .some(key => {
      const dep = manifest[key];
      return dep && typeof dep === 'object' && !Array.isArray(dep) &&
        typeof dep.next === 'string';
    });
}
function projectFromPackage(relative) {
  return relative === 'package.json'
    ? '.' : relative.slice(0, -'/package.json'.length);
}
function relativeInProject(item, project) {
  if (project === '.') return item;
  return item.startsWith(project + '/') ? item.slice(project.length + 1) : null;
}
function isSupportedRouteFile(relative) {
  if (relative === null || skipped(relative.split('/'))) return null;
  if (INPUT_ROUTE.test(relative)) return 'app';
  if (INPUT_PAGE.test(relative)) return 'pages';
  return null;
}
function limitedWarning(warnings, warning) {
  if (warnings.length >= MAX_WARNINGS) {
    throw new NextMonorepoError('TOO_MANY_INVALID_PACKAGE_MANIFESTS');
  }
  warnings.push(warning);
}

export function catalogPinnedNextProjects(snapshot) {
  requireVerifiedSnapshot(snapshot);
  if (!Array.isArray(snapshot.entries)) {
    throw new NextMonorepoError('SNAPSHOT_NOT_VERIFIED');
  }
  const warnings = [];
  const manifests = snapshot.entries
    .filter(file => file.relative === 'package.json' ||
      file.relative.endsWith('/package.json'))
    .sort((a, b) => lex(a.relative, b.relative));
  const projects = [];
  const allFiles = snapshot.entries
    .filter(item => item.type === 'file' && !skipped(item.relative.split('/')))
    .map(item => item.relative);
  for (const file of manifests) {
    if (skipped(file.relative.split('/'))) continue;
    if (file.type !== 'file' || typeof file.text !== 'string') {
      limitedWarning(warnings, Object.freeze({
        file: file.relative, code: 'PACKAGE_SOURCE_NOT_REGULAR_OR_AVAILABLE',
      }));
      continue;
    }
    let body;
    try { body = JSON.parse(file.text); }
    catch {
      limitedWarning(warnings, Object.freeze({
        file: file.relative, code: 'PACKAGE_JSON_INVALID',
      }));
      continue;
    }
    if (!declaresNext(body)) continue;
    const projectId = projectFromPackage(file.relative);
    if (!validProjectId(projectId)) {
      limitedWarning(warnings, Object.freeze({
        file: file.relative, code: 'NEXT_PROJECT_PATH_UNSUPPORTED',
      }));
      continue;
    }
    if (projects.length >= MAX_NEXT_PROJECTS) {
      throw new NextMonorepoError('TOO_MANY_NEXT_PROJECTS');
    }
    const routes = [];
    const pages = [];
    for (const name of allFiles) {
      const rel = relativeInProject(name, projectId);
      const kind = isSupportedRouteFile(rel);
      if (kind === 'app') routes.push(name);
      if (kind === 'pages') pages.push(name);
    }
    const name = typeof body.name === 'string' && body.name.length <= 120
      ? body.name : projectId;
    projects.push(Object.freeze({
      id: projectId,
      packageFile: file.relative,
      name,
      appRouteSourceCount: routes.length,
      pagesApiSourceCount: pages.length,
      serverSourceCount: routes.length + pages.length,
      routeStatus: routes.length + pages.length ? 'sources-present' : 'no-server-sources',
    }));
  }
  projects.sort((a, b) => lex(a.id, b.id));
  const publicWarnings = Object.freeze(warnings);
  const publicProjects = Object.freeze(projects);
  return Object.freeze({
    projects: publicProjects,
    warnings: publicWarnings,
    incomplete: warnings.length !== 0,
    catalogSha256: hash({ projects: publicProjects, warnings: publicWarnings }),
  });
}
function normalizedProjectSource(snapshot, project, file) {
  const virtualRoot = snapshot.virtualRoot;
  const rel = path.posix.relative(virtualRoot, file);
  if (!rel || rel === '.' || rel.startsWith('../') || path.posix.isAbsolute(rel)) {
    throw new NextMonorepoError('SCANNED_SOURCE_PATH_OUTSIDE_VIRTUAL_ROOT');
  }
  if (project.id !== '.' && !rel.startsWith(project.id + '/')) {
    throw new NextMonorepoError('SCANNED_SOURCE_PATH_OUTSIDE_PROJECT');
  }
  return rel;
}
function scanOne(snapshot, io, scanner, project) {
  const projectRoot = project.id === '.'
    ? io.root : path.posix.join(io.root, project.id);
  const packageFile = path.posix.join(projectRoot, 'package.json');
  const report = scanner.scanNext(io.root, { projectRoot, packageFile });
  const endpointList = report.modules.flatMap(module =>
    module.controllers.flatMap(controller =>
      controller.endpoints.map(endpoint => Object.freeze({
        project: project.id,
        method: endpoint.verb,
        route: endpoint.path,
        source: normalizedProjectSource(snapshot, project, controller.file),
        line: endpoint.line,
        params: endpoint.params,
      }))));
  const reportSha256 = hash(report);
  return Object.freeze({
    id: project.id,
    name: project.name,
    status: project.serverSourceCount ? 'scanned' : 'next-without-server-sources',
    endpointCount: endpointList.length,
    sourceInputCount: report.filesRead.length,
    reportSha256,
    report,
    endpoints: endpointList,
  });
}
/**
 * Supports list/auto/single/all modes. Multi-project auto never silently
 * selects the first directory; consumers must choose project or all.
 */
export function scanPinnedNextMonorepo({
  snapshot, mode = 'auto', projectId = null,
} = {}) {
  requireVerifiedSnapshot(snapshot);
  if (!['auto', 'list', 'single', 'all'].includes(mode)) {
    throw new NextMonorepoError('INVALID_SCAN_MODE');
  }
  if (mode === 'single' && !validProjectId(projectId)) {
    throw new NextMonorepoError('INVALID_PROJECT_ID');
  }
  if (mode !== 'single' && projectId !== null) {
    throw new NextMonorepoError('UNEXPECTED_PROJECT_SELECTION');
  }
  const catalog = catalogPinnedNextProjects(snapshot);
  const selected =
    mode === 'list' ? [] :
    mode === 'all' ? catalog.projects :
    mode === 'single' ? catalog.projects.filter(p => p.id === projectId) :
    catalog.projects.length === 1 ? catalog.projects : [];
  if (mode === 'single' && selected.length === 0) {
    throw new NextMonorepoError('SELECTED_NEXT_PROJECT_NOT_FOUND');
  }
  const selectionRequired = mode === 'auto' && catalog.projects.length > 1;
  let reportItems = [];
  let ioOperations = { open: 0, read: 0, unclosed: 0 };
  if (selected.length) {
    const io = makeSnapshotFs(snapshot);
    const scanner = createNextScanner(io);
    reportItems = selected.map(project => scanOne(snapshot, io, scanner, project));
    ioOperations = io.operationCount();
    if (ioOperations.unclosed !== 0) {
      throw new NextMonorepoError('VIRTUAL_FD_LEAK');
    }
  }
  const endpoints = reportItems.flatMap(item => item.endpoints);
  const sourceCommit = snapshot.git_commit;
  const sourceTree = snapshot.git_tree;
  const trust = Object.freeze({
    type: 'caller-selected-pinned-Git-object-store',
    externallyAuthorized: false,
    sourceCommit,
    sourceTree,
    snapshotSha256: snapshot.snapshot_sha256,
    scannerSourceSha256: ORIGINAL_T13_NEXT_SOURCE_SHA256,
  });
  const status = selectionRequired ? 'selection-required' :
    mode === 'list' ? 'project-list' :
    catalog.projects.length === 0
      ? (catalog.incomplete ? 'incomplete-catalog' : 'no-next-projects') :
    mode === 'single' ? 'selected' :
    catalog.incomplete ? 'partial-scan' : 'scanned';
  const data = {
    schema: 'backend-skeleton.next-pinned-monorepo/1',
    mode,
    status,
    support: Object.freeze({
      stage: 'experimental',
      verificationBasis: 'synthetic-only',
      runtimeCertified: false,
      operationRegistrationAllowed: false,
      methodInference: 'explicit-export-only',
    }),
    trust,
    catalog,
    projectSelection: {
      requestedProjectId: projectId,
      selectedProjectIds: selected.map(p => p.id),
      selectionRequired,
    },
    projects: reportItems,
    endpoints,
    inventory: {
      trackedFiles: snapshot.file_count,
      hydratedSourceFiles: snapshot.hydrated_file_count,
      hydratedSourceBytes: snapshot.hydrated_bytes,
      matchedNextProjects: catalog.projects.length,
      scannedProjects: reportItems.length,
      endpointCount: endpoints.length,
      virtualFdOperations: ioOperations,
    },
  };
  const resultSha256 = hash({
    schema: data.schema, mode, status, trust, catalog,
    projectSelection: data.projectSelection,
    reportHashes: reportItems.map(item => [item.id, item.reportSha256]),
    endpoints,
  });
  return Object.freeze({ ...data, resultSha256 });
}
