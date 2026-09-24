const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ASSERTION_TYPES = new Set([
  'render_frames',
  'player_displacement',
  'camera_only_reject',
  'max_step',
  'vertical_bounds',
  'wall_crossing_reject',
  'interaction_count',
]);
const ACTION_TYPES = new Set(['key', 'wait', 'interact']);

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function push(errors, condition, message) {
  if (!condition) errors.push(message);
}

function validateArgv(errors, argv, label) {
  push(errors, Array.isArray(argv) && argv.length > 0, `${label}.argv must be a non-empty string array`);
  if (!Array.isArray(argv)) return;
  argv.forEach((arg, index) => push(errors, typeof arg === 'string' && arg.length > 0, `${label}.argv[${index}] must be a non-empty string`));
}

function repoRelative(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]/).some((part) => part === '..');
}

function loopbackUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function validateAssertion(errors, assertion, label) {
  push(errors, plain(assertion), `${label} must be an object`);
  if (!plain(assertion)) return;
  push(errors, ASSERTION_TYPES.has(assertion.type), `${label}.type is not supported: ${String(assertion.type)}`);
  if (!ASSERTION_TYPES.has(assertion.type)) return;
  switch (assertion.type) {
    case 'render_frames':
      push(errors, finite(assertion.min_delta) && assertion.min_delta >= 1, `${label}.min_delta must be >= 1`);
      break;
    case 'player_displacement':
      push(errors, finite(assertion.min) && assertion.min >= 0, `${label}.min must be >= 0`);
      if (assertion.max !== undefined) push(errors, finite(assertion.max) && assertion.max >= assertion.min, `${label}.max must be >= min`);
      break;
    case 'camera_only_reject':
      push(errors, finite(assertion.min_player) && assertion.min_player > 0, `${label}.min_player must be > 0`);
      break;
    case 'max_step':
      push(errors, finite(assertion.max) && assertion.max > 0, `${label}.max must be > 0`);
      break;
    case 'vertical_bounds':
      push(errors, finite(assertion.max_drop) && assertion.max_drop >= 0, `${label}.max_drop must be >= 0`);
      push(errors, finite(assertion.max_rise) && assertion.max_rise >= 0, `${label}.max_rise must be >= 0`);
      break;
    case 'wall_crossing_reject': {
      push(errors, plain(assertion.plane), `${label}.plane must be an object`);
      const n = assertion.plane?.normal;
      push(errors, plain(n) && finite(n.x) && finite(n.y) && finite(n.z), `${label}.plane.normal must be a finite vec3`);
      push(errors, finite(assertion.plane?.constant), `${label}.plane.constant must be finite`);
      push(errors, ['positive', 'negative'].includes(assertion.allowed_sign), `${label}.allowed_sign must be positive or negative`);
      if (assertion.tolerance !== undefined) push(errors, finite(assertion.tolerance) && assertion.tolerance >= 0, `${label}.tolerance must be >= 0`);
      break;
    }
    case 'interaction_count':
      if (assertion.exact !== undefined) push(errors, Number.isInteger(assertion.exact) && assertion.exact >= 0, `${label}.exact must be a non-negative integer`);
      if (assertion.min !== undefined) push(errors, Number.isInteger(assertion.min) && assertion.min >= 0, `${label}.min must be a non-negative integer`);
      if (assertion.max !== undefined) push(errors, Number.isInteger(assertion.max) && assertion.max >= 0, `${label}.max must be a non-negative integer`);
      push(errors, assertion.exact !== undefined || assertion.min !== undefined || assertion.max !== undefined, `${label} must declare exact, min, or max`);
      break;
  }
}

export function webgameRuntimeSemanticErrors(raw) {
  const errors = [];
  push(errors, plain(raw), 'runtime contract must be an object');
  if (!plain(raw)) return errors;
  push(errors, raw.sbf_webgame_runtime === '1', 'sbf_webgame_runtime must equal "1"');
  push(errors, typeof raw.project_id === 'string' && ID_RE.test(raw.project_id), 'project_id must match ^[a-z0-9][a-z0-9-]*$');
  push(errors, plain(raw.source), 'source must be an object');
  if (plain(raw.source)) {
    push(errors, ['owned', 'trusted', 'reference'].includes(raw.source.trust), 'source.trust must be owned, trusted, or reference');
    push(errors, repoRelative(raw.source.root), 'source.root must be repository-relative and must not traverse upward');
  }
  push(errors, plain(raw.build), 'build must be an object');
  if (plain(raw.build)) {
    validateArgv(errors, raw.build.argv, 'build');
    push(errors, repoRelative(raw.build.output_dir), 'build.output_dir must be repository-relative');
  }
  push(errors, plain(raw.serve), 'serve must be an object');
  if (plain(raw.serve)) {
    validateArgv(errors, raw.serve.argv, 'serve');
    push(errors, loopbackUrl(raw.serve.url), 'serve.url must use loopback HTTP(S)');
    push(errors, typeof raw.serve.ready_path === 'string' && raw.serve.ready_path.startsWith('/'), 'serve.ready_path must start with /');
  }
  push(errors, plain(raw.browser), 'browser must be an object');
  if (plain(raw.browser)) {
    push(errors, ['chromium', 'firefox', 'webkit'].includes(raw.browser.name), 'browser.name must be chromium, firefox, or webkit');
    push(errors, typeof raw.browser.headless === 'boolean', 'browser.headless must be boolean');
    if (raw.browser.required_workers !== undefined) push(errors, Number.isInteger(raw.browser.required_workers) && raw.browser.required_workers >= 0, 'browser.required_workers must be a non-negative integer');
    if (raw.browser.worker_timeout_ms !== undefined) push(errors, Number.isInteger(raw.browser.worker_timeout_ms) && raw.browser.worker_timeout_ms > 0, 'browser.worker_timeout_ms must be a positive integer');
  }
  push(errors, plain(raw.probe), 'probe must be an object');
  if (plain(raw.probe)) {
    push(errors, typeof raw.probe.global === 'string' && /^__[A-Z0-9_]+__$/.test(raw.probe.global), 'probe.global must be an explicit __NAME__ global');
    push(errors, Number.isInteger(raw.probe.sample_interval_ms) && raw.probe.sample_interval_ms >= 10, 'probe.sample_interval_ms must be an integer >= 10');
  }
  push(errors, Array.isArray(raw.scenarios) && raw.scenarios.length > 0, 'scenarios must be a non-empty array');
  if (Array.isArray(raw.scenarios)) {
    const ids = new Set();
    raw.scenarios.forEach((scenario, index) => {
      const label = `scenarios[${index}]`;
      push(errors, plain(scenario), `${label} must be an object`);
      if (!plain(scenario)) return;
      push(errors, typeof scenario.id === 'string' && ID_RE.test(scenario.id), `${label}.id must be a canonical id`);
      if (ids.has(scenario.id)) errors.push(`${label}.id is duplicated: ${scenario.id}`);
      ids.add(scenario.id);
      push(errors, plain(scenario.action), `${label}.action must be an object`);
      if (plain(scenario.action)) {
        push(errors, ACTION_TYPES.has(scenario.action.type), `${label}.action.type is unsupported`);
        if (scenario.action.type === 'key') {
          push(errors, typeof scenario.action.key === 'string' && scenario.action.key.length > 0, `${label}.action.key must be non-empty`);
          push(errors, Number.isInteger(scenario.action.duration_ms) && scenario.action.duration_ms > 0, `${label}.action.duration_ms must be > 0`);
        }
        if (scenario.action.type === 'wait') push(errors, Number.isInteger(scenario.action.duration_ms) && scenario.action.duration_ms > 0, `${label}.action.duration_ms must be > 0`);
      }
      push(errors, Array.isArray(scenario.assertions) && scenario.assertions.length > 0, `${label}.assertions must be a non-empty array`);
      if (Array.isArray(scenario.assertions)) scenario.assertions.forEach((assertion, aIndex) => validateAssertion(errors, assertion, `${label}.assertions[${aIndex}]`));
    });
  }
  return errors;
}

export function assertWebgameRuntimeSemantics(raw) {
  const errors = webgameRuntimeSemanticErrors(raw);
  if (errors.length) {
    const error = new Error(`invalid webgame runtime contract: ${errors.join('; ')}`);
    error.name = 'WebgameRuntimeContractError';
    error.errors = errors;
    throw error;
  }
  return raw;
}
