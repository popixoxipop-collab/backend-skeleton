import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const REL='adapters/http/ruby-rails/SCOPE_EVIDENCE.json';
const SHA=/^[0-9a-f]{40}$/;
const H=b=>createHash('sha256').update(b).digest('hex');
const git=(args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8',timeout:25000}).trim();
const read=p=>fs.readFileSync(path.join(ROOT,p));
const inputs=[
 'adapters/http/ruby-rails/TARGET_SCOPE.md',
 'adapters/http/ruby-rails/target-scope.test.mjs',
 'adapters/http/ruby-rails/target-scope-negative.test.mjs',
 'adapters/http/ruby-rails/scope-evidence.mjs',
 'adapters/http/ruby-rails/scope-evidence.test.mjs',
 'scanners/adapters/ruby-rails.mjs','scanners/index.mjs','scanners/text-util.mjs',
 'scanners/language/ruby-php/dsl-facts.mjs','scanners/language/ruby-php/dsl-expand.mjs',
 'test/fixtures/oracle-manifest.json','test/language-ruby-php/corpus-manifest.json',
 'test/language-ruby-php/corpus-observed-2026-09-26.json',
 'scripts/rails-integration-smoke.mjs','test/ruby-rails-cli.test.mjs',
 'test/language-ruby-php/rails-scope-literals.test.mjs',
 'next/t00/check-ownership.mjs','next/t00/ownership.mjs'
];
export const SOURCE_FILES=Object.freeze([...new Set([...inputs,
 ...git(['ls-files','test/fixtures/ruby-rails/backend']).split('\n').filter(Boolean)])].sort());
export const COMMAND=['node','--test',
 'adapters/http/ruby-rails/target-scope.test.mjs',
 'adapters/http/ruby-rails/target-scope-negative.test.mjs'];
export const RECEIPT=path.join(ROOT,REL);
export const digests=()=>Object.fromEntries(SOURCE_FILES.map(p=>[p,H(read(p))]));
export function replay(){
 const r=spawnSync(process.execPath,COMMAND.slice(1),
   {cwd:ROOT,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024,
    env:{...process.env,NODE_OPTIONS:''}});
 if(r.error||r.status!==0||r.signal)throw Error('direct scope tests did not pass: '+r.stderr?.slice(-500));
 const text=(r.stdout||'')+'\n'+(r.stderr||'');
 const counts={};
 for(const k of ['tests','pass','fail','skipped','cancelled','todo']){
  const match=[...text.matchAll(new RegExp('(?:^|\\n)(?:#|ℹ)\\s*'+k+'\\s+(\\d+)','g'))];
  if(!match.length)throw Error('missing TAP '+k);
  counts[k]=Number(match.at(-1)[1]);
 }
 if(counts.tests!==14||counts.pass!==14||counts.fail||counts.skipped||counts.cancelled||counts.todo)
  throw Error('not 14/14 zero-skip '+JSON.stringify(counts));
 return {command:COMMAND,exit_code:0,counts};
}
export function problems(rec,actual=digests(),gitCheck=true){
 const bad=[];
 if(rec?.schema!=='bskel.rails-target-scope-proof/1'||rec?.task!=='HTTP-ruby-rails-01')bad.push('identity');
 if(!SHA.test(rec?.source_commit||''))bad.push('source commit invalid');
 const keys=Object.keys(rec?.sources||{}).sort();
 if(JSON.stringify(keys)!==JSON.stringify(SOURCE_FILES))bad.push('source path set drift');
 else for(const p of SOURCE_FILES)if(rec.sources[p]!==actual[p])bad.push('source digest drift '+p);
 const a=rec?.assertions||{};
 if(a.MET!==0||a.release!==false||a.runtime_certified!==false||
    a.external_runtime_equal!==false||a.signed_attestation!==false)bad.push('false authority');
 if(JSON.stringify(rec?.observed)!==JSON.stringify(replay()))bad.push('replay mismatch');
 if(!String(rec?.limits).includes('not runtime certified'))bad.push('scope limit');
 if(gitCheck&&SHA.test(rec?.source_commit||'')){
  try{
   if(git(['cat-file','-t',rec.source_commit])!=='commit')bad.push('missing original commit');
   const exists=spawnSync('git',['cat-file','-e',rec.source_commit+':'+REL],{cwd:ROOT});
   if(exists.status===0)bad.push('receipt already in original commit');
   const delta=git(['diff','--name-only',rec.source_commit,'HEAD','--',...SOURCE_FILES,REL]);
   if(delta.split('\n').filter(Boolean).some(p=>p!==REL))bad.push('original sources changed');
   for(const p of SOURCE_FILES){
    const blob=execFileSync('git',['show',rec.source_commit+':'+p],{cwd:ROOT,timeout:12000});
    if(H(blob)!==rec.sources?.[p])bad.push('original Git blob differs '+p);
   }
  }catch(e){bad.push('original Git evidence unavailable '+e.message)}
 }
 return bad;
}
const mode=process.argv[2];
if(mode==='--write'||mode==='--check'){
 try{
  if(mode==='--write'){
   const rec={schema:'bskel.rails-target-scope-proof/1',task:'HTTP-ruby-rails-01',
    source_commit:git(['rev-parse','HEAD']),sources:digests(),observed:replay(),
    assertions:{MET:0,release:false,runtime_certified:false,
      external_runtime_equal:false,signed_attestation:false},
    limits:'Static Rails target plan only, not runtime certified; outside CI third-party route equivalence remains unverified.'};
   if(problems(rec).length)throw Error(problems(rec).join('; '));
   fs.writeFileSync(RECEIPT,JSON.stringify(rec,null,2)+'\n',{flag:'wx'});
   console.log('SCOPE_RECEIPT_WRITTEN');
  }else{
   const failures=problems(JSON.parse(fs.readFileSync(RECEIPT)));
   if(failures.length)throw Error(failures.join('; '));
   console.log('SCOPE_EVIDENCE_PASS source-bound real 14/14, MET=0');
  }
 }catch(e){console.error('SCOPE_EVIDENCE_FAIL '+e.message);process.exitCode=1}
}
