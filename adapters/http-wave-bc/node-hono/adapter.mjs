import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.git', 'coverage']);
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

function listFilesRecursive(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) out.push(full);
    }
  }
  walk(root);
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function declaresHono(pkg) {
  return Boolean(pkg?.dependencies?.hono || pkg?.devDependencies?.hono || pkg?.peerDependencies?.hono);
}

function packageCandidates(repoRoot) {
  return listFilesRecursive(repoRoot)
    .filter((file) => path.basename(file) === 'package.json')
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
}

function sourceFiles(projectRoot) {
  return listFilesRecursive(projectRoot).filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)));
}

const REGEX_PRECEDING_CHARS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';']);
const REGEX_PRECEDING_KEYWORD_RE = /\b(?:return|typeof|case|in|of|new|delete|do|else|yield|await|void|instanceof)\s*$/;

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
    if (ch === '\\') { i += 2; continue; }
    if (ch === '\n') return i;
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
      if (ch === '\\') { i++; continue; }
      if (ch === quote) { quote = null; lastSignificant = ch; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') { out[i] = ' '; i++; }
      i--;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      out[i] = out[i + 1] = ' ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n') out[i] = ' ';
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
    if (!/\s/.test(ch)) lastSignificant = ch;
  }
  return out.join('');
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

function joinPath(base, segment) {
  const b = (base || '').replace(/\/$/, '');
  const s = (segment || '').replace(/^\//, '');
  if (!b && !s) return '/';
  if (!b) return `/${s}`;
  if (!s) return b || '/';
  return `${b}/${s}`.replace(/\/+/g, '/');
}

function commonPathPrefix(paths) {
  if (paths.length === 0) return '/';
  const lists = paths.map((p) => p.split('/').filter(Boolean));
  const min = Math.min(...lists.map((x) => x.length));
  const shared = [];
  for (let i = 0; i < min; i++) {
    if (lists.every((x) => x[i] === lists[0][i])) shared.push(lists[0][i]);
    else break;
  }
  return shared.length ? `/${shared.join('/')}` : '/';
}

function hasLiveHonoImport(text) {
  const masked = maskComments(text);
  return /\bfrom\s*['"]hono['"]/.test(masked) || /\brequire\s*\(\s*['"]hono['"]\s*\)/.test(masked);
}

function honoVariables(masked) {
  const vars = new Map();
  for (const m of masked.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*new\s+Hono\s*\([^)]*\)(?:\s*\.\s*basePath\s*\(\s*['"`]([^'"`]*)['"`]\s*\))?/g)) {
    vars.set(m[1], { basePath: m[2] ?? '' });
  }
  return vars;
}

function handlerName(args) {
  const parts = args.split(',').map((x) => x.trim()).filter(Boolean);
  const last = (parts.at(-1) ?? '').replace(/\)\s*$/, '').trim();
  return /^[A-Za-z_$][\w$]*$/.test(last) ? last : null;
}

function scanFile(file, text) {
  const masked = maskComments(text);
  if (!hasLiveHonoImport(masked)) return { controllers: [], notes: [] };
  const vars = honoVariables(masked);
  const controllers = [];
  const notes = [];
  for (const [varName, info] of vars) {
    const endpoints = [];
    const routeRe = new RegExp(`\\b${varName.replace(/[$]/g, '\\$&')}\\s*\\.\\s*(get|post|put|patch|delete|options|head)\\s*\\(\\s*(['\"` + '`' + `])([^'\"` + '`' + `]+)\\2\\s*,([^;\\n]*)`, 'gi');
    for (const m of masked.matchAll(routeRe)) {
      const verb = m[1].toLowerCase();
      if (!VERBS.has(verb)) continue;
      const literalPath = m[3];
      const fullPath = joinPath(info.basePath, literalPath);
      endpoints.push({ verb: verb.toUpperCase(), path: fullPath, operationId: null, method: handlerName(m[4]), line: lineNumberAt(text, m.index) });
    }
    if (endpoints.length > 0) {
      controllers.push({
        className: `Hono(${varName})`,
        basePath: commonPathPrefix(endpoints.map((ep) => ep.path)),
        operationIds: [],
        endpoints,
        file,
      });
    }
    const routeMountRe = new RegExp(`\\b${varName.replace(/[$]/g, '\\$&')}\\s*\\.\\s*route\\s*\\(\\s*(['\"` + '`' + `])([^'\"` + '`' + `]+)\\1\\s*,`, 'g');
    for (const m of masked.matchAll(routeMountRe)) {
      notes.push(`Hono route() mount at ${path.basename(file)}:${lineNumberAt(text, m.index)} (${m[2]}) is observed but not expanded by the T13 first slice; nested app resolution remains unknown.`);
    }
  }
  return { controllers, notes };
}

export function detectHonoRoot(repoRoot) {
  for (const packageFile of packageCandidates(repoRoot)) {
    const pkg = readJson(packageFile);
    if (!declaresHono(pkg)) continue;
    const projectRoot = path.dirname(packageFile);
    const files = sourceFiles(projectRoot);
    const hasSource = files.some((file) => {
      try {
        const text = fs.readFileSync(file, 'utf8');
        const masked = maskComments(text);
        return hasLiveHonoImport(masked) && /\bnew\s+Hono\s*\(/.test(masked);
      } catch { return false; }
    });
    if (hasSource) return { projectRoot, packageFile };
  }
  return null;
}

export function scanHono(repoRoot, detection = detectHonoRoot(repoRoot)) {
  if (!detection) return { modules: [], filesRead: [], scanNotes: ['Hono was not detected.'] };
  const files = sourceFiles(detection.projectRoot);
  const controllers = [];
  const scanNotes = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const result = scanFile(file, text);
    controllers.push(...result.controllers);
    scanNotes.push(...result.notes);
  }
  const filesRead = [detection.packageFile, ...files]
    .map((file) => path.relative(repoRoot, file))
    .sort();
  const packageName = readJson(detection.packageFile)?.name || path.basename(detection.projectRoot) || '_hono';
  return {
    modules: controllers.length > 0 ? [{ module: packageName, controllers, entities: [], enums: [], dtos: [] }] : [],
    filesRead,
    scanNotes: [
      'T13 Hono first slice: only literal routes on variables directly initialized with `new Hono()` are emitted; dynamic paths, factory-returned apps and nested route() mounts remain unknown.',
      ...scanNotes,
    ],
    apiSurfaceSource: 'Hono source literals only (T13 experimental leaf adapter; operationId/schema/security/runtime semantics are not inferred)',
  };
}

export const adapter = {
  contract: 'sbf.adapter/2',
  id: 'node-hono',
  title: 'Hono HTTP routes (T13 experimental leaf)',
  specificity: 55,
  confidence: 'high',
  verificationBasis: 'synthetic-only',
  capabilities: {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  },
  detect(repoRoot) { return detectHonoRoot(repoRoot); },
  scan(repoRoot, detection) { return scanHono(repoRoot, detection); },
  listReadSet(repoRoot, detection = detectHonoRoot(repoRoot)) {
    return detection ? scanHono(repoRoot, detection).filesRead : [];
  },
  diagnostics(repoRoot) {
    const d = detectHonoRoot(repoRoot);
    return d
      ? [{ level: 'info', code: 't13-experimental-hono', message: 'Hono detected by dependency + live import/new Hono() source signal. This leaf is not registered in the production scanner registry yet.' }]
      : [{ level: 'info', code: 'hono-not-detected', message: 'no package declaring hono with a live new Hono() source signal was found' }];
  },
};
