const REQUIRED_STATUSES = ['supported','partial','unsupported','unknown','not-applicable'];

function error(code, detail={}) { return {code, ...detail}; }
function exactSet(a,b){
  if(!Array.isArray(a) || a.length!==b.length) return false;
  const left=[...a].sort();
  const right=[...b].sort();
  return left.every((x,i)=>x===right[i]);
}

export function evaluateCoreFreezeActivation(snapshot){
  const errors=[];
  if(snapshot?.schema !== 'bskel.scale-core-freeze-activation/1') errors.push(error('BAD_SCHEMA'));
  if(snapshot?.candidate !== 'T00-04A') errors.push(error('BAD_CANDIDATE'));

  const baseline=snapshot?.baseline ?? {};
  if(baseline.state !== 'ACCEPTED') errors.push(error('BASELINE_NOT_ACCEPTED',{actual:baseline.state ?? null}));
  for(const role of ['bskel','becoder','beval']){
    const pinned=baseline.heads?.[role];
    const current=snapshot?.current_main_heads?.[role];
    if(typeof pinned!=='string' || !/^[0-9a-f]{40}$/.test(pinned)) errors.push(error('INVALID_PINNED_HEAD',{role}));
    if(current !== pinned) errors.push(error('BASELINE_DRIFT',{role,expected:pinned ?? null,actual:current ?? null}));
  }
  if(baseline.exact_head_ci !== 'success') errors.push(error('BASELINE_CI_NOT_GREEN',{actual:baseline.exact_head_ci ?? null}));
  if(baseline.independent_review !== 'pass') errors.push(error('BASELINE_REVIEW_NOT_PASS',{actual:baseline.independent_review ?? null}));

  const identity=snapshot?.identity ?? {};
  if(identity.exact_head_ci !== 'success') errors.push(error('IDENTITY_CI_NOT_GREEN'));
  if(identity.scope_compliant !== true) errors.push(error('IDENTITY_SCOPE_NOT_COMPLIANT'));
  if(identity.legacy_compatibility !== true) errors.push(error('IDENTITY_LEGACY_COMPAT_NOT_PROVEN'));
  if(identity.artifact_ref_semantics !== 'exact-bytes') errors.push(error('ARTIFACT_REF_SEMANTICS_MISMATCH'));
  if(identity.identity_envelope_family !== 'http') errors.push(error('IDENTITY_ENVELOPE_FAMILY_MISMATCH'));
  if(identity.additive_only !== true) errors.push(error('IDENTITY_NOT_ADDITIVE'));

  const capability=snapshot?.capability ?? {};
  if(capability.exact_head_ci !== 'success') errors.push(error('CAPABILITY_CI_NOT_GREEN'));
  if(capability.scope_compliant !== true) errors.push(error('CAPABILITY_SCOPE_NOT_COMPLIANT'));
  if(!exactSet(capability.statuses,REQUIRED_STATUSES)) errors.push(error('CAPABILITY_STATUS_SET_MISMATCH'));
  if(capability.certification_wire_promoted === true) errors.push(error('CERTIFICATION_WIRE_PREMATURELY_PROMOTED'));
  if(capability.runtime_tested_requires_verified_runtime_evidence !== true) errors.push(error('RUNTIME_EVIDENCE_RULE_MISSING'));

  const lease=snapshot?.lease ?? {};
  if(lease.policy_revision !== 'T00-03-r1') errors.push(error('LEASE_POLICY_REVISION_MISMATCH'));
  if(lease.verifier_ci !== 'success') errors.push(error('LEASE_VERIFIER_NOT_GREEN'));
  if(lease.fail_closed !== true) errors.push(error('LEASE_NOT_FAIL_CLOSED'));

  const semantics=snapshot?.semantics ?? {};
  if(semantics.unknown_preserved !== true) errors.push(error('UNKNOWN_PRESERVATION_NOT_FROZEN'));
  if(semantics.runtime_cannot_repair_contract !== true) errors.push(error('RUNTIME_AUTHORITY_BOUNDARY_MISSING'));
  if(semantics.causality_not_inferred !== true) errors.push(error('CAUSALITY_BOUNDARY_MISSING'));

  return {ok:errors.length===0,status:errors.length===0?'ACTIVE_CORE_FREEZE':'BLOCKED',errors};
}
