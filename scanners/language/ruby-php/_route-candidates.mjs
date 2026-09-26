import crypto from 'node:crypto';

export const DSL_ROUTE_CANDIDATES_CONTRACT = 'sbf.dsl-route-candidates/1';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function joinRoute(...segments) {
  const parts = [];
  for (const segment of segments) {
    if (segment == null || segment === '' || segment === '/') continue;
    parts.push(String(segment).replace(/^\/+|\/+$/g, ''));
  }
  return `/${parts.filter(Boolean).join('/')}`.replace(/\/{2,}/g, '/') || '/';
}

export function regularSingular(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) return null;
  if (/ies$/.test(name)) return `${name.slice(0, -3)}y`;
  if (/(?:ches|shes|xes|zes|sses)$/.test(name)) return name.slice(0, -2);
  if (/s$/.test(name) && !/ss$/.test(name)) return name.slice(0, -1);
  return null;
}

export function createRouteCandidateEnvelope(envelope) {
  return {
    contract: DSL_ROUTE_CANDIDATES_CONTRACT,
    sourceContract: envelope.contract,
    framework: envelope.framework,
    source: envelope.source,
    candidates: [],
    unknowns: [],
  };
}

export function addCandidate(out, envelope, fact, method, routePath, extras = {}) {
  const routePathNormalized = joinRoute(routePath);
  const raw = [envelope.framework, fact.id, method, routePathNormalized].join('\0');
  out.candidates.push({
    id: `dslr_${sha256(raw).slice(0, 20)}`,
    framework: envelope.framework,
    method,
    path: routePathNormalized,
    sourceFactId: fact.id,
    source: fact.source,
    provenance: 'bounded-literal-dsl-expansion',
    ...extras,
  });
}

export function addUnknown(out, fact, code, reason) {
  out.unknowns.push({ code, sourceFactId: fact.id, source: fact.source, reason });
}

export function finalizeCandidates(out) {
  out.candidates.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.id.localeCompare(b.id));
  out.unknowns.sort((a, b) => a.source.start - b.source.start || a.code.localeCompare(b.code));
  return out;
}

export function assertDslRouteCandidates(value) {
  if (!value || value.contract !== DSL_ROUTE_CANDIDATES_CONTRACT) {
    throw new TypeError(`expected ${DSL_ROUTE_CANDIDATES_CONTRACT}`);
  }
  if (!Array.isArray(value.candidates) || !Array.isArray(value.unknowns)) {
    throw new TypeError('candidate envelope arrays are required');
  }
  const ids = new Set();
  for (const candidate of value.candidates) {
    if (!candidate.id || ids.has(candidate.id)) throw new TypeError('candidate ids must be unique');
    ids.add(candidate.id);
    if (!/^[A-Z]+$/.test(candidate.method) || !candidate.path?.startsWith('/')) throw new TypeError('invalid route candidate');
    if (Object.hasOwn(candidate, 'operationId')) throw new TypeError('route candidates must not synthesize API operationId');
    if (!candidate.sourceFactId || !candidate.source) throw new TypeError('candidate provenance is required');
  }
  return true;
}
