import { addCandidate, addUnknown, joinRoute, regularSingular } from './_route-candidates.mjs';

const ROWS = Object.freeze({
  index: [['GET', 'collection']], store: [['POST', 'collection']], show: [['GET', 'member']],
  edit: [['GET', 'edit']], update: [['PUT', 'member'], ['PATCH', 'member']], destroy: [['DELETE', 'member']],
});
const RESOURCE_ACTIONS = Object.freeze(['index', 'create', 'show', 'edit', 'update', 'destroy']);
const API_RESOURCE_ACTIONS = Object.freeze(['index', 'create', 'show', 'update', 'destroy']);

function groupPrefix(fact) {
  const segments = [];
  for (const ctx of fact.context ?? []) {
    if (ctx.dynamic) return { ok: false, reason: 'dynamic Laravel group context' };
    if (ctx.prefix) segments.push(ctx.prefix);
  }
  return { ok: true, path: joinRoute(...segments) };
}

function resourceActions(fact) {
  const defaults = fact.attributes?.apiOnly ? API_RESOURCE_ACTIONS : RESOURCE_ACTIONS;
  const actions = new Set(fact.attributes?.only ?? defaults);
  for (const action of fact.attributes?.except ?? []) actions.delete(action);
  if (actions.delete('create')) actions.add('store');
  const unsupported = [...actions].filter((action) => !Object.hasOwn(ROWS, action));
  for (const action of unsupported) actions.delete(action);
  return { actions: [...actions], unsupported };
}

export function expandLaravelFacts(envelope, out) {
  for (const fact of envelope.facts) {
    if (fact.status === 'unknown') {
      if (fact.kind === 'route' || fact.kind === 'resource') {
        addUnknown(out, fact, 'DSL_DYNAMIC_DECLARATION', fact.unknownReason);
      }
      continue;
    }
    const prefix = groupPrefix(fact);
    if (!prefix.ok) {
      if (fact.kind === 'route' || fact.kind === 'resource') {
        addUnknown(out, fact, 'DSL_CONTEXT_UNRESOLVED', prefix.reason);
      }
      continue;
    }
    if (fact.kind === 'route') {
      const methods = fact.attributes?.methods ?? [];
      if (fact.attributes?.path == null || methods.length === 0) {
        addUnknown(out, fact, 'DSL_ROUTE_PARTIAL', 'Laravel route URI/method set is incomplete');
        continue;
      }
      for (const method of methods) {
        addCandidate(out, envelope, fact, method, joinRoute(prefix.path, fact.attributes.path), {
          declaredName: fact.attributes.routeName ?? null,
        });
      }
      continue;
    }
    if (fact.kind !== 'resource') continue;
    const name = fact.declaration.name;
    const memberParam = regularSingular(name ?? '');
    if (!name || !memberParam) {
      addUnknown(out, fact, 'DSL_RESOURCE_KEY_UNRESOLVED', `cannot conservatively derive Laravel resource parameter from '${name ?? '<dynamic>'}'`);
      continue;
    }
    const collection = joinRoute(prefix.path, name);
    const member = joinRoute(collection, `{${memberParam}}`);
    const { actions, unsupported } = resourceActions(fact);
    if (unsupported.length) {
      addUnknown(out, fact, 'DSL_RESOURCE_ACTION_UNSUPPORTED', `unsupported Laravel actions: ${unsupported.join(', ')}`);
    }
    for (const action of actions) {
      for (const [method, where] of ROWS[action]) {
        const routePath = where === 'collection' ? collection
          : where === 'member' ? member
          : joinRoute(member, 'edit');
        addCandidate(out, envelope, fact, method, routePath, { resource: name, action, memberParam });
      }
    }
  }
}
