// T04: compiler-AST structure facts for decorator-heavy servers and JSX render trees.
//
// This module intentionally stays below framework semantics. A @Controller decorator is reported
// as a decorator call; it is NOT declared to mean an HTTP controller here. A <mesh> JSX tag is
// reported as JSX structure; it is NOT declared to be a Three.js entity here. Nest/R3F adapters
// can interpret these facts in their own scoped layers.

import { createTypeScriptCompilerBackend } from './typescript-compiler-backend.mjs';

export const JS_TS_STRUCTURE_CONTRACT = 'bskel.internal.js-ts-structure/0';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_NODES = 200_000;
const DEFAULT_MAX_TRACKED_CALLS = 128;

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateStringArray(values, label, maxItems) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  if (values.length > maxItems) throw new RangeError(`${label} has ${values.length} entries; limit is ${maxItems}`);
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(value)) {
      throw new TypeError(`${label} entries must be identifier/dotted-name strings`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out.sort(compareText);
}

function scriptKind(ts, language) {
  if (language === 'typescript') return ts.ScriptKind.TS;
  if (language === 'tsx') return ts.ScriptKind.TSX;
  if (language === 'javascript') return ts.ScriptKind.JS;
  if (language === 'jsx') return ts.ScriptKind.JSX;
  throw new TypeError(`unsupported language mode: ${language}`);
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
    if (codeUnit !== wanted) throw new Error(`structure span boundary ${wanted} falls inside a surrogate pair`);
    out.set(wanted, bytes);
  }
  return out;
}

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++;
  return line;
}

function withSpan(node, sourceFile, data) {
  return {
    ...data,
    _start: node.getStart(sourceFile, false),
    _end: node.getEnd(),
  };
}

function collectSpanPositions(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectSpanPositions(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Number.isInteger(value._start)) out.push(value._start);
  if (Number.isInteger(value._end)) out.push(value._end);
  for (const [key, child] of Object.entries(value)) {
    if (key !== '_start' && key !== '_end') collectSpanPositions(child, out);
  }
}

function finalizeSpans(value, source, offsets) {
  if (Array.isArray(value)) return value.map((item) => finalizeSpans(item, source, offsets));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '_start' || key === '_end') continue;
    out[key] = finalizeSpans(child, source, offsets);
  }
  if (Number.isInteger(value._start) && Number.isInteger(value._end)) {
    out.source = {
      byteStart: offsets.get(value._start),
      byteEnd: offsets.get(value._end),
      line: lineAt(source, value._start),
    };
  }
  return out;
}

function decoratorsOf(ts, node) {
  if (typeof ts.canHaveDecorators === 'function' && typeof ts.getDecorators === 'function') {
    return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  }
  return (node.modifiers ?? []).filter((modifier) => modifier.kind === ts.SyntaxKind.Decorator);
}

function expressionName(ts, expression, sourceFile) {
  if (!expression) return '<missing>';
  if (typeof ts.isIdentifier === 'function' && ts.isIdentifier(expression)) return expression.text;
  if (typeof ts.isPropertyAccessExpression === 'function' && ts.isPropertyAccessExpression(expression)) {
    return `${expressionName(ts, expression.expression, sourceFile)}.${expression.name.text}`;
  }
  return expression.getText(sourceFile);
}

function literalOrExpression(ts, expression, sourceFile) {
  if (!expression) return { kind: 'missing' };
  if (typeof ts.isStringLiteralLike === 'function' && ts.isStringLiteralLike(expression)) {
    return { kind: 'literal', value: expression.text };
  }
  if (typeof ts.isNumericLiteral === 'function' && ts.isNumericLiteral(expression)) {
    const numeric = Number(expression.text.replaceAll('_', ''));
    return Number.isFinite(numeric)
      ? { kind: 'literal', value: numeric }
      : { kind: 'expression', text: expression.getText(sourceFile) };
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'literal', value: true };
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: false };
  if (expression.kind === ts.SyntaxKind.NullKeyword) return { kind: 'literal', value: null };
  return { kind: 'expression', text: expression.getText(sourceFile) };
}

function decoratorFact(ts, decorator, sourceFile) {
  const expression = decorator.expression;
  if (typeof ts.isCallExpression === 'function' && ts.isCallExpression(expression)) {
    return withSpan(decorator, sourceFile, {
      name: expressionName(ts, expression.expression, sourceFile),
      called: true,
      arguments: expression.arguments.map((arg) => literalOrExpression(ts, arg, sourceFile)),
    });
  }
  return withSpan(decorator, sourceFile, {
    name: expressionName(ts, expression, sourceFile),
    called: false,
    arguments: [],
  });
}

function memberName(ts, node, sourceFile) {
  const name = node.name;
  if (!name) return { name: '<constructor>', computed: false };
  if (typeof ts.isIdentifier === 'function' && ts.isIdentifier(name)) return { name: name.text, computed: false };
  if (typeof ts.isStringLiteralLike === 'function' && ts.isStringLiteralLike(name)) return { name: name.text, computed: false };
  if (typeof ts.isNumericLiteral === 'function' && ts.isNumericLiteral(name)) return { name: name.text, computed: false };
  return { name: name.getText(sourceFile), computed: true };
}

function parameterFact(ts, parameter, sourceFile) {
  let name = '<pattern>';
  if (typeof ts.isIdentifier === 'function' && ts.isIdentifier(parameter.name)) name = parameter.name.text;
  else name = parameter.name.getText(sourceFile);
  return withSpan(parameter, sourceFile, {
    name,
    optional: Boolean(parameter.questionToken || parameter.initializer),
    rest: Boolean(parameter.dotDotDotToken),
    typeText: parameter.type ? parameter.type.getText(sourceFile) : null,
    decorators: decoratorsOf(ts, parameter).map((d) => decoratorFact(ts, d, sourceFile)),
  });
}

function classMemberFact(ts, member, sourceFile) {
  let kind = 'member';
  if (typeof ts.isMethodDeclaration === 'function' && ts.isMethodDeclaration(member)) kind = 'method';
  else if (typeof ts.isPropertyDeclaration === 'function' && ts.isPropertyDeclaration(member)) kind = 'property';
  else if (typeof ts.isGetAccessorDeclaration === 'function' && ts.isGetAccessorDeclaration(member)) kind = 'getter';
  else if (typeof ts.isSetAccessorDeclaration === 'function' && ts.isSetAccessorDeclaration(member)) kind = 'setter';
  else if (typeof ts.isConstructorDeclaration === 'function' && ts.isConstructorDeclaration(member)) kind = 'constructor';

  const named = memberName(ts, member, sourceFile);
  return withSpan(member, sourceFile, {
    kind,
    ...named,
    static: Boolean(member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)),
    decorators: decoratorsOf(ts, member).map((d) => decoratorFact(ts, d, sourceFile)),
    parameters: (member.parameters ?? []).map((p) => parameterFact(ts, p, sourceFile)),
    typeText: member.type ? member.type.getText(sourceFile) : null,
  });
}

function classFact(ts, node, sourceFile) {
  const name = node.name?.text ?? '<anonymous>';
  return withSpan(node, sourceFile, {
    name,
    exported: Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)),
    defaultExport: Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)),
    decorators: decoratorsOf(ts, node).map((d) => decoratorFact(ts, d, sourceFile)),
    members: (node.members ?? []).map((member) => classMemberFact(ts, member, sourceFile)),
  });
}

function jsxTagName(node, sourceFile) {
  return node.tagName?.getText(sourceFile) ?? '<unknown>';
}

function jsxAttributeFact(ts, attribute, sourceFile) {
  if (typeof ts.isJsxSpreadAttribute === 'function' && ts.isJsxSpreadAttribute(attribute)) {
    return withSpan(attribute, sourceFile, {
      kind: 'spread',
      name: null,
      value: { kind: 'expression', text: attribute.expression.getText(sourceFile) },
    });
  }

  const name = attribute.name?.getText(sourceFile) ?? '<unknown>';
  const initializer = attribute.initializer;
  if (!initializer) {
    return withSpan(attribute, sourceFile, { kind: 'attribute', name, value: { kind: 'literal', value: true } });
  }
  if (typeof ts.isStringLiteral === 'function' && ts.isStringLiteral(initializer)) {
    return withSpan(attribute, sourceFile, { kind: 'attribute', name, value: { kind: 'literal', value: initializer.text } });
  }
  if (typeof ts.isJsxExpression === 'function' && ts.isJsxExpression(initializer)) {
    return withSpan(attribute, sourceFile, {
      kind: 'attribute',
      name,
      value: initializer.expression
        ? literalOrExpression(ts, initializer.expression, sourceFile)
        : { kind: 'missing' },
    });
  }
  return withSpan(attribute, sourceFile, {
    kind: 'attribute',
    name,
    value: { kind: 'expression', text: initializer.getText(sourceFile) },
  });
}

function trackedCallFact(ts, node, sourceFile) {
  return withSpan(node, sourceFile, {
    callee: expressionName(ts, node.expression, sourceFile),
    arguments: node.arguments.map((arg) => literalOrExpression(ts, arg, sourceFile)),
  });
}

function countNodes(ts, sourceFile, maxNodes) {
  let count = 0;
  let exceeded = false;
  function visit(node) {
    if (exceeded) return;
    count++;
    if (count > maxNodes) {
      exceeded = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { count, exceeded };
}

export function analyzeTypeScriptStructure(ts, source, {
  filePath = '<memory>.ts',
  language = 'typescript',
  trackedCalls = [],
  maxBytes = DEFAULT_MAX_BYTES,
  maxNodes = DEFAULT_MAX_NODES,
} = {}) {
  const compilerBackend = createTypeScriptCompilerBackend(ts);
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
  if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0) throw new TypeError('maxNodes must be a positive safe integer');
  const tracked = new Set(validateStringArray(trackedCalls, 'trackedCalls', DEFAULT_MAX_TRACKED_CALLS));

  const inputBytes = Buffer.byteLength(source, 'utf8');
  if (inputBytes > maxBytes) {
    return {
      contract: JS_TS_STRUCTURE_CONTRACT,
      filePath,
      language,
      complete: false,
      syntaxValidated: false,
      runtimeValidated: false,
      typescriptVersion: compilerBackend.typescriptVersion,
      inputBytes,
      nodeCount: 0,
      decoratedClasses: [],
      jsxElements: [],
      trackedCalls: [],
      diagnostics: [{ code: 'input-too-large', message: `input is ${inputBytes} bytes; limit is ${maxBytes}` }],
    };
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(ts, language),
  );
  const parseDiagnostics = Array.isArray(sourceFile.parseDiagnostics) ? sourceFile.parseDiagnostics : [];
  if (parseDiagnostics.length > 0) {
    return {
      contract: JS_TS_STRUCTURE_CONTRACT,
      filePath,
      language,
      complete: false,
      syntaxValidated: false,
      runtimeValidated: false,
      typescriptVersion: compilerBackend.typescriptVersion,
      inputBytes,
      nodeCount: 0,
      decoratedClasses: [],
      jsxElements: [],
      trackedCalls: [],
      diagnostics: parseDiagnostics.map((d) => ({
        code: 'typescript-parse-diagnostic',
        tsCode: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      })),
    };
  }

  const counted = countNodes(ts, sourceFile, maxNodes);
  if (counted.exceeded) {
    return {
      contract: JS_TS_STRUCTURE_CONTRACT,
      filePath,
      language,
      complete: false,
      syntaxValidated: true,
      runtimeValidated: false,
      typescriptVersion: compilerBackend.typescriptVersion,
      inputBytes,
      nodeCount: counted.count,
      decoratedClasses: [],
      jsxElements: [],
      trackedCalls: [],
      diagnostics: [{ code: 'node-limit', message: `AST node limit ${maxNodes} exceeded; no partial structure facts emitted` }],
    };
  }

  const decoratedClasses = [];
  const jsxElements = [];
  const trackedCallFacts = [];
  let jsxIndex = 0;

  function recordJsx(node, parentId) {
    let opening;
    let selfClosing = false;
    let children = [];
    if (typeof ts.isJsxElement === 'function' && ts.isJsxElement(node)) {
      opening = node.openingElement;
      children = node.children ?? [];
    } else if (typeof ts.isJsxSelfClosingElement === 'function' && ts.isJsxSelfClosingElement(node)) {
      opening = node;
      selfClosing = true;
    } else {
      return false;
    }

    const id = `jsx-${jsxIndex++}`;
    const fact = withSpan(node, sourceFile, {
      id,
      parentId,
      tag: jsxTagName(opening, sourceFile),
      selfClosing,
      attributes: (opening.attributes?.properties ?? []).map((a) => jsxAttributeFact(ts, a, sourceFile)),
    });
    jsxElements.push(fact);

    for (const child of children) {
      if (
        (typeof ts.isJsxElement === 'function' && ts.isJsxElement(child))
        || (typeof ts.isJsxSelfClosingElement === 'function' && ts.isJsxSelfClosingElement(child))
      ) {
        recordJsx(child, id);
      } else {
        ts.forEachChild(child, (nested) => visit(nested, id));
      }
    }
    return true;
  }

  function visit(node, jsxParent = null) {
    if (typeof ts.isClassDeclaration === 'function' && ts.isClassDeclaration(node)) {
      const decorators = decoratorsOf(ts, node);
      const memberDecorators = (node.members ?? []).some((member) => decoratorsOf(ts, member).length > 0 || (member.parameters ?? []).some((p) => decoratorsOf(ts, p).length > 0));
      if (decorators.length > 0 || memberDecorators) decoratedClasses.push(classFact(ts, node, sourceFile));
    }

    if (
      (typeof ts.isJsxElement === 'function' && ts.isJsxElement(node))
      || (typeof ts.isJsxSelfClosingElement === 'function' && ts.isJsxSelfClosingElement(node))
    ) {
      if (recordJsx(node, jsxParent)) return;
    }

    if (tracked.size > 0 && typeof ts.isCallExpression === 'function' && ts.isCallExpression(node)) {
      const callee = expressionName(ts, node.expression, sourceFile);
      if (tracked.has(callee)) trackedCallFacts.push(trackedCallFact(ts, node, sourceFile));
    }
    ts.forEachChild(node, (child) => visit(child, jsxParent));
  }

  visit(sourceFile);

  const internal = {
    decoratedClasses,
    jsxElements,
    trackedCalls: trackedCallFacts,
  };
  const positions = [];
  collectSpanPositions(internal, positions);
  const offsets = byteOffsets(source, positions);
  const publicFacts = finalizeSpans(internal, source, offsets);

  publicFacts.decoratedClasses.sort((a, b) => a.source.byteStart - b.source.byteStart || compareText(a.name, b.name));
  publicFacts.jsxElements.sort((a, b) => a.source.byteStart - b.source.byteStart || compareText(a.id, b.id));
  publicFacts.trackedCalls.sort((a, b) => a.source.byteStart - b.source.byteStart || compareText(a.callee, b.callee));

  return {
    contract: JS_TS_STRUCTURE_CONTRACT,
    filePath,
    language,
    complete: true,
    syntaxValidated: true,
    runtimeValidated: false,
    typescriptVersion: compilerBackend.typescriptVersion,
    inputBytes,
    nodeCount: counted.count,
    ...publicFacts,
    diagnostics: [],
  };
}
