// T13-02 source-bound RFC evidence; never a MET or release adjudicator.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RECEIPT = path.join(ROOT, 'test/http-wave-bc/interface-rfc-evidence.json');
export const SOURCE_FILES = Object.freeze([
  'adapters/http-wave-bc/INTERFACE_RFC.md',
  'test/http-wave-bc/interface-rfc.vocabulary.json',
  'test/http-wave-bc/interface-rfc.test.mjs',
]);
export const COMMAND = Object.freeze(['node', '--test', 'test/http-wave-bc/interface-rfc.test.mjs']);
const digest = (buf) => createHash('sha256').update(buf).digest('hex');
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const COUNTS = ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'];

export function pinnedFiles() {
  return Object.fromEntries(SOURCE_FILES.map((rel) => [rel, digest(fs.readFileSync(path.join(ROOT, rel)))]));
}

export function observeRfcTest() {
  // A direct replay inside node --test must not inherit the parent's test
  // worker IPC context, which suppresses the child's standalone summary.
  const childEnv = { ...process.env, NODE_OPTIONS: '' };
  for (const name of Object.keys(childEnv)) if (name.startsWith('NODE_TEST_')) delete childEnv[name];
  const output = spawnSync(process.execPath, COMMAND.slice(1), {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    env: childEnv,
  });
  if (output.error || output.signal !== null || output.status !== 0) {
    throw new Error('T13 RFC test did not pass: ' + JSON.stringify({
      error: output.error?.message, signal: output.signal, exit_code: output.status,
      stderr_tail: output.stderr?.slice(-600),
      stdout_tail: output.stdout?.slice(-1000),
    }));
  }
  const combined = (output.stdout ?? '') + '\n' + (output.stderr ?? '');
  const counts = {};
  for (const key of COUNTS) {
    const matches = [...combined.matchAll(new RegExp('(?:^|\\n)(?:#|ℹ)\\s*' + key + '\\s+(\\d+)\\s*(?=\\r?\\n|$)', 'g'))];
    if (matches.length === 0) throw new Error('T13 RFC test did not report ' + key);
    counts[key] = Number(matches.at(-1)[1]);
  }
  if (counts.tests <= 0 || counts.pass !== counts.tests || counts.fail !== 0 ||
      counts.skipped !== 0 || counts.cancelled !== 0 || counts.todo !== 0) {
    throw new Error('T13 RFC test is not a zero-skip pass: ' + JSON.stringify(counts));
  }
  return { command: [...COMMAND], exit_code: 0, counts };
}

export function evidenceProblems(record, current = pinnedFiles()) {
  const out = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return ['record must be an object'];
  if (record.schema !== 'bskel.t13-interface-rfc-evidence/1' || record.task_id !== 'T13-02') out.push('wrong schema or task');
  if (!SHA1.test(record.verified_source_commit ?? '')) out.push('missing exact verified source commit');
  if (!record.source_files || typeof record.source_files !== 'object' || Array.isArray(record.source_files) ||
      JSON.stringify(Object.keys(record.source_files).sort()) !== JSON.stringify([...SOURCE_FILES].sort())) out.push('source file set changed');
  else for (const rel of SOURCE_FILES) {
    if (!SHA256.test(record.source_files[rel] ?? '') || current[rel] !== record.source_files[rel]) out.push('source digest drift: ' + rel);
  }
  if (record.assertions?.MET_delta !== 0 || record.assertions?.release_activation !== false ||
      record.assertions?.independent_review_completed !== false || record.assertions?.runtime_certified !== false) out.push('false authority claim');
  const run = record.observed_run;
  if (!run || JSON.stringify(run.command) !== JSON.stringify(COMMAND) ||
      run.exit_code !== 0 || run.counts?.tests <= 0 ||
      run.counts?.pass !== run.counts?.tests || run.counts?.fail !== 0 ||
      run.counts?.skipped !== 0 || run.counts?.cancelled !== 0 || run.counts?.todo !== 0) out.push('invalid recorded command outcome');
  return out;
}

export function verifyEvidence(record = JSON.parse(fs.readFileSync(RECEIPT, 'utf8')), observed = null) {
  const problems = evidenceProblems(record);
  if (observed && JSON.stringify(record.observed_run) !== JSON.stringify(observed)) problems.push('reproduced command differs from recorded command');
  return problems;
}

function writeEvidence() {
  const observed_run = observeRfcTest();
  const verified_source_commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.match(verified_source_commit, SHA1);
  const record = {
    schema: 'bskel.t13-interface-rfc-evidence/1',
    task_id: 'T13-02',
    verified_source_commit,
    source_files: pinnedFiles(),
    observed_run,
    assertions: { MET_delta: 0, release_activation: false, independent_review_completed: false, runtime_certified: false },
    limits: 'T13 interface and recorded unit checks only; no runtime certification or release. Nested-suite CI, independent review and authorized T00 CAS remain separate gates.',
  };
  assert.deepEqual(verifyEvidence(record, observed_run), []);
  fs.writeFileSync(RECEIPT, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--write') {
      writeEvidence();
      console.log('WROTE source-bound T13 RFC receipt');
    } else if (process.argv[2] === '--check') {
      const observed = observeRfcTest();
      assert.deepEqual(verifyEvidence(undefined, observed), []);
      console.log('PASS T13 RFC source hashes + exact recorded command replay, MET_delta=0');
    } else throw new Error('usage: node test/http-wave-bc/interface-rfc-evidence.mjs --write|--check');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
