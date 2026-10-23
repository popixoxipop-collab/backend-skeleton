// T06-02 source provenance and RFC command replay; no MET or release approval.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  RECEIPT, currentSourceHashes, structureProblems,
  sourceCommitProblems, runInterfaceChecks, verifyEvidence,
} from './interface-rfc-evidence.mjs';

test('T06 RFC receipt binds exact source Git blobs and replays 56 zero-skip RFC checks', () => {
  const rec = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  const observed = runInterfaceChecks();
  assert.equal(observed.counts.fail, 0);
  assert.equal(observed.counts.skipped, 0);
  assert.deepEqual(verifyEvidence(rec, observed), []);
});

test('T06 forged source identity, file, command and official authority all fail closed', () => {
  const rec = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  assert.match(sourceCommitProblems({ ...rec, verified_source_commit: '0'.repeat(40) }).join(';'), /source commit unavailable/);
  assert.match(structureProblems({ ...rec, source_files: {} }).join(';'), /incomplete source file/);
  const altered = { ...currentSourceHashes(), 'scanners/language/python/INTERFACE_RFC.md': '0'.repeat(64) };
  assert.match(structureProblems(rec, altered).join(';'), /source file digest drift/);
  const forged = { ...rec.source_files, 'scanners/language/python/README.md': 'f'.repeat(64) };
  assert.match(sourceCommitProblems({ ...rec, source_files: forged }).join(';'), /source commit blob digest mismatch/);
  assert.match(structureProblems({ ...rec, assertions: { ...rec.assertions, official_MET_delta: 1 } }).join(';'), /forged adjudication/);
  assert.match(structureProblems({ ...rec, assertions: { ...rec.assertions, signed_independent_attestation: true } }).join(';'), /forged adjudication/);
  assert.match(structureProblems({ ...rec, observed_run: { ...rec.observed_run, exit_code: 1 } }).join(';'), /recorded RFC command/);
  assert.match(structureProblems({ ...rec, observed_run: { ...rec.observed_run, counts: { ...rec.observed_run.counts, skipped: 1 } } }).join(';'), /recorded RFC command/);
});
