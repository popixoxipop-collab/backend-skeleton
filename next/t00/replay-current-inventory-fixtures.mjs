#!/usr/bin/env node
// Opt-in rehearsal only. No writes to inventory/lock/observation, no network and no release authority.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBaseline, verifyLockRecord } from './verify-baseline-strict-v1.mjs';
import { readInput } from './verify-inventory-alignment.mjs';

const [lockPath, obsPath, invPath, invPin] = process.argv.slice(2);
assert.equal(process.argv.length,6,'expected lock, observation, production inventory copy, pinned inventory SHA-256');
const parse = bytes => JSON.parse(bytes.toString('utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const lock = parse(readInput(lockPath)), observation = parse(readInput(obsPath));
const productionInventory = readInput(invPath);
assert.match(invPin,/^[0-9a-f]{64}$/);
assert.equal(digest(productionInventory),invPin,'source inventory must match the supplied byte pin');
assert.deepEqual(verifyBaseline(lock, observation, { remote:true }).errors,[]);
assert.deepEqual(verifyLockRecord(lock, observation).errors,[]);
const inv = parse(productionInventory);
const aligned = structuredClone(inv);
const heads = Object.fromEntries(lock.repositories.map(row => [row.role,row.head_sha]));
const oldPins = {};
for (const row of aligned.repositories) {
  oldPins[row.role] = inv.coordination_baseline.repositories[row.role];
  aligned.coordination_baseline.repositories[row.role] = heads[row.role];
  row.head_sha = heads[row.role];
  row.coordination_sha = heads[row.role];
}
const fixtureBytes = doc => Buffer.from(JSON.stringify(doc,null,2)+'\n');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'t00-inventory-replay-'));
const gate=fileURLToPath(new URL('./verify-inventory-alignment.mjs',import.meta.url));
function probe(label,bytes,pin,codes,role=null) {
  const file=path.join(temp,'inventory.json');
  fs.writeFileSync(file,bytes);
  const r=spawnSync(process.execPath,[gate,'--inventory-sha256',pin,lockPath,obsPath,file],
    {encoding:'utf8',timeout:8000});
  assert.ifError(r.error); assert.equal(r.signal,null);
  assert.equal(r.status,codes.length?2:0,label+': '+r.stderr);
  const result=JSON.parse(r.stdout);
  assert.deepEqual(result.errors.map(e=>e.code),codes,label);
  assert.equal(result.ok,codes.length===0,label);
  if(role) assert.ok(result.errors.every(e=>e.role===role),label);
  if(codes.length) assert.deepEqual(result.aligned_repositories,[],label);
  else assert.deepEqual(Object.fromEntries(result.aligned_repositories.map(r=>[r.role,r.head_sha])),heads,label);
  return {label,exit:r.status,sha256:digest(bytes),errors:result.errors,stdout_sha256:digest(r.stdout)};
}
const proofs=[];
try {
  const good=fixtureBytes(aligned);
  proofs.push(probe('synthetic-aligned-pins-only',good,digest(good),[]));
  proofs.push(probe('unchanged-production-inventory',productionInventory,invPin,Array(9).fill('INVENTORY_HEAD_MISMATCH')));
  for (const role of Object.keys(heads).sort()) {
    assert.notEqual(oldPins[role],heads[role],role+' fixture requires an actually stale inventory pin');
    for (const key of ['coordination-map','head_sha','coordination_sha']) {
      const bad=structuredClone(aligned);
      if(key==='coordination-map') bad.coordination_baseline.repositories[role]=oldPins[role];
      else bad.repositories.find(row=>row.role===role)[key]=oldPins[role];
      const bytes=fixtureBytes(bad);
      proofs.push(probe(role+'-'+key,bytes,digest(bytes),['INVENTORY_HEAD_MISMATCH'],role));
    }
  }
  proofs.push(probe('aligned-bytes-with-wrong-pin',good,invPin,['INVENTORY_HASH_MISMATCH']));
  console.log(JSON.stringify({scope:'offline fixture; no T23 approval, CI promotion, signature or U-2',
    heads,proofs,positive:1,negative:proofs.length-1},null,2));
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
