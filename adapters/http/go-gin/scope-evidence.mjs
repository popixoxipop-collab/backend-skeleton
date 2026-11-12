import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const REL='adapters/http/go-gin/SCOPE_EVIDENCE.json';
const SHA=/^[0-9a-f]{40}$/;
const H=b=>createHash('sha256').update(b).digest('hex');
const git=args=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8',timeout:25000,
 stdio:['ignore','pipe','pipe']}).trim();
const read=p=>fs.readFileSync(path.join(ROOT,p));
const inputs=[
 'adapters/http/go-gin/TARGET_SCOPE.md','adapters/http/go-gin/UPSTREAM_PIN.json',
 'adapters/http/go-gin/fixtures/upstream/realtime-chat/main.go',
 'adapters/http/go-gin/fixtures/upstream/realtime-chat/go.mod',
 'adapters/http/go-gin/target-scope.test.mjs',
 'adapters/http/go-gin/target-scope-negative.test.mjs',
 'adapters/http/go-gin/scope-evidence.mjs','adapters/http/go-gin/scope-evidence.test.mjs',
 'adapters/http-wave-a/gin.mjs','adapters/http-wave-a/_shared.mjs',
 'adapters/http-wave-a/BASELINE.json','adapters/http-wave-a/INTERFACE_RFC.md',
 'adapters/http-wave-a/leaf-contract.schema.json',
 'scanners/language/native-server/go.mjs','scanners/language/native-server/index.mjs',
 '.github/workflows/ci.yml','next/t00/check-ownership.mjs','next/t00/ownership.mjs'
];
// The Gin leaf consumes T08 facts and its existing T12 nested suite verifies the
// complete Wave A vocabulary. Pin both complete tracked subtrees plus package,
// baseline-lock, nested-runner and ownership inputs so a receipt cannot replay
// against changed upstream analysis or admission rules.
const dependencyFiles=git(['ls-files','adapters/http-wave-a','scanners/language/native-server',
 'test/http-wave-a','test/language-native-server','schemas/adapter.schema.json',
 'schemas/scan-report.schema.json','lib/schema-validate.mjs','package.json','package-lock.json',
 'next/t00/build-ownership-map.mjs','next/t00/verify-baseline.mjs','next/t00/snapshot-plan.mjs',
 'next/t00/ownership-map.json','next/t00/baseline.lock.json','next/t00/fixtures',
 'scripts/run-next-nested-tests.mjs'
]).split('\n').filter(Boolean);
export const SOURCE_FILES=Object.freeze([...new Set([...inputs,...dependencyFiles])].sort());
export const COMMAND=Object.freeze(['node','--test',
 'adapters/http/go-gin/target-scope.test.mjs',
 'adapters/http/go-gin/target-scope-negative.test.mjs']);
export const RECEIPT=path.join(ROOT,REL);
export const digests=()=>Object.fromEntries(SOURCE_FILES.map(p=>[p,H(read(p))]));

export function replay(){
 const env={...process.env,NODE_OPTIONS:''};
 for(const key of Object.keys(env))if(key.startsWith('NODE_TEST_'))delete env[key];
 const r=spawnSync(process.execPath,COMMAND.slice(1),
  {cwd:ROOT,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024,env});
 if(r.error||r.status!==0||r.signal)throw Error('direct Gin scope tests did not pass: '+r.stderr?.slice(-1000));
 const text=(r.stdout||'')+'\n'+(r.stderr||'');
 const counts={};
 for(const k of ['tests','pass','fail','skipped','cancelled','todo']){
  const match=[...text.matchAll(new RegExp('(?:^|\\n)(?:#|ℹ)\\s*'+k+'\\s+(\\d+)','g'))];
  if(!match.length)throw Error('missing TAP '+k);
  counts[k]=Number(match.at(-1)[1]);
 }
 if(counts.tests!==16||counts.pass!==16||counts.fail||counts.skipped||counts.cancelled||counts.todo)
  throw Error('not 16/16 zero-skip '+JSON.stringify(counts));
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
      ['command','exit_code','counts'].sort()))bad.push('invalid replay field set');
 if(!rec.observed?.counts||JSON.stringify(Object.keys(rec.observed.counts).sort())!==JSON.stringify(
      ['tests','pass','fail','skipped','cancelled','todo'].sort()))bad.push('invalid TAP field set');
 if(rec?.schema!=='bskel.gin-target-scope-proof/1'||rec?.task!=='HTTP-go-gin-01')bad.push('identity');
 if(!SHA.test(rec?.source_commit||''))bad.push('source commit invalid');
 const keys=Object.keys(rec?.sources||{}).sort();
 if(JSON.stringify(keys)!==JSON.stringify(SOURCE_FILES))bad.push('source path set drift');
 else for(const p of SOURCE_FILES){
  if(!/^[0-9a-f]{64}$/.test(rec.sources[p])||rec.sources[p]!==actual[p])bad.push('source digest drift '+p);
 }
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
   const rec={schema:'bskel.gin-target-scope-proof/1',task:'HTTP-go-gin-01',
    source_commit:git(['rev-parse','HEAD']),sources:digests(),observed:replay(),
    assertions:{MET:0,release:false,runtime_certified:false,
      external_runtime_equal:false,signed_attestation:false},
    limits:'Static Gin target plan only, not runtime certified; one exact upstream source commit is analyzed without Go or Gin execution and runtime equivalence remains unverified.'};
   if(problems(rec).length)throw Error(problems(rec).join('; '));
   fs.writeFileSync(RECEIPT,JSON.stringify(rec,null,2)+'\n',{flag:'wx'});
   console.log('SCOPE_RECEIPT_WRITTEN');
  }else{
   const failures=problems(JSON.parse(fs.readFileSync(RECEIPT)));
   if(failures.length)throw Error(failures.join('; '));
   console.log('SCOPE_EVIDENCE_PASS source-bound real 16/16, MET=0');
  }
 }catch(e){console.error('SCOPE_EVIDENCE_FAIL '+e.message);process.exitCode=1}
}
