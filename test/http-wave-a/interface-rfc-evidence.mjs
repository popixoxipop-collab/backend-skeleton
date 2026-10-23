// T12-02: explicit source + Git-tree provenance for RFC replay. Never promotes MET or release.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RECEIPT = path.join(ROOT, 'next/t12/INTERFACE_RFC_EVIDENCE.json');
export const RECEIPT_REL = 'next/t12/INTERFACE_RFC_EVIDENCE.json';
export const SOURCE_FILES = Object.freeze([
  'adapters/http-wave-a/BASELINE.json',
  'adapters/http-wave-a/INTERFACE_RFC.md',
  'adapters/http-wave-a/leaf-contract.schema.json',
  'adapters/http-wave-a/_shared.mjs',
  'adapters/http-wave-a/aspnet-core.mjs',
  'adapters/http-wave-a/django-drf.mjs',
  'adapters/http-wave-a/fastify.mjs',
  'adapters/http-wave-a/flask.mjs',
  'adapters/http-wave-a/gin.mjs',
  'adapters/http-wave-a/laravel.mjs',
  'adapters/http-wave-a/nestjs.mjs',
  'adapters/http-wave-a/python-scope/static-runner.mjs',
  'adapters/http-wave-a/python-scope/verify.mjs',
  'adapters/http-wave-a/python-django/results/static.json',
  'test/http-wave-a/baseline-record-lib.mjs',
  'test/http-wave-a/interface-rfc.test.mjs',
  'test/http-wave-a/interface-rfc.vocabulary.json',
  'test/http-wave-a/rfc-boundaries.test.mjs',
  'test/http-wave-a/interface-rfc-evidence.mjs',
  'test/http-wave-a/interface-rfc-evidence.test.mjs',
]);
export const COMMAND = Object.freeze([
  'node', '--test',
  'test/http-wave-a/interface-rfc.test.mjs',
  'test/http-wave-a/rfc-boundaries.test.mjs',
]);
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const KEYS = ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'];
const sourceHash = (buf) => createHash('sha256').update(buf).digest('hex');
const exact = (x, keys) => x !== null && typeof x === 'object' && !Array.isArray(x) &&
  JSON.stringify(Object.keys(x).sort()) === JSON.stringify([...keys].sort());

export function pinnedFiles() {
  return Object.fromEntries(SOURCE_FILES.map((p) =>
    [p, sourceHash(fs.readFileSync(path.join(ROOT, p)))]));
}

export function runRfcCommand() {
  const env = { ...process.env, NODE_OPTIONS: '' };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST_')) delete env[k];
  const p = spawnSync(process.execPath, COMMAND.slice(1), {
    cwd: ROOT, encoding: 'utf8', env, timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (p.error || p.signal !== null || p.status !== 0) {
    throw new Error('T12 interface command failed: ' + JSON.stringify({
      exit_code: p.status, signal: p.signal, error: p.error?.message,
      stderr_tail: p.stderr?.slice(-1000), stdout_tail: p.stdout?.slice(-1200),
    }));
  }
  const tap = (p.stdout ?? '') + '\n' + (p.stderr ?? '');
  const counts = {};
  for (const key of KEYS) {
    const matches = [...tap.matchAll(new RegExp(
      '(?:^|\\n)(?:#|ℹ)\\s*' + key + '\\s+(\\d+)\\s*(?=\\r?\\n|$)', 'g'))];
    if (!matches.length) throw new Error('missing RFC TAP summary ' + key);
    counts[key] = Number(matches.at(-1)[1]);
  }
  if (!Number.isSafeInteger(counts.tests) || counts.tests < 1 ||
      counts.pass !== counts.tests || counts.fail !== 0 ||
      counts.skipped !== 0 || counts.cancelled !== 0 || counts.todo !== 0) {
    throw new Error('T12 RFC command not a zero-skip success ' + JSON.stringify(counts));
  }
  return { command: [...COMMAND], exit_code: 0, counts };
}

export function structureProblems(rec, current = pinnedFiles()) {
  const errors = [];
  if (!exact(rec, ['schema', 'task_id', 'verified_source_commit',
    'source_files', 'observed_run', 'assertions', 'limits'])) return ['incomplete evidence receipt schema'];
  if (rec.schema !== 'bskel.t12-interface-rfc-evidence/1' || rec.task_id !== 'T12-02') {
    errors.push('wrong T12-02 task or schema');
  }
  if (!SHA1.test(rec.verified_source_commit)) errors.push('invalid immutable source commit');
  if (!exact(rec.source_files, SOURCE_FILES)) errors.push('missing or extra source file pins');
  else for (const p of SOURCE_FILES) {
    if (!SHA256.test(rec.source_files[p]) || current[p] !== rec.source_files[p]) {
      errors.push('source file hash drift ' + p);
    }
  }
  if (!exact(rec.assertions, ['official_MET_delta', 'automatic_promotion',
    'release_activation', 'signed_independent_attestation', 'runtime_certified']) ||
    rec.assertions.official_MET_delta !== 0 ||
    rec.assertions.automatic_promotion !== false ||
    rec.assertions.release_activation !== false ||
    rec.assertions.signed_independent_attestation !== false ||
    rec.assertions.runtime_certified !== false) errors.push('forged MET, attestation or release authority');
  const run = rec.observed_run;
  if (!exact(run, ['command', 'exit_code', 'counts']) ||
      JSON.stringify(run.command) !== JSON.stringify(COMMAND) || run.exit_code !== 0 ||
      !exact(run.counts, KEYS) ||
      !KEYS.every((key) => Number.isSafeInteger(run.counts[key]) && run.counts[key] >= 0) ||
      run.counts.tests < 1 || run.counts.pass !== run.counts.tests ||
      run.counts.fail !== 0 || run.counts.skipped !== 0 ||
      run.counts.cancelled !== 0 || run.counts.todo !== 0) {
    errors.push('invalid recorded T12 command outcome');
  }
  if (typeof rec.limits !== 'string' ||
      !rec.limits.includes('not runtime-certified') ||
      !rec.limits.includes('historical T12-01')) {
    errors.push('scope limit was erased');
  }
  return errors;
}

function git(args, timeout = 18000) {
  return spawnSync('git', args, {
    cwd: ROOT, encoding: null, timeout, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}
const output = (p) => p.stdout?.toString('utf8').trim() ?? '';

export function sourceCommitProblems(rec) {
  const sha = rec?.verified_source_commit;
  if (!SHA1.test(sha ?? '')) return ['invalid source commit identity'];
  let object = git(['cat-file', '-t', sha]);
  if (object.error || object.status !== 0 || output(object) !== 'commit') {
    const fetched = git(['fetch', '--no-tags', '--depth=1', '--quiet',
      'https://github.com/popixoxipop-collab/backend-skeleton.git', sha], 55000);
    if (fetched.error || fetched.status !== 0) return ['source commit unavailable'];
    object = git(['cat-file', '-t', sha]);
    if (object.error || object.status !== 0 || output(object) !== 'commit') {
      return ['source commit unavailable'];
    }
  }
  const problems = [];
  const priorReceipt = git(['cat-file', '-e', sha + ':' + RECEIPT_REL]);
  if (priorReceipt.status === 0) problems.push('receipt existed at recorded source commit');
  const tree = git(['diff', '--name-only', '--no-renames', sha, 'HEAD']);
  if (tree.status !== 0 || tree.error) {
    problems.push('source commit and current tree comparison unavailable');
  } else {
    const changed = output(tree).split('\n').filter(Boolean);
    if (changed.some((p) => p !== RECEIPT_REL)) {
      problems.push('tracked source tree changed beyond evidence receipt');
    }
  }
  // The source checkout may contain exactly one untracked file while --write
  // is producing this receipt. Every other untracked input is suspect too:
  // nested fixtures can otherwise alter a replay without changing Git blobs.
  const tracked = git(['status', '--porcelain', '--untracked-files=all']);
  const unexpected = output(tracked).split('\n').filter(Boolean)
    .filter((line) => line !== '?? ' + RECEIPT_REL);
  if (tracked.status !== 0 || tracked.error || unexpected.length) {
    problems.push('working-tree source drift or untracked inputs');
  }
  for (const rel of SOURCE_FILES) {
    const blob = git(['show', sha + ':' + rel]);
    if (blob.error || blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) {
      problems.push('source commit blob unavailable ' + rel);
    } else if (sourceHash(blob.stdout) !== rec.source_files?.[rel]) {
      problems.push('source commit blob hash differs ' + rel);
    }
  }
  return problems;
}

export function verifyEvidence(rec = JSON.parse(fs.readFileSync(RECEIPT, 'utf8')), replay = null) {
  const errors = structureProblems(rec);
  if (errors.length === 0) errors.push(...sourceCommitProblems(rec));
  if (replay && JSON.stringify(rec.observed_run) !== JSON.stringify(replay)) {
    errors.push('fresh T12 RFC command result differs from receipt');
  }
  return errors;
}

function write() {
  const observed_run = runRfcCommand();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.match(sha, SHA1);
  const rec = {
    schema: 'bskel.t12-interface-rfc-evidence/1',
    task_id: 'T12-02', verified_source_commit: sha,
    source_files: pinnedFiles(),
    observed_run,
    assertions: {
      official_MET_delta: 0, automatic_promotion: false,
      release_activation: false, signed_independent_attestation: false,
      runtime_certified: false,
    },
    limits: 'Source-pinned T12-02 RFC and counterexample replay only: not runtime-certified or product-supported. The historical T12-01 baseline and upstream analysis limitations remain separate and unchanged.',
  };
  assert.deepEqual(verifyEvidence(rec, observed_run), []);
  fs.mkdirSync(path.dirname(RECEIPT), { recursive: true });
  fs.writeFileSync(RECEIPT, JSON.stringify(rec, null, 2) + '\n', { flag: 'wx' });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (mode === '--write') {
      write();
      console.log('WROTE T12-02 exact-source RFC evidence receipt');
    } else if (mode === '--check') {
      assert.deepEqual(verifyEvidence(undefined, runRfcCommand()), []);
      console.log('PASS T12 source-bound RFC replay, MET_delta=0 release=false');
    } else throw new Error('usage: node test/http-wave-a/interface-rfc-evidence.mjs --write|--check');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
