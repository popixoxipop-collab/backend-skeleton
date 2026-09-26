import { assertDslFactsEnvelope } from './dsl-facts.mjs';
import { createRouteCandidateEnvelope, finalizeCandidates, assertDslRouteCandidates, DSL_ROUTE_CANDIDATES_CONTRACT } from './_route-candidates.mjs';
import { expandRailsFacts } from './expand-rails.mjs';
import { expandLaravelFacts } from './expand-laravel.mjs';
import { expandSymfonyFacts } from './expand-symfony.mjs';

export { DSL_ROUTE_CANDIDATES_CONTRACT, assertDslRouteCandidates };

export function expandDslFacts(envelope) {
  assertDslFactsEnvelope(envelope);
  const out = createRouteCandidateEnvelope(envelope);
  if (envelope.framework === 'rails') expandRailsFacts(envelope, out);
  else if (envelope.framework === 'laravel') expandLaravelFacts(envelope, out);
  else if (envelope.framework === 'symfony') expandSymfonyFacts(envelope, out);
  else throw new TypeError(`unsupported DSL fact framework: ${envelope.framework}`);
  return finalizeCandidates(out);
}
