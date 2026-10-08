import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RECORD_SCHEMA = 'bskel.track-baseline-record/1';
export const RECORD_FILE = 'scanners/language/js-ts/BASELINE.json';
export const OWN_FILES = ['test/language-js-ts/baseline-record.test.mjs', 'test/language-js-ts/baseline-record-lib.mjs'];
export const RUNNER_SCRIPT = 'scripts/run-next-nested-tests.mjs';
export const AUTHORED = 'authored for this record';

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LIMIT_STATUSES = ['UNSUPPORTED', 'UNKNOWN', 'BLOCKED', 'NOT_RECORDED'];
const COUNT_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const blobSha1 = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

export function fileEntry(root, rel) {
  const buf = fs.readFileSync(path.join(root, rel));
  return { path: rel, bytes: buf.length, git_blob_sha1: blobSha1(buf), sha256: sha256(buf) };
}

export function readRecord(root = REPO_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, RECORD_FILE), 'utf8'));
}

export function artifactDigest(fixtures) {
  return sha256(canonical(fixtures.map((f) => ({ id: f.id, output_sha256: f.output_sha256 }))));
}

export function tapCommand(files) {
  return ['node', '--test', '--test-reporter=tap', ...files].join(' ');
}

export function verifyRecord(r) {
  const problems = [];
  const bad = (message) => problems.push(message);
  const count = (n) => Number.isInteger(n) && n >= 0;
  if (r?.schema !== RECORD_SCHEMA) bad(`schema must be ${RECORD_SCHEMA}`);
  for (const key of ['track', 'item', 'suite_id', 'source_dir', 'test_dir']) {
    if (typeof r?.[key] !== 'string' || r[key] === '') bad(`${key} must be a non-empty string`);
  }
  if (!SHA1.test(r?.base_commit ?? '')) bad('base_commit must be a 40-hex commit id');
  if (!SHA1.test(r?.base_tree ?? '')) bad('base_tree must be a 40-hex tree id');
  for (const [group, dirKey] of [['sources', 'source_dir'], ['tests', 'test_dir']]) {
    if (!Array.isArray(r?.[group]) || r[group].length === 0) { bad(`${group} must list at least one file`); continue; }
    for (const e of r[group]) {
      if (typeof e?.path !== 'string' || !e.path.startsWith(`${r[dirKey]}/`) || !count(e.bytes) || !SHA1.test(e.git_blob_sha1 ?? '') || !SHA256.test(e.sha256 ?? '')) {
        bad(`${group}: malformed entry ${e?.path}`);
      }
      if (group === 'tests' && !count(e?.test_count)) bad(`tests: ${e?.path} needs an integer test_count`);
    }
  }
  const byId = new Map();
  for (const c of r?.commands ?? []) {
    byId.set(c.id, c);
    if (typeof c.command !== 'string' || c.command.trim() === '') bad(`command ${c.id}: command text is empty`);
    if (!Number.isInteger(c.exit_code)) bad(`command ${c.id}: exit_code must be an integer`);
    if (c.revision !== r.base_commit) bad(`command ${c.id}: revision is not the base commit`);
    if (!COUNT_KEYS.every((k) => count(c.result?.[k]))) bad(`command ${c.id}: result needs integer ${COUNT_KEYS.join('/')}`);
    else if (c.exit_code === 0 && (c.result.fail !== 0 || c.result.cancelled !== 0)) bad(`command ${c.id}: exit_code 0 contradicts failing tests`);
  }
  const runner = byId.get('nested-runner');
  const direct = byId.get('direct-tap');
  if (!runner || !direct) bad('commands must include nested-runner and direct-tap');
  else {
    const files = (r.tests ?? []).map((t) => t.path);
    const total = (r.tests ?? []).reduce((sum, t) => sum + (t.test_count ?? 0), 0);
    if (runner.command !== `node scripts/run-next-nested-tests.mjs ${r.suite_id}`) bad('nested-runner command does not name the suite');
    if (runner.runner_files !== files.length) bad('nested-runner runner_files does not match the recorded test files');
    if (runner.stdout_first_line !== `NESTED_SUITE ${r.suite_id} RUN ${runner.runner_files} files`) bad('nested-runner stdout_first_line does not match the suite and file count');
    const script = runner.runner_script;
    if (script?.path !== RUNNER_SCRIPT || !count(script?.bytes) || !SHA1.test(script?.git_blob_sha1 ?? '') || !SHA256.test(script?.sha256 ?? '')) bad(`nested-runner runner_script must pin ${RUNNER_SCRIPT} by blob id and sha256`);
    if (direct.command !== tapCommand(files)) bad('direct-tap command does not list exactly the recorded test files');
    if (direct.result?.tests !== total) bad(`direct-tap tests ${direct.result?.tests} != sum of per-file test_count ${total}`);
    if (runner.result?.tests !== direct.result?.tests) bad('nested-runner and direct-tap disagree on the test count');
  }
  const ids = new Set();
  for (const f of r?.fixtures ?? []) {
    if (ids.has(f.id)) bad(`duplicate fixture id ${f.id}`);
    ids.add(f.id);
    if (f.class !== 'normal' && f.class !== 'negative') bad(`${f.id}: class must be normal or negative`);
    if (!(f.origin === AUTHORED || f.origin_pin || /^\S+\.mjs:\d+ \(.+\)$/.test(f.origin ?? ''))) bad(`${f.id}: origin must cite a test file line, a pinned file, or say it was authored for this record`);
    if (sha256(canonical(f.input)) !== f.input_sha256) bad(`${f.id}: input_sha256 does not match the recorded input`);
    if (!SHA256.test(f.output_sha256 ?? '')) bad(`${f.id}: output_sha256 must be a 64-hex digest`);
    if (!f.expected || typeof f.expected !== 'object') bad(`${f.id}: expected summary is missing`);
    if (f.origin_pin && typeof f.input?.source === 'string' && blobSha1(Buffer.from(f.input.source, 'utf8')) !== f.origin_pin.git_blob_sha1) {
      bad(`${f.id}: input bytes are not the pinned blob ${f.origin_pin.git_blob_sha1}`);
    }
  }
  for (const cls of ['normal', 'negative']) {
    if (!(r?.fixtures ?? []).some((f) => f.class === cls)) bad(`needs at least one ${cls} fixture`);
  }
  if (r?.artifact_digest?.value !== artifactDigest(r?.fixtures ?? [])) bad('artifact_digest does not match the fixture output hashes');
  if (!Array.isArray(r?.limits) || r.limits.length === 0) bad('limits must record the remaining limits');
  for (const l of r?.limits ?? []) {
    if (!LIMIT_STATUSES.includes(l.status)) bad(`limit ${l.id}: status ${l.status} is not one of ${LIMIT_STATUSES.join('/')}`);
    if (typeof l.statement !== 'string' || l.statement.trim() === '') bad(`limit ${l.id}: statement is empty`);
    for (const id of l.fixtures ?? []) if (!ids.has(id)) bad(`limit ${l.id}: unknown fixture ${id}`);
  }
  const walk = (value, trail) => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${trail}[${i}]`));
    if (!value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      if (/(^|_)commit$/.test(k) && !SHA1.test(v ?? '')) bad(`${trail}.${k} must be a 40-hex commit id`);
      if (/blob_sha1$/.test(k) && !SHA1.test(v ?? '')) bad(`${trail}.${k} must be a 40-hex blob id`);
      if (/sha256$/.test(k) && !SHA256.test(v ?? '')) bad(`${trail}.${k} must be a 64-hex digest`);
      walk(v, `${trail}.${k}`);
    }
  };
  walk(r?.pins ?? {}, 'pins');
  walk((r?.fixtures ?? []).map((f) => f.origin_pin ?? {}), 'fixtures.origin_pin');
  for (const o of r?.ci_observations ?? []) if (o.head_sha !== r.base_commit) bad(`ci run ${o.run_id}: head_sha is not the base commit`);
  return problems;
}

export async function loadModules(dir) {
  const load = (name) => import(pathToFileURL(path.join(dir, name)).href);
  return {
    facts: await load('source-facts.mjs'),
    resolver: await load('module-resolver.mjs'),
    snapshot: await load('snapshot-graph.mjs'),
    backends: await load('backend-comparison.mjs')
  };
}

function buildBackend(spec, { backends }) {
  const lexical = backends.lexicalJsTsBackend();
  const base = { contract: backends.JS_TS_BACKEND_CONTRACT, id: spec.id, syntaxValidated: false };
  if (spec.kind === 'lexical') return lexical;
  if (spec.kind === 'mirror-of-lexical') return { ...base, analyze: (s, o) => lexical.analyze(s, o) };
  if (spec.kind === 'adds-edge') {
    return {
      ...base,
      analyze: (s, o) => {
        const out = lexical.analyze(s, o);
        return { ...out, moduleEdges: [...out.moduleEdges, { ...spec.edge, basis: 'lexical-literal', source: { byteStart: 0, line: 1 } }] };
      }
    };
  }
  throw new Error(`unknown backend spec ${spec.kind}`);
}

export function runFixture(f, modules) {
  try {
    switch (f.api) {
      case 'analyzeJsTsSource':
        return modules.facts.analyzeJsTsSource(f.input.source, f.input.options);
      case 'resolveJsTsModuleEdges':
        return modules.resolver.resolveJsTsModuleEdges(modules.facts.analyzeJsTsSource(f.input.source, f.input.options), f.input.resolve);
      case 'analyzeJsTsSnapshot':
        return modules.snapshot.analyzeJsTsSnapshot(f.input.entries, f.input.options);
      case 'compareJsTsBackends':
        return modules.backends.compareJsTsBackends(f.input.backends.map((b) => buildBackend(b, modules)), f.input.corpus);
      default:
        throw new Error(`unknown api ${f.api}`);
    }
  } catch (error) {
    return { threw: { name: error.name, message: error.message } };
  }
}

const diagKeys = (list) => list.map((d) => (d.source?.line ? `${d.code}@L${d.source.line}` : d.code));
const edgeKey = (e) => `${e.kind} ${e.specifier} L${e.source.line} [${e.source.byteStart},${e.source.byteEnd})`;
const resolutionKey = (r) => `${r.specifier} => ${r.status}${r.target ? `:${r.target}` : r.reason ? `:${r.reason}` : ''}${r.candidates.length > 1 ? ` [${r.candidates.join(',')}]` : ''}`;

export function summarize(api, out) {
  if (out.threw) return { threw: `${out.threw.name}: ${out.threw.message}` };
  switch (api) {
    case 'analyzeJsTsSource':
      return {
        complete: out.complete,
        syntaxValidated: out.syntaxValidated,
        edges: out.moduleEdges.map(edgeKey),
        allEdgesLexicalUnresolved: out.moduleEdges.every((e) => e.basis === 'lexical-literal' && e.resolution === 'unresolved'),
        diagnostics: diagKeys(out.diagnostics)
      };
    case 'resolveJsTsModuleEdges':
      return {
        complete: out.complete,
        allResolved: out.allResolved,
        sourceSyntaxValidated: out.sourceSyntaxValidated,
        resolutions: out.resolutions.map(resolutionKey),
        diagnostics: diagKeys(out.diagnostics)
      };
    case 'analyzeJsTsSnapshot':
      return {
        complete: out.complete,
        allResolved: out.allResolved,
        syntaxValidated: out.syntaxValidated,
        files: out.files.map((f) => f.path),
        graph: out.moduleGraph.map((g) => `${g.from} -> ${g.specifier} => ${g.status}${g.target ? `:${g.target}` : ''}`),
        diagnostics: diagKeys(out.diagnostics)
      };
    case 'compareJsTsBackends':
      return {
        referenceBackendId: out.referenceBackendId,
        backendIds: out.backendIds,
        corpusCases: out.corpusCases,
        comparisons: out.cases.flatMap((c) => c.comparisons.map((x) => `${c.id}: ${x.backendId} ${x.agrees ? 'agrees' : `differs in ${x.differences.join(',')}`}`))
      };
    default:
      throw new Error(`unknown api ${api}`);
  }
}

export function replay(record, modules) {
  return record.fixtures.map((f) => {
    const out = runFixture(f, modules);
    const text = canonical(out);
    return {
      id: f.id,
      deterministic: text === canonical(runFixture(f, modules)),
      output_sha256: sha256(text),
      expected: summarize(f.api, out)
    };
  });
}

export function replayProblems(record, computed) {
  const problems = [];
  if (computed.length !== record.fixtures.length) problems.push(`replayed ${computed.length} fixtures, record has ${record.fixtures.length}`);
  record.fixtures.forEach((f, i) => {
    const c = computed[i];
    if (!c || c.id !== f.id) return problems.push(`${f.id}: not replayed`);
    if (!c.deterministic) problems.push(`${f.id}: two runs differ`);
    if (c.output_sha256 !== f.output_sha256) problems.push(`${f.id}: output sha256 ${c.output_sha256} != recorded ${f.output_sha256}`);
    if (canonical(c.expected) !== canonical(f.expected)) problems.push(`${f.id}: expected summary differs: ${canonical(c.expected)}`);
  });
  return problems;
}

function listFiles(root, rel) {
  const out = [];
  const visit = (dir) => {
    if (!fs.existsSync(path.join(root, dir))) return;
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  visit(rel);
  return out.sort();
}

// The record is a baseline of base_commit: live replays are only meaningful while the tree still equals it.
export function liveTreeState(record, root = REPO_ROOT) {
  const blob = (rel) => (fs.existsSync(path.join(root, rel)) ? fileEntry(root, rel).git_blob_sha1 : null);
  const drifted = (group) => group.filter((e) => blob(e.path) !== e.git_blob_sha1).map((e) => e.path);
  const recordedSources = new Set(record.sources.map((e) => e.path));
  const recordedTests = new Set(record.tests.map((e) => e.path));
  const extraSources = listFiles(root, record.source_dir).filter((p) => !p.endsWith('.md') && p !== RECORD_FILE && !recordedSources.has(p));
  const extraTests = listFiles(root, record.test_dir).filter((p) => !recordedTests.has(p) && !OWN_FILES.includes(p));
  const sourcesChanged = [...drifted(record.sources), ...extraSources];
  const testsChanged = [...drifted(record.tests), ...extraTests];
  return { sourcesUnchanged: sourcesChanged.length === 0, testsUnchanged: testsChanged.length === 0, sourcesChanged, testsChanged };
}

function git(root, args, options = {}) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options });
}

export function historyState(root, commit) {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.error || inside.status !== 0 || inside.stdout.trim() !== 'true') return { kind: 'no-git', note: 'not inside a git work tree, or git is unavailable' };
  if (git(root, ['cat-file', '-e', `${commit}^{commit}`]).status === 0) return { kind: 'present' };
  const shallow = git(root, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true';
  return shallow
    ? { kind: 'shallow', note: `shallow checkout does not contain baseline commit ${commit}` }
    : { kind: 'missing', note: `baseline commit ${commit} is not in this repository's history` };
}

export function blobAtCommit(root, commit, rel) {
  const res = git(root, ['rev-parse', `${commit}:${rel}`]);
  return res.status === 0 ? res.stdout.trim() : null;
}

export function treeAtCommit(root, commit) {
  const res = git(root, ['rev-parse', `${commit}^{tree}`]);
  return res.status === 0 ? res.stdout.trim() : null;
}

export function isAncestor(root, commit) {
  return git(root, ['merge-base', '--is-ancestor', commit, 'HEAD']).status === 0;
}

export function listAtCommit(root, commit, dir) {
  const res = git(root, ['ls-tree', '-r', '--full-name', '--name-only', commit, '--', dir]);
  return res.status === 0 ? res.stdout.split('\n').filter(Boolean).sort() : null;
}

export function extractCommit(root, commit, paths, dest) {
  for (const rel of paths) {
    const res = spawnSync('git', ['cat-file', 'blob', `${commit}:${rel}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) throw new Error(`git cat-file failed for ${commit}:${rel}: ${res.stderr}`);
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.writeFileSync(path.join(dest, rel), res.stdout);
  }
}

export function runNestedRunner(root, suiteId) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, [RUNNER_SCRIPT, suiteId], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const stdout = res.stdout ?? '';
  const result = {};
  for (const m of stdout.matchAll(/^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) result[m[1]] = Number(m[2]);
  return { exit_code: res.status, stdout_first_line: stdout.split('\n')[0], result };
}

export function runTapTests(root, files) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const result = {};
  for (const m of (res.stdout ?? '').matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) result[m[1]] = Number(m[2]);
  return { exit_code: res.status, result };
}
