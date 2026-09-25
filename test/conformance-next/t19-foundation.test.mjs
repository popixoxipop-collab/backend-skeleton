import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCorpusManifest, summarizeCorpus } from '../corpus-next/corpus.mjs';
import { validateNegativeCatalog, coverageSummary } from './catalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'corpus-next', 'manifest.json'), 'utf8'));
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'negative-vectors.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

test('T19 corpus manifest is structurally and semantically valid without claiming independent certification', () => {
  const verdict = validateCorpusManifest(corpus);
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  const summary = summarizeCorpus(corpus);
  assert.equal(summary.total, 5);
  assert.equal(summary.holdout, 0);
  assert.equal(summary.pending_review, 5);
  assert.equal(summary.certification_eligible, 0);
});

test('T19 corpus rejects a real repository without an exact commit pin or license', () => {
  const bad = clone(corpus);
  bad.entries[0].source = { kind: 'real-repo', repository: 'https://github.com/example/project', commit: 'main', license: '', root: '.' };
  const verdict = validateCorpusManifest(bad);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('40-hex commit SHA')));
  assert.ok(verdict.errors.some((x) => x.includes('license')));
});

test('T19 corpus rejects candidate-generated expected output as an independent golden', () => {
  const bad = clone(corpus);
  bad.entries[0].golden.generated_by_candidate = true;
  const verdict = validateCorpusManifest(bad);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('candidate-generated output')));
});

test('T19 corpus rejects self-reviewed or unreviewed holdout entries', () => {
  const bad = clone(corpus);
  bad.entries[0].cohort = 'holdout';
  bad.entries[0].golden = { basis: 'manual', review_state: 'independent-reviewed', authored_by: 'alice', reviewed_by: 'alice', generated_by_candidate: false };
  const verdict = validateCorpusManifest(bad);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('must differ from authored_by')));
});

test('T19 corpus rejects duplicate ids and escaping roots', () => {
  const bad = clone(corpus);
  bad.entries[1].id = bad.entries[0].id;
  bad.entries[0].source.root = '../outside';
  const verdict = validateCorpusManifest(bad);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('duplicate corpus id')));
  assert.ok(verdict.errors.some((x) => x.includes('may not contain ..')));
});

test('T19 negative catalog has exactly 79 unique vectors with the planned category distribution', () => {
  const verdict = validateNegativeCatalog(vectors);
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  const summary = coverageSummary(vectors);
  assert.equal(summary.specified, 79);
  assert.equal(summary.covered, 0);
  assert.equal(summary.status, 'incomplete');
  assert.ok(summary.critical_specified > 0);
});

test('T19 negative catalog cannot claim coverage without an implementation/test reference', () => {
  const bad = clone(vectors);
  bad.vectors[0].status = 'covered';
  bad.vectors[0].implementation_refs = [];
  const verdict = validateNegativeCatalog(bad);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('covered vectors need at least one implementation ref')));
});

test('T19 negative catalog rejects duplicated vector identities', () => {
  const bad = clone(vectors);
  bad.vectors[1].id = bad.vectors[0].id;
  const verdict = validateNegativeCatalog(bad);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('duplicate')));
});
