import { defineProfile, makeRoute, projection } from './_shared.mjs';

export const FLASK_PROFILE = defineProfile({
  id: 'python-flask',
  title: 'Python / Flask',
  state: 'candidate',
  upstreamOwner: 'T06',
  upstreamContracts: ['T06 buildFlaskRouteShadow output'],
  supportedSyntax: [
    'T06-proven literal app/Blueprint route registrations',
    'explicit shortcut verbs',
    'explicit literal methods list',
  ],
  unknownConditions: [
    '@route with framework-default method semantics',
    'dynamic path/method/prefix expressions',
    'imported or factory-provided route receivers',
    'register_blueprint mount-prefix override composition',
  ],
  versionPin: {
    repo: 'pallets/flask',
    path: 'examples/tutorial',
    ref: 'd73fa1cdcbd8b1465c151db8924ba58b1dd14e35',
    framework: null,
  },
  realRepoComparison: 'historical-pass-needs-leaf-rerun',
});

export function projectFlaskShadow(shadow) {
  if (!shadow || !Array.isArray(shadow.registrations) || !Array.isArray(shadow.unknowns)) {
    throw new TypeError('Flask projection requires T06 buildFlaskRouteShadow output');
  }
  const routes = [];
  const unknowns = [...shadow.unknowns].map((item) => ({ code: 'T06_FLASK_UNKNOWN', ...item }));

  for (const registration of shadow.registrations) {
    if (!Array.isArray(registration.methods) || registration.methods.length === 0) {
      unknowns.push({
        code: 'FLASK_METHOD_SEMANTICS_UNRESOLVED',
        module: registration.module,
        function: registration.function,
        path: registration.path,
        methodsStatus: registration.methodsStatus,
      });
      continue;
    }
    for (const method of registration.methods) {
      routes.push(makeRoute({
        method,
        path: registration.path,
        handler: registration.function,
        source: { file: registration.source, line: registration.line ?? null },
        provenance: 'T06:buildFlaskRouteShadow',
      }));
    }
  }

  return projection(FLASK_PROFILE, {
    sourceContracts: ['T06 buildFlaskRouteShadow'],
    routes,
    unknowns,
    evidence: { runtimeValidated: false },
  });
}
