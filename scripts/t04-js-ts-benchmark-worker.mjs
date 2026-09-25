#!/usr/bin/env node
// T04 process-isolated benchmark worker. stdin JSON only; no arbitrary module path or command.

import { benchmarkJsTsBackend } from '../scanners/language/js-ts/backend-benchmark.mjs';
import { lexicalJsTsBackend } from '../scanners/language/js-ts/backend-comparison.mjs';

const MAX_STDIN_BYTES = 8 * 1024 * 1024;

function backendById(id) {
  if (id === 'bounded-lexical') return lexicalJsTsBackend();
  throw new TypeError(`unsupported benchmark backend: ${String(id)}`);
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) throw new RangeError(`benchmark input exceeds ${MAX_STDIN_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const raw = await readStdin();
  const request = JSON.parse(raw);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('benchmark request must be an object');
  const backend = backendById(request.backendId);
  const report = benchmarkJsTsBackend(backend, request.corpus, {
    warmup: request.warmup ?? 2,
    repeats: request.repeats ?? 10,
  });
  const usage = process.resourceUsage();
  const output = {
    schema: 'bskel.internal.js-ts-process-benchmark/0',
    processScope: 'isolated-node-process',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    backendId: backend.id,
    benchmark: report,
    resourceUsage: {
      maxRssKiB: usage.maxRSS,
      maxRssBytes: usage.maxRSS * 1024,
      userCpuMicros: usage.userCPUTime,
      systemCpuMicros: usage.systemCPUTime,
      minorPageFault: usage.minorPageFault,
      majorPageFault: usage.majorPageFault,
    },
  };
  process.stdout.write(JSON.stringify(output) + '\n');
} catch (error) {
  process.stderr.write(`t04-js-ts-benchmark-worker: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
}
