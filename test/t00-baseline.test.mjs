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
import { ARTIFACT_PATHS, SEARCH_CAP, captureObservation, captureRepo, ghList } from '../next/t00/capture-observation.mjs';
import { CASES, buildReport, verifyReport } from '../next/t00/make-negative-report.mjs';
import {
  BASELINE_CODES, RECORD_CODES, REQUIRED_REPOSITORIES, RUNS_PAGE_SIZE,
  canonicalSha256, cleanGitEnv, deriveLockRepository, observeCheckout, summarizeCi, verifyBaseline, verifyLockRecord,
} from '../next/t00/verify-baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T00 = path.join(ROOT, 'next', 't00');
const CLI = path.join(T00, 'verify-baseline.mjs');
const LOCK_FILE = path.join(T00, 'baseline.lock.json');
const OBSERVATION_FILE = path.join(T00, 'fixtures', 'observation.json');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));
const lock = readJson(LOCK_FILE);
const observation = readJson(ROOT, lock.capture.observation_file);
const report = readJson(T00, 'negative-report.json');
const readme = fs.readFileSync(path.join(T00, 'README.md'), 'utf8');
const ROLES = REQUIRED_REPOSITORIES.map((r) => r.role);
const byRole = (doc, role) => doc.repositories.find((r) => r.role === role);
const flip = (hex) => `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`;
const failCodes = (stdout) => [...new Set(stdout.split('\n').filter((l) => l.startsWith('FAIL ')).map((l) => l.split(' ')[1]))].sort();
const codesOf = (result) => [...new Set(result.errors.map((e) => e.code))].sort();
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const withTemp = (prefix, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('the lock is rebuilt from the recorded observation, and every hash and derived fact is recomputed', () => {
  assert.equal(path.resolve(ROOT, lock.capture.observation_file), OBSERVATION_FILE);
  assert.equal(lock.capture.observation_sha256, canonicalSha256(observation));
  assert.deepEqual(buildLock(observation, lock.limits), lock);
  assert.deepEqual(verifyLockRecord(lock, observation), { ok: true, errors: [] });
  assert.deepEqual(verifyBaseline(lock, observation, { remote: true }), { ok: true, errors: [] });
  assert.deepEqual(verifyBaseline(lock, observation).errors.map((e) => e.code), ['DIRTY_STATE_UNKNOWN', 'DIRTY_STATE_UNKNOWN', 'DIRTY_STATE_UNKNOWN']);
  assert.deepEqual(lock.repositories.map((r) => [r.role, r.repo]), REQUIRED_REPOSITORIES.map((r) => [r.role, r.repo]));
  for (const repo of lock.repositories) {
    assert.match(repo.head_sha, /^[0-9a-f]{40}$/);
    assert.deepEqual(repo.required_artifacts.map((a) => a.path), ARTIFACT_PATHS);
    for (const a of repo.required_artifacts) assert.match(a.git_blob_sha, /^[0-9a-f]{40}$/);
  }
  for (const pin of lock.inventory_pins.pins) {
    const status = pin.head_ahead_by && pin.head_behind_by ? 'diverged' : pin.head_ahead_by ? 'ahead' : pin.head_behind_by ? 'behind' : 'identical';
    assert.equal(pin.compare_status, status, `${pin.role} pin status`);
  }
  const ok = cli('--remote', '--record', LOCK_FILE, OBSERVATION_FILE);
  assert.deepEqual([ok.status, ok.stdout.trim()], [0, `OK ${REQUIRED_REPOSITORIES.length} repositories verified`]);
  assert.ok(readme.includes(ok.stdout.trim()), 'the README quotes what the first command prints');
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
  assert.equal(runs('beval').length, 9);
  assert.deepEqual(beval.map((r) => r.conclusion), ['cancelled', 'failure', 'failure', 'failure', 'failure', 'failure', 'failure']);
  assert.equal(beval[0].event, 'push');
  assert.equal(beval[0].failed_jobs.length, 8);
  const scheduled = beval.slice(1);
  assert.equal(scheduled.length, 6);
  assert.ok(scheduled.every((r) => r.event === 'schedule' && r.failed_jobs.length === 1));
  assert.deepEqual(scheduled.slice(0, 5).map((r) => [r.failed_jobs[0].name, r.failed_jobs[0].failed_steps]), Array(5).fill(['integration', ['Run npm run test:integration']]));
  assert.deepEqual([scheduled[5].created_at, scheduled[5].failed_jobs], ['2026-10-08T23:19:06Z', [{ name: 'unit (20)', conclusion: 'failure', failed_steps: ['Run npm test'], unfinished_steps: [] }]]);
  assert.deepEqual(runs('beval').filter((r) => r.conclusion === 'success').map((r) => [r.workflow, r.event]), [['Alienware recovery', 'workflow_dispatch'], ['Alienware recovery', 'workflow_dispatch']]);
  const bv = limit('beval exact-head CI');
  for (const re of [/cancelled/, /all 8 of its jobs/, /six scheduled runs/, /five only in job integration/, /Run npm run test:integration/, /2026-10-08T23:19:06Z/, /unit \(20\)/, /Run npm test/, /two manual dispatches/, /Alienware recovery/]) assert.match(bv, re);
  assert.deepEqual(runs('becoder').map((r) => [r.event, r.conclusion]), [['push', 'success'], ['schedule', 'success']]);
  assert.match(limit('becoder exact-head CI'), /the only runs recorded/);
});

test('README documents exactly the verifier codes, every file of this slice and the page limits it states', () => {
  const documented = [...readme.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(documented, [...BASELINE_CODES, ...RECORD_CODES].sort());
  const files = ['capture-observation.mjs', 'fixtures/observation.json', 'build-lock.mjs', 'baseline.lock.json', 'verify-baseline.mjs', 'make-negative-report.mjs', 'negative-report.json'];
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(T00, f)), `${f} exists`);
    assert.ok(readme.includes(f), `README names ${f}`);
  }
  assert.ok(readme.includes(`${RUNS_PAGE_SIZE} per page`) && readme.includes(`at most ${SEARCH_CAP} runs`));
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

test('the baseline is exactly the three required repositories, in the lock and in the observation', () => {
  const dropBeval = (doc) => { doc.repositories = doc.repositories.filter((r) => r.role !== 'beval'); };
  const table = [
    ['lock drops beval', dropBeval, ['REPOSITORY_SET_MISMATCH']],
    ['lock and observation both drop beval', (l, o) => { dropBeval(l); dropBeval(o); }, ['REPOSITORY_SET_MISMATCH']],
    ['lock pins bskel twice', (l) => { l.repositories.push(structuredClone(byRole(l, 'bskel'))); }, ['REPOSITORY_SET_MISMATCH']],
    ['lock holds an unknown role', (l) => { l.repositories.push({ ...structuredClone(byRole(l, 'bskel')), role: 'gamma' }); }, ['MISSING_REPOSITORY_OBSERVATION', 'REPOSITORY_SET_MISMATCH']],
    ['lock renames beval', (l) => { byRole(l, 'beval').repo = 'someone-else/Backend-evaluation'; }, ['REPOSITORY_SET_MISMATCH']],
    ['observation renames beval', (l, o) => { byRole(o, 'beval').repo = 'someone-else/Backend-evaluation'; }, ['REPOSITORY_SET_MISMATCH']],
    ['observation holds becoder twice', (l, o) => { o.repositories.push(structuredClone(byRole(o, 'becoder'))); }, ['REPOSITORY_SET_MISMATCH']],
    ['observation adds an unknown role', (l, o) => { o.repositories.push({ ...structuredClone(byRole(o, 'bskel')), role: 'gamma' }); }, ['REPOSITORY_SET_MISMATCH']],
    ['observation lacks becoder', (l, o) => { o.repositories = o.repositories.filter((r) => r.role !== 'becoder'); }, ['MISSING_REPOSITORY_OBSERVATION']],
  ];
  for (const [what, mutate, want] of table) {
    const [l, o] = [structuredClone(lock), structuredClone(observation)];
    mutate(l, o);
    assert.deepEqual(codesOf(verifyBaseline(l, o, { remote: true })), want, what);
  }
});

test('the CLI refuses a lock that dropped a repository instead of printing OK', () => {
  withTemp('t00-set-', (dir) => {
    const dropped = structuredClone(lock);
    dropped.repositories = dropped.repositories.filter((r) => r.role !== 'beval');
    const lockFile = path.join(dir, 'lock.json');
    fs.writeFileSync(lockFile, JSON.stringify(dropped));
    for (const flags of [['--remote'], ['--remote', '--record']]) {
      const res = cli(...flags, lockFile, OBSERVATION_FILE);
      assert.equal(res.status, 2, flags.join(' '));
      assert.match(res.stdout, /^FAIL REPOSITORY_SET_MISMATCH beval /m);
      assert.doesNotMatch(res.stdout, /^OK /m);
    }
    fs.writeFileSync(lockFile, JSON.stringify({ repositories: 'none' }));
    const unreadable = cli('--remote', lockFile, OBSERVATION_FILE);
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stderr, /no repositories array/);
  });
});

test('a record that lacks a field the comparison reads is malformed, not equal to its twin', () => {
  const table = [
    ['neither side has a head sha', (l, o) => { delete byRole(l, 'beval').head_sha; delete byRole(o, 'beval').head_sha; }],
    ['neither side has a default branch', (l, o) => { delete byRole(l, 'becoder').default_branch; delete byRole(o, 'becoder').default_branch; }],
    ['neither side has a blob sha for package.json', (l, o) => { delete byRole(l, 'bskel').required_artifacts[0].git_blob_sha; delete byRole(o, 'bskel').artifacts[0].git_blob_sha; }],
    ['the lock lists no artifacts', (l) => { byRole(l, 'bskel').required_artifacts = []; }],
    ['the lock requires an extra artifact', (l) => { byRole(l, 'bskel').required_artifacts.push({ path: 'README.md', git_blob_sha: 'a'.repeat(40) }); }],
    ['the observation has no artifact list', (l, o) => { delete byRole(o, 'beval').artifacts; }],
  ];
  for (const [what, mutate] of table) {
    const [l, o] = [structuredClone(lock), structuredClone(observation)];
    mutate(l, o);
    assert.ok(codesOf(verifyBaseline(l, o, { remote: true })).includes('MALFORMED_RECORD'), what);
  }
});

test('every recorded run list states the count GitHub reported and the pages it took', () => {
  for (const r of observation.repositories) {
    const n = r.ci_runs_on_exact_head.length;
    assert.deepEqual([r.ci_runs_total_count, r.ci_runs_pages], [n, Math.max(1, Math.ceil(n / RUNS_PAGE_SIZE))], r.role);
  }
  const broken = {
    'count one too high': (r) => { r.ci_runs_total_count += 1; },
    'count removed': (r) => { delete r.ci_runs_total_count; },
    'page count wrong': (r) => { r.ci_runs_pages = 2; },
    'newest run removed after the capture': (r) => { r.ci_runs_on_exact_head.pop(); },
  };
  for (const [what, mutate] of Object.entries(broken)) {
    const obs = structuredClone(observation);
    mutate(byRole(obs, 'bskel'));
    assert.ok(codesOf(verifyLockRecord(lock, obs)).includes('CI_RUNS_INCOMPLETE'), what);
  }
});

const [HEAD, B1, B2, B3, INV, PIN] = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(40));
const PKG = { name: 'n', version: '1.2.3', engines: { node: '>=20' }, scripts: { test: 'node --test', lint: 'eslint .' } };
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64');
const repoRoutes = {
  'repos/o/r': { private: false, default_branch: 'main' },
  'repos/o/r/commits/main': { sha: HEAD, commit: { committer: { date: '2026-01-02T03:04:05Z' } } },
  [`repos/o/r/git/trees/${HEAD}?recursive=1`]: { truncated: false, tree: [{ path: 'src', type: 'tree', sha: INV }, { path: 'package.json', type: 'blob', sha: B1 }, { path: 'package-lock.json', type: 'blob', sha: B2 }, { path: '.github/workflows/ci.yml', type: 'blob', sha: B3 }] },
  [`repos/o/r/git/blobs/${B1}`]: { content: b64(PKG) },
};
const runsRoute = (page) => `repos/o/r/actions/runs?head_sha=${HEAD}&per_page=100&page=${page}`;

// An in-memory GitHub that pages like the real one: per_page items per page and total_count on every page.
function fakeGitHub({ runs, jobsByRun }) {
  const calls = [];
  const paged = (all, key, route) => {
    const page = Number(/[?&]page=(\d+)/.exec(route)[1]);
    const size = Number(/[?&]per_page=(\d+)/.exec(route)[1]);
    return { total_count: all.length, [key]: all.slice((page - 1) * size, page * size) };
  };
  const read = (route) => {
    calls.push(route);
    if (route.startsWith(`repos/o/r/actions/runs?head_sha=${HEAD}&`)) return paged(runs, 'workflow_runs', route);
    const jobs = /^repos\/o\/r\/actions\/runs\/(\d+)\/jobs\?/.exec(route);
    if (jobs) return paged(jobsByRun[jobs[1]] ?? [], 'jobs', route);
    if (repoRoutes[route] === undefined) throw new Error(`unexpected call ${route}`);
    return repoRoutes[route];
  };
  return { read, calls };
}

test('a head with more than 100 runs is read page by page, so an old failure on the last page is not lost', () => {
  const total = 230;
  const stamp = (id) => new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString().replace('.000Z', 'Z');
  const runs = Array.from({ length: total }, (_, i) => { const id = total - i; return { id, name: 'CI', event: 'schedule', status: 'completed', conclusion: id === 1 ? 'failure' : 'success', created_at: stamp(id) }; });
  const jobs = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, name: `job-${i + 1}`, conclusion: i === 114 ? 'failure' : 'success', steps: i === 114 ? [{ name: 'Run it', conclusion: 'failure' }] : [] }));
  const api = fakeGitHub({ runs, jobsByRun: { 1: jobs } });
  const r = captureRepo({ role: 'bskel', repo: 'o/r' }, api.read);
  assert.deepEqual([r.ci_runs_total_count, r.ci_runs_pages, r.ci_runs_on_exact_head.length], [total, 3, total]);
  assert.deepEqual(r.ci_runs_on_exact_head.filter((x) => x.conclusion !== 'success').map((x) => [x.run_id, x.failed_jobs]), [[1, [{ name: 'job-115', conclusion: 'failure', failed_steps: ['Run it'], unfinished_steps: [] }]]]);
  const ci = deriveLockRepository(r).ci_on_exact_head;
  assert.deepEqual([ci.runs_total, ci.all_success, ci.not_success.map((x) => x.run_id)], [total, false, [1]]);
  assert.deepEqual(api.calls.filter((c) => c.includes('/actions/')), [1, 2, 3].map(runsRoute).concat([1, 2].map((p) => `repos/o/r/actions/runs/1/jobs?per_page=100&page=${p}`)));

  const doc = structuredClone(observation);
  doc.repositories[doc.repositories.findIndex((x) => x.role === 'bskel')] = r;
  assert.deepEqual(verifyLockRecord(buildLock(doc, lock.limits), doc), { ok: true, errors: [] });
  // The same observation with the oldest page lost, and a lock and hash rebuilt from it, is the lie "all success".
  const cut = structuredClone(doc);
  byRole(cut, 'bskel').ci_runs_on_exact_head = byRole(cut, 'bskel').ci_runs_on_exact_head.slice(30);
  const cutLock = buildLock(cut, lock.limits);
  assert.equal(byRole(cutLock, 'bskel').ci_on_exact_head.all_success, true);
  assert.deepEqual(codesOf(verifyLockRecord(cutLock, cut)), ['CI_RUNS_INCOMPLETE']);
});

test('a list the API cannot serve completely fails the capture instead of recording fewer items', () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
  const serve = (all, { claimed = all.length, limit = Infinity } = {}) => (route) => {
    const from = (Number(/[?&]page=(\d+)/.exec(route)[1]) - 1) * 100;
    return { total_count: claimed, items: from >= limit ? [] : all.slice(from, Math.min(from + 100, limit)) };
  };
  assert.deepEqual(ghList('r', 'items', serve(ids(250))), { items: ids(250), total: 250, pages: 3 });
  assert.deepEqual(ghList('r', 'items', serve([])), { items: [], total: 0, pages: 1 });
  assert.throws(() => ghList('r', 'items', serve(ids(250), { limit: 100 })), /cannot be recorded completely/);
  assert.throws(() => ghList('r', 'items', serve(ids(1500), { limit: 1000 }), SEARCH_CAP), /cannot be recorded completely/);
  assert.throws(() => ghList('r', 'items', () => ({ total_count: 150, items: ids(100) })), /an id repeats/);
  assert.throws(() => ghList('r', 'items', serve(ids(100), { claimed: 90 })), /total_count is 90/);
  assert.throws(() => ghList('r', 'items', () => ({ items: [] })), /no items array or total_count/);
});

// A throwaway repository holding the three locked artifact files; the lock file lives beside it, outside the work tree.
function fixtureRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't00-checkout-'));
  const dir = path.join(base, 'repo');
  fs.mkdirSync(dir);
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t00', '-c', 'user.email=t00@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${os.devNull}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: cleanGitEnv() });
  git('init', '-q', '-b', 'main');
  for (const p of ARTIFACT_PATHS) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), `${p}\n`);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const at = observeCheckout(dir, ARTIFACT_PATHS);
  assert.equal(at.dirty, false);
  const writeLock = (roles = ROLES) => {
    const file = path.join(base, 'lock.json');
    fs.writeFileSync(file, JSON.stringify({ repositories: roles.map((role) => ({ role, repo: REQUIRED_REPOSITORIES.find((r) => r.role === role).repo, default_branch: at.default_branch, head_sha: at.head_sha, required_artifacts: at.artifacts })) }));
    return file;
  };
  const checkouts = (roles = ROLES) => roles.flatMap((role) => ['--checkout', `${role}=${dir}`]);
  return { base, dir, git, at, writeLock, checkouts };
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
      const lockFile = repo.writeLock();
      mutate(repo);
      const res = cli(lockFile, ...repo.checkouts());
      assert.deepEqual([res.status, failCodes(res.stdout)], [want.length ? 2 : 0, want], name);
    } finally {
      fs.rmSync(repo.base, { recursive: true, force: true });
    }
  }
});

test('checkout mode needs exactly one checkout per required repository and rejects an unknown role', () => {
  const repo = fixtureRepo();
  try {
    const lockFile = repo.writeLock();
    const missing = cli(lockFile, ...repo.checkouts(['bskel', 'becoder']));
    assert.deepEqual([missing.status, failCodes(missing.stdout)], [2, ['MISSING_REPOSITORY_OBSERVATION']]);
    const twice = cli(lockFile, ...repo.checkouts(['bskel', 'bskel', 'becoder', 'beval']));
    assert.deepEqual([twice.status, failCodes(twice.stdout)], [2, ['REPOSITORY_SET_MISMATCH']]);
    const short = cli(repo.writeLock(['bskel', 'becoder']), ...repo.checkouts(['bskel', 'becoder']));
    assert.deepEqual([short.status, failCodes(short.stdout)], [2, ['REPOSITORY_SET_MISMATCH']]);
    const unknown = cli(lockFile, '--checkout', `nobody=${repo.dir}`);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown role/);
  } finally {
    fs.rmSync(repo.base, { recursive: true, force: true });
  }
});

test('the caller git environment and configuration cannot redirect or soften the checkout observation', () => {
  const repo = fixtureRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't00-home-'));
  const saved = { HOME: process.env.HOME, GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  try {
    fs.writeFileSync(path.join(home, '.gitconfig'), '[status]\n\tshowUntrackedFiles = no\n');
    fs.writeFileSync(path.join(repo.dir, 'stray.txt'), 'x');
    Object.assign(process.env, { HOME: home, GIT_DIR: path.join(ROOT, '.git'), GIT_WORK_TREE: ROOT });
    const at = observeCheckout(repo.dir, ARTIFACT_PATHS);
    assert.deepEqual([at.head_sha, at.dirty], [repo.at.head_sha, true]);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(repo.base, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('capture-observation records sorted runs, failed and unfinished steps and recomputable hashes (stubbed gh)', () => {
  const run = (id, conclusion, day) => ({ id, name: 'CI', event: 'schedule', status: 'completed', conclusion, created_at: `2026-01-0${day}T00:00:00Z` });
  const routes = {
    ...repoRoutes,
    [runsRoute(1)]: { total_count: 2, workflow_runs: [run(2, 'failure', 4), run(1, 'success', 3)] },
    'repos/o/r/actions/runs/2/jobs?per_page=100&page=1': { total_count: 2, jobs: [{ id: 21, name: 'test (24.x)', conclusion: 'failure', steps: [{ name: 'checkout', conclusion: 'success' }, { name: 'run tests', conclusion: null }] }, { id: 22, name: 'lint', conclusion: 'success', steps: [] }] },
    [`repos/o/r/contents/release/next/compatibility-inventory.json?ref=${HEAD}`]: { sha: INV, content: b64({ coordination_baseline: { repositories: { bskel: PIN } } }) },
    [`repos/o/r/compare/${PIN}...${HEAD}?per_page=1`]: { status: 'ahead', ahead_by: 3, behind_by: 0 },
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
  assert.deepEqual(r.artifacts, [{ path: 'package.json', git_blob_sha: B1 }, { path: 'package-lock.json', git_blob_sha: B2 }, { path: '.github/workflows/ci.yml', git_blob_sha: B3 }]);
  assert.deepEqual(r.package, { name: 'n', version: '1.2.3', node_engine: '>=20', script_names: ['lint', 'test'], scripts_sha256: canonicalSha256(PKG.scripts) });
  assert.deepEqual([r.ci_runs_total_count, r.ci_runs_pages], [2, 1]);
  assert.deepEqual(r.ci_runs_on_exact_head.map((x) => [x.run_id, x.conclusion]), [[1, 'success'], [2, 'failure']]);
  assert.deepEqual(r.ci_runs_on_exact_head[0].failed_jobs, []);
  assert.deepEqual(r.ci_runs_on_exact_head[1].failed_jobs, [{ name: 'test (24.x)', conclusion: 'failure', failed_steps: [], unfinished_steps: ['run tests'] }]);
  assert.deepEqual(out.inventory.pins, [{ role: 'bskel', pinned_sha: PIN, compare_status: 'ahead', head_ahead_by: 3, head_behind_by: 0 }]);
  const ci = deriveLockRepository(r).ci_on_exact_head;
  assert.deepEqual([ci.runs_total, ci.all_success, ci.not_success.map((x) => x.run_id)], [2, false, [2]]);
});

const rootGit = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...cleanGitEnv(), GIT_TERMINAL_PROMPT: '0' } });
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
