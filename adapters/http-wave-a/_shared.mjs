export const HTTP_WAVE_A_LEAF_CONTRACT = 'bskel.internal.http-wave-a-leaf/0';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort(compareText).map((key) => [key, canonicalize(value[key])]),
  );
}

function stableText(value) {
  return JSON.stringify(canonicalize(value));
}

export function defineProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new TypeError('profile must be an object');
  if (typeof profile.id !== 'string' || !profile.id) throw new TypeError('profile.id is required');
  if (!['candidate', 'blocked-upstream-fact-gap'].includes(profile.state)) throw new TypeError('invalid profile.state');
  return Object.freeze({
    ...profile,
    registration: 'unregistered',
    productionDefault: false,
    runtimeTested: false,
    t19Review: profile.t19Review ?? 'NOT_REVIEWED',
  });
}

export function joinHttpPath(...parts) {
  const clean = parts
    .filter((part) => part != null && part !== '' && part !== '/')
    .map((part) => String(part).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  return clean.length ? '/' + clean.join('/') : '/';
}

export function literalArgument(decorator, index = 0) {
  const arg = decorator?.arguments?.[index];
  if (!arg) return { status: 'absent', value: '' };
  if (arg.kind === 'literal' && typeof arg.value === 'string') return { status: 'literal', value: arg.value };
  return { status: 'unknown', value: null };
}

export function makeRoute({ method, path, handler = null, source = null, provenance }) {
  const upper = String(method ?? '').toUpperCase();
  if (!HTTP_METHODS.has(upper)) throw new TypeError('route method is not a supported explicit HTTP method');
  if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('route path must be absolute');
  if (handler != null && (typeof handler !== 'string' || !handler)) throw new TypeError('route handler must be null or a non-empty string');
  if (typeof provenance !== 'string' || !provenance) throw new TypeError('route provenance is required');
  return { method: upper, path, handler, source, provenance };
}

export function projection(profile, {
  sourceContracts = [],
  routes = [],
  unknowns = [],
  observations = [],
  evidence = {},
} = {}) {
  const sortedRoutes = [...routes].sort((a, b) =>
    compareText(a.path, b.path) || compareText(a.method, b.method) || compareText(a.handler ?? '', b.handler ?? '')
  );
  const sortedUnknowns = [...unknowns].sort((a, b) => compareText(stableText(a), stableText(b)));
  const sortedObservations = [...observations].sort((a, b) => compareText(stableText(a), stableText(b)));
  for (const route of sortedRoutes) {
    if (Object.hasOwn(route, 'operationId')) throw new TypeError('Wave A leaf must not synthesize operationId');
  }
  return {
    contract: HTTP_WAVE_A_LEAF_CONTRACT,
    profileId: profile.id,
    registration: 'unregistered',
    productionDefault: false,
    status: profile.state === 'blocked-upstream-fact-gap' ? 'blocked' : 'candidate',
    sourceContracts: [...sourceContracts],
    routes: sortedRoutes,
    unknowns: sortedUnknowns,
    observations: sortedObservations,
    evidence,
  };
}

export function blockedProjection(profile, code, reason, evidence = {}) {
  return projection(profile, { unknowns: [{ code, reason }], evidence });
}

export function localDecoratorNamesFromModuleFacts(moduleFacts, specifier, importedNames) {
  if (!moduleFacts || moduleFacts.contract !== 'bskel.internal.js-ts-source-facts/0') {
    throw new TypeError('NestJS projection requires T04 bskel.internal.js-ts-source-facts/0');
  }
  const wanted = new Set(importedNames);
  const out = new Map(importedNames.map((name) => [name, new Set()]));
  for (const edge of moduleFacts.moduleEdges ?? []) {
    if (edge.kind !== 'import' || edge.specifier !== specifier) continue;
    for (const binding of edge.bindings ?? []) {
      if (wanted.has(binding.imported) && typeof binding.local === 'string') {
        out.get(binding.imported).add(binding.local);
      }
      if (binding.imported === '*' && typeof binding.local === 'string') {
        for (const name of importedNames) out.get(name).add(binding.local + '.' + name);
      }
    }
  }
  return out;
}
