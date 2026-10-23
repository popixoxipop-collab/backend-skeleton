// T14-02: negative evidence mutations must be rejected without runtime or MET claims.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  RECEIPT, evidenceProblems, observe, pinnedFiles, verify,
} from './interface-rfc-evidence.mjs';

test('T14 committed RFC receipt pins source files and reproduces its zero-skip test command', () => {
  const record = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  assert.deepEqual(verify(record, observe()), []);
});
test('T14 rejects source drift, omitted proof, and forged MET/release/reviewer assertions', () => {
  const record = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));
  const badFiles = { ...pinnedFiles(), 'handles/composition-next/INTERFACE_RFC.md': 'f'.repeat(64) };
  assert.match(evidenceProblems(record, badFiles).join(';'), /source hash drift/);
  assert.match(evidenceProblems({ ...record, source_files: {} }).join(';'), /source file pins/);
  assert.match(evidenceProblems({ ...record, assertions: { ...record.assertions, official_MET_delta: 1 } }).join(';'), /false MET/);
  assert.match(evidenceProblems({ ...record, assertions: { ...record.assertions, signed_independent_review: true } }).join(';'), /reviewer/);
  assert.match(evidenceProblems({ ...record, observed_run: { ...record.observed_run, exit_code: 1 } }).join(';'), /recorded command/);
  assert.match(evidenceProblems({ ...record, observed_run: { ...record.observed_run, counts: { ...record.observed_run.counts, skipped: 1 } } }).join(';'), /recorded command/);
  assert.match(evidenceProblems({ ...record, scope_limit: 'APPROVED' }).join(';'), /limited scope/);
  // A syntactically valid but nonexistent commit is not an acceptable source identity.
  const forgedSource = { ...record, verified_source_commit: '0'.repeat(40) };
  assert.match(verify(forgedSource).join(';'), /pinned source commit unavailable/);
});
