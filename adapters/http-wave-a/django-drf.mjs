import { blockedProjection, defineProfile, projection } from './_shared.mjs';

export const DJANGO_DRF_PROFILE = defineProfile({
  id: 'python-django',
  title: 'Python / Django + DRF',
  state: 'blocked-upstream-fact-gap',
  upstreamOwner: 'T06',
  upstreamContracts: ['T06 buildDjangoUrlShadow output'],
  supportedSyntax: [
    'Django literal path/re_path/include observations from T06',
  ],
  unknownConditions: [
    'Django URLConf explicitly does not declare HTTP method semantics',
    'DRF Router/ViewSet action-to-method facts are not present in the accepted T06 shadow surface',
    'dynamic/mutated urlpatterns, permissions and serializers',
  ],
  versionPin: {
    repo: 'encode/rest-framework-tutorial',
    ref: '0f26fc15db5c39f22af1fef488cbb7c1bd65eb43',
    framework: 'Django 6.1.1 / djangorestframework 3.18.1',
  },
  realRepoComparison: 'historical-pass-does-not-certify-drf-method-projection',
});

export function projectDjangoDrfShadow(shadow) {
  if (!shadow || !Array.isArray(shadow.registrations) || !Array.isArray(shadow.unknowns)) {
    return blockedProjection(
      DJANGO_DRF_PROFILE,
      'DJANGO_DRF_UPSTREAM_FACTS_MISSING',
      'T12 requires T06 Django URL facts and a future T06-owned DRF action/method fact surface.',
    );
  }
  const observations = shadow.registrations.map((item) => ({
    kind: 'django-url-registration',
    module: item.module,
    source: item.source,
    line: item.line ?? null,
    patternSegments: item.patternSegments,
    target: item.target,
    methodSemantics: item.methodSemantics,
  }));
  return projection(DJANGO_DRF_PROFILE, {
    sourceContracts: ['T06 buildDjangoUrlShadow'],
    observations,
    unknowns: [
      ...shadow.unknowns.map((item) => ({ code: 'T06_DJANGO_UNKNOWN', ...item })),
      {
        code: 'DRF_ACTION_METHOD_FACT_MISSING',
        reason: 'T06 has not promoted Router/ViewSet action-to-HTTP-method facts; Django URL observations cannot become HTTP endpoints.',
      },
    ],
  });
}
