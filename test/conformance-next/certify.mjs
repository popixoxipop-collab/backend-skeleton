import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createHash, verify as verifySignature } from 'node:crypto';
import {
  compareObservedInventory,
  evaluateMutationGate,
  validateCorpusManifest,
  validateNegativeVectorCatalog,
  verifyEvidencePack,
} from './harness.mjs';
import { runMutationCampaign } from './mutation-runner.mjs';
import { runProductMutationCampaign } from './product-mutation-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_MUTATION_CATALOG = JSON.parse(fs.readFileSync(path.join(HERE, 'mutations.json'), 'utf8'));
const PRODUCT_MUTATION_CATALOG = JSON.parse(fs.readFileSync(path.join(HERE, 'product-mutations.json'), 'utf8'));
const REFERENCE_CORPUS = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'corpus-next', 'corpus-manifest.json'), 'utf8'));
const COMMITTED_NEGATIVE_VECTORS = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'corpus-next', 'negative-vectors.json'), 'utf8'));
const COMMITTED_HOLDOUT_ATTESTORS = JSON.parse(fs.readFileSync(path.join(HERE, 'holdout-attestors.json'), 'utf8'));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function gitObjectTypeAt(repoRoot, sourceCommit) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '')) return null;
  const run = spawnSync('git', ['-C', repoRoot, 'cat-file', '-t', sourceCommit], {
    encoding: 'utf8', timeout: 10_000,
  });
  return run.status === 0 ? (run.stdout ?? '').trim() : null;
}

function gitObjectType(sourceCommit) {
  return gitObjectTypeAt(REPO_ROOT, sourceCommit);
}

function trackedFileAtCommit(repoRoot, sourceCommit, relPath) {
  if (gitObjectTypeAt(repoRoot, sourceCommit) !== 'commit') return null;
  const run = spawnSync('git', ['-C', repoRoot, 'show', `${sourceCommit}:${relPath}`], {
    encoding: null, timeout: 10_000, maxBuffer: 32 * 1024 * 1024,
  });
  return run.status === 0 ? run.stdout : null;
}

function trackedFileDigestAtCommit(sourceCommit, relPath) {
  const bytes = trackedFileAtCommit(REPO_ROOT, sourceCommit, relPath);
  if (bytes === null) return null;
  return createHash('sha256').update(bytes).digest('hex');
}

export function loadMutationCatalogsAtCommit(sourceCommit, { repoRoot = REPO_ROOT } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '') || gitObjectTypeAt(repoRoot, sourceCommit) !== 'commit') {
    throw new Error('mutation catalogs require a canonical Git commit object');
  }
  const readJson = (relPath) => {
    const bytes = trackedFileAtCommit(repoRoot, sourceCommit, relPath);
    if (bytes === null) throw new Error(`cannot read ${relPath} from certified commit ${sourceCommit}`);
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error(`invalid JSON in ${relPath} at certified commit ${sourceCommit}`); }
  };
  return {
    harness: readJson('test/conformance-next/mutations.json'),
    product: readJson('test/conformance-next/product-mutations.json'),
  };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function ratio(n, d) {
  return d === 0 ? null : n / d;
}

function catalogDigest(catalog) {
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
}

function validateMutationReportAgainstCatalog(report, { contract, catalog, label, source_commit }) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { errors: [`${label}: report must be an object`], mutants: [] };
  if (report.contract !== contract) errors.push(`${label}: contract must be ${contract}`);
  if (report.source_commit !== source_commit) errors.push(`${label}: source_commit ${String(report.source_commit)} does not match certified release commit ${source_commit}`);
  const expectedCatalogDigest = catalogDigest(catalog);
  if (report.catalog_sha256 !== expectedCatalogDigest) errors.push(`${label}: catalog_sha256 ${String(report.catalog_sha256)} does not match committed catalog ${expectedCatalogDigest}`);
  if (!['harness','product'].includes(label)) {
    errors.push(`${label}: unsupported mutation report label`);
  } else if (report.source_materialization !== 'git-archive') {
    errors.push(`${label}: source_materialization must be git-archive`);
  }
  if (label === 'product') {
    if (report.dependency_install?.mode !== 'npm-ci-ignore-scripts') errors.push('product: dependency_install.mode must be npm-ci-ignore-scripts');
    const reportedLockDigest = report.dependency_install?.package_lock_sha256 ?? null;
    if (!/^[a-f0-9]{64}$/i.test(reportedLockDigest ?? '')) {
      errors.push('product: dependency_install.package_lock_sha256 must be a sha256 digest');
    } else {
      const trackedLockDigest = trackedFileDigestAtCommit(source_commit, 'package-lock.json');
      if (!trackedLockDigest) errors.push(`product: cannot read package-lock.json from certified commit ${source_commit}`);
      else if (reportedLockDigest !== trackedLockDigest) errors.push(`product: dependency package-lock digest ${reportedLockDigest} does not match certified commit ${trackedLockDigest}`);
    }
  }
  if (!Array.isArray(report.mutants)) return { errors: [...errors, `${label}: mutants must be an array`], mutants: [] };
  const expected = new Map(catalog.mutants.map((m) => [m.id, m]));
  const seen = new Set();
  const mutants = [];
  for (const result of report.mutants) {
    if (!result || !nonEmptyString(result.id) || !['killed', 'survived', 'equivalent'].includes(result.status)) {
      errors.push(`${label}: every mutant result requires {id,status:killed|survived|equivalent}`);
      continue;
    }
    if (seen.has(result.id)) { errors.push(`${label}: duplicate mutant result ${result.id}`); continue; }
    seen.add(result.id);
    const planned = expected.get(result.id);
    if (!planned) { errors.push(`${label}: unknown mutant id ${result.id}`); continue; }
    if (result.critical !== planned.critical) errors.push(`${label}: critical flag mismatch for ${result.id}`);
    if (result.status === 'equivalent' && planned.equivalent_allowed !== true) {
      errors.push(`${label}: equivalent result is not approved by the committed mutation catalog: ${result.id}`);
    }
    mutants.push({ id: `${label}:${result.id}`, critical: planned.critical, status: result.status });
  }
  for (const id of expected.keys()) if (!seen.has(id)) errors.push(`${label}: missing mutant result ${id}`);
  return { errors, mutants };
}

export function evaluateBoundMutationBundle(bundle, { source_commit = null } = {}) {
  const reasons = [];
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || bundle.contract !== 'sbf.qa-mutation-bundle/1') {
    return { pass: false, reasons: ['mutation bundle contract must be sbf.qa-mutation-bundle/1'], gate: null };
  }
  let catalogs;
  try { catalogs = loadMutationCatalogsAtCommit(source_commit); }
  catch (err) { return { pass: false, reasons: [`mutation catalogs: ${err.message}`], gate: null }; }
  if (bundle.source_commit !== source_commit) reasons.push(`mutation bundle: source_commit ${String(bundle.source_commit)} does not match certified release commit ${source_commit}`);
  const harness = validateMutationReportAgainstCatalog(bundle.harness, {
    contract: 'sbf.qa-mutation-report/1', catalog: catalogs.harness, label: 'harness', source_commit,
  });
  const product = validateMutationReportAgainstCatalog(bundle.product, {
    contract: 'sbf.qa-product-mutation-report/1', catalog: catalogs.product, label: 'product', source_commit,
  });
  reasons.push(...harness.errors, ...product.errors);
  let gate = null;
  if (reasons.length === 0) {
    gate = evaluateMutationGate({ mutants: [...harness.mutants, ...product.mutants] });
    if (!gate.pass) reasons.push(...gate.reasons);
  }
  return {
    pass: reasons.length === 0 && gate?.pass === true,
    reasons,
    gate,
    expected: { harness: catalogs.harness.mutants.length, product: catalogs.product.mutants.length },
    observed: { harness: harness.mutants.length, product: product.mutants.length },
  };
}

export function injectHoldoutManifest(corpus, holdout) {
  if (!holdout || typeof holdout !== 'object' || Array.isArray(holdout)) {
    return { ok: false, errors: ['holdout manifest must be an object'], corpus: null };
  }
  if (holdout.contract !== 'sbf.qa-holdout/1') {
    return { ok: false, errors: ['holdout contract must be sbf.qa-holdout/1'], corpus: null };
  }
  if (!Array.isArray(holdout.entries) || holdout.entries.length === 0) {
    return { ok: false, errors: ['holdout entries must be a non-empty array'], corpus: null };
  }
  if (!corpus || typeof corpus !== 'object' || Array.isArray(corpus)) {
    return { ok: false, errors: ['reference corpus must be an object'], corpus: null };
  }
  if (Array.isArray(corpus.holdout_entries) && corpus.holdout_entries.length > 0) {
    return { ok: false, errors: ['reference corpus already contains holdout entries; external injection refuses to merge two holdout sources'], corpus: null };
  }
  const merged = structuredClone(corpus);
  merged.holdout_entries = structuredClone(holdout.entries);
  const validation = validateCorpusManifest(merged);
  return { ok: validation.ok, errors: validation.errors, corpus: validation.ok ? merged : null };
}

export function validateReferenceCorpusBinding(corpus) {
  if (!corpus || corpus.contract !== REFERENCE_CORPUS.contract) return { pass: false, reasons: ['reference corpus contract does not match the committed manifest'] };
  if (!isDeepStrictEqual(corpus.entries, REFERENCE_CORPUS.entries)) {
    return { pass: false, reasons: ['reference corpus entries do not exactly match the committed manifest'] };
  }
  return { pass: true, reasons: [] };
}

export function validateNegativeVectorCatalogBinding(catalog) {
  if (!isDeepStrictEqual(catalog, COMMITTED_NEGATIVE_VECTORS)) {
    return { pass: false, reasons: ['negative-vector catalog does not exactly match the committed 79-vector manifest'] };
  }
  return { pass: true, reasons: [] };
}

function corpusEntrySource(entry) {
  return { owner: entry.owner, repo: entry.repo, ref: entry.ref, path: entry.path ?? null };
}

export function corpusEntrySourceMatches(actual, entry) {
  return isDeepStrictEqual(actual, corpusEntrySource(entry));
}

function corpusEntryIdentity(entry) {
  return {
    id: entry.id,
    adapter: entry.adapter,
    owner: entry.owner,
    repo: entry.repo,
    ref: entry.ref,
    path: entry.path ?? null,
    terms: Array.isArray(entry.terms) ? [...entry.terms] : [],
    license_spdx: entry.license_spdx,
    source_family: entry.source_family,
    golden_basis: entry.golden_basis,
    expected_limitations: Array.isArray(entry.expected_limitations) ? [...entry.expected_limitations] : [],
  };
}

export function corpusEntryIdentityMatches(actual, entry) {
  return isDeepStrictEqual(actual, corpusEntryIdentity(entry));
}

function normalizeGoldInventory(items) {
  if (!Array.isArray(items) || items.some((item) => !nonEmptyString(item))) return null;
  return [...items].sort();
}

function normalizeObservedInventory(items) {
  if (!Array.isArray(items)) return null;
  const normalized = [];
  for (const item of items) {
    if (!item || !nonEmptyString(item.id) || !['verified', 'unknown'].includes(item.status)) return null;
    normalized.push({ id: item.id, status: item.status });
  }
  normalized.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.status < b.status ? -1 : a.status > b.status ? 1 : 0);
  return normalized;
}

function inventoryStructuresMatch(leftGold, leftObserved, rightGold, rightObserved) {
  const lg = normalizeGoldInventory(leftGold);
  const rg = normalizeGoldInventory(rightGold);
  const lo = normalizeObservedInventory(leftObserved);
  const ro = normalizeObservedInventory(rightObserved);
  return lg !== null && rg !== null && lo !== null && ro !== null &&
    isDeepStrictEqual(lg, rg) && isDeepStrictEqual(lo, ro);
}

export function holdoutAttestationPayload(doc) {
  return Buffer.from(JSON.stringify({
    contract: doc?.contract ?? null,
    entry_id: doc?.entry_id ?? null,
    corpus_entry: doc?.corpus_entry ?? null,
    source: doc?.source ?? null,
    run: doc?.run ?? null,
    release_source_commit: doc?.release_source_commit ?? null,
    attestor_key_id: doc?.attestation?.key_id ?? null,
    gold: doc?.gold ?? null,
    observed: doc?.observed ?? null,
  }), 'utf8');
}

export function validateHoldoutAttestorRegistry(registry) {
  const errors = [];
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return { ok: false, errors: ['holdout attestor registry must be an object'] };
  if (registry.contract !== 'sbf.qa-holdout-attestors/1') errors.push('holdout attestor registry contract must be sbf.qa-holdout-attestors/1');
  if (!Array.isArray(registry.keys)) errors.push('holdout attestor registry keys must be an array');
  if (errors.length) return { ok: false, errors };
  const ids = new Set();
  for (const [i, key] of registry.keys.entries()) {
    const at = `keys[${i}]`;
    if (!nonEmptyString(key?.id)) errors.push(`${at}.id must be non-empty`);
    else if (ids.has(key.id)) errors.push(`duplicate holdout attestor id: ${key.id}`);
    else ids.add(key.id);
    if (key?.alg !== 'ed25519') errors.push(`${at}.alg must be ed25519`);
    if (key?.purpose !== 't19-private-holdout') errors.push(`${at}.purpose must be t19-private-holdout`);
    if (key?.status !== 'active') errors.push(`${at}.status must be active`);
    if (!nonEmptyString(key?.public_key_pem)) errors.push(`${at}.public_key_pem must be non-empty`);
  }
  return { ok: errors.length === 0, errors };
}

export function verifyHoldoutAttestationWithRegistry(doc, registry = COMMITTED_HOLDOUT_ATTESTORS) {
  const validation = validateHoldoutAttestorRegistry(registry);
  if (!validation.ok) return { ok: false, reason: validation.errors.join('; ') };
  const attestation = doc?.attestation;
  if (!attestation || attestation.alg !== 'ed25519' || !nonEmptyString(attestation.key_id) || !nonEmptyString(attestation.signature_b64)) {
    return { ok: false, reason: 'attestation requires {alg:ed25519,key_id,signature_b64}' };
  }
  const trusted = registry.keys.find((key) => key.id === attestation.key_id);
  if (!trusted) return { ok: false, reason: `attestor key ${attestation.key_id} is not trusted by committed registry` };
  try {
    const signature = Buffer.from(attestation.signature_b64, 'base64');
    const ok = signature.length > 0 && verifySignature(null, holdoutAttestationPayload(doc), trusted.public_key_pem, signature);
    return ok ? { ok: true, reason: null } : { ok: false, reason: 'signature verification failed' };
  } catch {
    return { ok: false, reason: 'signature verification failed' };
  }
}

export function evaluateHoldoutCoverageGate({ corpus, differential, evidence, artifact_root, source_commit = null, holdout_attestors = COMMITTED_HOLDOUT_ATTESTORS }) {
  const entries = [...(corpus?.entries ?? []), ...(corpus?.holdout_entries ?? [])];
  const results = Array.isArray(differential?.entry_results) ? differential.entry_results : [];
  const reasons = [];
  const artifactMap = new Map((evidence?.artifacts ?? []).map((item) => [item.path, item]));
  const root = artifact_root ? path.resolve(artifact_root) : null;
  const holdoutIds = new Set((corpus?.holdout_entries ?? []).map((entry) => entry.id));
  const attestorRegistryValidation = validateHoldoutAttestorRegistry(holdout_attestors);
  if (holdoutIds.size > 0 && !attestorRegistryValidation.ok) {
    reasons.push(...attestorRegistryValidation.errors.map((x) => `holdout attestor registry: ${x}`));
  }

  for (const entry of entries) {
    const matches = results.filter((item) => item?.entry_id === entry.id);
    if (matches.length !== 1) {
      reasons.push(`corpus entry ${entry.id} requires exactly one differential entry result`);
      continue;
    }
    const result = matches[0];
    if (!corpusEntrySourceMatches(result.source, entry)) {
      reasons.push(`corpus entry ${entry.id} differential source identity does not match its pinned repository`);
      continue;
    }
    if (!Array.isArray(result.gold) || result.gold.length === 0 || !Array.isArray(result.observed)) {
      reasons.push(`corpus entry ${entry.id} requires non-empty expected inventory and observed inventory`);
      continue;
    }
    const perEntry = evaluateDifferentialGate({ gold: result.gold, observed: result.observed });
    if (!perEntry.pass) {
      reasons.push(`corpus entry ${entry.id} differential failed: ${perEntry.reasons.join('; ')}`);
      continue;
    }
    if (!nonEmptyString(result.evidence_artifact) || !artifactMap.has(result.evidence_artifact)) {
      reasons.push(`corpus entry ${entry.id} is not bound to a declared evidence artifact`);
      continue;
    }
    if (!root) {
      reasons.push(`corpus entry ${entry.id} requires artifact_root for provenance verification`);
      continue;
    }
    const artifactPath = path.resolve(root, result.evidence_artifact);
    if (artifactPath !== root && !artifactPath.startsWith(root + path.sep)) {
      reasons.push(`corpus entry ${entry.id} evidence artifact escapes artifact_root`);
      continue;
    }
    let doc;
    try { doc = JSON.parse(fs.readFileSync(artifactPath, 'utf8')); }
    catch { reasons.push(`corpus entry ${entry.id} evidence artifact is missing or invalid JSON`); continue; }
    if (doc?.contract !== 'sbf.qa-corpus-entry-result/1' || doc?.entry_id !== entry.id) {
      reasons.push(`corpus entry ${entry.id} evidence artifact has the wrong contract/entry id`);
      continue;
    }
    if (!corpusEntrySourceMatches(doc.source, entry)) {
      reasons.push(`corpus entry ${entry.id} evidence artifact is not bound to the pinned repository/ref`);
      continue;
    }
    if (!corpusEntryIdentityMatches(doc.corpus_entry, entry)) {
      reasons.push(`corpus entry ${entry.id} evidence artifact is not bound to the complete corpus entry identity`);
      continue;
    }
    const run = doc.run;
    if (!run || run.kind !== 'controlled-checkout' || run.checkout_commit !== entry.ref ||
        !nonEmptyString(run.runner_id) || !nonEmptyString(run.run_id) ||
        !nonEmptyString(run.command) || run.exit_code !== 0) {
      reasons.push(`corpus entry ${entry.id} evidence artifact lacks successful controlled-checkout provenance`);
      continue;
    }
    if (holdoutIds.has(entry.id)) {
      if (doc.release_source_commit !== source_commit) {
        reasons.push(`corpus entry ${entry.id} signed holdout release_source_commit ${String(doc.release_source_commit)} does not match certified release commit ${source_commit}`);
        continue;
      }
      const attestationCheck = verifyHoldoutAttestationWithRegistry(doc, holdout_attestors);
      if (!attestationCheck.ok) {
        reasons.push(`corpus entry ${entry.id} private holdout attestation rejected: ${attestationCheck.reason}`);
        continue;
      }
    }
    if (!inventoryStructuresMatch(doc.gold, doc.observed, result.gold, result.observed)) {
      reasons.push(`corpus entry ${entry.id} differential inventory does not match the independently recorded run artifact`);
      continue;
    }
    const artifactDifferential = evaluateDifferentialGate({ gold: doc.gold, observed: doc.observed });
    if (!artifactDifferential.pass) {
      reasons.push(`corpus entry ${entry.id} controlled-run artifact differential failed: ${artifactDifferential.reasons.join("; ")}`);
    }
  }
  const expectedIds = new Set(entries.map((entry) => entry.id));
  for (const result of results) {
    if (!expectedIds.has(result?.entry_id)) reasons.push(`unexpected differential entry result ${String(result?.entry_id)}`);
  }
  return {
    pass: reasons.length === 0,
    required: entries.length,
    covered: entries.length - new Set(reasons.map((x) => entries.find((e) => x.includes(e.id))?.id).filter(Boolean)).size,
    reasons,
  };
}

export function evaluateDifferentialGate({ gold, observed, min_precision = 0.995, min_recall = 0.95 }) {
  if (!(min_precision >= 0 && min_precision <= 1) || !(min_recall >= 0 && min_recall <= 1)) {
    throw new RangeError('precision/recall thresholds must be between 0 and 1');
  }
  const metrics = compareObservedInventory({ gold, observed });
  const reasons = [];
  if (metrics.gold_total === 0) reasons.push('gold denominator is empty');
  if (metrics.precision === null) reasons.push('precision is undefined because there are no verified predictions');
  else if (metrics.precision < min_precision) reasons.push(`precision ${metrics.precision.toFixed(4)} is below ${min_precision.toFixed(4)}`);
  if (metrics.recall === null) reasons.push('recall is undefined because the gold denominator is empty');
  else if (metrics.recall < min_recall) reasons.push(`recall ${metrics.recall.toFixed(4)} is below ${min_recall.toFixed(4)}`);
  return { pass: reasons.length === 0, min_precision, min_recall, metrics, reasons };
}

export function evaluateNegativeVectorRun({ catalog, results }) {
  const validation = validateNegativeVectorCatalog(catalog);
  if (!validation.ok) return { pass: false, reasons: validation.errors, critical_failures: [], score: null };
  if (!Array.isArray(results)) throw new TypeError('negative vector results must be an array');
  const known = new Map(catalog.vectors.map((v) => [v.id, v]));
  const seen = new Set();
  const errors = [];
  const critical_failures = [];
  let executable = 0;
  let caught = 0;
  let equivalent = 0;

  for (const result of results) {
    if (!result || !nonEmptyString(result.id) || !['caught', 'missed', 'blocked', 'equivalent'].includes(result.status)) {
      errors.push('each negative result requires {id,status:caught|missed|blocked|equivalent}');
      continue;
    }
    if (seen.has(result.id)) { errors.push(`duplicate negative result: ${result.id}`); continue; }
    seen.add(result.id);
    const vector = known.get(result.id);
    if (!vector) { errors.push(`unknown negative vector result: ${result.id}`); continue; }
    if (vector.critical && result.status !== 'caught') critical_failures.push(result.id);
    if (result.status === 'equivalent') {
      if (vector.equivalent_allowed !== true) {
        errors.push(`equivalent result is not approved by the committed catalog: ${result.id}`);
        executable++;
        continue;
      }
      if (!vector.critical) { equivalent++; continue; }
    }
    executable++;
    if (result.status === 'caught') caught++;
  }
  for (const vector of catalog.vectors) {
    if (!seen.has(vector.id)) {
      if (vector.critical) critical_failures.push(vector.id);
      errors.push(`missing negative vector result: ${vector.id}`);
    }
  }
  const score = ratio(caught, executable);
  if (score !== null && score < 1) errors.push(`negative vector executable coverage ${score.toFixed(4)} is below required 1.0000`);
  return {
    pass: errors.length === 0 && critical_failures.length === 0 && score === 1,
    reasons: errors,
    critical_failures: [...new Set(critical_failures)],
    executable,
    caught,
    equivalent_excluded: equivalent,
    score,
  };
}

function safeArtifactPath(root, rel) {
  if (!nonEmptyString(rel) || path.isAbsolute(rel) || rel.includes('\\') || rel.split('/').includes('..')) {
    throw new Error(`unsafe artifact path: ${String(rel)}`);
  }
  const base = fs.realpathSync(root);
  const candidate = path.resolve(base, rel);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error(`artifact path is a symlink: ${rel}`);
  if (!stat.isFile()) throw new Error(`artifact path is not a regular file: ${rel}`);
  const real = fs.realpathSync(candidate);
  if (real !== base && !real.startsWith(base + path.sep)) throw new Error(`artifact escapes root: ${rel}`);
  return real;
}

export function verifyEvidencePackFromDisk(pack, { artifact_root }) {
  if (!nonEmptyString(artifact_root)) throw new TypeError('artifact_root is required');
  if (!Array.isArray(pack?.artifacts)) return verifyEvidencePack(pack);
  const bytes = new Map();
  const errors = [];
  for (const artifact of pack.artifacts) {
    try {
      const file = safeArtifactPath(artifact_root, artifact?.path);
      bytes.set(artifact.path, fs.readFileSync(file));
    } catch (err) {
      errors.push(err.message);
    }
  }
  const base = verifyEvidencePack(pack, { artifactBytes: bytes });
  return { ok: errors.length === 0 && base.ok, errors: [...errors, ...base.errors] };
}

function normalizedMutationStatuses(report) {
  return (report?.mutants ?? [])
    .map(({ id, critical, status }) => ({ id, critical, status }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function compareSubmittedMutationBundleToExecution(bundle, execution) {
  const reasons = [];
  if (!bundle?.harness || !bundle?.product) return ['submitted mutation bundle is missing harness/product reports'];
  if (!isDeepStrictEqual(normalizedMutationStatuses(bundle.harness), execution.harness.results)) {
    reasons.push('submitted harness mutation results do not match direct release execution');
  }
  if (!isDeepStrictEqual(normalizedMutationStatuses(bundle.product), execution.product.results)) {
    reasons.push('submitted product mutation results do not match direct release execution');
  }
  return reasons;
}

export function executeReleaseMutationCampaigns({ source_commit }) {
  if (!/^[a-f0-9]{40}$/.test(source_commit ?? '') || gitObjectType(source_commit) !== 'commit') {
    return { required: true, executed: false, pass: false, reasons: ['release mutation execution requires a canonical Git commit object'] };
  }
  try {
    const catalogs = loadMutationCatalogsAtCommit(source_commit);
    const harness = runMutationCampaign({ repoRoot: REPO_ROOT, catalog: catalogs.harness, sourceCommit: source_commit });
    const product = runProductMutationCampaign({ repoRoot: REPO_ROOT, catalog: catalogs.product, sourceCommit: source_commit });
    const result = {
      required: true,
      executed: true,
      pass: harness.pass === true && product.pass === true,
      source_commit,
      harness: {
        pass: harness.pass === true,
        results: normalizedMutationStatuses(harness),
      },
      product: {
        pass: product.pass === true,
        results: normalizedMutationStatuses(product),
        dependency_install: product.dependency_install ?? null,
      },
      reasons: [],
    };
    if (!result.harness.pass) result.reasons.push('direct harness mutation campaign did not pass');
    if (!result.product.pass) result.reasons.push('direct product mutation campaign did not pass');
    return result;
  } catch (err) {
    return { required: true, executed: true, pass: false, source_commit, reasons: [`direct mutation execution failed: ${err.message}`] };
  }
}

export function assembleCertification(input, { artifact_root = null, require_holdout = true, source_commit = null } = {}) {
  const reasons = [];
  if (!/^[a-f0-9]{40}$/.test(source_commit ?? '')) reasons.push('release: --source-commit must supply the canonical lowercase 40-hex commit being certified');
  else if (gitObjectType(source_commit) !== 'commit') reasons.push('release: --source-commit must resolve to a Git commit object');
  else if (input?.evidence?.source_commit !== source_commit) reasons.push(`evidence: source_commit ${String(input?.evidence?.source_commit)} does not match certified release commit ${source_commit}`);
  const corpus = validateCorpusManifest(input?.corpus);
  const vectors = validateNegativeVectorCatalog(input?.negative_vectors);
  const corpusBinding = validateReferenceCorpusBinding(input?.corpus);
  const vectorBinding = validateNegativeVectorCatalogBinding(input?.negative_vectors);
  if (!corpus.ok) reasons.push(...corpus.errors.map((x) => `corpus: ${x}`));
  if (corpus.ok && !corpusBinding.pass) reasons.push(...corpusBinding.reasons.map((x) => `corpus: ${x}`));
  if (!vectors.ok) reasons.push(...vectors.errors.map((x) => `vectors: ${x}`));
  if (vectors.ok && !vectorBinding.pass) reasons.push(...vectorBinding.reasons.map((x) => `vectors: ${x}`));

  let differential = null;
  if (input?.differential) {
    if (input.differential.source_commit !== source_commit) reasons.push(`differential: source_commit ${String(input.differential.source_commit)} does not match certified release commit ${source_commit}`);
    differential = evaluateDifferentialGate(input.differential);
    if (!differential.pass) reasons.push(...differential.reasons.map((x) => `differential: ${x}`));
  }
  let negative = null;
  if (input?.negative_run) {
    if (input.negative_run.source_commit !== source_commit) reasons.push(`negative: source_commit ${String(input.negative_run.source_commit)} does not match certified release commit ${source_commit}`);
    negative = evaluateNegativeVectorRun({ catalog: input.negative_vectors, results: input.negative_run.results });
    if (!negative.pass) reasons.push(...negative.reasons.map((x) => `negative: ${x}`), ...negative.critical_failures.map((x) => `negative critical failure: ${x}`));
  }
  let mutation = null;
  if (input?.mutation) {
    mutation = evaluateBoundMutationBundle(input.mutation, { source_commit });
    if (!mutation.pass) reasons.push(...mutation.reasons.map((x) => `mutation: ${x}`));
  }
  let evidence = null;
  if (input?.evidence) {
    const hasArtifacts = Array.isArray(input.evidence.artifacts) && input.evidence.artifacts.length > 0;
    evidence = artifact_root ? verifyEvidencePackFromDisk(input.evidence, { artifact_root }) : verifyEvidencePack(input.evidence);
    if (hasArtifacts && !artifact_root) reasons.push('evidence: artifact_root is required when artifact evidence is declared');
    if (!evidence.ok) reasons.push(...evidence.errors.map((x) => `evidence: ${x}`));
    else if (input.evidence.verdict === 'fail') reasons.push('evidence: valid evidence records a failed product/conformance run');
  }

  let holdoutCoverage = null;
  if (corpus.ok) {
    holdoutCoverage = evaluateHoldoutCoverageGate({ corpus: input.corpus, differential: input.differential, evidence: input.evidence, artifact_root, source_commit });
    if (!holdoutCoverage.pass) reasons.push(...holdoutCoverage.reasons.map((x) => `corpus-evidence: ${x}`));
  }

  const requiredMissing = [];
  for (const name of ['differential', 'negative_run', 'mutation', 'evidence']) if (!input?.[name]) requiredMissing.push(name);
  if (requiredMissing.length) reasons.push(`missing required certification sections: ${requiredMissing.join(', ')}`);

  const releaseExecutionRequired = require_holdout && corpus.ok && corpus.stats.holdout_ready;
  let releaseMutationExecution = {
    required: releaseExecutionRequired,
    executed: false,
    pass: releaseExecutionRequired ? false : null,
    reasons: releaseExecutionRequired ? ['direct release mutation execution deferred until all preceding release gates pass'] : [],
  };
  if (releaseExecutionRequired && holdoutCoverage?.pass && requiredMissing.length === 0 && reasons.length === 0) {
    releaseMutationExecution = executeReleaseMutationCampaigns({ source_commit });
    if (!releaseMutationExecution.pass) {
      reasons.push(...releaseMutationExecution.reasons.map((x) => `release-mutation-execution: ${x}`));
    } else {
      const mismatches = compareSubmittedMutationBundleToExecution(input.mutation, releaseMutationExecution);
      if (mismatches.length) {
        releaseMutationExecution = { ...releaseMutationExecution, pass: false, reasons: mismatches };
        reasons.push(...mismatches.map((x) => `release-mutation-execution: ${x}`));
      }
    }
  }

  let verdict = reasons.length ? 'fail' : 'pass';
  if (require_holdout && corpus.ok && !corpus.stats.holdout_ready) {
    reasons.push('holdout corpus is empty; certification cannot be promoted beyond reference-corpus validation');
    if (verdict === 'pass') verdict = 'blocked';
  }
  if (input?.evidence?.verdict === 'blocked' && verdict === 'pass') verdict = 'blocked';

  return {
    contract: 'sbf.qa-certification-report/1',
    verdict,
    reasons,
    gates: { corpus, corpus_binding: corpusBinding, vectors, vector_binding: vectorBinding, differential, negative, mutation, evidence, corpus_entry_coverage: holdoutCoverage, release_mutation_execution: releaseMutationExecution },
  };
}

function parseArgs(argv) {
  const out = { artifact_root: null, require_holdout: true, holdout_manifest: null, input: null, source_commit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--artifact-root') { out.artifact_root = argv[++i] ?? null; continue; }
    if (argv[i] === '--holdout-manifest') { out.holdout_manifest = argv[++i] ?? null; continue; }
    if (argv[i] === '--input') { out.input = argv[++i] ?? null; continue; }
    if (argv[i] === '--source-commit') { out.source_commit = argv[++i] ?? null; continue; }
    if (argv[i] === '--allow-no-holdout') { out.require_holdout = false; continue; }
    throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

export async function main(argv = process.argv.slice(2), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr) {
  try {
    const options = parseArgs(argv);
    let text = '';
    if (options.input) text = fs.readFileSync(options.input, 'utf8');
    else for await (const chunk of stdin) text += chunk;
    if (!text.trim()) throw new Error(options.input ? 'input file was empty' : 'expected one JSON certification input object on stdin');
    let input = JSON.parse(text);
    if (options.holdout_manifest) {
      const holdout = JSON.parse(fs.readFileSync(options.holdout_manifest, 'utf8'));
      const injected = injectHoldoutManifest(input.corpus, holdout);
      if (!injected.ok) throw new Error(`holdout injection rejected: ${injected.errors.join('; ')}`);
      input = { ...input, corpus: injected.corpus };
    }
    const report = assembleCertification(input, options);
    stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.verdict === 'pass' ? 0 : report.verdict === 'blocked' ? 2 : 3;
  } catch (err) {
    stderr.write(`qa-certify: ${err.message}\n`);
    return 1;
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entry && entry === fileURLToPath(import.meta.url)) process.exitCode = await main();
