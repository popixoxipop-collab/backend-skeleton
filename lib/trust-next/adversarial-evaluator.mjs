import { validateAdversarialFixtureSpec } from './adversarial-fixture-spec.mjs';

export const ADVERSARIAL_EVALUATION_CONTRACT = 'bskel.trust-adversarial-evaluation/1';

const OUTCOMES = new Set(['pass', 'fail', 'blocked']);
const EVIDENCE_REF = /^sha256:[0-9a-f]{64}$/;

function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(code, message, details = null) {
  const error = new TypeError(message);
  error.code = code;
  if (details !== null) error.details = details;
  throw error;
}

function normalizeEvidenceRefs(value, field, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > 64) fail('ADVERSARIAL_RESULT_EVIDENCE_INVALID', `${field} must contain ${min}..64 refs`);
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const ref = value[i];
    if (typeof ref !== 'string' || !EVIDENCE_REF.test(ref) || /[\u0000-\u001f\u007f]/.test(ref)) {
      fail('ADVERSARIAL_RESULT_EVIDENCE_INVALID', `${field}[${i}] must use sha256:<64 lowercase hex>`);
    }
    out.push(ref);
  }
  return [...new Set(out)].sort();
}

export function evaluateAdversarialResults(specInput, resultsInput, {
  requiredLayers = ['runner', 'evidence'],
  verifiedEvidenceRefs = [],
} = {}) {
  const specValidation = validateAdversarialFixtureSpec(specInput);
  if (!specValidation.ok) fail('INVALID_ADVERSARIAL_FIXTURE_SPEC', 'fixture specification is invalid', specValidation.errors);
  if (!Array.isArray(requiredLayers) || requiredLayers.length === 0 ||
      requiredLayers.some((x) => !['declaration', 'runner', 'evidence'].includes(x))) {
    fail('ADVERSARIAL_EVALUATION_LAYERS_INVALID', 'requiredLayers must contain declaration/runner/evidence');
  }
  if (!Array.isArray(resultsInput) || resultsInput.length > 256) {
    fail('ADVERSARIAL_RESULTS_INVALID', 'results must be an array with at most 256 entries');
  }

  let verifiedRefs;
  try {
    verifiedRefs = normalizeEvidenceRefs(verifiedEvidenceRefs, 'verifiedEvidenceRefs');
  } catch (error) {
    fail(error.code, error.message);
  }
  const verifiedSet = new Set(verifiedRefs);

  const spec = specValidation.value;
  const required = new Map(spec.cases.filter((x) => requiredLayers.includes(x.layer)).map((x) => [x.id, x]));
  const seen = new Set();
  const normalized = [];
  const errors = [];

  for (let i = 0; i < resultsInput.length; i += 1) {
    const item = resultsInput[i];
    if (!plain(item)) {
      errors.push({ code: 'RESULT_INVALID', index: i, message: 'result must be a plain object' });
      continue;
    }
    const keys = new Set(['id', 'outcome', 'observer_kind', 'evidence_refs', 'blocked_reason']);
    for (const key of Object.keys(item)) {
      if (!keys.has(key)) errors.push({ code: 'RESULT_UNKNOWN_FIELD', id: item.id ?? null, field: key });
    }
    if (typeof item.id !== 'string' || !required.has(item.id)) {
      errors.push({ code: 'RESULT_UNKNOWN_CASE', id: item.id ?? null });
      continue;
    }
    if (seen.has(item.id)) {
      errors.push({ code: 'RESULT_DUPLICATE_CASE', id: item.id });
      continue;
    }
    seen.add(item.id);
    const expected = required.get(item.id);
    if (!OUTCOMES.has(item.outcome)) errors.push({ code: 'RESULT_OUTCOME_INVALID', id: item.id });
    if (item.observer_kind !== expected.observer.kind) {
      errors.push({ code: 'RESULT_OBSERVER_MISMATCH', id: item.id, expected: expected.observer.kind, actual: item.observer_kind ?? null });
    }

    let evidenceRefs = [];
    try {
      evidenceRefs = normalizeEvidenceRefs(item.evidence_refs ?? [], `results[${i}].evidence_refs`);
    } catch (error) {
      errors.push({ code: error.code, id: item.id, message: error.message });
    }
    if ((item.outcome === 'pass' || item.outcome === 'fail') && evidenceRefs.length === 0) {
      errors.push({ code: 'RESULT_EVIDENCE_REQUIRED', id: item.id, message: 'pass/fail requires external evidence refs' });
    }
    for (const ref of evidenceRefs) {
      if (!verifiedSet.has(ref)) {
        errors.push({ code: 'RESULT_EVIDENCE_NOT_VERIFIED', id: item.id, evidence_ref: ref });
      }
    }
    const blockedReason = item.blocked_reason ?? null;
    if (item.outcome === 'blocked' && (typeof blockedReason !== 'string' || blockedReason.trim().length < 3 || blockedReason.length > 500 || /[\u0000-\u001f\u007f]/.test(blockedReason))) {
      errors.push({ code: 'RESULT_BLOCKED_REASON_REQUIRED', id: item.id });
    }
    if (item.outcome !== 'blocked' && blockedReason !== null) {
      errors.push({ code: 'RESULT_BLOCKED_REASON_UNEXPECTED', id: item.id });
    }

    normalized.push({
      id: item.id,
      layer: expected.layer,
      outcome: OUTCOMES.has(item.outcome) ? item.outcome : 'blocked',
      observer_kind: item.observer_kind ?? null,
      evidence_refs: evidenceRefs,
      blocked_reason: item.outcome === 'blocked' && typeof blockedReason === 'string' ? blockedReason.trim() : null,
    });
  }

  const missing = [...required.keys()].filter((id) => !seen.has(id)).sort();
  const counts = { pass: 0, fail: 0, blocked: 0, missing: missing.length };
  for (const item of normalized) {
    if (counts[item.outcome] !== undefined) counts[item.outcome] += 1;
  }
  normalized.sort((a,b)=>a.id.localeCompare(b.id));

  const ready = errors.length === 0 && counts.fail === 0 && counts.blocked === 0 && counts.missing === 0 &&
    counts.pass === required.size;

  return Object.freeze({
    contract: ADVERSARIAL_EVALUATION_CONTRACT,
    required_layers: Object.freeze([...new Set(requiredLayers)].sort()),
    required_count: required.size,
    ready,
    counts: Object.freeze(counts),
    missing: Object.freeze(missing),
    errors: Object.freeze(errors),
    results: Object.freeze(normalized.map(Object.freeze)),
    note: ready
      ? 'All requested T20 adversarial cases have externally referenced observations; runtime/support certification still belongs to T16/T19/T00.'
      : 'Not ready: missing/blocked/failed/invalid adversarial evidence remains.',
  });
}
