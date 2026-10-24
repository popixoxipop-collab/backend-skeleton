// T05-02 source-bound interface evidence. This tool cannot award MET, certify a parser or activate a release.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RECEIPT_REL = 'next/t05/INTERFACE_RFC_EVIDENCE.json';
export const RECEIPT = path.join(ROOT, RECEIPT_REL);
export const SOURCE_FILES = Object.freeze([
  'scanners/language/jvm/BASELINE.json',
  'scanners/language/jvm/README.md',
  'scanners/language/jvm/protocol.mjs',
  'scanners/language/jvm/java-syntax-facts.mjs',
  'scanners/language/jvm/annotation-graph.mjs',
  'scanners/language/jvm/member-facts.mjs',
  'scanners/language/jvm/method-facts.mjs',
  'scanners/language/jvm/jpa-direct-facts.mjs',
  'scanners/language/jvm/framework-profiles.mjs',
  'scanners/language/jvm/semantic-backend.mjs',
  'scanners/language/jvm/spring-shadow.mjs',
  'next/t05/INTERFACE_RFC.md',
  'next/t05/interface-rfc.test.mjs',
  'next/t05/interface-rfc-evidence.mjs',
  'next/t05/interface-rfc-evidence.test.mjs',
]);
export const COMMAND = Object.freeze(['node', '--test', 'next/t05/interface-rfc.test.mjs']);
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COUNT_KEYS = ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());

export function pinnedFiles() {
  return Object.fromEntries(SOURCE_FILES.map((rel) => [rel, hash(fs.readFileSync(path.join(ROOT, rel)))]));
}

export function runRfcChecks() {
  // node --test sets an IPC worker context; remove it for the independent child summary.
  const env = { ...process.env, NODE_OPTIONS: '' };
  for (const key of Object.keys(env)) if (key.startsWith('NODE_TEST_')) delete env[key];
  const p = spawnSync(process.execPath, COMMAND.slice(1), {
    cwd: ROOT, encoding: 'utf8', env,
    timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  });
  if (p.error || p.signal !== null || p.status !== 0) {
    throw new Error('T05 RFC test did not pass: ' + JSON.stringify({
      status: p.status, signal: p.signal, error: p.error?.message,
      stdout_tail: p.stdout?.slice(-950), stderr_tail: p.stderr?.slice(-700),
    }));
  }
  const tap = (p.stdout ?? '') + '\n' + (p.stderr ?? '');
  const counts = {};
  for (const key of COUNT_KEYS) {
    const lines = [...tap.matchAll(new RegExp('(?:^|\\n)(?:#|ℹ)\\s*' + key + '\\s+(\\d+)\\s*(?=\\r?\\n|$)', 'g'))];
    if (!lines.length) throw new Error('missing RFC TAP summary ' + key);
    counts[key] = Number(lines.at(-1)[1]);
  }
  if (!Number.isSafeInteger(counts.tests) || counts.tests === 0 || counts.pass !== counts.tests ||
      counts.fail !== 0 || counts.skipped !== 0 || counts.cancelled !== 0 || counts.todo !== 0) {
    throw new Error('T05 RFC checks not a zero-skip pass: ' + JSON.stringify(counts));
  }
  return { command: [...COMMAND], exit_code: 0, counts };
}

export function structureProblems(rec, current = pinnedFiles()) {
  const errors = [];
  if (!exactKeys(rec, ['schema', 'task_id', 'verified_source_commit',
    'source_files', 'observed_run', 'assertions', 'limitations'])) return ['invalid evidence receipt field set'];
  if (rec.schema !== 'bskel.t05-interface-rfc-evidence/1' || rec.task_id !== 'T05-02') errors.push('wrong task or schema');
  if (!SHA1.test(rec.verified_source_commit)) errors.push('invalid exact Git source revision');
  if (!exactKeys(rec.source_files, SOURCE_FILES)) errors.push('incomplete or extra source-file pins');
  else for (const rel of SOURCE_FILES) {
    if (!SHA256.test(rec.source_files[rel]) || current[rel] !== rec.source_files[rel]) {
      errors.push('source file digest drift ' + rel);
    }
  }
  if (!exactKeys(rec.assertions, ['official_MET_delta', 'automatic_promotion',
    'release_activation', 'signed_independent_attestation', 'runtime_certified',
    'stable_sbf_contract']) ||
    rec.assertions.official_MET_delta !== 0 ||
    rec.assertions.automatic_promotion !== false ||
    rec.assertions.release_activation !== false ||
    rec.assertions.signed_independent_attestation !== false ||
    rec.assertions.runtime_certified !== false ||
    rec.assertions.stable_sbf_contract !== false) errors.push('forged MET/release/contract/attestation authority');
  const run = rec.observed_run;
  if (!exactKeys(run, ['command', 'exit_code', 'counts']) ||
    JSON.stringify(run.command) !== JSON.stringify(COMMAND) || run.exit_code !== 0 ||
    !exactKeys(run.counts, COUNT_KEYS) ||
    !COUNT_KEYS.every((key) => Number.isSafeInteger(run.counts[key]) && run.counts[key] >= 0) ||
    run.counts.tests < 1 || run.counts.pass !== run.counts.tests || run.counts.fail !== 0 ||
    run.counts.skipped !== 0 || run.counts.cancelled !== 0 || run.counts.todo !== 0) {
    errors.push('invalid recorded RFC command, exit or counts');
  }
  if (typeof rec.limitations !== 'string' ||
      !rec.limitations.includes('not a stable SBF cross-tool contract') ||
      !rec.limitations.includes('not runtime-certified') ||
      !rec.limitations.includes('historical T05-01')) {
    errors.push('missing unresolved RFC scope limitations');
  }
  return errors;
}

function git(args, timeout = 18000) {
  return spawnSync('git', args, {
    cwd: ROOT, encoding: null, maxBuffer: 16 * 1024 * 1024,
    timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}
function text(p) { return p.stdout?.toString('utf8').trim() ?? ''; }

export function sourceCommitProblems(rec) {
  const rev = rec?.verified_source_commit;
  if (!SHA1.test(rev ?? '')) return ['invalid source commit identity'];
  let kind = git(['cat-file', '-t', rev]);
  if (kind.error || kind.status !== 0 || text(kind) !== 'commit') {
    // Depth-1 CI checkouts may lack the exact source snapshot. Fetch that
    // immutable SHA only; absence is a hard failure, never a waived check.
    const fetched = git(['fetch', '--no-tags', '--depth=1', '--quiet',
      'https://github.com/popixoxipop-collab/backend-skeleton.git', rev], 55000);
    if (fetched.error || fetched.status !== 0) return ['source commit unavailable'];
    kind = git(['cat-file', '-t', rev]);
    if (kind.error || kind.status !== 0 || text(kind) !== 'commit') return ['source commit unavailable'];
  }

  const problems = [];
  const earlyReceipt = git(['cat-file', '-e', rev + ':' + RECEIPT_REL]);
  if (earlyReceipt.status === 0) problems.push('receipt already existed in source commit');
  // Restrict the revision check to the source files that this RFC receipt
  // actually authenticates. Unrelated future T12/T13/T14/main changes
  // cannot invalidate the T05 evidence or block unrelated CI.
  const delta = git(['diff', '--name-only', '--no-renames', rev, 'HEAD',
    '--', ...SOURCE_FILES, RECEIPT_REL]);
  if (delta.error || delta.status !== 0) problems.push('cannot compare source revision against checked-out HEAD');
  else if (text(delta).split('\n').filter(Boolean).some((p) => p !== RECEIPT_REL)) {
    problems.push('pinned T05 source tree changed beyond the evidence receipt');
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty.error || dirty.status !== 0 || text(dirty)) problems.push('tracked source files modified in working tree');

  for (const rel of SOURCE_FILES) {
    const blob = git(['show', rev + ':' + rel]);
    if (blob.error || blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) {
      problems.push('source Git blob unavailable ' + rel);
    } else if (hash(blob.stdout) !== rec.source_files?.[rel]) {
      problems.push('source Git blob digest mismatch ' + rel);
    }
  }
  return problems;
}

export function verifyEvidence(rec = JSON.parse(fs.readFileSync(RECEIPT, 'utf8')), replay = null) {
  const problems = structureProblems(rec);
  if (problems.length === 0) problems.push(...sourceCommitProblems(rec));
  if (replay && JSON.stringify(rec.observed_run) !== JSON.stringify(replay)) {
    problems.push('fresh command replay differs from recorded result');
  }
  return problems;
}

function writeReceipt() {
  const observed_run = runRfcChecks();
  const verified_source_commit = execFileSync('git', ['rev-parse', 'HEAD'],
    { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.match(verified_source_commit, SHA1);
  const record = {
    schema: 'bskel.t05-interface-rfc-evidence/1',
    task_id: 'T05-02',
    verified_source_commit,
    source_files: pinnedFiles(),
    observed_run,
    assertions: { official_MET_delta: 0, automatic_promotion: false,
      release_activation: false, signed_independent_attestation: false,
      runtime_certified: false, stable_sbf_contract: false },
    limitations: 'This pins only the T05 internal v0 interface and exact source-facts/RFC command evidence; not a stable SBF cross-tool contract, not runtime-certified or a parser/typechecker approval. The historical T05-01 baseline remains separately pinned and unchanged; Kotlin/Ktor blocked.',
  };
  assert.deepEqual(verifyEvidence(record, observed_run), []);
  fs.mkdirSync(path.dirname(RECEIPT), { recursive: true });
  fs.writeFileSync(RECEIPT, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (mode === '--write') {
      writeReceipt();
      console.log('WROTE T05-02 exact source interface RFC receipt');
    } else if (mode === '--check') {
      assert.deepEqual(verifyEvidence(undefined, runRfcChecks()), []);
      console.log('PASS T05-02 RFC source-bound zero-skip replay, MET_delta=0 release=false');
    } else throw new Error('usage: node test/language-js-ts/interface-rfc-evidence.mjs --write|--check');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
