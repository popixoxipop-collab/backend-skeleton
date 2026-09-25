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
  const parentParam = ctx.param ?? regularSingular(name);
  return {
    ok: true,
    collection,
    member: joinRoute(collection, `{${memberParam}}`),
    nested: parentParam ? joinRoute(collection, `{${parentParam}_id}`) : null,
    memberParam,
    nestedParam: parentParam,
  };
}

function baseForResourceFact(fact) {
  let base = '/';
  for (const ctx of fact.context ?? []) {
    if (ctx.dynamic) return { ok: false, reason: `dynamic ${ctx.kind} context` };
    if (ctx.kind === 'namespace' || ctx.kind === 'scope') {
      if (ctx.path) base = normalizeRailsCandidatePath(joinRoute(base, ctx.path));
      continue;
    }
    if (ctx.kind === 'resource') {
      const shape = resourceContextShape(ctx, base);
      if (!shape.ok) return shape;
      if (!shape.nested) {
        return {
          ok: false,
          reason: `cannot conservatively derive parent nested key for resource '${ctx.name}'`,
        };
      }
      base = shape.nested;
      continue;
    }
    if (ctx.kind === 'route-mode') {
      return { ok: false, reason: 'resource declaration inside member/collection route mode is unsupported' };
    }
  }
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

  return {
    ok: false,
    reason: 'custom route inside resources requires explicit member/collection/on context for bounded expansion',
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

export function expandRailsFacts(envelope, out) {
  for (const fact of envelope.facts) {
    if (fact.status === 'unknown') {
      if (fact.kind === 'route' || fact.kind === 'resource') {
        addUnknown(out, fact, 'DSL_DYNAMIC_DECLARATION', fact.unknownReason);
      }
      continue;
    }

    if (fact.kind === 'route') {
      if (fact.attributes?.path == null || !fact.attributes?.method) {
        addUnknown(out, fact, 'DSL_ROUTE_PARTIAL', 'route method/path are not both literal');
        continue;
      }
      const base = baseForExplicitRoute(fact);
      if (!base.ok) {
        addUnknown(out, fact, 'DSL_CONTEXT_UNRESOLVED', base.reason);
        continue;
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
        },
      );
      continue;
    }

    if (fact.kind !== 'resource') continue;
    const base = baseForResourceFact(fact);
    if (!base.ok) {
      addUnknown(out, fact, 'DSL_CONTEXT_UNRESOLVED', base.reason);
      continue;
    }

    const shape = resourceShape(fact, base.path);
    if (!shape.ok) {
      addUnknown(out, fact, 'DSL_RESOURCE_KEY_UNRESOLVED', shape.reason);
      continue;
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
        });
      }
    }
  }
}
