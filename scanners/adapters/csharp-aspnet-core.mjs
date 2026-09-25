import fs from 'node:fs';
import path from 'node:path';
import { lineNumberAt, listRgFiles as sharedListRgFiles, byShallowestThenName, binaryAvailable } from '../text-util.mjs';

const EXCLUDE_GLOBS = ['!**/bin/**', '!**/obj/**', '!**/node_modules/**', '!**/.git/**'];
const HTTP_ATTRS = new Map([
  ['HttpGet', 'GET'], ['HttpPost', 'POST'], ['HttpPut', 'PUT'], ['HttpPatch', 'PATCH'],
  ['HttpDelete', 'DELETE'], ['HttpHead', 'HEAD'], ['HttpOptions', 'OPTIONS'],
]);
const MINIMAL_MAPS = new Map([
  ['MapGet', 'GET'], ['MapPost', 'POST'], ['MapPut', 'PUT'], ['MapPatch', 'PATCH'], ['MapDelete', 'DELETE'],
]);

function listFiles(dir, globs) { return sharedListRgFiles(dir, globs, EXCLUDE_GLOBS); }
function listProjectFiles(repoRoot) { return listFiles(repoRoot, ['*.csproj']).sort(byShallowestThenName); }
function listCSharpFiles(projectRoot) { return listFiles(projectRoot, ['*.cs']); }

function isAspNetProject(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return /<Project\b[^>]*Sdk\s*=\s*["']Microsoft\.NET\.Sdk\.Web["']/i.test(text) ||
      /<FrameworkReference\b[^>]*Include\s*=\s*["']Microsoft\.AspNetCore\.App["']/i.test(text);
  } catch { return false; }
}

function sourceConfirmsAspNet(file) {
  try {
    const text = maskCSharpComments(fs.readFileSync(file, 'utf8'));
    return /\bWebApplication\.CreateBuilder\s*\(/.test(text) ||
      /\bControllerBase\b/.test(text) || /\[\s*ApiController\s*\]/.test(text);
  } catch { return false; }
}

export function detectCSharpAspNetCoreRoot(repoRoot) {
  for (const projectFile of listProjectFiles(repoRoot)) {
    if (!isAspNetProject(projectFile)) continue;
    const projectRoot = path.dirname(projectFile);
    if (listCSharpFiles(projectRoot).some(sourceConfirmsAspNet)) return projectRoot;
  }
  return null;
}

function maskCSharpComments(text) {
  const out = text.split('');
  let i = 0, quote = null, verbatim = false;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (!verbatim && ch === '\\') { i += 2; continue; }
      if (verbatim && ch === '"' && text[i + 1] === '"') { i += 2; continue; }
      if (ch === quote) { quote = null; verbatim = false; }
      i++; continue;
    }
    if (ch === '@' && text[i + 1] === '"') { quote = '"'; verbatim = true; i += 2; continue; }
    if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
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

function matchBalanced(text, openIndex, openChar, closeChar) {
  let depth = 0, quote = null, verbatim = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (!verbatim && ch === '\\') { i++; continue; }
      if (verbatim && ch === '"' && text[i + 1] === '"') { i++; continue; }
      if (ch === quote) { quote = null; verbatim = false; }
      continue;
    }
    if (ch === '@' && text[i + 1] === '"') { quote = '"'; verbatim = true; i++; continue; }
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

function literalString(text) {
  const m = text?.trim().match(/^@?"([^"]*)"$/);
  return m ? m[1] : null;
}

function splitTopLevel(text) {
  const parts = [];
  let start = 0, quote = null, verbatim = false;
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (!verbatim && ch === '\\') { i++; continue; }
      if (verbatim && ch === '"' && text[i + 1] === '"') { i++; continue; }
      if (ch === quote) { quote = null; verbatim = false; }
      continue;
    }
    if (ch === '@' && text[i + 1] === '"') { quote = '"'; verbatim = true; i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if ('([{'.includes(ch)) stack.push(ch);
    else if (')]}'.includes(ch)) stack.pop();
    else if (ch === ',' && stack.length === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function joinPath(base, segment) {
  const b = (base || '').replace(/\/$/, '');
  const s = (segment || '').replace(/^\//, '');
  return s ? b + '/' + s : (b || '/');
}

function absoluteOrJoined(base, segment) {
  if (segment == null || segment === '') return joinPath(base, '');
  if (segment.startsWith('~/')) return '/' + segment.slice(2);
  if (segment.startsWith('/')) return segment;
  return joinPath(base, segment);
}

function replaceRouteTokens(template, controllerName, actionName = '') {
  return template.replace(/\[controller\]/gi, controllerName).replace(/\[action\]/gi, actionName);
}

function attributeBlockBefore(text, start) {
  const prefix = text.slice(Math.max(0, start - 2500), start);
  const m = prefix.match(/((?:\s*\[[^\]\r\n]+\]\s*)*)$/);
  return m ? m[1] : '';
}

function routeAttribute(attrs) {
  const m = attrs.match(/\[\s*Route\s*\(\s*(@?"[^"]*")\s*\)\s*\]/i);
  return m ? literalString(m[1]) : null;
}

function skipAttributes(text, start) {
  let pos = start;
  while (pos < text.length) {
    while (/\s/.test(text[pos] ?? '')) pos++;
    if (text[pos] !== '[') return pos;
    const close = text.indexOf(']', pos + 1);
    if (close === -1) return null;
    pos = close + 1;
  }
  return pos;
}

function methodNameAfter(text, start) {
  const pos = skipAttributes(text, start);
  if (pos == null) return null;
  const rest = text.slice(pos, pos + 1000);
  const m = rest.match(/^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|new|extern)\s+)*(?:[A-Za-z_][\w<>\[\],?.]*\s+)+([A-Za-z_]\w*)\s*\(/);
  return m ? m[1] : null;
}

function controllerRoutes(text, file, mapControllersEnabled) {
  if (!mapControllersEnabled) return [];
  const entries = [];
  const classRe = /\b(?:public\s+|internal\s+)?class\s+([A-Za-z_]\w*Controller)\s*:\s*([^{\r\n]+)/g;

  for (const cm of text.matchAll(classRe)) {
    if (!/\b(?:ControllerBase|Controller)\b/.test(cm[2])) continue;
    const attrs = attributeBlockBefore(text, cm.index);
    const controllerName = cm[1].replace(/Controller$/, '');
    const classTemplate = routeAttribute(attrs);
    const basePath = replaceRouteTokens(classTemplate ?? '', controllerName);

    const bodyOpen = text.indexOf('{', cm.index + cm[0].length);
    if (bodyOpen === -1) continue;
    const bodyClose = matchBalancedBraces(text, bodyOpen);
    if (bodyClose === -1) continue;
    const body = text.slice(bodyOpen + 1, bodyClose);
    const endpoints = [];

    const attrRe = /\[\s*(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|HttpHead|HttpOptions)\s*(?:\(([^)]*)\))?\s*\]/g;
    for (const am of body.matchAll(attrRe)) {
      const method = methodNameAfter(body, am.index + am[0].length);
      if (!method) continue;
      const verb = HTTP_ATTRS.get(am[1]);
      const args = am[2]?.trim() ?? '';
      let actionTemplate = '';
      if (args) {
        const value = literalString(splitTopLevel(args)[0]);
        if (value == null) continue;
        actionTemplate = value;
      } else {
        // Official ASP.NET samples also place [Route("...")] on the action next to a
        // parameterless [HttpGet]. Accept a single literal Route attribute in that same
        // contiguous method-attribute cluster without interpreting unrelated metadata.
        const beforeRoute = routeAttribute(attributeBlockBefore(body, am.index));
        const afterStart = am.index + am[0].length;
        const afterEnd = skipAttributes(body, afterStart);
        const afterRoute = afterEnd == null ? null : routeAttribute(body.slice(afterStart, afterEnd));
        actionTemplate = afterRoute ?? beforeRoute ?? '';
      }
      actionTemplate = replaceRouteTokens(actionTemplate, controllerName, method);
      endpoints.push({
        verb,
        path: absoluteOrJoined(basePath, actionTemplate),
        operationId: null,
        method,
        line: lineNumberAt(text, bodyOpen + 1 + am.index),
      });
    }

    if (endpoints.length > 0) {
      entries.push({
        module: controllerName.charAt(0).toLowerCase() + controllerName.slice(1),
        controller: {
          className: cm[1],
          basePath: basePath ? joinPath('', basePath) : '',
          operationIds: [],
          endpoints,
          file,
        },
      });
    }
  }
  return entries;
}

function minimalApiBindings(text) {
  const groups = new Map(), apps = new Set();
  for (const m of text.matchAll(/\bvar\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.Build\s*\(\s*\)\s*;/g)) apps.add(m[1]);

  let changed = true;
  while (changed) {
    changed = false;
    const groupRe = /\b(?:var|RouteGroupBuilder)\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.MapGroup\s*\(\s*(@?"[^"]*")\s*\)/g;
    for (const m of text.matchAll(groupRe)) {
      if (groups.has(m[1])) continue;
      const prefix = literalString(m[3]);
      if (prefix == null) continue;
      if (apps.has(m[2])) { groups.set(m[1], prefix); changed = true; }
      else if (groups.has(m[2])) { groups.set(m[1], joinPath(groups.get(m[2]), prefix)); changed = true; }
    }
  }
  return { apps, groups };
}

function handlerName(expr) {
  const text = expr?.trim() ?? '';
  if (/^[A-Za-z_]\w*$/.test(text)) return text;
  if (/^(?:async\s+)?\([^)]*\)\s*=>/.test(text)) return null;
  if (/^(?:async\s+)?[A-Za-z_]\w*\s*=>/.test(text)) return null;
  return undefined;
}

function minimalApiRoutes(text, file) {
  const { apps, groups } = minimalApiBindings(text);
  const receivers = [...apps, ...groups.keys()].sort();
  if (receivers.length === 0) return [];

  const escape = (x) => x.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
  const re = new RegExp('\\b(' + receivers.map(escape).join('|') + ')\\.(MapGet|MapPost|MapPut|MapPatch|MapDelete)\\s*\\(', 'g');
  const entries = new Map();

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
    if (!entries.has(key)) {
      entries.set(key, {
        module: m[1],
        controller: {
          className: String(m[1]) + 'MinimalApiRoutes',
          basePath: prefix,
          operationIds: [],
          endpoints: [],
          file,
        },
      });
    }
    entries.get(key).controller.endpoints.push({
      verb: MINIMAL_MAPS.get(m[2]),
      path: joinPath(prefix, routePath),
      operationId: null,
      method,
      line: lineNumberAt(text, m.index),
    });
  }
  return [...entries.values()];
}

const API_SURFACE_SOURCE =
  'ASP.NET Core static discovery: attribute-routed controllers behind MapControllers(), plus ' +
  'literal Minimal API MapGroup/MapGet/MapPost/MapPut/MapPatch/MapDelete calls. Conventional ' +
  'MapControllerRoute patterns, dynamic templates, endpoint filters, authorization enforcement, ' +
  'parameter/model binding and runtime metadata are not inferred.';

export function scanCSharpAspNetCore(repoRoot, projectRoot) {
  const files = listCSharpFiles(projectRoot);
  const texts = new Map();
  let mapControllersEnabled = false;
  for (const file of files) {
    let text = '';
    try { text = maskCSharpComments(fs.readFileSync(file, 'utf8')); } catch {}
    texts.set(file, text);
    if (/\.MapControllers\s*\(\s*\)/.test(text)) mapControllersEnabled = true;
  }

  const modules = new Map();
  const add = (entry) => {
    if (!modules.has(entry.module)) modules.set(entry.module, { module: entry.module, controllers: [], entities: [], enums: [], dtos: [] });
    modules.get(entry.module).controllers.push(entry.controller);
  };

  for (const file of files) {
    const text = texts.get(file);
    for (const entry of controllerRoutes(text, file, mapControllersEnabled)) add(entry);
    for (const entry of minimalApiRoutes(text, file)) add(entry);
  }

  const projectFiles = listProjectFiles(repoRoot).filter((f) => path.dirname(f) === projectRoot);
  return {
    modules: [...modules.values()].sort((a, b) => a.module.localeCompare(b.module)),
    pathPrefixSignals: [],
    apiSurfaceSource: API_SURFACE_SOURCE,
    filesRead: [...projectFiles, ...files].map((f) => path.relative(repoRoot, f)).sort(),
  };
}

function diagnostics(repoRoot) {
  const messages = [];
  const projectFiles = listProjectFiles(repoRoot);
  if (projectFiles.length === 0) messages.push({ level: 'info', code: 'no-csproj', message: 'no .csproj file found' });
  else if (!projectFiles.some(isAspNetProject)) messages.push({ level: 'info', code: 'aspnet-web-sdk-not-found', message: 'C# projects were found, but none use Microsoft.NET.Sdk.Web or reference Microsoft.AspNetCore.App' });
  if (!binaryAvailable('rg')) messages.push({ level: 'warn', code: 'rg-missing', message: 'ripgrep (rg) is not on PATH -- this adapter uses it for bounded file discovery and will not detect without it' });
  messages.push({ level: 'info', code: 'aspnet-static-slice-limit', message: 'Conventional routing, dynamic route templates, endpoint metadata, auth enforcement and model binding are intentionally unresolved in this first static slice.' });
  return messages;
}

export const adapter = {
  contract: 'sbf.adapter/2',
  id: 'csharp-aspnet-core',
  title: 'C# / ASP.NET Core',
  specificity: 91,
  confidence: 'high',
  verificationBasis: 'synthetic-only',
  capabilities: {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  },
  detect: detectCSharpAspNetCoreRoot,
  scan(repoRoot, detection) { return scanCSharpAspNetCore(repoRoot, detection); },
  listReadSet(repoRoot) {
    const projectRoot = detectCSharpAspNetCoreRoot(repoRoot);
    if (!projectRoot) return [];
    const projectFiles = listProjectFiles(repoRoot).filter((f) => path.dirname(f) === projectRoot);
    return [...projectFiles, ...listCSharpFiles(projectRoot)].map((f) => path.relative(repoRoot, f)).sort();
  },
  diagnostics,
};
