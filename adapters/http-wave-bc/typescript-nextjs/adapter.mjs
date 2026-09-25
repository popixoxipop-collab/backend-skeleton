import fs from 'node:fs';
import path from 'node:path';
import { maskJsComments } from '../../../scanners/adapters/_express-shared.mjs';
import { lineNumberAt } from '../../../scanners/text-util.mjs';

const SOURCE_EXTENSIONS = new Set(['.js', '.ts']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.git', 'coverage']);
const APP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const NEXT_CONFIGS = [
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
  'next.config.ts',
  'next.config.mts',
  'next.config.cts',
];

function listFilesRecursive(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function declaresNext(pkg) {
  return Boolean(pkg?.dependencies?.next || pkg?.devDependencies?.next || pkg?.peerDependencies?.next);
}

function packageCandidates(repoRoot) {
  return listFilesRecursive(repoRoot)
    .filter((file) => path.basename(file) === 'package.json')
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
}

function routeRoots(projectRoot) {
  const candidates = [
    { kind: 'app', root: path.join(projectRoot, 'app') },
    { kind: 'app', root: path.join(projectRoot, 'src', 'app') },
    { kind: 'pages-api', root: path.join(projectRoot, 'pages', 'api') },
    { kind: 'pages-api', root: path.join(projectRoot, 'src', 'pages', 'api') },
  ];
  return candidates.filter(({ root }) => {
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

function nextConfigFiles(projectRoot) {
  return NEXT_CONFIGS
    .map((name) => path.join(projectRoot, name))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

function analyzeBasePath(projectRoot) {
  const files = nextConfigFiles(projectRoot);
  if (files.length === 0) return { prefix: '', unknown: false, notes: [], files: [] };

  const notes = [];
  let seenLiteral = null;
  let unknown = false;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const masked = maskJsComments(text);
    const hasBasePath = /\bbasePath\s*:/.test(masked);
    if (hasBasePath) {
      const literal = masked.match(/\bbasePath\s*:\s*(['"`])([^'"`]*)\1/);
      if (!literal || (literal[1] === '`' && literal[2].includes('${'))) {
        unknown = true;
        notes.push(`${path.basename(file)}: basePath is non-literal; absolute API paths are withheld.`);
      } else if (seenLiteral === null) {
        seenLiteral = literal[2];
      } else if (seenLiteral !== literal[2]) {
        unknown = true;
        notes.push(`${path.basename(file)}: conflicting literal basePath values were observed; absolute API paths are withheld.`);
      }
    }
    if (/\brewrites\s*(?:\(|:)/.test(masked)) {
      notes.push(`${path.basename(file)}: rewrites are present; this first slice reports filesystem API routes only and does not synthesize rewrite aliases.`);
    }
  }
  return {
    prefix: seenLiteral ?? '',
    unknown,
    notes,
    files,
  };
}

function normalizeSegment(segment) {
  if (/^\(\.{1,3}\)/.test(segment) || segment.startsWith('@')) {
    return { value: null, reason: `unsupported intercepting/parallel route segment "${segment}"` };
  }
  if (/^\([^)]*\)$/.test(segment)) {
    return { value: '', reason: null }; // route group: omitted from URL
  }
  if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment) || /^\[\.\.\.[^\]]+\]$/.test(segment)) {
    return { value: null, reason: `catch-all segment "${segment}" is outside the first slice` };
  }
  const dynamic = segment.match(/^\[([A-Za-z_$][\w$]*)\]$/);
  if (dynamic) return { value: `{${dynamic[1]}}`, reason: null };
  if (segment.startsWith('_')) {
    return { value: null, reason: `private route segment "${segment}" is outside the first slice` };
  }
  return { value: segment, reason: null };
}

function routePathFromSegments(segments, prefix) {
  const parts = [];
  for (const segment of segments) {
    const normalized = normalizeSegment(segment);
    if (normalized.reason) return { path: null, reason: normalized.reason };
    if (normalized.value) parts.push(normalized.value);
  }
  const route = '/' + parts.join('/');
  const base = String(prefix || '').replace(/\/$/, '');
  return { path: base + (route === '/' ? '' : route) || '/', reason: null };
}

function appRouteFiles(root) {
  return listFilesRecursive(root)
    .filter((file) => {
      if (!SOURCE_EXTENSIONS.has(path.extname(file))) return false;
      const stem = path.basename(file, path.extname(file));
      return stem === 'route';
    })
    .sort();
}

function pagesApiFiles(root) {
  return listFilesRecursive(root)
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
    .sort();
}

function parseAppMethods(text) {
  const masked = maskJsComments(text);
  const found = [];
  const seen = new Set();

  const functionRe = new RegExp(
    '\\bexport\\s+(?:async\\s+)?function\\s+(' + APP_METHODS.join('|') + ')\\b',
    'g',
  );
  for (const match of masked.matchAll(functionRe)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    found.push({ method: match[1], line: lineNumberAt(text, match.index) });
  }

  const constRe = new RegExp(
    '\\bexport\\s+const\\s+(' + APP_METHODS.join('|') + ')\\s*=',
    'g',
  );
  for (const match of masked.matchAll(constRe)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    found.push({ method: match[1], line: lineNumberAt(text, match.index) });
  }

  found.sort((a, b) => a.line - b.line || a.method.localeCompare(b.method));
  const reexport = new RegExp(
    '\\bexport\\s*\\{[^}]*\\b(?:' + APP_METHODS.join('|') + ')\\b[^}]*\\}(?:\\s+from\\s+[\'"][^\'"]+[\'"])?',
    'g',
  ).test(masked);

  return { methods: found, hasUnsupportedReexport: reexport };
}

function hasPagesDefaultExport(text) {
  const masked = maskJsComments(text);
  return /\bexport\s+default\b/.test(masked) || /\bmodule\.exports\s*=/.test(masked);
}

function appController({ file, root, prefix, baseUnknown, notes }) {
  const relDir = path.relative(root, path.dirname(file));
  const segments = relDir === '' ? [] : relDir.split(path.sep);
  const mapped = routePathFromSegments(segments, prefix);
  if (mapped.reason) {
    notes.push(`${path.relative(root, file)}: ${mapped.reason}; route file is withheld.`);
    return null;
  }
  if (baseUnknown) return null;

  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseAppMethods(text);
  if (parsed.hasUnsupportedReexport) {
    notes.push(`${path.relative(root, file)}: HTTP method re-export detected; this first slice only accepts methods declared directly in route files.`);
  }
  if (parsed.methods.length === 0) {
    notes.push(`${path.relative(root, file)}: no directly-declared supported HTTP method export was found.`);
    return null;
  }

  const endpoints = parsed.methods.map(({ method, line }) => ({
    verb: method,
    path: mapped.path,
    operationId: null,
    method,
    line,
  }));
  return {
    className: `NextAppRoute(${path.relative(root, file)})`,
    basePath: mapped.path,
    operationIds: [],
    endpoints,
    file,
  };
}

function pagesController({ file, root, prefix, baseUnknown, notes }) {
  const ext = path.extname(file);
  let rel = path.relative(root, file).slice(0, -ext.length);
  const segments = rel.split(path.sep);
  if (segments.at(-1) === 'index') segments.pop();

  const mapped = routePathFromSegments(['api', ...segments], prefix);
  if (mapped.reason) {
    notes.push(`${path.relative(root, file)}: ${mapped.reason}; API route is withheld.`);
    return null;
  }
  if (baseUnknown) return null;

  const text = fs.readFileSync(file, 'utf8');
  if (!hasPagesDefaultExport(text)) {
    notes.push(`${path.relative(root, file)}: no default API handler export was found.`);
    return null;
  }

  return {
    className: `NextPagesApi(${path.relative(root, file)})`,
    basePath: mapped.path,
    operationIds: [],
    endpoints: [{
      verb: '?',
      path: mapped.path,
      operationId: null,
      method: null,
      line: 1,
    }],
    file,
  };
}

function scanProject(projectRoot, repoRoot, packageFile) {
  const base = analyzeBasePath(projectRoot);
  const notes = [...base.notes];
  const controllers = [];
  const readFiles = new Set([packageFile, ...base.files]);

  for (const { kind, root } of routeRoots(projectRoot)) {
    const files = kind === 'app' ? appRouteFiles(root) : pagesApiFiles(root);
    for (const file of files) {
      readFiles.add(file);
      try {
        const controller = kind === 'app'
          ? appController({ file, root, prefix: base.prefix, baseUnknown: base.unknown, notes })
          : pagesController({ file, root, prefix: base.prefix, baseUnknown: base.unknown, notes });
        if (controller) controllers.push(controller);
      } catch (error) {
        notes.push(`${path.relative(projectRoot, file)}: failed to read/parse (${error.message}).`);
      }
    }
  }

  const packageName = readJson(packageFile)?.name || path.basename(projectRoot) || '_nextjs';
  return {
    modules: controllers.length > 0
      ? [{ module: packageName, controllers, entities: [], enums: [], dtos: [] }]
      : [],
    filesRead: [...readFiles].map((file) => path.relative(repoRoot, file)).sort(),
    scanNotes: [
      'T13 Next.js first slice: App Router route.js/route.ts direct HTTP method exports are method-known; Pages Router pages/api files are path-known but method-unknown ("?"). Catch-all/intercepting/parallel/private segments, method re-exports, dynamic basePath and rewrite aliases remain outside this slice.',
      ...[...new Set(notes)],
    ],
    apiSurfaceSource: 'Next.js filesystem server routes only (T13 experimental leaf; App method exports are source-known, Pages API method dispatch/schema/security/runtime semantics are not inferred)',
  };
}

export function detectNextServerRoutesRoot(repoRoot) {
  for (const packageFile of packageCandidates(repoRoot)) {
    const pkg = readJson(packageFile);
    if (!declaresNext(pkg)) continue;
    const projectRoot = path.dirname(packageFile);
    const roots = routeRoots(projectRoot);
    if (roots.length === 0) continue;

    const hasCandidate = roots.some(({ kind, root }) => (
      kind === 'app' ? appRouteFiles(root).length > 0 : pagesApiFiles(root).length > 0
    ));
    if (hasCandidate) return { projectRoot, packageFile };
  }
  return null;
}

export function scanNextServerRoutes(repoRoot, detection = detectNextServerRoutesRoot(repoRoot)) {
  if (!detection) {
    return { modules: [], filesRead: [], scanNotes: ['Next.js server API routes were not detected.'] };
  }
  return scanProject(detection.projectRoot, repoRoot, detection.packageFile);
}

export const adapter = {
  contract: 'sbf.adapter/2',
  id: 'typescript-nextjs',
  title: 'Next.js server API routes (T13 experimental leaf)',
  specificity: 57,
  confidence: 'high',
  verificationBasis: 'synthetic-only',
  capabilities: {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  },
  detect(repoRoot) {
    return detectNextServerRoutesRoot(repoRoot);
  },
  scan(repoRoot, detection) {
    return scanNextServerRoutes(repoRoot, detection);
  },
  listReadSet(repoRoot, detection = detectNextServerRoutesRoot(repoRoot)) {
    return detection ? scanNextServerRoutes(repoRoot, detection).filesRead : [];
  },
  diagnostics(repoRoot) {
    const detection = detectNextServerRoutesRoot(repoRoot);
    return detection
      ? [{
          level: 'info',
          code: 't13-experimental-next-server-routes',
          message: 'Next.js server API route files detected. This T13 leaf covers server route files only and is not registered in the production scanner registry yet.',
        }]
      : [{
          level: 'info',
          code: 'next-server-routes-not-detected',
          message: 'no package declaring next with app route files or pages/api files was found',
        }];
  },
};
