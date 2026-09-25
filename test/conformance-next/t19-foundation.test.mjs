import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCorpusManifest, summarizeCorpus } from '../corpus-next/corpus.mjs';
import { projectLegacyOracleCandidates, summarizeLegacyOracleProjection } from '../corpus-next/legacy-oracle-import.mjs';
import { validateNegativeCatalog, coverageSummary } from './catalog.mjs';
import { validateExternalEvidenceCandidates, summarizeExternalEvidenceCandidates } from './external-candidates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'corpus-next', 'manifest.json'), 'utf8'));
const legacyOracle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'oracle-manifest.json'), 'utf8'));
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'negative-vectors.json'), 'utf8'));
const externalCandidates = JSON.parse(fs.readFileSync(path.join(__dirname, 'external-evidence-candidates.json'), 'utf8'));
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
  assert.equal(summary.evidence_candidates, 6);
  assert.equal(summary.covered, 0);
  assert.equal(summary.status, 'incomplete');
  assert.ok(summary.critical_specified > 0);
});

test('T19 negative catalog cannot claim evidence candidacy without an implementation/test reference', () => {
  const bad = clone(vectors);
  bad.vectors[0].status = 'evidence-candidate';
  bad.vectors[0].implementation_refs = [];
  const verdict = validateNegativeCatalog(bad);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('need at least one implementation ref')));
});

test('T19 negative catalog cannot promote a candidate to covered without an exact execution ref', () => {
  const bad = clone(vectors);
  const candidate = bad.vectors.find((v) => v.status === 'evidence-candidate');
  assert.ok(candidate, 'fixture must contain at least one evidence candidate');
  candidate.status = 'covered';
  candidate.execution_refs = [];
  const verdict = validateNegativeCatalog(bad);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('covered vectors need at least one exact execution ref')));
});


test('T19 negative catalog rejects traversal-like implementation refs', () => {
  const bad = clone(vectors);
  const candidate = bad.vectors.find((v) => v.status === 'evidence-candidate');
  assert.ok(candidate);
  candidate.implementation_refs = ['test/../secrets.test.mjs::fake'];
  const verdict = validateNegativeCatalog(bad);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('may not traverse paths')));
});

test('T19 negative catalog rejects non-exact execution refs', () => {
  const bad = clone(vectors);
  const candidate = bad.vectors.find((v) => v.status === 'evidence-candidate');
  assert.ok(candidate);
  candidate.status = 'covered';
  candidate.execution_refs = ['gha:owner/repo@main:run:123'];
  const verdict = validateNegativeCatalog(bad);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('exact gha head/run')));
});

test('T19 negative catalog rejects duplicated vector identities', () => {
  const bad = clone(vectors);
  bad.vectors[1].id = bad.vectors[0].id;
  const verdict = validateNegativeCatalog(bad);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('duplicate')));
});


test('T19 external evidence registry is provenance-valid and never self-certifies coverage', () => {
  const verdict = validateExternalEvidenceCandidates(externalCandidates, vectors);
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  const summary = summarizeExternalEvidenceCandidates(externalCandidates, vectors);
  assert.equal(summary.candidates, 5);
  assert.equal(summary.unique_vectors, 12);
  assert.equal(summary.direct_mappings, 10);
  assert.equal(summary.partial_mappings, 2);
  assert.equal(summary.exact_head_ci_success_candidates, 1);
  assert.equal(summary.nonterminal_ci_candidates, 4);
  assert.equal(summary.covered_vectors, 0);
});

test('T19 external evidence rejects mutable source refs instead of silently following a branch', () => {
  const bad = clone(externalCandidates);
  bad.candidates[0].source.commit = 'main';
  const verdict = validateExternalEvidenceCandidates(bad, vectors);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('exact 40-hex commit required')));
});

test('T19 external evidence rejects traversal-like test paths', () => {
  const bad = clone(externalCandidates);
  bad.candidates[0].tests[0].path = 'test/../secrets.test.mjs';
  const verdict = validateExternalEvidenceCandidates(bad, vectors);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('unsafe or non-test repo path')));
});

test('T19 external evidence rejects mappings to unknown negative-vector IDs', () => {
  const bad = clone(externalCandidates);
  bad.candidates[0].vector_mappings[0].vector_id = 'NEG-NOT-REAL-99';
  const verdict = validateExternalEvidenceCandidates(bad, vectors);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('unknown negative vector')));
});

test('T19 external evidence cannot mark itself covered or certified', () => {
  const bad = clone(externalCandidates);
  bad.candidates[0].state = 'covered';
  bad.candidates[0].certification = true;
  const verdict = validateExternalEvidenceCandidates(bad, vectors);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('must remain external-candidate')));
  assert.ok(verdict.errors.some((x) => x.includes('cannot self-certify')));
});

test('T19 external evidence preserves nonterminal CI instead of turning it into success', () => {
  const bad = clone(externalCandidates);
  const candidate = bad.candidates.find((x) => x.ci.status !== 'completed');
  assert.ok(candidate);
  candidate.ci.conclusion = 'success';
  const verdict = validateExternalEvidenceCandidates(bad, vectors);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('nonterminal CI must keep conclusion=null')));
});


test('T19 legacy oracle import exposes all 17 pinned real repos only as non-certifying source candidates', () => {
  const projection = projectLegacyOracleCandidates(legacyOracle);
  assert.deepEqual(projection.errors, []);
  assert.equal(projection.ok, true);
  const summary = summarizeLegacyOracleProjection(projection);
  assert.equal(summary.candidates, 17);
  assert.equal(summary.excluded, 0);
  assert.equal(summary.certification_eligible, 0);
  assert.equal(summary.license_review_pending, 17);
  assert.deepEqual(summary.adapters, {
    'java-spring': 3,
    'ruby-rails': 3,
    'python-fastapi': 4,
    'typescript-express': 3,
    'javascript-express': 4,
  });
});

test('T19 legacy oracle import rejects mutable refs instead of treating a branch as a pinned corpus source', () => {
  const bad = clone(legacyOracle);
  bad.adapters['java-spring'][0].ref = 'main';
  const projection = projectLegacyOracleCandidates(bad);
  assert.equal(projection.ok, false);
  assert.ok(projection.errors.some((x) => x.includes('exact 40-hex commit required')));
});

test('T19 legacy oracle import rejects traversal-like subpaths', () => {
  const bad = clone(legacyOracle);
  bad.adapters['python-fastapi'][0].path = '../server';
  const projection = projectLegacyOracleCandidates(bad);
  assert.equal(projection.ok, false);
  assert.ok(projection.errors.some((x) => x.includes('unsafe repo-relative path')));
});

test('T19 legacy oracle import never upgrades a source candidate into a golden or certification claim', () => {
  const projection = projectLegacyOracleCandidates(legacyOracle);
  assert.equal(projection.ok, true);
  for (const candidate of projection.candidates) {
    assert.equal(candidate.admission_state, 'needs-license-review');
    assert.equal(candidate.certification_eligible, false);
    assert.deepEqual(candidate.missing_requirements, ['license-review', 'independent-golden-review']);
    assert.equal(Object.hasOwn(candidate, 'golden'), false);
  }
});
