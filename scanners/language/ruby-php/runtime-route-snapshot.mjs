import crypto from 'node:crypto';

export const RUNTIME_ROUTE_SNAPSHOT_CONTRACT = 'sbf.dsl-runtime-routes/1';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function snapshot(exporter, raw, routes, unknowns = []) {
  return {
    contract: RUNTIME_ROUTE_SNAPSHOT_CONTRACT,
    exporter,
    rawSha256: sha256(raw),
    routes: routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || (a.name ?? '').localeCompare(b.name ?? '')),
    unknowns,
  };
}

function normalizeRailsPath(uri) {
  if (typeof uri !== 'string' || !uri) return null;
  return uri.replace(/\(\.:format\)$/, '').replace(/:([A-Za-z_]\w*)/g, '{$1}');
}

export function parseRailsExpandedRoutes(raw) {
  if (typeof raw !== 'string') throw new TypeError('raw Rails route output must be a string');
  const routes = [];
  const unknowns = [];
  const blocks = raw.split(/(?=--\[ Route \d+ \]-+)/).filter((x) => /^--\[ Route \d+ \]-+/.test(x));
  for (const block of blocks) {
    const field = (name) => block.match(new RegExp(`^\\s*${name}\\s*\\|\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
    const name = field('Prefix') || null;
    const verb = field('Verb');
    const path = normalizeRailsPath(field('URI'));
    const controllerAction = field('Controller#Action');
    const sourceLocation = field('Source Location') || null;
    const target = controllerAction.match(/^([^\s#]+)#([A-Za-z_]\w*)/);
    if (!path || !verb) {
      unknowns.push({ code: 'RUNTIME_ROUTE_INCOMPLETE', name, reason: 'Rails route has no literal URI or HTTP verb' });
      continue;
    }
    const methods = verb.split('|').map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (!target) {
      unknowns.push({ code: 'RUNTIME_ROUTE_TARGET_UNRESOLVED', name, path, methods, reason: `Rails Controller#Action is not a local controller action: ${controllerAction || '<empty>'}` });
      continue;
    }
    for (const method of methods) {
      routes.push({ name, method, path, controller: target[1], action: target[2], sourceLocation });
    }
  }
  return snapshot('rails-routes-expanded', raw, routes, unknowns);
}

function parseJson(raw, label) {
  try { return JSON.parse(raw); }
  catch (error) { throw new TypeError(`${label} output is not valid JSON: ${error.message}`); }
}

export function parseLaravelRouteListJson(raw) {
  if (typeof raw !== 'string') throw new TypeError('raw Laravel route output must be a string');
  const data = parseJson(raw, 'Laravel route:list --json');
  if (!Array.isArray(data)) throw new TypeError('Laravel route:list --json output must be an array');
  const routes = [];
  const unknowns = [];
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      unknowns.push({ code: 'RUNTIME_ROUTE_INVALID_ROW', index: i, reason: 'route row is not an object' });
      continue;
    }
    const uri = typeof row.uri === 'string' && row.uri ? `/${row.uri.replace(/^\/+/, '')}` : null;
    const methods = typeof row.method === 'string' ? row.method.split('|').map((x) => x.trim().toUpperCase()).filter(Boolean) : [];
    if (!uri || methods.length === 0) {
      unknowns.push({ code: 'RUNTIME_ROUTE_INCOMPLETE', index: i, name: row.name ?? null, reason: 'Laravel route has no literal uri/method' });
      continue;
    }
    for (const method of methods) {
      routes.push({
        name: row.name ?? null,
        method,
        path: uri === '//' ? '/' : uri,
        action: typeof row.action === 'string' ? row.action : null,
        domain: row.domain ?? null,
        middleware: Array.isArray(row.middleware) ? [...row.middleware] : (typeof row.middleware === 'string' && row.middleware ? row.middleware.split('\n') : []),
        definition: row.path ?? null,
      });
    }
  }
  return snapshot('laravel-route-list-json', raw, routes, unknowns);
}

export function parseSymfonyRouterJson(raw) {
  if (typeof raw !== 'string') throw new TypeError('raw Symfony router output must be a string');
  const data = parseJson(raw, 'Symfony debug:router --format=json');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Symfony debug:router JSON output must be an object keyed by route name');
  const routes = [];
  const unknowns = [];
  for (const [name, row] of Object.entries(data)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      unknowns.push({ code: 'RUNTIME_ROUTE_INVALID_ROW', name, reason: 'route entry is not an object' });
      continue;
    }
    const routePath = typeof row.path === 'string' && row.path.startsWith('/') ? row.path : null;
    const rawMethod = typeof row.method === 'string' ? row.method : '';
    const methods = rawMethod === 'ANY' || !rawMethod ? [] : rawMethod.split('|').map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (!routePath) {
      unknowns.push({ code: 'RUNTIME_ROUTE_INCOMPLETE', name, reason: 'Symfony route has no literal absolute path' });
      continue;
    }
    if (methods.length === 0) {
      unknowns.push({ code: 'RUNTIME_ROUTE_METHOD_ANY', name, path: routePath, reason: 'Symfony route allows any method; bounded candidate expansion does not fabricate a finite method set' });
      continue;
    }
    for (const method of methods) {
      routes.push({
        name,
        method,
        path: routePath,
        host: row.host ?? 'ANY',
        scheme: row.scheme ?? 'ANY',
        controller: row.defaults?._controller ?? null,
        requirements: row.requirements ?? null,
        condition: row.condition ?? null,
      });
    }
  }
  return snapshot('symfony-debug-router-json', raw, routes, unknowns);
}

export function assertRuntimeRouteSnapshot(value) {
  if (!value || value.contract !== RUNTIME_ROUTE_SNAPSHOT_CONTRACT) throw new TypeError(`expected ${RUNTIME_ROUTE_SNAPSHOT_CONTRACT}`);
  if (!Array.isArray(value.routes) || !Array.isArray(value.unknowns)) throw new TypeError('routes/unknowns arrays are required');
  if (!/^[0-9a-f]{64}$/.test(value.rawSha256 ?? '')) throw new TypeError('rawSha256 is required');
  for (const route of value.routes) {
    if (!/^[A-Z]+$/.test(route.method) || !route.path?.startsWith('/')) throw new TypeError('invalid normalized runtime route');
    if (Object.hasOwn(route, 'operationId')) throw new TypeError('runtime route snapshot must not claim API operationId');
  }
  return true;
}
