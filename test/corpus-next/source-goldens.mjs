const SHA40=/^[0-9a-f]{40}$/;
const ID=/^[a-z][a-z0-9-]*$/;
function nonEmpty(v){return typeof v==='string'&&v.trim().length>0;}
function safePath(v){return nonEmpty(v)&&!v.startsWith('/')&&!v.includes('..')&&!v.includes('\\');}

export function validateSourceGoldens(doc, corpusManifest){
  const errors=[];
  if(!doc||typeof doc!=='object'||Array.isArray(doc)) return {ok:false,errors:['(root): must be an object']};
  if(doc.contract!=='sbf.qa-source-goldens/1') errors.push('contract: must equal sbf.qa-source-goldens/1');
  if(!Array.isArray(doc.goldens)) errors.push('goldens: must be an array');
  const corpus=new Map((corpusManifest?.entries??[]).map(x=>[x.id,x]));
  const seen=new Set();
  for(const [i,g] of (doc.goldens??[]).entries()){
    const at='goldens['+i+']';
    if(!ID.test(g?.golden_id??'')) errors.push(at+'.golden_id: invalid');
    if(seen.has(g?.golden_id)) errors.push(at+'.golden_id: duplicate '+g.golden_id);
    seen.add(g?.golden_id);
    if(g?.scope!=='selected-source-facts') errors.push(at+'.scope: must remain selected-source-facts');
    if(g?.completeness_claim!==false) errors.push(at+'.completeness_claim: must be false');
    if(g?.generated_by_candidate!==false) errors.push(at+'.generated_by_candidate: must be false');
    if(g?.certification_eligible!==false) errors.push(at+'.certification_eligible: source golden cannot self-certify');
    if(!nonEmpty(g?.authored_by)) errors.push(at+'.authored_by: required');
    const ce=corpus.get(g?.corpus_id);
    if(!ce) errors.push(at+'.corpus_id: unknown corpus entry');
    else {
      if(g.adapter_id!==ce.adapter_id) errors.push(at+'.adapter_id: must match corpus entry');
      if(g.source?.repository!==ce.source?.repository) errors.push(at+'.source.repository: must match corpus entry');
      if(g.source?.commit!==ce.source?.commit) errors.push(at+'.source.commit: must match corpus entry');
      if(g.source?.fixture_root!==ce.source?.root) errors.push(at+'.source.fixture_root: must match corpus entry');
    }
    if(!SHA40.test(g.source?.commit??'')) errors.push(at+'.source.commit: exact 40-hex commit required');
    if(!Array.isArray(g.assertions)||g.assertions.length===0) errors.push(at+'.assertions: non-empty array required');
    const assertionIds=new Set();
    for(const [ai,a] of (g.assertions??[]).entries()){
      const aat=at+'.assertions['+ai+']';
      if(!ID.test(a?.id??'')) errors.push(aat+'.id: invalid');
      if(assertionIds.has(a?.id)) errors.push(aat+'.id: duplicate '+a.id);
      assertionIds.add(a?.id);
      if(!nonEmpty(a?.kind)) errors.push(aat+'.kind: required');
      if(!Object.hasOwn(a??{},'expected')) errors.push(aat+'.expected: required');
      if(!safePath(a?.source_ref?.path)) errors.push(aat+'.source_ref.path: safe repo-relative path required');
      if(!SHA40.test(a?.source_ref?.git_blob_sha??'')) errors.push(aat+'.source_ref.git_blob_sha: exact Git blob SHA required');
      if(!nonEmpty(a?.source_ref?.selector)) errors.push(aat+'.source_ref.selector: required');
      if(ce?.source?.root && !a.source_ref?.path?.startsWith(ce.source.root+'/')) errors.push(aat+'.source_ref.path: must stay inside corpus fixture root');
    }
  }
  if(doc.goldens?.length!==corpus.size) errors.push('goldens: expected exactly '+corpus.size+' corpus goldens, got '+(doc.goldens?.length??0));
  for(const id of corpus.keys()) if(!(doc.goldens??[]).some(g=>g.corpus_id===id)) errors.push('goldens: missing corpus entry '+id);
  return {ok:errors.length===0,errors};
}

export function summarizeSourceGoldens(doc, corpusManifest){
 const v=validateSourceGoldens(doc,corpusManifest);
 if(!v.ok) throw new Error('invalid source goldens:\n'+v.errors.join('\n'));
 return {
  goldens:doc.goldens.length,
  assertions:doc.goldens.reduce((n,g)=>n+g.assertions.length,0),
  completeness_claims:doc.goldens.filter(g=>g.completeness_claim).length,
  certification_eligible:doc.goldens.filter(g=>g.certification_eligible).length
 };
}
