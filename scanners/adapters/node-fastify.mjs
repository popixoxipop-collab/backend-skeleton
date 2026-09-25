import fs from 'node:fs';
import path from 'node:path';
import { lineNumberAt, listRgFiles, byShallowestThenName, binaryAvailable } from '../text-util.mjs';
import { maskJsComments, matchBalancedParens, joinPath } from './_express-shared.mjs';

const EXCLUDE_GLOBS = [
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/coverage/**',
  '!**/*.d.ts',
];
const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function listFiles(dir, globs) {
  return listRgFiles(dir, globs, EXCLUDE_GLOBS);
}

function listPackageFiles(repoRoot) {
  return listFiles(repoRoot, ['package.json']).sort(byShallowestThenName);
}

function listSourceFiles(projectRoot) {
  return listFiles(projectRoot, ['*.js', '*.mjs', '*.cjs', '*.ts', '*.tsx']);
}

function readPackageJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function declaresFastify(file) {
  const pkg = readPackageJson(file);
  return Boolean(pkg?.dependencies?.fastify || pkg?.devDependencies?.fastify);
}

function sourceConfirmsFastify(file) {
  try {
    const text = maskJsComments(fs.readFileSync(file, 'utf8'));
    const importsFastify =
      /from\s*['"]fastify['"]/.test(text) ||
      /require\s*\(\s*['"]fastify['"]\s*\)/.test(text);
    const usesFastifySurface =
      /\.(?:get|post|put|patch|delete|head|options|route|register)\s*\(/.test(text) ||
      /\bFastify\s*\(/.test(text);
    return importsFastify && usesFastifySurface;
  } catch {
    return false;
  }
}

export function detectNodeFastifyRoot(repoRoot) {
  for (const packageFile of listPackageFiles(repoRoot)) {
    if (!declaresFastify(packageFile)) continue;
    const projectRoot = path.dirname(packageFile);
    if (listSourceFiles(projectRoot).some(sourceConfirmsFastify)) return projectRoot;
  }
  return null;
}

function escapeRegex(s) {
  return s.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
}

function literalString(text) {
  const m = text.trim().match(/^['"`]([^'"`]*)['"`]$/);
  return m ? m[1] : null;
}

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
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if ('([{'.includes(ch)) { stack.push(ch); continue; }
    if (')]}'.includes(ch)) { stack.pop(); continue; }
    if (ch === ',' && stack.length === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function matchBalancedBraces(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function receiverNames(text) {
  const names = new Set();
  const factories = new Set();

  for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]fastify['"]/g)) factories.add(m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]fastify['"]\s*\)/g)) factories.add(m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]fastify['"]\s*\)\s*\(/g)) names.add(m[1]);

  for (const factory of factories) {
    const re = new RegExp('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*' + escapeRegex(factory) + '\\s*\\(', 'g');
    for (const m of text.matchAll(re)) names.add(m[1]);
  }

  for (const m of text.matchAll(/(?:export\s+default\s+)?(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/module\.exports\s*=\s*(?:async\s+)?function\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:[^=\n]+)?\s*=\s*(?:async\s+)?\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);

  return [...names].sort();
}

function handlerName(expr) {
  const text = expr?.trim() ?? '';
  if (/^[A-Za-z_$][\w$]*$/.test(text)) return text;
  if (/^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(text)) return null;
  if (/^(?:async\s+)?function\b/.test(text)) return null;
  return undefined;
}

function extractShorthandEndpoints(text, receivers) {
  const endpoints = [];
  if (receivers.length === 0) return endpoints;
  const re = new RegExp('\\b(' + receivers.map(escapeRegex).join('|') + ')\\.(' + VERBS.join('|') + ')\\s*\\(', 'gi');

  for (const m of text.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    const close = matchBalancedParens(text, open);
    if (close === -1) continue;
    const args = splitTopLevel(text.slice(open + 1, close));
    if (args.length < 2) continue;
    const routePath = literalString(args[0]);
    if (routePath === null) continue;
    const method = handlerName(args[args.length - 1]);
    if (method === undefined) continue;

    endpoints.push({
      verb: m[2].toUpperCase(),
      path: routePath,
      operationId: null,
      method,
      line: lineNumberAt(text, m.index),
    });
  }
  return endpoints;
}

function objectField(objectText, field) {
  for (const part of splitTopLevel(objectText)) {
    const m = part.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/);
    if (m && m[1] === field) return m[2].trim();
  }
  return null;
}

function extractRouteObjectEndpoints(text, receivers) {
  const endpoints = [];
  if (receivers.length === 0) return endpoints;
  const re = new RegExp('\\b(' + receivers.map(escapeRegex).join('|') + ')\\.route\\s*\\(', 'g');

  for (const m of text.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    const close = matchBalancedParens(text, open);
    if (close === -1) continue;
    const args = splitTopLevel(text.slice(open + 1, close));
    if (args.length !== 1) continue;
    const obj = args[0].trim();
    if (!obj.startsWith('{')) continue;
    const braceClose = matchBalancedBraces(obj, 0);
    if (braceClose !== obj.length - 1) continue;

    const methodRaw = objectField(obj.slice(1, -1), 'method');
    const urlRaw = objectField(obj.slice(1, -1), 'url');
    const handlerRaw = objectField(obj.slice(1, -1), 'handler');
    const methodLiteral = methodRaw ? literalString(methodRaw) : null;
    const routePath = urlRaw ? literalString(urlRaw) : null;
    const method = handlerName(handlerRaw);
    if (!methodLiteral || routePath === null || method === undefined) continue;
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(methodLiteral)) continue;

    endpoints.push({
      verb: methodLiteral.toUpperCase(),
      path: routePath,
      operationId: null,
      method,
      line: lineNumberAt(text, m.index),
    });
  }
  return endpoints;
}

function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const probes = [base];

  if (path.extname(base)) {
    const ext = path.extname(base);
    const stem = base.slice(0, -ext.length);
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') probes.push(stem + '.ts', stem + '.tsx');
  } else {
    probes.push(
      base + '.js', base + '.mjs', base + '.cjs', base + '.ts', base + '.tsx',
      path.join(base, 'index.js'), path.join(base, 'index.mjs'), path.join(base, 'index.cjs'),
      path.join(base, 'index.ts'), path.join(base, 'index.tsx'),
    );
  }

  return probes.find((p) => fs.existsSync(p)) ?? null;
}

function importedPlugins(text, file) {
  const map = new Map();
  for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g)) {
    const resolved = resolveRelativeImport(file, m[2]);
    if (resolved) map.set(m[1], resolved);
  }
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const resolved = resolveRelativeImport(file, m[2]);
    if (resolved) map.set(m[1], resolved);
  }
  return map;
}

function prefixFromOptions(expr) {
  if (expr == null) return { known: true, prefix: '' };
  const text = expr.trim();
  if (!text.startsWith('{')) return { known: false, prefix: null };
  const close = matchBalancedBraces(text, 0);
  if (close !== text.length - 1) return { known: false, prefix: null };
  const raw = objectField(text.slice(1, -1), 'prefix');
  if (raw == null) return { known: true, prefix: '' };
  const prefix = literalString(raw);
  return prefix === null ? { known: false, prefix: null } : { known: true, prefix };
}

function pluginTarget(expr, imports, fromFile) {
  const text = expr.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(text)) return imports.get(text) ?? null;
  const m = text.match(/^require\s*\(\s*['"]([^'"]+)['"]\s*\)$/);
  return m ? resolveRelativeImport(fromFile, m[1]) : null;
}

function buildRegisterGraph(files, texts) {
  const edges = [];
  const unknownMounts = new Set();

  for (const file of files) {
    const text = texts.get(file);
    const receivers = receiverNames(text);
    if (receivers.length === 0) continue;
    const imports = importedPlugins(text, file);
    const re = new RegExp('\\b(' + receivers.map(escapeRegex).join('|') + ')\\.register\\s*\\(', 'g');

    for (const m of text.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      const close = matchBalancedParens(text, open);
      if (close === -1) continue;
      const args = splitTopLevel(text.slice(open + 1, close));
      if (args.length === 0) continue;

      const toFile = pluginTarget(args[0], imports, file);
      if (!toFile || !files.includes(toFile)) continue;

      const prefix = prefixFromOptions(args[1]);
      if (!prefix.known) {
        unknownMounts.add(toFile);
        continue;
      }
      edges.push({ fromFile: file, toFile, prefix: prefix.prefix });
    }
  }

  edges.sort((a, b) =>
    a.fromFile.localeCompare(b.fromFile) ||
    a.toFile.localeCompare(b.toFile) ||
    a.prefix.localeCompare(b.prefix)
  );
  return { edges, unknownMounts };
}

function prefixesFor(file, edges, unknownMounts, memo = new Map(), stack = new Set()) {
  if (memo.has(file)) return memo.get(file);
  if (stack.has(file)) return [];

  const incoming = edges.filter((e) => e.toFile === file);
  if (incoming.length === 0) {
    const roots = unknownMounts.has(file) ? [] : [''];
    memo.set(file, roots);
    return roots;
  }

  stack.add(file);
  const out = [];
  for (const edge of incoming) {
    for (const parentPrefix of prefixesFor(edge.fromFile, edges, unknownMounts, memo, stack)) {
      out.push(joinPath(parentPrefix, edge.prefix));
    }
  }
  stack.delete(file);
  const unique = [...new Set(out)].sort();
  memo.set(file, unique);
  return unique;
}

function moduleNameFor(file) {
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  return stem === 'index' ? path.basename(path.dirname(file)) : stem;
}

const API_SURFACE_SOURCE =
  'Fastify static discovery: literal shorthand routes and literal fastify.route({method,url}) ' +
  'objects, plus relative register(plugin,{prefix}) edges. Dynamic route URLs, dynamic prefixes, ' +
  'inline plugin factories, constraints/versioning, schemas, hooks and authorization semantics ' +
  'are not inferred. Reconcile operation/schema identity with a pinned OpenAPI artifact or an ' +
  'explicitly approved runtime route export when the application provides one.';

export function scanNodeFastify(repoRoot, projectRoot) {
  const files = listSourceFiles(projectRoot);
  const texts = new Map();
  for (const file of files) {
    try {
      texts.set(file, maskJsComments(fs.readFileSync(file, 'utf8')));
    } catch {
      texts.set(file, '');
    }
  }

  const { edges, unknownMounts } = buildRegisterGraph(files, texts);
  const prefixMemo = new Map();
  const modules = new Map();

  for (const file of files) {
    const text = texts.get(file);
    const receivers = receiverNames(text);
    const local = [
      ...extractShorthandEndpoints(text, receivers),
      ...extractRouteObjectEndpoints(text, receivers),
    ].sort((a, b) => a.line - b.line || a.verb.localeCompare(b.verb) || a.path.localeCompare(b.path));
    if (local.length === 0) continue;

    const prefixes = prefixesFor(file, edges, unknownMounts, prefixMemo);
    if (prefixes.length === 0) continue;

    const moduleName = moduleNameFor(file);
    if (!modules.has(moduleName)) {
      modules.set(moduleName, { module: moduleName, controllers: [], entities: [], enums: [], dtos: [] });
    }

    for (const prefix of prefixes) {
      modules.get(moduleName).controllers.push({
        className: moduleName + 'FastifyRoutes',
        basePath: prefix,
        operationIds: [],
        endpoints: local.map((ep) => ({ ...ep, path: joinPath(prefix, ep.path) })),
        file,
      });
    }
  }

  const packageFile = path.join(projectRoot, 'package.json');
  return {
    modules: [...modules.values()].sort((a, b) => a.module.localeCompare(b.module)),
    pathPrefixSignals: [],
    apiSurfaceSource: API_SURFACE_SOURCE,
    filesRead: [
      ...(fs.existsSync(packageFile) ? [packageFile] : []),
      ...files,
    ].map((f) => path.relative(repoRoot, f)).sort(),
  };
}

function diagnostics(repoRoot) {
  const messages = [];
  const packageFiles = listPackageFiles(repoRoot);
  if (packageFiles.length === 0) {
    messages.push({ level: 'info', code: 'no-package-json', message: 'no package.json found' });
  } else if (!packageFiles.some(declaresFastify)) {
    messages.push({ level: 'info', code: 'fastify-not-a-dependency', message: 'package.json files were found, but none declare fastify' });
  }
  if (!binaryAvailable('rg')) {
    messages.push({ level: 'warn', code: 'rg-missing', message: 'ripgrep (rg) is not on PATH -- this adapter uses it for bounded file discovery and will not detect without it' });
  }
  messages.push({
    level: 'info',
    code: 'fastify-static-slice-limit',
    message: 'This first Fastify slice does not infer schemas, hooks, constraints, auth enforcement, dynamic register prefixes or operation IDs. Supply pinned OpenAPI/runtime evidence for those claims.',
  });
  return messages;
}

export const adapter = {
  contract: 'sbf.adapter/2',
  id: 'node-fastify',
  title: 'Node.js / Fastify',
  specificity: 88,
  confidence: 'high',
  verificationBasis: 'synthetic-only',
  capabilities: {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  },
  detect: detectNodeFastifyRoot,
  scan(repoRoot, detection) {
    return scanNodeFastify(repoRoot, detection);
  },
  listReadSet(repoRoot) {
    const projectRoot = detectNodeFastifyRoot(repoRoot);
    if (!projectRoot) return [];
    const packageFile = path.join(projectRoot, 'package.json');
    return [
      ...(fs.existsSync(packageFile) ? [packageFile] : []),
      ...listSourceFiles(projectRoot),
    ].map((f) => path.relative(repoRoot, f)).sort();
  },
  diagnostics,
};
