import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCorpusManifest, summarizeCorpus } from '../corpus-next/corpus.mjs';
import { projectLegacyOracleCandidates, summarizeLegacyOracleProjection } from '../corpus-next/legacy-oracle-import.mjs';
import { validateLicenseObservations, summarizeLicenseObservations } from '../corpus-next/license-observations.mjs';
import { validateSourceGoldens, summarizeSourceGoldens } from '../corpus-next/source-goldens.mjs';
import { validateNegativeCatalog, coverageSummary } from './catalog.mjs';
import { validateExternalEvidenceCandidates, summarizeExternalEvidenceCandidates } from './external-candidates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'corpus-next', 'manifest.json'), 'utf8'));
const legacyOracle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'oracle-manifest.json'), 'utf8'));
const licenseObservations = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'corpus-next', 'license-observations.json'), 'utf8'));
const sourceGoldens = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'corpus-next', 'source-goldens.json'), 'utf8'));
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
  assert.equal(summary.manual_goldens, 5);
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
  assert.equal(summary.evidence_candidates, 11);
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
  assert.equal(summary.candidates, 7);
  assert.equal(summary.unique_vectors, 14);
  assert.equal(summary.direct_mappings, 12);
  assert.equal(summary.partial_mappings, 4);
  assert.equal(summary.exact_head_ci_success_candidates, 7);
  assert.equal(summary.nonterminal_ci_candidates, 0);
  assert.equal(summary.job_observed_candidates, 1);
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
  const candidate = bad.candidates[0];
  candidate.ci.status = 'queued';
  candidate.ci.conclusion = 'success';
  const verdict = validateExternalEvidenceCandidates(bad, vectors);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('nonterminal CI must keep conclusion=null')));
});

test('T19 external evidence rejects CI observations bound to a different head than the candidate source', () => {
  const bad = clone(externalCandidates);
  bad.candidates[0].ci.head_sha = '0'.repeat(40);
  const verdict = validateExternalEvidenceCandidates(bad, vectors);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('must equal source.commit')));
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

test('T19 license observations cover all 17 pinned legacy candidates without granting certification', () => {
  const projection = projectLegacyOracleCandidates(legacyOracle);
  assert.equal(projection.ok, true);
  const verdict = validateLicenseObservations(licenseObservations, projection);
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  const summary = summarizeLicenseObservations(licenseObservations, projection);
  assert.equal(summary.entries, 17);
  assert.equal(summary.pinned_root_license_files, 12);
  assert.equal(summary.no_pinned_root_license_file_observed, 5);
  assert.equal(summary.current_repo_spdx_hints, 12);
  assert.equal(summary.certification_eligible, 0);
});

test('T19 license observations reject a commit that differs from the pinned corpus source', () => {
  const projection = projectLegacyOracleCandidates(legacyOracle);
  const bad = clone(licenseObservations);
  bad.entries[0].commit = '0'.repeat(40);
  const verdict = validateLicenseObservations(bad, projection);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('must match legacy projection source')));
});

test('T19 license observations cannot self-promote a repository into certification', () => {
  const projection = projectLegacyOracleCandidates(legacyOracle);
  const bad = clone(licenseObservations);
  bad.entries[0].review_state = 'approved';
  bad.entries[0].certification_eligible = true;
  const verdict = validateLicenseObservations(bad, projection);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('must remain observation-only')));
  assert.ok(verdict.errors.some((x) => x.includes('cannot self-certify')));
});

test('T19 license observation status must agree with the presence of a pinned root license blob', () => {
  const projection = projectLegacyOracleCandidates(legacyOracle);
  const bad = clone(licenseObservations);
  const observed = bad.entries.find((x) => x.root_license_file !== null);
  assert.ok(observed);
  observed.observation = 'no-pinned-root-license-file-observed';
  const verdict = validateLicenseObservations(bad, projection);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('license file requires pinned-root-license-file-observed')));
});

test('T19 source-backed manual goldens cover five fixtures with 24 selected facts and no completeness claim', () => {
  const verdict = validateSourceGoldens(sourceGoldens, corpus);
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  const summary = summarizeSourceGoldens(sourceGoldens, corpus);
  assert.equal(summary.goldens, 5);
  assert.equal(summary.assertions, 24);
  assert.equal(summary.completeness_claims, 0);
  assert.equal(summary.certification_eligible, 0);
});

test('T19 source golden rejects a commit that differs from the corpus source', () => {
  const bad = clone(sourceGoldens);
  bad.goldens[0].source.commit = '0'.repeat(40);
  const verdict = validateSourceGoldens(bad, corpus);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('must match corpus entry')));
});

test('T19 source golden rejects assertion evidence that escapes its fixture root', () => {
  const bad = clone(sourceGoldens);
  bad.goldens[0].assertions[0].source_ref.path = 'test/fixtures/python-fastapi/backend/app/models.py';
  const verdict = validateSourceGoldens(bad, corpus);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('must stay inside corpus fixture root')));
});

test('T19 source golden cannot claim completeness or self-certification', () => {
  const bad = clone(sourceGoldens);
  bad.goldens[0].completeness_claim = true;
  bad.goldens[0].certification_eligible = true;
  const verdict = validateSourceGoldens(bad, corpus);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('completeness_claim')));
  assert.ok(verdict.errors.some((x) => x.includes('cannot self-certify')));
});


test('T19 external evidence job observations are bound to the candidate exact-head run', () => {
  const bad = clone(externalCandidates);
  const candidate = bad.candidates.find((x) => x.job_observations.length > 0);
  assert.ok(candidate);
  candidate.job_observations[0].run_id += 1;
  const verdict = validateExternalEvidenceCandidates(bad, vectors);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('must match candidate ci.run_id')));
});

test('T19 external evidence refuses job-level observations on nonterminal CI', () => {
  const bad = clone(externalCandidates);
  const target = bad.candidates[0];
  target.ci.status = 'queued';
  target.ci.conclusion = null;
  target.job_observations = [{
    run_id: target.ci.run_id,
    job_id: 1,
    job_name: 'untrusted-nonterminal-job',
    subtests: ['not a terminal observation'],
  }];
  const verdict = validateExternalEvidenceCandidates(bad, vectors);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((x) => x.includes('require completed-success candidate CI')));
});
