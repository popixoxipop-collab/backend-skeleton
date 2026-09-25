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

function resourceContextShape(ctx, prefix) {
  const name = ctx.name;
  const segment = ctx.path ?? name;
  if (!name || segment == null) return { ok: false, reason: 'resource context has no literal name/path' };
  const collection = normalizeRailsCandidatePath(joinRoute(prefix, segment));
  if (ctx.singular) {
    return { ok: true, collection, member: collection, nested: collection };
  }
  const memberParam = ctx.param ?? 'id';
  const nestedParam = ctx.param ?? regularSingular(name);
  return {
    ok: true,
    collection,
    member: joinRoute(collection, `{${memberParam}}`),
    nested: nestedParam ? joinRoute(collection, `{${nestedParam}_id}`) : null,
  };
}

function contextPrefix(fact) {
  let prefix = '/';
  const context = fact.context ?? [];
  const resourceContexts = context.filter((ctx) => ctx.kind === 'resource');
  let resourceIndex = 0;
  const blockMode = [...context].reverse().find((ctx) => ctx.kind === 'route-mode')?.routeMode ?? null;
  const routeMode = fact.attributes?.routeMode ?? blockMode;

  for (const ctx of context) {
    if (ctx.dynamic) return { ok: false, reason: `dynamic ${ctx.kind} context` };
    if (ctx.kind === 'namespace' || ctx.kind === 'scope') {
      if (ctx.path) prefix = normalizeRailsCandidatePath(joinRoute(prefix, ctx.path));
      continue;
    }
    if (ctx.kind === 'route-mode') continue;
    if (ctx.kind !== 'resource') continue;

    const shape = resourceContextShape(ctx, prefix);
    if (!shape.ok) return shape;
    resourceIndex++;
    const isLastResource = resourceIndex === resourceContexts.length;

    if (fact.kind === 'resource') {
      if (!shape.nested) {
        return { ok: false, reason: `cannot conservatively derive nested parameter for resource '${ctx.name}'` };
      }
      prefix = shape.nested;
      continue;
    }

    if (fact.kind === 'route') {
      if (!isLastResource) {
        if (!shape.nested) {
          return { ok: false, reason: `cannot conservatively derive nested parameter for resource '${ctx.name}'` };
        }
        prefix = shape.nested;
        continue;
      }
      if (routeMode === 'member') {
        prefix = shape.member;
        continue;
      }
      if (routeMode === 'collection') {
        prefix = shape.collection;
        continue;
      }
      return { ok: false, reason: 'route inside resources requires explicit member/collection/on mode' };
    }
  }
  return { ok: true, path: prefix };
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
  if (fact.attributes?.singular) return { ok: true, collection, member: collection, memberParam: null };
  const explicitParam = fact.attributes?.param;
  const memberParam = explicitParam ?? 'id';
  return { ok: true, collection, member: joinRoute(collection, `{${memberParam}}`), memberParam };
}

export function expandRailsFacts(envelope, out) {
  for (const fact of envelope.facts) {
    if (fact.status === 'unknown') {
      if (fact.kind === 'route' || fact.kind === 'resource') {
        addUnknown(out, fact, 'DSL_DYNAMIC_DECLARATION', fact.unknownReason);
      }
      continue;
    }
    const prefix = contextPrefix(fact);
    if (!prefix.ok) {
      if (fact.kind === 'route' || fact.kind === 'resource') {
        addUnknown(out, fact, 'DSL_CONTEXT_UNRESOLVED', prefix.reason);
      }
      continue;
    }
    if (fact.kind === 'route') {
      if (fact.attributes?.path == null || !fact.attributes?.method) {
        addUnknown(out, fact, 'DSL_ROUTE_PARTIAL', 'route method/path are not both literal');
        continue;
      }
      addCandidate(out, envelope, fact, fact.attributes.method, normalizeRailsCandidatePath(joinRoute(prefix.path, fact.attributes.path)), {
        controller: fact.attributes.controller ?? null, action: fact.attributes.action ?? null,
      });
      continue;
    }
    if (fact.kind !== 'resource') continue;
    const shape = resourceShape(fact, prefix.path);
    if (!shape.ok) {
      addUnknown(out, fact, 'DSL_RESOURCE_KEY_UNRESOLVED', shape.reason);
      continue;
    }
    const { actions, unsupported } = resourceActions(fact);
    if (unsupported.length) {
      addUnknown(out, fact, 'DSL_RESOURCE_ACTION_UNSUPPORTED', `unsupported Rails actions: ${unsupported.join(', ')}`);
    }
    for (const action of actions) {
      for (const [method, where] of ROWS[action]) {
        const routePath = where === 'collection' ? shape.collection
          : where === 'member' ? shape.member
          : where === 'new' ? joinRoute(shape.collection, 'new')
          : joinRoute(shape.member, 'edit');
        addCandidate(out, envelope, fact, method, routePath, {
          resource: fact.declaration.name, action,
          controller: fact.attributes?.controller ?? fact.declaration.name,
          memberParam: shape.memberParam,
        });
      }
    }
  }
}
