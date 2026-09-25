// T04: optional TypeScript Compiler API candidate backend.
//
// The compiler object is injected by the caller. This file does not import/install TypeScript,
// inspect tsconfig, load compiler plugins, or execute target modules. It only parses supplied bytes
// into a SourceFile and projects the same provisional module-edge surface used by T04 comparison.

import { JS_TS_BACKEND_CONTRACT } from './backend-comparison.mjs';
import { JS_TS_FACTS_CONTRACT } from './source-facts.mjs';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOKENS = 250_000;

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateCompilerApi(ts) {
  if (!ts || typeof ts !== 'object') throw new TypeError('TypeScript compiler API object is required');
  for (const fn of [
    'createSourceFile', 'createScanner', 'forEachChild',
    'isImportDeclaration', 'isExportDeclaration', 'isCallExpression',
    'isIdentifier', 'isVariableDeclaration', 'isObjectBindingPattern',
    'isNamespaceImport', 'isNamedImports', 'isImportEqualsDeclaration',
    'isExternalModuleReference',
  ]) {
    if (typeof ts[fn] !== 'function') throw new TypeError(`TypeScript compiler API missing ${fn}()`);
  }
  if (!ts.SyntaxKind || !ts.ScriptTarget || !ts.ScriptKind || !ts.LanguageVariant) {
    throw new TypeError('TypeScript compiler API is missing SyntaxKind/ScriptTarget/ScriptKind/LanguageVariant');
  }
  return ts;
}

function scriptKindFor(ts, language) {
  if (language === 'javascript') return ts.ScriptKind.JS;
  if (language === 'jsx') return ts.ScriptKind.JSX;
  if (language === 'typescript') return ts.ScriptKind.TS;
  if (language === 'tsx') return ts.ScriptKind.TSX;
  throw new TypeError(`unsupported language mode: ${language}`);
}

function languageVariantFor(ts, language) {
  return language === 'jsx' || language === 'tsx' ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
}

function literalText(ts, node) {
  if (!node) return null;
  if (typeof ts.isStringLiteral === 'function' && ts.isStringLiteral(node)) return node.text;
  if (typeof ts.isNoSubstitutionTemplateLiteral === 'function' && ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function byteOffsets(source, positions) {
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  const out = new Map();
  let target = 0, cu = 0, bytes = 0;
  while (target < sorted.length) {
    const wanted = sorted[target];
    while (cu < wanted) {
      const cp = source.codePointAt(cu);
      const width = cp > 0xffff ? 2 : 1;
      bytes += Buffer.byteLength(source.slice(cu, cu + width), 'utf8');
      cu += width;
    }
    if (cu !== wanted) throw new Error(`compiler span boundary ${wanted} falls inside a surrogate pair`);
    out.set(wanted, bytes);
    target++;
  }
  return out;
}

function withSpans(source, sourceFile, edges, diagnostics) {
  const positions = [];
  for (const edge of edges) positions.push(edge.start, edge.end);
  for (const d of diagnostics) if (Number.isInteger(d.start)) positions.push(d.start);
  const offsets = byteOffsets(source, positions);
  const lineAt = (index) => {
    if (typeof sourceFile.getLineAndCharacterOfPosition === 'function') {
      return sourceFile.getLineAndCharacterOfPosition(index).line + 1;
    }
    let line = 1;
    for (let i = 0; i < index; i++) if (source[i] === '\n') line++;
    return line;
  };
  return {
    edges: edges.map(({ start, end, ...edge }) => ({
      ...edge,
      source: { byteStart: offsets.get(start), byteEnd: offsets.get(end), line: lineAt(start) },
    })),
    diagnostics: diagnostics.map(({ start, ...d }) => start === undefined ? d : ({
      ...d,
      source: { byteStart: offsets.get(start), line: lineAt(start) },
    })),
  };
}

function importBindings(ts, clause) {
  if (!clause) return [];
  const typeOnly = Boolean(clause.isTypeOnly);
  const out = [];
  if (clause.name) {
    out.push({ imported: 'default', local: clause.name.text, bindingKind: 'default', typeOnly });
  }
  const named = clause.namedBindings;
  if (!named) return out;
  if (ts.isNamespaceImport(named)) {
    out.push({ imported: '*', local: named.name.text, bindingKind: 'namespace', typeOnly });
    return out;
  }
  if (ts.isNamedImports(named)) {
    for (const item of named.elements) {
      out.push({
        imported: item.propertyName?.text ?? item.name.text,
        local: item.name.text,
        bindingKind: 'named',
        typeOnly: typeOnly || Boolean(item.isTypeOnly),
      });
    }
  }
  return out;
}

function requireBindings(ts, call) {
  const parent = call.parent;
  if (!parent || !ts.isVariableDeclaration(parent) || parent.initializer !== call) return [];
  if (ts.isIdentifier(parent.name)) {
    return [{ imported: 'module.exports', local: parent.name.text, bindingKind: 'commonjs-default', typeOnly: false }];
  }
  if (ts.isObjectBindingPattern(parent.name)) {
    const out = [];
    for (const element of parent.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      let imported = element.name.text;
      if (element.propertyName && ts.isIdentifier(element.propertyName)) imported = element.propertyName.text;
      out.push({ imported, local: element.name.text, bindingKind: 'commonjs-named', typeOnly: false });
    }
    return out;
  }
  return [];
}

function scanTokenBudget(ts, source, language, maxTokens) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    languageVariantFor(ts, language),
    source,
  );
  let count = 0;
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    count++;
    if (count > maxTokens) return { complete: false, count };
  }
  return { complete: true, count };
}

function parseDiagnostics(ts, sourceFile) {
  const raw = Array.isArray(sourceFile.parseDiagnostics) ? sourceFile.parseDiagnostics : [];
  return raw.map((d) => ({
    level: 'info',
    code: 'typescript-parse-diagnostic',
    tsCode: d.code,
    message: typeof ts.flattenDiagnosticMessageText === 'function'
      ? ts.flattenDiagnosticMessageText(d.messageText, '\n')
      : String(d.messageText),
    ...(Number.isInteger(d.start) ? { start: d.start } : {}),
  }));
}

export function createTypeScriptCompilerBackend(compilerApi, {
  id = null,
} = {}) {
  const ts = validateCompilerApi(compilerApi);
  const version = typeof ts.version === 'string' && ts.version ? ts.version : 'unknown';
  const backendId = id ?? `typescript-compiler-${version.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;

  return Object.freeze({
    contract: JS_TS_BACKEND_CONTRACT,
    id: backendId,
    syntaxValidated: true,
    compilerVersion: version,
    analyze(source, {
      filePath = '<memory>',
      language = 'javascript',
      maxBytes = DEFAULT_MAX_BYTES,
      maxTokens = DEFAULT_MAX_TOKENS,
    } = {}) {
      if (typeof source !== 'string') throw new TypeError('source must be a string');
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
      if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new TypeError('maxTokens must be a positive safe integer');
      const scriptKind = scriptKindFor(ts, language);
      const inputBytes = Buffer.byteLength(source, 'utf8');
      if (inputBytes > maxBytes) {
        return {
          contract: JS_TS_FACTS_CONTRACT,
          filePath,
          language,
          complete: false,
          syntaxValidated: false,
          inputBytes,
          moduleEdges: [],
          diagnostics: [{ level: 'info', code: 'input-too-large', message: `input is ${inputBytes} bytes; limit is ${maxBytes}; no partial compiler facts emitted` }],
        };
      }
      const tokenBudget = scanTokenBudget(ts, source, language, maxTokens);
      if (!tokenBudget.complete) {
        return {
          contract: JS_TS_FACTS_CONTRACT,
          filePath,
          language,
          complete: false,
          syntaxValidated: false,
          inputBytes,
          moduleEdges: [],
          diagnostics: [{ level: 'info', code: 'token-limit', message: `token limit ${maxTokens} reached; no partial compiler facts emitted` }],
        };
      }

      const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
      const diagnostics = parseDiagnostics(ts, sourceFile);
      const edges = [];

      function pushEdge(node, kind, specifier, bindings = [], typeOnly = false) {
        const start = node.getStart(sourceFile, false);
        const end = node.getEnd();
        edges.push({
          kind,
          specifier,
          bindings,
          typeOnly,
          basis: 'typescript-compiler-ast',
          resolution: 'unresolved',
          start,
          end,
        });
      }

      function visit(node) {
        if (ts.isImportDeclaration(node)) {
          const specifier = literalText(ts, node.moduleSpecifier);
          if (specifier !== null) {
            pushEdge(node, 'import', specifier, importBindings(ts, node.importClause), Boolean(node.importClause?.isTypeOnly));
          }
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
          const specifier = literalText(ts, node.moduleSpecifier);
          if (specifier !== null) pushEdge(node, 'export-from', specifier, [], Boolean(node.isTypeOnly));
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
          const specifier = literalText(ts, node.moduleReference.expression);
          if (specifier !== null) {
            pushEdge(node, 'require', specifier, [{
              imported: 'module.exports',
              local: node.name.text,
              bindingKind: 'commonjs-default',
              typeOnly: Boolean(node.isTypeOnly),
            }], Boolean(node.isTypeOnly));
          }
        } else if (ts.isCallExpression(node)) {
          const isDynamicImport = node.expression?.kind === ts.SyntaxKind.ImportKeyword;
          const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
          if (isDynamicImport || isRequire) {
            const specifier = node.arguments.length === 1 ? literalText(ts, node.arguments[0]) : null;
            if (specifier !== null) {
              pushEdge(node, isDynamicImport ? 'dynamic-import' : 'require', specifier, isRequire ? requireBindings(ts, node) : [], false);
            } else {
              diagnostics.push({
                level: 'info',
                code: isDynamicImport ? 'dynamic-import-nonliteral' : 'require-nonliteral',
                message: `${isDynamicImport ? 'dynamic import' : 'require()'} is not a single trusted literal; no module edge emitted`,
                start: node.getStart(sourceFile, false),
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(sourceFile);

      const spanned = withSpans(source, sourceFile, edges, diagnostics);
      spanned.edges.sort((a, b) =>
        a.source.byteStart - b.source.byteStart
        || compareText(a.kind, b.kind)
        || compareText(a.specifier, b.specifier)
      );
      spanned.diagnostics.sort((a, b) =>
        (a.source?.byteStart ?? -1) - (b.source?.byteStart ?? -1)
        || compareText(a.code, b.code)
      );

      return {
        contract: JS_TS_FACTS_CONTRACT,
        filePath,
        language,
        complete: true,
        syntaxValidated: spanned.diagnostics.every((d) => d.code !== 'typescript-parse-diagnostic'),
        inputBytes,
        moduleEdges: spanned.edges,
        diagnostics: spanned.diagnostics,
      };
    },
  });
}
