import fs from 'node:fs';
import path from 'node:path';
import {
  maskJsComments,
  matchBalancedParens,
  splitTopLevelArgs,
  joinPath,
} from '../../../scanners/adapters/_express-shared.mjs';
import { lineNumberAt } from '../../../scanners/text-util.mjs';

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.git', 'coverage']);
const ROUTE_METHODS = new Map([
  ['get', 'GET'],
  ['post', 'POST'],
  ['put', 'PUT'],
  ['patch', 'PATCH'],
  ['delete', 'DELETE'],
  ['del', 'DELETE'],
  ['head', 'HEAD'],
  ['options', 'OPTIONS'],
  ['connect', 'CONNECT'],
  ['trace', 'TRACE'],
]);

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

function declaresDependency(pkg, name) {
  return Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name] || pkg?.peerDependencies?.[name]);
}

function packageCandidates(repoRoot) {
  return listFilesRecursive(repoRoot)
    .filter((file) => path.basename(file) === 'package.json')
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
}

function sourceFiles(projectRoot) {
  return listFilesRecursive(projectRoot)
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
    .sort();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultImportBindings(masked, moduleName) {
  const out = new Set();
  const escaped = escapeRegExp(moduleName);
  const fromRe = new RegExp("\\bfrom\\s*['\"]" + escaped + "['\"]", 'g');
  for (const match of masked.matchAll(fromRe)) {
    const before = masked.slice(Math.max(0, match.index - 500), match.index);
    const imports = [...before.matchAll(/\bimport\b/g)];
    if (imports.length === 0) continue;
    const keyword = imports.at(-1);
    const clause = before.slice(keyword.index + 'import'.length).replace(/\s+/g, ' ').trim();
    if (clause.startsWith('{') || clause.startsWith('*')) continue;
    const comma = clause.indexOf(',');
    const local = (comma === -1 ? clause : clause.slice(0, comma)).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(local)) out.add(local);
  }
  return out;
}

function requireBindings(masked, moduleName) {
  const out = new Set();
  const escaped = escapeRegExp(moduleName);
  const re = new RegExp("\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*require\\s*\\(\\s*['\"]" + escaped + "['\"]\\s*\\)", 'g');
  for (const match of masked.matchAll(re)) out.add(match[1]);
  return out;
}

function moduleBindings(masked, moduleName) {
  return new Set([...defaultImportBindings(masked, moduleName), ...requireBindings(masked, moduleName)]);
}

function parseLiteral(value) {
  const trimmed = value.trim();
  const match = trimmed.match(/^(['"`])([\s\S]*)\1$/);
  if (!match) return null;
  if (match[1] === '`' && match[2].includes('${')) return null;
  return match[2];
}

function findConstructors(masked, bindingNames) {
  const out = new Map();
  for (const binding of bindingNames) {
    const escaped = escapeRegExp(binding);
    const re = new RegExp(
      "\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+" + escaped +
      "(?:\\s*<[^>\\n]{1,500}>)?\\s*\\(",
      'g',
    );
    for (const match of masked.matchAll(re)) {
      const openIndex = masked.indexOf('(', match.index + match[0].lastIndexOf('('));
      const closeIndex = matchBalancedParens(masked, openIndex);
      if (openIndex === -1 || closeIndex === -1) continue;
      out.set(match[1], {
        name: match[1],
        declarationIndex: match.index,
        args: masked.slice(openIndex + 1, closeIndex),
      });
    }
  }
  return out;
}

function parseRouterOptions(args) {
  const trimmed = args.trim();
  if (!trimmed) return { prefix: '', blocked: false, notes: [] };
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    return {
      prefix: '',
      blocked: true,
      notes: ['Router constructor arguments are non-object/dynamic; first-slice route semantics are withheld.'],
    };
  }

  const notes = [];
  let prefix = '';
  const prefixKey = /\bprefix\s*:/.test(trimmed);
  const prefixMatch = trimmed.match(/\bprefix\s*:\s*(['"`])([^'"`]*)\1/);
  if (prefixKey && (!prefixMatch || (prefixMatch[1] === '`' && prefixMatch[2].includes('${')))) {
    return {
      prefix: '',
      blocked: true,
      notes: ['Router constructor prefix is non-literal; absolute paths are unknown.'],
    };
  }
  if (prefixMatch) prefix = prefixMatch[2];

  const unsupportedKeys = ['host', 'methods', 'sensitive', 'strict'];
  const present = unsupportedKeys.filter((key) => new RegExp('\\b' + key + '\\s*:').test(trimmed));
  if (present.length > 0) {
    return {
      prefix,
      blocked: true,
      notes: [`Router constructor option(s) ${present.join(', ')} affect matching semantics and are not modeled by the first slice.`],
    };
  }
  if (/\bexclusive\s*:/.test(trimmed)) {
    notes.push('Router constructor option exclusive affects match arbitration; route discovery keeps the route declarations but does not model arbitration.');
  }
  return { prefix, blocked: false, notes };
}

function routeCalls(masked, routerName) {
  const escaped = escapeRegExp(routerName);
  const methods = [...ROUTE_METHODS.keys()].join('|');
  const re = new RegExp('\\b' + escaped + '\\s*\\.\\s*(' + methods + ')\\s*\\(', 'gi');
  const calls = [];
  for (const match of masked.matchAll(re)) {
    const openIndex = masked.indexOf('(', match.index + match[0].lastIndexOf('('));
    const closeIndex = matchBalancedParens(masked, openIndex);
    if (openIndex === -1 || closeIndex === -1) continue;
    calls.push({
      index: match.index,
      line: lineNumberAt(masked, match.index),
      method: match[1].toLowerCase(),
      args: splitTopLevelArgs(masked.slice(openIndex + 1, closeIndex)),
    });
  }
  return calls;
}

function parseRouteCall(call, prefix) {
  const args = call.args;
  if (args.length < 2) return { endpoint: null, reason: 'too few route arguments' };

  const first = parseLiteral(args[0]);
  const second = args.length > 1 ? parseLiteral(args[1]) : null;
  let routePath = null;
  if (first !== null && first.startsWith('/')) {
    routePath = first;
  } else if (first !== null && second !== null && second.startsWith('/')) {
    routePath = second; // named route: name, path, ...middleware
  }
  if (routePath === null) {
    return { endpoint: null, reason: 'path is non-literal, array/RegExp, or otherwise outside the first slice' };
  }

  const last = args.at(-1)?.trim() ?? '';
  const handler = /^[A-Za-z_$][\w$]*$/.test(last) ? last : null;
  return {
    endpoint: {
      verb: ROUTE_METHODS.get(call.method),
      path: joinPath(prefix, routePath),
      operationId: null,
      method: handler,
      line: call.line,
    },
    reason: null,
  };
}

function hasRouterPrefixMutation(masked, routerName) {
  const escaped = escapeRegExp(routerName);
  return new RegExp('\\b' + escaped + '\\s*\\.\\s*prefix\\s*\\(', 'g').test(masked);
}

function appUsesRouter(masked, appNames, routerName) {
  const router = escapeRegExp(routerName);
  for (const appName of appNames) {
    const app = escapeRegExp(appName);
    const re = new RegExp('\\b' + app + '\\s*\\.\\s*use\\s*\\(\\s*' + router + '\\s*\\.\\s*routes\\s*\\(\\s*\\)\\s*\\)', 'g');
    if (re.test(masked)) return true;
  }
  return false;
}

function unsupportedRouterNotes(masked, routerName, file) {
  const notes = [];
  const escaped = escapeRegExp(routerName);
  const patterns = [
    ['all', 'router.all() represents all HTTP methods and is not emitted by the first slice.'],
    ['use', 'router.use() may mount middleware or nested routers and is observed but not expanded by the first slice.'],
    ['register', 'router.register() is a lower-level route API and is observed but not emitted by the first slice.'],
    ['redirect', 'router.redirect() creates routing behavior and is observed but not emitted by the first slice.'],
  ];
  for (const [method, message] of patterns) {
    const re = new RegExp('\\b' + escaped + '\\s*\\.\\s*' + method + '\\s*\\(', 'g');
    for (const match of masked.matchAll(re)) {
      notes.push(`${path.basename(file)}:${lineNumberAt(masked, match.index)} ${message}`);
    }
  }
  return notes;
}

function commonPathPrefix(paths) {
  if (paths.length === 0) return '/';
  const segments = paths.map((value) => value.split('/').filter(Boolean));
  const min = Math.min(...segments.map((value) => value.length));
  const shared = [];
  for (let i = 0; i < min; i++) {
    if (segments.every((value) => value[i] === segments[0][i])) shared.push(segments[0][i]);
    else break;
  }
  return shared.length ? '/' + shared.join('/') : '/';
}

function analyzeFile(file, text) {
  const masked = maskJsComments(text);
  const koaBindings = moduleBindings(masked, 'koa');
  const routerBindings = moduleBindings(masked, '@koa/router');
  if (koaBindings.size === 0 || routerBindings.size === 0) {
    return { controllers: [], notes: [], detected: false };
  }

  const apps = findConstructors(masked, koaBindings);
  const routers = findConstructors(masked, routerBindings);
  if (apps.size === 0 || routers.size === 0) {
    return { controllers: [], notes: [], detected: false };
  }

  const notes = [];
  const controllers = [];
  for (const router of routers.values()) {
    const options = parseRouterOptions(router.args);
    notes.push(...options.notes.map((note) => `${path.basename(file)}: ${router.name}: ${note}`));
    notes.push(...unsupportedRouterNotes(masked, router.name, file));

    if (!appUsesRouter(masked, apps.keys(), router.name)) {
      notes.push(`${path.basename(file)}: router ${router.name} defines/contains routes but no same-file Koa app mounts ${router.name}.routes(); routes are withheld.`);
      continue;
    }
    if (hasRouterPrefixMutation(masked, router.name)) {
      notes.push(`${path.basename(file)}: router ${router.name} calls prefix(); this mutation can affect existing routes, so all first-slice endpoints for this router are withheld.`);
      continue;
    }
    if (options.blocked) continue;

    const endpoints = [];
    for (const call of routeCalls(masked, router.name)) {
      const parsed = parseRouteCall(call, options.prefix);
      if (parsed.endpoint) endpoints.push(parsed.endpoint);
      else notes.push(`${path.basename(file)}:${call.line} ${router.name}.${call.method}() not emitted: ${parsed.reason}.`);
    }
    if (endpoints.length === 0) continue;

    controllers.push({
      className: `KoaRouter(${path.basename(file)}:${router.name})`,
      basePath: commonPathPrefix(endpoints.map((endpoint) => endpoint.path)),
      operationIds: [],
      endpoints,
      file,
    });
  }

  return { controllers, notes, detected: true };
}

export function detectKoaRouterRoot(repoRoot) {
  for (const packageFile of packageCandidates(repoRoot)) {
    const pkg = readJson(packageFile);
    if (!declaresDependency(pkg, 'koa') || !declaresDependency(pkg, '@koa/router')) continue;
    const projectRoot = path.dirname(packageFile);
    const detected = sourceFiles(projectRoot).some((file) => {
      try {
        const result = analyzeFile(file, fs.readFileSync(file, 'utf8'));
        return result.detected;
      } catch {
        return false;
      }
    });
    if (detected) return { projectRoot, packageFile };
  }
  return null;
}

export function scanKoaRouter(repoRoot, detection = detectKoaRouterRoot(repoRoot)) {
  if (!detection) return { modules: [], filesRead: [], scanNotes: ['Koa + @koa/router was not detected.'] };
  const files = sourceFiles(detection.projectRoot);
  const controllers = [];
  const scanNotes = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const result = analyzeFile(file, text);
    controllers.push(...result.controllers);
    scanNotes.push(...result.notes);
  }

  const packageName = readJson(detection.packageFile)?.name || path.basename(detection.projectRoot) || '_koa';
  const filesRead = [detection.packageFile, ...files]
    .map((file) => path.relative(repoRoot, file))
    .sort();

  return {
    modules: controllers.length > 0
      ? [{ module: packageName, controllers, entities: [], enums: [], dtos: [] }]
      : [],
    filesRead,
    scanNotes: [
      'T13 Koa first slice: only same-file @koa/router instances actually mounted via app.use(router.routes()) are emitted; constructor literal prefix is supported, while prefix() mutation, nested router.use(), all/register/redirect, dynamic/array/RegExp paths and unsupported matching options remain unknown.',
      ...[...new Set(scanNotes)],
    ],
    apiSurfaceSource: 'Koa + @koa/router same-file source literals only (T13 experimental leaf; operationId/schema/security/runtime semantics are not inferred)',
  };
}

export const adapter = {
  contract: 'sbf.adapter/2',
  id: 'node-koa',
  title: 'Koa + @koa/router routes (T13 experimental leaf)',
  specificity: 54,
  confidence: 'high',
  verificationBasis: 'synthetic-only',
  capabilities: {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  },
  detect(repoRoot) {
    return detectKoaRouterRoot(repoRoot);
  },
  scan(repoRoot, detection) {
    return scanKoaRouter(repoRoot, detection);
  },
  listReadSet(repoRoot, detection = detectKoaRouterRoot(repoRoot)) {
    return detection ? scanKoaRouter(repoRoot, detection).filesRead : [];
  },
  diagnostics(repoRoot) {
    const detection = detectKoaRouterRoot(repoRoot);
    return detection
      ? [{
          level: 'info',
          code: 't13-experimental-koa-router',
          message: 'Koa + @koa/router detected from dependencies and live same-file constructor signals. This leaf is not registered in the production scanner registry yet.',
        }]
      : [{
          level: 'info',
          code: 'koa-router-not-detected',
          message: 'no project declaring koa + @koa/router with live local app/router constructor signals was found',
        }];
  },
};
