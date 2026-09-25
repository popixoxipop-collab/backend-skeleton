import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkJsTsBackend } from '../scanners/language/js-ts/backend-benchmark.mjs';
import { JS_TS_BACKEND_CONTRACT } from '../scanners/language/js-ts/backend-comparison.mjs';

function backend(id, analyze, syntaxValidated = false) {
  return { contract: JS_TS_BACKEND_CONTRACT, id, syntaxValidated, analyze };
}

function stableBackend() {
  return backend('stable', (source, options) => ({
    contract: 'facts',
    filePath: options.filePath,
    complete: true,
    syntaxValidated: false,
    moduleEdges: source ? [{ kind: 'import', specifier: source, bindings: [], typeOnly: false }] : [],
    diagnostics: [],
  }));
}

test('benchmark reports deterministic aggregate wall-time from an injected clock', () => {
  let tick = 0;
  const now = () => tick++;
  const result = benchmarkJsTsBackend(stableBackend(), [
    { id: 'a', source: 'aa', options: { filePath: 'a.js' } },
    { id: 'b', source: 'bbb', options: { filePath: 'b.js' } },
  ], {
    warmup: 1,
    repeats: 3,
    now,
    memoryUsage: () => ({ rss: 100, heapUsed: 50 }),
  });
  assert.equal(result.corpusCases, 2);
  assert.equal(result.corpusBytes, 5);
  assert.equal(result.processedBytes, 15);
  assert.deepEqual(result.durationMs.runs, [1,1,1]);
  assert.equal(result.durationMs.total, 3);
  assert.equal(result.durationMs.p50, 1);
  assert.equal(result.durationMs.p95, 1);
  assert.equal(result.throughput.bytesPerMs, 5);
  assert.equal(result.memoryBoundaryObservation.peakRssMeasured, false);
  assert.deepEqual(result.lastOutcome, { complete: 2, syntaxValidated: 0, edgeCount: 2 });
});

test('p50/p95 use ordered nearest-rank values', () => {
  const times = [0,1,1,3,3,6,6,10,10,15];
  let i = 0;
  const result = benchmarkJsTsBackend(stableBackend(), [{ id: 'x', source: 'x', options: { filePath: 'x.js' } }], {
    warmup: 0,
    repeats: 5,
    now: () => times[i++],
    memoryUsage: () => ({ rss: 0, heapUsed: 0 }),
  });
  assert.deepEqual(result.durationMs.runs, [1,2,3,4,5]);
  assert.equal(result.durationMs.p50, 3);
  assert.equal(result.durationMs.p95, 5);
  assert.equal(result.durationMs.mean, 3);
});

test('memory delta is labeled as boundary observation rather than peak RSS', () => {
  const samples = [{ rss: 1000, heapUsed: 400 }, { rss: 1400, heapUsed: 450 }];
  let m = 0;
  let time = 0;
  const result = benchmarkJsTsBackend(stableBackend(), [{ id:'x', source:'', options:{filePath:'x.js'} }], {
    warmup: 0,
    repeats: 1,
    now: () => time++,
    memoryUsage: () => samples[m++],
  });
  assert.deepEqual(result.memoryBoundaryObservation, {
    rssBefore: 1000,
    rssAfter: 1400,
    rssDelta: 400,
    heapUsedBefore: 400,
    heapUsedAfter: 450,
    heapUsedDelta: 50,
    peakRssMeasured: false,
  });
  assert.ok(result.caveats.some((x) => /peak RSS/.test(x)));
});

test('zero duration never fabricates infinite throughput', () => {
  const result = benchmarkJsTsBackend(stableBackend(), [{ id:'x', source:'x', options:{filePath:'x.js'} }], {
    warmup: 0,
    repeats: 1,
    now: () => 1,
    memoryUsage: () => ({ rss: 0, heapUsed: 0 }),
  });
  assert.equal(result.durationMs.total, 0);
  assert.equal(result.throughput.bytesPerMs, null);
  assert.equal(result.throughput.casesPerMs, null);
});

test('warmup executions are excluded from measured outcome counts', () => {
  let calls = 0;
  const b = backend('counted', () => {
    calls++;
    return { contract:'facts', complete:true, syntaxValidated:false, moduleEdges:[], diagnostics:[] };
  });
  let time = 0;
  benchmarkJsTsBackend(b, [{ id:'x', source:'', options:{} }], {
    warmup: 2,
    repeats: 3,
    now: () => time++,
    memoryUsage: () => ({ rss:0, heapUsed:0 }),
  });
  assert.equal(calls, 5);
});

test('invalid corpus and benchmark budgets are rejected before execution', () => {
  let calls = 0;
  const b = backend('counted', () => {
    calls++;
    return { contract:'facts', complete:true, syntaxValidated:false, moduleEdges:[], diagnostics:[] };
  });
  assert.throws(() => benchmarkJsTsBackend(b, [], { warmup:0 }), /non-empty/);
  assert.throws(() => benchmarkJsTsBackend(b, [
    { id:'x', source:'' }, { id:'x', source:'' },
  ], { warmup:0 }), /duplicate corpus id/);
  assert.throws(() => benchmarkJsTsBackend(b, [{id:'x',source:''}], { repeats:0 }), /repeats/);
  assert.equal(calls, 0);
});

test('backend errors are not swallowed into fake timing samples', () => {
  const b=backend('throws',()=>{throw new Error('backend failed');});
  let time=0;
  assert.throws(
    () => benchmarkJsTsBackend(b,[{id:'x',source:'',options:{}}],{
      warmup:0,repeats:1,now:()=>time++,memoryUsage:()=>({rss:0,heapUsed:0}),
    }),
    /backend failed/,
  );
});
