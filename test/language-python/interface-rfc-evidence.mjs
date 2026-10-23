// T06-02: source-bound interface RFC evidence; never an adjudicator or release gate.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RECEIPT = path.join(ROOT, 'next/t06/INTERFACE_RFC_EVIDENCE.json');
export const SOURCE_FILES = Object.freeze([
  'scanners/language/python/README.md',
  'scanners/language/python/INTERFACE_RFC.md',
  'test/language-python/interface-rfc.vocabulary.json',
  'test/language-python/interface-rfc.test.mjs',
  'test/language-python/baseline-record-lib.mjs',
  'test/language-python/interface-rfc-evidence.mjs',
  'test/language-python/interface-rfc-evidence.test.mjs',
]);
export const COMMAND = Object.freeze(['node', '--test', 'test/language-python/interface-rfc.test.mjs']);
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const METRICS = ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());

export function currentSourceHashes() {
  return Object.fromEntries(SOURCE_FILES.map((rel) => [rel, digest(fs.readFileSync(path.join(ROOT, rel)))]));
}

export function runInterfaceChecks() {
  // Node --test normally propagates an IPC worker context to subprocesses,
  // hiding the child's summary. Run the real command independently.
  const env = { ...process.env, NODE_OPTIONS: '' };
  for (const name of Object.keys(env)) if (name.startsWith('NODE_TEST_')) delete env[name];
  const out = spawnSync(process.execPath, COMMAND.slice(1), {
    cwd: ROOT, env, encoding: 'utf8', timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (out.error || out.signal !== null || out.status !== 0) {
    throw new Error('RFC command failed: ' + JSON.stringify({
      status: out.status, signal: out.signal, error: out.error?.message,
      stdout_tail: out.stdout?.slice(-800), stderr_tail: out.stderr?.slice(-800),
    }));
  }
  const lines = (out.stdout ?? '') + '\n' + (out.stderr ?? '');
  const counts = {};
  for (const key of METRICS) {
    const matches = [...lines.matchAll(new RegExp('(?:^|\\n)(?:#|ℹ)\\s*' + key + '\\s+(\\d+)\\s*(?=\\r?\\n|$)', 'g'))];
    if (!matches.length) throw new Error('missing TAP summary ' + key);
    counts[key] = Number(matches.at(-1)[1]);
  }
  if (!Number.isSafeInteger(counts.tests) || counts.tests < 1 ||
      counts.pass !== counts.tests || counts.fail !== 0 ||
      counts.skipped !== 0 || counts.cancelled !== 0 || counts.todo !== 0) {
    throw new Error('interface RFC test not a zero-skip pass ' + JSON.stringify(counts));
  }
  return { command: [...COMMAND], exit_code: 0, counts };
}

export function structureProblems(record, current = currentSourceHashes()) {
  const problems = [];
  if (!exactKeys(record, ['schema', 'task_id', 'verified_source_commit',
    'source_files', 'observed_run', 'assertions', 'limits'])) return ['invalid evidence receipt field set'];
  if (record.schema !== 'bskel.t06-interface-evidence/1' || record.task_id !== 'T06-02') {
    problems.push('invalid task or schema');
  }
  if (!SHA1.test(record.verified_source_commit)) problems.push('source commit is not a Git SHA-1');
  if (!exactKeys(record.source_files, SOURCE_FILES)) problems.push('incomplete source file hash set');
  else for (const rel of SOURCE_FILES) {
    if (!SHA256.test(record.source_files[rel]) || record.source_files[rel] !== current[rel]) {
      problems.push('source file digest drift ' + rel);
    }
  }
  if (!exactKeys(record.assertions, ['official_MET_delta', 'automatic_promotion',
    'release_activation', 'signed_independent_attestation', 'runtime_certified']) ||
    record.assertions.official_MET_delta !== 0 ||
    record.assertions.automatic_promotion !== false ||
    record.assertions.release_activation !== false ||
    record.assertions.signed_independent_attestation !== false ||
    record.assertions.runtime_certified !== false) {
    problems.push('forged adjudication or release authority');
  }
  const run = record.observed_run;
  if (!exactKeys(run, ['command', 'exit_code', 'counts']) ||
    JSON.stringify(run.command) !== JSON.stringify(COMMAND) || run.exit_code !== 0 ||
    !exactKeys(run.counts, METRICS) ||
    !METRICS.every((key) => Number.isSafeInteger(run.counts[key]) && run.counts[key] >= 0) ||
    run.counts.tests < 1 || run.counts.pass !== run.counts.tests ||
    run.counts.fail !== 0 || run.counts.skipped !== 0 ||
    run.counts.cancelled !== 0 || run.counts.todo !== 0) {
    problems.push('invalid recorded RFC command outcome');
  }
  if (typeof record.limits !== 'string' ||
      !record.limits.includes('not a runtime certification') ||
      !record.limits.includes('historical baseline')) {
    problems.push('missing RFC scope limitations');
  }
  return problems;
}

function Git(args, timeout = 20000) {
  return spawnSync('git', args, {
    cwd: ROOT, encoding: null, timeout, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

export function sourceCommitProblems(record) {
  const commit = record?.verified_source_commit;
  if (!SHA1.test(commit ?? '')) return ['invalid immutable source commit id'];
  let kind = Git(['cat-file', '-t', commit]);
  if (kind.error || kind.status !== 0 || kind.stdout?.toString('utf8').trim() !== 'commit') {
    // GitHub Actions shallow clones only have the PR checkout. Fetch only
    // the exact immutable SHA; fail closed if unavailable.
    const fetched = Git(['fetch', '--no-tags', '--depth=1', '--quiet',
      'https://github.com/popixoxipop-collab/backend-skeleton.git', commit], 60000);
    if (fetched.error || fetched.status !== 0) return ['source commit unavailable'];
    kind = Git(['cat-file', '-t', commit]);
    if (kind.error || kind.status !== 0 || kind.stdout?.toString('utf8').trim() !== 'commit') {
      return ['source commit unavailable'];
    }
  }
  const errors = [];
  for (const rel of SOURCE_FILES) {
    const file = Git(['show', commit + ':' + rel]);
    if (file.error || file.status !== 0 || !Buffer.isBuffer(file.stdout)) {
      errors.push('source commit file unavailable ' + rel);
    } else if (digest(file.stdout) !== record.source_files?.[rel]) {
      errors.push('source commit blob digest mismatch ' + rel);
    }
  }
  return errors;
}

export function verifyEvidence(record = JSON.parse(fs.readFileSync(RECEIPT, 'utf8')), fresh = null) {
  const problems = structureProblems(record);
  if (problems.length === 0) problems.push(...sourceCommitProblems(record));
  if (fresh && JSON.stringify(record.observed_run) !== JSON.stringify(fresh)) {
    problems.push('replayed command differs from recorded outcome');
  }
  return problems;
}

function createReceipt() {
  const observed_run = runInterfaceChecks();
  const verified_source_commit = execFileSync('git', ['rev-parse', 'HEAD'],
    { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.match(verified_source_commit, SHA1);
  const record = {
    schema: 'bskel.t06-interface-evidence/1',
    task_id: 'T06-02', verified_source_commit,
    source_files: currentSourceHashes(), observed_run,
    assertions: { official_MET_delta: 0, automatic_promotion: false,
      release_activation: false, signed_independent_attestation: false,
      runtime_certified: false },
    limits: 'This validates the T06-02 Python analysis RFC and sample evidence, not a runtime certification. The T06-01 historical baseline and optional corpus are separate and not modified or certified by this receipt.',
  };
  assert.deepEqual(verifyEvidence(record, observed_run), []);
  fs.mkdirSync(path.dirname(RECEIPT), { recursive: true });
  fs.writeFileSync(RECEIPT, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (mode === '--write') {
      createReceipt();
      console.log('WROTE T06-02 source-bound RFC receipt');
    } else if (mode === '--check') {
      assert.deepEqual(verifyEvidence(undefined, runInterfaceChecks()), []);
      console.log('PASS T06-02 exact source RFC replay, MET_delta=0 and release=false');
    } else {
      throw new Error('usage: node test/language-python/interface-rfc-evidence.mjs --write|--check');
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
