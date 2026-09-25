const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ID = /^[a-z][a-z0-9-]*$/;
const TEST_PATH = /^(?:test|release\/next\/test)\/[A-Za-z0-9._/-]+\.test\.mjs$/;
const CI_STATUS = new Set(['queued', 'in_progress', 'pending', 'completed']);
const CI_CONCLUSION = new Set(['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure', null]);
const STRENGTH = new Set(['direct', 'partial']);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeRepoPath(value) {
  return nonEmpty(value) && TEST_PATH.test(value) && !value.includes('..') && !value.includes('\\');
}

export function validateExternalEvidenceCandidates(registry, negativeCatalog) {
  const errors = [];
  const knownVectors = new Set(Array.isArray(negativeCatalog?.vectors) ? negativeCatalog.vectors.map((v) => v.id) : []);
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return { ok: false, errors: ['(root): must be an object'] };
  if (registry.contract !== 'sbf.external-evidence-candidates/1') errors.push('contract: must equal sbf.external-evidence-candidates/1');
  if (!Array.isArray(registry.candidates)) errors.push('candidates: must be an array');
  const ids = new Set();
  for (const [index, candidate] of (registry.candidates ?? []).entries()) {
    const at = 'candidates[' + index + ']';
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { errors.push(at + ': must be an object'); continue; }
    if (!ID.test(candidate.id ?? '')) errors.push(at + '.id: invalid candidate id');
    if (ids.has(candidate.id)) errors.push(at + '.id: duplicate ' + candidate.id);
    ids.add(candidate.id);
    if (candidate.state !== 'external-candidate') errors.push(at + '.state: must remain external-candidate');
    if (candidate.certification !== false) errors.push(at + '.certification: external evidence cannot self-certify');

    const source = candidate.source;
    if (!source || typeof source !== 'object' || Array.isArray(source)) errors.push(at + '.source: required');
    else {
      if (!REPO.test(source.repository ?? '')) errors.push(at + '.source.repository: must be owner/repo');
      if (!SHA40.test(source.commit ?? '')) errors.push(at + '.source.commit: exact 40-hex commit required');
      if (!Number.isSafeInteger(source.pull_request) || source.pull_request <= 0) errors.push(at + '.source.pull_request: positive integer required');
    }

    if (!Array.isArray(candidate.vector_mappings) || candidate.vector_mappings.length === 0) errors.push(at + '.vector_mappings: non-empty array required');
    for (const [mi, mapping] of (candidate.vector_mappings ?? []).entries()) {
      const mat = at + '.vector_mappings[' + mi + ']';
      if (!knownVectors.has(mapping?.vector_id)) errors.push(mat + '.vector_id: unknown negative vector ' + String(mapping?.vector_id));
      if (!STRENGTH.has(mapping?.strength)) errors.push(mat + '.strength: must be direct or partial');
      if (!nonEmpty(mapping?.reason)) errors.push(mat + '.reason: required');
    }

    if (!Array.isArray(candidate.tests) || candidate.tests.length === 0) errors.push(at + '.tests: non-empty array required');
    for (const [ti, spec] of (candidate.tests ?? []).entries()) {
      const tat = at + '.tests[' + ti + ']';
      if (!safeRepoPath(spec?.path)) errors.push(tat + '.path: unsafe or non-test repo path');
      if (!Array.isArray(spec?.selectors) || spec.selectors.length === 0 || spec.selectors.some((x) => !nonEmpty(x))) errors.push(tat + '.selectors: non-empty selectors required');
    }

    const ci = candidate.ci;
    if (!ci || typeof ci !== 'object' || Array.isArray(ci)) errors.push(at + '.ci: required');
    else {
      if (!Number.isSafeInteger(ci.run_id) || ci.run_id <= 0) errors.push(at + '.ci.run_id: positive integer required');
      if (!Number.isSafeInteger(ci.run_number) || ci.run_number <= 0) errors.push(at + '.ci.run_number: positive integer required');
      if (!CI_STATUS.has(ci.status)) errors.push(at + '.ci.status: invalid status');
      if (!CI_CONCLUSION.has(ci.conclusion)) errors.push(at + '.ci.conclusion: invalid conclusion');
      if (ci.status !== 'completed' && ci.conclusion !== null) errors.push(at + '.ci: nonterminal CI must keep conclusion=null');
      if (ci.status === 'completed' && ci.conclusion === null) errors.push(at + '.ci: completed CI requires a conclusion');
    }
    if (!Array.isArray(candidate.job_observations)) errors.push(at + '.job_observations: must be an array');
    else {
      for (const [ji, observation] of candidate.job_observations.entries()) {
        const jat = at + '.job_observations[' + ji + ']';
        if (!Number.isSafeInteger(observation?.run_id) || observation.run_id <= 0) errors.push(jat + '.run_id: positive integer required');
        else if (candidate.ci?.run_id !== observation.run_id) errors.push(jat + '.run_id: must match candidate ci.run_id');
        if (!Number.isSafeInteger(observation?.job_id) || observation.job_id <= 0) errors.push(jat + '.job_id: positive integer required');
        if (!nonEmpty(observation?.job_name)) errors.push(jat + '.job_name: required');
        if (!Array.isArray(observation?.subtests) || observation.subtests.length === 0 || observation.subtests.some((x) => !nonEmpty(x))) errors.push(jat + '.subtests: non-empty subtest names required');
      }
      if (candidate.job_observations.length > 0 && !(candidate.ci?.status === 'completed' && candidate.ci?.conclusion === 'success')) {
        errors.push(at + '.job_observations: require completed-success candidate CI');
      }
    }
    if (!nonEmpty(candidate.note)) errors.push(at + '.note: required');
  }
  return { ok: errors.length === 0, errors };
}

export function summarizeExternalEvidenceCandidates(registry, negativeCatalog) {
  const verdict = validateExternalEvidenceCandidates(registry, negativeCatalog);
  if (!verdict.ok) throw new Error('invalid external evidence candidates:\n' + verdict.errors.join('\n'));
  const vectorSet = new Set();
  let directMappings = 0;
  let partialMappings = 0;
  let exactHeadCiSuccess = 0;
  let nonterminalCi = 0;
  let jobObservedCandidates = 0;
  for (const candidate of registry.candidates) {
    for (const mapping of candidate.vector_mappings) {
      vectorSet.add(mapping.vector_id);
      if (mapping.strength === 'direct') directMappings += 1;
      else partialMappings += 1;
    }
    if (candidate.ci.status === 'completed' && candidate.ci.conclusion === 'success') exactHeadCiSuccess += 1;
    if (candidate.ci.status !== 'completed') nonterminalCi += 1;
    if (candidate.job_observations.length > 0) jobObservedCandidates += 1;
  }
  return {
    candidates: registry.candidates.length,
    unique_vectors: vectorSet.size,
    direct_mappings: directMappings,
    partial_mappings: partialMappings,
    exact_head_ci_success_candidates: exactHeadCiSuccess,
    nonterminal_ci_candidates: nonterminalCi,
    job_observed_candidates: jobObservedCandidates,
    covered_vectors: 0
  };
}
