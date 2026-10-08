#!/usr/bin/env node
// T00-01 baseline verifier: compares the pinned baseline lock with an observation of the repositories
// (a recorded GitHub observation or local checkouts) and recomputes every fact the lock states about itself.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BASELINE_CODES = [
  'MISSING_REPOSITORY_OBSERVATION', 'DIRTY_CHECKOUT', 'DIRTY_STATE_UNKNOWN', 'DEFAULT_BRANCH_MISMATCH',
  'HEAD_SHA_MISMATCH', 'MISSING_ARTIFACT', 'ARTIFACT_BLOB_MISMATCH',
];
export const RECORD_CODES = ['OBSERVATION_HASH_MISMATCH', 'DERIVED_FACT_MISMATCH'];

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const canonicalSha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

// A repository with no workflow run on its exact head is not "all success": absence is unknown, not success.
export function summarizeCi(runs) {
  const notSuccess = runs
    .filter((r) => r.conclusion !== 'success')
    .map(({ run_id, workflow, event, status, conclusion, created_at, failed_jobs }) => ({ run_id, workflow, event, status, conclusion, created_at, failed_jobs }));
  return { runs_total: runs.length, all_success: runs.length > 0 && notSuccess.length === 0, not_success: notSuccess };
}

export function deriveLockRepository(o) {
  return {
    role: o.role, repo: o.repo, visibility: o.visibility, default_branch: o.default_branch,
    head_sha: o.head_sha, head_committed_at: o.head_committed_at, package: o.package,
    required_artifacts: o.artifacts, ci_on_exact_head: summarizeCi(o.ci_runs_on_exact_head ?? []),
  };
}

const err = (code, role, detail) => ({ code, role, detail });
const find = (list, key, value) => (list ?? []).find((x) => x[key] === value);

export function verifyBaseline(lock, observation, { remote = false } = {}) {
  const errors = [];
  for (const repo of lock.repositories) {
    const o = find(observation.repositories, 'role', repo.role);
    if (!o) { errors.push(err('MISSING_REPOSITORY_OBSERVATION', repo.role, `no observation for ${repo.repo}`)); continue; }
    if (o.dirty === true) errors.push(err('DIRTY_CHECKOUT', repo.role, 'work tree has uncommitted or untracked changes'));
    else if (o.dirty !== false && !remote) errors.push(err('DIRTY_STATE_UNKNOWN', repo.role, `dirty state is ${JSON.stringify(o.dirty ?? null)}, not false`));
    if (o.default_branch !== repo.default_branch) errors.push(err('DEFAULT_BRANCH_MISMATCH', repo.role, `locked ${repo.default_branch}, observed ${o.default_branch}`));
    if (o.head_sha !== repo.head_sha) errors.push(err('HEAD_SHA_MISMATCH', repo.role, `locked ${repo.head_sha}, observed ${o.head_sha}`));
    for (const want of repo.required_artifacts) {
      const got = find(o.artifacts, 'path', want.path);
      if (!got) errors.push(err('MISSING_ARTIFACT', repo.role, want.path));
      else if (got.git_blob_sha !== want.git_blob_sha) errors.push(err('ARTIFACT_BLOB_MISMATCH', repo.role, `${want.path}: locked ${want.git_blob_sha}, observed ${got.git_blob_sha}`));
    }
  }
  return { ok: errors.length === 0, errors };
}

export function verifyLockRecord(lock, observation) {
  const errors = [];
  if (lock.capture?.observation_sha256 !== canonicalSha256(observation)) {
    errors.push(err('OBSERVATION_HASH_MISMATCH', '-', 'lock.capture.observation_sha256 is not the canonical sha256 of the observation'));
  }
  for (const repo of lock.repositories) {
    const o = find(observation.repositories, 'role', repo.role);
    if (!o) continue;
    const want = deriveLockRepository(o);
    for (const key of Object.keys(want)) {
      if (canonicalJson(repo[key]) !== canonicalJson(want[key])) errors.push(err('DERIVED_FACT_MISMATCH', repo.role, `${key} does not match the observation`));
    }
  }
  if (canonicalJson(lock.inventory_pins) !== canonicalJson(observation.inventory)) {
    errors.push(err('DERIVED_FACT_MISMATCH', '-', 'inventory_pins does not match the observation'));
  }
  return { ok: errors.length === 0, errors };
}

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// default_branch here is the checked-out branch (a detached HEAD reads "HEAD"), so a mismatch means "not on the locked branch".
export function observeCheckout(dir, paths) {
  const artifacts = [];
  for (const p of paths) {
    try { artifacts.push({ path: p, git_blob_sha: git(dir, 'rev-parse', '--verify', `HEAD:${p}`) }); } catch { /* absent from HEAD */ }
  }
  return {
    default_branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    head_sha: git(dir, 'rev-parse', 'HEAD'),
    dirty: git(dir, 'status', '--porcelain').length > 0,
    artifacts,
  };
}

const USAGE = `usage: node next/t00/verify-baseline.mjs [--remote] [--record] <lock.json> <observation.json>
       node next/t00/verify-baseline.mjs <lock.json> --checkout <role>=<dir> [--checkout <role>=<dir> ...]
exit codes: 0 verified, 2 verification errors, 1 usage or unreadable input`;

function usage(message) {
  console.error(`${message}\n${USAGE}`);
  return 1;
}

export function runCli(argv) {
  const opts = { remote: false, record: false, checkouts: [], files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--remote') opts.remote = true;
    else if (a === '--record') opts.record = true;
    else if (a === '--checkout') { i += 1; opts.checkouts.push(argv[i] ?? ''); }
    else if (a.startsWith('--')) return usage(`unknown option ${a}`);
    else opts.files.push(a);
  }
  const checkoutMode = opts.checkouts.length > 0;
  if (opts.files.length !== (checkoutMode ? 1 : 2) || (checkoutMode && (opts.remote || opts.record))) {
    return usage('wrong arguments');
  }
  let lock;
  let observation;
  try {
    lock = JSON.parse(fs.readFileSync(opts.files[0], 'utf8'));
    if (checkoutMode) {
      observation = { repositories: opts.checkouts.map((spec) => {
        const [role, dir] = spec.split(/=(.*)/s);
        const repo = find(lock.repositories, 'role', role);
        if (!repo || !dir) throw new Error(`--checkout ${spec}: unknown role or empty directory`);
        return { role, ...observeCheckout(dir, repo.required_artifacts.map((a) => a.path)) };
      }) };
    } else {
      observation = JSON.parse(fs.readFileSync(opts.files[1], 'utf8'));
    }
  } catch (e) {
    return usage(`cannot read input: ${e.message}`);
  }
  const errors = [
    ...verifyBaseline(lock, observation, { remote: opts.remote }).errors,
    ...(opts.record ? verifyLockRecord(lock, observation).errors : []),
  ];
  for (const e of errors) console.log(`FAIL ${e.code} ${e.role} ${e.detail}`);
  if (errors.length === 0) console.log(`OK ${lock.repositories.length} repositories verified`);
  return errors.length === 0 ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
