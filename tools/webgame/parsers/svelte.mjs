import { parseJavaScriptSource } from './javascript.mjs';

function lineColumn(text, offset) {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

export function parseSvelteSource(text, { sourcePath = '<memory>', role = 'active' } = {}) {
  const scripts = [];
  const unresolved = [];
  const commentRanges = [];
  const commentRe = /<!--[\s\S]*?-->/g;
  let comment;
  while ((comment = commentRe.exec(text)) != null) commentRanges.push([comment.index, commentRe.lastIndex]);
  const inHtmlComment = (offset) => commentRanges.some(([start, end]) => offset >= start && offset < end);
  const scriptRe = /<script\b([^>]*)>/gi;
  let match;
  while ((match = scriptRe.exec(text)) != null) {
    if (inHtmlComment(match.index)) continue;
    const openEnd = scriptRe.lastIndex;
    const close = text.toLowerCase().indexOf('</script>', openEnd);
    if (close < 0) {
      const pos = lineColumn(text, match.index);
      unresolved.push({ kind: 'syntax', message: 'unclosed <script> block', source_path: sourcePath, ...pos, offset: match.index });
      break;
    }
    const attributes = match[1] ?? '';
    const content = text.slice(openEnd, close);
    const parsed = parseJavaScriptSource(content, { baseOffset: openEnd, fullText: text, sourcePath });
    scripts.push({
      context: /context\s*=\s*["']module["']|module\b/i.test(attributes) ? 'module' : 'instance',
      attributes,
      start_offset: openEnd,
      end_offset: close,
      ...parsed,
    });
    unresolved.push(...parsed.unresolved);
    scriptRe.lastIndex = close + '</script>'.length;
  }

  const combine = (key) => scripts.flatMap((s) => s[key] ?? []);
  return {
    source_path: sourcePath,
    role,
    language: 'svelte',
    scripts: scripts.map(({ imports, dynamicImports, constructions, calls, assets, unresolved: _u, ...meta }) => meta),
    imports: combine('imports'),
    dynamicImports: combine('dynamicImports'),
    constructions: combine('constructions'),
    calls: combine('calls'),
    assets: combine('assets'),
    unresolved,
    token_count: scripts.reduce((n, s) => n + s.token_count, 0),
  };
}
