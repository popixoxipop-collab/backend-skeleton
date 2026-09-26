import { defineProfile, makeRoute, projection } from './_shared.mjs';

export const LARAVEL_PROFILE = defineProfile({
  id: 'php-laravel',
  title: 'PHP / Laravel',
  state: 'candidate',
  upstreamOwner: 'T07',
  upstreamContracts: ['sbf.dsl-route-candidates/1'],
  supportedSyntax: [
    'T07 bounded literal Laravel route candidates',
    'T07 bounded resource/apiResource expansion where source facts are sufficient',
  ],
  unknownConditions: [
    'dynamic DSL declarations',
    'dynamic group context',
    'partial URI/method/resource facts',
    'middleware/auth semantics, macros and runtime registrations',
  ],
  versionPin: {
    repo: 'laravel/laravel',
    ref: 'aa0cf127fc365a56ee016867144ddffabc2290ae',
    framework: null,
    declaredRange: '^13.17',
  },
  realRepoComparison: 'historical-pass-needs-leaf-rerun',
});

export function projectLaravelCandidates(envelope) {
  if (!envelope || envelope.contract !== 'sbf.dsl-route-candidates/1' || envelope.framework !== 'laravel') {
    throw new TypeError('Laravel projection requires T07 sbf.dsl-route-candidates/1 framework=laravel');
  }
  const routes = (envelope.candidates ?? []).map((candidate) => makeRoute({
    method: candidate.method,
    path: candidate.path,
    handler: null,
    source: candidate.source ?? null,
    provenance: 'T07:sbf.dsl-route-candidates/1:' + (candidate.provenance ?? 'unknown'),
  }));
  const unknowns = (envelope.unknowns ?? []).map((item) => ({
    code: 'T07_' + item.code,
    reason: item.reason,
    sourceFactId: item.sourceFactId,
    source: item.source ?? null,
  }));

  return projection(LARAVEL_PROFILE, {
    sourceContracts: ['sbf.dsl-route-candidates/1'],
    routes,
    unknowns,
    evidence: {
      sourceContract: envelope.sourceContract ?? null,
      runtimeValidated: false,
    },
  });
}
