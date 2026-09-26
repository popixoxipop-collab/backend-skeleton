import crypto from 'node:crypto';

const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BINDING_VERSION = 'beval.runtime-binding/1';
const EVIDENCE_PAIR_VERSION = 'beval.runtime-evidence-pair/1';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) throw new TypeError(label + ' must be a plain JSON object');
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(label + ' must contain exactly: ' + wanted.join(', '));
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(label + ' must be a non-empty string');
  return value;
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new TypeError(label + ' must be a lowercase sha256 digest');
  }
  return value;
}

function optionalHash(value, label) {
  if (value == null) return null;
  return requireHash(value, label);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function t16StableJson(value) {
  return JSON.stringify(canonical(value), null, 2) + '\n';
}

export function t16HashJson(value) {
  return crypto.createHash('sha256').update(Buffer.from(t16StableJson(value))).digest('hex');
}

function normalizeArtifacts(value) {
  if (!plainObject(value)) throw new TypeError('runtime binding artifacts must be an object');
  const out = {};
  for (const name of Object.keys(value).sort()) {
    requireString(name, 'runtime artifact name');
    out[name] = requireHash(value[name], 'runtime binding artifacts.' + name);
  }
  return out;
}

export function assertT16RuntimeBinding(binding) {
  exactKeys(binding, [
    'runtime_binding',
    'run_id',
    'case_revision_hash',
    'oracle_profile_approval_hash',
    'contract_hash',
    'flow_hash',
    'config_hash',
    'candidate_hash',
    'original_hash',
    'runner_implementation_hash',
    'runtime_execution_policy_hash',
    'artifacts',
    'attempt_nonce',
  ], 'RuntimeBinding');

  if (binding.runtime_binding !== BINDING_VERSION) {
    throw new TypeError('unsupported runtime binding document');
  }
  const normalized = {
    runtime_binding: BINDING_VERSION,
    run_id: requireString(binding.run_id, 'runtime binding run_id'),
    case_revision_hash: requireHash(binding.case_revision_hash, 'runtime binding case_revision_hash'),
    oracle_profile_approval_hash: requireHash(binding.oracle_profile_approval_hash, 'runtime binding oracle_profile_approval_hash'),
    contract_hash: requireHash(binding.contract_hash, 'runtime binding contract_hash'),
    flow_hash: optionalHash(binding.flow_hash, 'runtime binding flow_hash'),
    config_hash: optionalHash(binding.config_hash, 'runtime binding config_hash'),
    candidate_hash: optionalHash(binding.candidate_hash, 'runtime binding candidate_hash'),
    original_hash: optionalHash(binding.original_hash, 'runtime binding original_hash'),
    runner_implementation_hash: requireHash(binding.runner_implementation_hash, 'runtime binding runner_implementation_hash'),
    runtime_execution_policy_hash: requireHash(binding.runtime_execution_policy_hash, 'runtime binding runtime_execution_policy_hash'),
    artifacts: normalizeArtifacts(binding.artifacts),
    attempt_nonce: requireString(binding.attempt_nonce, 'runtime binding attempt_nonce'),
  };
  if (!UUID_RE.test(normalized.attempt_nonce)) {
    throw new TypeError('runtime binding attempt_nonce must be a UUID');
  }
  if (t16HashJson(binding) !== t16HashJson(normalized)) {
    throw new TypeError('runtime binding contains unexpected or non-canonical fields');
  }
  return normalized;
}

export function t16RuntimeBindingHash(binding) {
  return t16HashJson(assertT16RuntimeBinding(binding));
}

function evidenceContractHash(evidence) {
  return evidence?.contract_hash ?? evidence?.contract_ref?.contract_hash ?? null;
}

function assertRawEvidence(evidence, target, contractHash) {
  if (!plainObject(evidence)) throw new TypeError(target + ' runtime evidence must be an object');
  if (evidence.target !== target) throw new TypeError(target + ' runtime evidence has the wrong target');
  if (evidenceContractHash(evidence) !== contractHash) {
    throw new TypeError(target + ' runtime evidence does not address the runtime contract');
  }
  return evidence;
}

export function assertT16RuntimeEvidencePair({
  binding,
  bindingHash,
  pair,
  oracleEvidence,
  candidateEvidence,
}) {
  const normalizedBinding = assertT16RuntimeBinding(binding);
  const actualBindingHash = t16RuntimeBindingHash(normalizedBinding);
  if (bindingHash !== actualBindingHash) {
    throw new TypeError('runtime binding hash does not match the exact binding');
  }

  exactKeys(pair, [
    'runtime_evidence_pair',
    'family',
    'runtime_binding_hash',
    'attempt_nonce',
    'oracle_evidence_hash',
    'candidate_evidence_hash',
  ], 'RuntimeEvidencePair');
  if (pair.runtime_evidence_pair !== EVIDENCE_PAIR_VERSION) {
    throw new TypeError('unsupported runtime evidence pair document');
  }
  if (pair.family !== 'http') {
    throw new TypeError('T09 accepts only http runtime evidence pairs');
  }
  if (pair.runtime_binding_hash !== actualBindingHash) {
    throw new TypeError('runtime evidence pair binding hash mismatch');
  }
  if (pair.attempt_nonce !== normalizedBinding.attempt_nonce) {
    throw new TypeError('runtime evidence pair attempt mismatch');
  }

  const oracle = assertRawEvidence(oracleEvidence, 'oracle', normalizedBinding.contract_hash);
  const candidate = assertRawEvidence(candidateEvidence, 'candidate', normalizedBinding.contract_hash);
  const normalizedPair = {
    runtime_evidence_pair: EVIDENCE_PAIR_VERSION,
    family: 'http',
    runtime_binding_hash: actualBindingHash,
    attempt_nonce: normalizedBinding.attempt_nonce,
    oracle_evidence_hash: t16HashJson(oracle),
    candidate_evidence_hash: t16HashJson(candidate),
  };
  requireHash(pair.oracle_evidence_hash, 'runtime evidence pair oracle_evidence_hash');
  requireHash(pair.candidate_evidence_hash, 'runtime evidence pair candidate_evidence_hash');
  if (pair.oracle_evidence_hash !== normalizedPair.oracle_evidence_hash) {
    throw new TypeError('runtime evidence pair oracle evidence hash mismatch');
  }
  if (pair.candidate_evidence_hash !== normalizedPair.candidate_evidence_hash) {
    throw new TypeError('runtime evidence pair candidate evidence hash mismatch');
  }
  if (t16HashJson(pair) !== t16HashJson(normalizedPair)) {
    throw new TypeError('runtime evidence pair contains unexpected or stale fields');
  }

  return {
    binding: normalizedBinding,
    bindingHash: actualBindingHash,
    pair: normalizedPair,
    oracleEvidenceHash: normalizedPair.oracle_evidence_hash,
    candidateEvidenceHash: normalizedPair.candidate_evidence_hash,
  };
}
