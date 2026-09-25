// T04 parser/backend benchmark helper.
//
// This measures caller-supplied backend execution on an explicit corpus. It reports observed wall
// time and boundary memory samples, not a production SLO and not a statistically rigorous peak RSS.
// Process-isolated peak memory/package-size evidence remains a release-task concern.

import { performance } from 'node:perf_hooks';
import { analyzeWithJsTsBackend, validateJsTsBackend } from './backend-comparison.mjs';

export const JS_TS_BACKEND_BENCHMARK_CONTRACT = 'bskel.internal.js-ts-backend-benchmark/0';

function compareNumber(a, b) { return a - b; }
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}
function validateInteger(value, label, min) {
  if (!Number.isSafeInteger(value) || value < min) throw new TypeError(`${label} must be an integer >= ${min}`);
}

function validateCorpus(corpus) {
  if (!Array.isArray(corpus) || corpus.length === 0) throw new TypeError('corpus must be a non-empty array');
  const ids = new Set();
  return corpus.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new TypeError('corpus entry must be an object');
    if (typeof entry.id !== 'string' || entry.id.length === 0) throw new TypeError('corpus entry.id must be non-empty');
    if (ids.has(entry.id)) throw new TypeError(`duplicate corpus id: ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.source !== 'string') throw new TypeError(`${entry.id}: source must be a string`);
    const options = entry.options ?? {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError(`${entry.id}: options must be an object`);
    return {
      id: entry.id,
      source: entry.source,
      options,
      bytes: Buffer.byteLength(entry.source, 'utf8'),
    };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function benchmarkJsTsBackend(backend, corpus, {
  warmup = 2,
  repeats = 10,
  now = () => performance.now(),
  memoryUsage = () => process.memoryUsage(),
} = {}) {
  validateJsTsBackend(backend);
  const cases = validateCorpus(corpus);
  validateInteger(warmup, 'warmup', 0);
  validateInteger(repeats, 'repeats', 1);
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof memoryUsage !== 'function') throw new TypeError('memoryUsage must be a function');

  const corpusBytes = cases.reduce((sum, entry) => sum + entry.bytes, 0);

  function executePass() {
    let complete = 0;
    let syntaxValidated = 0;
    let edgeCount = 0;
    for (const entry of cases) {
      const result = analyzeWithJsTsBackend(backend, entry.source, entry.options);
      if (result.complete) complete++;
      if (result.syntaxValidated) syntaxValidated++;
      edgeCount += result.moduleEdges.length;
    }
    return { complete, syntaxValidated, edgeCount };
  }

  for (let i = 0; i < warmup; i++) executePass();

  const before = memoryUsage();
  const runs = [];
  let lastOutcome = null;
  for (let i = 0; i < repeats; i++) {
    const started = now();
    const outcome = executePass();
    const ended = now();
    const durationMs = ended - started;
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError('clock produced an invalid duration');
    runs.push(durationMs);
    lastOutcome = outcome;
  }
  const after = memoryUsage();

  const sorted = [...runs].sort(compareNumber);
  const totalMs = runs.reduce((sum, value) => sum + value, 0);
  const processedBytes = corpusBytes * repeats;

  return {
    contract: JS_TS_BACKEND_BENCHMARK_CONTRACT,
    backendId: backend.id,
    corpusCases: cases.length,
    corpusBytes,
    warmup,
    repeats,
    processedBytes,
    durationMs: {
      total: totalMs,
      min: sorted[0],
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted.at(-1),
      mean: totalMs / runs.length,
      runs,
    },
    throughput: {
      bytesPerMs: totalMs === 0 ? null : processedBytes / totalMs,
      casesPerMs: totalMs === 0 ? null : (cases.length * repeats) / totalMs,
    },
    memoryBoundaryObservation: {
      rssBefore: Number(before?.rss ?? 0),
      rssAfter: Number(after?.rss ?? 0),
      rssDelta: Number(after?.rss ?? 0) - Number(before?.rss ?? 0),
      heapUsedBefore: Number(before?.heapUsed ?? 0),
      heapUsedAfter: Number(after?.heapUsed ?? 0),
      heapUsedDelta: Number(after?.heapUsed ?? 0) - Number(before?.heapUsed ?? 0),
      peakRssMeasured: false,
    },
    lastOutcome,
    caveats: [
      'wall-time is environment-dependent and must be compared only within the same pinned runner profile',
      'memory values are boundary samples; peak RSS requires a process-isolated measurement',
      'this helper does not measure dependency install time or package size',
    ],
  };
}
