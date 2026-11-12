import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { runGatedProductScan, GATED_SCAN_CONTRACT } from '../../lib/trust-next/gated-product-scan.mjs';
import { PERMISSION_MANIFEST_SCHEMA } from '../../lib/trust-next/permission-manifest.mjs';
import { EnforcementDenied } from '../../lib/trust-next/enforcement-gate.mjs';
import { runScan } from '../../scanners/index.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CASES = { 'java-spring':'test/fixtures/java-spring',
  'javascript-express':'test/fixtures/javascript-express/backend',
  'python-fastapi':'test/fixtures/python-fastapi/backend' };
const grant=(...read_roots)=>({schema:PERMISSION_MANIFEST_SCHEMA,read_roots});
const fixture=name=>path.join(ROOT,CASES[name]);
function filesOf(root) {
  const out=[];
  function visit(parent) {
    for (const d of fs.readdirSync(path.join(root,parent),{withFileTypes:true})) {
      const rel=parent?parent+'/'+d.name:d.name;
      if(d.isDirectory()) visit(rel);
      else if(d.isFile() && !d.name.startsWith('.')) out.push(rel);
    }
  }
  visit('');
  return out.sort();
}
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t20-consumer-test-'));
test('T20 gate snapshot', async()=>{const root=fixture('javascript-express'); const files=filesOf(root); const r=await runGatedProductScan({repoRoot:root,manifest:grant('.'),files,terms:[]}); assert.equal(r.scan_report.adapter,'javascript-express'); assert.equal(r.gate_enforced_source_reads,files.length);});
test('T20 gated product matches direct report for all adapters',async()=>{
  for(const [id,rel] of Object.entries(CASES)) {
    const repoRoot=path.join(ROOT,rel),files=filesOf(repoRoot);
    const gated=await runGatedProductScan({repoRoot,manifest:grant('.'),files,terms:[]});
    assert.equal(gated.scan_report.adapter,id);
    assert.equal(gated.gate_audit_entries,files.length*2);
    assert.equal(gated.gate_audit_valid,true);
    assert.deepEqual(gated.scan_report,runScan({repoRoot,terms:[],rgAvailable:true}),id);
  }
});
test('T20 denied project file aborts before product scan',async()=>{
  const repoRoot=fixture('python-fastapi'),files=filesOf(repoRoot);
  assert.ok(files.includes('pyproject.toml'));
  await assert.rejects(
    runGatedProductScan({repoRoot,manifest:grant('app'),files,terms:[]}),
    error=>error instanceof EnforcementDenied && error.reason==='NOT_GRANTED');
});
test('T20 out-of-root symbolic link cannot be copied into a product snapshot',async()=>{
  const root=temp();
  try{
    const target=path.join(root,'outside.txt');
    const project=path.join(root,'project');
    fs.mkdirSync(path.join(project,'src'),{recursive:true});
    fs.writeFileSync(target,'private fixture');
    fs.writeFileSync(path.join(project,'package.json'),'{"name":"sample","type":"module"}');
    fs.symlinkSync(target,path.join(project,'src','leak.js'));
    await assert.rejects(runGatedProductScan({
      repoRoot:project,manifest:grant('.'),files:['package.json','src/leak.js'],
      terms:[]
    }),e=>e instanceof EnforcementDenied && e.reason==='PATH_ESCAPES_ROOT');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('T20 rejects traversal, hidden source, duplicate files and unsupported rg',async()=>{
  const repoRoot=fixture('javascript-express'),manifest=grant('.');
  for(const files of [['../outside'],['.env'],['src/../../outside'],
      ['package.json','package.json'],['node_modules/secrets.js']]){
    await assert.rejects(runGatedProductScan({repoRoot,manifest,files}),
      e=>e.code==='T20_SOURCE_LIST_INVALID');
  }
  await assert.rejects(runGatedProductScan({
    repoRoot,manifest,files:['package.json'],rgAvailable:false
  }),e=>e.code==='T20_RG_REQUIRED');
});
test('T20 enforces per-source byte bound before the scanner sees input',async()=>{
  const root=temp();
  try{
    fs.writeFileSync(path.join(root,'large.js'),Buffer.alloc(2*1024*1024+1,65));
    await assert.rejects(runGatedProductScan({
      repoRoot:root,manifest:grant('.'),files:['large.js']
    }),e=>e.code==='T20_FILE_LIMIT');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('T20 installed npm distribution ships real gated product consumer and CLI', {timeout:70000}, async()=>{
  const scratch=temp();
  try{
    const npm=path.join(path.dirname(process.execPath),'npm');
    const opts={cwd:ROOT,encoding:'utf8',timeout:45000,maxBuffer:16*1024*1024};
    const info=JSON.parse(execFileSync(npm,['pack','--ignore-scripts','--json','--pack-destination',scratch],opts))[0];
    for(const name of ['lib/trust-next/gated-product-scan.mjs','lib/trust-next/gated-product-scan-cli.mjs'])
      assert.ok(info.files.some(x=>x.path===name),name);
    const install=path.join(scratch,'consumer');
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(install,'package.json'),'{"name":"gated-consumer","private":true,"type":"module"}');
    execFileSync(npm,['install','--ignore-scripts','--no-audit','--no-fund','--prefer-offline','--silent',
      path.join(scratch,info.filename)],{...opts,cwd:install});
    const pkg=path.join(install,'node_modules/backend-skeleton');
    const module=await import(pathToFileURL(path.join(pkg,'lib/trust-next/gated-product-scan.mjs')).href);
    assert.equal(module.GATED_SCAN_CONTRACT,GATED_SCAN_CONTRACT);
    const cli=path.join(pkg,'lib/trust-next/gated-product-scan-cli.mjs');
    const repoRoot=fixture('javascript-express'),files=filesOf(repoRoot);
    const argv=[cli,'--repo',repoRoot,'--policy-json',JSON.stringify(grant('.')),
      '--files-json',JSON.stringify(files)];
    const observed=spawnSync(process.execPath,argv,{encoding:'utf8',timeout:15000});
    assert.equal(observed.status,0,observed.stderr);
    const report=JSON.parse(observed.stdout);
    assert.equal(report.schema,GATED_SCAN_CONTRACT);
    assert.equal(report.scan_report.adapter,'javascript-express');
    assert.equal(report.gate_enforced_source_reads,files.length);
    const denied=spawnSync(process.execPath,[cli,'--repo',repoRoot,
      '--policy-json',JSON.stringify(grant('src')),
      '--files-json',JSON.stringify(files)],{encoding:'utf8',timeout:15000});
    assert.equal(denied.status,2);
    assert.equal(denied.stdout,'');
    assert.equal(JSON.parse(denied.stderr).error_code,'PERMISSION_DENIED');
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
});
