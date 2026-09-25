import fs from 'node:fs';
import path from 'node:path';
import { lineNumberAt, listRgFiles, byShallowestThenName, binaryAvailable } from '../text-util.mjs';
import { maskJsComments, matchBalancedParens, joinPath } from './_express-shared.mjs';

// T12 Wave A: conservative NestJS HTTP discovery.
// This adapter intentionally recognizes only literal @Controller()/HTTP method decorator paths.
// Computed paths, global prefixes/versioning, request schemas, authorization enforcement and ORM
// bindings remain unknown until their dedicated reconciliation/persistence tracks supply evidence.
const EXCLUDE_GLOBS = ['!**/node_modules/**', '!**/dist/**', '!**/build/**', '!**/coverage/**'];
const METHOD_DECORATOR_RE = /@(Get|Post|Put|Patch|Delete)\s*\(/g;
const CONTROLLER_DECORATOR_RE = /@Controller\s*\(/g;
const NEST_IMPORT_RE = /import\s*\{[^}]*\bController\b[^}]*\}\s*from\s*['"]@nestjs\/common['"]/;
const NEST_PACKAGES = ['@nestjs/common', '@nestjs/core'];

function listFiles(dir, globs) {
  return listRgFiles(dir, globs, EXCLUDE_GLOBS);
}

function listPackageFiles(repoRoot) {
  return listFiles(repoRoot, ['package.json']).sort(byShallowestThenName);
}

function readPackageJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function declaresNest(file) {
  const pkg = readPackageJson(file);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  return NEST_PACKAGES.every((name) => Boolean(deps[name]));
}

function listTypeScriptFiles(projectRoot) {
  return listFiles(projectRoot, ['*.ts', '*.tsx']);
}

function sourceConfirmsNest(file) {
  try {
    const text = maskJsComments(fs.readFileSync(file, 'utf8'));
    return NEST_IMPORT_RE.test(text) && /@Controller\s*\(/.test(text);
  } catch {
    return false;
  }
}

export function detectTypeScriptNestJsRoot(repoRoot) {
  for (const packageFile of listPackageFiles(repoRoot)) {
    if (!declaresNest(packageFile)) continue;
    const projectRoot = path.dirname(packageFile);
    if (listTypeScriptFiles(projectRoot).some(sourceConfirmsNest)) return projectRoot;
  }
  return null;
}

function literalPath(argsText) {
  const text = argsText.trim();
  if (text === '') return '';
  const m = text.match(/^['"]([^'"]*)['"]$/);
  return m ? m[1] : null;
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

function moduleNameFor(className) {
  const stem = className.replace(/Controller$/, '') || className;
  return stem.charAt(0).toLowerCase() + stem.slice(1);
}

function extractEndpoints(classBody, absoluteBodyOffset, wholeText, basePath) {
  const endpoints = [];
  for (const m of classBody.matchAll(METHOD_DECORATOR_RE)) {
    const openIndex = m.index + m[0].length - 1;
    const closeIndex = matchBalancedParens(classBody, openIndex);
    if (closeIndex === -1) continue;

    const localPath = literalPath(classBody.slice(openIndex + 1, closeIndex));
    if (localPath === null) continue;

    // Deliberately require the HTTP decorator to be directly adjacent to the handler. Other
    // method decorators are not guessed through in this first slice; they are retained as unknown
    // until a syntax-aware NestJS analysis layer is available.
    const after = classBody.slice(closeIndex + 1, closeIndex + 600);
    const methodMatch = after.match(/^\s*(?:(?:public|protected|private|static|readonly)\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/);
    if (!methodMatch) continue;

    endpoints.push({
      verb: m[1].toUpperCase(),
      path: joinPath(basePath, localPath),
      operationId: null,
      method: methodMatch[1],
      line: lineNumberAt(wholeText, absoluteBodyOffset + m.index),
    });
  }
  return endpoints;
}

function extractControllers(text, file) {
  const controllers = [];
  for (const m of text.matchAll(CONTROLLER_DECORATOR_RE)) {
    const openIndex = m.index + m[0].length - 1;
    const closeIndex = matchBalancedParens(text, openIndex);
    if (closeIndex === -1) continue;

    const controllerPath = literalPath(text.slice(openIndex + 1, closeIndex));
    if (controllerPath === null) continue;

    // First slice: only a directly-adjacent class declaration is considered proof that this
    // @Controller belongs to that class. Additional stacked class decorators are intentionally
    // left for the syntax-aware follow-up instead of being crossed by regex guesswork.
    const after = text.slice(closeIndex + 1, closeIndex + 800);
    const classMatch = after.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (!classMatch) continue;

    const className = classMatch[1];
    const classDeclStart = closeIndex + 1 + classMatch.index;
    const bodyOpen = text.indexOf('{', classDeclStart + classMatch[0].length);
    if (bodyOpen === -1) continue;
    const bodyClose = matchBalancedBraces(text, bodyOpen);
    if (bodyClose === -1) continue;

    const basePath = joinPath('', controllerPath);
    const classBody = text.slice(bodyOpen + 1, bodyClose);
    const endpoints = extractEndpoints(classBody, bodyOpen + 1, text, basePath);
    controllers.push({
      module: moduleNameFor(className),
      controller: {
        className,
        basePath,
        operationIds: [],
        endpoints,
        file,
      },
    });
  }
  return controllers;
}

const API_SURFACE_SOURCE =
  'NestJS static discovery: literal @Controller(path) plus directly-adjacent literal ' +
  '@Get/@Post/@Put/@Patch/@Delete paths only. Computed paths, global prefixes, versioning, ' +
  'stacked class/method decorators, guards, schemas and runtime metadata are not inferred. ' +
  'For operation identity and runtime-composed routing, reconcile with a pinned OpenAPI document ' +
  '(for projects using @nestjs/swagger) or an explicitly approved runtime route export.';

export function scanTypeScriptNestJs(repoRoot, projectRoot) {
  const files = listTypeScriptFiles(projectRoot);
  const modules = new Map();

  for (const file of files) {
    let text;
    try {
      text = maskJsComments(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const entry of extractControllers(text, file)) {
      if (!modules.has(entry.module)) {
        modules.set(entry.module, { module: entry.module, controllers: [], entities: [], enums: [], dtos: [] });
      }
      modules.get(entry.module).controllers.push(entry.controller);
    }
  }

  const packageFile = path.join(projectRoot, 'package.json');
  const filesRead = [
    ...(fs.existsSync(packageFile) ? [packageFile] : []),
    ...files,
  ].map((f) => path.relative(repoRoot, f)).sort();

  return {
    modules: [...modules.values()].sort((a, b) => a.module.localeCompare(b.module)),
    pathPrefixSignals: [],
    apiSurfaceSource: API_SURFACE_SOURCE,
    filesRead,
  };
}

function diagnostics(repoRoot) {
  const messages = [];
  const packageFiles = listPackageFiles(repoRoot);
  if (packageFiles.length === 0) {
    messages.push({ level: 'info', code: 'no-package-json', message: 'no package.json found' });
  } else if (!packageFiles.some(declaresNest)) {
    messages.push({
      level: 'info',
      code: 'nestjs-not-a-dependency',
      message: 'package.json files were found, but none declare both @nestjs/common and @nestjs/core',
    });
  }
  if (!binaryAvailable('rg')) {
    messages.push({
      level: 'warn',
      code: 'rg-missing',
      message: 'ripgrep (rg) is not on PATH -- this adapter uses it for bounded file discovery and will not detect without it',
    });
  }
  messages.push({
    level: 'info',
    code: 'nestjs-openapi-reconciliation-hint',
    message: 'api.operations and api.request-shape remain false in this first NestJS slice. If the project already uses @nestjs/swagger, export a pinned SwaggerModule.createDocument() result and pass that OpenAPI artifact through the existing reconciliation path rather than guessing runtime metadata from decorators.',
  });
  return messages;
}

export const adapter = {
  contract: 'sbf.adapter/2',
  id: 'typescript-nestjs',
  title: 'TypeScript / NestJS',
  specificity: 92,
  confidence: 'high',
  verificationBasis: 'synthetic-only',
  capabilities: {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  },
  detect: detectTypeScriptNestJsRoot,
  scan(repoRoot, detection) {
    return scanTypeScriptNestJs(repoRoot, detection);
  },
  listReadSet(repoRoot) {
    const projectRoot = detectTypeScriptNestJsRoot(repoRoot);
    if (!projectRoot) return [];
    const packageFile = path.join(projectRoot, 'package.json');
    return [
      ...(fs.existsSync(packageFile) ? [packageFile] : []),
      ...listTypeScriptFiles(projectRoot),
    ].map((f) => path.relative(repoRoot, f)).sort();
  },
  diagnostics,
};
