import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RECEIPT, SOURCE_FILES, COMMAND, pinnedFiles, runRfcChecks, structureProblems, sourceCommitProblems, verifyEvidence } from './interface-rfc-evidence.mjs';

test('T05-02 exact source-bound JVM receipt and zero-skip command',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 const run=runRfcChecks();
 assert.equal(SOURCE_FILES.length,15);
 assert.deepEqual(run.command,COMMAND);
 assert.equal(run.counts.pass,16);
 assert.equal(run.counts.fail,0);
 assert.equal(run.counts.skipped,0);
 assert.deepEqual(verifyEvidence(r,run),[]);
});
test('T05-02 rejects altered original blobs and false MET or release authority',()=>{
 const r=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
 const p='scanners/language/jvm/protocol.mjs';
 assert.ok(structureProblems(r,{...pinnedFiles(),[p]:'f'.repeat(64)}).length);
 assert.ok(structureProblems({...r,source_files:{}}).length);
 const forged={...r.source_files,[p]:'0'.repeat(64)};
 assert.deepEqual(structureProblems({...r,source_files:forged},{...pinnedFiles(),[p]:'0'.repeat(64)}),[]);
 assert.ok(sourceCommitProblems({...r,source_files:forged}).length);
 assert.ok(sourceCommitProblems({...r,verified_source_commit:'0'.repeat(40)}).length);
 for(const [key,value] of [['official_MET_delta',1],['release_activation',true],['stable_sbf_contract',true]]){
  assert.ok(structureProblems({...r,assertions:{...r.assertions,[key]:value}}).length);
 }
 assert.ok(structureProblems({...r,observed_run:{...r.observed_run,exit_code:1}}).length);
 assert.ok(structureProblems({...r,observed_run:{...r.observed_run,counts:{...r.observed_run.counts,skipped:1}}}).length);
});
