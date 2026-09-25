import crypto from 'node:crypto';
import path from 'node:path';

export const DSL_FACTS_CONTRACT = 'sbf.dsl-facts/1';

const FACT_STATUSES = new Set(['literal', 'partial', 'unknown']);
const FACT_KINDS = new Set([
  'namespace', 'scope', 'group', 'resource', 'route', 'concern',
  'attribute', 'dynamic-block', 'unsupported',
]);

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function assertRelativeFile(file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file)) {
    throw new TypeError('file must be a non-empty repository-relative path');
  }
  const parts = file.replaceAll('\\', '/').split('/');
  if (parts.some((part) => part === '..' || part === '')) {
    throw new TypeError('file must not escape the repository root');
  }
  return parts.join('/');
}

function lineAndColumnAt(source, offset) {
  const before = source.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - lastNewline };
}

function sourceRef(source, file, start, end) {
  const loc = lineAndColumnAt(source, start);
  const text = source.slice(start, end);
  return {
    file, start, end, line: loc.line, column: loc.column, sha256: sha256(text),
  };
}

function factId({ framework, file, start, end, kind, name }) {
  const raw = [DSL_FACTS_CONTRACT, framework, file, start, end, kind, name ?? ''].join('\0');
  return `dslf_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 20)}`;
}

function sanitizeJson(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, sanitizeJson(v)]),
    );
  }
  throw new TypeError(`DSL fact attributes must be JSON-shaped, got ${typeof value}`);
}

function makeFact({
  source, file, framework, language, kind, status = 'literal', name,
  start, end, context = [], attributes = {}, unknownReason = null,
}) {
  if (!FACT_KINDS.has(kind)) throw new TypeError(`unknown DSL fact kind: ${kind}`);
  if (!FACT_STATUSES.has(status)) throw new TypeError(`unknown DSL fact status: ${status}`);
  if (status === 'unknown' && !unknownReason) {
    throw new TypeError('unknown DSL facts require unknownReason');
  }
  return {
    id: factId({ framework, file, start, end, kind, name }),
    framework,
    language,
    kind,
    status,
    declaration: { name: name ?? null },
    context: context.map((entry) => sanitizeJson(entry)),
    source: sourceRef(source, file, start, end),
    attributes: sanitizeJson(attributes),
    ...(unknownReason ? { unknownReason } : {}),
  };
}

function envelope({ source, file, framework, language, facts }) {
  return {
    contract: DSL_FACTS_CONTRACT,
    framework,
    language,
    source: { file, sha256: sha256(source), bytes: Buffer.byteLength(source) },
    facts,
  };
}

function stripRubyComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) { escaped = false; continue; }
    if (quote && ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function bracketDelta(text) {
  let delta = 0;
  let quote = null;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (quote && ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if ('([{'.includes(ch)) delta++;
    else if (')]}'.includes(ch)) delta--;
  }
  return delta;
}

function rubyStatements(source) {
  const lines = source.split(/(?<=\n)/);
  const out = [];
  let pending = '';
  let start = 0;
  let end = 0;
  let depth = 0;
  let cursor = 0;

  for (const rawLine of lines) {
    const rawNoNl = rawLine.replace(/\r?\n$/, '');
    const code = stripRubyComment(rawNoNl).trim();
    if (!pending && !code) { cursor += rawLine.length; continue; }
    if (!pending) start = cursor + rawNoNl.indexOf(code);
    pending += `${pending ? ' ' : ''}${code}`;
    end = cursor + rawNoNl.length;
    depth += bracketDelta(code);
    cursor += rawLine.length;
    if (depth > 0 || /(?:,|=>|\\)\s*$/.test(code)) continue;
    out.push({ text: pending.trim(), start, end });
    pending = '';
    depth = 0;
  }
  if (pending) out.push({ text: pending.trim(), start, end });
  return out;
}

function firstRubyLiteral(args) {
  const m = args.match(/^\s*\(?\s*(?::([a-zA-Z_]\w*)|["']([^"']*)["'])/);
  return m ? (m[1] ?? m[2]) : null;
}

function rubyOptionLiteral(args, name) {
  const re = new RegExp(`(?:\\b${name}\\s*:|:${name}\\s*=>)\\s*(?:"([^"]*)"|'([^']*)'|:([a-zA-Z_]\\w*))`);
  const m = args.match(re);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

function rubyOptionPresent(args, name) {
  return new RegExp(`(?:\\b${name}\\s*:|:${name}\\s*=>)`).test(args);
}

function rubyOptionNil(args, name) {
  return new RegExp(`(?:\\b${name}\\s*:|:${name}\\s*=>)\\s*nil\\b`).test(args);
}

function rubyOptionSymbols(args, name) {
  const start = args.search(new RegExp(`(?:\\b${name}\\s*:|:${name}\\s*=>)`));
  if (start === -1) return null;
  const tail = args.slice(start).replace(new RegExp(`^(?:${name}\\s*:|:${name}\\s*=>)\\s*`), '');
  const percent = tail.match(/^%i[\[(]([^\])]+)[\])]/);
  if (percent) return percent[1].split(/\s+/).filter(Boolean);
  const array = tail.match(/^\[([^\]]*)\]/);
  if (array) return [...array[1].matchAll(/:([a-zA-Z_]\w*)/g)].map((m) => m[1]);
  const one = tail.match(/^:([a-zA-Z_]\w*)/);
  return one ? [one[1]] : null;
}

function rubyContextSnapshot(stack) {
  return stack
    .filter((entry) => entry.kind !== 'root')
    .map(({ kind, name, path: routePath, module, dynamic, singular, param, routeMode }) => ({
      kind, name, path: routePath, module, dynamic: Boolean(dynamic),
      ...(singular !== undefined ? { singular: Boolean(singular) } : {}),
      ...(param != null ? { param } : {}),
      ...(routeMode ? { routeMode } : {}),
    }));
}

export function extractRailsDslFacts(source, { file = 'config/routes.rb' } = {}) {
  file = assertRelativeFile(file);
  const framework = 'rails';
  const language = 'ruby';
  const facts = [];
  const stack = [{ kind: 'root', name: null, path: null, module: null, dynamic: false }];

  for (const statement of rubyStatements(source)) {
    const src = statement.text;
    if (!src) continue;
    if (/^end\b/.test(src)) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const context = rubyContextSnapshot(stack);

    if (
      /^(?:if|unless|while|until|for)\b/.test(src)
      || /\.each\b[\s\S]*\bdo(?:\s*\|[^|]*\|)?\s*$/.test(src)
    ) {
      facts.push(makeFact({
        source, file, framework, language,
        kind: 'dynamic-block', status: 'unknown',
        name: src.split(/\s+/)[0],
        start: statement.start, end: statement.end, context,
        attributes: { expression: src },
        unknownReason: 'runtime-dependent Ruby control flow is not expanded statically',
      }));
      if (
        /\bdo(?:\s*\|[^|]*\|)?\s*$/.test(src)
        || /^(?:if|unless|while|until|for)\b/.test(src)
      ) {
        stack.push({ kind: 'dynamic', name: null, path: null, module: null, dynamic: true });
      }
      continue;
    }

    const namespace = src.match(/^namespace\b\s*(.*)$/);
    if (namespace && /\bdo\s*$/.test(src)) {
      const args = namespace[1].replace(/\s+do\s*$/, '');
      const name = firstRubyLiteral(args);
      if (!name || name.includes('#{')) {
        facts.push(makeFact({
          source, file, framework, language,
          kind: 'namespace', status: 'unknown', name: null,
          start: statement.start, end: statement.end, context,
          attributes: { raw: args },
          unknownReason: 'namespace is not a literal symbol/string',
        }));
        stack.push({ kind: 'namespace', name: null, path: null, module: null, dynamic: true });
      } else {
        const attrs = {
          path: rubyOptionLiteral(args, 'path') ?? name,
          module: rubyOptionLiteral(args, 'module') ?? name,
        };
        facts.push(makeFact({
          source, file, framework, language,
          kind: 'namespace', name,
          start: statement.start, end: statement.end, context,
          attributes: attrs,
        }));
        stack.push({ kind: 'namespace', name, path: attrs.path, module: attrs.module, dynamic: false });
      }
      continue;
    }

    const scope = src.match(/^scope\b\s*(.*)$/);
    if (scope && /\bdo\s*$/.test(src)) {
      const args = scope[1].replace(/\s+do\s*$/, '');
      const pathPresent = rubyOptionPresent(args, 'path');
      const modulePresent = rubyOptionPresent(args, 'module');
      const pathNil = rubyOptionNil(args, 'path');
      const moduleNil = rubyOptionNil(args, 'module');
      const firstLiteral = firstRubyLiteral(args);
      const pathLiteral = rubyOptionLiteral(args, 'path') ?? (!pathPresent ? firstLiteral : null);
      const moduleLiteral = rubyOptionLiteral(args, 'module');
      const optionOnlyStart = /^\s*\(?\s*(?:[a-zA-Z_]\w*\s*:|:[a-zA-Z_]\w*\s*=>)/.test(args);
      const positionalDynamic = !pathPresent && !modulePresent && !optionOnlyStart && firstLiteral == null && args.trim() !== '';
      const dynamic = src.includes('#{')
        || (pathPresent && pathLiteral == null && !pathNil)
        || (modulePresent && moduleLiteral == null && !moduleNil)
        || positionalDynamic;
      facts.push(makeFact({
        source, file, framework, language,
        kind: 'scope', status: dynamic ? 'unknown' : 'literal',
        name: pathLiteral ?? moduleLiteral,
        start: statement.start, end: statement.end, context,
        attributes: {
          path: pathLiteral,
          pathExplicitNil: pathNil,
          module: moduleLiteral,
          moduleExplicitNil: moduleNil,
          raw: args,
        },
        ...(dynamic ? { unknownReason: 'scope path/module is not a supported literal form' } : {}),
      }));
      stack.push({
        kind: 'scope', name: pathLiteral ?? moduleLiteral,
        path: pathLiteral, module: moduleLiteral, dynamic,
      });
      continue;
    }

    const inlineRouteMode = src.match(/^(member|collection)\s*\{\s*(get|post|put|patch|delete)\b\s*(.*?)\s*\}\s*$/);
    if (inlineRouteMode) {
      const routeMode = inlineRouteMode[1];
      const verb = inlineRouteMode[2];
      const args = inlineRouteMode[3];
      const routePath = firstRubyLiteral(args);
      const target = args.match(/(?:\bto\s*:|=>)\s*["']([^"']+)#([a-zA-Z_]\w*)["']/);
      const inlineContext = [...context, { kind: 'route-mode', name: routeMode, path: null, module: null, dynamic: false, routeMode }];
      const dynamic = routePath == null || routePath.includes('#{') || context.some((entry) => entry.dynamic);
      facts.push(makeFact({
        source, file, framework, language,
        kind: 'route',
        status: dynamic ? 'unknown' : (target ? 'literal' : 'partial'),
        name: verb,
        start: statement.start, end: statement.end, context: inlineContext,
        attributes: {
          method: verb.toUpperCase(),
          path: routePath,
          controller: target?.[1] ?? null,
          action: target?.[2] ?? null,
          routeMode,
        },
        ...(dynamic ? { unknownReason: 'route path or enclosing context is dynamic' } : {}),
      }));
      continue;
    }

    const routeModeBlock = src.match(/^(member|collection)\b[\s\S]*\bdo\s*$/);
    if (routeModeBlock) {
      stack.push({
        kind: 'route-mode',
        name: routeModeBlock[1],
        path: null,
        module: null,
        routeMode: routeModeBlock[1],
        dynamic: false,
      });
      continue;
    }

    const resource = src.match(/^(resources|resource)\b\s*(.*)$/);
    if (resource) {
      const args = resource[2].replace(/\s+do\s*$/, '');
      const name = firstRubyLiteral(args);
      const dynamic = !name || name.includes('#{') || context.some((entry) => entry.dynamic);
      const attrs = {
        singular: resource[1] === 'resource',
        path: rubyOptionLiteral(args, 'path'),
        controller: rubyOptionLiteral(args, 'controller'),
        param: rubyOptionLiteral(args, 'param'),
        only: rubyOptionSymbols(args, 'only'),
        except: rubyOptionSymbols(args, 'except'),
      };
      facts.push(makeFact({
        source, file, framework, language,
        kind: 'resource', status: dynamic ? 'unknown' : 'literal', name,
        start: statement.start, end: statement.end, context,
        attributes: attrs,
        ...(dynamic ? { unknownReason: 'resource name or enclosing context is dynamic' } : {}),
      }));
      if (/\bdo\s*$/.test(src)) {
        stack.push({
          kind: 'resource', name, path: attrs.path ?? name,
          module: null, dynamic,
          singular: attrs.singular,
          param: attrs.param,
        });
      }
      continue;
    }

    const concern = src.match(/^(concern|concerns)\b\s*(.*)$/);
    if (concern) {
      const name = firstRubyLiteral(concern[2]);
      facts.push(makeFact({
        source, file, framework, language,
        kind: 'concern', status: 'unknown', name,
        start: statement.start, end: statement.end, context,
        attributes: { declaration: concern[1], raw: concern[2] },
        unknownReason: 'Rails concern expansion requires a separate declaration/use-site resolution pass',
      }));
      if (/\bdo\s*$/.test(src)) {
        stack.push({ kind: 'concern', name, path: null, module: null, dynamic: true });
      }
      continue;
    }

    const explicit = src.match(/^(get|post|put|patch|delete)\b\s*(.*)$/);
    if (explicit) {
      const routePath = firstRubyLiteral(explicit[2]);
      const target = explicit[2].match(/(?:\bto\s*:|=>)\s*["']([^"']+)#([a-zA-Z_]\w*)["']/);
      const dynamic = routePath == null || routePath.includes('#{') || context.some((entry) => entry.dynamic);
      facts.push(makeFact({
        source, file, framework, language,
        kind: 'route',
        status: dynamic ? 'unknown' : (target ? 'literal' : 'partial'),
        name: explicit[1],
        start: statement.start, end: statement.end, context,
        attributes: {
          method: explicit[1].toUpperCase(),
          path: routePath,
          controller: target?.[1] ?? null,
          action: target?.[2] ?? null,
          routeMode: rubyOptionLiteral(explicit[2], 'on'),
        },
        ...(dynamic ? { unknownReason: 'route path or enclosing context is dynamic' } : {}),
      }));
      continue;
    }

    if (/^(?:draw|mount|direct|resolve|match)\b/.test(src)) {
      const name = src.match(/^([a-zA-Z_]\w*)/)?.[1] ?? 'unsupported';
      facts.push(makeFact({
        source, file, framework, language,
        kind: 'unsupported', status: 'unknown', name,
        start: statement.start, end: statement.end, context,
        attributes: { raw: src },
        unknownReason: 'Rails DSL form is not statically expanded by the shared fact layer',
      }));
      if (/\bdo\s*$/.test(src)) {
        stack.push({ kind: 'unsupported', name, path: null, module: null, dynamic: true });
      }
    }
  }

  return envelope({ source, file, framework, language, facts });
}

function phpStripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
    .split('\n')
    .map((line) => {
      let quote = null;
      let escaped = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (escaped) { escaped = false; continue; }
        if (quote && ch === '\\') { escaped = true; continue; }
        if (quote) { if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '/' && line[i + 1] === '/') {
          return line.slice(0, i) + ' '.repeat(line.length - i);
        }
      }
      return line;
    })
    .join('\n');
}

function phpLiteral(input) {
  const m = input.match(/^\s*["']([^"']*)["']/);
  return m?.[1] ?? null;
}

function laravelContext(stack) {
  return stack.map((entry) => ({
    kind: 'group',
    prefix: entry.prefix ?? null,
    middleware: entry.middleware ?? [],
    name: entry.name ?? null,
    dynamic: Boolean(entry.dynamic),
  }));
}

function parseLaravelChain(chain) {
  const prefix = chain.match(/(?:Route::|->)prefix\(\s*["']([^"']+)["']\s*\)/)?.[1] ?? null;
  const name = chain.match(/->name\(\s*["']([^"']+)["']\s*\)/)?.[1] ?? null;
  const middlewareRaw = chain.match(/(?:Route::|->)middleware\(([^)]*)\)/)?.[1] ?? null;
  const middleware = middlewareRaw
    ? [...middlewareRaw.matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
    : [];
  const dynamic = /(?:Route::|->)(?:prefix|name|middleware)\(\s*\$/.test(chain);
  return { prefix, name, middleware, dynamic };
}

export function extractLaravelDslFacts(source, { file = 'routes/api.php' } = {}) {
  file = assertRelativeFile(file);
  const framework = 'laravel';
  const language = 'php';
  const clean = phpStripComments(source);
  const facts = [];
  const stack = [];
  const lines = clean.split(/(?<=\n)/);
  let cursor = 0;

  for (const rawLine of lines) {
    const text = rawLine.replace(/\r?\n$/, '');
    const trimmed = text.trim();
    const start = cursor + Math.max(0, text.indexOf(trimmed));
    const end = cursor + text.length;
    cursor += rawLine.length;
    if (!trimmed) continue;
    if (/^\}\);?\s*$/.test(trimmed)) {
      if (stack.length) stack.pop();
      continue;
    }
    const context = laravelContext(stack);

    if (
      /^Route::(?:prefix|middleware|name|group)\b/.test(trimmed)
      && (/->group\s*\(/.test(trimmed) || /^Route::group\s*\(/.test(trimmed))
    ) {
      let attrs = parseLaravelChain(trimmed);
      const arrayGroup = trimmed.match(/^Route::group\s*\(\s*\[([\s\S]*?)\]\s*,/);
      if (arrayGroup) {
        const body = arrayGroup[1];
        attrs = {
          prefix: body.match(/["']prefix["']\s*=>\s*["']([^"']+)["']/)?.[1] ?? null,
          name: body.match(/["']as["']\s*=>\s*["']([^"']+)["']/)?.[1] ?? null,
          middleware: [...body.matchAll(
            /["']middleware["']\s*=>\s*(?:\[([^\]]*)\]|["']([^"']+)["'])/g,
          )].flatMap((m) => (
            m[2]
              ? [m[2]]
              : [...(m[1] ?? '').matchAll(/["']([^"']+)["']/g)].map((x) => x[1])
          )),
          dynamic: /["'](?:prefix|as|middleware)["']\s*=>\s*\$/.test(body),
        };
      }
      facts.push(makeFact({
        source, file, framework, language,
        kind: 'group', status: attrs.dynamic ? 'unknown' : 'literal',
        name: attrs.prefix ?? attrs.name,
        start, end, context,
        attributes: attrs,
        ...(attrs.dynamic ? { unknownReason: 'Laravel group metadata is runtime-dependent' } : {}),
      }));
      stack.push({ ...attrs });
      continue;
    }

    const route = trimmed.match(/^Route::(get|post|put|patch|delete|options|any|match)\s*\((.*)$/);
    if (route) {
      const routePath = phpLiteral(route[2]);
      const chain = trimmed.slice(trimmed.indexOf(')') + 1);
      const routeName = chain.match(/->name\(\s*["']([^"']+)["']\s*\)/)?.[1] ?? null;
      const dynamic = routePath == null || context.some((entry) => entry.dynamic);
      const methods = route[1] === 'match'
        ? [...route[2].matchAll(/["'](GET|POST|PUT|PATCH|DELETE|OPTIONS)["']/gi)]
          .map((m) => m[1].toUpperCase())
        : [route[1].toUpperCase()];
      facts.push(makeFact({
        source, file, framework, language,
        kind: 'route',
        status: dynamic
          ? 'unknown'
          : (route[1] === 'any' || (route[1] === 'match' && methods.length === 0) ? 'partial' : 'literal'),
        name: routeName ?? route[1],
        start, end, context,
        attributes: { methods, path: routePath, routeName },
        ...(dynamic ? { unknownReason: 'Laravel route URI or enclosing group is dynamic' } : {}),
      }));
      continue;
    }

    const resource = trimmed.match(/^Route::(apiResource|resource)\s*\((.*)$/);
    if (resource) {
      const name = phpLiteral(resource[2]);
      const onlyBody = trimmed.match(/->only\s*\(\s*\[([^\]]*)\]\s*\)/)?.[1];
      const exceptBody = trimmed.match(/->except\s*\(\s*\[([^\]]*)\]\s*\)/)?.[1];
      const list = (body) => (
        body ? [...body.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]) : null
      );
      const dynamic = !name || context.some((entry) => entry.dynamic);
      facts.push(makeFact({
        source, file, framework, language,
        kind: 'resource',
        status: dynamic ? 'unknown' : 'literal',
        name, start, end, context,
        attributes: {
          apiOnly: resource[1] === 'apiResource',
          only: list(onlyBody),
          except: list(exceptBody),
        },
        ...(dynamic ? { unknownReason: 'Laravel resource URI or enclosing group is dynamic' } : {}),
      }));
      continue;
    }

    if (/^Route::macro\b/.test(trimmed)) {
      facts.push(makeFact({
        source, file, framework, language,
        kind: 'unsupported', status: 'unknown', name: 'macro',
        start, end, context,
        attributes: { raw: trimmed },
        unknownReason: 'Laravel Route::macro changes DSL semantics at runtime and is not expanded statically',
      }));
    }
  }

  return envelope({ source, file, framework, language, facts });
}

function splitAttributeArgs(args) {
  const parts = [];
  let quote = null;
  let depth = 0;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (escaped) { escaped = false; continue; }
    if (quote && ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if ('[({'.includes(ch)) depth++;
    else if ('])}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(args.slice(start).trim());
  return parts.filter(Boolean);
}

function balancedPhpDelimiterEnd(source, start, open, close) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (escaped) { escaped = false; continue; }
    if (quote && ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

function phpAttributeGroups(source) {
  const groups = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('#[', cursor);
    if (start === -1) break;
    const end = balancedPhpDelimiterEnd(source, start + 1, '[', ']');
    if (end == null) break;
    groups.push({ start, end, bodyStart: start + 2, body: source.slice(start + 2, end - 1) });
    cursor = end;
  }
  return groups;
}

function symfonyRouteCalls(group) {
  const calls = [];
  const re = /(?:^|,)\s*(?:\\?Symfony\\Component\\Routing\\(?:Annotation|Attribute)\\)?Route\s*\(/g;
  for (const match of group.body.matchAll(re)) {
    const open = group.body.indexOf('(', match.index);
    if (open === -1) continue;
    const end = balancedPhpDelimiterEnd(group.body, open, '(', ')');
    if (end == null) continue;
    calls.push({
      start: group.bodyStart + match.index + match[0].indexOf('Route'),
      end: group.bodyStart + end,
      args: group.body.slice(open + 1, end - 1),
    });
  }
  return calls;
}

function skipFollowingPhpAttributes(source, offset) {
  let cursor = offset;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? '')) cursor++;
    if (source.startsWith('//', cursor)) {
      const end = source.indexOf('\n', cursor + 2);
      cursor = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2);
      if (end === -1) break;
      cursor = end + 2;
      continue;
    }
    if (source[cursor] === '#' && source[cursor + 1] !== '[') {
      const end = source.indexOf('\n', cursor + 1);
      cursor = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.slice(cursor, cursor + 2) !== '#[') break;
    const end = balancedPhpDelimiterEnd(source, cursor + 1, '[', ']');
    if (end == null) break;
    cursor = end;
  }
  return source.slice(cursor);
}

export function extractSymfonyRouteAttributeFacts(
  source,
  { file = 'src/Controller/Controller.php' } = {},
) {
  file = assertRelativeFile(file);
  const framework = 'symfony';
  const language = 'php';
  const facts = [];

  for (const group of phpAttributeGroups(source)) {
    const calls = symfonyRouteCalls(group);
    if (calls.length === 0) continue;
    const after = skipFollowingPhpAttributes(source, group.end);
    const classTarget = /^\s*(?:(?:final|abstract|readonly)\s+)*class\s+([A-Za-z_]\w*)/.exec(after);
    const methodTarget = /^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+([A-Za-z_]\w*)/.exec(after);
    const target = classTarget ?? methodTarget;
    const targetKind = classTarget ? 'class' : methodTarget ? 'method' : null;

    for (const call of calls) {
      const args = splitAttributeArgs(call.args);
      const pathLiteral = phpLiteral(args[0] ?? '')
        ?? args.find((entry) => /^path\s*:/.test(entry))
          ?.match(/path\s*:\s*["']([^"']+)["']/)?.[1]
        ?? null;
      const routeName = args.find((entry) => /^name\s*:/.test(entry))
        ?.match(/name\s*:\s*["']([^"']+)["']/)?.[1]
        ?? null;
      const methodsArg = args.find((entry) => /^methods\s*:/.test(entry)) ?? '';
      const methods = [...methodsArg.matchAll(/["']([A-Z]+)["']/g)].map((x) => x[1]);
      const status = pathLiteral ? (target ? 'literal' : 'partial') : 'unknown';
      facts.push(makeFact({
        source, file, framework, language,
        kind: 'attribute', status, name: routeName ?? 'Route',
        start: call.start, end: call.end, context: [],
        attributes: {
          path: pathLiteral,
          routeName,
          methods,
          targetKind,
          targetName: target?.[1] ?? null,
        },
        ...(status === 'unknown'
          ? { unknownReason: 'Symfony Route attribute path is not a supported literal' }
          : {}),
      }));
    }
  }

  return envelope({ source, file, framework, language, facts });
}

export function extractDslFacts({ source, file, framework }) {
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  switch (framework) {
    case 'rails': return extractRailsDslFacts(source, { file });
    case 'laravel': return extractLaravelDslFacts(source, { file });
    case 'symfony': return extractSymfonyRouteAttributeFacts(source, { file });
    default: throw new TypeError(`unsupported Ruby/PHP DSL framework: ${framework}`);
  }
}

export function assertDslFactsEnvelope(value) {
  if (!value || value.contract !== DSL_FACTS_CONTRACT) {
    throw new TypeError(`expected ${DSL_FACTS_CONTRACT}`);
  }
  if (!Array.isArray(value.facts)) throw new TypeError('facts must be an array');

  const ids = new Set();
  for (const fact of value.facts) {
    if (
      !fact
      || !FACT_KINDS.has(fact.kind)
      || !FACT_STATUSES.has(fact.status)
    ) {
      throw new TypeError('invalid DSL fact');
    }
    if (fact.framework !== value.framework || fact.language !== value.language) {
      throw new TypeError('fact/envelope framework mismatch');
    }
    if (ids.has(fact.id)) throw new TypeError(`duplicate DSL fact id: ${fact.id}`);
    ids.add(fact.id);
    if (
      !fact.source
      || fact.source.file !== value.source.file
      || !Number.isInteger(fact.source.start)
      || !Number.isInteger(fact.source.end)
      || fact.source.start < 0
      || fact.source.end < fact.source.start
    ) {
      throw new TypeError('invalid DSL fact source ref');
    }
    if (fact.status === 'unknown' && !fact.unknownReason) {
      throw new TypeError('unknown facts require unknownReason');
    }
    if (
      Object.hasOwn(fact, 'operationId')
      || Object.hasOwn(fact.attributes ?? {}, 'operationId')
    ) {
      throw new TypeError('DSL facts must not claim an API operationId');
    }
  }
  return true;
}
