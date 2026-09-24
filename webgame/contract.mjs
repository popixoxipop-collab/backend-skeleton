import { assertWebgameRuntimeSemantics } from './semantic-validation.mjs';

export class WebgameRuntimeContractError extends Error {
  constructor(message, { file = null, errors = [] } = {}) {
    super(message);
    this.name = 'WebgameRuntimeContractError';
    this.file = file;
    this.errors = errors;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function parseWebgameRuntimeContract(raw, { file = null } = {}) {
  try {
    assertWebgameRuntimeSemantics(raw);
  } catch (error) {
    throw new WebgameRuntimeContractError(error.message, { file, errors: error.errors ?? [] });
  }
  const value = clone(raw);
  return {
    schema: 'sbf.webgame-runtime/1',
    file,
    project_id: value.project_id,
    source: value.source,
    build: value.build,
    serve: value.serve,
    browser: value.browser,
    probe: value.probe,
    scenarios: value.scenarios,
    execution_trust: value.source.trust === 'owned' || value.source.trust === 'trusted' ? 'approved' : 'inventory-only',
    summary: {
      scenario_count: value.scenarios.length,
      assertion_count: value.scenarios.reduce((count, scenario) => count + scenario.assertions.length, 0),
    },
  };
}
