// T04: conservative JavaScript/TypeScript lexical source facts.
//
// This layer deliberately does not execute the target project, resolve packages, or claim
// framework semantics. It provides deterministic literal module edges that higher-level adapters
// can consume while retaining explicit unknowns for constructs this bounded lexer cannot prove.

// Provisional T04-internal shape. T01 owns any future stable cross-tool contract.
export const JS_TS_FACTS_CONTRACT = 'bskel.internal.js-ts-source-facts/0';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOKENS = 250_000;
const IDENT_START_RE = /[A-Za-z_$]/;
const IDENT_CONTINUE_RE = /[A-Za-z0-9_$]/;
const REGEX_PRECEDING_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';']);
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'do', 'else', 'yield', 'await', 'void', 'instanceof',
]);

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function diag(code, message, start = null) {
  return { level: 'info', code, message, ...(start === null ? {} : { start }) };
}

function isIdentifierStart(ch) {
  return typeof ch === 'string' && IDENT_START_RE.test(ch);
}

function isIdentifierContinue(ch) {
  return typeof ch === 'string' && IDENT_CONTINUE_RE.test(ch);
}

function readQuotedString(source, start, quote) {
  let i = start + 1;
  let value = '';
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      if (i + 1 >= source.length) return { end: source.length, terminated: false, value: null };
      // Module specifiers with escapes are legal, but decoding JavaScript escapes correctly is a
      // language-parser concern. Preserve the fact as unresolved instead of guessing a value.
      return { end: skipQuotedString(source, start, quote), terminated: true, value: null, escaped: true };
    }
    if (ch === quote) return { end: i + 1, terminated: true, value };
    if (ch === '\n' || ch === '\r') return { end: i, terminated: false, value: null };
    value += ch;
    i++;
  }
  return { end: source.length, terminated: false, value: null };
}

function skipQuotedString(source, start, quote) {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i + 1;
    if (ch === '\n' || ch === '\r') return i;
    i++;
  }
  return source.length;
}

function skipLineComment(source, start) {
  let i = start + 2;
  while (i < source.length && source[i] !== '\n') i++;
  return i;
}

function skipBlockComment(source, start) {
  const end = source.indexOf('*/', start + 2);
  return end === -1 ? source.length : end + 2;
}

function skipTemplate(source, start) {
  let i = start + 1;
  let sawExpression = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') return { end: i + 1, terminated: true, sawExpression };
    if (ch === '$' && source[i + 1] === '{') sawExpression = true;
    i++;
  }
  return { end: source.length, terminated: false, sawExpression };
}

function canStartRegex(previousToken) {
  if (!previousToken) return true;
  if (previousToken.type === 'punct') return REGEX_PRECEDING_PUNCT.has(previousToken.value);
  return previousToken.type === 'identifier' && REGEX_PRECEDING_KEYWORDS.has(previousToken.value);
}

function skipRegex(source, start) {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '\n' || ch === '\r') return start + 1; // probably division; consume only '/'
    if (inClass) {
      if (ch === ']') inClass = false;
      i++;
      continue;
    }
    if (ch === '[') { inClass = true; i++; continue; }
    if (ch === '/') {
      i++;
      while (i < source.length && /[A-Za-z]/.test(source[i])) i++;
      return i;
    }
    i++;
  }
  return start + 1;
}

function tokenize(source, maxTokens) {
  const tokens = [];
  const diagnostics = [];
  let i = 0;
  let previousToken = null;
  while (i < source.length) {
    if (tokens.length >= maxTokens) {
      diagnostics.push(diag('token-limit', `token limit ${maxTokens} reached; no facts are returned from an incomplete token stream`, i));
      return { tokens: [], diagnostics, complete: false };
    }
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && source[i + 1] === '/') { i = skipLineComment(source, i); continue; }
    if (ch === '/' && source[i + 1] === '*') { i = skipBlockComment(source, i); continue; }
    if (ch === '\'' || ch === '"') {
      const r = readQuotedString(source, i, ch);
      const token = { type: 'string', value: r.value, start: i, end: r.end, literalComplete: r.terminated && r.value !== null };
      tokens.push(token); previousToken = token; i = Math.max(r.end, i + 1);
      if (!r.terminated) diagnostics.push(diag('unterminated-string', 'unterminated quoted string; literal module reference will not be trusted', token.start));
      else if (r.escaped) diagnostics.push(diag('escaped-module-literal', 'quoted string contains escapes; module specifier is left unresolved by the lexical layer', token.start));
      continue;
    }
    if (ch === '`') {
      const r = skipTemplate(source, i);
      if (r.sawExpression) diagnostics.push(diag('template-expression-unparsed', 'template literal interpolation is not tokenized by the conservative lexical layer', i));
      if (!r.terminated) diagnostics.push(diag('unterminated-template', 'unterminated template literal', i));
      i = Math.max(r.end, i + 1);
      continue;
    }
    if (ch === '/' && canStartRegex(previousToken)) {
      const end = skipRegex(source, i);
      if (end > i + 1) { i = end; continue; }
    }
    if (isIdentifierStart(ch)) {
      let end = i + 1;
      while (end < source.length && isIdentifierContinue(source[end])) end++;
      const token = { type: 'identifier', value: source.slice(i, end), start: i, end };
      tokens.push(token); previousToken = token; i = end; continue;
    }
    const token = { type: 'punct', value: ch, start: i, end: i + 1 };
    tokens.push(token); previousToken = token; i++;
  }
  return { tokens, diagnostics, complete: true };
}

function findStatementEnd(tokens, start) {
  let brace = 0, paren = 0, bracket = 0;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct') {
      if (t.value === '{') brace++;
      else if (t.value === '}') { if (brace === 0 && paren === 0 && bracket === 0) return i; brace = Math.max(0, brace - 1); }
      else if (t.value === '(') paren++;
      else if (t.value === ')') paren = Math.max(0, paren - 1);
      else if (t.value === '[') bracket++;
      else if (t.value === ']') bracket = Math.max(0, bracket - 1);
      else if (t.value === ';' && brace === 0 && paren === 0 && bracket === 0) return i;
    }
    if (i > start && brace === 0 && paren === 0 && bracket === 0 && t.type === 'identifier' && ['import','export','const','let','var','class','function'].includes(t.value)) {
      return i;
    }
  }
  return tokens.length;
}

function tokenIs(tokens, i, type, value = undefined) {
  const t = tokens[i];
  return Boolean(t && t.type === type && (value === undefined || t.value === value));
}

function parseNamedBindings(tokens, open, close, { typeOnly = false } = {}) {
  const out = [];
  let i = open + 1;
  while (i < close) {
    if (tokenIs(tokens, i, 'punct', ',')) { i++; continue; }
    let itemTypeOnly = typeOnly;
    if (tokenIs(tokens, i, 'identifier', 'type')) { itemTypeOnly = true; i++; }
    if (!tokenIs(tokens, i, 'identifier')) { i++; continue; }
    const imported = tokens[i].value;
    let local = imported;
    i++;
    if (tokenIs(tokens, i, 'identifier', 'as') && tokenIs(tokens, i + 1, 'identifier')) {
      local = tokens[i + 1].value; i += 2;
    }
    out.push({ imported, local, bindingKind: 'named', typeOnly: itemTypeOnly });
    while (i < close && !tokenIs(tokens, i, 'punct', ',')) i++;
  }
  return out;
}

function parseImportBindings(tokens, start, fromIndex) {
  const out = [];
  let i = start + 1;
  let typeOnly = false;
  if (tokenIs(tokens, i, 'identifier', 'type')) { typeOnly = true; i++; }
  if (i >= fromIndex) return { bindings: out, typeOnly };
  if (tokenIs(tokens, i, 'identifier')) {
    out.push({ imported: 'default', local: tokens[i].value, bindingKind: 'default', typeOnly });
    i++;
    if (tokenIs(tokens, i, 'punct', ',')) i++;
  }
  if (tokenIs(tokens, i, 'punct', '*') && tokenIs(tokens, i + 1, 'identifier', 'as') && tokenIs(tokens, i + 2, 'identifier')) {
    out.push({ imported: '*', local: tokens[i + 2].value, bindingKind: 'namespace', typeOnly });
    return { bindings: out, typeOnly };
  }
  if (tokenIs(tokens, i, 'punct', '{')) {
    let close = i + 1;
    while (close < fromIndex && !tokenIs(tokens, close, 'punct', '}')) close++;
    if (close < fromIndex) out.push(...parseNamedBindings(tokens, i, close, { typeOnly }));
  }
  return { bindings: out, typeOnly };
}

function simpleRequireBindings(tokens, requireIndex) {
  const eq = requireIndex - 1;
  if (!tokenIs(tokens, eq, 'punct', '=')) return [];
  const before = eq - 1;
  if (tokenIs(tokens, before, 'identifier')) {
    return [{ imported: 'module.exports', local: tokens[before].value, bindingKind: 'commonjs-default', typeOnly: false }];
  }
  if (tokenIs(tokens, before, 'punct', '}')) {
    let open = before - 1;
    while (open >= 0 && !tokenIs(tokens, open, 'punct', '{')) open--;
    if (open >= 0 && tokenIs(tokens, open - 1, 'identifier') && ['const','let','var'].includes(tokens[open - 1].value)) {
      const out = [];
      let i = open + 1;
      while (i < before) {
        if (tokenIs(tokens, i, 'punct', ',')) { i++; continue; }
        if (!tokenIs(tokens, i, 'identifier')) { i++; continue; }
        const imported = tokens[i].value;
        let local = imported; i++;
        if (tokenIs(tokens, i, 'punct', ':') && tokenIs(tokens, i + 1, 'identifier')) { local = tokens[i + 1].value; i += 2; }
        out.push({ imported, local, bindingKind: 'commonjs-named', typeOnly: false });
        while (i < before && !tokenIs(tokens, i, 'punct', ',')) i++;
      }
      return out;
    }
  }
  return [];
}

function extractEdges(tokens, diagnostics) {
  const edges = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];
    if (t.type !== 'identifier') continue;
    if (t.value === 'import' && !(prev?.type === 'punct' && prev.value === '.')) {
      if (tokenIs(tokens, i + 1, 'punct', '(')) {
        const spec = tokens[i + 2];
        if (spec?.type === 'string' && spec.literalComplete && tokenIs(tokens, i + 3, 'punct', ')')) {
          edges.push({ kind: 'dynamic-import', specifier: spec.value, bindings: [], typeOnly: false, start: t.start, end: tokens[i + 3].end });
        } else {
          diagnostics.push(diag('dynamic-import-nonliteral', 'dynamic import is not a single trusted quoted literal; no module edge emitted', t.start));
        }
        continue;
      }
      const end = findStatementEnd(tokens, i + 1);
      if (tokens[i + 1]?.type === 'string' && tokens[i + 1].literalComplete) {
        edges.push({ kind: 'import', specifier: tokens[i + 1].value, bindings: [], typeOnly: false, start: t.start, end: tokens[i + 1].end });
        continue;
      }
      let from = i + 1;
      while (from < end && !tokenIs(tokens, from, 'identifier', 'from')) from++;
      if (from < end && tokens[from + 1]?.type === 'string' && tokens[from + 1].literalComplete) {
        const parsed = parseImportBindings(tokens, i, from);
        edges.push({ kind: 'import', specifier: tokens[from + 1].value, bindings: parsed.bindings, typeOnly: parsed.typeOnly, start: t.start, end: tokens[from + 1].end });
      } else diagnostics.push(diag('import-unresolved', 'import statement has no trusted quoted module specifier', t.start));
      continue;
    }
    if (t.value === 'export' && !(prev?.type === 'punct' && prev.value === '.')) {
      const end = findStatementEnd(tokens, i + 1);
      let from = i + 1;
      while (from < end && !tokenIs(tokens, from, 'identifier', 'from')) from++;
      if (from < end && tokens[from + 1]?.type === 'string' && tokens[from + 1].literalComplete) {
        edges.push({ kind: 'export-from', specifier: tokens[from + 1].value, bindings: [], typeOnly: tokenIs(tokens, i + 1, 'identifier', 'type'), start: t.start, end: tokens[from + 1].end });
      }
      continue;
    }
    if (t.value === 'require' && !(prev?.type === 'punct' && prev.value === '.')) {
      if (tokenIs(tokens, i + 1, 'punct', '(') && tokens[i + 2]?.type === 'string' && tokens[i + 2].literalComplete && tokenIs(tokens, i + 3, 'punct', ')')) {
        edges.push({ kind: 'require', specifier: tokens[i + 2].value, bindings: simpleRequireBindings(tokens, i), typeOnly: false, start: t.start, end: tokens[i + 3].end });
      } else if (tokenIs(tokens, i + 1, 'punct', '(')) {
        diagnostics.push(diag('require-nonliteral', 'require() is not a single trusted quoted literal; no module edge emitted', t.start));
      }
    }
  }
  return edges;
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
    if (cu !== wanted) throw new Error(`internal span boundary ${wanted} falls inside a surrogate pair`);
    out.set(wanted, bytes); target++;
  }
  return out;
}

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++;
  return line;
}

function addSpans(source, edges) {
  const offsets = byteOffsets(source, edges.flatMap((e) => [e.start, e.end]));
  return edges.map(({ start, end, ...e }) => ({
    ...e,
    basis: 'lexical-literal',
    resolution: 'unresolved',
    source: {
      byteStart: offsets.get(start),
      byteEnd: offsets.get(end),
      line: lineAt(source, start),
    },
  }));
}

function addDiagnosticSpans(source, diagnostics) {
  const positions = diagnostics.flatMap((d) => d.start === undefined ? [] : [d.start]);
  const offsets = byteOffsets(source, positions);
  return diagnostics.map(({ start, ...d }) => start === undefined ? d : ({
    ...d,
    source: { byteStart: offsets.get(start), line: lineAt(source, start) },
  }));
}

export function analyzeJsTsSource(source, {
  filePath = '<memory>',
  language = 'javascript',
  maxBytes = DEFAULT_MAX_BYTES,
  maxTokens = DEFAULT_MAX_TOKENS,
} = {}) {
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  if (!['javascript', 'typescript', 'jsx', 'tsx'].includes(language)) throw new TypeError(`unsupported language mode: ${language}`);
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
      diagnostics: [diag('input-too-large', `input is ${inputBytes} bytes; limit is ${maxBytes}; no partial module facts emitted`)],
    };
  }

  const lexed = tokenize(source, maxTokens);
  if (!lexed.complete) {
    return { contract: JS_TS_FACTS_CONTRACT, filePath, language, complete: false, syntaxValidated: false, inputBytes, moduleEdges: [], diagnostics: addDiagnosticSpans(source, lexed.diagnostics) };
  }
  const diagnostics = [...lexed.diagnostics];
  const edges = addSpans(source, extractEdges(lexed.tokens, diagnostics));
  edges.sort((a, b) => a.source.byteStart - b.source.byteStart || compareText(a.kind, b.kind) || compareText(a.specifier, b.specifier));
  diagnostics.sort((a, b) => (a.start ?? -1) - (b.start ?? -1) || compareText(a.code, b.code));
  const publicDiagnostics = addDiagnosticSpans(source, diagnostics);
  return {
    contract: JS_TS_FACTS_CONTRACT,
    filePath,
    language,
    complete: true,
    syntaxValidated: false,
    inputBytes,
    moduleEdges: edges,
    diagnostics: publicDiagnostics,
  };
}
