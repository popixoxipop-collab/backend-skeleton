import fs from 'node:fs';
import path from 'node:path';
import { lineNumberAt, listRgFiles as sharedListRgFiles, byShallowestThenName, binaryAvailable } from '../text-util.mjs';

const EXCLUDE_GLOBS = ['!**/vendor/**', '!**/storage/**', '!**/node_modules/**', '!**/.git/**'];
const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options'];

function listFiles(dir, globs) { return sharedListRgFiles(dir, globs, EXCLUDE_GLOBS); }
function listComposerFiles(repoRoot) { return listFiles(repoRoot, ['composer.json']).sort(byShallowestThenName); }
function listRouteFiles(projectRoot) {
  return listFiles(projectRoot, ['*.php']).filter((f) => {
    const rel = path.relative(projectRoot, f).split(path.sep);
    return rel[0] === 'routes';
  });
}

function declaresLaravel(file) {
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const deps = { ...(pkg?.require ?? {}), ...(pkg?.['require-dev'] ?? {}) };
    return Boolean(deps['laravel/framework']);
  } catch { return false; }
}

function sourceConfirmsLaravel(file) {
  try { return /\bRoute::(?:get|post|put|patch|delete|options|prefix)\s*\(/.test(maskPhpComments(fs.readFileSync(file, 'utf8'))); }
  catch { return false; }
}

export function detectPhpLaravelRoot(repoRoot) {
  for (const composerFile of listComposerFiles(repoRoot)) {
    if (!declaresLaravel(composerFile)) continue;
    const projectRoot = path.dirname(composerFile);
    if (listRouteFiles(projectRoot).some(sourceConfirmsLaravel)) return projectRoot;
  }
  return null;
}

function maskPhpComments(text) {
  const out = text.split('');
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = null;
      i++; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== '\n') out[i] = ' ';
      continue;
    }
    i++;
  }
  return out.join('');
}

function matchBalanced(text, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function matchBalancedParens(text, openIndex) { return matchBalanced(text, openIndex, '(', ')'); }
function matchBalancedBraces(text, openIndex) { return matchBalanced(text, openIndex, '{', '}'); }

function splitTopLevel(text) {
  const parts = [];
  let start = 0;
  const stack = [];
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if ('([{'.includes(ch)) stack.push(ch);
    else if (')]}'.includes(ch)) stack.pop();
    else if (ch === ',' && stack.length === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function literalString(text) {
  const m = text?.trim().match(/^['"]([^'"]*)['"]$/);
  return m ? m[1] : null;
}

function joinPath(base, segment) {
  const b = (base || '').replace(/\/$/, '');
  const s = (segment || '').replace(/^\//, '');
  return s ? b + '/' + s : (b || '/');
}

function handlerName(expr) {
  const text = expr?.trim() ?? '';
  let m = text.match(/^\[\s*([A-Za-z_\\][\w\\]*)::class\s*,\s*['"]([^'"]+)['"]\s*\]$/);
  if (m) return m[1].split('\\').filter(Boolean).at(-1) + '@' + m[2];
  m = text.match(/^([A-Za-z_\\][\w\\]*)::class$/);
  if (m) return m[1].split('\\').filter(Boolean).at(-1);
  m = text.match(/^['"]([^'"]+)['"]$/);
  if (m) return m[1];
  if (/^(?:static\s+)?function\s*\(/.test(text) || /^fn\s*\(/.test(text)) return null;
  return undefined;
}

function prefixGroups(text) {
  const groups = [];
  const re = /\bRoute::prefix\s*\(\s*(['"][^'"]*['"])\s*\)\s*->\s*group\s*\(\s*(?:static\s+)?function\s*\([^)]*\)\s*\{/g;
  for (const m of text.matchAll(re)) {
    const prefix = literalString(m[1]);
    if (prefix == null) continue;
    const bodyOpen = m.index + m[0].length - 1;
    const bodyClose = matchBalancedBraces(text, bodyOpen);
    if (bodyClose === -1) continue;
    groups.push({ start: bodyOpen + 1, end: bodyClose, prefix });
  }
  return groups;
}

function prefixAt(index, groups) {
  return groups
    .filter((g) => g.start <= index && index < g.end)
    .sort((a, b) => a.start - b.start)
    .reduce((prefix, g) => joinPath(prefix, g.prefix), '');
}

function extractRoutes(text, file) {
  const groups = prefixGroups(text);
  const endpointsByPrefix = new Map();
  const re = new RegExp('\\\\bRoute::(' + VERBS.join('|') + ')\\\\s*\\\\(', 'gi');

  for (const m of text.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    const close = matchBalancedParens(text, open);
    if (close === -1) continue;
    const args = splitTopLevel(text.slice(open + 1, close));
    if (args.length < 2) continue;
    const routePath = literalString(args[0]);
    if (routePath == null) continue;
    const method = handlerName(args[1]);
    if (method === undefined) continue;

    const prefix = prefixAt(m.index, groups);
    if (!endpointsByPrefix.has(prefix)) endpointsByPrefix.set(prefix, []);
    endpointsByPrefix.get(prefix).push({
      verb: m[1].toUpperCase(),
      path: joinPath(prefix, routePath),
      operationId: null,
      method,
      line: lineNumberAt(text, m.index),
    });
  }

  const moduleName = path.basename(file, '.php');
  return [...endpointsByPrefix.entries()].map(([prefix, endpoints]) => ({
    module: moduleName,
    controller: {
      className: moduleName + 'LaravelRoutes',
      basePath: prefix,
      operationIds: [],
      endpoints: endpoints.sort((a, b) => a.line - b.line || a.verb.localeCompare(b.verb)),
      file,
    },
  }));
}

const API_SURFACE_SOURCE =
  'Laravel static discovery: routes/*.php literal Route::get/post/put/patch/delete/options calls ' +
  'and directly-declared literal Route::prefix(...)->group(function(){...}) blocks. The implicit ' +
  'routes/api.php deployment prefix is intentionally not synthesized because bootstrap/app.php may ' +
  'change it. Route::resource/apiResource, middleware/auth semantics, macros, service-provider ' +
  'routes and runtime route registration are unresolved in this first slice.';

export function scanPhpLaravel(repoRoot, projectRoot) {
  const files = listRouteFiles(projectRoot);
  const modules = new Map();

  for (const file of files) {
    let text = '';
    try { text = maskPhpComments(fs.readFileSync(file, 'utf8')); } catch {}
    for (const entry of extractRoutes(text, file)) {
      if (!modules.has(entry.module)) modules.set(entry.module, { module: entry.module, controllers: [], entities: [], enums: [], dtos: [] });
      modules.get(entry.module).controllers.push(entry.controller);
    }
  }

  const composerFiles = listComposerFiles(repoRoot).filter((f) => path.dirname(f) === projectRoot);
  return {
    modules: [...modules.values()].sort((a, b) => a.module.localeCompare(b.module)),
    pathPrefixSignals: [],
    apiSurfaceSource: API_SURFACE_SOURCE,
    filesRead: [...composerFiles, ...files].map((f) => path.relative(repoRoot, f)).sort(),
  };
}

function diagnostics(repoRoot) {
  const messages = [];
  const composers = listComposerFiles(repoRoot);
  if (composers.length === 0) messages.push({ level: 'info', code: 'no-composer-json', message: 'no composer.json found' });
  else if (!composers.some(declaresLaravel)) messages.push({ level: 'info', code: 'laravel-not-a-dependency', message: 'composer.json files were found, but none require laravel/framework' });
  if (!binaryAvailable('rg')) messages.push({ level: 'warn', code: 'rg-missing', message: 'ripgrep (rg) is not on PATH -- this adapter uses it for bounded file discovery and will not detect without it' });
  messages.push({ level: 'info', code: 'laravel-api-prefix-unresolved', message: 'routes/api.php may receive an application-level URI prefix from bootstrap/app.php; this first static slice does not guess that prefix.' });
  messages.push({ level: 'info', code: 'laravel-static-slice-limit', message: 'Resource routes, middleware/auth semantics, macros and service-provider/runtime registrations are intentionally unresolved.' });
  return messages;
}

export const adapter = {
  contract: 'sbf.adapter/2',
  id: 'php-laravel',
  title: 'PHP / Laravel',
  specificity: 93,
  confidence: 'high',
  verificationBasis: 'synthetic-only',
  capabilities: {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  },
  detect: detectPhpLaravelRoot,
  scan(repoRoot, detection) { return scanPhpLaravel(repoRoot, detection); },
  listReadSet(repoRoot) {
    const projectRoot = detectPhpLaravelRoot(repoRoot);
    if (!projectRoot) return [];
    const composerFiles = listComposerFiles(repoRoot).filter((f) => path.dirname(f) === projectRoot);
    return [...composerFiles, ...listRouteFiles(projectRoot)].map((f) => path.relative(repoRoot, f)).sort();
  },
  diagnostics,
};
