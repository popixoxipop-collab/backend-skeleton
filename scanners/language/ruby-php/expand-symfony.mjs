import { addCandidate, addUnknown, joinRoute } from './_route-candidates.mjs';

export function expandSymfonyFacts(envelope, out) {
  let classPrefix = null;
  for (const fact of envelope.facts) {
    if (fact.kind !== 'attribute') continue;
    if (fact.status === 'unknown') {
      addUnknown(out, fact, 'DSL_DYNAMIC_DECLARATION', fact.unknownReason);
      continue;
    }
    if (fact.attributes?.targetKind === 'class') {
      classPrefix = fact.attributes.path ?? null;
      continue;
    }
    if (fact.attributes?.targetKind !== 'method') {
      addUnknown(
        out,
        fact,
        'DSL_ATTRIBUTE_TARGET_UNRESOLVED',
        'Route attribute is not attached to a class or method declaration',
      );
      continue;
    }
    const methods = fact.attributes.methods ?? [];
    if (methods.length === 0) {
      addUnknown(
        out,
        fact,
        'DSL_ROUTE_PARTIAL',
        'Symfony Route attribute has no literal methods; implicit method set is intentionally not guessed',
      );
      continue;
    }
    for (const method of methods) {
      addCandidate(out, envelope, fact, method, joinRoute(classPrefix, fact.attributes.path), {
        declaredName: fact.attributes.routeName ?? null,
        target: fact.attributes.targetName ?? null,
      });
    }
  }
}
