export function evaluateWebgameCapabilities(plan, available = {}) {
  if (!plan || plan.schema !== 'sbf.webgame-execution-plan/1') throw new Error('evaluateWebgameCapabilities requires an execution plan');
  const required = ['loopback-server', 'isolated-browser', 'webgame-probe', `browser.${plan.browser.name}`];
  const missing = required.filter((capability) => available[capability] !== true);
  return {
    required,
    missing,
    status: missing.length === 0 ? 'ready' : 'unsupported',
  };
}
