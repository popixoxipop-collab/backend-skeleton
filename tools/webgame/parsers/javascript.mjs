import path from 'node:path';

const IDENT_START = /[A-Za-z_$]/;
const IDENT_CONT = /[A-Za-z0-9_$]/;
const ASSET_EXT_RE = /\.(?:glb|gltf|fbx|obj|dae|stl|ply|png|jpe?g|webp|avif|gif|hdr|exr|ktx2?|basis|bin|wasm|mp3|ogg|wav|mp4|webm)(?:[?#].*)?$/i;

function isIdentStart(ch) { return ch != null && IDENT_START.test(ch); }
function isIdentCont(ch) { return ch != null && IDENT_CONT.test(ch); }

function makeLocator(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= offset) lo = mid + 1;
      else hi = mid - 1;
    }
    const lineIndex = Math.max(0, hi);
    return { line: lineIndex + 1, column: offset - starts[lineIndex] + 1 };
  };
}

function decodeString(raw, quote) {
  if (quote === '`') return raw;
  try {
    return JSON.parse(`${quote}${raw}${quote}`);
  } catch {
    return raw.replace(/\\([\\'"bnrtvf0])/g, (_m, c) => ({ b:'\b', n:'\n', r:'\r', t:'\t', v:'\v', f:'\f', 0:'\0', "'":"'", '"':'"', '\\':'\\' }[c] ?? c));
  }
}

export function lexJavaScript(source, { baseOffset = 0, fullText = source, sourcePath = '<memory>' } = {}) {
  const tokens = [];
  const errors = [];
  const locate = makeLocator(fullText);
  let i = 0;

  const push = (type, value, start, end, raw = value) => {
    const absolute = baseOffset + start;
    const { line, column } = locate(absolute);
    tokens.push({ type, value, raw, start: absolute, end: baseOffset + end, line, column, source_path: sourcePath });
  };
  const error = (kind, start, message) => {
    const absolute = baseOffset + start;
    const { line, column } = locate(absolute);
    errors.push({ kind, message, source_path: sourcePath, line, column, offset: absolute });
  };

  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }

    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const start = i;
      i += 2;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') { i += 2; closed = true; break; }
        i++;
      }
      if (!closed) error('syntax', start, 'unterminated block comment');
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i++;
      let raw = '';
      let closed = false;
      while (i < source.length) {
        const c = source[i++];
        if (c === '\\') {
          raw += c;
          if (i < source.length) raw += source[i++];
          continue;
        }
        if (c === quote) { closed = true; break; }
        if (c === '\n' || c === '\r') break;
        raw += c;
      }
      if (!closed) error('syntax', start, 'unterminated string literal');
      else push('string', decodeString(raw, quote), start, i, source.slice(start, i));
      continue;
    }

    if (ch === '`') {
      const start = i++;
      let raw = '';
      let closed = false;
      let escaped = false;
      let interpolationDepth = 0;
      while (i < source.length) {
        const c = source[i++];
        if (escaped) { raw += c; escaped = false; continue; }
        if (c === '\\') { raw += c; escaped = true; continue; }
        if (c === '`' && interpolationDepth === 0) { closed = true; break; }
        if (c === '$' && source[i] === '{') { interpolationDepth++; raw += '${'; i++; continue; }
        if (c === '}' && interpolationDepth > 0) { interpolationDepth--; raw += c; continue; }
        raw += c;
      }
      if (!closed) error('syntax', start, 'unterminated template literal');
      else push('template', raw, start, i, source.slice(start, i));
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i++;
      while (i < source.length && isIdentCont(source[i])) i++;
      push('identifier', source.slice(start, i), start, i);
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = i++;
      while (i < source.length && /[0-9A-Fa-f_xXobOBn.eE+-]/.test(source[i])) i++;
      push('number', source.slice(start, i), start, i);
      continue;
    }

    push('punct', ch, i, i + 1);
    i++;
  }

  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (const t of tokens) {
    if (t.type !== 'punct') continue;
    if (t.value === '(' || t.value === '[' || t.value === '{') stack.push(t);
    else if (pairs[t.value]) {
      const top = stack.at(-1);
      if (!top || top.value !== pairs[t.value]) {
        errors.push({ kind: 'syntax', message: `unmatched ${t.value}`, source_path: sourcePath, line: t.line, column: t.column, offset: t.start });
      } else stack.pop();
    }
  }
  for (const t of stack) errors.push({ kind: 'syntax', message: `unclosed ${t.value}`, source_path: sourcePath, line: t.line, column: t.column, offset: t.start });

  return { tokens, errors };
}

function dottedName(tokens, start) {
  if (tokens[start]?.type !== 'identifier') return null;
  const parts = [tokens[start].value];
  let i = start + 1;
  while (tokens[i]?.value === '.' && tokens[i + 1]?.type === 'identifier') {
    parts.push(tokens[i + 1].value);
    i += 2;
  }
  return { name: parts.join('.'), endIndex: i - 1 };
}

function evidenceFromToken(token, extra = {}) {
  return {
    source_path: token.source_path,
    line: token.line,
    column: token.column,
    offset: token.start,
    ...extra,
  };
}

function findMatchingParen(tokens, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    if (tokens[i].value === '(') depth++;
    else if (tokens[i].value === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function parseJavaScriptSource(source, opts = {}) {
  const { tokens, errors } = lexJavaScript(source, opts);
  const imports = [];
  const dynamicImports = [];
  const constructions = [];
  const calls = [];
  const assets = [];
  const unresolved = [...errors];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.type === 'identifier' && t.value === 'import') {
      if (tokens[i + 1]?.value === '(') {
        const arg = tokens[i + 2];
        if (arg?.type === 'string' && tokens[i + 3]?.value === ')') {
          dynamicImports.push({ specifier: arg.value, literal: true, ...evidenceFromToken(t) });
        } else {
          dynamicImports.push({ specifier: null, literal: false, ...evidenceFromToken(t) });
          unresolved.push({ kind: 'dynamic-import', message: 'dynamic import target is not a string literal', ...evidenceFromToken(t) });
        }
        continue;
      }
      let spec = null;
      for (let j = i + 1; j < Math.min(tokens.length, i + 24); j++) {
        if (tokens[j].type === 'string') { spec = tokens[j]; break; }
        if (tokens[j].value === ';') break;
      }
      if (spec) imports.push({ kind: 'import', specifier: spec.value, ...evidenceFromToken(t) });
      continue;
    }

    if (t.type === 'identifier' && t.value === 'require' && tokens[i + 1]?.value === '(' && tokens[i + 2]?.type === 'string') {
      imports.push({ kind: 'require', specifier: tokens[i + 2].value, ...evidenceFromToken(t) });
      continue;
    }

    if (t.type === 'identifier' && t.value === 'new') {
      const n = dottedName(tokens, i + 1);
      if (n && tokens[n.endIndex + 1]?.value === '(') {
        constructions.push({ name: n.name, ...evidenceFromToken(t) });
      }
      continue;
    }

    if (t.type === 'identifier') {
      const d = dottedName(tokens, i);
      if (d && tokens[d.endIndex + 1]?.value === '(') {
        const openIndex = d.endIndex + 1;
        const closeIndex = findMatchingParen(tokens, openIndex);
        const firstArg = tokens[openIndex + 1];
        const call = { name: d.name, first_string_arg: firstArg?.type === 'string' ? firstArg.value : null, ...evidenceFromToken(t) };
        calls.push(call);
        if (call.first_string_arg && (/(?:^|\.)(?:load|loadAsync)$/i.test(call.name) || call.name === 'fetch') && ASSET_EXT_RE.test(call.first_string_arg)) {
          assets.push({ kind: 'runtime-load', value: call.first_string_arg, ...evidenceFromToken(t) });
        }
        if (closeIndex > -1) i = Math.max(i, d.endIndex);
      }
    }
  }

  for (const imp of imports) {
    if (ASSET_EXT_RE.test(imp.specifier)) assets.push({ kind: 'static-import', value: imp.specifier, source_path: imp.source_path, line: imp.line, column: imp.column, offset: imp.offset });
  }

  return { imports, dynamicImports, constructions, calls, assets, unresolved, token_count: tokens.length };
}

export function parseSourceFile({ sourcePath, text, role = 'active', language = null }) {
  const ext = path.extname(sourcePath).toLowerCase();
  const parsed = parseJavaScriptSource(text, { sourcePath });
  return { source_path: sourcePath, role, language: language ?? ext.slice(1), ...parsed };
}
