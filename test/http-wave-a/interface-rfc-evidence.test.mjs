// T12-02: adversarial evidence and source-bound replay regressions; no automatic release or MET.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { RECEIPT, SOURCE_FILES, pinnedFiles, structureProblems,
  sourceCommitProblems, evidenceRelevantChangedPaths, runRfcCommand, verifyEvidence } from './interface-rfc-evidence.mjs';

test('T12 committed evidence matches Git source bytes and an actual zero-skip RFC+boundary replay', () => {
  const record = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  assert.equal(SOURCE_FILES.length, 20);
  assert.deepEqual(verifyEvidence(record, runRfcCommand()), []);
});
test('T12 receipt rejects missing pins, source edits, forged Git identity and false MET/release assertions', () => {
  const rec = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  const changed = { ...pinnedFiles(), 'adapters/http-wave-a/django-drf.mjs': 'f'.repeat(64) };
  assert.match(structureProblems(rec, changed).join(';'), /source file hash drift adapters\/http-wave-a\/django-drf\.mjs/);
  assert.match(structureProblems({ ...rec, source_files: {} }).join(';'), /source file pins/);
  const forged = { ...rec.source_files, 'adapters/http-wave-a/nestjs.mjs': '0'.repeat(64) };
  assert.match(sourceCommitProblems({ ...rec, source_files: forged }).join(';'), /source commit blob hash differs/);
  assert.match(structureProblems({ ...rec, assertions: { ...rec.assertions, official_MET_delta: 1 } }).join(';'), /forged MET/);
  assert.match(structureProblems({ ...rec, assertions: { ...rec.assertions, signed_independent_attestation: true } }).join(';'), /forged MET/);
  assert.match(structureProblems({ ...rec, observed_run: { ...rec.observed_run, exit_code: 2 } }).join(';'), /invalid recorded/);
  assert.match(structureProblems({ ...rec, observed_run: { ...rec.observed_run, counts: { ...rec.observed_run.counts, skipped: 1 } } }).join(';'), /invalid recorded/);
  assert.match(structureProblems({ ...rec, limits: 'all runtimes approved' }).join(';'), /scope limit/);
  assert.match(sourceCommitProblems({ ...rec, verified_source_commit: '0'.repeat(40) }).join(';'), /source commit unavailable/);
});


test('T12 source identity gates do not reject unrelated future T04/T06 or DOCS changes', () => {
  const unrelated = [
    'scanners/language/js-ts/INTERFACE_RFC.md',
    'test/language-js-ts/interface-rfc.test.mjs',
    'next/t04/INTERFACE_RFC_EVIDENCE.json',
    'README.md',
  ];
  assert.deepEqual(evidenceRelevantChangedPaths(unrelated), []);
  assert.deepEqual(evidenceRelevantChangedPaths([
    ...unrelated,
    'adapters/http-wave-a/django-drf.mjs',
    'test/http-wave-a/interface-rfc.test.mjs',
    'next/t12/INTERFACE_RFC_EVIDENCE.json',
  ]), ['adapters/http-wave-a/django-drf.mjs', 'test/http-wave-a/interface-rfc.test.mjs']);
});
