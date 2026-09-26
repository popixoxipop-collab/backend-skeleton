import fs from 'node:fs';

const ACTIVE = new Set(['CLAIMED', 'RUNNING']);

function normPath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('empty path scope');
  let s = p.replaceAll('\\', '/').replace(/^\.\//, '');
  if (s.startsWith('/') || /^[A-Za-z]:\//.test(s)) throw new Error(`absolute path is forbidden: ${p}`);
  const parts = s.split('/');
  if (parts.some((x) => x === '..')) throw new Error(`path traversal is forbidden: ${p}`);
  return s.replace(/\/+/g, '/');
}
function patternBase(pattern) {
  const p = normPath(pattern);
  const wildcard = p.search(/[?*[]/);
  const raw = wildcard === -1 ? p : p.slice(0, wildcard);
  return raw.replace(/\/$/, '').toLowerCase();
}
function isWildcard(pattern) { return /[?*[]/.test(pattern); }
export function patternsOverlap(a,b) {
  const aa=patternBase(a), bb=patternBase(b), ae=!isWildcard(a), be=!isWildcard(b);
  if (ae && be) return aa===bb;
  if (ae) return aa===bb || aa.startsWith(`${bb}/`) || bb==='';
  if (be) return aa===bb || bb.startsWith(`${aa}/`) || aa==='';
  return aa===bb || aa.startsWith(`${bb}/`) || bb.startsWith(`${aa}/`) || aa==='' || bb==='';
}
export function patternContains(allowed,requested) {
  const a=patternBase(allowed), r=patternBase(requested);
  if (!isWildcard(allowed)) return !isWildcard(requested) && a===r;
  if (a==='') return true;
  return r===a || r.startsWith(`${a}/`) || r.startsWith(a);
}
function trackPolicy(policy,id){ return (policy.tracks??[]).find((t)=>t.id===id)??null; }
function currentToken(ledger,key){ let max=null; for(const c of ledger.claims??[]){ if(c.resource_key!==key) continue; max=max==null?c.fencing_token:Math.max(max,c.fencing_token);} return max; }

export function validateOwnership(policy,ledger,{now=new Date().toISOString()}={}) {
  const errors=[], tracks=new Set();
  for (const t of policy.tracks??[]) {
    if (tracks.has(t.id)) errors.push({code:'DUPLICATE_TRACK_POLICY',track:t.id});
    tracks.add(t.id);
    for (const s of t.allowed_write_scopes??[]) { try{normPath(s);}catch(e){errors.push({code:'INVALID_POLICY_SCOPE',track:t.id,scope:s,message:e.message});} }
  }
  const ids=new Set(), claims=ledger.claims??[];
  for (const c of claims) {
    if(ids.has(c.claim_id)) errors.push({code:'DUPLICATE_CLAIM_ID',claim_id:c.claim_id}); ids.add(c.claim_id);
    if(!/^[0-9a-f]{40}$/i.test(c.base_sha??'')) errors.push({code:'INVALID_BASE_SHA',claim_id:c.claim_id});
    const tp=trackPolicy(policy,c.track);
    if(!tp){errors.push({code:'UNKNOWN_TRACK',claim_id:c.claim_id,track:c.track});continue;}
    for(const s of c.write_scope??[]) {
      try { normPath(s); if(!(tp.allowed_write_scopes??[]).some((a)=>patternContains(a,s))) errors.push({code:'WRITE_SCOPE_OUTSIDE_POLICY',claim_id:c.claim_id,track:c.track,scope:s}); }
      catch(e){ errors.push({code:'INVALID_CLAIM_SCOPE',claim_id:c.claim_id,scope:s,message:e.message}); }
    }
    if(ACTIVE.has(c.state)&&(!c.expires_at||c.expires_at<=now)) errors.push({code:'EXPIRED_ACTIVE_LEASE',claim_id:c.claim_id,expires_at:c.expires_at??null,now});
  }
  for(let i=0;i<claims.length;i++){const a=claims[i]; if(!ACTIVE.has(a.state))continue; for(let j=i+1;j<claims.length;j++){const b=claims[j]; if(!ACTIVE.has(b.state)||a.repository!==b.repository)continue; for(const as of a.write_scope??[]) for(const bs of b.write_scope??[]) if(patternsOverlap(as,bs)) errors.push({code:'WRITE_SCOPE_CONFLICT',repository:a.repository,claims:[a.claim_id,b.claim_id],scopes:[as,bs]});}}
  const by=new Map(); for(const c of claims){const arr=by.get(c.resource_key)??[];arr.push(c);by.set(c.resource_key,arr);}
  for(const [resource,arr] of by){arr.sort((a,b)=>String(a.issued_at).localeCompare(String(b.issued_at))||a.claim_id.localeCompare(b.claim_id));let prev=null;for(const c of arr){if(!Number.isInteger(c.fencing_token)||c.fencing_token<1)errors.push({code:'INVALID_FENCING_TOKEN',claim_id:c.claim_id,token:c.fencing_token});else if(prev!=null&&c.fencing_token<=prev)errors.push({code:'FENCING_TOKEN_REGRESSION',resource_key:resource,claim_id:c.claim_id,previous:prev,actual:c.fencing_token});if(Number.isInteger(c.fencing_token))prev=c.fencing_token;}}
  return {ok:errors.length===0,errors};
}
export function verifySubmission(policy,ledger,packet){
  const errors=[], claim=(ledger.claims??[]).find((c)=>c.claim_id===packet.claim_id);
  if(!claim)return {ok:false,errors:[{code:'UNKNOWN_CLAIM',claim_id:packet.claim_id}]};
  const max=currentToken(ledger,claim.resource_key);
  if(packet.fencing_token!==claim.fencing_token||packet.fencing_token!==max)errors.push({code:'STALE_FENCING_TOKEN',claim_id:claim.claim_id,expected:max,actual:packet.fencing_token});
  if(!packet.submitted_at||!claim.expires_at||packet.submitted_at>claim.expires_at)errors.push({code:'EXPIRED_LEASE_RESULT',claim_id:claim.claim_id,expires_at:claim.expires_at??null,submitted_at:packet.submitted_at??null});
  if(packet.base_sha!==claim.base_sha)errors.push({code:'BASE_SHA_MISMATCH',claim_id:claim.claim_id});
  if(packet.repository!==claim.repository)errors.push({code:'REPOSITORY_MISMATCH',claim_id:claim.claim_id});
  if(packet.branch!==claim.branch)errors.push({code:'BRANCH_MISMATCH',claim_id:claim.claim_id});
  for(const p of packet.touched_paths??[]){let n;try{n=normPath(p);}catch{errors.push({code:'INVALID_TOUCHED_PATH',path:p});continue;}if(!(claim.write_scope??[]).some((s)=>patternContains(s,n)))errors.push({code:'TOUCHED_PATH_OUTSIDE_CLAIM',claim_id:claim.claim_id,path:p});}
  if(!trackPolicy(policy,claim.track))errors.push({code:'UNKNOWN_TRACK',track:claim.track});
  return {ok:errors.length===0,errors};
}
function main(){
  const [cmd,policyPath,ledgerPath,packetPath]=process.argv.slice(2);
  if(!cmd||!policyPath||!ledgerPath){console.error('usage: node lease-verifier.mjs <validate|submission> <policy.json> <ledger.json> [packet.json]');process.exit(1);}
  const policy=JSON.parse(fs.readFileSync(policyPath,'utf8')), ledger=JSON.parse(fs.readFileSync(ledgerPath,'utf8'));
  const result=cmd==='validate'?validateOwnership(policy,ledger):cmd==='submission'&&packetPath?verifySubmission(policy,ledger,JSON.parse(fs.readFileSync(packetPath,'utf8'))):{ok:false,errors:[{code:'BAD_COMMAND'}]};
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);process.exit(result.ok?0:2);
}
if(import.meta.url===`file://${process.argv[1]}`)main();
