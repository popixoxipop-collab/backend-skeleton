// T04: in-memory TypeScript semantic facts.
//
// The TypeScript API object is injected by the caller. All source files come from an explicit
// immutable snapshot. The compiler host never reads the filesystem, writes output, loads a default
// library, evaluates tsconfig, executes plugins/transformers, or resolves packages outside the
// supplied snapshot. This is a provisional T04-internal shape.

import path from 'node:path';
import { createTypeScriptCompilerBackend } from './typescript-compiler-backend.mjs';
import { analyzeJsTsSource } from './source-facts.mjs';
import { resolveJsTsModuleEdges } from './module-resolver.mjs';

export const JS_TS_SEMANTIC_CONTRACT = 'bskel.internal.js-ts-semantic/0';

const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalRepoPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('entry.path must be a non-empty repository-relative path');
  }
  const slashed = value.replaceAll('\\', '/');
  if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) {
    throw new TypeError('entry.path must be repository-relative');
  }
  const normalized = path.posix.normalize(slashed).replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new TypeError('entry.path escapes the repository root');
  }
  return normalized;
}

function extensionOf(filePath) {
  if (filePath.endsWith('.d.ts')) return '.d.ts';
  return path.posix.extname(filePath).toLowerCase();
}

function scriptKind(ts, filePath) {
  const ext = extensionOf(filePath);
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

function resolvedExtension(ts, filePath) {
  const ext = extensionOf(filePath);
  const E = ts.Extension ?? {};
  if (ext === '.tsx') return E.Tsx ?? '.tsx';
  if (ext === '.mts') return E.Mts ?? '.mts';
  if (ext === '.cts') return E.Cts ?? '.cts';
  if (ext === '.d.ts') return E.Dts ?? '.d.ts';
  return E.Ts ?? '.ts';
}

function virtualName(repoPath) {
  return `/__bskel_t04__/${repoPath}`;
}

function repoName(virtualFile) {
  const prefix = '/__bskel_t04__/';
  return virtualFile.startsWith(prefix) ? virtualFile.slice(prefix.length) : null;
}

function hasModifier(ts, node, kind) {
  return Boolean(node?.modifiers?.some((m) => m.kind === kind));
}

function byteOffsets(source, positions) {
  const sorted = [...new Set(positions)].filter(Number.isInteger).sort((a, b) => a - b);
  const out = new Map();
  let codeUnit = 0;
  let bytes = 0;
  for (const wanted of sorted) {
    while (codeUnit < wanted) {
      const cp = source.codePointAt(codeUnit);
      const width = cp > 0xffff ? 2 : 1;
      bytes += Buffer.byteLength(source.slice(codeUnit, codeUnit + width), 'utf8');
      codeUnit += width;
    }
    if (codeUnit !== wanted) {
      throw new Error(`semantic span boundary ${wanted} falls inside a surrogate pair`);
    }
    out.set(wanted, bytes);
  }
  return out;
}

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++;
  return line;
}

function sourceSpan(source, start, end, offsets) {
  return {
    byteStart: offsets.get(start),
    byteEnd: offsets.get(end),
    line: lineAt(source, start),
  };
}

function diagnosticRecord(ts, diagnostic, repoPath, source) {
  const start = Number.isInteger(diagnostic.start) ? diagnostic.start : null;
  const length = Number.isInteger(diagnostic.length) ? diagnostic.length : 0;
  const result = {
    code: diagnostic.code,
    category: ts.DiagnosticCategory?.[diagnostic.category]?.toLowerCase?.() ?? String(diagnostic.category),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    filePath: repoPath,
  };
  if (start !== null && source !== undefined) {
    const offsets = byteOffsets(source, [start, start + length]);
    result.source = sourceSpan(source, start, start + length, offsets);
  }
  return result;
}

function typeFormatFlags(ts) {
  let flags = 0;
  for (const name of ['NoTruncation', 'UseAliasDefinedOutsideCurrentScope', 'WriteArrayAsGenericType']) {
    const value = ts.TypeFormatFlags?.[name];
    if (typeof value === 'number') flags |= value;
  }
  return flags;
}

function symbolFlags(ts, symbol) {
  const flags = symbol.flags ?? 0;
  const S = ts.SymbolFlags ?? {};
  return {
    optional: Boolean(S.Optional && (flags & S.Optional)),
    alias: Boolean(S.Alias && (flags & S.Alias)),
    typeAlias: Boolean(S.TypeAlias && (flags & S.TypeAlias)),
    interface: Boolean(S.Interface && (flags & S.Interface)),
    class: Boolean(S.Class && (flags & S.Class)),
  };
}

function declarationKind(ts, node) {
  if (typeof ts.isInterfaceDeclaration === 'function' && ts.isInterfaceDeclaration(node)) return 'interface';
  if (typeof ts.isTypeAliasDeclaration === 'function' && ts.isTypeAliasDeclaration(node)) return 'type-alias';
  if (typeof ts.isClassDeclaration === 'function' && ts.isClassDeclaration(node)) return 'class';
  return null;
}

function propertyRecord(ts, checker, symbol, ownerNode, entryByVirtual) {
  const declarations = symbol.getDeclarations?.() ?? symbol.declarations ?? [];
  const declaration = symbol.valueDeclaration ?? declarations[0] ?? ownerNode;
  const virtualFile = declaration?.getSourceFile?.()?.fileName ?? ownerNode.getSourceFile().fileName;
  const repoPath = repoName(virtualFile);
  const entry = repoPath ? entryByVirtual.get(virtualFile) : null;
  const location = declaration ?? ownerNode;
  let typeText = '<unknown>';
  try {
    const type = checker.getTypeOfSymbolAtLocation(symbol, location);
    typeText = checker.typeToString(type, location, typeFormatFlags(ts));
  } catch {
    typeText = '<type-error>';
  }

  let source = null;
  if (entry && declaration && typeof declaration.getStart === 'function' && typeof declaration.getEnd === 'function') {
    const start = declaration.getStart(declaration.getSourceFile(), false);
    const end = declaration.getEnd();
    const offsets = byteOffsets(entry.source, [start, end]);
    source = sourceSpan(entry.source, start, end, offsets);
  }

  const readonly = declarations.some((d) => hasModifier(ts, d, ts.SyntaxKind.ReadonlyKeyword));
  return {
    name: symbol.getName?.() ?? symbol.name ?? '<anonymous>',
    typeText,
    optional: Boolean((symbol.flags ?? 0) & (ts.SymbolFlags?.Optional ?? 0)),
    readonly,
    declaredIn: repoPath,
    ...(source ? { source } : {}),
  };
}

function declarationRecord(ts, checker, node, repoPath, source, entryByVirtual) {
  const kind = declarationKind(ts, node);
  if (!kind || !node.name || typeof node.name.text !== 'string') return null;
  const symbol = checker.getSymbolAtLocation(node.name);
  if (!symbol) return null;

  let declaredType;
  let typeText = '<unknown>';
  try {
    declaredType = checker.getDeclaredTypeOfSymbol(symbol);
    typeText = checker.typeToString(declaredType, node, typeFormatFlags(ts));
  } catch {
    declaredType = checker.getTypeAtLocation(node);
    typeText = checker.typeToString(declaredType, node, typeFormatFlags(ts));
  }

  const start = node.getStart(node.getSourceFile(), false);
  const end = node.getEnd();
  const offsets = byteOffsets(source, [start, end]);
  const exported = hasModifier(ts, node, ts.SyntaxKind.ExportKeyword);
  const declared = hasModifier(ts, node, ts.SyntaxKind.DeclareKeyword);
  const properties = (checker.getPropertiesOfType(declaredType) ?? [])
    .map((property) => propertyRecord(ts, checker, property, node, entryByVirtual))
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.declaredIn ?? '', b.declaredIn ?? ''));

  const bases = [];
  if (kind === 'interface' || kind === 'class') {
    try {
      for (const base of checker.getBaseTypes?.(declaredType) ?? []) {
        bases.push(checker.typeToString(base, node, typeFormatFlags(ts)));
      }
    } catch {
      // Base-type expansion is informative only. Diagnostics remain the authoritative error path.
    }
  }

  return {
    name: node.name.text,
    kind,
    exported,
    declared,
    typeText,
    symbolFlags: symbolFlags(ts, symbol),
    bases: [...new Set(bases)].sort(compareText),
    properties,
    source: sourceSpan(source, start, end, offsets),
  };
}

function buildResolutionMaps(entries) {
  const knownFiles = entries.map((entry) => entry.path);
  const byFile = new Map();
  const diagnostics = [];
  for (const entry of entries) {
    const language = entry.path.endsWith('.tsx') ? 'tsx' : 'typescript';
    const facts = analyzeJsTsSource(entry.source, { filePath: entry.path, language });
    if (!facts.complete) {
      byFile.set(entry.path, new Map());
      diagnostics.push(...facts.diagnostics.map((d) => ({ ...d, filePath: entry.path })));
      continue;
    }
    const resolved = resolveJsTsModuleEdges(facts, { knownFiles });
    const map = new Map();
    for (const edge of resolved.resolutions) {
      if (edge.status === 'resolved' && edge.target) map.set(edge.specifier, edge.target);
    }
    byFile.set(entry.path, map);
    diagnostics.push(...resolved.diagnostics.map((d) => ({ ...d, filePath: entry.path })));
  }
  return { byFile, diagnostics };
}

function validateLimits(maxFiles, maxTotalBytes) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) throw new TypeError('maxFiles must be a positive safe integer');
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) throw new TypeError('maxTotalBytes must be a positive safe integer');
}

export function analyzeTypeScriptSemanticSnapshot(ts, entries, {
  maxFiles = DEFAULT_MAX_FILES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
} = {}) {
  // Reuse the compiler-backend's strict API/version validation without executing source.
  const compilerBackend = createTypeScriptCompilerBackend(ts);
  validateLimits(maxFiles, maxTotalBytes);
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');

  if (entries.length > maxFiles) {
    return {
      contract: JS_TS_SEMANTIC_CONTRACT,
      complete: false,
      syntaxValidated: false,
      semanticChecked: false,
      semanticValidated: false,
      runtimeValidated: false,
      typescriptVersion: compilerBackend.typescriptVersion,
      files: [],
      declarations: [],
      moduleDiagnostics: [],
      syntacticDiagnostics: [],
      semanticDiagnostics: [],
      diagnostics: [{ code: 'file-limit', message: `snapshot has ${entries.length} files; limit is ${maxFiles}` }],
    };
  }

  const normalized = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') throw new TypeError('each entry must be an object');
    if (typeof raw.source !== 'string') throw new TypeError('entry.source must be a string');
    const filePath = canonicalRepoPath(raw.path);
    if (seen.has(filePath)) throw new TypeError(`duplicate semantic snapshot path: ${filePath}`);
    seen.add(filePath);
    const ext = extensionOf(filePath);
    if (!SUPPORTED_EXTENSIONS.has(ext) && ext !== '.d.ts') {
      throw new TypeError(`unsupported semantic snapshot extension: ${filePath}`);
    }
    const bytes = Buffer.byteLength(raw.source, 'utf8');
    totalBytes += bytes;
    if (totalBytes > maxTotalBytes) {
      return {
        contract: JS_TS_SEMANTIC_CONTRACT,
        complete: false,
        syntaxValidated: false,
        semanticChecked: false,
        semanticValidated: false,
        runtimeValidated: false,
        typescriptVersion: compilerBackend.typescriptVersion,
        files: [],
        declarations: [],
        moduleDiagnostics: [],
        syntacticDiagnostics: [],
        semanticDiagnostics: [],
        diagnostics: [{ code: 'snapshot-too-large', message: `snapshot exceeds ${maxTotalBytes} bytes` }],
      };
    }
    normalized.push({ path: filePath, source: raw.source, bytes });
  }
  normalized.sort((a, b) => compareText(a.path, b.path));

  const virtualEntries = normalized.map((entry) => ({
    ...entry,
    virtualFile: virtualName(entry.path),
  }));
  const entryByVirtual = new Map(virtualEntries.map((entry) => [entry.virtualFile, entry]));
  const resolution = buildResolutionMaps(normalized);

  const sourceFiles = new Map();
  for (const entry of virtualEntries) {
    sourceFiles.set(entry.virtualFile, ts.createSourceFile(
      entry.virtualFile,
      entry.source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(ts, entry.path),
    ));
  }

  const directories = new Set(['/__bskel_t04__']);
  for (const entry of virtualEntries) {
    let current = path.posix.dirname(entry.virtualFile);
    while (current.startsWith('/__bskel_t04__')) {
      directories.add(current);
      if (current === '/__bskel_t04__') break;
      current = path.posix.dirname(current);
    }
  }

  const host = {
    getSourceFile(fileName) { return sourceFiles.get(fileName); },
    getSourceFileByPath(fileName) { return sourceFiles.get(fileName); },
    getDefaultLibFileName() { return '/__bskel_t04__/__no_default_lib__.d.ts'; },
    writeFile() { throw new Error('T04 semantic host is noEmit/read-only'); },
    getCurrentDirectory() { return '/__bskel_t04__'; },
    getDirectories(dir) {
      const prefix = dir.endsWith('/') ? dir : dir + '/';
      return [...directories]
        .filter((candidate) => candidate.startsWith(prefix) && candidate !== dir)
        .map((candidate) => candidate.slice(prefix.length).split('/')[0])
        .filter(Boolean)
        .filter((name, index, all) => all.indexOf(name) === index)
        .sort(compareText);
    },
    fileExists(fileName) { return sourceFiles.has(fileName); },
    readFile(fileName) { return entryByVirtual.get(fileName)?.source; },
    directoryExists(dir) { return directories.has(dir); },
    getCanonicalFileName(fileName) { return fileName; },
    useCaseSensitiveFileNames() { return true; },
    getNewLine() { return '\n'; },
    realpath(fileName) { return fileName; },
    resolveModuleNames(moduleNames, containingFile) {
      const fromRepo = repoName(containingFile);
      const map = fromRepo ? resolution.byFile.get(fromRepo) : null;
      return moduleNames.map((specifier) => {
        const targetRepo = map?.get(specifier);
        if (!targetRepo) return undefined;
        const targetVirtual = virtualName(targetRepo);
        return {
          resolvedFileName: targetVirtual,
          extension: resolvedExtension(ts, targetRepo),
          isExternalLibraryImport: false,
        };
      });
    },
  };

  const moduleKind = ts.ModuleKind?.ESNext ?? ts.ModuleKind?.CommonJS;
  const moduleResolution = ts.ModuleResolutionKind?.Node10
    ?? ts.ModuleResolutionKind?.NodeJs
    ?? ts.ModuleResolutionKind?.Classic;

  const program = ts.createProgram({
    rootNames: virtualEntries.map((entry) => entry.virtualFile),
    options: {
      noLib: true,
      noEmit: true,
      allowJs: false,
      checkJs: false,
      skipLibCheck: true,
      strict: false,
      target: ts.ScriptTarget.Latest,
      module: moduleKind,
      moduleResolution,
    },
    host,
  });

  const checker = program.getTypeChecker();
  const syntacticDiagnostics = [];
  const semanticDiagnostics = [];
  const declarations = [];
  const files = [];

  for (const entry of virtualEntries) {
    const sourceFile = program.getSourceFile(entry.virtualFile);
    if (!sourceFile) {
      return {
        contract: JS_TS_SEMANTIC_CONTRACT,
        complete: false,
        syntaxValidated: false,
        semanticChecked: false,
        semanticValidated: false,
        runtimeValidated: false,
        typescriptVersion: compilerBackend.typescriptVersion,
        files: [],
        declarations: [],
        moduleDiagnostics: resolution.diagnostics,
        syntacticDiagnostics: [],
        semanticDiagnostics: [],
        diagnostics: [{ code: 'program-source-missing', message: `program did not retain ${entry.path}` }],
      };
    }

    const syntactic = program.getSyntacticDiagnostics(sourceFile);
    const semantic = program.getSemanticDiagnostics(sourceFile);
    syntacticDiagnostics.push(...syntactic.map((d) => diagnosticRecord(ts, d, entry.path, entry.source)));
    semanticDiagnostics.push(...semantic.map((d) => diagnosticRecord(ts, d, entry.path, entry.source)));

    const fileDeclarations = [];
    for (const statement of sourceFile.statements ?? []) {
      const record = declarationRecord(ts, checker, statement, entry.path, entry.source, entryByVirtual);
      if (record) {
        fileDeclarations.push(record);
        declarations.push({ ...record, filePath: entry.path });
      }
    }
    fileDeclarations.sort((a, b) => a.source.byteStart - b.source.byteStart || compareText(a.name, b.name));
    files.push({
      path: entry.path,
      bytes: entry.bytes,
      declarations: fileDeclarations,
    });
  }

  syntacticDiagnostics.sort((a, b) => compareText(a.filePath, b.filePath) || (a.source?.byteStart ?? -1) - (b.source?.byteStart ?? -1) || a.code - b.code);
  semanticDiagnostics.sort((a, b) => compareText(a.filePath, b.filePath) || (a.source?.byteStart ?? -1) - (b.source?.byteStart ?? -1) || a.code - b.code);
  declarations.sort((a, b) => compareText(a.filePath, b.filePath) || a.source.byteStart - b.source.byteStart || compareText(a.name, b.name));

  const syntaxValidated = syntacticDiagnostics.length === 0;
  const semanticValidated = syntaxValidated
    && semanticDiagnostics.length === 0
    && resolution.diagnostics.length === 0;

  return {
    contract: JS_TS_SEMANTIC_CONTRACT,
    complete: true,
    syntaxValidated,
    semanticChecked: true,
    semanticValidated,
    runtimeValidated: false,
    typescriptVersion: compilerBackend.typescriptVersion,
    totalBytes,
    files,
    declarations,
    moduleDiagnostics: resolution.diagnostics,
    syntacticDiagnostics,
    semanticDiagnostics,
    diagnostics: [],
  };
}
