#!/usr/bin/env node
// T00-02 ownership map builder. next/t00/ownership-map.json is derived, never typed: from the committed plan snapshot, the
// committed rules file, the repositories of the baseline lock and two live facts of the checkout, the SUITES list of the
// nested test runner and the files named test/t00-*.test.mjs. verifyMap derives the map again and compares it, so a map
// edited by hand, or one that went stale when an input changed, fails.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MAP_SCHEMA, T00_TEST_FILE, TRACK_ID, checkMap, formatError, isObject, isText, matches, normalizeScopes, scopeProblem, sortErrors, sortedObject,
  suiteEntry, suiteScopes,
} from './ownership.mjs';
import { planProblems, planTracks } from './snapshot-plan.mjs';
import { REQUIRED_REPOSITORIES, canonicalJson, canonicalSha256 } from './verify-baseline.mjs';

export const RULES_SCHEMA = 'bskel.t00-ownership-rules/1';
export const LOCK_SCHEMA = 'bskel.t00-baseline-lock/1';
export const LOCAL_ROLE = 'bskel'; // the repository this checkout is: the nested runner and the files on disk belong to it
export const BUILD_CODES = ['INPUT_INVALID', 'MAP_NOT_DERIVED'];
export const FILES = {
  map: 'next/t00/ownership-map.json',
  plan: 'next/t00/fixtures/plan-write-scopes.json',
  rules: 'next/t00/fixtures/ownership-rules.json',
  lock: 'next/t00/baseline.lock.json',
  runner: 'scripts/run-next-nested-tests.mjs',
};
export const DEFAULT_REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GENERATOR = 'node next/t00/build-ownership-map.mjs';
const texts = (x) => Array.isArray(x) && x.every(isText);
const byRepositoryAndPath = (a, b) => (a.repository !== b.repository ? (a.repository < b.repository ? -1 : 1) : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export class UsageError extends Error {}
export class UnreadableInput extends Error {}

export function parseOptions(argv, { single = [], pairs = [] } = {}) {
  const options = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const count = single.includes(a) ? 1 : pairs.includes(a) ? 2 : 0;
    if (count === 0) throw new UsageError(`unknown option ${a}`);
    if (Object.hasOwn(options, a)) throw new UsageError(`${a} is given twice`);
    const values = argv.slice(i + 1, i + 1 + count);
    if (values.length < count || values.some((v) => v.startsWith('--'))) throw new UsageError(`${a} needs ${count} value${count > 1 ? 's' : ''}`);
    options[a] = count === 1 ? values[0] : values;
    i += count;
  }
  return { options, rest };
}

// Prints a usage or unreadable-input failure and returns exit code 1; anything else is a bug and propagates.
export function failInput(e, usage) {
  if (!(e instanceof UsageError || e instanceof UnreadableInput)) throw e;
  console.error(`${e.message}\n${usage}`);
  return 1;
}

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new UnreadableInput(`cannot read the ${what} ${file}: ${e.code ?? e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UnreadableInput(`the ${what} ${file} is not valid JSON: ${e.message}`);
  }
}

export const readMap = (repoDir) => readJson(path.join(repoDir, FILES.map), 'ownership map');

export function rulesProblems(rules) {
  if (!isObject(rules)) return ['the rules file is not an object'];
  const roles = REQUIRED_REPOSITORIES.map((r) => r.role);
  const problems = [];
  if (rules.schema !== RULES_SCHEMA) problems.push(`schema is not ${RULES_SCHEMA}`);
  if (rules.task_id !== 'T00-02') problems.push('task_id is not T00-02');
  if (!isText(rules.source)) problems.push('source is not a statement');
  if (!Array.isArray(rules.reserved_hot_paths) || rules.reserved_hot_paths.length === 0) {
    problems.push('reserved_hot_paths is not a non-empty array');
  } else {
    const seen = new Set();
    for (const [i, h] of rules.reserved_hot_paths.entries()) {
      if (!isObject(h) || !roles.includes(h.repository) || !isText(h.path) || !isText(h.reason)) {
        problems.push(`reserved_hot_paths[${i}] is not {repository (one of ${roles.join(', ')}), path, reason}`);
        continue;
      }
      const problem = scopeProblem(h.path);
      if (problem) problems.push(`reserved_hot_paths[${i}]: path ${JSON.stringify(h.path)}: ${problem}`);
      const key = `${h.repository} ${h.path}`;
      if (seen.has(key)) problems.push(`reserved_hot_paths[${i}]: ${key} appears more than once`);
      seen.add(key);
    }
  }
  if (!texts(rules.limits) || rules.limits.length === 0) problems.push('limits is not a non-empty array of statements');
  return problems;
}

// The repositories (role to name) and the required artifact paths of each role, from a baseline lock. The set of roles
// and names must equal the fixed set of the baseline verifier, so a lock that dropped or renamed a repository is refused.
export function lockFacts(lock) {
  if (!isObject(lock) || lock.schema !== LOCK_SCHEMA || !Array.isArray(lock.repositories)) {
    return { problems: [`the lock is not a ${LOCK_SCHEMA} document with a repositories array`], repositories: {}, artifacts: {} };
  }
  const problems = [];
  const repositories = {};
  const artifacts = {};
  for (const r of lock.repositories) {
    if (!isObject(r) || !isText(r.role) || !isText(r.repo) || !Array.isArray(r.required_artifacts) || !r.required_artifacts.every((a) => isObject(a) && isText(a.path))) {
      problems.push('a lock repository lacks role, repo or required_artifacts [{path}]');
    } else if (Object.hasOwn(repositories, r.role)) {
      problems.push(`role ${r.role} appears more than once in the lock`);
    } else {
      repositories[r.role] = r.repo;
      artifacts[r.role] = r.required_artifacts.map((a) => a.path);
    }
  }
  const want = Object.fromEntries(REQUIRED_REPOSITORIES.map((r) => [r.role, r.repo]));
  if (canonicalJson(repositories) !== canonicalJson(want)) problems.push(`the lock's repositories ${canonicalJson(repositories)} differ from the required set ${canonicalJson(want)}`);
  return { problems, repositories, artifacts };
}

// The SUITES of the nested runner of a checkout, as suite entries. The runner is imported, as `npm run test:nested` does;
// its path carries the sha256 of its bytes so a changed file is never served from the module cache.
export async function loadSuites(repoDir) {
  const file = path.join(repoDir, FILES.runner);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    throw new UnreadableInput(`cannot read the nested runner ${file}: ${e.code ?? e.message}`);
  }
  let list;
  try {
    list = (await import(`${pathToFileURL(fs.realpathSync(file)).href}?sha256=${createHash('sha256').update(bytes).digest('hex')}`)).SUITES;
  } catch (e) {
    throw new UnreadableInput(`cannot import the nested runner ${file}: ${e.message}`);
  }
  if (!Array.isArray(list) || list.length === 0) return { entries: [], problems: ['the runner does not export a non-empty SUITES array'] };
  const problems = [];
  const entries = [];
  const ids = new Set();
  for (const [i, s] of list.entries()) {
    const shaped = isObject(s) && matches(TRACK_ID, s.id) && ['sourcePaths', 'testDirs', 'requiredTestDirs'].every((k) => s[k] === undefined || texts(s[k])) && (s.testDir === undefined || isText(s.testDir));
    if (!shaped) {
      problems.push(`SUITES[${i}] is not {id Tnn, sourcePaths[], testDir | testDirs[] | requiredTestDirs[]} with non-empty strings`);
    } else if (ids.has(s.id)) {
      problems.push(`suite ${s.id} appears more than once`);
    } else {
      ids.add(s.id);
      const entry = suiteEntry(s);
      if (entry.source_paths.length + entry.test_dirs.length === 0) problems.push(`suite ${s.id} names no source path and no test directory`);
      else entries.push(entry);
    }
  }
  return { entries: entries.sort((a, b) => (a.id < b.id ? -1 : 1)), problems };
}

// The T00 test files of a checkout: every non-directory in test/ whose name starts with t00-. A name of that kind that
// does not fit the strict pattern is a problem, because the pattern is what gives the file to T00 and to nobody else.
export function listT00Tests(repoDir) {
  let names;
  try {
    names = fs.readdirSync(path.join(repoDir, 'test'), { withFileTypes: true }).filter((e) => !e.isDirectory() && e.name.startsWith('t00-')).map((e) => e.name).sort();
  } catch (e) {
    throw new UnreadableInput(`cannot list ${path.join(repoDir, 'test')}: ${e.code ?? e.message}`);
  }
  const tests = names.map((n) => `test/${n}`).filter((p) => T00_TEST_FILE.test(p));
  const problems = names.map((n) => `test/${n}`).filter((p) => !T00_TEST_FILE.test(p)).map((p) => `${p} is named like a T00 test but does not match test/t00-[a-z0-9-]+.test.mjs`);
  return { tests, problems };
}

// Everything a map is derived from. `problems` ([{subject, detail}]) are inputs that are shaped wrong or contradict
// themselves; when there are any, the other members must not be used. Unreadable files throw UnreadableInput.
export async function loadSources(repoDir) {
  const at = (key) => path.join(repoDir, FILES[key]);
  const plan = readJson(at('plan'), 'plan snapshot');
  const rules = readJson(at('rules'), 'ownership rules');
  const lock = readJson(at('lock'), 'baseline lock');
  const suites = await loadSuites(repoDir);
  const tests = listT00Tests(repoDir);
  const facts = lockFacts(lock);
  const problems = [];
  const add = (subject, list) => list.forEach((detail) => problems.push({ subject, detail }));
  add('plan-snapshot', planProblems(plan));
  add('ownership-rules', rulesProblems(rules));
  add('baseline-lock', facts.problems);
  add('nested-runner', suites.problems);
  add('t00-tests', tests.problems);
  const roles = new Set(Object.keys(facts.repositories));
  if (Array.isArray(plan?.tasks)) {
    for (const repository of new Set(plan.tasks.map((t) => t?.repository))) {
      if (!roles.has(repository)) add('plan-snapshot', [`repository ${JSON.stringify(repository)} is not a role of the baseline lock`]);
    }
  }
  const sources = { repoDir, problems, repositories: facts.repositories, artifacts: facts.artifacts, rules, suites: suites.entries, t00Tests: tests.tests };
  if (problems.length === 0) {
    sources.plan = planTracks(plan);
    sources.inputs = {
      plan_write_scopes: { file: FILES.plan, canonical_sha256: canonicalSha256(plan), task_count: plan.tasks.length, track_count: sources.plan.length },
      ownership_rules: { file: FILES.rules, canonical_sha256: canonicalSha256(rules) },
      nested_suites: { file: FILES.runner, export: 'SUITES', suite_count: suites.entries.length, canonical_sha256: canonicalSha256(suites.entries) },
    };
  }
  return sources;
}

// The map, from sources that have no problems. A suite whose paths are not valid scopes is left out of the track here and
// reported by checkMap as INVALID_SCOPE, so building never throws.
export function buildMap(s) {
  const suiteOf = new Map(s.suites.map((e) => [e.id, e]));
  const tracks = s.plan.map((p) => {
    const entry = p.repository === LOCAL_ROLE ? suiteOf.get(p.track) : undefined;
    let fromSuite = [];
    try {
      fromSuite = entry ? suiteScopes(entry) : [];
    } catch {
      fromSuite = [];
    }
    return { track: p.track, repository: p.repository, plan_scopes: normalizeScopes(p.write_scopes), suite_scopes: fromSuite, extra_scopes: p.track === 'T00' ? [...s.t00Tests] : [] };
  });
  return {
    schema: MAP_SCHEMA,
    task_id: 'T00-02',
    generator: GENERATOR,
    inputs: s.inputs,
    repositories: sortedObject(s.repositories),
    tracks,
    reserved_hot_paths: s.rules.reserved_hot_paths.map(({ repository, path: p, reason }) => ({ repository, path: p, reason })).sort(byRepositoryAndPath),
    limits: [...s.rules.limits],
  };
}

// One track or reserved path per line: a 24-track map stays readable in a diff.
export function serializeMap(map) {
  const part = ([key, value]) => {
    if (Array.isArray(value)) return `  ${JSON.stringify(key)}: [\n${value.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]`;
    return `  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replaceAll('\n', '\n  ')}`;
  };
  return `{\n${Object.entries(map).map(part).join(',\n')}\n}\n`;
}

export function mapContext(s) {
  return {
    repositories: s.repositories,
    plan: s.plan,
    suites: s.suites,
    suiteRepository: LOCAL_ROLE,
    pathExists: (role, p) => (role === LOCAL_ROLE ? fs.existsSync(path.join(s.repoDir, p)) : (s.artifacts[role] ?? []).some((a) => a === p || a.startsWith(`${p}/`))),
  };
}

const names = (ids) => `${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` and ${ids.length - 5} more` : ''}`;

function derivationDifferences(map, derived) {
  const out = [];
  for (const key of [...new Set([...Object.keys(derived), ...Object.keys(map)])].sort()) {
    if (canonicalJson(map[key]) === canonicalJson(derived[key])) continue;
    let detail = 'differs from the value derived from the inputs';
    if (key === 'tracks') {
      const have = new Map(map.tracks.map((t) => [t.track, canonicalJson(t)]));
      const want = new Map(derived.tracks.map((t) => [t.track, canonicalJson(t)]));
      const ids = [...new Set([...have.keys(), ...want.keys()])].filter((id) => have.get(id) !== want.get(id)).sort();
      detail = ids.length ? `tracks that differ: ${names(ids)}` : `the tracks are listed in another order or repeated (${map.tracks.length} entries, derived ${derived.tracks.length})`;
    } else if (key === 'inputs' && isObject(map.inputs)) {
      const ids = [...new Set([...Object.keys(map.inputs), ...Object.keys(derived.inputs)])].filter((k) => canonicalJson(map.inputs[k]) !== canonicalJson(derived.inputs[k])).sort();
      detail = `inputs that differ: ${names(ids)}`;
    }
    out.push({ code: 'MAP_NOT_DERIVED', subject: key, detail });
  }
  return out;
}

// All errors for a map against sources that have no problems: the map checks, then the comparison with the derived map.
// A map of the wrong shape is reported as such only; there is nothing meaningful to compare.
export function verifyMap(map, s) {
  const errors = checkMap(map, mapContext(s));
  if (errors.some((e) => e.code === 'MAP_SCHEMA')) return errors;
  return sortErrors([...errors, ...derivationDifferences(map, buildMap(s))]);
}

export const inputErrors = (problems) => sortErrors(problems.map(({ subject, detail }) => ({ code: 'INPUT_INVALID', subject, detail })));

export function mapCounts(map) {
  return { tracks: map.tracks.length, scopes: map.tracks.reduce((n, t) => n + t.plan_scopes.length + t.suite_scopes.length + t.extra_scopes.length, 0), reserved: map.reserved_hot_paths.length };
}

const USAGE = `usage: node next/t00/build-ownership-map.mjs [--repo-dir <dir>]
Derives next/t00/ownership-map.json of <dir> (default: this checkout) from the committed plan snapshot, rules file and
baseline lock and from the nested runner and test/t00-*.test.mjs of <dir>, checks the derived map, and writes it only if
every check passed.
exit codes: 0 written, 2 an input or the derived map fails a check (nothing written), 1 usage or unreadable input`;

export async function runCli(argv) {
  let repoDir;
  let sources;
  try {
    const { options, rest } = parseOptions(argv, { single: ['--repo-dir'] });
    if (rest.length) throw new UsageError(`unexpected argument ${rest[0]}`);
    repoDir = path.resolve(options['--repo-dir'] ?? DEFAULT_REPO_DIR);
    sources = await loadSources(repoDir);
  } catch (e) {
    return failInput(e, USAGE);
  }
  const map = sources.problems.length ? null : buildMap(sources);
  const errors = map ? checkMap(map, mapContext(sources)) : inputErrors(sources.problems);
  for (const e of errors) console.log(formatError(e));
  if (errors.length) {
    console.error('nothing written');
    return 2;
  }
  fs.writeFileSync(path.join(repoDir, FILES.map), serializeMap(map));
  const { tracks, scopes, reserved } = mapCounts(map);
  console.log(`wrote ${FILES.map}: ${tracks} tracks, ${scopes} scopes, ${reserved} reserved paths`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
