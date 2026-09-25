import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.git', 'coverage']);
const ROUTE_FILES = new Set(['route.js', 'route.ts']);
const PAGE_API_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function walkFiles(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { return; }
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
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function packageFiles(repoRoot) {
  return walkFiles(repoRoot)
    .filter((file) => path.basename(file) === 'package.json')
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
}

function declaresNext(pkg) {
  const bags = [pkg?.dependencies, pkg?.devDependencies, pkg?.peerDependencies, pkg?.optionalDependencies];
  return bags.some((bag) => bag && typeof bag.next === 'string');
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

const REGEX_PRECEDING_CHARS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';']);
const REGEX_PRECEDING_KEYWORD_RE = /\\b(?:return|typeof|case|in|of|new|delete|do|else|yield|await|void|instanceof)\\s*$/;

function isRegexStart(lastSignificant, recentText) {
  if (lastSignificant === null) return true;
  if (REGEX_PRECEDING_CHARS.has(lastSignificant)) return true;
  return REGEX_PRECEDING_KEYWORD_RE.test(recentText);
}

function skipRegexLiteral(text, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\\\') { i += 2; continue; }
    if (ch === '\\n') return i;
    if (inClass) {
      if (ch === ']') inClass = false;
      i++;
      continue;
    }
    if (ch === '[') { inClass = true; i++; continue; }
    if (ch === '/') return i + 1;
    i++;
  }
  return i;
}

function maskComments(text) {
  const out = text.split('');
  let quote = null;
  let lastSignificant = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\\\') { i++; continue; }
      if (ch === quote) { quote = null; lastSignificant = ch; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\\n') { out[i] = ' '; i++; }
      i--;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      out[i] = out[i + 1] = ' ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\\n') out[i] = ' ';
        i++;
      }
      if (i < text.length) { out[i] = out[i + 1] = ' '; i++; }
      continue;
    }
    if (ch === '/' && isRegexStart(lastSignificant, text.slice(Math.max(0, i - 12), i))) {
      const stop = skipRegexLiteral(text, i);
      i = Math.max(i, stop - 1);
      lastSignificant = '/';
      continue;
    }
    if (!/\\s/.test(ch)) lastSignificant = ch;
  }
  return out.join('');
}

function projectRoots(projectRoot) {
  const rootApp = path.join(projectRoot, 'app');
  const srcApp = path.join(projectRoot, 'src', 'app');
  const rootPagesApi = path.join(projectRoot, 'pages', 'api');
  const srcPagesApi = path.join(projectRoot, 'src', 'pages', 'api');
  const appRoot = fs.existsSync(rootApp) ? rootApp : (fs.existsSync(srcApp) ? srcApp : null);
  const pagesApiRoot = fs.existsSync(rootPagesApi) ? rootPagesApi : (fs.existsSync(srcPagesApi) ? srcPagesApi : null);
  return {
    appRoot,
    pagesApiRoot,
    ignoredSrcApp: fs.existsSync(rootApp) && fs.existsSync(srcApp),
    ignoredSrcPagesApi: fs.existsSync(rootPagesApi) && fs.existsSync(srcPagesApi),
  };
}

function appRouteFiles(appRoot) {
  if (!appRoot) return [];
  return walkFiles(appRoot).filter((file) => ROUTE_FILES.has(path.basename(file))).sort();
}

function pagesApiFiles(root) {
  if (!root) return [];
  return walkFiles(root).filter((file) => PAGE_API_EXTENSIONS.has(path.extname(file))).sort();
}

function nextConfigFiles(projectRoot) {
  return ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts']
    .map((name) => path.join(projectRoot, name))
    .filter((file) => fs.existsSync(file));
}

function readBasePath(projectRoot) {
  const files = nextConfigFiles(projectRoot);
  if (!files.length) return { value: '', unknown: false, files: [], notes: [] };
  const notes = [];
  let value = '';
  let unknown = false;
  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const masked = maskComments(raw);
    const any = /\bbasePath\s*:/.test(masked);
    const literal = masked.match(/\bbasePath\s*:\s*(['"`])([^'"`]+)\1/);
    if (literal && !(literal[1] === '`' && literal[2].includes('${'))) {
      if (value && value !== literal[2]) {
        unknown = true;
        notes.push('conflicting literal Next.js basePath values were found across config files');
      } else {
        value = literal[2];
      }
    } else if (any) {
      unknown = true;
      notes.push('Next.js basePath is present but not a simple literal; absolute Route Handler paths are unknown');
    }
  }
  return { value, unknown, files, notes };
}

function joinPath(base, routePath) {
  const b = String(base || '').replace(/\/$/, '');
  const r = String(routePath || '').replace(/^\//, '');
  if (!b && !r) return '/';
  if (!b) return '/' + r;
  if (!r) return b || '/';
  return (b + '/' + r).replace(/\/+/g, '/');
}

function routePathFromFile(appRoot, file) {
  const dir = path.relative(appRoot, path.dirname(file));
  if (!dir || dir === '.') return { path: '/', unknown: false, params: [] };
  const params = [];
  const out = [];

  for (const segment of dir.split(path.sep)) {
    if (!segment) continue;
    if (/^\([^()]+\)$/.test(segment)) continue;
    if (segment.startsWith('@')) return { path: null, unknown: true, reason: 'parallel-route-segment', params };
    if (segment.startsWith('_')) return { path: null, unknown: true, reason: 'private-folder', params };
    if (segment.includes('[...') || segment.includes('[[...')) return { path: null, unknown: true, reason: 'catch-all-segment', params };
    if (segment.startsWith('(') || segment.endsWith(')')) return { path: null, unknown: true, reason: 'intercepting-or-unsupported-segment', params };
    const dynamic = segment.match(/^\[([A-Za-z0-9_]+)\]$/);
    if (dynamic) {
      params.push(dynamic[1]);
      out.push('{' + dynamic[1] + '}');
      continue;
    }
    if (segment.includes('[') || segment.includes(']')) return { path: null, unknown: true, reason: 'unsupported-dynamic-segment', params };
    out.push(segment);
  }
  return { path: '/' + out.join('/'), unknown: false, params };
}

function explicitMethods(text) {
  const masked = maskComments(text);
  const found = new Map();

  const fnRe = /\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g;
  for (const m of masked.matchAll(fnRe)) {
    if (!found.has(m[1])) found.set(m[1], { method: m[1], handler: m[1], line: lineNumberAt(text, m.index), form: 'function' });
  }

  const constRe = /\bexport\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=/g;
  for (const m of masked.matchAll(constRe)) {
    if (!found.has(m[1])) found.set(m[1], { method: m[1], handler: m[1], line: lineNumberAt(text, m.index), form: 'const' });
  }

  const exportListRe = /\bexport\s*\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?/g;
  const unsupportedReExports = [];
  for (const m of masked.matchAll(exportListRe)) {
    const full = m[0];
    const external = /\}\s*from\s*['"]/.test(full);
    for (const part of m[1].split(',')) {
      const item = part.trim();
      if (!item) continue;
      const as = item.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!as) continue;
      const local = as[1];
      const exported = as[2] || as[1];
      if (!METHODS.includes(exported)) continue;
      if (external) {
        unsupportedReExports.push({ method: exported, line: lineNumberAt(text, m.index) });
      } else if (!found.has(exported)) {
        found.set(exported, { method: exported, handler: local, line: lineNumberAt(text, m.index), form: 'local-export-alias' });
      }
    }
  }

  return { methods: [...found.values()].sort((a, b) => a.line - b.line || a.method.localeCompare(b.method)), unsupportedReExports };
}

function scanProject(repoRoot, detection) {
  const roots = projectRoots(detection.projectRoot);
  const routeFiles = appRouteFiles(roots.appRoot);
  const legacyFiles = pagesApiFiles(roots.pagesApiRoot);
  const basePath = readBasePath(detection.projectRoot);
  const controllers = [];
  const notes = [...basePath.notes];
  const duplicates = new Map();

  if (roots.ignoredSrcApp) notes.push('both app/ and src/app/ exist; T13 follows the root app/ tree and records src/app as ignored for this profile');
  if (roots.ignoredSrcPagesApi) notes.push('both pages/api and src/pages/api exist; T13 follows root pages/api for legacy-route discovery');
  if (legacyFiles.length) notes.push('Next.js Pages API files were detected but are not emitted by the T13 App Route first slice because HTTP methods depend on handler control flow.');

  for (const file of routeFiles) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const route = routePathFromFile(roots.appRoot, file);
    const exported = explicitMethods(text);

    for (const item of exported.unsupportedReExports) {
      notes.push('Next.js external re-export for ' + item.method + ' at ' + path.relative(detection.projectRoot, file) + ':' + item.line + ' is not followed by the T13 first slice.');
    }
    if (route.unknown) {
      if (exported.methods.length) notes.push('Next.js Route Handler at ' + path.relative(detection.projectRoot, file) + ' uses ' + route.reason + '; no endpoint path was emitted.');
      continue;
    }
    if (basePath.unknown) {
      if (exported.methods.length) notes.push('Next.js Route Handler at ' + path.relative(detection.projectRoot, file) + ' was withheld because basePath is unresolved.');
      continue;
    }
    if (!exported.methods.length) {
      notes.push('Next.js route file at ' + path.relative(detection.projectRoot, file) + ' exports no directly supported HTTP method in the T13 first slice.');
      continue;
    }

    const finalPath = joinPath(basePath.value, route.path);
    const endpoints = exported.methods.map((item) => ({
      verb: item.method,
      path: finalPath,
      operationId: null,
      method: item.handler,
      line: item.line,
      params: route.params,
    }));

    for (const endpoint of endpoints) {
      const key = endpoint.verb + ' ' + endpoint.path;
      const seen = duplicates.get(key) || [];
      seen.push(path.relative(detection.projectRoot, file));
      duplicates.set(key, seen);
    }

    controllers.push({
      className: 'NextRoute(' + path.relative(detection.projectRoot, file) + ')',
      basePath: finalPath,
      operationIds: [],
      endpoints,
      file,
    });
  }

  for (const [key, files] of duplicates) {
    if (files.length > 1) notes.push('Next.js duplicate Route Handler identity ' + key + ' is produced by: ' + files.join(', ') + '; this conflict is preserved instead of choosing a winner.');
  }

  if (routeFiles.length) notes.push('T13 emits only explicitly exported Next.js HTTP methods; framework-generated OPTIONS when OPTIONS is absent is intentionally not synthesized.');

  const configFiles = nextConfigFiles(detection.projectRoot);
  const filesRead = [detection.packageFile, ...routeFiles, ...legacyFiles, ...configFiles]
    .map((file) => path.relative(repoRoot, file))
    .sort();

  const packageName = readJson(detection.packageFile)?.name || path.basename(detection.projectRoot) || '_next';
  return {
    modules: controllers.length ? [{ module: packageName, controllers, entities: [], enums: [], dtos: [] }] : [],
    filesRead,
    scanNotes: [...new Set([
      'T13 Next.js first slice: App Router route.js/route.ts files with explicit method exports are emitted; simple [param] segments and route groups are resolved, while catch-all/interception/parallel routes and Pages API control-flow methods remain unknown.',
      ...notes,
    ])],
    apiSurfaceSource: 'Next.js App Router file conventions + explicit method exports only (T13 experimental leaf; operationId/body/schema/security/runtime behavior are not inferred)',
  };
}

export function detectNextRoot(repoRoot) {
  for (const pkgFile of packageFiles(repoRoot)) {
    const pkg = readJson(pkgFile);
    if (!declaresNext(pkg)) continue;
    const projectRoot = path.dirname(pkgFile);
    const roots = projectRoots(projectRoot);
    const routeFiles = appRouteFiles(roots.appRoot);
    const legacyFiles = pagesApiFiles(roots.pagesApiRoot);
    if (routeFiles.length || legacyFiles.length) return { projectRoot, packageFile: pkgFile };
  }
  return null;
}

export function scanNext(repoRoot, detection = detectNextRoot(repoRoot)) {
  if (!detection) return { modules: [], filesRead: [], scanNotes: ['Next.js server routes were not detected.'] };
  return scanProject(repoRoot, detection);
}

export const adapter = {
  contract: 'sbf.adapter/2',
  id: 'typescript-nextjs',
  title: 'Next.js server routes (T13 experimental leaf)',
  specificity: 56,
  confidence: 'high',
  verificationBasis: 'synthetic-only',
  capabilities: {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  },
  detect(repoRoot) { return detectNextRoot(repoRoot); },
  scan(repoRoot, detection) { return scanNext(repoRoot, detection); },
  listReadSet(repoRoot, detection = detectNextRoot(repoRoot)) {
    return detection ? scanNext(repoRoot, detection).filesRead : [];
  },
  diagnostics(repoRoot) {
    const detection = detectNextRoot(repoRoot);
    return detection
      ? [{ level: 'info', code: 't13-experimental-nextjs', message: 'Next.js server-route project detected by dependency plus App Route or Pages API source files. This leaf is not registered in the production scanner registry yet.' }]
      : [{ level: 'info', code: 'nextjs-routes-not-detected', message: 'no Next.js package with App Route or Pages API server files was found' }];
  },
};
