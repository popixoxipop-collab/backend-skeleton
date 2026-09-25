// T04: optional Tree-sitter structural candidate backend.
//
// Parser constructor and grammars are injected by the caller. This module does not install native
// addons, discover grammars, execute target code, or resolve packages. Tree-sitter supplies trusted
// syntax boundaries; the existing bounded lexical projector is reused only inside syntax nodes.

import { JS_TS_BACKEND_CONTRACT } from './backend-comparison.mjs';
import { JS_TS_FACTS_CONTRACT, analyzeJsTsSource } from './source-facts.mjs';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOKENS = 250_000;

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function validateInputs(Parser, grammars) {
  if (typeof Parser !== 'function') throw new TypeError('Tree-sitter Parser constructor is required');
  if (!grammars || typeof grammars !== 'object') throw new TypeError('Tree-sitter grammars object is required');
  for (const key of ['javascript', 'typescript', 'tsx']) {
    if (!grammars[key]) throw new TypeError(`Tree-sitter grammar missing: ${key}`);
  }
}

function grammarFor(grammars, language) {
  if (language === 'javascript' || language === 'jsx') return grammars.javascript;
  if (language === 'typescript') return grammars.typescript;
  if (language === 'tsx') return grammars.tsx;
  throw new TypeError(`unsupported language mode: ${language}`);
}

function nodeChildren(node) {
  if (Array.isArray(node.namedChildren)) return node.namedChildren;
  const out = [];
  const count = Number(node.namedChildCount ?? 0);
  for (let i = 0; i < count; i++) {
    const child = typeof node.namedChild === 'function' ? node.namedChild(i) : null;
    if (child) out.push(child);
  }
  return out;
}

function missingNode(node) {
  if (typeof node.isMissing === 'function') return Boolean(node.isMissing());
  return Boolean(node.isMissing);
}

function hasError(node) {
  if (typeof node.hasError === 'function') return Boolean(node.hasError());
  return Boolean(node.hasError);
}

function codeUnitIndexFromUtf8ByteOffset(source, byteOffset) {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) return null;
  let codeUnit = 0;
  let bytes = 0;
  while (codeUnit < source.length && bytes < byteOffset) {
    const cp = source.codePointAt(codeUnit);
    const width = cp > 0xffff ? 2 : 1;
    const nextBytes = bytes + Buffer.byteLength(source.slice(codeUnit, codeUnit + width), 'utf8');
    if (nextBytes > byteOffset) return null;
    bytes = nextBytes;
    codeUnit += width;
  }
  return bytes === byteOffset ? codeUnit : null;
}

function lineStartCodeUnit(source, row) {
  if (!Number.isSafeInteger(row) || row <= 0) return 0;
  let currentRow = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      currentRow++;
      if (currentRow === row) return i + 1;
    }
  }
  return source.length;
}

function nodeCodeUnitStart(source, node) {
  const rawIndex = Number(node.startIndex ?? 0);
  const text = String(node.text ?? '');

  // node-tree-sitter versions/profiles have historically exposed positions around JS strings
  // differently. Never assume rawIndex's unit: test both plausible interpretations against the
  // actual node text and original source bytes.
  if (text && source.slice(rawIndex, rawIndex + text.length) === text) return rawIndex;

  const fromByteIndex = codeUnitIndexFromUtf8ByteOffset(source, rawIndex);
  if (text && fromByteIndex !== null && source.slice(fromByteIndex, fromByteIndex + text.length) === text) {
    return fromByteIndex;
  }

  const row = Number(node.startPosition?.row ?? 0);
  const column = Number(node.startPosition?.column ?? 0);
  const rowStart = lineStartCodeUnit(source, row);
  const asCodeUnits = rowStart + column;
  if (text && source.slice(asCodeUnits, asCodeUnits + text.length) === text) return asCodeUnits;

  const lineEndRaw = source.indexOf('\n', rowStart);
  const lineEnd = lineEndRaw === -1 ? source.length : lineEndRaw;
  const line = source.slice(rowStart, lineEnd);
  const inLineFromBytes = codeUnitIndexFromUtf8ByteOffset(line, column);
  if (inLineFromBytes !== null) {
    const candidate = rowStart + inLineFromBytes;
    if (!text || source.slice(candidate, candidate + text.length) === text) return candidate;
  }

  // Empty/missing nodes cannot be text-matched. Prefer the documented byte interpretation when
  // it lands on a valid UTF-8 boundary, then fall back to the row/column code-unit interpretation.
  if (!text && fromByteIndex !== null) return fromByteIndex;
  if (!text && asCodeUnits <= source.length) return asCodeUnits;

  throw new Error(`cannot map Tree-sitter node position back to source: ${node.type ?? '<unknown>'}`);
}

function nodeByteRange(source, node) {
  const startCodeUnit = nodeCodeUnitStart(source, node);
  const text = String(node.text ?? '');
  const endCodeUnit = startCodeUnit + text.length;
  return {
    codeUnitStart: startCodeUnit,
    byteStart: Buffer.byteLength(source.slice(0, startCodeUnit), 'utf8'),
    byteEnd: Buffer.byteLength(source.slice(0, endCodeUnit), 'utf8'),
  };
}

function adjustProjection(source, baseNode, projection) {
  const base = nodeByteRange(source, baseNode);
  const baseRow = Number(baseNode.startPosition?.row ?? 0);
  return {
    edges: projection.moduleEdges.map((edge) => ({
      ...edge,
      basis: 'tree-sitter-structure+lexical-projection',
      source: {
        byteStart: base.byteStart + edge.source.byteStart,
        byteEnd: base.byteStart + edge.source.byteEnd,
        line: baseRow + edge.source.line,
      },
    })),
    diagnostics: projection.diagnostics.map((d) => ({
      ...d,
      ...(d.source ? {
        source: {
          byteStart: base.byteStart + d.source.byteStart,
          ...(d.source.byteEnd === undefined ? {} : { byteEnd: base.byteStart + d.source.byteEnd }),
          line: baseRow + d.source.line,
        },
      } : {}),
    })),
  };
}

function snippetNodeForCall(node) {
  const text = String(node.text ?? '').trimStart();
  if (text.startsWith('require(')) {
    const declarator = node.parent;
    if (declarator?.type === 'variable_declarator') {
      const declaration = declarator.parent;
      // The bounded lexical projector intentionally trusts CommonJS local bindings only when the
      // declaration keyword is present. Tree-sitter's variable_declarator text starts after that
      // keyword, so project the containing declaration statement rather than weakening the
      // lexical trust rule.
      if (declaration?.type === 'lexical_declaration' || declaration?.type === 'variable_declaration') {
        return declaration;
      }
    }
    return node;
  }
  if (text.startsWith('import(')) return node;
  return null;
}

export function createTreeSitterJsTsBackend(Parser, grammars, {
  id = 'tree-sitter-js-ts',
} = {}) {
  validateInputs(Parser, grammars);
  return Object.freeze({
    contract: JS_TS_BACKEND_CONTRACT,
    id,
    syntaxValidated: true,
    analyze(source, {
      filePath = '<memory>',
      language = 'javascript',
      maxBytes = DEFAULT_MAX_BYTES,
      maxTokens = DEFAULT_MAX_TOKENS,
    } = {}) {
      if (typeof source !== 'string') throw new TypeError('source must be a string');
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
      if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new TypeError('maxTokens must be a positive safe integer');
      grammarFor(grammars, language);

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
          diagnostics: [{ level: 'info', code: 'input-too-large', message: `input is ${inputBytes} bytes; limit is ${maxBytes}; no partial Tree-sitter facts emitted` }],
        };
      }

      // Reuse the bounded lexical tokenizer only as the common pre-parse token budget. Its edges
      // are discarded here; Tree-sitter decides which syntax nodes are eligible for projection.
      const budget = analyzeJsTsSource(source, { filePath, language, maxBytes, maxTokens });
      if (!budget.complete) {
        return {
          contract: JS_TS_FACTS_CONTRACT,
          filePath,
          language,
          complete: false,
          syntaxValidated: false,
          inputBytes,
          moduleEdges: [],
          diagnostics: budget.diagnostics,
        };
      }

      const parser = new Parser();
      parser.setLanguage(grammarFor(grammars, language));
      const tree = parser.parse(source);
      const root = tree.rootNode;
      const diagnostics = [];
      const edges = [];

      function projectNode(node) {
        const snippet = String(node.text ?? '');
        const projected = analyzeJsTsSource(snippet, {
          filePath,
          language,
          maxBytes: Math.max(1, Buffer.byteLength(snippet, 'utf8') + 1),
          maxTokens,
        });
        const adjusted = adjustProjection(source, node, projected);
        edges.push(...adjusted.edges);
        diagnostics.push(...adjusted.diagnostics);
      }

      function visit(node) {
        if (node.type === 'ERROR' || missingNode(node)) {
          diagnostics.push({
            level: 'info',
            code: 'tree-sitter-parse-error',
            message: node.type === 'ERROR' ? 'Tree-sitter ERROR node' : 'Tree-sitter missing node',
            source: {
              byteStart: nodeByteRange(source, node).byteStart,
              byteEnd: nodeByteRange(source, node).byteEnd,
              line: Number(node.startPosition?.row ?? 0) + 1,
            },
          });
        }

        if (node.type === 'import_statement' || node.type === 'export_statement') {
          projectNode(node);
          return; // avoid projecting calls nested under a statement we already projected.
        }

        if (node.type === 'call_expression') {
          const snippetNode = snippetNodeForCall(node);
          if (snippetNode) {
            projectNode(snippetNode);
            return;
          }
        }

        for (const child of nodeChildren(node)) visit(child);
      }
      visit(root);

      // A variable_declarator may contain more than one lexical edge in unusual syntax. Preserve
      // distinct provenance but remove byte-identical duplicates created by overlapping AST walks.
      const seen = new Set();
      const uniqueEdges = [];
      for (const edge of edges) {
        const k = JSON.stringify([edge.kind, edge.specifier, edge.typeOnly, edge.bindings, edge.source]);
        if (seen.has(k)) continue;
        seen.add(k);
        uniqueEdges.push(edge);
      }
      uniqueEdges.sort((a, b) =>
        a.source.byteStart - b.source.byteStart
        || compareText(a.kind, b.kind)
        || compareText(a.specifier, b.specifier)
      );
      diagnostics.sort((a, b) =>
        (a.source?.byteStart ?? -1) - (b.source?.byteStart ?? -1)
        || compareText(a.code, b.code)
      );

      return {
        contract: JS_TS_FACTS_CONTRACT,
        filePath,
        language,
        complete: true,
        syntaxValidated: !hasError(root) && diagnostics.every((d) => d.code !== 'tree-sitter-parse-error'),
        inputBytes,
        moduleEdges: uniqueEdges,
        diagnostics,
      };
    },
  });
}
