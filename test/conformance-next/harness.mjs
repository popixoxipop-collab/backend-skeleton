import crypto from 'node:crypto';

const SHA40_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const VECTOR_CATEGORIES = new Set([
  'identity', 'project', 'route', 'schema', 'auth', 'db',
  'cache', 'run', 'game', 'trust', 'generation', 'release',
]);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniq(values) {
  return new Set(values).size === values.length;
}

function ratio(n, d) {
  return d === 0 ? null : n / d;
}

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function validateCorpusManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['manifest must be an object'] };
  }
  if (manifest.contract !== 'sbf.qa-corpus/1') errors.push('contract must be sbf.qa-corpus/1');
  if (!Array.isArray(manifest.entries)) errors.push('entries must be an array');
  if (!Array.isArray(manifest.holdout_entries)) errors.push('holdout_entries must be an array');
  if (errors.length) return { ok: false, errors };

  const all = [
    ...manifest.entries.map((entry) => ({ ...entry, split: 'reference' })),
    ...manifest.holdout_entries.map((entry) => ({ ...entry, split: 'holdout' })),
  ];
  const ids = [];
  const coordinates = [];
  const families = new Map();

  for (const [index, entry] of all.entries()) {
    const at = `${entry.split}[${index}]`;
    if (!nonEmptyString(entry.id)) errors.push(`${at}.id must be non-empty`);
    else ids.push(entry.id);
    if (!nonEmptyString(entry.adapter)) errors.push(`${at}.adapter must be non-empty`);
    if (!nonEmptyString(entry.owner) || !nonEmptyString(entry.repo)) errors.push(`${at} must pin owner and repo`);
    if (!SHA40_RE.test(entry.ref ?? '')) errors.push(`${at}.ref must be an exact 40-hex commit, never a branch/tag`);
    if (!nonEmptyString(entry.license_spdx)) errors.push(`${at}.license_spdx must be recorded before admission`);
    if (!nonEmptyString(entry.source_family)) errors.push(`${at}.source_family must identify a fork/template family`);
    if (!Array.isArray(entry.terms) || entry.terms.length === 0 || entry.terms.some((x) => !nonEmptyString(x))) {
      errors.push(`${at}.terms must contain at least one explicit search term`);
    }
    if (entry.path !== null && entry.path !== undefined && (!nonEmptyString(entry.path) || entry.path.startsWith('/') || entry.path.split('/').includes('..'))) {
      errors.push(`${at}.path must be a safe repo-relative subpath or null`);
    }
    if (!nonEmptyString(entry.golden_basis)) errors.push(`${at}.golden_basis must explain the independent expected-value source`);
    if (!Array.isArray(entry.expected_limitations)) errors.push(`${at}.expected_limitations must be an array`);
    if (nonEmptyString(entry.owner) && nonEmptyString(entry.repo) && SHA40_RE.test(entry.ref ?? '')) {
      coordinates.push(`${entry.owner}/${entry.repo}@${entry.ref}:${entry.path ?? ''}`);
    }
    if (nonEmptyString(entry.source_family)) {
      const seen = families.get(entry.source_family) ?? new Set();
      seen.add(entry.split);
      families.set(entry.source_family, seen);
    }
  }

  if (!uniq(ids)) errors.push('corpus entry ids must be unique across reference and holdout splits');
  if (!uniq(coordinates)) errors.push('the same repo/ref/subpath cannot appear twice');
  for (const [family, splits] of families) {
    if (splits.size > 1) errors.push(`source_family "${family}" crosses reference and holdout splits`);
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      reference_entries: manifest.entries.length,
      holdout_entries: manifest.holdout_entries.length,
      holdout_ready: manifest.holdout_entries.length > 0,
    },
  };
}

export function validateNegativeVectorCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return { ok: false, errors: ['catalog must be an object'] };
  if (catalog.contract !== 'sbf.qa-negative-vectors/1') errors.push('contract must be sbf.qa-negative-vectors/1');
  if (!Array.isArray(catalog.vectors)) errors.push('vectors must be an array');
  if (errors.length) return { ok: false, errors };

  const ids = [];
  for (const [i, vector] of catalog.vectors.entries()) {
    const at = `vectors[${i}]`;
    if (!nonEmptyString(vector.id)) errors.push(`${at}.id must be non-empty`);
    else ids.push(vector.id);
    if (!VECTOR_CATEGORIES.has(vector.category)) errors.push(`${at}.category is not recognized`);
    if (!['reject', 'preserve-unknown', 'block', 'detect'].includes(vector.expected)) errors.push(`${at}.expected is invalid`);
    if (typeof vector.critical !== 'boolean') errors.push(`${at}.critical must be boolean`);
    if (!nonEmptyString(vector.invariant)) errors.push(`${at}.invariant must be non-empty`);
    if (!nonEmptyString(vector.failure_signal)) errors.push(`${at}.failure_signal must be non-empty`);
  }
  if (!uniq(ids)) errors.push('negative vector ids must be unique');

  const categories = Object.fromEntries([...VECTOR_CATEGORIES].map((name) => [name, 0]));
  for (const vector of catalog.vectors) if (VECTOR_CATEGORIES.has(vector.category)) categories[vector.category]++;
  return { ok: errors.length === 0, errors, stats: { vectors: catalog.vectors.length, categories } };
}

export function compareObservedInventory({ gold, observed }) {
  if (!Array.isArray(gold) || !Array.isArray(observed)) throw new TypeError('gold and observed must be arrays');
  if (!uniq(gold) || gold.some((x) => !nonEmptyString(x))) throw new TypeError('gold ids must be unique non-empty strings');

  const seen = new Map();
  for (const item of observed) {
    if (!item || !nonEmptyString(item.id) || !['verified', 'unknown'].includes(item.status)) {
      throw new TypeError('observed items require {id,status:verified|unknown}');
    }
    if (seen.has(item.id)) throw new TypeError(`duplicate observed id: ${item.id}`);
    seen.set(item.id, item.status);
  }

  const goldSet = new Set(gold);
  const tp = gold.filter((id) => seen.get(id) === 'verified').length;
  const abstentions = gold.filter((id) => seen.get(id) === 'unknown').length;
  const missing = gold.filter((id) => !seen.has(id)).length;
  const fn = abstentions + missing;
  const fp = [...seen.entries()].filter(([id, status]) => status === 'verified' && !goldSet.has(id)).length;
  const unknown_outside_gold = [...seen.entries()].filter(([id, status]) => status === 'unknown' && !goldSet.has(id)).length;

  return {
    tp, fp, fn, abstentions, missing, unknown_outside_gold,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    abstention_rate: ratio(abstentions, gold.length),
    gold_total: gold.length,
    observed_total: observed.length,
  };
}

export function evaluateMutationGate({ mutants, noncritical_threshold = 0.9, require_noncritical = true }) {
  if (!Array.isArray(mutants)) throw new TypeError('mutants must be an array');
  if (!(noncritical_threshold >= 0 && noncritical_threshold <= 1)) throw new RangeError('noncritical_threshold must be between 0 and 1');
  const ids = mutants.map((m) => m?.id);
  if (ids.some((id) => !nonEmptyString(id)) || !uniq(ids)) throw new TypeError('mutants require unique non-empty ids');
  for (const m of mutants) {
    if (typeof m.critical !== 'boolean' || !['killed', 'survived', 'equivalent'].includes(m.status)) {
      throw new TypeError('mutants require boolean critical and killed|survived|equivalent status');
    }
  }

  const critical = mutants.filter((m) => m.critical);
  const critical_failures = critical.filter((m) => m.status !== 'killed').map((m) => m.id);
  const noncritical = mutants.filter((m) => !m.critical && m.status !== 'equivalent');
  const killed = noncritical.filter((m) => m.status === 'killed').length;
  const noncritical_score = ratio(killed, noncritical.length);
  const noncritical_ok = noncritical_score === null ? !require_noncritical : noncritical_score >= noncritical_threshold;

  return {
    pass: critical_failures.length === 0 && noncritical_ok,
    critical_total: critical.length,
    critical_failures,
    noncritical_executable: noncritical.length,
    noncritical_killed: killed,
    noncritical_score,
    noncritical_threshold,
    equivalent_excluded: mutants.filter((m) => !m.critical && m.status === 'equivalent').map((m) => m.id),
    reasons: [
      ...(critical_failures.length ? [`critical mutants survived or were marked equivalent: ${critical_failures.join(', ')}`] : []),
      ...(!noncritical_ok ? [noncritical_score === null ? 'no executable noncritical mutants' : `noncritical score ${noncritical_score.toFixed(4)} is below ${noncritical_threshold.toFixed(4)}`] : []),
    ],
  };
}

export function verifyEvidencePack(pack, { artifactBytes = new Map() } = {}) {
  const errors = [];
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return { ok: false, errors: ['evidence pack must be an object'] };
  if (pack.contract !== 'sbf.qa-evidence/1') errors.push('contract must be sbf.qa-evidence/1');
  if (!nonEmptyString(pack.scope)) errors.push('scope is required');
  if (!SHA40_RE.test(pack.source_commit ?? '')) errors.push('source_commit must be an exact 40-hex commit');
  if (!nonEmptyString(pack.adapter_id)) errors.push('adapter_id is required');
  if (!nonEmptyString(pack.target_profile)) errors.push('target_profile is required');
  if (!Array.isArray(pack.commands) || pack.commands.length === 0) errors.push('at least one command record is required');
  if (!Array.isArray(pack.assertions) || pack.assertions.length === 0) errors.push('at least one assertion record is required');
  if (!Array.isArray(pack.artifacts)) errors.push('artifacts must be an array');
  if (errors.length) return { ok: false, errors };

  for (const [i, command] of pack.commands.entries()) {
    if (!nonEmptyString(command.argv)) errors.push(`commands[${i}].argv is required`);
    if (!['executed', 'skipped', 'blocked'].includes(command.status)) errors.push(`commands[${i}].status is invalid`);
    if (command.status === 'executed' && !Number.isInteger(command.exit_code)) errors.push(`commands[${i}] executed command needs an integer exit_code`);
    if (command.status !== 'executed' && !nonEmptyString(command.reason)) errors.push(`commands[${i}] ${command.status} command needs a reason`);
  }

  for (const [i, assertion] of pack.assertions.entries()) {
    if (!nonEmptyString(assertion.id)) errors.push(`assertions[${i}].id is required`);
    if (!['passed', 'failed', 'skipped', 'blocked'].includes(assertion.status)) errors.push(`assertions[${i}].status is invalid`);
  }

  for (const [i, artifact] of pack.artifacts.entries()) {
    if (!nonEmptyString(artifact.path) || !SHA256_RE.test(artifact.sha256 ?? '') || !Number.isInteger(artifact.size_bytes) || artifact.size_bytes < 0) {
      errors.push(`artifacts[${i}] has invalid path/hash/size`);
      continue;
    }
    if (artifactBytes.has(artifact.path)) {
      const bytes = artifactBytes.get(artifact.path);
      if (!Buffer.isBuffer(bytes)) errors.push(`artifact bytes for ${artifact.path} must be a Buffer`);
      else {
        if (bytes.length !== artifact.size_bytes) errors.push(`artifact size mismatch: ${artifact.path}`);
        if (sha256(bytes) !== artifact.sha256) errors.push(`artifact hash mismatch: ${artifact.path}`);
      }
    }
  }

  const executed = pack.commands.filter((x) => x.status === 'executed');
  const nonzero = executed.filter((x) => x.exit_code !== 0);
  const requiredCommandsNotExecuted = pack.commands.filter((x) => x.required !== false && x.status !== 'executed');
  const requiredAssertionsNotPassed = pack.assertions.filter((x) => x.required !== false && x.status !== 'passed');
  const failedAssertions = pack.assertions.filter((x) => x.status === 'failed');
  const blockedRequired = [
    ...requiredCommandsNotExecuted.filter((x) => ['blocked', 'skipped'].includes(x.status)),
    ...requiredAssertionsNotPassed.filter((x) => ['blocked', 'skipped'].includes(x.status)),
  ];

  if (!['pass', 'fail', 'blocked'].includes(pack.verdict)) errors.push('verdict must be pass|fail|blocked');
  if (pack.verdict === 'pass') {
    if (nonzero.length) errors.push('pass verdict cannot include a non-zero executed command');
    if (requiredCommandsNotExecuted.length) errors.push('pass verdict cannot hide a skipped/blocked required command');
    for (const assertion of requiredAssertionsNotPassed) errors.push(`pass verdict cannot hide required assertion ${assertion.id}=${assertion.status}`);
  }
  if (pack.verdict === 'fail' && nonzero.length === 0 && failedAssertions.length === 0) {
    errors.push('fail verdict needs a non-zero command or failed assertion signal');
  }
  if (pack.verdict === 'blocked' && blockedRequired.length === 0) {
    errors.push('blocked verdict needs a skipped/blocked required command or assertion signal');
  }

  return { ok: errors.length === 0, errors };
}
