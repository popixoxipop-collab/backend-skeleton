import { blockedProjection, defineProfile } from './_shared.mjs';

export const FASTIFY_PROFILE = defineProfile({
  id: 'node-fastify',
  title: 'Node.js / Fastify',
  state: 'blocked-upstream-fact-gap',
  upstreamOwner: 'T04/T02',
  upstreamContracts: ['bskel.internal.js-ts-source-facts/0', 'bskel.internal.js-ts-structure/0'],
  supportedSyntax: [],
  unknownConditions: [
    'Fastify instance/plugin receiver identity is not proven by the current canonical T04 fact surface',
    'register(plugin,{prefix}) ownership and cross-file plugin graph',
    'route schemas/hooks/auth and dynamic prefixes',
  ],
  versionPin: {
    repo: 'fastify/example',
    path: 'fastify-postgres',
    ref: 'd3032da0b307afa8749e967aa0dbdf239c348341',
    framework: null,
    declaredRange: '^5.2.1',
  },
  realRepoComparison: 'historical-pass-does-not-certify-fact-projector',
});

export function projectFastifyFacts() {
  return blockedProjection(
    FASTIFY_PROFILE,
    'FASTIFY_UPSTREAM_RECEIVER_FACT_MISSING',
    'T12 will not recreate a JS parser. A T04/T02-owned fact must bind Fastify instance/plugin receiver identity and registration ownership before HTTP routes can be projected.',
  );
}
