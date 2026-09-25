// T09 shadow-suite entrypoint so the repository's existing test/*.test.mjs command executes the nested tests.
import './reconciliation-next/decision-graph.test.mjs';
import './reconciliation-next/openapi-integration.test.mjs';
import './reconciliation-next/openapi-context.test.mjs';
