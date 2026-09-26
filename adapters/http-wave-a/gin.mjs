import { defineProfile, makeRoute, projection } from './_shared.mjs';

export const GIN_PROFILE = defineProfile({
  id: 'go-gin',
  title: 'Go / Gin',
  state: 'candidate',
  upstreamOwner: 'T08',
  upstreamContracts: ['bskel.native-language/1'],
  supportedSyntax: [
    'T08-proven literal gin.Default/New roots',
    'T08-proven same-file literal Group chains',
    'T08-proven literal Gin HTTP routes',
  ],
  unknownConditions: [
    'computed paths',
    'wrapper/generated registration',
    'build-tag effects and cross-file helper factories',
    'middleware/auth semantics',
  ],
  versionPin: {
    repo: 'gin-gonic/examples',
    path: 'realtime-chat',
    ref: 'c2f7a0b158e7c8a60336f9ca5e97a517740234dc',
    framework: 'v1.12.0',
  },
  realRepoComparison: 'historical-pass-needs-leaf-rerun',
});

function assertResponse(message) {
  if (!message || message.protocol !== 'bskel.native-language/1' || message.kind !== 'analyze-response' || message.language !== 'go') {
    throw new TypeError('Gin projection requires a T08 bskel.native-language/1 Go analyze-response');
  }
}

export function projectGinFacts(message) {
  assertResponse(message);
  const routes = [];
  const unknowns = (message.diagnostics ?? []).map((d) => ({
    code: 'T08_' + d.code,
    severity: d.severity,
    reason: d.message,
    file: d.file,
    line: d.line ?? null,
  }));

  for (const route of message.routes ?? []) {
    if (route.framework !== 'gin') {
      unknowns.push({ code: 'GIN_FOREIGN_ROUTE_FACT', reason: 'T08 route fact is not a Gin route', framework: route.framework });
      continue;
    }
    routes.push(makeRoute({
      method: route.method,
      path: route.path,
      handler: route.handler,
      source: route.source,
      provenance: 'T08:bskel.native-language/1:' + route.confidence,
    }));
  }

  return projection(GIN_PROFILE, {
    sourceContracts: ['bskel.native-language/1'],
    routes,
    unknowns,
    evidence: {
      backend: message.backend ?? null,
      framework: message.framework ?? null,
      runtimeValidated: false,
    },
  });
}
