import { assertDslRouteCandidates } from './_route-candidates.mjs';
import { assertRuntimeRouteSnapshot } from './runtime-route-snapshot.mjs';

export const DSL_CONFORMANCE_CONTRACT = 'sbf.dsl-conformance/1';

function routeKey(route) {
  return `${route.method}\0${route.path}`;
}

function display(route) {
  return { method: route.method, path: route.path };
}

export function compareDslCandidatesToRuntime(candidates, runtime) {
  assertDslRouteCandidates(candidates);
  assertRuntimeRouteSnapshot(runtime);
  if (candidates.framework === 'rails' && runtime.exporter !== 'rails-routes-expanded') {
    throw new TypeError('Rails DSL candidates require a Rails runtime snapshot');
  }
  if (candidates.framework === 'laravel' && runtime.exporter !== 'laravel-route-list-json') {
    throw new TypeError('Laravel DSL candidates require a Laravel runtime snapshot');
  }
  if (candidates.framework === 'symfony' && runtime.exporter !== 'symfony-debug-router-json') {
    throw new TypeError('Symfony DSL candidates require a Symfony runtime snapshot');
  }

  const staticMap = new Map(candidates.candidates.map((route) => [routeKey(route), route]));
  const runtimeMap = new Map(runtime.routes.map((route) => [routeKey(route), route]));
  const keys = [...new Set([...staticMap.keys(), ...runtimeMap.keys()])].sort();
  const matched = [];
  const staticOnly = [];
  const runtimeOnly = [];

  for (const key of keys) {
    const left = staticMap.get(key);
    const right = runtimeMap.get(key);
    if (left && right) {
      matched.push({ route: display(left), staticSourceFactId: left.sourceFactId, runtimeName: right.name ?? null });
    } else if (left) {
      staticOnly.push({ route: display(left), staticSourceFactId: left.sourceFactId });
    } else {
      runtimeOnly.push({ route: display(right), runtimeName: right.name ?? null });
    }
  }

  const runtimeComparable = matched.length + runtimeOnly.length;
  const precisionDenominator = matched.length + staticOnly.length;
  return {
    contract: DSL_CONFORMANCE_CONTRACT,
    framework: candidates.framework,
    exporter: runtime.exporter,
    matched,
    staticOnly,
    runtimeOnly,
    staticUnknowns: [...candidates.unknowns],
    runtimeUnknowns: [...runtime.unknowns],
    metrics: {
      matched: matched.length,
      staticOnly: staticOnly.length,
      runtimeOnly: runtimeOnly.length,
      staticAbstentions: candidates.unknowns.length,
      runtimeAbstentions: runtime.unknowns.length,
      comparableRuntimeRoutes: runtimeComparable,
      conditionalRecall: runtimeComparable ? matched.length / runtimeComparable : null,
      conditionalPrecision: precisionDenominator ? matched.length / precisionDenominator : null,
    },
    conclusion: runtime.unknowns.length
      ? 'inconclusive-runtime-unknowns'
      : staticOnly.length || runtimeOnly.length
        ? 'differences-observed'
        : 'route-set-aligned',
  };
}

export function assertDslConformanceReport(report) {
  if (!report || report.contract !== DSL_CONFORMANCE_CONTRACT) throw new TypeError(`expected ${DSL_CONFORMANCE_CONTRACT}`);
  for (const name of ['matched', 'staticOnly', 'runtimeOnly', 'staticUnknowns', 'runtimeUnknowns']) {
    if (!Array.isArray(report[name])) throw new TypeError(`${name} must be an array`);
  }
  if (!['inconclusive-runtime-unknowns', 'differences-observed', 'route-set-aligned'].includes(report.conclusion)) {
    throw new TypeError('invalid conformance conclusion');
  }
  return true;
}
