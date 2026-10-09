#!/usr/bin/env node
// Builds negative-report.json by running the real verify-baseline CLI on mutated copies of the committed lock and
// observation. Nothing in the report is typed by hand: exit codes, error codes and stdout hashes are what the CLI printed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalSha256, deriveLockRepository } from './verify-baseline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'verify-baseline.mjs');
export const REPORT_FILE = path.join(here, 'negative-report.json');
const flip = (hex) => `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const pick = (doc, role) => doc.repositories.find((r) => r.role === role);
const RECORD = ['--remote', '--record'];

export const CASES = [
  { id: 'accept-recorded-observation', mutation: 'none (control)', flags: RECORD, exit: 0, codes: [], mutate() {} },
  { id: 'unknown-dirty-state-in-checkout-mode', mutation: 'none; the GitHub observation is checked without --remote', flags: [], exit: 2, codes: ['DIRTY_STATE_UNKNOWN'], mutate() {} },
  { id: 'dirty-checkout', mutation: 'observation: bskel dirty set to true', flags: ['--remote'], exit: 2, codes: ['DIRTY_CHECKOUT'], mutate: (l, o) => { pick(o, 'bskel').dirty = true; } },
  { id: 'missing-repository-observation', mutation: 'observation: becoder entry removed', flags: ['--remote'], exit: 2, codes: ['MISSING_REPOSITORY_OBSERVATION'], mutate: (l, o) => { o.repositories = o.repositories.filter((r) => r.role !== 'becoder'); } },
  { id: 'default-branch-mismatch', mutation: 'observation: beval default_branch set to develop', flags: ['--remote'], exit: 2, codes: ['DEFAULT_BRANCH_MISMATCH'], mutate: (l, o) => { pick(o, 'beval').default_branch = 'develop'; } },
  { id: 'head-sha-mismatch', mutation: 'observation: becoder head_sha first hex digit changed', flags: ['--remote'], exit: 2, codes: ['HEAD_SHA_MISMATCH'], mutate: (l, o) => { const r = pick(o, 'becoder'); r.head_sha = flip(r.head_sha); } },
  { id: 'missing-artifact', mutation: 'observation: bskel package-lock.json removed', flags: ['--remote'], exit: 2, codes: ['MISSING_ARTIFACT'], mutate: (l, o) => { const r = pick(o, 'bskel'); r.artifacts = r.artifacts.filter((a) => a.path !== 'package-lock.json'); } },
  { id: 'artifact-blob-mismatch', mutation: 'observation: bskel ci.yml blob first hex digit changed', flags: ['--remote'], exit: 2, codes: ['ARTIFACT_BLOB_MISMATCH'], mutate: (l, o) => { const a = pick(o, 'bskel').artifacts.find((x) => x.path === '.github/workflows/ci.yml'); a.git_blob_sha = flip(a.git_blob_sha); } },
  { id: 'recorded-observation-hash-changed', mutation: 'lock: capture.observation_sha256 first hex digit changed', flags: RECORD, exit: 2, codes: ['OBSERVATION_HASH_MISMATCH'], mutate: (l) => { l.capture.observation_sha256 = flip(l.capture.observation_sha256); } },
  { id: 'ci-success-claimed-for-a-failing-head', mutation: 'lock: beval ci_on_exact_head.all_success set to true', flags: RECORD, exit: 2, codes: ['DERIVED_FACT_MISMATCH'], mutate: (l) => { pick(l, 'beval').ci_on_exact_head.all_success = true; } },
  { id: 'package-version-claim-changed', mutation: 'lock: becoder package.version set to 9.9.9', flags: RECORD, exit: 2, codes: ['DERIVED_FACT_MISMATCH'], mutate: (l) => { pick(l, 'becoder').package.version = '9.9.9'; } },
  { id: 'observation-edited-after-capture', mutation: 'observation: becoder head_sha changed, lock untouched', flags: RECORD, exit: 2, codes: ['DERIVED_FACT_MISMATCH', 'HEAD_SHA_MISMATCH', 'OBSERVATION_HASH_MISMATCH'], mutate: (l, o) => { const r = pick(o, 'becoder'); r.head_sha = flip(r.head_sha); } },
  { id: 'lock-drops-a-required-repository', mutation: 'lock: beval entry removed, observation untouched', flags: RECORD, exit: 2, codes: ['DERIVED_FACT_MISMATCH', 'REPOSITORY_SET_MISMATCH'], mutate: (l) => { l.repositories = l.repositories.filter((r) => r.role !== 'beval'); } },
  { id: 'lock-and-observation-consistently-drop-a-repository', mutation: 'lock and observation: beval removed (repositories and inventory pins), lock pins and observation hash recomputed', flags: RECORD, exit: 2, codes: ['REPOSITORY_SET_MISMATCH'], mutate: (l, o) => { for (const doc of [l, o]) doc.repositories = doc.repositories.filter((r) => r.role !== 'beval'); o.inventory.pins = o.inventory.pins.filter((p) => p.role !== 'beval'); l.inventory_pins = structuredClone(o.inventory); l.capture.observation_sha256 = canonicalSha256(o); } },
  { id: 'lock-repository-renamed', mutation: 'lock: beval repo set to someone-else/Backend-evaluation', flags: ['--remote'], exit: 2, codes: ['REPOSITORY_SET_MISMATCH'], mutate: (l) => { pick(l, 'beval').repo = 'someone-else/Backend-evaluation'; } },
  { id: 'observation-adds-an-unknown-repository', mutation: 'observation: a fourth entry with role gamma added', flags: ['--remote'], exit: 2, codes: ['REPOSITORY_SET_MISMATCH'], mutate: (l, o) => { o.repositories.push({ ...structuredClone(pick(o, 'bskel')), role: 'gamma' }); } },
  { id: 'ci-runs-truncated-lock-and-hash-rebuilt', mutation: 'observation: the failed bskel runs removed (as if only some pages were read), lock CI facts and observation hash recomputed to match', flags: RECORD, exit: 2, codes: ['CI_RUNS_INCOMPLETE'], mutate: (l, o) => { const r = pick(o, 'bskel'); r.ci_runs_on_exact_head = r.ci_runs_on_exact_head.filter((x) => x.conclusion === 'success'); Object.assign(pick(l, 'bskel'), deriveLockRepository(r)); l.capture.observation_sha256 = canonicalSha256(o); } },
  { id: 'observation-without-a-run-count', mutation: 'observation: becoder ci_runs_total_count removed, observation hash recomputed', flags: RECORD, exit: 2, codes: ['CI_RUNS_INCOMPLETE'], mutate: (l, o) => { delete pick(o, 'becoder').ci_runs_total_count; l.capture.observation_sha256 = canonicalSha256(o); } },
  { id: 'observation-page-count-inconsistent', mutation: 'observation: beval ci_runs_pages set to 2 for 8 runs, observation hash recomputed', flags: RECORD, exit: 2, codes: ['CI_RUNS_INCOMPLETE'], mutate: (l, o) => { pick(o, 'beval').ci_runs_pages = 2; l.capture.observation_sha256 = canonicalSha256(o); } },
  { id: 'lock-and-observation-both-lack-a-head-sha', mutation: 'lock and observation: bskel head_sha removed from both', flags: ['--remote'], exit: 2, codes: ['MALFORMED_RECORD'], mutate: (l, o) => { delete pick(l, 'bskel').head_sha; delete pick(o, 'bskel').head_sha; } },
  { id: 'lock-empties-the-required-artifacts', mutation: 'lock: bskel required_artifacts set to an empty list', flags: ['--remote'], exit: 2, codes: ['MALFORMED_RECORD'], mutate: (l) => { pick(l, 'bskel').required_artifacts = []; } },
  { id: 'lock-and-observation-both-drop-the-beval-pin', mutation: 'lock and observation: the beval inventory pin removed from both, observation hash recomputed', flags: RECORD, exit: 2, codes: ['REPOSITORY_SET_MISMATCH'], mutate: (l, o) => { o.inventory.pins = o.inventory.pins.filter((p) => p.role !== 'beval'); l.inventory_pins = structuredClone(o.inventory); l.capture.observation_sha256 = canonicalSha256(o); } },
  { id: 'lock-schema-changed', mutation: 'lock: schema set to bskel.t00-baseline-lock/2', flags: RECORD, exit: 2, codes: ['DERIVED_FACT_MISMATCH'], mutate: (l) => { l.schema = 'bskel.t00-baseline-lock/2'; } },
  { id: 'lock-task-id-changed', mutation: 'lock: task_id set to T00-99', flags: RECORD, exit: 2, codes: ['DERIVED_FACT_MISMATCH'], mutate: (l) => { l.task_id = 'T00-99'; } },
  { id: 'lock-observed-at-changed', mutation: 'lock: capture.observed_at set to 2026-01-01T00:00:00.000Z', flags: RECORD, exit: 2, codes: ['DERIVED_FACT_MISMATCH'], mutate: (l) => { l.capture.observed_at = '2026-01-01T00:00:00.000Z'; } },
  { id: 'lock-required-artifacts-deleted', mutation: 'lock: bskel required_artifacts removed', flags: ['--remote'], exit: 2, codes: ['MALFORMED_RECORD'], mutate: (l) => { delete pick(l, 'bskel').required_artifacts; } },
  { id: 'lock-required-artifacts-is-a-string', mutation: 'lock: bskel required_artifacts set to the string package.json', flags: ['--remote'], exit: 2, codes: ['MALFORMED_RECORD'], mutate: (l) => { pick(l, 'bskel').required_artifacts = 'package.json'; } },
  { id: 'usage-error', mutation: 'no arguments', flags: [], noFiles: true, exit: 1, codes: [], mutate() {} },
];

function runCase(c, lock0, obs0, dir) {
  const lock = structuredClone(lock0);
  const obs = structuredClone(obs0);
  c.mutate(lock, obs);
  const lockFile = path.join(dir, 'lock.json');
  const obsFile = path.join(dir, 'observation.json');
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  fs.writeFileSync(obsFile, JSON.stringify(obs));
  const res = spawnSync(process.execPath, [CLI, ...(c.noFiles ? [] : [...c.flags, lockFile, obsFile])], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  const lines = res.stdout.split('\n').filter(Boolean);
  const codes = [...new Set(lines.filter((l) => l.startsWith('FAIL ')).map((l) => l.split(' ')[1]))].sort();
  if (res.status !== c.exit || JSON.stringify(codes) !== JSON.stringify(c.codes)) {
    throw new Error(`${c.id}: expected exit ${c.exit} codes ${c.codes}, the CLI gave exit ${res.status} codes ${codes}`);
  }
  return {
    id: c.id,
    mutation: c.mutation,
    command: ['node', 'next/t00/verify-baseline.mjs', ...(c.noFiles ? [] : [...c.flags, '<lock.json>', '<observation.json>'])].join(' '),
    exit_code: res.status,
    codes,
    stdout_first_line: lines[0] ?? '',
    stdout_sha256: sha256(res.stdout),
  };
}

export function buildReport() {
  const lock = JSON.parse(fs.readFileSync(path.join(here, 'baseline.lock.json'), 'utf8'));
  const obs = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'observation.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't00-negative-'));
  try {
    return {
      schema: 'bskel.t00-negative-report/1',
      task_id: 'T00-01',
      generator: 'node next/t00/make-negative-report.mjs --write',
      lock_sha256: canonicalSha256(lock),
      observation_sha256: canonicalSha256(obs),
      cases: CASES.map((c) => runCase(c, lock, obs, dir)),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function verifyReport(report, fresh = buildReport()) {
  const errors = [];
  for (const key of ['schema', 'task_id', 'generator', 'lock_sha256', 'observation_sha256']) {
    if (report[key] !== fresh[key]) errors.push(`${key} differs from the recomputed value`);
  }
  if (report.cases?.length !== fresh.cases.length) errors.push('case count differs from the recomputed report');
  fresh.cases.forEach((want, i) => {
    for (const key of Object.keys(want)) {
      if (JSON.stringify(report.cases?.[i]?.[key]) !== JSON.stringify(want[key])) errors.push(`case ${want.id}: ${key} differs from the recomputed value`);
    }
  });
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const mode = process.argv[2];
  if (mode === '--write') {
    fs.writeFileSync(REPORT_FILE, `${JSON.stringify(buildReport(), null, 2)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), REPORT_FILE)}`);
  } else if (mode === '--check') {
    const errors = verifyReport(JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8')));
    for (const e of errors) console.log(`FAIL ${e}`);
    if (errors.length === 0) console.log('OK negative-report.json equals the recomputed report');
    process.exitCode = errors.length === 0 ? 0 : 2;
  } else {
    console.error('usage: node next/t00/make-negative-report.mjs --write | --check');
    process.exitCode = 1;
  }
}
