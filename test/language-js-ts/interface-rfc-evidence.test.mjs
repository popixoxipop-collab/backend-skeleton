// T04-02: negative provenance regressions for exact-source RFC receipts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  RECEIPT, SOURCE_FILES, COMMAND,
  pinnedFiles, runRfcChecks, structureProblems,
  sourceCommitProblems, verifyEvidence,
} from './interface-rfc-evidence.mjs';

test('T04-02 receipt pins 27 source and T00 ownership-check dependency blobs and reproduces its actual zero-skip Node command', () => {
  const record=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
  assert.equal(SOURCE_FILES.length,27);
  const actual=runRfcChecks();
  assert.deepEqual(actual.command,COMMAND);
  assert.equal(actual.counts.skipped,0);
  assert.equal(actual.counts.fail,0);
  assert.deepEqual(verifyEvidence(record,actual),[]);
});

test('T04-02 evidence refuses source edits, forged Git identity, fabricated MET and an invented stable contract', () => {
  const record=JSON.parse(fs.readFileSync(RECEIPT,'utf8'));
  const changed={...pinnedFiles(),'scanners/language/js-ts/source-facts.mjs':'f'.repeat(64)};
  assert.match(structureProblems(record,changed).join(';'),/source file digest drift scanners\/language\/js-ts\/source-facts\.mjs/);
  assert.match(structureProblems({...record,source_files:{}}).join(';'),/incomplete or extra source-file pins/);
  const forged={...record.source_files,'scanners/language/js-ts/snapshot-graph.mjs':'0'.repeat(64)};
  const forgedWorking={...pinnedFiles(),'scanners/language/js-ts/snapshot-graph.mjs':'0'.repeat(64)};
  assert.deepEqual(structureProblems({...record,source_files:forged},forgedWorking),[],
    'source/working-copy matching forgery must pass shallow structure checks only');
  assert.match(sourceCommitProblems({...record,source_files:forged}).join(';'),/source Git blob digest mismatch/);
  const checkerDrift={...pinnedFiles(),'next/t00/check-ownership.mjs':'f'.repeat(64)};
  assert.match(structureProblems(record,checkerDrift).join(';'),/source file digest drift next\/t00\/check-ownership\.mjs/);
  const forgedChecker={...record.source_files,'next/t00/ownership.mjs':'0'.repeat(64)};
  const forgedCheckerWorking={...pinnedFiles(),'next/t00/ownership.mjs':'0'.repeat(64)};
  assert.deepEqual(structureProblems({...record,source_files:forgedChecker},forgedCheckerWorking),[]);
  assert.match(sourceCommitProblems({...record,source_files:forgedChecker}).join(';'),/source Git blob digest mismatch next\/t00\/ownership\.mjs/);

  assert.match(sourceCommitProblems({...record,verified_source_commit:'0'.repeat(40)}).join(';'),/source commit unavailable/);
  assert.match(structureProblems({...record,assertions:{...record.assertions,official_MET_delta:1}}).join(';'),/forged MET/);
  assert.match(structureProblems({...record,assertions:{...record.assertions,release_activation:true}}).join(';'),/forged MET/);
  assert.match(structureProblems({...record,assertions:{...record.assertions,signed_independent_attestation:true}}).join(';'),/forged MET/);
  assert.match(structureProblems({...record,assertions:{...record.assertions,stable_sbf_contract:true}}).join(';'),/forged MET/);
  assert.match(structureProblems({...record,observed_run:{...record.observed_run,exit_code:1}}).join(';'),/invalid recorded RFC command/);
  assert.match(structureProblems({...record,observed_run:{...record.observed_run,counts:{...record.observed_run.counts,skipped:1}}}).join(';'),/invalid recorded RFC command/);
  assert.match(structureProblems({...record,limitations:'all runtimes approved'}).join(';'),/scope limitations/);
  assert.match(structureProblems({...record,metadata:'approved'}).join(';'),/invalid evidence receipt field set/);
});
