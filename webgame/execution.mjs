import { evaluateScenarioEvidence } from './assertions.mjs';

export async function executeWebgamePlan(plan, { driver }) {
  if (!plan || plan.schema !== 'sbf.webgame-execution-plan/1') throw new Error('executeWebgamePlan requires an sbf.webgame-execution-plan/1');
  if (!plan.execution.available) {
    return { schema: 'sbf.webgame-runtime-result/1', project_id: plan.project_id, verdict: 'blocked', blocked_by: [...plan.execution.blocked_by], scenarios: [] };
  }
  if (!driver || typeof driver.open !== 'function' || typeof driver.runScenario !== 'function' || typeof driver.close !== 'function') {
    throw new Error('executeWebgamePlan requires an explicit isolated browser driver');
  }
  const scenarios = [];
  let openAttempted = false;
  try {
    openAttempted = true;
    await driver.open(plan);
    for (const scenario of plan.scenarios) {
      const samples = await driver.runScenario(scenario, plan);
      scenarios.push(evaluateScenarioEvidence(scenario, samples));
    }
  } finally {
    if (openAttempted) await driver.close();
  }
  return {
    schema: 'sbf.webgame-runtime-result/1',
    project_id: plan.project_id,
    verdict: scenarios.every((scenario) => scenario.verdict === 'passed') ? 'passed' : 'failed',
    evidence_scope: 'ungated-runtime-evidence',
    scenarios,
  };
}
