import {
  defineProfile, joinHttpPath, literalArgument, localDecoratorNamesFromModuleFacts,
  makeRoute, projection,
} from './_shared.mjs';

const VERB_DECORATORS = new Map([
  ['Get', 'GET'], ['Post', 'POST'], ['Put', 'PUT'], ['Patch', 'PATCH'],
  ['Delete', 'DELETE'], ['Head', 'HEAD'], ['Options', 'OPTIONS'],
]);

export const NESTJS_PROFILE = defineProfile({
  id: 'typescript-nestjs',
  title: 'TypeScript / NestJS',
  state: 'candidate',
  upstreamOwner: 'T04',
  upstreamContracts: ['bskel.internal.js-ts-source-facts/0', 'bskel.internal.js-ts-structure/0'],
  supportedSyntax: [
    'Nest decorators proven imported from @nestjs/common',
    'literal @Controller() or @Controller("...")',
    'literal @Get/@Post/@Put/@Patch/@Delete/@Head/@Options method decorators',
  ],
  unknownConditions: [
    'non-literal decorator arguments',
    'global prefixes and versioning',
    'guards/interceptors/auth semantics',
    'DTO/request/response schemas',
    'runtime metadata and synthesized operation identity',
  ],
  versionPin: {
    repo: 'nestjs/typescript-starter',
    ref: 'a122dea65cd0610ee205d7765ed46f9d73629141',
    framework: '12.0.1',
    evidence: 'package-lock.json blob 4d3c17bdd69d3106d48517bbeadaf728119a8f44',
  },
  realRepoComparison: 'PASS_STATIC_REAL_REPO',
});

function hasName(set, decorator) {
  return Boolean(decorator && typeof decorator.name === 'string' && set.has(decorator.name));
}

export function projectNestJsFacts({ moduleFacts, structureFacts }) {
  if (!structureFacts || structureFacts.contract !== 'bskel.internal.js-ts-structure/0') {
    throw new TypeError('NestJS projection requires T04 bskel.internal.js-ts-structure/0');
  }
  if (!moduleFacts?.complete || !structureFacts.complete || structureFacts.syntaxValidated !== true) {
    return projection(NESTJS_PROFILE, {
      sourceContracts: [moduleFacts?.contract, structureFacts?.contract].filter(Boolean),
      unknowns: [{ code: 'NESTJS_UPSTREAM_FACTS_INCOMPLETE', reason: 'T04 module/structure facts are incomplete or syntax-unvalidated' }],
    });
  }
  if (moduleFacts.filePath !== structureFacts.filePath) {
    return projection(NESTJS_PROFILE, {
      sourceContracts: [moduleFacts.contract, structureFacts.contract],
      unknowns: [{ code: 'NESTJS_FACT_FILE_MISMATCH', reason: 'module and structure facts do not refer to the same source file' }],
    });
  }

  const imported = localDecoratorNamesFromModuleFacts(
    moduleFacts,
    '@nestjs/common',
    ['Controller', ...VERB_DECORATORS.keys()],
  );
  const routes = [];
  const unknowns = [];

  for (const cls of structureFacts.decoratedClasses ?? []) {
    const controllerDecorator = (cls.decorators ?? []).find((d) => hasName(imported.get('Controller'), d));
    if (!controllerDecorator) continue;
    if (controllerDecorator.called !== true) {
      unknowns.push({ code: 'NESTJS_CONTROLLER_DECORATOR_NOT_CALLED', className: cls.name, source: cls.source ?? null });
      continue;
    }
    const base = literalArgument(controllerDecorator);
    if (base.status === 'unknown') {
      unknowns.push({ code: 'NESTJS_CONTROLLER_PATH_UNKNOWN', className: cls.name, source: controllerDecorator.source ?? cls.source ?? null });
      continue;
    }

    for (const member of cls.members ?? []) {
      if (member.kind !== 'method' || member.computed) continue;
      for (const [decoratorName, verb] of VERB_DECORATORS) {
        const routeDecorator = (member.decorators ?? []).find((d) => hasName(imported.get(decoratorName), d));
        if (!routeDecorator) continue;
        if (routeDecorator.called !== true) {
          unknowns.push({ code: 'NESTJS_METHOD_DECORATOR_NOT_CALLED', className: cls.name, method: member.name, decorator: decoratorName, source: member.source ?? null });
          continue;
        }
        const local = literalArgument(routeDecorator);
        if (local.status === 'unknown') {
          unknowns.push({ code: 'NESTJS_METHOD_PATH_UNKNOWN', className: cls.name, method: member.name, decorator: decoratorName, source: routeDecorator.source ?? member.source ?? null });
          continue;
        }
        routes.push(makeRoute({
          method: verb,
          path: joinHttpPath(base.value, local.value),
          handler: cls.name + '.' + member.name,
          source: { file: structureFacts.filePath, ...(member.source ?? {}) },
          provenance: 'T04:bskel.internal.js-ts-structure/0 + @nestjs/common import binding',
        }));
      }
    }
  }

  return projection(NESTJS_PROFILE, {
    sourceContracts: [moduleFacts.contract, structureFacts.contract],
    routes,
    unknowns,
    evidence: {
      filePath: structureFacts.filePath,
      typescriptVersion: structureFacts.typescriptVersion ?? null,
      runtimeValidated: false,
    },
  });
}
