// Independent regression for T13-02 RFC receipt: source changes and forged MET must fail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { RECEIPT, evidenceProblems, observeRfcTest, pinnedFiles, verifyEvidence } from './interface-rfc-evidence.mjs';

test('T13 RFC receipt is source-pinned, zero-skip, and reproduced by the actual test command', () => {
  const record = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  assert.deepEqual(verifyEvidence(record, observeRfcTest()), []);
});

test('T13 RFC evidence rejects edited interface, omitted files and false MET/release claims', () => {
  const record = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  const changed = { ...pinnedFiles(), 'adapters/http-wave-bc/INTERFACE_RFC.md': '0'.repeat(64) };
  assert.match(evidenceProblems(record, changed).join(';'), /source digest drift/);
  assert.match(evidenceProblems({ ...record, source_files: {} }).join(';'), /source file set changed/);
  assert.match(evidenceProblems({ ...record, assertions: { ...record.assertions, MET_delta: 1 } }).join(';'), /false authority claim/);
  assert.match(evidenceProblems({ ...record, observed_run: { ...record.observed_run, exit_code: 2 } }).join(';'), /invalid recorded command outcome/);
});
