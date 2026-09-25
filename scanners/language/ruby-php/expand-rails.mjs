import { addCandidate, addUnknown, joinRoute, regularSingular } from './_route-candidates.mjs';

const ROWS = Object.freeze({
  index: [['GET', 'collection']], create: [['POST', 'collection']], new: [['GET', 'new']],
  show: [['GET', 'member']], edit: [['GET', 'edit']],
  update: [['PATCH', 'member'], ['PUT', 'member']], destroy: [['DELETE', 'member']],
});
const ALL_ACTIONS = Object.freeze(Object.keys(ROWS));

function normalizeRailsCandidatePath(value) {
  return joinRoute(value).replace(/:([A-Za-z_]\w*)/g, '{$1}');
}

function resourceContextShape(ctx, base) {
  const name = ctx.name;
  if (!name) return { ok: false, reason: 'resource context name is not literal' };
  const collection = normalizeRailsCandidatePath(joinRoute(base, ctx.path ?? name));
  if (ctx.singular) {
    return {
      ok: true,
      collection,
      member: collection,
      nested: collection,
      memberParam: null,
      nestedParam: null,
    };
  }
  const memberParam = ctx.param ?? 'id';
  const parentResource = regularSingular(name);
  const nestedParam = parentResource
    ? (ctx.param ? `${parentResource}_${ctx.param}` : `${parentResource}_id`)
    : null;
  return {
    ok: true,
    collection,
    member: joinRoute(collection, `{${memberParam}}`),
    nested: nestedParam ? joinRoute(collection, `{${nestedParam}}`) : null,
    memberParam,
    nestedParam,
  };
}

function baseForResourceFact(fact) {
  let base = '/';
  let pendingResource = null;

  const consumePendingNested = () => {
    if (!pendingResource) return { ok: true };
    if (!pendingResource.nested) {
      return {
        ok: false,
        reason: `cannot conservatively derive parent nested key for resource '${pendingResource.name}'`,
      };
    }
    base = pendingResource.nested;
    pendingResource = null;
    return { ok: true };
  };

  for (const ctx of fact.context ?? []) {
    if (ctx.dynamic) return { ok: false, reason: `dynamic ${ctx.kind} context` };

    if (ctx.kind === 'namespace' || ctx.kind === 'scope') {
      const consumed = consumePendingNested();
      if (!consumed.ok) return consumed;
      if (ctx.path) base = normalizeRailsCandidatePath(joinRoute(base, ctx.path));
      continue;
    }

    if (ctx.kind === 'resource') {
      const consumed = consumePendingNested();
      if (!consumed.ok) return consumed;
      const shape = resourceContextShape(ctx, base);
      if (!shape.ok) return shape;
      pendingResource = { ...shape, name: ctx.name };
      continue;
    }

    if (ctx.kind === 'route-mode') {
      if (!pendingResource) {
        return { ok: false, reason: 'member/collection route mode has no resolved resource context' };
      }
      if (ctx.routeMode === 'collection') base = pendingResource.collection;
      else if (ctx.routeMode === 'member') base = pendingResource.member;
      else if (ctx.routeMode === 'new') base = joinRoute(pendingResource.collection, 'new');
      else return { ok: false, reason: `unsupported route mode '${ctx.routeMode ?? ctx.name}'` };
      pendingResource = null;
    }
  }

  const consumed = consumePendingNested();
  if (!consumed.ok) return consumed;
  return { ok: true, path: base };
}

function baseForExplicitRoute(fact) {
  let base = '/';
  let resource = null;
  let routeMode = fact.attributes?.routeMode ?? null;

  for (const ctx of fact.context ?? []) {
    if (ctx.dynamic) return { ok: false, reason: `dynamic ${ctx.kind} context` };

    if (ctx.kind === 'namespace' || ctx.kind === 'scope') {
      if (ctx.path) base = normalizeRailsCandidatePath(joinRoute(base, ctx.path));
      continue;
    }

    if (ctx.kind === 'resource') {
      const shape = resourceContextShape(ctx, base);
      if (!shape.ok) return shape;
      resource = shape;
      base = shape.nested;
      continue;
    }

    if (ctx.kind === 'route-mode') {
      routeMode = ctx.routeMode ?? ctx.name ?? routeMode;
    }
  }

  if (!resource) return { ok: true, path: base };

  if (routeMode === 'member') return { ok: true, path: resource.member };
  if (routeMode === 'collection') return { ok: true, path: resource.collection };
  if (routeMode === 'new') return { ok: true, path: joinRoute(resource.collection, 'new') };

  if (resource.nested) {
    return {
      ok: true,
      path: resource.nested,
      implicitNestedMember: true,
    };
  }

  return {
    ok: false,
    reason: 'custom route inside resources requires a regular or explicit parent nesting key',
  };
}

function resourceActions(fact) {
  const actions = new Set(fact.attributes?.only ?? ALL_ACTIONS);
  for (const action of fact.attributes?.except ?? []) actions.delete(action);
  const unsupported = [...actions].filter((action) => !ALL_ACTIONS.includes(action));
  for (const action of unsupported) actions.delete(action);
  return { actions: [...actions], unsupported };
}

function resourceShape(fact, prefix) {
  const name = fact.declaration.name;
  if (!name) return { ok: false, reason: 'resource name is not literal' };
  const collection = normalizeRailsCandidatePath(joinRoute(prefix, fact.attributes?.path ?? name));
  if (fact.attributes?.singular) {
    return { ok: true, collection, member: collection, memberParam: null };
  }
  const memberParam = fact.attributes?.param ?? 'id';
  return {
    ok: true,
    collection,
    member: joinRoute(collection, `{${memberParam}}`),
    memberParam,
  };
}

function hasConcernDefinitionContext(fact) {
  return (fact.context ?? []).some((ctx) => ctx.kind === 'concern-definition');
}

function resourceContextFromFact(fact) {
  return {
    kind: 'resource',
    name: fact.declaration.name,
    path: fact.attributes?.path ?? fact.declaration.name,
    module: null,
    dynamic: fact.status === 'unknown',
    singular: Boolean(fact.attributes?.singular),
    param: fact.attributes?.param ?? null,
    routeMode: null,
  };
}

function collectConcernDefinitions(facts) {
  const declarationCounts = new Map();
  const bodies = new Map();

  for (const fact of facts) {
    if (fact.kind !== 'concern' || fact.attributes?.declaration !== 'concern') continue;
    const name = fact.declaration.name;
    if (!name || fact.status === 'unknown') continue;
    declarationCounts.set(name, (declarationCounts.get(name) ?? 0) + 1);
    if (!bodies.has(name)) bodies.set(name, []);
  }

  for (const fact of facts) {
    const concernCtx = (fact.context ?? []).find((ctx) => ctx.kind === 'concern-definition');
    if (!concernCtx?.name || !bodies.has(concernCtx.name)) continue;
    bodies.get(concernCtx.name).push(fact);
  }

  return { declarationCounts, bodies };
}

function materializeConcernFacts(envelope, out) {
  const { declarationCounts, bodies } = collectConcernDefinitions(envelope.facts);
  const derived = [];

  const instantiate = (name, useFact, useContext) => {
    if (!name) {
      addUnknown(out, useFact, 'DSL_CONCERN_UNRESOLVED', 'concern use does not have a literal name');
      return;
    }
    const count = declarationCounts.get(name) ?? 0;
    if (count !== 1) {
      addUnknown(
        out,
        useFact,
        'DSL_CONCERN_UNRESOLVED',
        count === 0
          ? `concern '${name}' has no declaration in this route source`
          : `concern '${name}' has ${count} declarations and is ambiguous`,
      );
      return;
    }

    for (const child of bodies.get(name) ?? []) {
      const idx = (child.context ?? []).findIndex(
        (ctx) => ctx.kind === 'concern-definition' && ctx.name === name,
      );
      if (idx === -1) continue;
      const tail = child.context.slice(idx + 1);
      derived.push({
        ...child,
        id: `${child.id}::concern-use::${useFact.id}`,
        context: [...useContext, ...tail],
        attributes: {
          ...(child.attributes ?? {}),
          concernDefinition: name,
          concernSourceFactId: child.id,
          concernUseSourceFactId: useFact.id,
        },
      });
    }
  };

  for (const fact of envelope.facts) {
    if (fact.kind === 'resource') {
      for (const name of fact.attributes?.concerns ?? []) {
        instantiate(name, fact, [...(fact.context ?? []), resourceContextFromFact(fact)]);
      }
      continue;
    }

    if (fact.kind === 'concern' && fact.attributes?.declaration === 'concerns') {
      if (fact.status === 'unknown') {
        addUnknown(out, fact, 'DSL_CONCERN_UNRESOLVED', fact.unknownReason);
        continue;
      }
      for (const name of fact.attributes?.names ?? []) {
        instantiate(name, fact, fact.context ?? []);
      }
    }
  }

  return derived;
}

function expandOneRailsFact(envelope, out, fact) {
  if (fact.status === 'unknown') {
    if (fact.kind === 'route' || fact.kind === 'resource') {
      addUnknown(out, fact, 'DSL_DYNAMIC_DECLARATION', fact.unknownReason);
    }
    return;
  }

  if (fact.kind === 'route') {
    if (fact.attributes?.path == null || !fact.attributes?.method) {
      addUnknown(out, fact, 'DSL_ROUTE_PARTIAL', 'route method/path are not both literal');
      return;
    }
    const base = baseForExplicitRoute(fact);
    if (!base.ok) {
      addUnknown(out, fact, 'DSL_CONTEXT_UNRESOLVED', base.reason);
      return;
    }
    addCandidate(
      out,
      envelope,
      fact,
      fact.attributes.method,
      normalizeRailsCandidatePath(joinRoute(base.path, fact.attributes.path)),
      {
        controller: fact.attributes.controller ?? null,
        action: fact.attributes.action ?? null,
        routeMode: fact.attributes.routeMode ?? null,
        implicitNestedMember: Boolean(base.implicitNestedMember),
        concernDefinition: fact.attributes?.concernDefinition ?? null,
        concernUseSourceFactId: fact.attributes?.concernUseSourceFactId ?? null,
      },
    );
    return;
  }

  if (fact.kind !== 'resource') return;
  const base = baseForResourceFact(fact);
  if (!base.ok) {
    addUnknown(out, fact, 'DSL_CONTEXT_UNRESOLVED', base.reason);
    return;
  }

  const shape = resourceShape(fact, base.path);
  if (!shape.ok) {
    addUnknown(out, fact, 'DSL_RESOURCE_KEY_UNRESOLVED', shape.reason);
    return;
  }

  const { actions, unsupported } = resourceActions(fact);
  if (unsupported.length) {
    addUnknown(
      out,
      fact,
      'DSL_RESOURCE_ACTION_UNSUPPORTED',
      `unsupported Rails actions: ${unsupported.join(', ')}`,
    );
  }

  for (const action of actions) {
    for (const [method, where] of ROWS[action]) {
      const routePath = where === 'collection' ? shape.collection
        : where === 'member' ? shape.member
          : where === 'new' ? joinRoute(shape.collection, 'new')
            : joinRoute(shape.member, 'edit');
      addCandidate(out, envelope, fact, method, routePath, {
        resource: fact.declaration.name,
        action,
        controller: fact.attributes?.controller ?? fact.declaration.name,
        memberParam: shape.memberParam,
        concernDefinition: fact.attributes?.concernDefinition ?? null,
        concernUseSourceFactId: fact.attributes?.concernUseSourceFactId ?? null,
      });
    }
  }
}

export function expandRailsFacts(envelope, out) {
  const derivedConcernFacts = materializeConcernFacts(envelope, out);

  for (const fact of envelope.facts) {
    if (hasConcernDefinitionContext(fact)) continue;
    if (fact.kind === 'concern') continue;
    expandOneRailsFact(envelope, out, fact);
  }

  for (const fact of derivedConcernFacts) {
    if (fact.kind === 'concern') {
      addUnknown(
        out,
        fact,
        'DSL_CONCERN_UNRESOLVED',
        'nested concern use inside a concern definition is not expanded in this bounded pass',
      );
      continue;
    }
    expandOneRailsFact(envelope, out, fact);
  }
}
