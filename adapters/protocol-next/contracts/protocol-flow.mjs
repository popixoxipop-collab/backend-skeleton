import { createHash } from 'node:crypto';
import { PROTOCOL_FAMILIES } from './protocol.mjs';

export const PROTOCOL_FLOW_VERSION = '1';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sortedUniqueStrings(values, label) {
  const out = [...new Set((values ?? []).map((value) => String(value)))].sort();
  if (out.some((value) => value.length === 0)) throw new Error(label + ' cannot contain an empty reference');
  return out;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(label + ' must be a non-empty string');
  return value;
}

function normalizeCorrelation(item, stepId) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('step ' + stepId + ' has an invalid correlation');
  return {
    key: requireString(item.key, 'correlation.key'),
    with_step: requireString(item.with_step, 'correlation.with_step'),
    local_ref: requireString(item.local_ref, 'correlation.local_ref'),
    remote_ref: requireString(item.remote_ref, 'correlation.remote_ref'),
  };
}

function normalizeStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('flow step must be an object');
  const id = requireString(step.id, 'step.id');
  const family = requireString(step.family, 'step.family');
  if (!PROTOCOL_FAMILIES.includes(family)) throw new Error('step ' + id + ' uses unsupported protocol family ' + JSON.stringify(family));
  const after = sortedUniqueStrings(step.after, 'step.after');
  const causedBy = sortedUniqueStrings(step.caused_by, 'step.caused_by');
  const correlations = (step.correlations ?? []).map((item) => normalizeCorrelation(item, id))
    .sort((a, b) => a.key.localeCompare(b.key) || a.with_step.localeCompare(b.with_step) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const retry = step.retry == null ? null : {
    max_attempts: Number(step.retry.max_attempts),
    backoff_ms: step.retry.backoff_ms == null ? null : Number(step.retry.backoff_ms),
  };
  if (retry && (!Number.isInteger(retry.max_attempts) || retry.max_attempts < 1)) throw new Error('step ' + id + ' retry.max_attempts must be an integer >= 1');
  if (retry?.backoff_ms != null && (!Number.isFinite(retry.backoff_ms) || retry.backoff_ms < 0)) throw new Error('step ' + id + ' retry.backoff_ms must be >= 0');
  const timeoutMs = step.timeout_ms == null ? null : Number(step.timeout_ms);
  if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error('step ' + id + ' timeout_ms must be > 0');
  const idempotency = step.idempotency == null ? null : {
    key_ref: requireString(step.idempotency.key_ref, 'step.idempotency.key_ref'),
    required: step.idempotency.required !== false,
  };
  return {
    id,
    family,
    action_ref: requireString(step.action_ref, 'step.action_ref'),
    after,
    caused_by: causedBy,
    correlations,
    idempotency,
    retry,
    timeout_ms: timeoutMs,
  };
}

function validateReferences(steps) {
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) throw new Error('protocol flow contains duplicate step ids');
  for (const step of steps) {
    const refs = [...step.after, ...step.caused_by, ...step.correlations.map((item) => item.with_step)];
    for (const ref of refs) {
      if (ref === step.id) throw new Error('step ' + step.id + ' cannot reference itself');
      if (!ids.has(ref)) throw new Error('step ' + step.id + ' references unknown step ' + JSON.stringify(ref));
    }
  }
}

function validateAcyclicOrdering(steps) {
  const deps = new Map(steps.map((step) => [step.id, new Set([...step.after, ...step.caused_by])]));
  const temporary = new Set();
  const permanent = new Set();
  function visit(id) {
    if (permanent.has(id)) return;
    if (temporary.has(id)) throw new Error('protocol flow ordering contains a cycle at step ' + id);
    temporary.add(id);
    for (const dep of deps.get(id) ?? []) visit(dep);
    temporary.delete(id);
    permanent.add(id);
  }
  for (const step of steps) visit(step.id);
}

export function buildProtocolFlowContract({ featureId, featureUid, scenario }) {
  requireString(featureId, 'featureId');
  requireString(featureUid, 'featureUid');
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) throw new Error('scenario must be an object');
  const scenarioId = requireString(scenario.id, 'scenario.id');
  const steps = (scenario.steps ?? []).map(normalizeStep).sort((a, b) => a.id.localeCompare(b.id));
  if (steps.length === 0) throw new Error('protocol flow requires at least one step');
  validateReferences(steps);
  validateAcyclicOrdering(steps);

  const ordering = [];
  const causation = [];
  const correlation = [];
  for (const step of steps) {
    for (const predecessor of step.after) ordering.push({ before: predecessor, after: step.id, provenance: 'explicit-after' });
    for (const predecessor of step.caused_by) causation.push({ cause: predecessor, effect: step.id, provenance: 'explicit-caused-by' });
    for (const item of step.correlations) {
      correlation.push({
        key: item.key,
        left_step: item.with_step,
        left_ref: item.remote_ref,
        right_step: step.id,
        right_ref: item.local_ref,
        provenance: 'explicit-correlation',
      });
    }
  }
  ordering.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  causation.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  correlation.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  return {
    sbf_protocol_flow: PROTOCOL_FLOW_VERSION,
    feature_id: featureId,
    feature_uid: featureUid,
    scenario_id: scenarioId,
    steps: clone(steps),
    relations: { ordering, causation, correlation },
    semantics: {
      ordering_does_not_imply_causation: true,
      correlation_does_not_imply_causation: true,
    },
  };
}

export function protocolFlowDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
