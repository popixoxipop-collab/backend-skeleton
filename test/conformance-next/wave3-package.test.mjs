import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
function command(args,cwd){
 const r=spawnSync(process.platform==='win32'?'npm.cmd':'npm',args,{cwd,encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024,
  env:{...process.env,NODE_OPTIONS:'',npm_config_update_notifier:'false',npm_config_offline:'true'}});
 assert.equal(r.error,undefined,r.error?.message);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);return r.stdout;
}
test('NEG-RELEASE-03 actual archive and installed SDK include required runtime files',{timeout:120000},t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave3-pack-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const [pack]=JSON.parse(command(['pack','--offline','--ignore-scripts','--json','--pack-destination',temp],ROOT));
 assert.equal(pack.name,'backend-skeleton');assert.equal(path.basename(pack.filename),pack.filename);
 const names=new Set(pack.files.map(x=>x.path));
 for(const rel of ['sdk/next/index.mjs','sdk/next/_util.mjs','contracts/next/identity.mjs']){
  assert.ok(names.has(rel),'actual npm archive is missing required runtime file '+rel);
 }
 const consumer=path.join(temp,'consumer');fs.mkdirSync(consumer);
 command(['install','--offline','--ignore-scripts','--no-audit','--no-fund','--no-save','--package-lock=false','--prefix',consumer,path.join(temp,pack.filename)],temp);
 const installed=path.join(consumer,'node_modules/backend-skeleton');
 for(const rel of ['sdk/next/index.mjs','sdk/next/_util.mjs','contracts/next/identity.mjs']){
  assert.deepEqual(fs.readFileSync(path.join(installed,rel)),fs.readFileSync(path.join(ROOT,rel)));
 }
 const r=spawnSync(process.execPath,[path.join(ROOT,'next/t22/installed-sdk-probe.mjs'),consumer,'present'],{
  cwd:temp,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,env:{...process.env,NODE_OPTIONS:''}});
 assert.equal(r.error,undefined,r.error?.message);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);
 const result=JSON.parse(r.stdout);assert.equal(result.ok,true);assert.equal(result.sdk,'present');
});
