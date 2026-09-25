// T04: optional TypeScript Compiler API backend.
//
// The compiler package is injected by the caller. This module does not import "typescript" itself,
// mutate the repository, resolve packages, run transforms, or emit JavaScript. The first supported
// range is TypeScript 5.x and 6.x. TypeScript 7.x is intentionally refused until its changed API
// surface is reviewed against this boundary.

import { JS_TS_BACKEND_CONTRACT } from './backend-comparison.mjs';
import { JS_TS_FACTS_CONTRACT } from './source-facts.mjs';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOKENS = 250_000;
const SUPPORTED_MAJOR_MIN = 5;
const SUPPORTED_MAJOR_MAX = 6;

function diagnostic(code, message, source = undefined) {
  return { level: 'info', code, message, ...(source ? { source } : {}) };
}

function versionMajor(ts) {
  const raw = String(ts?.versionMajorMinor ?? ts?.version ?? '');
  const match = raw.match(/^(\d+)/);
  if (!match) throw new TypeError('typescript API must expose version or versionMajorMinor');
  return Number(match[1]);
}

function validateApi(ts) {
  if (!ts || typeof ts !== 'object') throw new TypeError('typescript API object is required');
  for (const name of ['createSourceFile', 'createScanner', 'flattenDiagnosticMessageText']) {
    if (typeof ts[name] !== 'function') throw new TypeError(`typescript API missing ${name}()`);
  }
  if (!ts.ScriptTarget || ts.ScriptTarget.Latest === undefined) throw new TypeError('typescript API missing ScriptTarget.Latest');
  if (!ts.ScriptKind) throw new TypeError('typescript API missing ScriptKind');
  if (!ts.SyntaxKind) throw new TypeError('typescript API missing SyntaxKind');
  const major = versionMajor(ts);
  if (major < SUPPORTED_MAJOR_MIN || major > SUPPORTED_MAJOR_MAX) {
    throw new RangeError(`unsupported TypeScript Compiler API major ${major}; supported majors are ${SUPPORTED_MAJOR_MIN}-${SUPPORTED_MAJOR_MAX}`);
  }
  return { major, version: String(ts.version ?? ts.versionMajorMinor) };
}

function scriptKind(ts, language) {
  if (language === 'typescript') return ts.ScriptKind.TS;
  if (language === 'tsx') return ts.ScriptKind.TSX;
  if (language === 'jsx') return ts.ScriptKind.JSX;
  if (language === 'javascript') return ts.ScriptKind.JS;
  throw new TypeError(`unsupported language mode: ${language}`);
}

function byteOffsets(source, positions) {
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  const out = new Map();
  let target = 0, codeUnit = 0, bytes = 0;
  while (target < sorted.length) {
    const wanted = sorted[target];
    while (codeUnit < wanted) {
      const cp = source.codePointAt(codeUnit);
      const width = cp > 0xffff ? 2 : 1;
      bytes += Buffer.byteLength(source.slice(codeUnit, codeUnit + width), 'utf8');
      codeUnit += width;
    }
    if (codeUnit !== wanted) throw new Error(`AST span boundary ${wanted} falls inside a surrogate pair`);
    out.set(wanted, bytes);
    target++;
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

function countTokens(ts, source, language, maxTokens) {
  const variant = language === 'jsx' || language === 'tsx'
    ? (ts.LanguageVariant?.JSX ?? 1)
    : (ts.LanguageVariant?.Standard ?? 0);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, variant, source);
  let count = 0;
  while (true) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) break;
    count++;
    if (count > maxTokens) return { complete: false, count };
  }
  return { complete: true, count };
}

function isStringLiteralLike(ts, node) {
  if (typeof ts.isStringLiteralLike === 'function') return ts.isStringLiteralLike(node);
  return Boolean(node && (node.kind === ts.SyntaxKind.StringLiteral || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral));
}

function literalText(ts, node) {
  return isStringLiteralLike(ts, node) ? node.text : null;
}

function importBindings(ts, node) {
  const clause = node.importClause;
  if (!clause) return [];
  const out = [];
  const clauseTypeOnly = Boolean(clause.isTypeOnly);
  if (clause.name) {
    out.push({
      imported: 'default',
      local: clause.name.text,
      bindingKind: 'default',
      typeOnly: clauseTypeOnly,
    });
  }
  const named = clause.namedBindings;
  if (!named) return out;
  if (typeof ts.isNamespaceImport === 'function' && ts.isNamespaceImport(named)) {
    out.push({
      imported: '*',
      local: named.name.text,
      bindingKind: 'namespace',
      typeOnly: clauseTypeOnly,
    });
    return out;
  }
  if (typeof ts.isNamedImports === 'function' && ts.isNamedImports(named)) {
    for (const spec of named.elements) {
      out.push({
        imported: spec.propertyName?.text ?? spec.name.text,
        local: spec.name.text,
        bindingKind: 'named',
        typeOnly: clauseTypeOnly || Boolean(spec.isTypeOnly),
      });
    }
  }
  return out;
}

function commonJsBinding(ts, call) {
  const parent = call.parent;
  if (!parent || typeof ts.isVariableDeclaration !== 'function' || !ts.isVariableDeclaration(parent)) return [];
  const name = parent.name;
  if (typeof ts.isIdentifier === 'function' && ts.isIdentifier(name)) {
    return [{
      imported: 'module.exports',
      local: name.text,
      bindingKind: 'commonjs-default',
      typeOnly: false,
    }];
  }
  if (typeof ts.isObjectBindingPattern === 'function' && ts.isObjectBindingPattern(name)) {
    const out = [];
    for (const element of name.elements) {
      if (element.dotDotDotToken) continue;
      if (!element.name || !(typeof ts.isIdentifier === 'function' && ts.isIdentifier(element.name))) continue;
      let imported = element.name.text;
      if (element.propertyName && typeof ts.isIdentifier === 'function' && ts.isIdentifier(element.propertyName)) imported = element.propertyName.text;
      out.push({
        imported,
        local: element.name.text,
        bindingKind: 'commonjs-named',
        typeOnly: false,
      });
    }
    return out;
  }
  return [];
}

function collectTopLevelNames(ts, sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements ?? []) {
    if (typeof ts.isFunctionDeclaration === 'function' && ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    }
    if (typeof ts.isClassDeclaration === 'function' && ts.isClassDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    }
    if (typeof ts.isVariableStatement === 'function' && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList?.declarations ?? []) {
        if (typeof ts.isIdentifier === 'function' && ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
    if (typeof ts.isImportDeclaration === 'function' && ts.isImportDeclaration(statement)) {
      for (const binding of importBindings(ts, statement)) names.add(binding.local);
    }
  }
  return names;
}

function parseDiagnostics(ts, sourceFile, source, offsets) {
  const raw = Array.isArray(sourceFile.parseDiagnostics) ? sourceFile.parseDiagnostics : [];
  return raw.map((d) => {
    const start = Number.isInteger(d.start) ? d.start : null;
    const length = Number.isInteger(d.length) ? d.length : 0;
    return {
      level: 'info',
      code: 'typescript-parse-diagnostic',
      tsCode: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      ...(start === null ? {} : { source: sourceSpan(source, start, start + length, offsets) }),
    };
  });
}

function createEdge(kind, specifier, bindings, typeOnly, start, end) {
  return {
    kind,
    specifier,
    bindings,
    typeOnly,
    basis: 'typescript-compiler-ast',
    resolution: 'unresolved',
    start,
    end,
  };
}

function extractEdges(ts, sourceFile, source) {
  const edges = [];
  const diagnostics = [];
  const topLevelNames = collectTopLevelNames(ts, sourceFile);
  const requireShadowed = topLevelNames.has('require');

  function visit(node) {
    if (typeof ts.isImportDeclaration === 'function' && ts.isImportDeclaration(node)) {
      const specifier = literalText(ts, node.moduleSpecifier);
      if (specifier !== null) {
        edges.push(createEdge(
          'import',
          specifier,
          importBindings(ts, node),
          Boolean(node.importClause?.isTypeOnly),
          node.getStart(sourceFile, false),
          node.getEnd(),
        ));
      }
    } else if (typeof ts.isExportDeclaration === 'function' && ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = literalText(ts, node.moduleSpecifier);
      if (specifier !== null) {
        edges.push(createEdge(
          'export-from',
          specifier,
          [],
          Boolean(node.isTypeOnly),
          node.getStart(sourceFile, false),
          node.getEnd(),
        ));
      }
    } else if (typeof ts.isCallExpression === 'function' && ts.isCallExpression(node)) {
      if (node.expression?.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments?.[0];
        const specifier = literalText(ts, arg);
        if (specifier !== null && node.arguments.length === 1) {
          edges.push(createEdge(
            'dynamic-import',
            specifier,
            [],
            false,
            node.getStart(sourceFile, false),
            node.getEnd(),
          ));
        } else {
          diagnostics.push({
            level: 'info',
            code: 'dynamic-import-nonliteral',
            message: 'dynamic import is not a single trusted literal; no module edge emitted',
            start: node.getStart(sourceFile, false),
          });
        }
      } else if (
        typeof ts.isIdentifier === 'function'
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'require'
      ) {
        if (requireShadowed) {
          diagnostics.push({
            level: 'info',
            code: 'require-shadowed',
            message: 'a top-level declaration named require exists; CommonJS require calls are not trusted in this file',
            start: node.getStart(sourceFile, false),
          });
        } else {
          const arg = node.arguments?.[0];
          const specifier = literalText(ts, arg);
          const bindings = commonJsBinding(ts, node);
          if (specifier !== null && node.arguments.length === 1 && bindings.length > 0) {
            edges.push(createEdge(
              'require',
              specifier,
              bindings,
              false,
              node.getStart(sourceFile, false),
              node.getEnd(),
            ));
          } else if (specifier === null || node.arguments.length !== 1) {
            diagnostics.push({
              level: 'info',
              code: 'require-nonliteral',
              message: 'require() is not a single trusted literal; no module edge emitted',
              start: node.getStart(sourceFile, false),
            });
          } else {
            diagnostics.push({
              level: 'info',
              code: 'require-unbound',
              message: 'literal require() has no supported local binding; no module edge emitted',
              start: node.getStart(sourceFile, false),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { edges, diagnostics };
}

function finalize(source, edges, diagnostics) {
  const positions = [];
  for (const edge of edges) positions.push(edge.start, edge.end);
  for (const d of diagnostics) if (d.start !== undefined) positions.push(d.start);
  const offsets = byteOffsets(source, positions);

  const publicEdges = edges.map(({ start, end, ...edge }) => ({
    ...edge,
    source: sourceSpan(source, start, end, offsets),
  }));
  const publicDiagnostics = diagnostics.map(({ start, ...d }) => (
    start === undefined
      ? d
      : { ...d, source: { byteStart: offsets.get(start), line: lineAt(source, start) } }
  ));
  publicEdges.sort((a, b) =>
    a.source.byteStart - b.source.byteStart
    || a.kind.localeCompare(b.kind)
    || a.specifier.localeCompare(b.specifier)
  );
  publicDiagnostics.sort((a, b) =>
    (a.source?.byteStart ?? -1) - (b.source?.byteStart ?? -1)
    || a.code.localeCompare(b.code)
  );
  return { edges: publicEdges, diagnostics: publicDiagnostics };
}

export function createTypeScriptCompilerBackend(ts) {
  const api = validateApi(ts);
  return Object.freeze({
    contract: JS_TS_BACKEND_CONTRACT,
    id: 'typescript-compiler',
    syntaxValidated: true,
    typescriptVersion: api.version,
    supportedMajorRange: [SUPPORTED_MAJOR_MIN, SUPPORTED_MAJOR_MAX],
    analyze(source, {
      filePath = '<memory>.ts',
      language = 'typescript',
      maxBytes = DEFAULT_MAX_BYTES,
      maxTokens = DEFAULT_MAX_TOKENS,
    } = {}) {
      if (typeof source !== 'string') throw new TypeError('source must be a string');
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
      if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new TypeError('maxTokens must be a positive safe integer');

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
          diagnostics: [diagnostic('input-too-large', `input is ${inputBytes} bytes; limit is ${maxBytes}; no partial compiler facts emitted`)],
        };
      }

      const counted = countTokens(ts, source, language, maxTokens);
      if (!counted.complete) {
        return {
          contract: JS_TS_FACTS_CONTRACT,
          filePath,
          language,
          complete: false,
          syntaxValidated: false,
          inputBytes,
          moduleEdges: [],
          diagnostics: [diagnostic('token-limit', `token limit ${maxTokens} reached; no partial compiler facts emitted`)],
        };
      }

      const sourceFile = ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKind(ts, language),
      );

      const rawParse = Array.isArray(sourceFile.parseDiagnostics) ? sourceFile.parseDiagnostics : [];
      if (rawParse.length > 0) {
        const positions = rawParse.flatMap((d) => Number.isInteger(d.start) ? [d.start, d.start + (Number.isInteger(d.length) ? d.length : 0)] : []);
        const offsets = byteOffsets(source, positions);
        return {
          contract: JS_TS_FACTS_CONTRACT,
          filePath,
          language,
          complete: false,
          syntaxValidated: false,
          inputBytes,
          moduleEdges: [],
          diagnostics: parseDiagnostics(ts, sourceFile, source, offsets),
        };
      }

      const extracted = extractEdges(ts, sourceFile, source);
      const final = finalize(source, extracted.edges, extracted.diagnostics);
      return {
        contract: JS_TS_FACTS_CONTRACT,
        filePath,
        language,
        complete: true,
        syntaxValidated: true,
        inputBytes,
        moduleEdges: final.edges,
        diagnostics: final.diagnostics,
      };
    },
  });
}
