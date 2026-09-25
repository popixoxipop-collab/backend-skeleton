import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareObservedInventory,
  evaluateMutationGate,
  validateCorpusManifest,
  validateNegativeVectorCatalog,
  verifyEvidencePack,
} from './harness.mjs';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function ratio(n, d) {
  return d === 0 ? null : n / d;
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
    if (!vector.critical && result.status === 'equivalent') { equivalent++; continue; }
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
  return {
    pass: errors.length === 0 && critical_failures.length === 0,
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

export function assembleCertification(input, { artifact_root = null, require_holdout = true } = {}) {
  const reasons = [];
  const corpus = validateCorpusManifest(input?.corpus);
  const vectors = validateNegativeVectorCatalog(input?.negative_vectors);
  if (!corpus.ok) reasons.push(...corpus.errors.map((x) => `corpus: ${x}`));
  if (!vectors.ok) reasons.push(...vectors.errors.map((x) => `vectors: ${x}`));

  let differential = null;
  if (input?.differential) {
    differential = evaluateDifferentialGate(input.differential);
    if (!differential.pass) reasons.push(...differential.reasons.map((x) => `differential: ${x}`));
  }
  let negative = null;
  if (input?.negative_run) {
    negative = evaluateNegativeVectorRun({ catalog: input.negative_vectors, results: input.negative_run });
    if (!negative.pass) reasons.push(...negative.reasons.map((x) => `negative: ${x}`), ...negative.critical_failures.map((x) => `negative critical failure: ${x}`));
  }
  let mutation = null;
  if (input?.mutation) {
    mutation = evaluateMutationGate(input.mutation);
    if (!mutation.pass) reasons.push(...mutation.reasons.map((x) => `mutation: ${x}`));
  }
  let evidence = null;
  if (input?.evidence) {
    evidence = artifact_root ? verifyEvidencePackFromDisk(input.evidence, { artifact_root }) : verifyEvidencePack(input.evidence);
    if (!evidence.ok) reasons.push(...evidence.errors.map((x) => `evidence: ${x}`));
  }

  const requiredMissing = [];
  for (const name of ['differential', 'negative_run', 'mutation', 'evidence']) if (!input?.[name]) requiredMissing.push(name);
  if (requiredMissing.length) reasons.push(`missing required certification sections: ${requiredMissing.join(', ')}`);

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
    gates: { corpus, vectors, differential, negative, mutation, evidence },
  };
}

function parseArgs(argv) {
  const out = { artifact_root: null, require_holdout: true, holdout_manifest: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--artifact-root') { out.artifact_root = argv[++i] ?? null; continue; }
    if (argv[i] === '--holdout-manifest') { out.holdout_manifest = argv[++i] ?? null; continue; }
    if (argv[i] === '--allow-no-holdout') { out.require_holdout = false; continue; }
    throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

export async function main(argv = process.argv.slice(2), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr) {
  try {
    const options = parseArgs(argv);
    let text = '';
    for await (const chunk of stdin) text += chunk;
    if (!text.trim()) throw new Error('expected one JSON certification input object on stdin');
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
