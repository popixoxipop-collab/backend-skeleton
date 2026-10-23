// T14-02: exact-source RFC check receipt; it NEVER adjudicates MET or release.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RECEIPT = path.join(ROOT, 'next/t14/INTERFACE_RFC_EVIDENCE.json');
export const SOURCE_FILES = Object.freeze([
  'handles/composition-next/INTERFACE_RFC.md',
  'test/provider-composition-next/interface-rfc.vocabulary.json',
  'test/provider-composition-next/interface-rfc.test.mjs',
  'test/provider-composition-next/interface-rfc-coercion.test.mjs',
  'test/provider-composition-next/baseline-record.test.mjs',
  'test/provider-composition-next/baseline-record-lib.mjs',
  'test/provider-composition-next/interface-rfc-evidence.mjs',
  'test/provider-composition-next/interface-rfc-evidence.test.mjs',
]);
export const COMMAND = Object.freeze([
  'node', '--test',
  'test/provider-composition-next/interface-rfc.test.mjs',
  'test/provider-composition-next/interface-rfc-coercion.test.mjs',
]);
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const KEYS = ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'];
const sourceHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

export function pinnedFiles() {
  return Object.fromEntries(SOURCE_FILES.map((rel) => [rel, sourceHash(fs.readFileSync(path.join(ROOT, rel)))]));
}

export function observe() {
  const childEnv = { ...process.env, NODE_OPTIONS: '' };
  for (const key of Object.keys(childEnv)) if (key.startsWith('NODE_TEST_')) delete childEnv[key];
  const output = spawnSync(process.execPath, COMMAND.slice(1), {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: childEnv,
  });
  if (output.error || output.signal !== null || output.status !== 0) {
    throw new Error('T14 RFC evidence command failed: ' + JSON.stringify({
      signal: output.signal, exit_code: output.status, error: output.error?.message,
      stdout_tail: output.stdout?.slice(-1200), stderr_tail: output.stderr?.slice(-1200),
    }));
  }
  const raw = (output.stdout ?? '') + '\n' + (output.stderr ?? '');
  const counts = {};
  for (const key of KEYS) {
    const lines = [...raw.matchAll(new RegExp('(?:^|\\n)(?:#|ℹ)\\s*' + key + '\\s+(\\d+)\\s*(?=\\r?\\n|$)', 'g'))];
    if (lines.length === 0) throw new Error('missing command summary ' + key);
    counts[key] = Number(lines.at(-1)[1]);
  }
  if (!Number.isSafeInteger(counts.tests) || counts.tests < 1 ||
      counts.pass !== counts.tests || counts.fail !== 0 ||
      counts.skipped !== 0 || counts.cancelled !== 0 || counts.todo !== 0) {
    throw new Error('T14 RFC command is not a zero-skip pass: ' + JSON.stringify(counts));
  }
  return { command: [...COMMAND], exit_code: 0, counts };
}

export function evidenceProblems(record, currentFiles = pinnedFiles()) {
  const bad = [];
  if (!exactKeys(record, ['schema', 'task_id', 'verified_source_commit', 'source_files',
    'observed_run', 'assertions', 'scope_limit'])) return ['invalid receipt field set'];
  if (record.schema !== 'bskel.t14-interface-rfc-evidence/1' || record.task_id !== 'T14-02') {
    bad.push('wrong schema or task');
  }
  if (!SHA1.test(record.verified_source_commit)) bad.push('invalid exact source commit');
  if (!exactKeys(record.source_files, SOURCE_FILES)) bad.push('missing or extra source file pins');
  else for (const rel of SOURCE_FILES) {
    if (!SHA256.test(record.source_files[rel]) || currentFiles[rel] !== record.source_files[rel]) {
      bad.push('source hash drift ' + rel);
    }
  }
  if (!exactKeys(record.assertions, ['official_MET_delta', 'auto_promote_MET',
    'release_activation', 'signed_independent_review', 'runtime_certified']) ||
    record.assertions.official_MET_delta !== 0 ||
    record.assertions.auto_promote_MET !== false ||
    record.assertions.release_activation !== false ||
    record.assertions.signed_independent_review !== false ||
    record.assertions.runtime_certified !== false) bad.push('false MET, reviewer or release claim');
  const run = record.observed_run;
  if (!exactKeys(run, ['command', 'exit_code', 'counts']) ||
      JSON.stringify(run.command) !== JSON.stringify(COMMAND) || run.exit_code !== 0 ||
      !exactKeys(run.counts, KEYS) ||
      !KEYS.every((key) => Number.isSafeInteger(run.counts[key]) && run.counts[key] >= 0) ||
      run.counts.tests < 1 || run.counts.pass !== run.counts.tests ||
      run.counts.fail !== 0 || run.counts.skipped !== 0 ||
      run.counts.cancelled !== 0 || run.counts.todo !== 0) bad.push('invalid recorded command');
  if (typeof record.scope_limit !== 'string' || !record.scope_limit.includes('not runtime certified')) {
    bad.push('missing limited scope');
  }
  return bad;
}

export function verify(record = JSON.parse(fs.readFileSync(RECEIPT, 'utf8')), replay = null) {
  const bad = evidenceProblems(record);
  if (replay && JSON.stringify(record.observed_run) !== JSON.stringify(replay)) {
    bad.push('fresh command replay differs from committed evidence');
  }
  return bad;
}

function write() {
  const observed_run = observe();
  const verified_source_commit = execFileSync('git', ['rev-parse', 'HEAD'],
    { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.match(verified_source_commit, SHA1);
  const record = {
    schema: 'bskel.t14-interface-rfc-evidence/1',
    task_id: 'T14-02',
    verified_source_commit,
    source_files: pinnedFiles(),
    observed_run,
    assertions: { official_MET_delta: 0, auto_promote_MET: false,
      release_activation: false, signed_independent_review: false, runtime_certified: false },
    scope_limit: 'Interface RFC wording and source-hash replay only; not runtime certified, merged or approved.',
  };
  assert.deepEqual(verify(record, observed_run), []);
  fs.mkdirSync(path.dirname(RECEIPT), { recursive: true });
  fs.writeFileSync(RECEIPT, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (mode === '--write') {
      write();
      console.log('WROTE T14 source-bound RFC command evidence');
    } else if (mode === '--check') {
      assert.deepEqual(verify(undefined, observe()), []);
      console.log('PASS T14 source-bound RFC replay; MET_delta=0, review_and_release=false');
    } else throw new Error('usage: node test/provider-composition-next/interface-rfc-evidence.mjs --write|--check');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
