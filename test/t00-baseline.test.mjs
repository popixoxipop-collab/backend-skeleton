// T00-01: every fact in next/t00/baseline.lock.json is recomputed here from the committed files, from real git
// repositories, or from git objects of the locked bskel head. A commit this checkout lacks is fetched; if it cannot be
// obtained the test fails, it never skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLock } from '../next/t00/build-lock.mjs';
import { ARTIFACT_PATHS, captureObservation } from '../next/t00/capture-observation.mjs';
import { CASES, buildReport, verifyReport } from '../next/t00/make-negative-report.mjs';
import { BASELINE_CODES, RECORD_CODES, canonicalSha256, deriveLockRepository, observeCheckout, summarizeCi, verifyBaseline, verifyLockRecord } from '../next/t00/verify-baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T00 = path.join(ROOT, 'next', 't00');
const CLI = path.join(T00, 'verify-baseline.mjs');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));
const lock = readJson(T00, 'baseline.lock.json');
const observation = readJson(ROOT, lock.capture.observation_file);
const report = readJson(T00, 'negative-report.json');
const readme = fs.readFileSync(path.join(T00, 'README.md'), 'utf8');
const byRole = (doc, role) => doc.repositories.find((r) => r.role === role);
const flip = (hex) => `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`;
const failCodes = (stdout) => [...new Set(stdout.split('\n').filter((l) => l.startsWith('FAIL ')).map((l) => l.split(' ')[1]))].sort();
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('the lock is rebuilt from the recorded observation, and every hash and derived fact is recomputed', () => {
  assert.equal(path.resolve(ROOT, lock.capture.observation_file), path.join(T00, 'fixtures', 'observation.json'));
  assert.equal(lock.capture.observation_sha256, canonicalSha256(observation));
  assert.deepEqual(buildLock(observation, lock.limits), lock);
  assert.deepEqual(verifyLockRecord(lock, observation), { ok: true, errors: [] });
  assert.deepEqual(verifyBaseline(lock, observation, { remote: true }), { ok: true, errors: [] });
  assert.deepEqual(verifyBaseline(lock, observation).errors.map((e) => e.code), ['DIRTY_STATE_UNKNOWN', 'DIRTY_STATE_UNKNOWN', 'DIRTY_STATE_UNKNOWN']);
  for (const repo of lock.repositories) {
    assert.match(repo.head_sha, /^[0-9a-f]{40}$/);
    assert.deepEqual(repo.required_artifacts.map((a) => a.path), ARTIFACT_PATHS);
    for (const a of repo.required_artifacts) assert.match(a.git_blob_sha, /^[0-9a-f]{40}$/);
  }
  for (const pin of lock.inventory_pins.pins) {
    const status = pin.head_ahead_by && pin.head_behind_by ? 'diverged' : pin.head_ahead_by ? 'ahead' : pin.head_behind_by ? 'behind' : 'identical';
    assert.equal(pin.compare_status, status, `${pin.role} pin status`);
  }
});

test('CI results in the lock are derived from every recorded run; absence of runs is not success', () => {
  for (const repo of observation.repositories) {
    const ci = byRole(lock, repo.role).ci_on_exact_head;
    assert.deepEqual(ci, summarizeCi(repo.ci_runs_on_exact_head));
    assert.equal(ci.all_success, repo.ci_runs_on_exact_head.length > 0 && repo.ci_runs_on_exact_head.every((r) => r.conclusion === 'success'));
  }
  assert.equal(summarizeCi([]).all_success, false);
  assert.equal(summarizeCi([{ conclusion: 'success' }, { conclusion: 'cancelled' }]).all_success, false);
});

test('the limits sentences agree with the recorded runs they describe', () => {
  const limit = (needle) => { const hits = lock.limits.filter((l) => l.includes(needle)); assert.equal(hits.length, 1, needle); return hits[0]; };
  const runs = (role) => byRole(observation, role).ci_runs_on_exact_head;
  const failed = (role) => runs(role).filter((r) => r.conclusion !== 'success');
  const bskel = failed('bskel');
  assert.deepEqual(runs('bskel').filter((r) => r.conclusion === 'success').map((r) => r.event).sort(), ['push', 'schedule', 'schedule', 'schedule']);
  assert.deepEqual(bskel.map((r) => [r.created_at.slice(0, 10), r.failed_jobs.map((j) => j.name)]), [['2026-10-06', ['test (24.x)']], ['2026-10-07', ['python-integration']], ['2026-10-08', ['python-integration']]]);
  assert.deepEqual(bskel[0].failed_jobs[0].failed_steps, []);
  assert.ok(bskel[0].failed_jobs[0].unfinished_steps.includes('run tests'));
  assert.deepEqual(bskel[1].failed_jobs[0].failed_steps, ['Run npm run test:python-integration']);
  const sk = limit('bskel exact-head CI');
  for (const re of [/2026-10-06/, /test \(24\.x\)/, /run tests/, /HTTP 404/, /2026-10-07 and 2026-10-08/, /python-integration/, /Run npm run test:python-integration/, /PR 248/]) assert.match(sk, re);
  const beval = failed('beval');
  assert.equal(runs('beval').length, 8);
  assert.deepEqual(beval.map((r) => r.conclusion), ['cancelled', 'failure', 'failure', 'failure', 'failure', 'failure']);
  assert.equal(beval[0].event, 'push');
  assert.equal(beval[0].failed_jobs.length, 8);
  assert.ok(beval.slice(1).every((r) => r.event === 'schedule' && r.failed_jobs.length === 1 && r.failed_jobs[0].name === 'integration'));
  assert.deepEqual(runs('beval').filter((r) => r.conclusion === 'success').map((r) => [r.workflow, r.event]), [['Alienware recovery', 'workflow_dispatch'], ['Alienware recovery', 'workflow_dispatch']]);
  const bv = limit('beval exact-head CI');
  for (const re of [/cancelled/, /all 8 of its jobs/, /five scheduled runs/, /integration/, /two manual dispatches/, /Alienware recovery/]) assert.match(bv, re);
  assert.deepEqual(runs('becoder').map((r) => [r.event, r.conclusion]), [['push', 'success'], ['schedule', 'success']]);
  assert.match(limit('becoder exact-head CI'), /the only runs recorded/);
});

test('README documents exactly the verifier codes and every file of this slice', () => {
  const documented = [...readme.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(documented, [...BASELINE_CODES, ...RECORD_CODES].sort());
  const files = ['capture-observation.mjs', 'fixtures/observation.json', 'build-lock.mjs', 'baseline.lock.json', 'verify-baseline.mjs', 'make-negative-report.mjs', 'negative-report.json'];
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(T00, f)), `${f} exists`);
    assert.ok(readme.includes(f), `README names ${f}`);
  }
});

test('every verifier code is raised by a recorded negative case and the control passes', () => {
  assert.deepEqual([...new Set(CASES.flatMap((c) => c.codes))].sort(), [...BASELINE_CODES, ...RECORD_CODES].sort());
  assert.deepEqual([CASES[0].exit, CASES[0].codes], [0, []]);
});

test('negative-report.json equals real CLI runs recomputed now, and any tampering is reported', () => {
  const fresh = buildReport();
  assert.deepEqual(verifyReport(report, fresh), []);
  assert.equal(report.cases.length, CASES.length);
  assert.equal(report.lock_sha256, canonicalSha256(lock));
  assert.equal(report.observation_sha256, canonicalSha256(observation));
  const tampers = {
    'exit code': (r) => { r.cases[2].exit_code = 0; },
    'same-length stdout hash': (r) => { r.cases[3].stdout_sha256 = flip(r.cases[3].stdout_sha256); },
    'error codes': (r) => { r.cases[4].codes = []; },
    'lock hash': (r) => { r.lock_sha256 = flip(r.lock_sha256); },
    'dropped case': (r) => { r.cases.pop(); },
  };
  for (const [what, mutate] of Object.entries(tampers)) {
    const bad = structuredClone(report);
    mutate(bad);
    assert.ok(verifyReport(bad, fresh).length > 0, `${what} tampering must be reported`);
  }
});

// A throwaway repository holding the three locked artifact files; the lock file lives beside it, outside the work tree.
function fixtureRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't00-checkout-'));
  const dir = path.join(base, 'repo');
  fs.mkdirSync(dir);
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t00', '-c', 'user.email=t00@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${os.devNull}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  for (const p of ARTIFACT_PATHS) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), `${p}\n`);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const at = observeCheckout(dir, ARTIFACT_PATHS);
  assert.equal(at.dirty, false);
  const writeLock = (roles) => {
    const file = path.join(base, 'lock.json');
    fs.writeFileSync(file, JSON.stringify({ repositories: roles.map((role) => ({ role, repo: `local/${role}`, default_branch: at.default_branch, head_sha: at.head_sha, required_artifacts: at.artifacts })) }));
    return file;
  };
  return { base, dir, git, writeLock };
}

test('checkout mode on real git repositories accepts a clean checkout and raises each state code', () => {
  const table = [
    ['clean checkout', () => {}, []],
    ['untracked file', ({ dir }) => fs.writeFileSync(path.join(dir, 'stray.txt'), 'x'), ['DIRTY_CHECKOUT']],
    ['modified tracked file', ({ dir }) => fs.appendFileSync(path.join(dir, 'package.json'), 'edit\n'), ['DIRTY_CHECKOUT']],
    ['other branch', ({ git }) => git('switch', '-q', '-c', 'topic'), ['DEFAULT_BRANCH_MISMATCH']],
    ['new commit', ({ git }) => git('commit', '-q', '--allow-empty', '-m', 'next'), ['HEAD_SHA_MISMATCH']],
    ['artifact changed in a new commit', ({ dir, git }) => { fs.appendFileSync(path.join(dir, 'package.json'), 'edit\n'); git('commit', '-q', '-am', 'edit'); }, ['ARTIFACT_BLOB_MISMATCH', 'HEAD_SHA_MISMATCH']],
    ['artifact removed in a new commit', ({ git }) => { git('rm', '-q', 'package-lock.json'); git('commit', '-q', '-m', 'rm'); }, ['HEAD_SHA_MISMATCH', 'MISSING_ARTIFACT']],
  ];
  for (const [name, mutate, want] of table) {
    const repo = fixtureRepo();
    try {
      const lockFile = repo.writeLock(['bskel']);
      mutate(repo);
      const res = cli(lockFile, '--checkout', `bskel=${repo.dir}`);
      assert.deepEqual([res.status, failCodes(res.stdout)], [want.length ? 2 : 0, want], name);
    } finally {
      fs.rmSync(repo.base, { recursive: true, force: true });
    }
  }
});

test('checkout mode reports a locked role that has no checkout and rejects an unknown role', () => {
  const repo = fixtureRepo();
  try {
    const lockFile = repo.writeLock(['bskel', 'becoder']);
    const missing = cli(lockFile, '--checkout', `bskel=${repo.dir}`);
    assert.deepEqual([missing.status, failCodes(missing.stdout)], [2, ['MISSING_REPOSITORY_OBSERVATION']]);
    const unknown = cli(lockFile, '--checkout', `nobody=${repo.dir}`);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown role/);
  } finally {
    fs.rmSync(repo.base, { recursive: true, force: true });
  }
});

test('capture-observation records sorted runs, failed and unfinished steps and recomputable hashes (stubbed gh)', () => {
  const [head, b1, b2, b3, inv, pin] = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(40));
  const scripts = { test: 'node --test', lint: 'eslint .' };
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64');
  const run = (id, conclusion, day) => ({ id, name: 'CI', event: 'schedule', status: 'completed', conclusion, created_at: `2026-01-0${day}T00:00:00Z` });
  const routes = {
    'repos/o/r': { private: false, default_branch: 'main' },
    'repos/o/r/commits/main': { sha: head, commit: { committer: { date: '2026-01-02T03:04:05Z' } } },
    [`repos/o/r/git/trees/${head}?recursive=1`]: { truncated: false, tree: [{ path: 'src', type: 'tree', sha: inv }, { path: 'package.json', type: 'blob', sha: b1 }, { path: 'package-lock.json', type: 'blob', sha: b2 }, { path: '.github/workflows/ci.yml', type: 'blob', sha: b3 }] },
    [`repos/o/r/git/blobs/${b1}`]: { content: b64({ name: 'n', version: '1.2.3', engines: { node: '>=20' }, scripts }) },
    [`repos/o/r/actions/runs?head_sha=${head}&per_page=100`]: { workflow_runs: [run(2, 'failure', 4), run(1, 'success', 3)] },
    'repos/o/r/actions/runs/2/jobs?per_page=100': { jobs: [{ name: 'test (24.x)', conclusion: 'failure', steps: [{ name: 'checkout', conclusion: 'success' }, { name: 'run tests', conclusion: null }] }, { name: 'lint', conclusion: 'success', steps: [] }] },
    [`repos/o/r/contents/release/next/compatibility-inventory.json?ref=${head}`]: { sha: inv, content: b64({ coordination_baseline: { repositories: { bskel: pin } } }) },
    [`repos/o/r/compare/${pin}...${head}?per_page=1`]: { status: 'ahead', ahead_by: 3, behind_by: 0 },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't00-gh-'));
  const savedPath = process.env.PATH;
  let out;
  try {
    fs.writeFileSync(path.join(dir, 'gh.js'), `const routes = ${JSON.stringify(routes)};\nconst a = process.argv.slice(2);\nif (a[0] === '--version') { console.log('gh version 0.0.0 (stub)'); process.exit(0); }\nif (a[0] !== 'api' || routes[a[1]] === undefined) { console.error('unexpected gh call ' + a.join(' ')); process.exit(1); }\nconsole.log(JSON.stringify(routes[a[1]]));\n`);
    fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(dir, 'gh.js')}' "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
    out = captureObservation([{ role: 'bskel', repo: 'o/r' }], new Date('2026-02-03T04:05:06Z'));
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const r = out.repositories[0];
  assert.equal(out.observed_at, '2026-02-03T04:05:06.000Z');
  assert.equal(r.dirty, null);
  assert.deepEqual(r.artifacts, [{ path: 'package.json', git_blob_sha: b1 }, { path: 'package-lock.json', git_blob_sha: b2 }, { path: '.github/workflows/ci.yml', git_blob_sha: b3 }]);
  assert.deepEqual(r.package, { name: 'n', version: '1.2.3', node_engine: '>=20', script_names: ['lint', 'test'], scripts_sha256: canonicalSha256(scripts) });
  assert.deepEqual(r.ci_runs_on_exact_head.map((x) => [x.run_id, x.conclusion]), [[1, 'success'], [2, 'failure']]);
  assert.deepEqual(r.ci_runs_on_exact_head[0].failed_jobs, []);
  assert.deepEqual(r.ci_runs_on_exact_head[1].failed_jobs, [{ name: 'test (24.x)', conclusion: 'failure', failed_steps: [], unfinished_steps: ['run tests'] }]);
  assert.deepEqual(out.inventory.pins, [{ role: 'bskel', pinned_sha: pin, compare_status: 'ahead', head_ahead_by: 3, head_behind_by: 0 }]);
  const ci = deriveLockRepository(r).ci_on_exact_head;
  assert.deepEqual([ci.runs_total, ci.all_success, ci.not_success.map((x) => x.run_id)], [2, false, [2]]);
});

const rootGit = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const mustGit = (...args) => { const r = rootGit(...args); assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`); return r.stdout.trim(); };
const hasCommit = (sha) => rootGit('cat-file', '-e', `${sha}^{commit}`).status === 0;

// A full clone already holds the locked commits; a shallow CI checkout gets one fetch of exactly that commit.
function needCommit(sha) {
  if (hasCommit(sha)) return;
  const shallow = mustGit('rev-parse', '--is-shallow-repository') === 'true';
  const fetched = rootGit('fetch', '--no-tags', ...(shallow ? ['--depth=1'] : []), 'origin', sha);
  assert.ok(fetched.status === 0 && hasCommit(sha), `commit ${sha} is not in this checkout and could not be fetched from origin: ${fetched.stderr}`);
}

test('a commit that is neither present nor fetchable fails instead of skipping', () => {
  assert.throws(() => needCommit('1'.repeat(40)), /could not be fetched/);
});

test('git objects: the bskel facts in the lock are recomputed from the locked head, its inventory and its pin', () => {
  const sk = byRole(lock, 'bskel');
  needCommit(sk.head_sha);
  assert.equal(mustGit('cat-file', '-t', sk.head_sha), 'commit');
  assert.equal(Number(mustGit('show', '-s', '--format=%ct', sk.head_sha)), Date.parse(sk.head_committed_at) / 1000);
  for (const a of sk.required_artifacts) assert.equal(mustGit('rev-parse', `${sk.head_sha}:${a.path}`), a.git_blob_sha, a.path);
  const pkg = JSON.parse(mustGit('show', `${sk.head_sha}:package.json`));
  assert.deepEqual(sk.package, { name: pkg.name, version: pkg.version, node_engine: pkg.engines?.node ?? null, script_names: Object.keys(pkg.scripts).sort(), scripts_sha256: canonicalSha256(pkg.scripts) });
  const src = lock.inventory_pins.source;
  assert.deepEqual([src.repo, src.ref], [sk.repo, sk.head_sha]);
  assert.equal(mustGit('rev-parse', `${sk.head_sha}:${src.path}`), src.git_blob_sha);
  const pinned = JSON.parse(mustGit('show', `${sk.head_sha}:${src.path}`)).coordination_baseline.repositories;
  for (const p of lock.inventory_pins.pins) assert.equal(p.pinned_sha, pinned[p.role], `${p.role} pin`);
  const pin = lock.inventory_pins.pins.find((p) => p.role === 'bskel');
  needCommit(pin.pinned_sha);
  if (mustGit('rev-parse', '--is-shallow-repository') === 'true') mustGit('fetch', '--no-tags', '--unshallow', 'origin', sk.head_sha);
  assert.equal(rootGit('merge-base', '--is-ancestor', pin.pinned_sha, sk.head_sha).status, 0, 'the pinned commit is an ancestor of the locked head');
  assert.equal(Number(mustGit('rev-list', '--count', `${pin.pinned_sha}..${sk.head_sha}`)), pin.head_ahead_by);
  assert.equal(Number(mustGit('rev-list', '--count', `${sk.head_sha}..${pin.pinned_sha}`)), pin.head_behind_by);
});
