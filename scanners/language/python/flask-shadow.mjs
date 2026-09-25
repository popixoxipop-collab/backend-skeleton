import { resolveValueSymbol } from './resolver.mjs';

const DIRECT_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function resolvedFull(project, moduleId, value) {
  if (!value || value.kind !== 'symbol') return null;
  const ref = resolveValueSymbol(project, moduleId, value);
  if (ref.status !== 'resolved') return null;
  return { ...ref, full: [ref.module, ref.name].filter(Boolean).join('.') };
}

function literalString(value) {
  return value?.kind === 'constant' && typeof value.value === 'string' ? value.value : null;
}

function keyword(call, name) {
  return (call?.keywords || []).find((item) => item.name === name)?.value || null;
}

function literalMethods(value) {
  if (!value || value.kind !== 'sequence' || !['list', 'tuple', 'set'].includes(value.container)) return null;
  const methods = [];
  for (const item of value.items || []) {
    const method = literalString(item);
    if (method === null) return null;
    methods.push(method.toUpperCase());
  }
  return [...new Set(methods)].sort();
}

function joinLiteralPrefix(prefix, localPath) {
  if (prefix === '') return localPath;
  const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const s = localPath.startsWith('/') ? localPath : `/${localPath}`;
  return `${p}${s}` || '/';
}

function routeKey(item) {
  return `${item.module}:${item.function}:${item.path}:${item.methods.join(',')}`;
}

export function buildFlaskRouteShadow(project) {
  const declarations = new Map();
  const registrations = [];
  const unknowns = [];

  for (const mod of project.list()) {
    for (const assignment of mod.facts.assignments || []) {
      const variable = assignment.targets?.[0];
      const call = assignment.value;
      if (typeof variable !== 'string' || call?.kind !== 'call') continue;
      const callee = resolvedFull(project, mod.moduleId, call.callee);
      if (!callee || !['flask.Flask', 'flask.Blueprint'].includes(callee.full)) continue;
      const kind = callee.full === 'flask.Flask' ? 'app' : 'blueprint';
      const prefixValue = kind === 'blueprint' ? keyword(call, 'url_prefix') : null;
      const prefix = prefixValue ? literalString(prefixValue) : '';
      declarations.set(`${mod.moduleId}#${variable}`, {
        module: mod.moduleId,
        variable,
        kind,
        prefix,
        prefixStatus: prefixValue && prefix === null ? 'unknown' : 'verified',
        line: assignment.line,
      });
    }
  }

  for (const mod of project.list()) {
    for (const fn of mod.facts.functions || []) {
      for (const decorator of fn.decorators || []) {
        if (decorator?.kind !== 'call' || decorator.callee?.kind !== 'symbol') continue;
        const parts = decorator.callee.name.split('.');
        if (parts.length !== 2) continue;
        const [receiver, member] = parts;
        if (member !== 'route' && !DIRECT_VERBS.has(member)) continue;
        const decl = declarations.get(`${mod.moduleId}#${receiver}`);
        if (!decl) {
          unknowns.push({ kind: 'flask-route', module: mod.moduleId, function: fn.name, line: decorator.line || fn.line, reason: 'route-receiver-not-locally-declared', receiver });
          continue;
        }
        const pathValue = decorator.args?.[0] || keyword(decorator, 'rule');
        const localPath = literalString(pathValue);
        if (localPath === null) {
          unknowns.push({ kind: 'flask-route', module: mod.moduleId, function: fn.name, line: decorator.line || fn.line, reason: 'route-path-not-literal', receiver });
          continue;
        }
        if (decl.prefixStatus !== 'verified') {
          unknowns.push({ kind: 'flask-route', module: mod.moduleId, function: fn.name, line: decorator.line || fn.line, reason: 'blueprint-prefix-not-literal', receiver, localPath });
          continue;
        }

        let methods = [];
        let methodsStatus;
        if (DIRECT_VERBS.has(member)) {
          methods = [member.toUpperCase()];
          methodsStatus = 'explicit-decorator';
        } else {
          const methodsValue = keyword(decorator, 'methods');
          if (!methodsValue) {
            methodsStatus = 'framework-default-unresolved';
          } else {
            const found = literalMethods(methodsValue);
            if (!found) {
              unknowns.push({ kind: 'flask-route', module: mod.moduleId, function: fn.name, line: decorator.line || fn.line, reason: 'methods-not-literal-sequence', receiver, localPath });
              continue;
            }
            methods = found;
            methodsStatus = 'explicit-methods-list';
          }
        }

        registrations.push({
          module: mod.moduleId,
          source: mod.source.path,
          function: fn.name,
          line: decorator.line || fn.line,
          receiver,
          receiverKind: decl.kind,
          localPath,
          prefix: decl.prefix,
          path: joinLiteralPrefix(decl.prefix, localPath),
          methods,
          methodsStatus,
          limitations: decl.kind === 'blueprint'
            ? ['register_blueprint(url_prefix=...) mount overrides are not composed in this shadow slice.']
            : [],
        });
      }
    }
  }

  registrations.sort((a, b) => routeKey(a).localeCompare(routeKey(b)));
  unknowns.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { registrations, declarations: [...declarations.values()].sort((a, b) => `${a.module}#${a.variable}`.localeCompare(`${b.module}#${b.variable}`)), unknowns };
}
