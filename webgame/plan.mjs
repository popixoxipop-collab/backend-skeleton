export function buildWebgameExecutionPlan(contract) {
  if (!contract || contract.schema !== 'sbf.webgame-runtime/1') throw new Error('buildWebgameExecutionPlan requires a normalized sbf.webgame-runtime/1 contract');
  const executable = contract.execution_trust === 'approved';
  return {
    schema: 'sbf.webgame-execution-plan/1',
    project_id: contract.project_id,
    contract_file: contract.file,
    source: { ...contract.source },\n    execution: {
      available: executable,
      blocked_by: executable ? [] : ['source.trust'],
      trust: contract.source.trust,
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
    notes: executable
      ? ['Plan is side-effect free. Execution still requires an owned process session and isolated browser driver.']
      : ['Reference sources are inventory-only and cannot be promoted to executable code by this plan.'],
  };
}
