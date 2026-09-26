export const ADVERSARIAL_FIXTURE_SCHEMA = 'bskel.trust-adversarial-fixtures/1';

const TOP_KEYS = new Set(['schema', 'revision', 'cases']);
const CASE_KEYS = new Set([
  'id', 'category', 'layer', 'attack', 'expected', 'status',
  'preconditions', 'observer', 'test_refs', 'self_report_sufficient',
]);
const OBSERVER_KEYS = new Set(['kind', 'assertion']);
const CATEGORIES = new Set(['filesystem', 'process', 'environment', 'network', 'output', 'time', 'secret', 'adapter', 'build', 'evidence']);
const LAYERS = new Set(['declaration', 'runner', 'evidence']);
const EXPECTED = new Set(['reject-before-launch', 'deny-at-runner', 'kill-and-cleanup', 'block-certification']);
const STATUSES = new Set(['covered-unit', 'specified-not-implemented']);
const OBSERVERS = new Set(['validator', 'file-bytes', 'socket', 'environment-capture', 'process-tree', 'network-probe', 'runner-artifact', 'evidence-verifier']);
const ID = /^TRUST-(FS|PROC|ENV|NET|OUT|TIME|SECRET|ADAPTER|BUILD|EVID)-\d{2}$/;

function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function error(errors, code, path, message) {
  errors.push({ code, path, message });
}

function unknownKeys(errors, obj, allowed, path) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) error(errors, 'UNKNOWN_FIELD', `${path}.${key}`, 'unknown fields are rejected');
  }
}

function strings(errors, value, path, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.some((x) => typeof x !== 'string' || x.length === 0)) {
    error(errors, 'INVALID_STRING_LIST', path, `must be an array of non-empty strings with at least ${min} item(s)`);
    return [];
  }
  return value;
}

export function validateAdversarialFixtureSpec(input) {
  const errors = [];
  if (!plain(input)) return { ok: false, errors: [{ code: 'INVALID_SPEC', path: '(root)', message: 'must be a plain object' }], value: null };
  unknownKeys(errors, input, TOP_KEYS, '(root)');
  if (input.schema !== ADVERSARIAL_FIXTURE_SCHEMA) error(errors, 'UNSUPPORTED_SCHEMA', 'schema', `must equal ${ADVERSARIAL_FIXTURE_SCHEMA}`);
  if (!Number.isInteger(input.revision) || input.revision < 1) error(errors, 'INVALID_REVISION', 'revision', 'must be a positive integer');
  if (!Array.isArray(input.cases) || input.cases.length === 0) {
    error(errors, 'INVALID_CASES', 'cases', 'must be a non-empty array');
    return { ok: false, errors, value: null };
  }

  const ids = new Set();
  const normalized = [];
  for (let i = 0; i < input.cases.length; i += 1) {
    const item = input.cases[i];
    const p = `cases[${i}]`;
    if (!plain(item)) {
      error(errors, 'INVALID_CASE', p, 'must be a plain object');
      continue;
    }
    unknownKeys(errors, item, CASE_KEYS, p);
    if (typeof item.id !== 'string' || !ID.test(item.id)) error(errors, 'INVALID_CASE_ID', `${p}.id`, 'must use the TRUST-<category>-NN form');
    else if (ids.has(item.id)) error(errors, 'DUPLICATE_CASE_ID', `${p}.id`, item.id);
    else ids.add(item.id);

    if (!CATEGORIES.has(item.category)) error(errors, 'INVALID_CATEGORY', `${p}.category`, 'unsupported category');
    if (!LAYERS.has(item.layer)) error(errors, 'INVALID_LAYER', `${p}.layer`, 'unsupported layer');
    if (typeof item.attack !== 'string' || item.attack.length === 0) error(errors, 'INVALID_ATTACK', `${p}.attack`, 'must be non-empty text');
    if (!EXPECTED.has(item.expected)) error(errors, 'INVALID_EXPECTED', `${p}.expected`, 'unsupported expected outcome');
    if (!STATUSES.has(item.status)) error(errors, 'INVALID_STATUS', `${p}.status`, 'unsupported status');
    const preconditions = strings(errors, item.preconditions ?? [], `${p}.preconditions`);
    const testRefs = strings(errors, item.test_refs ?? [], `${p}.test_refs`);

    if (!plain(item.observer)) {
      error(errors, 'INVALID_OBSERVER', `${p}.observer`, 'must be an object');
    } else {
      unknownKeys(errors, item.observer, OBSERVER_KEYS, `${p}.observer`);
      if (!OBSERVERS.has(item.observer.kind)) error(errors, 'INVALID_OBSERVER_KIND', `${p}.observer.kind`, 'unsupported observer');
      if (typeof item.observer.assertion !== 'string' || item.observer.assertion.length === 0) error(errors, 'INVALID_OBSERVER_ASSERTION', `${p}.observer.assertion`, 'must be non-empty text');
    }
    if (item.self_report_sufficient !== false) error(errors, 'SELF_REPORT_FORBIDDEN', `${p}.self_report_sufficient`, 'candidate self-report can never be sufficient');

    if (item.status === 'covered-unit' && item.layer !== 'declaration') {
      error(errors, 'RUNTIME_COVERAGE_OVERCLAIM', `${p}.status`, 'only declaration-layer cases can be marked covered-unit before runner enforcement exists');
    }
    if (item.status === 'covered-unit' && testRefs.length === 0) {
      error(errors, 'MISSING_TEST_REF', `${p}.test_refs`, 'covered-unit requires at least one test reference');
    }
    if (item.status === 'specified-not-implemented' && testRefs.length > 0) {
      error(errors, 'UNIMPLEMENTED_WITH_TEST_REF', `${p}.test_refs`, 'unimplemented cases must not imply coverage through test references');
    }
    if (item.layer !== 'declaration' && item.observer?.kind === 'validator') {
      error(errors, 'WEAK_RUNTIME_OBSERVER', `${p}.observer.kind`, 'runner/evidence cases require an external observer, not the declaration validator');
    }
    if (item.layer === 'declaration' && item.expected !== 'reject-before-launch') {
      error(errors, 'DECLARATION_EXPECTATION_MISMATCH', `${p}.expected`, 'declaration-layer cases must reject before launch');
    }

    normalized.push({
      id: item.id,
      category: item.category,
      layer: item.layer,
      attack: item.attack,
      expected: item.expected,
      status: item.status,
      preconditions: [...preconditions],
      observer: plain(item.observer) ? { kind: item.observer.kind, assertion: item.observer.assertion } : item.observer,
      test_refs: [...testRefs],
      self_report_sufficient: false,
    });
  }

  normalized.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? { schema: ADVERSARIAL_FIXTURE_SCHEMA, revision: input.revision, cases: normalized } : null };
}

export function summarizeAdversarialFixtureSpec(input) {
  const result = validateAdversarialFixtureSpec(input);
  if (!result.ok) {
    const err = new TypeError('invalid adversarial fixture specification');
    err.code = 'INVALID_ADVERSARIAL_FIXTURE_SPEC';
    err.details = result.errors;
    throw err;
  }
  const byLayer = Object.create(null);
  const byStatus = Object.create(null);
  for (const item of result.value.cases) {
    byLayer[item.layer] = (byLayer[item.layer] ?? 0) + 1;
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
  }
  return Object.freeze({
    total: result.value.cases.length,
    by_layer: Object.freeze(byLayer),
    by_status: Object.freeze(byStatus),
    runner_enforcement_ready: result.value.cases.filter((x) => x.layer === 'runner' && x.status === 'specified-not-implemented').length,
  });
}
