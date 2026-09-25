import fs from 'node:fs';
import path from 'node:path';
import { lineNumberAt, listRgFiles as sharedListRgFiles, byShallowestThenName, binaryAvailable } from '../text-util.mjs';

const EXCLUDE_GLOBS = ['!**/vendor/**', '!**/.git/**', '!**/node_modules/**'];
const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function listFiles(dir, globs) { return sharedListRgFiles(dir, globs, EXCLUDE_GLOBS); }
function listGoModFiles(repoRoot) { return listFiles(repoRoot, ['go.mod']).sort(byShallowestThenName); }
function listGoFiles(projectRoot) { return listFiles(projectRoot, ['*.go', '!**/*_test.go']); }

function declaresGin(file) {
  try { return /(?:^|\s)github\.com\/gin-gonic\/gin(?:\s|$)/m.test(fs.readFileSync(file, 'utf8')); }
  catch { return false; }
}

function sourceConfirmsGin(file) {
  try {
    const text = maskGoComments(fs.readFileSync(file, 'utf8'));
    return /\bgin\.(?:Default|New)\s*\(/.test(text) &&
      /["']github\.com\/gin-gonic\/gin["']/.test(text);
  } catch { return false; }
}

export function detectGoGinRoot(repoRoot) {
  for (const modFile of listGoModFiles(repoRoot)) {
    if (!declaresGin(modFile)) continue;
    const projectRoot = path.dirname(modFile);
    if (listGoFiles(projectRoot).some(sourceConfirmsGin)) return projectRoot;
  }
  return null;
}

function isBacktick(ch) { return ch != null && ch.charCodeAt(0) === 96; }

function maskGoComments(text) {
  const out = text.split('');
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (!isBacktick(quote) && ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = null;
      i++; continue;
    }
    if (ch === '"' || ch === "'" || isBacktick(ch)) { quote = ch; i++; continue; }
    if (ch === '/' && text[i + 1] === '/') {
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

function matchBalancedParens(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (!isBacktick(quote) && ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || isBacktick(ch)) { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(text) {
  const parts = [];
  let start = 0;
  const stack = [];
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (!isBacktick(quote) && ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || isBacktick(ch)) { quote = ch; continue; }
    if ('([{'.includes(ch)) stack.push(ch);
    else if (')]}'.includes(ch)) stack.pop();
    else if (ch === ',' && stack.length === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function literalString(text) {
  const m = text?.trim().match(/^"([^"]*)"$/);
  return m ? m[1] : null;
}

function joinPath(base, segment) {
  const b = (base || '').replace(/\/$/, '');
  const s = (segment || '').replace(/^\//, '');
  return s ? b + '/' + s : (b || '/');
}

function handlerName(expr) {
  const text = expr?.trim() ?? '';
  if (/^[A-Za-z_]\w*$/.test(text)) return text;
  if (/^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(text)) return text;
  if (/^func\s*\(/.test(text)) return null;
  return undefined;
}

function routerBindings(text) {
  const roots = new Set();
  const groups = new Map();

  for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s*:=\s*gin\.(?:Default|New)\s*\(/g)) roots.add(m[1]);
  for (const m of text.matchAll(/\bvar\s+([A-Za-z_]\w*)\s*=\s*gin\.(?:Default|New)\s*\(/g)) roots.add(m[1]);

  let changed = true;
  while (changed) {
    changed = false;
    const re = /\b([A-Za-z_]\w*)\s*:=\s*([A-Za-z_]\w*)\.Group\s*\(\s*(".*?")/g;
    for (const m of text.matchAll(re)) {
      if (groups.has(m[1])) continue;
      const local = literalString(m[3]);
      if (local == null) continue;
      if (roots.has(m[2])) { groups.set(m[1], local); changed = true; }
      else if (groups.has(m[2])) { groups.set(m[1], joinPath(groups.get(m[2]), local)); changed = true; }
    }
  }
  return { roots, groups };
}

function extractRoutes(text, file) {
  const { roots, groups } = routerBindings(text);
  const receivers = [...roots, ...groups.keys()].sort();
  if (receivers.length === 0) return [];

  const esc = (x) => x.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
  const re = new RegExp('\\b(' + receivers.map(esc).join('|') + ')\\.(' + VERBS.join('|') + ')\\s*\\(', 'g');
  const grouped = new Map();

  for (const m of text.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    const close = matchBalancedParens(text, open);
    if (close === -1) continue;
    const args = splitTopLevel(text.slice(open + 1, close));
    if (args.length < 2) continue;
    const routePath = literalString(args[0]);
    if (routePath == null) continue;
    const method = handlerName(args[args.length - 1]);
    if (method === undefined) continue;

    const prefix = groups.get(m[1]) ?? '';
    const key = String(m[1]) + '\0' + prefix;
    if (!grouped.has(key)) grouped.set(key, { receiver: m[1], prefix, endpoints: [] });
    grouped.get(key).endpoints.push({
      verb: m[2].toUpperCase(),
      path: joinPath(prefix, routePath),
      operationId: null,
      method,
      line: lineNumberAt(text, m.index),
    });
  }

  const moduleName = path.basename(file, '.go');
  return [...grouped.values()].map((g) => ({
    module: moduleName,
    controller: {
      className: moduleName + 'GinRoutes',
      basePath: g.prefix,
      operationIds: [],
      endpoints: g.endpoints.sort((a, b) => a.line - b.line || a.verb.localeCompare(b.verb)),
      file,
    },
  }));
}

const API_SURFACE_SOURCE =
  'Gin static discovery: gin.Default()/gin.New() roots, same-file literal Group() prefix chains, ' +
  'and literal GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS calls. Cross-file group passing, computed ' +
  'paths, middleware/auth semantics, custom Handle/Any methods and request/response binding are ' +
  'not inferred in this first slice.';

export function scanGoGin(repoRoot, projectRoot) {
  const files = listGoFiles(projectRoot);
  const modules = new Map();
  for (const file of files) {
    let text = '';
    try { text = maskGoComments(fs.readFileSync(file, 'utf8')); } catch {}
    for (const entry of extractRoutes(text, file)) {
      if (!modules.has(entry.module)) modules.set(entry.module, { module: entry.module, controllers: [], entities: [], enums: [], dtos: [] });
      modules.get(entry.module).controllers.push(entry.controller);
    }
  }

  const modFiles = listGoModFiles(repoRoot).filter((f) => path.dirname(f) === projectRoot);
  return {
    modules: [...modules.values()].sort((a, b) => a.module.localeCompare(b.module)),
    pathPrefixSignals: [],
    apiSurfaceSource: API_SURFACE_SOURCE,
    filesRead: [...modFiles, ...files].map((f) => path.relative(repoRoot, f)).sort(),
  };
}

function diagnostics(repoRoot) {
  const messages = [];
  const modFiles = listGoModFiles(repoRoot);
  if (modFiles.length === 0) messages.push({ level: 'info', code: 'no-go-mod', message: 'no go.mod found' });
  else if (!modFiles.some(declaresGin)) messages.push({ level: 'info', code: 'gin-not-a-dependency', message: 'go.mod files were found, but none require github.com/gin-gonic/gin' });
  if (!binaryAvailable('rg')) messages.push({ level: 'warn', code: 'rg-missing', message: 'ripgrep (rg) is not on PATH -- this adapter uses it for bounded file discovery and will not detect without it' });
  messages.push({ level: 'info', code: 'gin-static-slice-limit', message: 'Cross-file router-group passing, middleware/auth semantics, custom methods and dynamic paths are intentionally unresolved in this first static slice.' });
  return messages;
}

export const adapter = {
  contract: 'sbf.adapter/2',
  id: 'go-gin',
  title: 'Go / Gin',
  specificity: 86,
  confidence: 'high',
  verificationBasis: 'synthetic-only',
  capabilities: {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  },
  detect: detectGoGinRoot,
  scan(repoRoot, detection) { return scanGoGin(repoRoot, detection); },
  listReadSet(repoRoot) {
    const projectRoot = detectGoGinRoot(repoRoot);
    if (!projectRoot) return [];
    const modFiles = listGoModFiles(repoRoot).filter((f) => path.dirname(f) === projectRoot);
    return [...modFiles, ...listGoFiles(projectRoot)].map((f) => path.relative(repoRoot, f)).sort();
  },
  diagnostics,
};
