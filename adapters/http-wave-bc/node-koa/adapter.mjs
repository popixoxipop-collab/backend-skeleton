import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.git', 'coverage']);
const STANDARD_METHODS = new Map([
  ['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'],
  ['delete', 'DELETE'], ['del', 'DELETE'], ['head', 'HEAD'], ['options', 'OPTIONS'],
  ['connect', 'CONNECT'], ['trace', 'TRACE'],
]);

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

function sourceFiles(projectRoot) {
  return walkFiles(projectRoot)
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
    .sort();
}

function declaresKoaRouter(pkg) {
  const bags = [pkg?.dependencies, pkg?.devDependencies, pkg?.peerDependencies, pkg?.optionalDependencies];
  return bags.some((bag) => bag && typeof bag['@koa/router'] === 'string');
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

function routerConstructors(masked) {
  const names = new Set();
  const defaultImport = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*['"]@koa\/router['"]/g;
  for (const m of masked.matchAll(defaultImport)) names.add(m[1]);

  const namedImport = /\bimport\s*\{([^}]*)\}\s*from\s*['"]@koa\/router['"]/g;
  for (const m of masked.matchAll(namedImport)) {
    for (const part of m[1].split(',')) {
      const item = part.trim();
      const hit = item.match(/^Router(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (hit) names.add(hit[1] || 'Router');
    }
  }

  const requireDefault = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]@koa\/router['"]\s*\)/g;
  for (const m of masked.matchAll(requireDefault)) names.add(m[1]);

  const requireNamed = /\b(?:const|let|var)\s*\{\s*Router(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*\}\s*=\s*require\s*\(\s*['"]@koa\/router['"]\s*\)/g;
  for (const m of masked.matchAll(requireNamed)) names.add(m[1] || 'Router');
  return names;
}

function literalPrefix(optionsText) {
  if (!optionsText || !optionsText.trim()) return { value: '', unknown: false };
  const hit = optionsText.match(/\bprefix\s*:\s*(['"`])([^'"`]+)\1/);
  if (hit) {
    if (hit[1] === '`' && hit[2].includes('${')) return { value: '', unknown: true };
    return { value: hit[2], unknown: false };
  }
  if (/\bprefix\s*:/.test(optionsText)) return { value: '', unknown: true };
  return { value: '', unknown: false };
}

function routerVariables(masked) {
  const constructors = routerConstructors(masked);
  const routers = new Map();
  for (const ctor of constructors) {
    const re = new RegExp('\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+' + escapeRegExp(ctor) + '(?:\\s*<[^>\\n]{1,500}>)?\\s*\\(([^)]*)\\)', 'g');
    for (const m of masked.matchAll(re)) {
      const prefix = literalPrefix(m[2]);
      routers.set(m[1], { name: m[1], prefix: prefix.value, prefixUnknown: prefix.unknown });
    }
  }
  return routers;
}

function handlerName(argsText) {
  const parts = argsText.split(',').map((x) => x.trim()).filter(Boolean);
  const last = (parts.at(-1) || '').replace(/\)\s*$/, '').trim();
  return /^[A-Za-z_$][\w$]*$/.test(last) ? last : null;
}

function parseRouteArgs(raw) {
  const text = raw.trim();
  const first = text.match(/^(['"`])([^'"`]+)\1\s*,\s*([\s\S]*)$/);
  if (!first) return null;
  if (first[1] === '`' && first[2].includes('${')) return null;

  const maybeNamed = first[3].match(/^(['"`])([^'"`]+)\1\s*,\s*([\s\S]*)$/);
  if (maybeNamed && !(maybeNamed[1] === '`' && maybeNamed[2].includes('${'))) {
    return { name: first[2], path: maybeNamed[2], rest: maybeNamed[3] };
  }
  return { name: null, path: first[2], rest: first[3] };
}

function scanFile(file, text) {
  const masked = maskComments(text);
  const routers = routerVariables(masked);
  const controllers = [];
  const notes = [];

  for (const [routerName, info] of routers) {
    const endpoints = [];
    const escaped = escapeRegExp(routerName);
    const prefixCallRe = new RegExp('\\b' + escaped + '\\s*\\.\\s*prefix\\s*\\(', 'gi');
    const prefixMutations = [...masked.matchAll(prefixCallRe)];
    const hasPrefixMutation = prefixMutations.length > 0;
    for (const m of prefixMutations) {
      notes.push('@koa/router prefix() mutation at ' + path.basename(file) + ':' + lineNumberAt(text, m.index) + ' is observed; routes on this router are not emitted because source-order prefix semantics are outside the T13 first slice.');
    }
    const methodNames = [...STANDARD_METHODS.keys()].join('|');
    const methodRe = new RegExp('\\b' + escaped + '\\s*\\.\\s*(' + methodNames + ')\\s*\\(([^;\\n]*)', 'gi');
    for (const m of masked.matchAll(methodRe)) {
      const parsed = parseRouteArgs(m[2]);
      if (!parsed) {
        notes.push('@koa/router ' + m[1] + '() at ' + path.basename(file) + ':' + lineNumberAt(text, m.index) + ' uses a dynamic/non-literal or unsupported route signature and was not emitted.');
        continue;
      }
      if (info.prefixUnknown) {
        notes.push('@koa/router constructor prefix for ' + routerName + ' at ' + path.basename(file) + ' is non-literal; its routes were not emitted because absolute paths are unknown.');
        continue;
      }
      if (hasPrefixMutation) continue;
      endpoints.push({
        verb: STANDARD_METHODS.get(m[1].toLowerCase()),
        path: joinPath(info.prefix, parsed.path),
        operationId: null,
        method: handlerName(parsed.rest),
        routeName: parsed.name,
        line: lineNumberAt(text, m.index),
      });
    }

    const allRe = new RegExp('\\b' + escaped + '\\s*\\.\\s*all\\s*\\(', 'gi');
    for (const m of masked.matchAll(allRe)) {
      notes.push('@koa/router all() at ' + path.basename(file) + ':' + lineNumberAt(text, m.index) + ' matches multiple HTTP methods and is observed but not emitted by the T13 first slice.');
    }

    const useRe = new RegExp('\\b' + escaped + '\\s*\\.\\s*use\\s*\\(', 'gi');
    for (const m of masked.matchAll(useRe)) {
      notes.push('@koa/router use() at ' + path.basename(file) + ':' + lineNumberAt(text, m.index) + ' may mount middleware or nested routers and is observed but not expanded by the T13 first slice.');
    }

    if (endpoints.length) {
      controllers.push({
        className: 'KoaRouter(' + routerName + ')',
        basePath: commonPathPrefix(endpoints.map((ep) => ep.path)),
        operationIds: [],
        endpoints,
        file,
      });
    }
  }

  return { controllers, notes, hasRouterImport: routerConstructors(masked).size > 0, hasRouterInstance: routers.size > 0 };
}

export function detectKoaRouterRoot(repoRoot) {
  for (const pkgFile of packageFiles(repoRoot)) {
    const pkg = readJson(pkgFile);
    if (!declaresKoaRouter(pkg)) continue;
    const projectRoot = path.dirname(pkgFile);
    const files = sourceFiles(projectRoot);
    const live = files.some((file) => {
      try {
        const text = fs.readFileSync(file, 'utf8');
        const result = scanFile(file, text);
        return result.hasRouterImport && result.hasRouterInstance;
      } catch { return false; }
    });
    if (live) return { projectRoot, packageFile: pkgFile };
  }
  return null;
}

export function scanKoaRouter(repoRoot, detection = detectKoaRouterRoot(repoRoot)) {
  if (!detection) return { modules: [], filesRead: [], scanNotes: ['@koa/router was not detected.'] };
  const files = sourceFiles(detection.projectRoot);
  const controllers = [];
  const notes = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const result = scanFile(file, text);
    controllers.push(...result.controllers);
    notes.push(...result.notes);
  }
  const packageName = readJson(detection.packageFile)?.name || path.basename(detection.projectRoot) || '_koa';
  return {
    modules: controllers.length
      ? [{ module: packageName, controllers, entities: [], enums: [], dtos: [] }]
      : [],
    filesRead: [detection.packageFile, ...files].map((file) => path.relative(repoRoot, file)).sort(),
    scanNotes: [...new Set([
      'T13 Koa/@koa-router first slice: literal standard-method routes and literal constructor prefixes are emitted; routers using prefix() mutation are withheld, while all(), use()/nested routers, RegExp paths, host constraints and runtime middleware semantics remain unknown.',
      ...notes,
    ])],
    apiSurfaceSource: '@koa/router source literals only (T13 experimental leaf; operationId/schema/security/runtime semantics are not inferred)',
  };
}

export const adapter = {
  contract: 'sbf.adapter/2',
  id: 'node-koa',
  title: 'Koa + @koa/router HTTP routes (T13 experimental leaf)',
  specificity: 54,
  confidence: 'high',
  verificationBasis: 'synthetic-only',
  capabilities: {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  },
  detect(repoRoot) { return detectKoaRouterRoot(repoRoot); },
  scan(repoRoot, detection) { return scanKoaRouter(repoRoot, detection); },
  listReadSet(repoRoot, detection = detectKoaRouterRoot(repoRoot)) {
    return detection ? scanKoaRouter(repoRoot, detection).filesRead : [];
  },
  diagnostics(repoRoot) {
    const detection = detectKoaRouterRoot(repoRoot);
    return detection
      ? [{ level: 'info', code: 't13-experimental-koa-router', message: '@koa/router detected by dependency + live Router source signal. This leaf is not registered in the production scanner registry yet.' }]
      : [{ level: 'info', code: 'koa-router-not-detected', message: 'no package declaring @koa/router with supported literal Router routes was found' }];
  },
};
