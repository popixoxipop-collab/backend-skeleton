import test from 'node:test';
import assert from 'node:assert/strict';
import { checkClaim, checkResult, verifyLedger } from './lease-ledger.mjs';

const SHA_A='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const AT='2026-09-25T02:00:00Z';
const policy={schema:'bskel.scale-ownership-policy/1',tracks:{
  T04:{repo:'owner/bskel',allowed_scopes:['scanners/language/js-ts/**','test/js-ts/**']},
  T12:{repo:'owner/bskel',allowed_scopes:['adapters/http-wave-a/**','test/http-wave-a/**']},
}};
const active={claim_id:'c1',track:'T04',repo:'owner/bskel',worker:'agent-4',worktree:'/tmp/wt-t04',base_sha:SHA_A,path_scopes:['scanners/language/js-ts/**'],issued_at:'2026-09-25T01:00:00Z',expires_at:'2026-09-25T03:00:00Z',fencing_token:4,state:'ACTIVE'};
const ledger={schema:'bskel.scale-lease-ledger/1',last_fencing_token:{T04:4,T12:1},claims:[active]};

test('ledger with one active claim is valid',()=>assert.equal(verifyLedger(policy,ledger,AT).ok,true));

test('same path cannot be claimed concurrently',()=>{
 const candidate={...active,claim_id:'c2',worker:'agent-other',worktree:'/tmp/wt-other',fencing_token:5};
 const r=checkClaim(policy,ledger,candidate,AT);
 assert.equal(r.ok,false); assert.ok(r.errors.some(e=>e.code==='ACTIVE_SCOPE_CONFLICT'));
});

test('non-overlapping owned path can be claimed',()=>{
 const c={claim_id:'c2',track:'T12',repo:'owner/bskel',worker:'agent-12',worktree:'/tmp/wt-t12',base_sha:SHA_A,path_scopes:['adapters/http-wave-a/nestjs/**'],issued_at:'2026-09-25T01:30:00Z',expires_at:'2026-09-25T03:00:00Z',fencing_token:2,state:'ACTIVE'};
 assert.equal(checkClaim(policy,ledger,c,AT).ok,true);
});

test('claim outside track ownership is rejected',()=>{
 const c={claim_id:'c2',track:'T12',repo:'owner/bskel',worker:'agent-12',worktree:'/tmp/wt-t12',base_sha:SHA_A,path_scopes:['scanners/adapters/typescript-nestjs.mjs'],issued_at:'2026-09-25T01:30:00Z',expires_at:'2026-09-25T03:00:00Z',fencing_token:2,state:'ACTIVE'};
 const r=checkClaim(policy,ledger,c,AT); assert.ok(r.errors.some(e=>e.code==='SCOPE_OUTSIDE_OWNERSHIP'));
});

test('fencing token regression is rejected',()=>{
 const c={claim_id:'c2',track:'T04',repo:'owner/bskel',worker:'agent-4b',worktree:'/tmp/wt-t04b',base_sha:SHA_A,path_scopes:['test/js-ts/**'],issued_at:'2026-09-25T01:30:00Z',expires_at:'2026-09-25T03:00:00Z',fencing_token:4,state:'ACTIVE'};
 const r=checkClaim(policy,ledger,c,AT); assert.ok(r.errors.some(e=>e.code==='FENCING_TOKEN_REGRESSION'));
});

test('result arriving after lease expiry is rejected',()=>{
 const r=checkResult(policy,ledger,{claim_id:'c1',fencing_token:4,base_sha:SHA_A,head_sha:SHA_B,changed_paths:['scanners/language/js-ts/source-facts.mjs']},'2026-09-25T04:00:00Z');
 assert.ok(r.errors.some(e=>e.code==='RESULT_AFTER_LEASE_EXPIRY'));
});

test('result from old fenced claim is rejected after counter advances',()=>{
 const l=structuredClone(ledger); l.last_fencing_token.T04=5;
 const r=checkResult(policy,l,{claim_id:'c1',fencing_token:4,base_sha:SHA_A,head_sha:SHA_B,changed_paths:['scanners/language/js-ts/source-facts.mjs']},AT);
 assert.ok(r.errors.some(e=>e.code==='RESULT_STALE_FENCING_TOKEN'));
});

test('result cannot write outside leased path',()=>{
 const r=checkResult(policy,ledger,{claim_id:'c1',fencing_token:4,base_sha:SHA_A,head_sha:SHA_B,changed_paths:['package.json']},AT);
 assert.ok(r.errors.some(e=>e.code==='RESULT_PATH_OUTSIDE_CLAIM'));
});

test('path traversal scopes are rejected',()=>{
 const c={claim_id:'c2',track:'T12',repo:'owner/bskel',worker:'agent-12',worktree:'/tmp/wt-t12',base_sha:SHA_A,path_scopes:['adapters/http-wave-a/../scanners/**'],issued_at:'2026-09-25T01:30:00Z',expires_at:'2026-09-25T03:00:00Z',fencing_token:2,state:'ACTIVE'};
 const r=checkClaim(policy,ledger,c,AT); assert.ok(r.errors.some(e=>e.code==='INVALID_CLAIM_SCOPE'));
});
