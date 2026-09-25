import fs from 'node:fs';
import path from 'node:path';
import { lineNumberAt, listRgFiles as sharedListRgFiles, byShallowestThenName, binaryAvailable } from '../text-util.mjs';

const PROJECT_FILE_GLOBS = ['pyproject.toml', 'requirements*.txt'];
const EXCLUDE_GLOBS = ['!**/.venv/**', '!**/site-packages/**', '!**/__pycache__/**', '!**/node_modules/**'];
const FLASK_DEP_RE = /(?:^|[\s"'[])flask(?:[\s"',\]=<>~!;]|$)/mi;
const ROUTE_DECORATOR_RE = /@(\w+)\.(route|get|post|put|patch|delete)\s*\(/gi;

function listRgFiles(dir, globs) {
  return sharedListRgFiles(dir, globs, EXCLUDE_GLOBS);
}

function listProjectFiles(repoRoot) {
  return listRgFiles(repoRoot, PROJECT_FILE_GLOBS).sort(byShallowestThenName);
}

function listPythonFiles(projectRoot) {
  return listRgFiles(projectRoot, ['*.py']);
}

function declaresFlask(file) {
  try { return FLASK_DEP_RE.test(fs.readFileSync(file, 'utf8')); }
  catch { return false; }
}

function sourceConfirmsFlask(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return /from\s+flask\s+import/.test(text) && /\b(?:Flask|Blueprint)\s*\(/.test(text);
  } catch {
    return false;
  }
}

export function detectPythonFlaskRoot(repoRoot) {
  for (const depFile of listProjectFiles(repoRoot)) {
    if (!declaresFlask(depFile)) continue;
    const projectRoot = path.dirname(depFile);
    if (listPythonFiles(projectRoot).some(sourceConfirmsFlask)) return projectRoot;
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
      parts.push(text.slice(start, i).trim()); start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function literalString(text) {
  const m = text?.trim().match(/^['"]([^'"]*)['"]$/);
  return m ? m[1] : null;
}

function kwarg(argsText, name) {
  for (const part of splitTopLevel(argsText)) {
    const m = part.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/);
    if (m && m[1] === name) return m[2].trim();
  }
  return null;
}

function extractBindings(text) {
  const apps = new Set();
  const blueprints = new Map();

  for (const m of text.matchAll(/\b(\w+)\s*=\s*Flask\s*\(/g)) apps.add(m[1]);

  for (const m of text.matchAll(/\b(\w+)\s*=\s*Blueprint\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchBalancedParens(text, open);
    if (close === -1) continue;
    const args = text.slice(open + 1, close);
    const rawPrefix = kwarg(args, 'url_prefix');
    const prefix = rawPrefix == null ? '' : literalString(rawPrefix);
    blueprints.set(m[1], { declaredPrefix: prefix, registrations: [] });
  }

  for (const app of apps) {
    const re = new RegExp('\\b' + app + '\\.register_blueprint\\s*\\(', 'g');
    for (const m of text.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      const close = matchBalancedParens(text, open);
      if (close === -1) continue;
      const args = splitTopLevel(text.slice(open + 1, close));
      const bpName = args[0]?.match(/^([A-Za-z_]\w*)$/)?.[1];
      if (!bpName || !blueprints.has(bpName)) continue;
      const rawPrefix = kwarg(text.slice(open + 1, close), 'url_prefix');
      const registrationPrefix = rawPrefix == null ? undefined : literalString(rawPrefix);
      blueprints.get(bpName).registrations.push({ app, registrationPrefix });
    }
  }

  return { apps, blueprints };
}

function resolveRelativeModule(fromFile, moduleName) {
  const base = path.resolve(path.dirname(fromFile), moduleName);
  const probes = [base + '.py', path.join(base, '__init__.py')];
  return probes.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function relativeModuleImports(text, file) {
  const out = new Map();
  for (const m of text.matchAll(/^\s*from\s+\.\s+import\s+([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?/gm)) {
    const resolved = resolveRelativeModule(file, m[1]);
    if (resolved) out.set(m[2] ?? m[1], resolved);
  }
  return out;
}

function crossFileBlueprintRegistrations(texts) {
  const byTarget = new Map();

  for (const [file, text] of texts) {
    const { apps } = extractBindings(text);
    if (apps.size === 0) continue;
    const imports = relativeModuleImports(text, file);
    if (imports.size === 0) continue;

    for (const app of apps) {
      const re = new RegExp('\\b' + app + '\\.register_blueprint\\s*\\(', 'g');
      for (const m of text.matchAll(re)) {
        const open = m.index + m[0].length - 1;
        const close = matchBalancedParens(text, open);
        if (close === -1) continue;

        const argsText = text.slice(open + 1, close);
        const args = splitTopLevel(argsText);
        const ref = args[0]?.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
        if (!ref) continue;

        const targetFile = imports.get(ref[1]);
        if (!targetFile || !texts.has(targetFile)) continue;
        const targetBindings = extractBindings(texts.get(targetFile));
        if (!targetBindings.blueprints.has(ref[2])) continue;

        const rawPrefix = kwarg(argsText, 'url_prefix');
        const registrationPrefix = rawPrefix == null ? undefined : literalString(rawPrefix);
        if (rawPrefix != null && registrationPrefix == null) continue;

        if (!byTarget.has(targetFile)) byTarget.set(targetFile, new Map());
        const targetVars = byTarget.get(targetFile);
        if (!targetVars.has(ref[2])) targetVars.set(ref[2], []);
        targetVars.get(ref[2]).push({ app, registrationPrefix, sourceFile: file });
      }
    }
  }

  return byTarget;
}

function routeMethods(kind, argsText) {
  if (kind !== 'route') return [kind.toUpperCase()];
  const raw = kwarg(argsText, 'methods');
  if (raw == null) return ['GET'];
  const match = raw.trim().match(/^\[([\s\S]*)\]$/) ?? raw.trim().match(/^\(([\s\S]*)\)$/);
  if (!match) return [];
  const methods = splitTopLevel(match[1]).map(literalString);
  if (methods.some((m) => !m)) return [];
  return methods.map((m) => m.toUpperCase()).filter((m) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(m));
}

function findHandler(text, start) {
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
  const m = text.slice(pos, pos + 400).match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
  return m ? m[1] : null;
}

function joinPath(base, segment) {
  const b = (base || '').replace(/\/$/, '');
  const s = (segment || '').replace(/^\//, '');
  return s ? (b ? b + '/' + s : '/' + s) : (b || '/');
}

function moduleNameFor(file) {
  const stem = path.basename(file, '.py');
  return stem === '__init__' ? path.basename(path.dirname(file)) : stem;
}

function extractControllers(text, file, externalRegistrations = new Map()) {
  const { apps, blueprints } = extractBindings(text);
  for (const [bpName, registrations] of externalRegistrations) {
    if (!blueprints.has(bpName)) continue;
    blueprints.get(bpName).registrations.push(...registrations);
  }
  const grouped = new Map();

  for (const m of text.matchAll(ROUTE_DECORATOR_RE)) {
    const receiver = m[1];
    const kind = m[2].toLowerCase();
    if (!apps.has(receiver) && !blueprints.has(receiver)) continue;

    const open = m.index + m[0].length - 1;
    const close = matchBalancedParens(text, open);
    if (close === -1) continue;
    const argsText = text.slice(open + 1, close);
    const first = splitTopLevel(argsText)[0];
    const routePath = literalString(first);
    if (routePath === null) continue;

    const methods = routeMethods(kind, argsText);
    if (methods.length === 0) continue;
    const handler = findHandler(text, close + 1);
    if (!handler) continue;

    let prefixes;
    if (apps.has(receiver)) {
      prefixes = [''];
    } else {
      const bp = blueprints.get(receiver);
      if (bp.registrations.length === 0) continue;
      prefixes = bp.registrations
        .map((r) => r.registrationPrefix === undefined ? bp.declaredPrefix : r.registrationPrefix)
        .filter((p) => p !== null);
    }

    for (const prefix of [...new Set(prefixes)].sort()) {
      const key = receiver + '\0' + prefix;
      if (!grouped.has(key)) grouped.set(key, { receiver, prefix, endpoints: [] });
      for (const verb of methods) {
        grouped.get(key).endpoints.push({
          verb,
          path: joinPath(prefix, routePath),
          operationId: null,
          method: handler,
          line: lineNumberAt(text, m.index),
        });
      }
    }
  }

  const moduleName = moduleNameFor(file);
  return [...grouped.values()].map((g) => ({
    module: moduleName,
    controller: {
      className: moduleName + (apps.has(g.receiver) ? 'FlaskAppRoutes' : 'FlaskBlueprintRoutes'),
      basePath: g.prefix,
      operationIds: [],
      endpoints: g.endpoints.sort((a, b) => a.line - b.line || a.verb.localeCompare(b.verb)),
      file,
    },
  }));
}

const API_SURFACE_SOURCE =
  'Flask static discovery: literal @app/@blueprint route decorators. Blueprint paths are emitted ' +
  'for same-file registrations and conservative relative-module registrations of the form ' +
  'from . import module + app.register_blueprint(module.bp). App factories are not executed. ' +
  'add_url_rule(), arbitrary import graphs, dynamic methods/prefixes, ' +
  'extensions, auth enforcement and runtime configuration are not inferred.';

export function scanPythonFlask(repoRoot, projectRoot) {
  const files = listPythonFiles(projectRoot);
  const modules = new Map();
  const texts = new Map();

  for (const file of files) {
    try { texts.set(file, maskPythonCommentsAndDocstrings(fs.readFileSync(file, 'utf8'))); }
    catch { texts.set(file, ''); }
  }

  const externalRegistrations = crossFileBlueprintRegistrations(texts);

  for (const file of files) {
    const text = texts.get(file);
    for (const entry of extractControllers(text, file, externalRegistrations.get(file) ?? new Map())) {
      if (!modules.has(entry.module)) modules.set(entry.module, { module: entry.module, controllers: [], entities: [], enums: [], dtos: [] });
      modules.get(entry.module).controllers.push(entry.controller);
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
  else if (!depFiles.some(declaresFlask)) messages.push({ level: 'info', code: 'flask-not-a-dependency', message: 'Python project files were found, but none declare Flask' });
  if (!binaryAvailable('rg')) messages.push({ level: 'warn', code: 'rg-missing', message: 'ripgrep (rg) is not on PATH -- this adapter uses it for bounded file discovery and will not detect without it' });
  messages.push({ level: 'info', code: 'flask-static-slice-limit', message: 'Only conservative relative-module Blueprint registration is resolved statically; arbitrary import graphs, app-factory runtime state, add_url_rule(), extensions and dynamic configuration still require approved runtime evidence.' });
  return messages;
}

export const adapter = {
  contract: 'sbf.adapter/2',
  id: 'python-flask',
  title: 'Python / Flask',
  specificity: 87,
  confidence: 'high',
  verificationBasis: 'synthetic-only',
  capabilities: {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  },
  detect: detectPythonFlaskRoot,
  scan(repoRoot, detection) { return scanPythonFlask(repoRoot, detection); },
  listReadSet(repoRoot) {
    const projectRoot = detectPythonFlaskRoot(repoRoot);
    if (!projectRoot) return [];
    const depFiles = listProjectFiles(repoRoot).filter((f) => path.dirname(f) === projectRoot);
    return [...depFiles, ...listPythonFiles(projectRoot)].map((f) => path.relative(repoRoot, f)).sort();
  },
  diagnostics,
};
