import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.git', 'coverage']);
const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

function walkSourceFiles(root) {
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
      } else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out.sort();
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

export function maskHonoSourceComments(text) {
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
    if (ch === "'" || ch === '"' || ch === '\x60') { quote = ch; continue; }
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
  const b = String(base || '').replace(/\/$/, '');
  const s = String(segment || '').replace(/^\//, '');
  if (!b && !s) return '/';
  if (!b) return '/' + s;
  if (!s) return b || '/';
  return (b + '/' + s).replace(/\/+/g, '/');
}

function commonPathPrefix(paths) {
  if (paths.length === 0) return '/';
  const segments = paths.map((p) => p.split('/').filter(Boolean));
  const min = Math.min(...segments.map((x) => x.length));
  const shared = [];
  for (let i = 0; i < min; i++) {
    if (segments.every((x) => x[i] === segments[0][i])) shared.push(segments[0][i]);
    else break;
  }
  return shared.length ? '/' + shared.join('/') : '/';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseBasePath(raw) {
  if (raw === undefined) return { value: '', unknown: false };
  const value = raw.trim();
  const m = value.match(/^(['"\x60])([\s\S]*)\1$/);
  if (!m) return { value: '', unknown: true };
  if (m[1] === '\x60' && m[2].includes('${')) return { value: '', unknown: true };
  return { value: m[2], unknown: false };
}

function parseHonoVariables(masked) {
  const vars = new Map();
  const re = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*new\s+Hono(?:\s*<[^>\n]{1,500}>)?\s*\([^)]*\)(?:\s*\.\s*basePath\s*\(\s*([^)]*)\))?/g;
  for (const m of masked.matchAll(re)) {
    const base = parseBasePath(m[2]);
    vars.set(m[1], {
      name: m[1],
      declarationIndex: m.index,
      basePath: base.value,
      basePathUnknown: base.unknown,
    });
  }
  return vars;
}

function parseImports(masked) {
  const imports = new Map();
  const fromRelative = /\bfrom\s*['"](\.[^'"]+)['"]/g;
  for (const m of masked.matchAll(fromRelative)) {
    const before = masked.slice(0, m.index);
    const importIndex = before.lastIndexOf('import');
    if (importIndex === -1 || m.index - importIndex > 500) continue;
    const clause = before.slice(importIndex + 'import'.length).replace(/\s+/g, ' ').trim();
    const specifier = m[1];
    if (clause.startsWith('*')) continue;
    let rest = clause;
    if (!rest.startsWith('{')) {
      const comma = rest.indexOf(',');
      const local = (comma === -1 ? rest : rest.slice(0, comma)).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) imports.set(local, { specifier, kind: 'default', imported: 'default' });
      rest = comma === -1 ? '' : rest.slice(comma + 1).trim();
    }
    const brace = rest.match(/^\{([\s\S]*)\}$/);
    if (!brace) continue;
    for (const part of brace[1].split(',')) {
      const item = part.trim();
      if (!item) continue;
      const as = item.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!as) continue;
      imports.set(as[2] || as[1], { specifier, kind: 'named', imported: as[1] });
    }
  }
  return imports;
}

function parseExports(masked) {
  const named = new Map();
  let defaultExport = null;
  for (const m of masked.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) named.set(m[1], m[1]);
  for (const m of masked.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const item = part.trim();
      if (!item) continue;
      const as = item.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!as) continue;
      const local = as[1];
      const exported = as[2] || as[1];
      if (exported === 'default') defaultExport = local;
      else named.set(exported, local);
    }
  }
  const def = masked.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)/);
  if (def) defaultExport = def[1];
  return { named, defaultExport };
}

function handlerName(args) {
  const parts = args.split(',').map((x) => x.trim()).filter(Boolean);
  const last = (parts.at(-1) || '').replace(/\)\s*$/, '').trim();
  return /^[A-Za-z_$][\w$]*$/.test(last) ? last : null;
}

function parseFile(file, text) {
  const masked = maskHonoSourceComments(text);
  const vars = parseHonoVariables(masked);
  const imports = parseImports(masked);
  const exports = parseExports(masked);
  const events = new Map();
  const notes = [];
  for (const name of vars.keys()) events.set(name, []);

  for (const [name] of vars) {
    const escaped = escapeRegExp(name);
    const routeRe = new RegExp('\\b' + escaped + '\\s*\\.\\s*(get|post|put|patch|delete|options|head)\\s*\\(\\s*([\\\'"\\x60])([^\\\'"\\x60]+)\\2\\s*,([^;\\n]*)', 'gi');
    const recognizedMethodIndexes = new Set();
    for (const m of masked.matchAll(routeRe)) {
      recognizedMethodIndexes.add(m.index);
      if (m[2] === '\x60' && m[3].includes('${')) {
        notes.push('Hono interpolated template route at ' + path.basename(file) + ':' + lineNumberAt(text, m.index) + ' is not emitted.');
        continue;
      }
      events.get(name).push({
        type: 'route',
        index: m.index,
        line: lineNumberAt(text, m.index),
        verb: m[1].toUpperCase(),
        path: m[3],
        handler: handlerName(m[4]),
      });
    }

    const anyMethodRe = new RegExp('\\b' + escaped + '\\s*\\.\\s*(get|post|put|patch|delete|options|head)\\s*\\(', 'gi');
    for (const m of masked.matchAll(anyMethodRe)) {
      if (!recognizedMethodIndexes.has(m.index)) {
        notes.push('Hono ' + m[1] + '() at ' + path.basename(file) + ':' + lineNumberAt(text, m.index) + ' uses a non-literal or chained path form and is not emitted by the T13 first slice.');
      }
    }

    const routeReLiteral = new RegExp('\\b' + escaped + '\\s*\\.\\s*route\\s*\\(\\s*([\\\'"\\x60])([^\\\'"\\x60]+)\\1\\s*,\\s*([A-Za-z_$][\\w$]*)', 'g');
    const recognizedMountIndexes = new Set();
    for (const m of masked.matchAll(routeReLiteral)) {
      recognizedMountIndexes.add(m.index);
      if (m[1] === '\x60' && m[2].includes('${')) {
        notes.push('Hono interpolated route() mount at ' + path.basename(file) + ':' + lineNumberAt(text, m.index) + ' is not expanded.');
        continue;
      }
      events.get(name).push({
        type: 'mount',
        index: m.index,
        line: lineNumberAt(text, m.index),
        mountPath: m[2],
        childBinding: m[3],
      });
    }

    const anyMountRe = new RegExp('\\b' + escaped + '\\s*\\.\\s*route\\s*\\(', 'g');
    for (const m of masked.matchAll(anyMountRe)) {
      if (!recognizedMountIndexes.has(m.index)) {
        notes.push('Hono route() at ' + path.basename(file) + ':' + lineNumberAt(text, m.index) + ' has a dynamic path or non-identifier child and is not expanded.');
      }
    }

    const unsupportedRe = new RegExp('\\b' + escaped + '\\s*\\.\\s*(all|on|use|mount)\\s*\\(', 'gi');
    for (const m of masked.matchAll(unsupportedRe)) {
      notes.push('Hono ' + m[1] + '() at ' + path.basename(file) + ':' + lineNumberAt(text, m.index) + ' has distinct routing/middleware semantics and is observed but not emitted by the T13 first slice.');
    }
    events.get(name).sort((a, b) => a.index - b.index);
  }

  return { file, text, masked, vars, imports, exports, events, notes };
}

function resolveModule(fromFile, specifier, fileSet) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [];
  if (SOURCE_EXTENSIONS.includes(path.extname(base))) candidates.push(base);
  else {
    for (const ext of SOURCE_EXTENSIONS) candidates.push(base + ext);
    for (const ext of SOURCE_EXTENSIONS) candidates.push(path.join(base, 'index' + ext));
  }
  return candidates.find((candidate) => fileSet.has(candidate)) || null;
}

function nodeKey(file, name) {
  return file + '\u0000' + name;
}

export function scanHonoProject({ repoRoot, projectRoot, packageFile }) {
  const files = walkSourceFiles(projectRoot);
  const fileSet = new Set(files);
  const parsed = new Map();
  const nodes = new Map();
  const notes = [];

  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const info = parseFile(file, text);
    parsed.set(file, info);
    notes.push(...info.notes);
    for (const [name, variable] of info.vars) {
      nodes.set(nodeKey(file, name), { file, name, ...variable, events: info.events.get(name) || [] });
    }
  }

  function resolveChild(parentNode, binding) {
    const parentInfo = parsed.get(parentNode.file);
    if (parentInfo.vars.has(binding)) return nodeKey(parentNode.file, binding);
    const imported = parentInfo.imports.get(binding);
    if (!imported) return null;
    const targetFile = resolveModule(parentNode.file, imported.specifier, fileSet);
    if (!targetFile) return null;
    const targetInfo = parsed.get(targetFile);
    if (!targetInfo) return null;
    const targetLocal = imported.kind === 'default'
      ? targetInfo.exports.defaultExport
      : targetInfo.exports.named.get(imported.imported);
    if (!targetLocal || !targetInfo.vars.has(targetLocal)) return null;
    return nodeKey(targetFile, targetLocal);
  }

  const mountedChildren = new Set();
  for (const node of nodes.values()) {
    for (const event of node.events) {
      if (event.type !== 'mount') continue;
      const child = resolveChild(node, event.childBinding);
      if (child) mountedChildren.add(child);
    }
  }

  const memo = new Map();
  function expand(key, cutoff = Infinity, stack = []) {
    const memoKey = key + '\u0001' + String(cutoff);
    if (memo.has(memoKey)) return memo.get(memoKey).map((ep) => ({ ...ep }));
    if (stack.includes(key)) {
      const node = nodes.get(key);
      notes.push('Hono route() graph cycle involving ' + path.basename(node?.file || key) + ' was not expanded.');
      return [];
    }
    const node = nodes.get(key);
    if (!node) return [];
    const out = [];
    const nextStack = [...stack, key];

    for (const event of node.events) {
      if (event.index >= cutoff) break;
      if (event.type === 'route') {
        if (node.basePathUnknown) {
          notes.push('Hono basePath() for ' + node.name + ' at ' + path.basename(node.file) + ' is non-literal; routes on this app are not emitted because their absolute paths are unknown.');
          continue;
        }
        out.push({
          verb: event.verb,
          path: joinPath(node.basePath, event.path),
          operationId: null,
          method: event.handler,
          line: event.line,
        });
        continue;
      }

      if (node.basePathUnknown) {
        notes.push('Hono route() on ' + node.name + ' at ' + path.basename(node.file) + ':' + event.line + ' is not expanded because the parent basePath() is non-literal.');
        continue;
      }
      const childKey = resolveChild(node, event.childBinding);
      if (!childKey) {
        notes.push('Hono route() mount at ' + path.basename(node.file) + ':' + event.line + ' (' + event.mountPath + ', ' + event.childBinding + ') could not be resolved to a local or relative-imported Hono app.');
        continue;
      }
      const childNode = nodes.get(childKey);
      const childCutoff = childNode.file === node.file ? event.index : Infinity;
      const childEndpoints = expand(childKey, childCutoff, nextStack);
      const prefix = joinPath(node.basePath, event.mountPath);
      for (const ep of childEndpoints) out.push({ ...ep, path: joinPath(prefix, ep.path) });
    }

    memo.set(memoKey, out.map((ep) => ({ ...ep })));
    return out;
  }

  let roots = [...nodes.keys()].filter((key) => !mountedChildren.has(key));
  if (roots.length === 0 && nodes.size > 0) {
    roots = [...nodes.keys()].sort();
    notes.push('All discovered Hono apps participate in route() mount relationships; no unique root could be inferred, so each app is emitted separately.');
  }

  const controllers = [];
  for (const key of roots.sort()) {
    const node = nodes.get(key);
    const endpoints = expand(key);
    if (endpoints.length === 0) continue;
    controllers.push({
      className: 'Hono(' + path.relative(projectRoot, node.file) + ':' + node.name + ')',
      basePath: commonPathPrefix(endpoints.map((ep) => ep.path)),
      operationIds: [],
      endpoints,
      file: node.file,
    });
  }

  let packageName = path.basename(projectRoot) || '_hono';
  try {
    packageName = JSON.parse(fs.readFileSync(packageFile, 'utf8'))?.name || packageName;
  } catch {}

  const filesRead = [packageFile, ...files].map((file) => path.relative(repoRoot, file)).sort();
  const uniqueNotes = [...new Set([
    'T13 Hono route graph: literal per-verb routes and resolvable route() mounts are emitted in registration order; dynamic paths, custom on/all/use/mount semantics and unresolved imports remain unknown.',
    ...notes,
  ])];

  return {
    modules: controllers.length > 0
      ? [{ module: packageName, controllers, entities: [], enums: [], dtos: [] }]
      : [],
    filesRead,
    scanNotes: uniqueNotes,
    apiSurfaceSource: 'Hono source literals + bounded same-file/relative-import route() graph only (T13 experimental leaf; operationId/schema/security/runtime semantics are not inferred)',
  };
}
