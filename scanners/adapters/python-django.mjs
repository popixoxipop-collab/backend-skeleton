import fs from 'node:fs';
import path from 'node:path';
import { lineNumberAt, listRgFiles as sharedListRgFiles, byShallowestThenName, binaryAvailable } from '../text-util.mjs';

const PROJECT_FILE_GLOBS = ['pyproject.toml', 'requirements*.txt'];
const EXCLUDE_GLOBS = ['!**/.venv/**', '!**/site-packages/**', '!**/__pycache__/**', '!**/node_modules/**'];
const DJANGO_DEP_RE = /(?:^|[\s"'[])django(?:[\s"',\]=<>~!;]|$)/mi;
const DRF_DEP_RE = /(?:^|[\s"'[])djangorestframework(?:[\s"',\]=<>~!;]|$)/mi;
const STANDARD_ACTIONS = new Set(['list', 'create', 'retrieve', 'update', 'partial_update', 'destroy']);

function listRgFiles(dir, globs) {
  return sharedListRgFiles(dir, globs, EXCLUDE_GLOBS);
}

function listProjectFiles(repoRoot) {
  return listRgFiles(repoRoot, PROJECT_FILE_GLOBS).sort(byShallowestThenName);
}

function listPythonFiles(projectRoot) {
  return listRgFiles(projectRoot, ['*.py']);
}

function dependencyText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function declaresDjango(file) {
  return DJANGO_DEP_RE.test(dependencyText(file));
}

function declaresDrf(file) {
  return DRF_DEP_RE.test(dependencyText(file));
}

function sourceConfirmsDjango(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return /from\s+django\.urls\s+import/.test(text) ||
      /from\s+rest_framework\s+import/.test(text) ||
      /from\s+rest_framework\.routers\s+import/.test(text);
  } catch {
    return false;
  }
}

export function detectPythonDjangoRoot(repoRoot) {
  for (const depFile of listProjectFiles(repoRoot)) {
    if (!declaresDjango(depFile)) continue;
    const projectRoot = path.dirname(depFile);
    if (listPythonFiles(projectRoot).some(sourceConfirmsDjango)) return projectRoot;
  }
  return null;
}

function maskPythonCommentsAndDocstrings(text) {
  const out = text.split('');
  let i = 0;
  let quote = null;
  let triple = false;
  while (i < text.length) {
    if (triple) {
      const token = quote.repeat(3);
      if (text.startsWith(token, i)) {
        for (let j = 0; j < 3; j++) out[i + j] = ' ';
        i += 3; triple = false; quote = null; continue;
      }
      if (text[i] !== '\n') out[i] = ' ';
      i++; continue;
    }
    if (quote) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === quote) quote = null;
      i++; continue;
    }
    if ((text[i] === "'" || text[i] === '"') && text.slice(i, i + 3) === text[i].repeat(3)) {
      quote = text[i]; triple = true;
      for (let j = 0; j < 3; j++) out[i + j] = ' ';
      i += 3; continue;
    }
    if (text[i] === "'" || text[i] === '"') { quote = text[i]; i++; continue; }
    if (text[i] === '#') {
      while (i < text.length && text[i] !== '\n') { out[i] = ' '; i++; }
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
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
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
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function literalString(text) {
  const m = text?.trim().match(/^[rRuU]?['"]([^'"]*)['"]$/);
  return m ? m[1] : null;
}

function kwarg(argsText, name) {
  for (const part of splitTopLevel(argsText)) {
    const m = part.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/);
    if (m && m[1] === name) return m[2].trim();
  }
  return null;
}

function blockEnd(text, start) {
  let pos = text.indexOf('\n', start);
  if (pos === -1) return text.length;
  pos++;
  while (pos < text.length) {
    const end = text.indexOf('\n', pos);
    const lineEnd = end === -1 ? text.length : end;
    const line = text.slice(pos, lineEnd);
    if (line.trim() && !/^\s/.test(line)) return pos;
    pos = end === -1 ? text.length : end + 1;
  }
  return text.length;
}

function nextDef(text, start) {
  let pos = start;
  while (pos < text.length) {
    while (/\s/.test(text[pos] ?? '')) pos++;
    if (text[pos] !== '@') break;
    const open = text.indexOf('(', pos);
    const lineEnd = text.indexOf('\n', pos);
    if (open !== -1 && (lineEnd === -1 || open < lineEnd)) {
      const close = matchBalancedParens(text, open);
      if (close === -1) return null;
      pos = close + 1;
    } else {
      pos = lineEnd === -1 ? text.length : lineEnd + 1;
    }
  }
  const m = text.slice(pos, pos + 500).match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
  return m ? m[1] : null;
}

function actionMethods(argsText) {
  const raw = kwarg(argsText, 'methods');
  if (raw == null) return ['GET'];
  const list = raw.match(/^\[([\s\S]*)\]$/) ?? raw.match(/^\(([\s\S]*)\)$/);
  if (!list) return [];
  const methods = splitTopLevel(list[1]).map(literalString);
  if (methods.some((m) => !m)) return [];
  return methods.map((m) => m.toUpperCase()).filter((m) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(m));
}

function extractViewSets(text, file) {
  const out = new Map();
  const classRe = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/gm;
  for (const m of text.matchAll(classRe)) {
    const className = m[1];
    const bases = m[2];
    if (!/ViewSet/.test(bases)) continue;
    const end = blockEnd(text, m.index);
    const body = text.slice(m.index + m[0].length, end);
    const explicitMethods = new Set();
    for (const mm of body.matchAll(/^\s+(?:async\s+)?def\s+(\w+)\s*\(/gm)) {
      if (STANDARD_ACTIONS.has(mm[1])) explicitMethods.add(mm[1]);
    }

    let actions;
    if (/ReadOnlyModelViewSet/.test(bases)) actions = new Set(['list', 'retrieve']);
    else if (/ModelViewSet/.test(bases)) actions = new Set(STANDARD_ACTIONS);
    else actions = explicitMethods;

    const extra = [];
    for (const am of body.matchAll(/@action\s*\(/g)) {
      const open = am.index + am[0].length - 1;
      const close = matchBalancedParens(body, open);
      if (close === -1) continue;
      const argsText = body.slice(open + 1, close);
      const detailRaw = kwarg(argsText, 'detail');
      if (detailRaw !== 'True' && detailRaw !== 'False') continue;
      const methodName = nextDef(body, close + 1);
      if (!methodName) continue;
      const methods = actionMethods(argsText);
      if (methods.length === 0) continue;
      const urlPathRaw = kwarg(argsText, 'url_path');
      const urlPath = urlPathRaw == null ? methodName : literalString(urlPathRaw);
      if (urlPath == null) continue;
      extra.push({
        methodName,
        detail: detailRaw === 'True',
        methods,
        urlPath,
        line: lineNumberAt(text, m.index + m[0].length + am.index),
      });
    }

    const customLookup = /^\s+(?:lookup_field|lookup_url_kwarg|lookup_value_regex|lookup_value_converter)\s*=/m.test(body);
    out.set(className, { className, actions, extra, customLookup, file });
  }
  return out;
}

function extractRouters(text) {
  const routers = new Map();
  for (const m of text.matchAll(/\b(\w+)\s*=\s*(?:(?:routers\.)?)(SimpleRouter|DefaultRouter)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchBalancedParens(text, open);
    if (close === -1) continue;
    const args = text.slice(open + 1, close);
    const trailingRaw = kwarg(args, 'trailing_slash');
    const trailingSlash = trailingRaw === 'False' ? false : true;
    routers.set(m[1], { name: m[1], kind: m[2], trailingSlash, registrations: [], mounts: [] });
  }

  for (const m of text.matchAll(/\b(\w+)\.register\s*\(/g)) {
    const router = routers.get(m[1]);
    if (!router) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBalancedParens(text, open);
    if (close === -1) continue;
    const argsText = text.slice(open + 1, close);
    const args = splitTopLevel(argsText);
    const prefix = literalString(args[0]);
    const viewset = args[1]?.match(/^([A-Za-z_]\w*)$/)?.[1];
    if (prefix == null || !viewset) continue;
    const basenameRaw = kwarg(argsText, 'basename');
    const basename = basenameRaw == null ? null : literalString(basenameRaw);
    router.registrations.push({ prefix, viewset, basename, line: lineNumberAt(text, m.index) });
  }

  for (const router of routers.values()) {
    const rootRe = new RegExp('\\burlpatterns\\s*(?:\\+?=)\\s*' + router.name + '\\.urls\\b');
    if (rootRe.test(text)) router.mounts.push('');

    for (const m of text.matchAll(/\b(?:path|re_path)\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = matchBalancedParens(text, open);
      if (close === -1) continue;
      const args = splitTopLevel(text.slice(open + 1, close));
      const prefix = literalString(args[0]);
      if (prefix == null || !args[1]) continue;
      const escaped = router.name.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
      const includeRe = new RegExp('^include\\s*\\(\\s*' + escaped + '\\.urls\\s*\\)$');
      if (includeRe.test(args[1].trim())) router.mounts.push(prefix);
    }

    router.mounts = [...new Set(router.mounts)].sort();
  }

  return routers;
}

function urlPath(parts, trailingSlash) {
  const joined = parts.map((p) => (p || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
  return '/' + joined + (trailingSlash ? '/' : '');
}

function moduleNameFor(file) {
  const stem = path.basename(file, '.py');
  return stem === 'urls' || stem === '__init__' ? path.basename(path.dirname(file)) : stem;
}

function endpointsForRegistration(reg, router, viewset, mount) {
  if (!viewset) return [];
  const out = [];
  const collection = urlPath([mount, reg.prefix], router.trailingSlash);
  const detail = urlPath([mount, reg.prefix, '{pk}'], router.trailingSlash);
  const add = (verb, pathValue, method, line = reg.line) => out.push({ verb, path: pathValue, operationId: null, method, line });

  if (viewset.actions.has('list')) add('GET', collection, 'list');
  if (viewset.actions.has('create')) add('POST', collection, 'create');
  if (!viewset.customLookup) {
    if (viewset.actions.has('retrieve')) add('GET', detail, 'retrieve');
    if (viewset.actions.has('update')) add('PUT', detail, 'update');
    if (viewset.actions.has('partial_update')) add('PATCH', detail, 'partial_update');
    if (viewset.actions.has('destroy')) add('DELETE', detail, 'destroy');
  }

  for (const action of viewset.extra) {
    if (action.detail && viewset.customLookup) continue;
    const p = action.detail
      ? urlPath([mount, reg.prefix, '{pk}', action.urlPath], router.trailingSlash)
      : urlPath([mount, reg.prefix, action.urlPath], router.trailingSlash);
    for (const verb of action.methods) add(verb, p, action.methodName, action.line);
  }

  return out.sort((a, b) => a.path.localeCompare(b.path) || a.verb.localeCompare(b.verb));
}

const API_SURFACE_SOURCE =
  'Django/DRF static discovery: SimpleRouter/DefaultRouter registrations and ViewSet action sets. ' +
  'Plain Django path()/re_path() entries do not declare HTTP methods and are not converted into ' +
  'HTTP endpoints. Only same-file literal router mounts through include(router.urls), or root ' +
  'urlpatterns = router.urls, are composed. Lookup customization, custom routers, cross-file ' +
  'URLConf include graphs, runtime settings, permissions and serializers remain unresolved.';

export function scanPythonDjango(repoRoot, projectRoot) {
  const files = listPythonFiles(projectRoot);
  const texts = new Map();
  const viewsets = new Map();

  for (const file of files) {
    let text;
    try { text = maskPythonCommentsAndDocstrings(fs.readFileSync(file, 'utf8')); }
    catch { text = ''; }
    texts.set(file, text);
    for (const [name, info] of extractViewSets(text, file)) viewsets.set(name, info);
  }

  const modules = new Map();
  for (const file of files) {
    const routers = extractRouters(texts.get(file));
    if (routers.size === 0) continue;
    const moduleName = moduleNameFor(file);
    if (!modules.has(moduleName)) modules.set(moduleName, { module: moduleName, controllers: [], entities: [], enums: [], dtos: [] });

    for (const router of routers.values()) {
      for (const reg of router.registrations) {
        const viewset = viewsets.get(reg.viewset);
        if (!viewset) continue;
        for (const mount of router.mounts) {
          const endpoints = endpointsForRegistration(reg, router, viewset, mount);
          if (endpoints.length === 0) continue;
          modules.get(moduleName).controllers.push({
            className: reg.viewset,
            basePath: urlPath([mount, reg.prefix], router.trailingSlash),
            operationIds: [],
            endpoints,
            file,
          });
        }
      }
    }
  }

  const depFiles = listProjectFiles(repoRoot).filter((f) => path.dirname(f) === projectRoot);
  return {
    modules: [...modules.values()].sort((a, b) => a.module.localeCompare(b.module)),
    pathPrefixSignals: [],
    apiSurfaceSource: API_SURFACE_SOURCE,
    filesRead: [...depFiles, ...files].map((f) => path.relative(repoRoot, f)).sort(),
  };
}

function diagnostics(repoRoot) {
  const messages = [];
  const depFiles = listProjectFiles(repoRoot);
  if (depFiles.length === 0) messages.push({ level: 'info', code: 'no-python-project-file', message: 'no pyproject.toml or requirements*.txt found' });
  else if (!depFiles.some(declaresDjango)) messages.push({ level: 'info', code: 'django-not-a-dependency', message: 'Python project files were found, but none declare Django' });
  else if (!depFiles.some(declaresDrf)) messages.push({ level: 'info', code: 'drf-not-a-dependency', message: 'Django is declared, but djangorestframework is not; plain Django URL paths have no static HTTP method mapping in this adapter' });
  if (!binaryAvailable('rg')) messages.push({ level: 'warn', code: 'rg-missing', message: 'ripgrep (rg) is not on PATH -- this adapter uses it for bounded file discovery and will not detect without it' });
  messages.push({ level: 'info', code: 'django-static-slice-limit', message: 'Custom routers, cross-file URLConf include graphs, lookup customization, permissions and serializer schemas are intentionally unresolved in this first static slice.' });
  return messages;
}

export const adapter = {
  contract: 'sbf.adapter/2',
  id: 'python-django',
  title: 'Python / Django / DRF router profile',
  specificity: 89,
  confidence: 'high',
  verificationBasis: 'synthetic-only',
  capabilities: {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  },
  detect: detectPythonDjangoRoot,
  scan(repoRoot, detection) { return scanPythonDjango(repoRoot, detection); },
  listReadSet(repoRoot) {
    const projectRoot = detectPythonDjangoRoot(repoRoot);
    if (!projectRoot) return [];
    const depFiles = listProjectFiles(repoRoot).filter((f) => path.dirname(f) === projectRoot);
    return [...depFiles, ...listPythonFiles(projectRoot)].map((f) => path.relative(repoRoot, f)).sort();
  },
  diagnostics,
};
