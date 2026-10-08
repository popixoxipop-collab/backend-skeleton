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

export const liveReader = (root) => (rel) => {
  try {
    return fs.readFileSync(path.join(root, rel));
  } catch {
    return null;
  }
};

export const commitReader = (root, commit) => (rel) => {
  const res = spawnSync('git', ['cat-file', 'blob', `${commit}:${rel}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return res.status === 0 ? res.stdout : null;
};

const DIGEST_KEYS = ['bytes', 'git_blob_sha1', 'sha256'];

export const digestsOf = (buf) => ({ bytes: buf.length, git_blob_sha1: blobSha1(buf), sha256: sha256(buf) });

// bytes, git_blob_sha1 and sha256 are recomputed from the file content; a well-formed value is not evidence.
export function recomputeProblems(entries, read, label) {
  const problems = [];
  for (const e of entries) {
    const buf = typeof e?.path === 'string' ? read(e.path) : null;
    if (!Buffer.isBuffer(buf)) {
      problems.push(`${label}: cannot read ${e?.path}`);
      continue;
    }
    const actual = digestsOf(buf);
    for (const key of DIGEST_KEYS) {
      if (e[key] !== actual[key]) problems.push(`${label}: ${e.path} ${key} ${e[key]} != recomputed ${actual[key]}`);
    }
  }
  return problems;
}

// One record entry against one file. Both content hashes describe the same file, so a record that disagrees with the
// file in exactly one hash (or in the size alone) is a damaged entry, never a moved tree. Only a file that matches
// neither hash is "drift", and only the pinned commit can arbitrate drift.
export function classifyEntry(entry, buf) {
  if (!Buffer.isBuffer(buf)) return { state: 'missing', detail: `${entry?.path} cannot be read` };
  const actual = digestsOf(buf);
  const wrong = DIGEST_KEYS.filter((k) => entry?.[k] !== actual[k]);
  if (wrong.length === 0) return { state: 'fresh' };
  if (wrong.includes('git_blob_sha1') && wrong.includes('sha256')) return { state: 'drift', detail: `${entry.path} differs from the record` };
  const agree = DIGEST_KEYS.filter((k) => !wrong.includes(k)).join(' and ');
  return { state: 'corrupt', detail: `${entry?.path}: the record's ${wrong.join(' and ')} disagree with the file while its ${agree} agree` };
}

export function artifactDigest(fixtures) {
  return sha256(canonical(fixtures.map((f) => ({ id: f.id, output_sha256: f.output_sha256 }))));
}

export function tapCommand(files) {
  return ['node', '--test', '--test-reporter=tap', ...files].join(' ');
}

// Without `files` only the record itself is checked. With `files = { read, includeRunner, label }` the size and both
// digests of every pinned source and test file (and of the runner script when includeRunner is set) are recomputed
// from read(path), which returns a Buffer or null.
export function verifyRecord(r, files) {
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
  if (files) {
    const pinned = [...(Array.isArray(r?.sources) ? r.sources : []), ...(Array.isArray(r?.tests) ? r.tests : [])];
    if (files.includeRunner) {
      const script = (r?.commands ?? []).find((c) => c.id === 'nested-runner')?.runner_script;
      if (script) pinned.push(script);
    }
    problems.push(...recomputeProblems(pinned, files.read, files.label ?? 'recompute'));
  }
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

// The record is a baseline of base_commit. Every pinned file is compared with the live file by size, sha256 and blob id
// (never by the record's own blob id alone): `corrupt` entries are damage and must fail the caller, `moved` files mean
// the tree has left the baseline (live replays are skipped and the pinned commit decides), `fresh` means all agree.
export function classifyLive(record, root = REPO_ROOT) {
  const read = liveReader(root);
  const states = [...record.sources, ...record.tests].map((e) => ({ path: e.path, ...classifyEntry(e, read(e.path)) }));
  const recorded = new Set(states.map((s) => s.path));
  const extras = [
    ...listFiles(root, record.source_dir).filter((p) => !p.endsWith('.md') && p !== RECORD_FILE && !recorded.has(p)),
    ...listFiles(root, record.test_dir).filter((p) => !recorded.has(p) && !OWN_FILES.includes(p))
  ];
  const corrupt = states.filter((s) => s.state === 'corrupt').map((s) => s.detail);
  const moved = [...states.filter((s) => s.state === 'drift' || s.state === 'missing').map((s) => s.path), ...extras];
  return { corrupt, moved, fresh: corrupt.length === 0 && moved.length === 0 };
}

function git(root, args, options = {}) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options });
}

export const isShallow = (root) => git(root, ['rev-parse', '--is-shallow-repository']).stdout?.trim() === 'true';

const hasCommit = (root, commit) => git(root, ['cat-file', '-e', `${commit}^{commit}`]).status === 0;

// The pinned commit is read from the checkout. A checkout that lacks it gets one fetch of exactly that commit
// (--depth=1 only when the checkout is already shallow, so a full clone never becomes shallow).
export function pinnedCommit(root, commit) {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.error || inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return { ok: false, reason: `pinned commit unavailable: ${root} is not a git work tree, or git is not installed` };
  }
  if (hasCommit(root, commit)) return { ok: true, via: 'checkout' };
  const args = ['fetch', '--no-tags', ...(isShallow(root) ? ['--depth=1'] : []), 'origin', commit];
  const res = git(root, args, { timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (res.status === 0 && hasCommit(root, commit)) return { ok: true, via: 'fetch' };
  const why = res.error ? res.error.message : `exit ${res.status}: ${(res.stderr ?? '').trim().split('\n')[0]}`;
  return { ok: false, reason: `pinned commit unavailable: ${commit} is not in this checkout and \`git ${args.join(' ')}\` failed (${why})` };
}

// Unavailable means `fail`, never a silent skip; only BASELINE_ALLOW_UNVERIFIED=1 turns it into an explicit `unverified`.
export function commitVerdict(root, commit, env = process.env) {
  const found = pinnedCommit(root, commit);
  if (found.ok) return { verdict: 'ok', via: found.via };
  if (env.BASELINE_ALLOW_UNVERIFIED === '1') return { verdict: 'unverified', message: `BASELINE_ALLOW_UNVERIFIED=1, so the pinned-commit checks were NOT run: ${found.reason}` };
  return { verdict: 'fail', message: `${found.reason}; set BASELINE_ALLOW_UNVERIFIED=1 to skip the pinned-commit checks explicitly` };
}

// Ancestry needs history. A shallow checkout is deepened once (`git fetch --unshallow origin`) and the pinned commit must
// then be an ancestor of HEAD. A deepening that fails is `fail`, never a skip, unless BASELINE_ALLOW_UNVERIFIED=1 turns it
// into an explicit `unverified`. Comparing trees says nothing about how the pinned commit relates to HEAD.
export function ancestryVerdict(root, commit, env = process.env) {
  if (isShallow(root)) {
    const args = ['fetch', '--no-tags', '--unshallow', 'origin'];
    const res = git(root, args, { timeout: 600000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (res.status !== 0 || isShallow(root)) {
      const why = res.error ? res.error.message : res.status === 0 ? 'the checkout is still shallow afterwards' : `exit ${res.status}: ${(res.stderr ?? '').trim().split('\n')[0]}`;
      const reason = `ancestry unavailable: the checkout is shallow and \`git ${args.join(' ')}\` failed (${why})`;
      if (env.BASELINE_ALLOW_UNVERIFIED === '1') return { verdict: 'unverified', message: `BASELINE_ALLOW_UNVERIFIED=1, so the ancestry check was NOT run: ${reason}` };
      return { verdict: 'fail', message: `${reason}; set BASELINE_ALLOW_UNVERIFIED=1 to skip the ancestry check explicitly` };
    }
  }
  return isAncestor(root, commit) ? { verdict: 'ok' } : { verdict: 'fail', message: `${commit} is not an ancestor of HEAD` };
}

// A throw-away upstream with two commits on one branch, a side-branch commit that is not an ancestor of the branch head,
// and a depth-1 clone of the branch head. The clone lacks the first (pinned) commit the way a CI checkout lacks the real
// base commit, and `origin` can serve it, so the shallow path needs no network.
export function depthOneCase(dir) {
  const ident = ['-c', 'user.name=baseline-test', '-c', 'user.email=baseline-test@example.invalid', '-c', 'commit.gpgsign=false'];
  const run = (cwd, ...args) => {
    const res = git(cwd, [...ident, ...args]);
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
    return res.stdout.trim();
  };
  const upstream = path.join(dir, 'upstream');
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(upstream, rel)), { recursive: true });
    fs.writeFileSync(path.join(upstream, rel), text);
  };
  fs.mkdirSync(upstream, { recursive: true });
  run(upstream, 'init', '-q');
  run(upstream, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  write('src/a.mjs', 'export const a = 1;\n');
  write('src/b.mjs', 'export const b = 2;\n');
  write('tests/a.test.mjs', "import '../src/a.mjs';\n");
  run(upstream, 'add', '.');
  run(upstream, 'commit', '-q', '-m', 'pinned baseline');
  const entry = (rel) => ({ path: rel, ...digestsOf(fs.readFileSync(path.join(upstream, rel))) });
  const record = {
    base_commit: run(upstream, 'rev-parse', 'HEAD'),
    source_dir: 'src',
    test_dir: 'tests',
    sources: [entry('src/a.mjs'), entry('src/b.mjs')],
    tests: [{ ...entry('tests/a.test.mjs'), test_count: 1 }]
  };
  const branch = run(upstream, 'rev-parse', '--abbrev-ref', 'HEAD');
  run(upstream, 'checkout', '-q', '-b', 'side');
  write('src/side.mjs', 'export const side = true;\n');
  run(upstream, 'add', '.');
  run(upstream, 'commit', '-q', '-m', 'side branch');
  const sideCommit = run(upstream, 'rev-parse', 'HEAD');
  run(upstream, 'checkout', '-q', branch);
  write('src/a.mjs', 'export const a = 100; // the tree moved on\n');
  run(upstream, 'commit', '-q', '-a', '-m', 'moved on');
  run(dir, 'clone', '-q', '--depth=1', `file://${upstream}`, 'checkout');
  return { checkout: path.join(dir, 'checkout'), record, sideCommit };
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
