import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const REL='adapters/http/java-spring/SCOPE_EVIDENCE.json';
const SHA=/^[0-9a-f]{40}$/;
const H=b=>createHash('sha256').update(b).digest('hex');
const git=(args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8',timeout:25000,
 stdio:['ignore','pipe','pipe']}).trim();
const read=p=>fs.readFileSync(path.join(ROOT,p));
const inputs=[
 'adapters/http/java-spring/TARGET_SCOPE.md',
 'adapters/http/java-spring/target-scope.test.mjs',
 'adapters/http/java-spring/target-scope-negative.test.mjs',
 'adapters/http/java-spring/scope-evidence.mjs',
 'adapters/http/java-spring/scope-evidence.test.mjs',
 'scanners/adapters/java-spring.mjs','scanners/adapters/_java-spring-analyzer.mjs',
 'scanners/index.mjs','scanners/registry.mjs','scanners/text-util.mjs',
 'test/fixtures/oracle-manifest.json','test/scan-fixture.test.mjs',
 'test/java-spring-analyzer.test.mjs','test/java-spring-nested-root.test.mjs',
 'test/spring-data-rest-adapter.test.mjs','scripts/shadow-validation-smoke.mjs',
 '.github/workflows/ci.yml','next/t00/check-ownership.mjs','next/t00/ownership.mjs'
];
// Registry discovery imports every tracked adapter. Pin that complete subtree,
// the exact fixture, schema/package inputs, and T00 ownership inputs so a new
// receipt cannot replay against changed implementation or admission rules.
const dependencyFiles=git(['ls-files',
 'scanners/adapters','scanners/registry.mjs','schemas/adapter.schema.json',
 'schemas/scan-report.schema.json','lib/schema-validate.mjs','package.json','package-lock.json',
 'next/t00/build-ownership-map.mjs','next/t00/verify-baseline.mjs','next/t00/snapshot-plan.mjs',
 'next/t00/ownership-map.json','next/t00/baseline.lock.json','next/t00/fixtures',
 'scripts/run-next-nested-tests.mjs'
]).split('\n').filter(Boolean);
export const SOURCE_FILES=Object.freeze([...new Set([...inputs,
 ...git(['ls-files','test/fixtures/java-spring']).split('\n').filter(Boolean),
 ...dependencyFiles])].sort());
export const COMMAND=Object.freeze(['node','--test',
 'adapters/http/java-spring/target-scope.test.mjs',
 'adapters/http/java-spring/target-scope-negative.test.mjs']);
export const RECEIPT=path.join(ROOT,REL);
export const digests=()=>Object.fromEntries(SOURCE_FILES.map(p=>[p,H(read(p))]));

export function replay(){
 const env={...process.env,NODE_OPTIONS:''};
 for(const key of Object.keys(env))if(key.startsWith('NODE_TEST_'))delete env[key];
 const r=spawnSync(process.execPath,COMMAND.slice(1),
   {cwd:ROOT,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024,env});
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
 if(!rec||typeof rec!=='object'||Array.isArray(rec)||
    JSON.stringify(Object.keys(rec).sort())!==JSON.stringify(
      ['schema','task','source_commit','sources','observed','assertions','limits'].sort()))
   return ['invalid receipt field set'];
 if(!rec.sources||typeof rec.sources!=='object'||Array.isArray(rec.sources))return ['invalid source map'];
 if(!rec.assertions||typeof rec.assertions!=='object'||
    JSON.stringify(Object.keys(rec.assertions).sort())!==JSON.stringify(
      ['MET','release','runtime_certified','external_runtime_equal','signed_attestation'].sort()))
   bad.push('invalid authority field set');
 if(!rec.observed||JSON.stringify(Object.keys(rec.observed).sort())!==JSON.stringify(
      ['command','exit_code','counts'].sort()))
   bad.push('invalid replay field set');
 if(!rec.observed?.counts||JSON.stringify(Object.keys(rec.observed.counts).sort())!==JSON.stringify(
      ['tests','pass','fail','skipped','cancelled','todo'].sort()))
   bad.push('invalid TAP field set');
 if(rec?.schema!=='bskel.spring-target-scope-proof/1'||rec?.task!=='HTTP-java-spring-01')bad.push('identity');
 if(!SHA.test(rec?.source_commit||''))bad.push('source commit invalid');
 const keys=Object.keys(rec?.sources||{}).sort();
 if(JSON.stringify(keys)!==JSON.stringify(SOURCE_FILES))bad.push('source path set drift');
 else for(const p of SOURCE_FILES)if(!/^[0-9a-f]{64}$/.test(rec.sources[p])||rec.sources[p]!==actual[p])bad.push('source digest drift '+p);
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
   const rec={schema:'bskel.spring-target-scope-proof/1',task:'HTTP-java-spring-01',
    source_commit:git(['rev-parse','HEAD']),sources:digests(),observed:replay(),
    assertions:{MET:0,release:false,runtime_certified:false,
      external_runtime_equal:false,signed_attestation:false},
    limits:'Static Spring target plan only, not runtime certified; external oracle execution remains outside default CI and runtime equivalence is unverified.'};
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
