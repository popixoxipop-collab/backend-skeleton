const SHA40 = /^[0-9a-f]{40}$/;
const ADAPTER_ID = /^[a-z][a-z0-9-]*$/;
const ENTRY_ID = /^[a-z][a-z0-9-]*$/;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeRoot(value) {
  return value === null || (nonEmpty(value) && !value.startsWith('/') && !value.includes('..') && !value.includes('\\'));
}

export function projectLegacyOracleCandidates(manifest) {
  const errors = [];
  const candidates = [];
  const excluded = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['(root): must be an object'], candidates, excluded };
  }
  if (manifest.contract !== 'sbf.oracle-manifest/1') errors.push('contract: must equal sbf.oracle-manifest/1');
  if (!manifest.adapters || typeof manifest.adapters !== 'object' || Array.isArray(manifest.adapters)) {
    errors.push('adapters: must be an object');
    return { ok: false, errors, candidates, excluded };
  }

  const ids = new Set();
  for (const [adapterId, entries] of Object.entries(manifest.adapters)) {
    if (!ADAPTER_ID.test(adapterId)) errors.push('adapters.' + adapterId + ': invalid adapter id');
    if (!Array.isArray(entries)) {
      errors.push('adapters.' + adapterId + ': must be an array');
      continue;
    }
    for (const [index, entry] of entries.entries()) {
      const at = 'adapters.' + adapterId + '[' + index + ']';
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(at + ': must be an object');
        continue;
      }
      if (!ENTRY_ID.test(entry.id ?? '')) errors.push(at + '.id: invalid id');
      if (entry.owner === null) {
        excluded.push({ adapter_id: adapterId, id: entry.id ?? null, reason: 'local-literal-source-is-not-a-real-repo-candidate' });
        continue;
      }
      if (!nonEmpty(entry.owner) || !nonEmpty(entry.repo)) errors.push(at + ': owner and repo are required for real-repo import');
      if (!SHA40.test(entry.ref ?? '')) errors.push(at + '.ref: exact 40-hex commit required');
      if (!safeRoot(entry.path ?? null)) errors.push(at + '.path: unsafe repo-relative path');
      if (!Array.isArray(entry.terms) || entry.terms.length === 0 || entry.terms.some((x) => !nonEmpty(x))) errors.push(at + '.terms: non-empty terms required');
      if (!nonEmpty(entry.note)) errors.push(at + '.note: selection rationale required');

      const candidateId = adapterId + '--' + entry.id;
      if (ids.has(candidateId)) errors.push(at + ': duplicate candidate id ' + candidateId);
      ids.add(candidateId);
      if (errors.some((x) => x.startsWith(at + ':') || x.startsWith(at + '.'))) continue;

      candidates.push({
        candidate_id: candidateId,
        adapter_id: adapterId,
        source: {
          kind: 'real-repo',
          repository: 'https://github.com/' + entry.owner + '/' + entry.repo,
          commit: entry.ref,
          root: entry.path ?? '.',
          legacy_oracle_id: entry.id
        },
        terms: [...entry.terms],
        selection_reason: entry.note,
        admission_state: 'needs-license-review',
        missing_requirements: ['license-review', 'independent-golden-review'],
        certification_eligible: false
      });
    }
  }
  return { ok: errors.length === 0, errors, candidates, excluded };
}

export function summarizeLegacyOracleProjection(projection) {
  if (!projection?.ok) throw new Error('invalid legacy oracle projection:\n' + (projection?.errors ?? []).join('\n'));
  const adapters = {};
  for (const candidate of projection.candidates) adapters[candidate.adapter_id] = (adapters[candidate.adapter_id] ?? 0) + 1;
  return {
    candidates: projection.candidates.length,
    excluded: projection.excluded.length,
    adapters,
    certification_eligible: projection.candidates.filter((x) => x.certification_eligible).length,
    license_review_pending: projection.candidates.filter((x) => x.missing_requirements.includes('license-review')).length
  };
}
