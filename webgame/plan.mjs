import { evaluateWebgameExecutionApproval } from './trust-policy.mjs';

export function buildWebgameExecutionPlan(contract, { approval = null } = {}) {
  if (!contract || contract.schema !== 'sbf.webgame-runtime/1') throw new Error('buildWebgameExecutionPlan requires a normalized sbf.webgame-runtime/1 contract');
  const authorization = evaluateWebgameExecutionApproval(contract, approval);
  return {
    schema: 'sbf.webgame-execution-plan/1',
    project_id: contract.project_id,
    contract_file: contract.file,
    source: { ...contract.source },
    execution: {
      available: authorization.approved,
      blocked_by: authorization.blocked_by,
      declared_trust: contract.source.trust,
      approval_id: authorization.approval_id,
    },
    build: { argv: [...contract.build.argv], output_dir: contract.build.output_dir },
    serve: { argv: [...contract.serve.argv], url: contract.serve.url, ready_path: contract.serve.ready_path },
    browser: { ...contract.browser },
    probe: { ...contract.probe },
    scenarios: contract.scenarios.map((scenario) => ({
      id: scenario.id,
      action: { ...scenario.action },
      assertions: scenario.assertions.map((assertion) => JSON.parse(JSON.stringify(assertion))),
    })),
    notes: authorization.approved
      ? ['Plan is side-effect free. Execution still requires an owned process session and isolated browser driver.']
      : ['Runtime contracts cannot grant themselves execution authority; an out-of-band approval must match project_id and source_root.'],
  };
}
