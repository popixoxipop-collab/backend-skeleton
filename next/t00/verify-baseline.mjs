#!/usr/bin/env node
// T00-01 baseline verifier: compares the pinned baseline lock with an observation of the repositories
// (a recorded GitHub observation or local checkouts) and recomputes every fact the lock states about itself.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// The baseline is exactly these repositories. The set is fixed here and not read from the lock or the observation, so a
// file that dropped, repeated, renamed or added a repository cannot verify the rest.
export const REQUIRED_REPOSITORIES = [
  { role: 'bskel', repo: 'popixoxipop-collab/backend-skeleton' },
  { role: 'becoder', repo: 'popixoxipop-collab/backend-decoder' },
  { role: 'beval', repo: 'popixoxipop-collab/Backend-evaluation' },
];
export const REQUIRED_ARTIFACT_PATHS = ['package.json', 'package-lock.json', '.github/workflows/ci.yml'];
export const RUNS_PAGE_SIZE = 100; // GitHub caps per_page at 100
export const OBSERVATION_FILE = 'next/t00/fixtures/observation.json';
export const OBSERVATION_SCHEMA = 'bskel.t00-observation/1';
export const BASELINE_CODES = [
  'MISSING_REPOSITORY_OBSERVATION', 'REPOSITORY_SET_MISMATCH', 'MALFORMED_RECORD', 'DIRTY_CHECKOUT', 'DIRTY_STATE_UNKNOWN',
  'DEFAULT_BRANCH_MISMATCH', 'HEAD_SHA_MISMATCH', 'MISSING_ARTIFACT', 'ARTIFACT_BLOB_MISMATCH',
];
export const RECORD_CODES = ['OBSERVATION_HASH_MISMATCH', 'DERIVED_FACT_MISMATCH', 'CI_RUNS_INCOMPLETE'];

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

// The whole lock as the builder emits it. The verifier calls the same function, so every field outside the hand-written
// `limits` is compared with what this observation derives, not just the repository and inventory sections.
export function deriveLock(observation, limits) {
  return {
    schema: 'bskel.t00-baseline-lock/1',
    task_id: 'T00-01',
    repositories: observation.repositories.map(deriveLockRepository),
    inventory_pins: observation.inventory,
    capture: {
      observed_at: observation.observed_at,
      observation_file: OBSERVATION_FILE,
      observation_sha256: canonicalSha256(observation),
      observation_sha256_method: 'sha256 of canonical JSON (object keys sorted, no whitespace), so line endings do not change it',
      commands: [`node next/t00/capture-observation.mjs ${OBSERVATION_FILE}`],
    },
    limits,
  };
}

const err = (code, role, detail) => ({ code, role, detail });
const plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const objects = (x) => (Array.isArray(x) ? x.filter(plain) : []);
const find = (items, key, value) => objects(items).find((x) => x[key] === value);
const text = (v) => typeof v === 'string' && v !== '';
const textList = (v) => Array.isArray(v) && v.every(text);
const count = (v) => Number.isInteger(v) && v >= 0;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const matches = (re, v) => typeof v === 'string' && re.test(v);
const differing = (have, want) => [...new Set([...Object.keys(have), ...Object.keys(want)])].filter((k) => canonicalJson(have[k]) !== canonicalJson(want[k]));

// Nothing below may assume a shape: both documents are objects with a repositories list of objects that name a role.
function structureErrors(lock, observation) {
  const errors = [];
  for (const [what, doc] of [['lock', lock], ['observation', observation]]) {
    if (!plain(doc) || !Array.isArray(doc.repositories)) errors.push(err('MALFORMED_RECORD', '-', `the ${what} is not an object with a repositories list`));
    else doc.repositories.forEach((r, i) => { if (!plain(r) || typeof r.role !== 'string') errors.push(err('MALFORMED_RECORD', '-', `the ${what} entry repositories[${i}] is not an object with a role`)); });
  }
  return errors;
}

// The lock pins each required repository once under its required name; the observation holds none twice or unknown.
// An observation that lacks a locked role is reported as MISSING_REPOSITORY_OBSERVATION below, not here.
function repositorySetErrors(lock, observation) {
  const errors = [];
  const bad = (role, detail) => errors.push(err('REPOSITORY_SET_MISMATCH', role, detail));
  for (const want of REQUIRED_REPOSITORIES) {
    const pinned = lock.repositories.filter((r) => r.role === want.role);
    if (pinned.length !== 1) bad(want.role, `the lock pins ${want.role} ${pinned.length} times, expected once`);
    else if (pinned[0].repo !== want.repo) bad(want.role, `the lock pins ${want.role} as ${JSON.stringify(pinned[0].repo)}, expected ${want.repo}`);
    const seen = observation.repositories.filter((r) => r.role === want.role);
    if (seen.length > 1) bad(want.role, `the observation holds ${want.role} ${seen.length} times`);
    else if (seen.length === 1 && seen[0].repo !== undefined && seen[0].repo !== want.repo) bad(want.role, `the observation has ${want.role} as ${JSON.stringify(seen[0].repo)}, expected ${want.repo}`);
  }
  for (const [what, list] of [['lock', lock.repositories], ['observation', observation.repositories]]) {
    for (const r of list) {
      if (!REQUIRED_REPOSITORIES.some((want) => want.role === r.role)) bad(String(r.role), `the ${what} holds ${JSON.stringify(r.role)}, which is not part of the baseline`);
    }
  }
  return errors;
}

// Every field the comparison reads must be present and well formed on both sides: two records that both lack a field
// would otherwise compare equal (undefined === undefined), and a lock whose artifact list was emptied would check nothing.
function shapeErrors(lock, observation) {
  const errors = [];
  const bad = (role, detail) => errors.push(err('MALFORMED_RECORD', String(role), detail));
  const blobs = (what, role, items) => {
    if (!Array.isArray(items)) { bad(role, `${what}: the artifact list is missing`); return; }
    for (const a of items) if (!plain(a) || typeof a.path !== 'string' || !matches(SHA, a.git_blob_sha)) bad(role, `${what}: artifact ${JSON.stringify(a?.path)} has no 40-hex git_blob_sha`);
    if (what === 'observation') {
      const paths = items.map((a) => a?.path);
      for (const p of paths) if (!REQUIRED_ARTIFACT_PATHS.includes(p)) bad(role, `observation: ${JSON.stringify(p)} is not a baseline artifact`);
      if (new Set(paths).size !== paths.length) bad(role, 'observation: an artifact path is listed twice');
    }
  };
  for (const [what, items] of [['lock', lock.repositories], ['observation', observation.repositories]]) {
    for (const r of items) {
      if (!text(r.default_branch)) bad(r.role, `${what}: default_branch is missing`);
      if (!matches(SHA, r.head_sha)) bad(r.role, `${what}: head_sha is not 40 hex digits`);
      blobs(what, r.role, what === 'lock' ? r.required_artifacts : r.artifacts);
    }
  }
  for (const r of lock.repositories) {
    const paths = Array.isArray(r.required_artifacts) ? r.required_artifacts.map((a) => a?.path) : [];
    if (canonicalJson([...paths].sort()) !== canonicalJson([...REQUIRED_ARTIFACT_PATHS].sort())) bad(r.role, `lock: required_artifacts lists [${paths}], expected exactly [${REQUIRED_ARTIFACT_PATHS}]`);
  }
  return errors;
}

export function verifyBaseline(lock, observation, { remote = false } = {}) {
  const structural = structureErrors(lock, observation);
  if (structural.length > 0) return { ok: false, errors: structural };
  const errors = [...repositorySetErrors(lock, observation), ...shapeErrors(lock, observation)];
  for (const repo of lock.repositories) {
    const o = find(observation.repositories, 'role', repo.role);
    if (!o) { errors.push(err('MISSING_REPOSITORY_OBSERVATION', repo.role, `no observation for ${repo.repo}`)); continue; }
    if (o.dirty === true) errors.push(err('DIRTY_CHECKOUT', repo.role, 'work tree has uncommitted or untracked changes'));
    else if (o.dirty !== false && !remote) errors.push(err('DIRTY_STATE_UNKNOWN', repo.role, `dirty state is ${JSON.stringify(o.dirty ?? null)}, not false`));
    if (o.default_branch !== repo.default_branch) errors.push(err('DEFAULT_BRANCH_MISMATCH', repo.role, `locked ${repo.default_branch}, observed ${o.default_branch}`));
    if (o.head_sha !== repo.head_sha) errors.push(err('HEAD_SHA_MISMATCH', repo.role, `locked ${repo.head_sha}, observed ${o.head_sha}`));
    for (const want of objects(repo.required_artifacts)) { // a list that is not a list was reported by shapeErrors
      const got = find(o.artifacts, 'path', want.path);
      if (!got) errors.push(err('MISSING_ARTIFACT', repo.role, want.path));
      else if (got.git_blob_sha !== want.git_blob_sha) errors.push(err('ARTIFACT_BLOB_MISMATCH', repo.role, `${want.path}: locked ${want.git_blob_sha}, observed ${got.git_blob_sha}`));
    }
  }
  return { ok: errors.length === 0, errors };
}

// A recorded observation must carry every field the lock derives from; a missing field is not "equal to its twin".
function observationErrors(observation) {
  const errors = [];
  const bad = (role, detail) => errors.push(err('MALFORMED_RECORD', role, `observation: ${detail}`));
  if (observation.schema !== OBSERVATION_SCHEMA) bad('-', `schema is ${JSON.stringify(observation.schema ?? null)}, expected ${OBSERVATION_SCHEMA}`);
  if (!matches(UTC, observation.observed_at)) bad('-', 'observed_at is not a UTC timestamp');
  for (const r of observation.repositories) {
    if (!['public', 'private'].includes(r.visibility)) bad(r.role, 'visibility is neither public nor private');
    if (!matches(UTC, r.head_committed_at)) bad(r.role, 'head_committed_at is not a UTC timestamp');
    const p = r.package;
    if (!plain(p) || !text(p.name) || !text(p.version) || !(p.node_engine === null || text(p.node_engine)) || !textList(p.script_names) || !matches(SHA256, p.scripts_sha256)) {
      bad(r.role, 'package needs a name, a version, node_engine (text or null), script_names and a 64-hex scripts_sha256');
    }
    if (!Array.isArray(r.ci_runs_on_exact_head)) { bad(r.role, 'ci_runs_on_exact_head is not a list'); continue; }
    for (const run of r.ci_runs_on_exact_head) {
      const jobsOk = plain(run) && Array.isArray(run.failed_jobs) && run.failed_jobs.every((j) => plain(j) && text(j.name) && text(j.conclusion) && textList(j.failed_steps) && textList(j.unfinished_steps));
      if (!jobsOk || !count(run.run_id) || !text(run.workflow) || !text(run.event) || !text(run.status) || !(run.conclusion === null || text(run.conclusion)) || !matches(UTC, run.created_at)) {
        bad(r.role, `run ${JSON.stringify(run?.run_id ?? null)} lacks a field the CI summary reads`);
      }
    }
  }
  return errors;
}

// The pins say how far each repository moved since the release inventory last pinned it; the baseline has one per role.
const PIN_STATUS = ['identical', 'ahead', 'behind', 'diverged'];
function inventoryErrors(what, inventory) {
  const errors = [];
  const bad = (role, detail) => errors.push(err('MALFORMED_RECORD', role, `${what} inventory: ${detail}`));
  if (!plain(inventory) || !plain(inventory.source) || !Array.isArray(inventory.pins)) return [err('MALFORMED_RECORD', '-', `${what} inventory needs a source object and a pins list`)];
  const s = inventory.source;
  if (!text(s.repo) || !text(s.path) || !matches(SHA, s.ref) || !matches(SHA, s.git_blob_sha) || !text(s.pin_field)) bad('-', 'source needs repo, path, a 40-hex ref, a 40-hex git_blob_sha and pin_field');
  for (const want of REQUIRED_REPOSITORIES) {
    const n = inventory.pins.filter((p) => plain(p) && p.role === want.role).length;
    if (n !== 1) errors.push(err('REPOSITORY_SET_MISMATCH', want.role, `the ${what} inventory pins ${want.role} ${n} times, expected once`));
  }
  for (const p of inventory.pins) {
    if (!plain(p) || !REQUIRED_REPOSITORIES.some((want) => want.role === p.role)) errors.push(err('REPOSITORY_SET_MISMATCH', String(p?.role), `the ${what} inventory holds a pin for ${JSON.stringify(p?.role ?? null)}, which is not part of the baseline`));
    else if (!matches(SHA, p.pinned_sha) || !PIN_STATUS.includes(p.compare_status) || !count(p.head_ahead_by) || !count(p.head_behind_by)) bad(p.role, 'a pin needs a 40-hex pinned_sha, a compare_status and non-negative head_ahead_by and head_behind_by');
  }
  return errors;
}

const limitsErrors = (limits) => (Array.isArray(limits) && limits.length > 0 && limits.every(text) ? [] : [err('MALFORMED_RECORD', '-', 'lock: limits must be a non-empty list of statements')]);

export function verifyLockRecord(lock, observation) {
  const structural = structureErrors(lock, observation);
  if (structural.length > 0) return { ok: false, errors: structural };
  const errors = [];
  if (lock.capture?.observation_sha256 !== canonicalSha256(observation)) {
    errors.push(err('OBSERVATION_HASH_MISMATCH', '-', 'lock.capture.observation_sha256 is not the canonical sha256 of the observation'));
  }
  const malformed = observationErrors(observation);
  errors.push(...malformed, ...inventoryErrors('lock', lock.inventory_pins), ...inventoryErrors('observation', observation.inventory), ...limitsErrors(lock.limits));
  if (malformed.length > 0) return { ok: false, errors }; // facts derived from an observation that lacks fields would mean nothing
  const roles = (doc) => doc.repositories.map((r) => r.role).sort();
  if (canonicalJson(roles(lock)) !== canonicalJson(roles(observation))) {
    errors.push(err('DERIVED_FACT_MISMATCH', '-', `repositories: the lock pins [${roles(lock)}], the observation holds [${roles(observation)}]`));
  }
  for (const o of observation.repositories) {
    const listed = o.ci_runs_on_exact_head;
    const pages = Math.max(1, Math.ceil(listed.length / RUNS_PAGE_SIZE));
    if (o.ci_runs_total_count !== listed.length || o.ci_runs_pages !== pages) {
      errors.push(err('CI_RUNS_INCOMPLETE', o.role, `the capture recorded ${JSON.stringify(o.ci_runs_total_count ?? null)} runs read in ${JSON.stringify(o.ci_runs_pages ?? null)} page(s); the observation lists ${listed.length} runs, which take ${pages} page(s)`));
    }
  }
  const want = deriveLock(observation, lock.limits);
  for (const wantRepo of want.repositories) {
    const repo = find(lock.repositories, 'role', wantRepo.role);
    if (!repo) continue; // the role lists differ, reported above
    for (const key of differing(repo, wantRepo)) errors.push(err('DERIVED_FACT_MISMATCH', repo.role, `${key} ${key in wantRepo ? 'does not match the observation' : 'is not a field the builder emits'}`));
  }
  for (const key of differing(lock, want)) {
    if (key === 'repositories') continue; // compared per repository above
    if (key === 'capture' && plain(lock.capture)) {
      for (const k of differing(lock.capture, want.capture)) if (k !== 'observation_sha256') errors.push(err('DERIVED_FACT_MISMATCH', '-', `capture.${k} is not what the builder derives from this observation`));
    } else {
      errors.push(err('DERIVED_FACT_MISMATCH', '-', `${key} ${key in want ? 'does not match the observation' : 'is not a field the builder emits'}`));
    }
  }
  return { ok: errors.length === 0, errors };
}

// GIT_DIR, GIT_WORK_TREE and friends (set when a hook runs the tests) would redirect `git -C <dir>` to another repository;
// --untracked-files=all keeps a user's status.showUntrackedFiles setting from hiding stray files.
export const cleanGitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: cleanGitEnv() }).trim();

// default_branch here is the checked-out branch (a detached HEAD reads "HEAD"), so a mismatch means "not on the locked branch".
export function observeCheckout(dir, paths) {
  const artifacts = [];
  for (const p of paths) {
    try { artifacts.push({ path: p, git_blob_sha: git(dir, 'rev-parse', '--verify', `HEAD:${p}`) }); } catch { /* absent from HEAD */ }
  }
  return {
    default_branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    head_sha: git(dir, 'rev-parse', 'HEAD'),
    dirty: git(dir, 'status', '--porcelain', '--untracked-files=all').length > 0,
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
  const needRepositories = (doc, what) => { if (!Array.isArray(doc?.repositories)) throw new Error(`${what} has no repositories array`); };
  try {
    lock = JSON.parse(fs.readFileSync(opts.files[0], 'utf8'));
    needRepositories(lock, 'the lock');
    if (checkoutMode) {
      observation = { repositories: opts.checkouts.map((spec) => {
        const [role, dir] = spec.split(/=(.*)/s);
        if (!REQUIRED_REPOSITORIES.some((r) => r.role === role) || !dir) throw new Error(`--checkout ${spec}: unknown role or empty directory`);
        return { role, ...observeCheckout(dir, REQUIRED_ARTIFACT_PATHS) };
      }) };
    } else {
      observation = JSON.parse(fs.readFileSync(opts.files[1], 'utf8'));
      needRepositories(observation, 'the observation');
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
