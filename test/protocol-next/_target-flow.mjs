import { buildProtocolFlowContract, protocolFlowDigest } from '../../adapters/protocol-next/contracts/protocol-flow.mjs';
import { protocolContext, protocolItem } from './_helpers.mjs';
import { runCase } from './_target-helpers.mjs';

const FEATURE = Object.freeze({ featureId: 'protocol-target-flow', featureUid: 'uid-protocol-target-flow' });

function contextFor(family, casesById, caseId) {
  const fixture = casesById.get(caseId);
  if (!fixture) throw new Error('flow case references unknown scan case ' + caseId);
  const outcome = runCase(family, fixture);
  if (!outcome.ok) throw new Error('scan case ' + caseId + ' did not load: ' + outcome.error);
  return protocolContext(outcome.scan, FEATURE);
}

function resolveAction(context, family, action) {
  const items = context.contract.planes[family][action.plane] ?? [];
  const index = items.findIndex((item) => Object.entries(action.match).every(([key, value]) => item[key] === value));
  if (index < 0) throw new Error('no ' + family + '.' + action.plane + ' item matches ' + JSON.stringify(action.match));
  return protocolItem(context, { family, plane: action.plane, index });
}

function buildSteps(flowCase, contexts, { stripped = false, dropped = [] } = {}) {
  return flowCase.steps.map((step) => {
    const { action, action_case: actionCase, ...rest } = step;
    const kept = stripped ? Object.fromEntries(Object.entries(rest).filter(([key]) => !dropped.includes(key))) : rest;
    return { ...kept, family: flowCase.family, action_ref: resolveAction(contexts.get(actionCase ?? flowCase.scan_case), flowCase.family, action) };
  });
}

function buildFlow(flowCase, contexts, steps) {
  const contextList = (flowCase.contexts ?? [flowCase.scan_case]).map((caseId) => contexts.get(caseId));
  return buildProtocolFlowContract({ ...FEATURE, scenario: { id: flowCase.id, steps }, protocolContexts: contextList });
}

// Everything a builder step can carry; any other key on an input step is silently dropped by the builder.
export const BUILDER_STEP_KEYS = Object.freeze(['id', 'family', 'action_ref', 'after', 'caused_by', 'correlations', 'idempotency', 'retry', 'timeout_ms']);

function projectFlow(flow) {
  return {
    steps: flow.steps.map((step) => ({
      id: step.id,
      plane: step.action_ref.plane,
      retry: step.retry,
      idempotency: step.idempotency,
      timeout_ms: step.timeout_ms,
      after: step.after,
      caused_by: step.caused_by,
      correlations: step.correlations.length,
    })),
    relations: flow.relations,
  };
}

// Builds a flow case against the real flow-contract builder. `casesById` maps scan-case ids to fixture cases.
export function runFlowCase(flowCase, casesById) {
  const needed = new Set([flowCase.scan_case, ...(flowCase.contexts ?? []), ...flowCase.steps.map((step) => step.action_case).filter(Boolean)]);
  if (flowCase.contrast?.scan_case) needed.add(flowCase.contrast.scan_case);
  const contexts = new Map([...needed].map((caseId) => [caseId, contextFor(flowCase.family, casesById, caseId)]));
  let flow;
  try {
    flow = buildFlow(flowCase, contexts, buildSteps(flowCase, contexts));
  } catch (error) {
    return { outcome: 'rejected', error: String(error?.message ?? error) };
  }
  const dropped = [...new Set(flowCase.steps.flatMap((step) => Object.keys(step).filter((key) => key !== 'action' && key !== 'action_case' && !BUILDER_STEP_KEYS.includes(key))))].sort();
  const result = { outcome: 'built', ...projectFlow(flow), dropped_step_fields: dropped };
  if (dropped.length > 0) {
    const stripped = buildFlow(flowCase, contexts, buildSteps(flowCase, contexts, { stripped: true, dropped }));
    result.digest_equal_without_dropped = protocolFlowDigest(flow) === protocolFlowDigest(stripped);
  }
  if (flowCase.contrast?.scan_case) {
    const otherCase = { ...flowCase, scan_case: flowCase.contrast.scan_case, contexts: [flowCase.contrast.scan_case], steps: flowCase.steps.map(({ action_case: _ignored, ...step }) => step) };
    const otherFlow = buildFlow(otherCase, contexts, buildSteps(otherCase, contexts));
    result.contrast_projection_equal = JSON.stringify(projectFlow(flow)) === JSON.stringify(projectFlow(otherFlow));
  }
  return result;
}
