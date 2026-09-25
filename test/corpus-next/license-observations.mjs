const SHA40 = /^[0-9a-f]{40}$/;
const REPO_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+$/;
const OBS = new Set(['pinned-root-license-file-observed', 'no-pinned-root-license-file-observed']);

function nonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }
function safeRootLicensePath(v) {
  return nonEmpty(v) && !v.startsWith('/') && !v.includes('..') && !v.includes('\\') && /^(?:LICENSE|COPYING|NOTICE)(?:\..+)?$/i.test(v);
}

export function validateLicenseObservations(doc, legacyProjection) {
  const errors = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok:false, errors:['(root): must be an object'] };
  if (doc.contract !== 'sbf.qa-license-observations/1') errors.push('contract: must equal sbf.qa-license-observations/1');
  if (!Array.isArray(doc.entries)) errors.push('entries: must be an array');
  const projected = new Map((legacyProjection?.candidates ?? []).map((x) => [x.candidate_id, x]));
  const seen = new Set();
  for (const [i,e] of (doc.entries ?? []).entries()) {
    const at='entries['+i+']';
    if (!e || typeof e !== 'object' || Array.isArray(e)) { errors.push(at+': must be an object'); continue; }
    if (!nonEmpty(e.candidate_id)) errors.push(at+'.candidate_id: required');
    if (seen.has(e.candidate_id)) errors.push(at+'.candidate_id: duplicate '+e.candidate_id);
    seen.add(e.candidate_id);
    if (!REPO_URL.test(e.repository ?? '')) errors.push(at+'.repository: canonical GitHub URL required');
    if (!SHA40.test(e.commit ?? '')) errors.push(at+'.commit: exact 40-hex commit required');
    if (!(e.current_repo_spdx_hint === null || nonEmpty(e.current_repo_spdx_hint))) errors.push(at+'.current_repo_spdx_hint: string or null required');
    if (!OBS.has(e.observation)) errors.push(at+'.observation: invalid');
    if (e.review_state !== 'observation-only') errors.push(at+'.review_state: must remain observation-only');
    if (e.certification_eligible !== false) errors.push(at+'.certification_eligible: license observation cannot self-certify');

    const p=projected.get(e.candidate_id);
    if (!p) errors.push(at+'.candidate_id: not present in legacy oracle projection');
    else {
      if (e.repository !== p.source.repository) errors.push(at+'.repository: must match legacy projection source');
      if (e.commit !== p.source.commit) errors.push(at+'.commit: must match legacy projection source');
    }

    if (e.root_license_file === null) {
      if (e.observation !== 'no-pinned-root-license-file-observed') errors.push(at+': null root_license_file requires no-pinned-root-license-file-observed');
    } else if (!e.root_license_file || typeof e.root_license_file !== 'object' || Array.isArray(e.root_license_file)) {
      errors.push(at+'.root_license_file: object or null required');
    } else {
      if (e.observation !== 'pinned-root-license-file-observed') errors.push(at+': license file requires pinned-root-license-file-observed');
      if (!safeRootLicensePath(e.root_license_file.path)) errors.push(at+'.root_license_file.path: unsafe/non-license root path');
      if (!SHA40.test(e.root_license_file.blob_sha ?? '')) errors.push(at+'.root_license_file.blob_sha: exact Git blob SHA required');
      if (!Number.isSafeInteger(e.root_license_file.size_bytes) || e.root_license_file.size_bytes <= 0) errors.push(at+'.root_license_file.size_bytes: positive integer required');
    }
  }
  if (projected.size !== seen.size) errors.push('entries: expected exactly '+projected.size+' legacy candidates, got '+seen.size);
  for(const id of projected.keys()) if(!seen.has(id)) errors.push('entries: missing legacy candidate '+id);
  return {ok:errors.length===0,errors};
}

export function summarizeLicenseObservations(doc, legacyProjection) {
  const v=validateLicenseObservations(doc, legacyProjection);
  if(!v.ok) throw new Error('invalid license observations:\n'+v.errors.join('\n'));
  return {
    entries:doc.entries.length,
    pinned_root_license_files:doc.entries.filter(x=>x.root_license_file!==null).length,
    no_pinned_root_license_file_observed:doc.entries.filter(x=>x.root_license_file===null).length,
    current_repo_spdx_hints:doc.entries.filter(x=>x.current_repo_spdx_hint!==null).length,
    certification_eligible:doc.entries.filter(x=>x.certification_eligible).length
  };
}
