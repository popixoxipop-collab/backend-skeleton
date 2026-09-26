import { defineProfile, makeRoute, projection } from './_shared.mjs';

export const ASPNET_CORE_PROFILE = defineProfile({
  id: 'csharp-aspnet-core',
  title: 'C# / ASP.NET Core',
  state: 'candidate',
  upstreamOwner: 'T08',
  upstreamContracts: ['bskel.native-language/1'],
  supportedSyntax: [
    'T08-proven literal Minimal API MapGroup/Map* routes',
    'T08-proven direct controller [Route]/[Http*] routes',
  ],
  unknownConditions: [
    'conventional routing',
    'dynamic route templates',
    'endpoint filters and authorization semantics',
    'model binding, generated or inherited metadata',
  ],
  versionPin: {
    repo: 'dotnet/AspNetCore.Docs',
    path: 'aspnetcore/tutorials/min-web-api/samples/8.x/todoDTO',
    ref: '5f20cce1736b24cb468c98833d965e969613bc3f',
    framework: 'net8.0 sample',
  },
  realRepoComparison: 'BLOCKED_INFRA',
});

function assertResponse(message) {
  if (!message || message.protocol !== 'bskel.native-language/1' || message.kind !== 'analyze-response' || message.language !== 'csharp') {
    throw new TypeError('ASP.NET projection requires a T08 bskel.native-language/1 C# analyze-response');
  }
}

export function projectAspNetCoreFacts(message) {
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
    if (!['aspnet-core-minimal', 'aspnet-core-controller'].includes(route.framework)) {
      unknowns.push({ code: 'ASPNET_FOREIGN_ROUTE_FACT', reason: 'T08 route fact is not an ASP.NET Core route', framework: route.framework });
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

  return projection(ASPNET_CORE_PROFILE, {
    sourceContracts: ['bskel.native-language/1'],
    routes,
    unknowns,
    evidence: {
      backend: message.backend ?? null,
      framework: message.framework ?? null,
      runtimeValidated: false,
      realRepoComparison: 'BLOCKED_INFRA',
    },
  });
}
