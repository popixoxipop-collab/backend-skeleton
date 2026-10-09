#!/usr/bin/env node
// Builds ownership-report.json by running the real check-ownership CLI on this checkout and on scaffold checkouts: a copy of
// this checkout's inputs with one thing broken. Nothing in the report is typed by hand. The exit code, the error codes and
// the stdout hash of every case are what the CLI printed, and a case whose run differs from its declaration throws, so no
// report is written unless every case behaved as declared.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FILES, buildMap, listT00Tests, loadSources, loadSuites, serializeMap } from './build-ownership-map.mjs';
import { diffReports, runAll, sha256 } from './recorded-runs.mjs';
import { canonicalSha256 } from './verify-baseline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..', '..');
export const REPORT_FILE = path.join(here, 'ownership-report.json');
export const REPORT_SCHEMA = 'bskel.t00-ownership-report/1';
const CLI = path.join(here, 'check-ownership.mjs');
const TOOL_FILES = ['check-ownership.mjs', 'ownership.mjs', 'build-ownership-map.mjs', 'snapshot-plan.mjs'];
const readText = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const flip = (hex) => `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`;
const trackOf = (map, id) => map.tracks.find((t) => t.track === id);
const taskOf = (plan, id) => plan.tasks.find((t) => t.track === id);
const suiteLine = (id, code) => `\nSUITES.find((s) => s.id === '${id}').${code};\n`;
const noop = () => {};

// The inputs of a scaffold, as parsed documents, so that a case can break one of them before the files are written.
function baseModel() {
  const rules = JSON.parse(readText(FILES.rules));
  return {
    plan: JSON.parse(readText(FILES.plan)),
    rules,
    lock: JSON.parse(readText(FILES.lock)),
    map: JSON.parse(readText(FILES.map)),
    runner: readText(FILES.runner),
    tests: listT00Tests(REPO).tests,
    hot: rules.reserved_hot_paths.filter((h) => h.repository === 'bskel').map((h) => h.path),
    omit: [],
    raw: {},
  };
}

function writeScaffold(repo, m) {
  const put = (rel, text) => {
    if (m.omit.includes(rel)) return;
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  const text = (rel, value) => m.raw[rel] ?? (typeof value === 'string' ? value : JSON.stringify(value));
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  for (const h of m.hot) put(h.endsWith('/**') ? `${h.slice(0, -3)}/keep` : h, '');
  for (const t of m.tests) put(t, '');
  put(FILES.plan, text(FILES.plan, m.plan));
  put(FILES.rules, text(FILES.rules, m.rules));
  put(FILES.lock, text(FILES.lock, m.lock));
  put(FILES.runner, text(FILES.runner, m.runner));
  put(FILES.map, text(FILES.map, m.map));
}

// Two commits in the scaffold: `before` runs ahead of the first one, `after` between the first and the second.
function twoCommits(repo, { before = noop, after }) {
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t00', '-c', 'user.email=t00@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${os.devNull}`, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, HOME: repo },
  });
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  git('init', '-q', '-b', 'main');
  before(write, git, repo);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  after(write, git, repo);
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
}

const DIFF = ['paths', '--track', 'T00', '--git-diff', 'HEAD~1', 'HEAD'];
const paths = (track, ...list) => ['paths', '--track', track, ...list];

// Declared expectations. `args` are the CLI arguments; a case with `change` runs on a scaffold (--repo-dir <repo>) whose
// inputs `change` breaks, `rederive` writes the map the broken inputs derive (so only the check under test can fail), and
// `git` makes the scaffold a repository with two commits. A case without `change` runs on this checkout.
export const CASES = [
  { id: 'accept-the-committed-map', mutation: 'none (control)', exit: 0, codes: [], args: ['map'] },
  { id: 'accept-paths-of-one-track', mutation: 'none (control): T05 source and test files', exit: 0, codes: [], args: paths('T05', 'scanners/language/jvm/Scan.mjs', 'test/language-jvm/Case.mjs') },
  { id: 'accept-windows-separators-typed-by-hand', mutation: 'none (control): a T06 path typed with backslashes', exit: 0, codes: [], args: paths('T06', 'scanners\\language\\python\\a.py') },
  { id: 'accept-a-track-of-another-repository', mutation: 'none (control): T15 lives in becoder', exit: 0, codes: [], args: paths('T15', 'next/t15/a.mjs') },
  { id: 'accept-the-t00-files', mutation: 'none (control): the T00 directory and a T00 test file', exit: 0, codes: [], args: paths('T00', 'next/t00/README.md', 'test/t00-ownership.test.mjs') },

  { id: 'path-of-an-unknown-track', mutation: 'track T99', exit: 2, codes: ['UNKNOWN_TRACK'], args: paths('T99', 'next/t99/a.mjs') },
  { id: 'path-with-the-wrong-repository', mutation: 'T15 asked for in bskel', exit: 2, codes: ['UNKNOWN_TRACK'], args: ['paths', '--track', 'T15', '--repository', 'bskel', 'next/t15/a.mjs'] },
  { id: 'path-with-dot-dot', mutation: 'a path that climbs out of the repository', exit: 2, codes: ['INVALID_PATH'], args: paths('T05', 'scanners/language/jvm/../../../package.json') },
  { id: 'absolute-path', mutation: 'an absolute path', exit: 2, codes: ['INVALID_PATH'], args: paths('T05', '/etc/passwd') },
  { id: 'file-of-another-track', mutation: 'T05 asked to own a T06 file', exit: 2, codes: ['PATH_OWNED_BY_OTHER_TRACK'], args: paths('T05', 'scanners/language/python/a.py') },
  { id: 'reserved-hot-files', mutation: 'T05 asked to own package.json and a workflow file', exit: 2, codes: ['PATH_RESERVED_HOT'], args: paths('T05', 'package.json', '.github/workflows/ci.yml') },
  { id: 'path-that-matches-only-ignoring-case', mutation: 'Scanners/Language/JVM spelled with other case', exit: 2, codes: ['PATH_CASE_MISMATCH'], args: paths('T05', 'Scanners/Language/JVM/A.mjs') },
  { id: 'stable-surface-path', mutation: 'a path inside no track scope', exit: 2, codes: ['PATH_UNOWNED'], args: paths('T05', 'docs/notes.txt') },
  { id: 'mixed-list-of-five-problems', mutation: 'one good path and five bad ones', exit: 2, codes: ['INVALID_PATH', 'PATH_CASE_MISMATCH', 'PATH_OWNED_BY_OTHER_TRACK', 'PATH_RESERVED_HOT', 'PATH_UNOWNED'], args: paths('T05', 'scanners/language/jvm/A.mjs', 'package.json', 'scanners/language/python/b.py', 'docs/x.md', '../x', 'Scanners/Language/JVM/a.mjs') },

  { id: 'usage-no-command', mutation: 'no arguments', exit: 1, codes: [], args: [] },
  { id: 'usage-paths-without-a-path', mutation: 'paths --track T05 and nothing else', exit: 1, codes: [], args: ['paths', '--track', 'T05'] },
  { id: 'usage-track-is-not-a-track-id', mutation: '--track t5', exit: 1, codes: [], args: paths('t5', 'a.mjs') },
  { id: 'usage-unknown-option', mutation: 'map --bogus', exit: 1, codes: [], args: ['map', '--bogus'] },
  { id: 'usage-map-with-a-path', mutation: 'map extra.txt', exit: 1, codes: [], args: ['map', 'extra.txt'] },
  { id: 'usage-paths-and-git-diff-together', mutation: 'a path and --git-diff', exit: 1, codes: [], args: paths('T05', 'a.mjs', '--git-diff', 'HEAD~1', 'HEAD') },

  { id: 'map-drops-a-track', mutation: 'map: T05 removed', exit: 2, codes: ['MAP_NOT_DERIVED', 'PLAN_SCOPE_MISMATCH', 'SUITE_UNKNOWN_TRACK'], change: (m) => { m.map.tracks = m.map.tracks.filter((t) => t.track !== 'T05'); } },
  { id: 'map-lists-a-track-twice', mutation: 'map: T05 entry repeated', exit: 2, codes: ['DUPLICATE_TRACK', 'MAP_NOT_DERIVED'], change: (m) => { m.map.tracks.push(structuredClone(trackOf(m.map, 'T05'))); } },
  { id: 'map-gives-t05-a-scope-of-t01', mutation: 'map: T05 plan_scopes gets contracts/next/**', exit: 2, codes: ['MAP_NOT_DERIVED', 'PLAN_SCOPE_MISMATCH', 'SCOPE_COLLISION'], change: (m) => { trackOf(m.map, 'T05').plan_scopes.push('contracts/next/**'); } },
  { id: 'map-claims-a-reserved-file', mutation: 'map: T05 plan_scopes gets package.json', exit: 2, codes: ['HOT_PATH_CLAIMED', 'MAP_NOT_DERIVED', 'PLAN_SCOPE_MISMATCH'], change: (m) => { trackOf(m.map, 'T05').plan_scopes.push('package.json'); } },
  { id: 'map-scope-with-a-glob-in-the-middle', mutation: 'map: T05 plan_scopes gets scanners/*/jvm/**', exit: 2, codes: ['INVALID_SCOPE', 'MAP_NOT_DERIVED'], change: (m) => { trackOf(m.map, 'T05').plan_scopes.push('scanners/*/jvm/**'); } },
  { id: 'map-extra-scope-on-a-track-that-is-not-t00', mutation: 'map: T05 extra_scopes gets a T00 test file', exit: 2, codes: ['INVALID_SCOPE', 'MAP_NOT_DERIVED'], change: (m) => { trackOf(m.map, 'T05').extra_scopes.push('test/t00-baseline.test.mjs'); } },
  { id: 'map-moves-t05-to-beval', mutation: 'map: T05 repository set to beval', exit: 2, codes: ['MAP_NOT_DERIVED', 'PLAN_SCOPE_MISMATCH', 'SUITE_UNKNOWN_TRACK'], change: (m) => { trackOf(m.map, 'T05').repository = 'beval'; } },
  { id: 'map-forgets-a-reserved-path', mutation: 'map: first reserved path removed', exit: 2, codes: ['MAP_NOT_DERIVED'], change: (m) => { m.map.reserved_hot_paths.shift(); } },
  { id: 'map-input-hash-flipped', mutation: 'map: inputs.plan_write_scopes.canonical_sha256 first hex digit changed', exit: 2, codes: ['MAP_NOT_DERIVED'], change: (m) => { const i = m.map.inputs.plan_write_scopes; i.canonical_sha256 = flip(i.canonical_sha256); } },
  { id: 'map-limits-edited', mutation: 'map: limits[0] extended', exit: 2, codes: ['MAP_NOT_DERIVED'], change: (m) => { m.map.limits[0] += ' (edited)'; } },
  { id: 'map-schema-changed', mutation: 'map: schema set to bskel.t00-ownership-map/2', exit: 2, codes: ['MAP_SCHEMA'], change: (m) => { m.map.schema = 'bskel.t00-ownership-map/2'; } },
  { id: 'map-is-an-array', mutation: 'map file holds []', exit: 2, codes: ['MAP_SCHEMA'], change: (m) => { m.raw[FILES.map] = '[]'; } },
  { id: 'new-t00-test-file-without-a-rebuild', mutation: 'scaffold: test/t00-extra.test.mjs added, map untouched', exit: 2, codes: ['MAP_NOT_DERIVED'], change: (m) => { m.tests.push('test/t00-extra.test.mjs'); } },
  { id: 'removed-t00-test-file-without-a-rebuild', mutation: 'scaffold: test/t00-baseline.test.mjs removed, map untouched', exit: 2, codes: ['MAP_NOT_DERIVED'], change: (m) => { m.tests = m.tests.filter((t) => t !== 'test/t00-baseline.test.mjs'); } },
  { id: 'suite-source-added-without-a-rebuild', mutation: 'runner: T05 suite gets scanners/language/jvm-extra, map untouched', exit: 2, codes: ['MAP_NOT_DERIVED', 'SUITE_SCOPE_MISSING'], change: (m) => { m.runner += suiteLine('T05', "sourcePaths.push('scanners/language/jvm-extra')"); } },
  { id: 'reserved-file-missing-from-the-checkout', mutation: 'scaffold: CATALOG.md not written', exit: 2, codes: ['HOT_PATH_MISSING'], change: (m) => { m.omit.push('CATALOG.md'); } },
  { id: 'reserved-file-missing-from-a-private-repository', mutation: 'lock: beval package-lock.json removed from required_artifacts', exit: 2, codes: ['HOT_PATH_MISSING'], change: (m) => { const r = m.lock.repositories.find((x) => x.role === 'beval'); r.required_artifacts = r.required_artifacts.filter((a) => a.path !== 'package-lock.json'); } },

  { id: 'plan-lets-t05-claim-the-source-of-t01', mutation: 'plan: a T05 task gets contracts/next/**; map rederived', exit: 2, codes: ['SCOPE_COLLISION'], rederive: true, change: (m) => { taskOf(m.plan, 'T05').write_scope.push('contracts/next/**'); } },
  { id: 'plan-lets-t05-claim-a-file-of-t06', mutation: 'plan: a T05 task gets test/language-python/case.mjs; map rederived', exit: 2, codes: ['SCOPE_COLLISION'], rederive: true, change: (m) => { taskOf(m.plan, 'T05').write_scope.push('test/language-python/case.mjs'); } },
  { id: 'plan-claims-a-directory-in-other-case', mutation: 'plan: a T05 task gets Contracts/Next/**; map rederived', exit: 2, codes: ['SCOPE_COLLISION'], rederive: true, change: (m) => { taskOf(m.plan, 'T05').write_scope.push('Contracts/Next/**'); } },
  { id: 'plan-claims-the-root-readme', mutation: 'plan: a T05 task gets README.md; map rederived', exit: 2, codes: ['HOT_PATH_CLAIMED'], rederive: true, change: (m) => { taskOf(m.plan, 'T05').write_scope.push('README.md'); } },
  { id: 'plan-claims-a-workflow-file', mutation: 'plan: a T05 task gets .github/workflows/ci.yml; map rederived', exit: 2, codes: ['HOT_PATH_CLAIMED'], rederive: true, change: (m) => { taskOf(m.plan, 'T05').write_scope.push('.github/workflows/ci.yml'); } },
  { id: 'rules-reserve-a-file-the-checkout-lacks', mutation: 'rules: SECURITY.md reserved in bskel; map rederived', exit: 2, codes: ['HOT_PATH_MISSING'], rederive: true, change: (m) => { m.rules.reserved_hot_paths.push({ repository: 'bskel', path: 'SECURITY.md', reason: 'probe' }); } },
  { id: 'runner-adds-a-suite-for-an-unknown-track', mutation: 'runner: a suite T24 added; map rederived', exit: 2, codes: ['SUITE_UNKNOWN_TRACK'], rederive: true, change: (m) => { m.runner += "\nSUITES.push({ id: 'T24', sourcePaths: ['sdk/future'], testDir: 'test/future' });\n"; } },
  { id: 'runner-suite-grants-t06-the-source-of-t01', mutation: 'runner: T06 suite gets contracts/next; map rederived', exit: 2, codes: ['SCOPE_COLLISION'], rederive: true, change: (m) => { m.runner += suiteLine('T06', "sourcePaths.push('contracts/next')"); } },

  { id: 'plan-task-count-differs', mutation: 'plan: source.task_count raised by one', exit: 2, codes: ['INPUT_INVALID'], change: (m) => { m.plan.source.task_count += 1; } },
  { id: 'plan-scope-with-a-glob-in-the-middle', mutation: 'plan: a T05 task gets scanners/*/jvm/**', exit: 2, codes: ['INPUT_INVALID'], change: (m) => { taskOf(m.plan, 'T05').write_scope.push('scanners/*/jvm/**'); } },
  { id: 'plan-track-in-two-repositories', mutation: 'plan: one T05 task moved to becoder', exit: 2, codes: ['INPUT_INVALID'], change: (m) => { taskOf(m.plan, 'T05').repository = 'becoder'; } },
  { id: 'rules-without-limits', mutation: 'rules: limits removed', exit: 2, codes: ['INPUT_INVALID'], change: (m) => { delete m.rules.limits; } },
  { id: 'lock-without-beval', mutation: 'lock: beval entry removed', exit: 2, codes: ['INPUT_INVALID'], change: (m) => { m.lock.repositories = m.lock.repositories.filter((r) => r.role !== 'beval'); } },
  { id: 'runner-exports-no-suites', mutation: 'runner: SUITES emptied', exit: 2, codes: ['INPUT_INVALID'], change: (m) => { m.runner += '\nSUITES.length = 0;\n'; } },
  { id: 'badly-named-t00-test-file', mutation: 'scaffold: test/t00-Bad_Name.test.mjs added', exit: 2, codes: ['INPUT_INVALID'], change: (m) => { m.tests.push('test/t00-Bad_Name.test.mjs'); } },

  { id: 'runner-with-a-syntax-error', mutation: 'runner: replaced by a file that does not parse', exit: 1, codes: [], change: (m) => { m.raw[FILES.runner] = 'export const SUITES = [;\n'; } },
  { id: 'map-file-missing', mutation: 'scaffold: no ownership-map.json', exit: 1, codes: [], change: (m) => { m.omit.push(FILES.map); } },
  { id: 'map-file-is-not-json', mutation: 'map file holds the text "not json"', exit: 1, codes: [], change: (m) => { m.raw[FILES.map] = 'not json'; } },

  { id: 'git-diff-of-own-files', mutation: 'git: a new file in next/t00 (control)', exit: 0, codes: [], change: noop, args: DIFF, git: { after: (write) => write('next/t00/new-file.mjs', 'export {};\n') } },
  { id: 'git-diff-touches-a-reserved-file-and-another-track', mutation: 'git: README.md edited and a T06 file added', exit: 2, codes: ['PATH_OWNED_BY_OTHER_TRACK', 'PATH_RESERVED_HOT'], change: noop, args: DIFF, git: { before: (write) => write('README.md', 'a\n'), after: (write) => { write('README.md', 'b\n'); write('scanners/language/python/x.py', 'x\n'); } } },
  { id: 'git-diff-renames-into-another-track', mutation: 'git: next/t00/moved.mjs renamed to sdk/next/moved.mjs (T22)', exit: 2, codes: ['PATH_OWNED_BY_OTHER_TRACK'], change: noop, args: DIFF, git: { before: (write) => write('next/t00/moved.mjs', 'x\n'), after: (write, git, repo) => { fs.mkdirSync(path.join(repo, 'sdk/next'), { recursive: true }); git('mv', 'next/t00/moved.mjs', 'sdk/next/moved.mjs'); } } },
  { id: 'git-diff-with-a-backslash-in-a-file-name', mutation: 'git: a root file named root\\file.mjs', exit: 2, codes: ['INVALID_PATH'], change: noop, args: DIFF, git: { after: (write) => write('root\\file.mjs', 'x\n') } },
  { id: 'git-diff-with-a-newline-in-a-file-name', mutation: 'git: a root file whose name holds a newline and a second FAIL line', exit: 2, codes: ['PATH_UNOWNED'], change: noop, args: DIFF, git: { after: (write) => write('evil\nFAIL FORGED_CODE injected line.txt', 'x\n') } },
  { id: 'git-diff-is-empty', mutation: 'git: the same revision twice', exit: 1, codes: [], change: noop, args: ['paths', '--track', 'T00', '--git-diff', 'HEAD', 'HEAD'], git: { after: (write) => write('next/t00/a.mjs', 'x\n') } },
  { id: 'git-diff-of-an-unknown-revision', mutation: 'git: HEAD~5 does not exist', exit: 1, codes: [], change: noop, args: ['paths', '--track', 'T00', '--git-diff', 'HEAD~5', 'HEAD'], git: { after: (write) => write('next/t00/a.mjs', 'x\n') } },
  { id: 'git-diff-with-an-option-as-revision', mutation: 'git: -p given as the base revision', exit: 1, codes: [], change: noop, args: ['paths', '--track', 'T00', '--git-diff', '-p', 'HEAD'], git: { after: (write) => write('next/t00/a.mjs', 'x\n') } },
];

const showCommand = (args) => ['node', 'next/t00/check-ownership.mjs', ...args].join(' ');

async function prepare(c, dir) {
  const args = c.args ?? ['map'];
  if (!c.change) return { argv: args, display: showCommand(args) };
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const m = baseModel();
  c.change(m);
  writeScaffold(repo, m);
  if (c.rederive) fs.writeFileSync(path.join(repo, FILES.map), serializeMap(buildMap(await loadSources(repo))));
  if (c.git) twoCommits(repo, c.git);
  return { argv: ['--repo-dir', repo, ...args], display: showCommand(['--repo-dir', '<repo>', ...args]), scrub: [repo, fs.realpathSync(repo)] };
}

export async function buildReport(cases = CASES) {
  const base = baseModel();
  return {
    schema: REPORT_SCHEMA,
    task_id: 'T00-02',
    generator: 'node next/t00/make-ownership-report.mjs --write',
    inputs: {
      ownership_map_sha256: canonicalSha256(base.map),
      plan_write_scopes_sha256: canonicalSha256(base.plan),
      ownership_rules_sha256: canonicalSha256(base.rules),
      baseline_lock_sha256: canonicalSha256(base.lock),
      nested_suites_sha256: canonicalSha256((await loadSuites(REPO)).entries),
      tool_sha256: Object.fromEntries(TOOL_FILES.map((f) => [f, sha256(fs.readFileSync(path.join(here, f)))])),
    },
    cases: await runAll(CLI, cases.map((c) => ({ ...c, prepare: (dir) => prepare(c, dir) }))),
  };
}

export const verifyReport = diffReports;

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const mode = process.argv[2];
  if (mode === '--write') {
    fs.writeFileSync(REPORT_FILE, `${JSON.stringify(await buildReport(), null, 2)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), REPORT_FILE)}`);
  } else if (mode === '--check') {
    let committed;
    try {
      committed = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
    } catch (e) {
      console.error(`cannot read ${REPORT_FILE}: ${e.message}`);
      process.exit(1);
    }
    const errors = verifyReport(committed, await buildReport());
    for (const e of errors) console.log(`FAIL ${e}`);
    if (errors.length === 0) console.log('OK ownership-report.json equals the recomputed report');
    process.exitCode = errors.length === 0 ? 0 : 2;
  } else {
    console.error('usage: node next/t00/make-ownership-report.mjs --write | --check');
    process.exitCode = 1;
  }
}
