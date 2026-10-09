import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RECORD_SCHEMA = 'bskel.track-baseline-record/2';
export const RECORD_FILE = 'adapters/http-legacy-next/BASELINE.json';
export const OWN_TESTS = ['test/http-legacy-next/baseline-record.test.mjs', 'test/http-legacy-next/interface-rfc.test.mjs'];
export const OWN_FILES = [...OWN_TESTS, 'test/http-legacy-next/baseline-record-lib.mjs', 'test/http-legacy-next/interface-rfc.vocabulary.json'];
export const RUNNER_SCRIPT = 'scripts/run-next-nested-tests.mjs';
export const AUTHORED = 'authored for this record';

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COUNT_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const DIGEST_KEYS = ['bytes', 'git_blob_sha1', 'sha256'];
const ENTRY_KEYS = ['path', ...DIGEST_KEYS];
const words = (text) => text.split(' ');

// Every set below is a literal in this reviewed file, so a re-sealed record cannot move it. The pinned commit's tree arbitrates
// the file lists (treeProblems) and baselines.mjs arbitrates the adapter table (expectationProblems); the verifier iterates
// these sets, never only what the record happens to contain.
const FIXTURES = {
  normal: {
    scan: ['scan-java-spring', 'scan-ruby-rails', 'scan-python-fastapi', 'scan-typescript-express', 'scan-javascript-express'],
    'semantic-snapshot': ['semantic-snapshot-root-relative-files'],
    shadow: ['shadow-identity-java-spring'],
    cutover: ['cutover-every-gate-true-ruby-rails'],
    checkout: ['checkout-full-python-fastapi', 'checkout-sparse-rails-read-set-materialized']
  },
  negative: {
    'snapshot-adapter': ['snapshot-adapter-contract-v3', 'snapshot-adapter-generic-grep'],
    bridge: ['bridge-report-adapter-mismatch', 'bridge-report-schema-v1'],
    'semantic-snapshot': ['semantic-snapshot-relative-root', 'semantic-snapshot-file-outside-root'],
    shadow: ['shadow-first-verb-flipped', 'shadow-projector-contract-mismatch', 'shadow-async-projector'],
    cutover: ['cutover-exact-head-ci-not-green', 'cutover-invented-gate'],
    checkout: ['checkout-sparse-fastapi-file-missing', 'checkout-sparse-rails-lib-missing', 'checkout-sparse-javascript-express-unsupported']
  }
};
const SRC = 'adapters/http-legacy-next';
const TST = 'test/http-legacy-next';
const FIXTURE_ROWS = Object.entries(FIXTURES).flatMap(([cls, apis]) => Object.entries(apis).flatMap(([api, ids]) => ids.map((id) => `${id} ${api} ${cls}`)));
export const EXPECTED = {
  record: words('schema schema_status track item suite_id title base_commit base_tree base_commit_note fixture_origin_note observed_on environment source_dir test_dir sources tests scanner_dir scanner_files inputs commands fixtures artifact_digest ci_observations limits verification'),
  identity: { schema: RECORD_SCHEMA, track: 'T11', item: 'T11-01', suite_id: 'T11', source_dir: SRC, test_dir: TST, scanner_dir: 'scanners/adapters' },
  environment: words('node platform arch os_release npm git package_lock'),
  sources: ['baselines', 'bridge', 'checkout-completeness', 'cutover-readiness', 'parity', 'shadow-projection'].map((name) => `${SRC}/${name}.mjs`),
  tests: Object.fromEntries(Object.entries({ baseline: 8, bridge: 5, 'checkout-completeness': 30, 'cutover-readiness': 12, parity: 26, 'shadow-projection': 18 }).map(([name, n]) => [`${TST}/${name}.test.mjs`, n])),
  scanner: ['adapters/_express-shared', 'adapters/_java-spring-analyzer', 'adapters/generic-grep', 'adapters/java-spring', 'adapters/javascript-express', 'adapters/python-fastapi', 'adapters/ruby-rails', 'adapters/typescript-express', 'index', 'registry', 'text-util'].map((name) => `scanners/${name}.mjs`),
  inputs: [['java-spring', 'test/fixtures/java-spring', 37], ['ruby-rails', 'test/fixtures/ruby-rails/backend', 9], ['python-fastapi', 'test/fixtures/python-fastapi/backend', 8], ['typescript-express', 'test/fixtures/typescript-express/backend', 11], ['javascript-express', 'test/fixtures/javascript-express/backend', 12]],
  commands: { 'nested-runner': words('id command cwd revision exit_code stdout_first_line runner_files runner_script result'), 'direct-tap': words('id command cwd revision exit_code result') },
  fixtureKeys: words('id class origin api input input_sha256 expected output_sha256'),
  fixtures: FIXTURE_ROWS,
  fixtureIds: FIXTURE_ROWS.map((row) => row.split(' ')[0]),
  limits: [
    ['no-next-contract-emission', 'UNSUPPORTED', FIXTURES.normal.scan],
    ['shadow-projectors-are-test-doubles', 'UNSUPPORTED', [...FIXTURES.normal.shadow, ...FIXTURES.negative.shadow]],
    ['cutover-gates-are-hand-written', 'UNKNOWN', [...FIXTURES.normal.cutover, ...FIXTURES.negative.cutover]],
    ['sparse-checkout-two-adapters-only', 'UNSUPPORTED', ['checkout-sparse-javascript-express-unsupported']],
    ['scanner-pins-are-the-static-closure', 'NOT_RECORDED', FIXTURES.normal.scan],
    ['single-runtime-observed', 'NOT_RECORDED', []],
    ['ci-observation-not-recomputable', 'NOT_RECORDED', []],
    ['real-repository-corpus', 'UNKNOWN', []],
    ['identity-and-capability-interfaces-not-frozen', 'BLOCKED', []]
  ],
  ci: { keys: words('command run_id run_number run_attempt workflow event head_sha conclusion jobs'), values: { workflow: 'CI', event: 'push', conclusion: 'success' }, jobKeys: words('id name runner conclusion step step_conclusion'), jobs: ['nested-next (22.x)', 'nested-next (24.x)'], job: { conclusion: 'success', step: 'T11 http-legacy-next', step_conclusion: 'success' } },
  verification: { keys: words('command unverified_override not_recomputed'), command: `node --test ${OWN_TESTS[0]}`, labels: ['ci_observations:', 'environment:', 'limits:', 'counterexample texts, title and notes:', 'artifact_digest is tamper evidence'] }
};

// The mismatches between a list and its exact expected set: what is missing, unexpected or repeated. Never throws.
export function exactSet(what, actual, expected) {
  if (!Array.isArray(actual)) return [`${what}: must be a list`];
  const tally = (items) => items.reduce((map, item) => map.set(String(item), (map.get(String(item)) ?? 0) + 1), new Map());
  const [have, want] = [tally(actual), tally(expected)];
  return [
    ['missing', [...want.keys()].filter((k) => !have.has(k))],
    ['unexpected', [...have.keys()].filter((k) => !want.has(k))],
    ['repeated', [...have].filter(([k, n]) => want.has(k) && n > want.get(k)).map(([k]) => k)]
  ].filter(([, names]) => names.length > 0).map(([kind, names]) => `${what}: ${kind} ${names.join(', ')}`);
}

export const exactKeys = (what, value, keys) => (value && typeof value === 'object' && !Array.isArray(value) ? exactSet(`${what} keys`, Object.keys(value), keys) : [`${what}: must be an object`]);

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const blobSha1 = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
export const digestsOf = (buf) => ({ bytes: buf.length, git_blob_sha1: blobSha1(buf), sha256: sha256(buf) });
export const fileEntry = (root, rel) => ({ path: rel, ...digestsOf(fs.readFileSync(path.join(root, rel))) });
export const readRecord = (root = REPO_ROOT) => JSON.parse(fs.readFileSync(path.join(root, RECORD_FILE), 'utf8'));
// The seal covers the whole record except artifact_digest.value, so prose (limit statements and statuses, fixture classes,
// origins, notes, CI observations) is bound as well. It is tamper evidence, not proof: whoever edits a field can re-seal it.
export const artifactDigest = (record) => sha256(canonical({
  ...record,
  artifact_digest: Object.fromEntries(Object.entries(record?.artifact_digest ?? {}).filter(([key]) => key !== 'value'))
}));
// Every module specifier a source loads: `import ... from` and `export ... from` with either quote style (also over several lines),
// side-effect `import 'x'` and a literal `import('x')`. A computed import() or a require cannot be listed, so it is returned as
// `opaque` for the caller to refuse. Comments are ignored.
export function importsOf(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');
  const specs = [...code.matchAll(/\b(?:import|export)\b[^'"`;()]*?\bfrom\s*(['"])([^'"\n]+)\1|\bimport\s*(['"])([^'"\n]+)\3|\bimport\s*\(\s*(['"])([^'"\n]+)\5\s*\)/g)].map((m) => m[2] ?? m[4] ?? m[6]);
  const opaque = [...code.matchAll(/\bimport\s*\((?!\s*['"][^'"\n]+['"]\s*\))|\brequire\s*\(|\bcreateRequire\b/g)].map((m) => m[0]);
  return { specs, opaque };
}
export const flip = (hex) => `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`;
export const tapCommand = (files) => ['node', '--test', '--test-reporter=tap', ...files].join(' ');

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

// Every file the record pins by size, sha256 and blob id: T11's sources and tests, the stable scanner files they run
// (the static import closure plus every adapter the registry loads) and the five fixture trees.
export const pinnedEntries = (r) => [
  ...(Array.isArray(r?.sources) ? r.sources : []),
  ...(Array.isArray(r?.tests) ? r.tests : []),
  ...(Array.isArray(r?.scanner_files) ? r.scanner_files : []),
  ...(Array.isArray(r?.inputs) ? r.inputs.flatMap((g) => (Array.isArray(g?.files) ? g.files : [])) : [])
];

// Pins that only the base commit can arbitrate: the nested runner script and the lock file.
export const gitOnlyPins = (r) => [
  (r?.commands ?? []).find((c) => c.id === 'nested-runner')?.runner_script,
  r?.environment?.package_lock
].filter(Boolean);

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

// Both content hashes describe the same file, so a record that disagrees with the file in exactly one hash (or in the
// size alone) is a damaged entry, never a moved tree. Only a file that matches neither hash is drift, and only the
// pinned commit can arbitrate drift.
export function classifyEntry(entry, buf) {
  if (!Buffer.isBuffer(buf)) return { state: 'missing', detail: `${entry?.path} cannot be read` };
  const actual = digestsOf(buf);
  const wrong = DIGEST_KEYS.filter((k) => entry?.[k] !== actual[k]);
  if (wrong.length === 0) return { state: 'fresh' };
  if (wrong.includes('git_blob_sha1') && wrong.includes('sha256')) return { state: 'drift', detail: `${entry.path} differs from the record` };
  const agree = DIGEST_KEYS.filter((k) => !wrong.includes(k)).join(' and ');
  return { state: 'corrupt', detail: `${entry?.path}: the record's ${wrong.join(' and ')} disagree with the file while its ${agree} agree` };
}

// Without `read` only the record itself is checked, against the literal EXPECTED tables: the exact key sets, ids, directories,
// counts and statuses, never "at least one" or "whatever is present". With `read` (a path -> Buffer|null function over the live
// tree or the pinned commit) the size and both digests of every pinned file, the runner script and the lock file are recomputed too.
export function verifyRecord(r, read, label = 'recompute') {
  const problems = [];
  const bad = (message) => problems.push(message);
  const keys = (what, value, expected) => problems.push(...exactKeys(what, value, expected));
  const sets = (what, actual, expected) => problems.push(...exactSet(what, actual, expected));
  const is = (what, actual, expected) => { if (actual !== expected) bad(`${what} must be ${expected}, not ${actual}`); };
  const text = (what, value) => { if (typeof value !== 'string' || value.trim() === '') bad(`${what} must be a non-empty string`); };
  const list = (value) => (Array.isArray(value) ? value : []);
  const count = (n) => Number.isInteger(n) && n >= 0;
  const entryOk = (e) => typeof e?.path === 'string' && count(e.bytes) && SHA1.test(e.git_blob_sha1 ?? '') && SHA256.test(e.sha256 ?? '');
  const pins = (what, entries, paths, extra = []) => {
    sets(`${what} paths`, list(entries).map((e) => e?.path), paths);
    for (const e of list(entries)) {
      keys(`${what} ${e?.path}`, e, [...ENTRY_KEYS, ...extra]);
      if (!entryOk(e)) bad(`${what}: malformed entry ${e?.path}`);
    }
  };
  keys('record', r, EXPECTED.record);
  for (const [key, value] of Object.entries(EXPECTED.identity)) is(key, r?.[key], value);
  for (const key of ['schema_status', 'title', 'base_commit_note', 'fixture_origin_note']) text(key, r?.[key]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r?.observed_on ?? '')) bad('observed_on must be a YYYY-MM-DD date');
  if (!SHA1.test(r?.base_commit ?? '')) bad('base_commit must be a 40-hex commit id');
  if (!SHA1.test(r?.base_tree ?? '')) bad('base_tree must be a 40-hex tree id');
  keys('environment', r?.environment, EXPECTED.environment);
  for (const key of EXPECTED.environment.filter((k) => k !== 'package_lock')) text(`environment.${key}`, r?.environment?.[key]);
  pins('sources', r?.sources, EXPECTED.sources);
  pins('tests', r?.tests, Object.keys(EXPECTED.tests), ['test_count']);
  for (const e of list(r?.tests)) is(`tests: ${e?.path} test_count`, e?.test_count, EXPECTED.tests[e?.path]);
  pins('scanner_files', r?.scanner_files, EXPECTED.scanner);
  sets('inputs ids', list(r?.inputs).map((g) => g?.id), EXPECTED.inputs.map(([id]) => id));
  for (const [id, dir, n] of EXPECTED.inputs) {
    const g = list(r?.inputs).find((x) => x?.id === id);
    if (!g) continue;
    keys(`inputs ${id}`, g, ['id', 'dir', 'git_tree_id', 'files']);
    is(`inputs: ${id} dir`, g.dir, dir);
    if (!SHA1.test(g.git_tree_id ?? '')) bad(`inputs: ${id} git_tree_id must be a 40-hex tree id`);
    if (list(g.files).length !== n) bad(`inputs: ${id} must pin exactly ${n} files, not ${list(g.files).length}`);
    for (const e of list(g.files)) {
      keys(`inputs ${id} ${e?.path}`, e, ENTRY_KEYS);
      if (!entryOk(e) || !e.path.startsWith(`${dir}/`)) bad(`inputs: ${id}: malformed entry ${e?.path}`);
    }
  }
  const commands = list(r?.commands);
  const [runner, direct] = ['nested-runner', 'direct-tap'].map((id) => commands.find((c) => c?.id === id));
  for (const c of commands) {
    keys(`command ${c?.id}`, c, EXPECTED.commands[c?.id] ?? []);
    text(`command ${c?.id}: command text`, c?.command);
    if (!Number.isInteger(c?.exit_code)) bad(`command ${c?.id}: exit_code must be an integer`);
    if (c?.revision !== r?.base_commit) bad(`command ${c?.id}: revision is not the base commit`);
    if (!COUNT_KEYS.every((k) => count(c?.result?.[k]))) bad(`command ${c?.id}: result needs integer ${COUNT_KEYS.join('/')}`);
    else if (c.exit_code === 0 && (c.result.fail !== 0 || c.result.cancelled !== 0)) bad(`command ${c.id}: exit_code 0 contradicts failing tests`);
  }
  // The replay runs exactly these two commands, so a third or a repeated one would claim an exit code that nothing re-ran.
  if (canonical(commands.map((c) => c?.id).sort()) !== canonical(['direct-tap', 'nested-runner'])) bad('commands must be exactly nested-runner and direct-tap, once each: the replay runs no other command');
  else {
    const names = list(r.tests).map((t) => t?.path);
    const total = list(r.tests).reduce((sum, t) => sum + (t?.test_count ?? 0), 0);
    if (runner.command !== `node scripts/run-next-nested-tests.mjs ${r.suite_id}`) bad('nested-runner command does not name the suite');
    if (runner.runner_files !== names.length) bad('nested-runner runner_files does not match the recorded test files');
    if (runner.stdout_first_line !== `NESTED_SUITE ${r.suite_id} RUN ${runner.runner_files} files`) bad('nested-runner stdout_first_line does not match the suite and file count');
    if (runner.runner_script?.path !== RUNNER_SCRIPT || !entryOk(runner.runner_script)) bad(`nested-runner runner_script must pin ${RUNNER_SCRIPT} by size, blob id and sha256`);
    keys('nested-runner runner_script', runner.runner_script, ENTRY_KEYS);
    if (direct.command !== tapCommand(names)) bad('direct-tap command does not list exactly the recorded test files');
    if (direct.result?.tests !== total) bad(`direct-tap tests ${direct.result?.tests} != sum of per-file test_count ${total}`);
    if (runner.result?.tests !== direct.result?.tests) bad('nested-runner and direct-tap disagree on the test count');
  }
  const lock = r?.environment?.package_lock;
  keys('environment.package_lock', lock, ENTRY_KEYS);
  if (lock?.path !== 'package-lock.json' || !entryOk(lock)) bad('environment.package_lock must pin package-lock.json by size, blob id and sha256');
  const fixtures = list(r?.fixtures);
  sets('fixtures (id api class)', fixtures.map((f) => `${f?.id} ${f?.api} ${f?.class}`), EXPECTED.fixtures);
  for (const f of fixtures) {
    keys(`fixture ${f?.id}`, f, f?.class === 'negative' ? [...EXPECTED.fixtureKeys, 'counterexample'] : EXPECTED.fixtureKeys);
    if (f?.class === 'negative') text(`${f.id}: counterexample (what the negative fixture is a counterexample of)`, f.counterexample);
    if (!(f?.origin === AUTHORED || /^\S+\.mjs:\d+ \(.+\)$/.test(f?.origin ?? ''))) bad(`${f?.id}: origin must cite a test file line or say it was authored for this record`);
    if (sha256(canonical(f?.input)) !== f?.input_sha256) bad(`${f?.id}: input_sha256 does not match the recorded input`);
    if (f?.api === 'scan' && canonical(f.input) !== canonical({ adapter: String(f.id).replace(/^scan-/, '') })) bad(`${f.id}: a scan fixture's input must be exactly its adapter id`);
    if (!SHA256.test(f?.output_sha256 ?? '')) bad(`${f?.id}: output_sha256 must be a 64-hex digest`);
    if (!f?.expected || typeof f.expected !== 'object') bad(`${f?.id}: expected summary is missing`);
  }
  keys('artifact_digest', r?.artifact_digest, ['algorithm', 'covers', 'value']);
  if (r?.artifact_digest?.algorithm !== 'sha256' || !SHA256.test(r?.artifact_digest?.value ?? '')) bad('artifact_digest needs algorithm sha256 and a 64-hex value');
  else if (r.artifact_digest.value !== artifactDigest(r)) bad('artifact_digest does not match the record (it covers every field except its own value)');
  const limits = list(r?.limits);
  sets('limits (id status)', limits.map((l) => `${l?.id} ${l?.status}`), EXPECTED.limits.map(([id, status]) => `${id} ${status}`));
  for (const [id, , fixtureIds] of EXPECTED.limits) {
    const l = limits.find((x) => x?.id === id);
    if (!l) continue;
    keys(`limit ${id}`, l, ['id', 'status', 'statement', ...(fixtureIds.length ? ['fixtures'] : [])]);
    text(`limit ${id}: statement`, l.statement);
    if (fixtureIds.length) sets(`limit ${id} fixtures`, l.fixtures, fixtureIds);
  }
  const { ci, verification: expectedVerification } = EXPECTED;
  const observations = list(r?.ci_observations);
  if (observations.length !== 1) bad(`ci_observations must hold exactly one observation, not ${observations.length}`);
  for (const o of observations) {
    keys('ci observation', o, ci.keys);
    for (const [k, v] of Object.entries(ci.values)) is(`ci run ${o?.run_id}: ${k}`, o?.[k], v);
    is(`ci run ${o?.run_id}: head_sha`, o?.head_sha, r?.base_commit);
    for (const k of ['run_id', 'run_number', 'run_attempt']) if (!Number.isInteger(o?.[k]) || o[k] < 1) bad(`ci run ${o?.run_id}: ${k} must be a positive integer`);
    text(`ci run ${o?.run_id}: command`, o?.command);
    sets(`ci run ${o?.run_id} jobs`, list(o?.jobs).map((j) => j?.name), ci.jobs);
    for (const j of list(o?.jobs)) {
      keys(`ci job ${j?.name}`, j, ci.jobKeys);
      if (!Number.isInteger(j?.id)) bad(`ci job ${j?.name}: id must be an integer`);
      text(`ci job ${j?.name}: runner`, j?.runner);
      for (const [k, v] of Object.entries(ci.job)) is(`ci job ${j?.name}: ${k}`, j?.[k], v);
    }
  }
  keys('verification', r?.verification, expectedVerification.keys);
  is('verification.command', r?.verification?.command, expectedVerification.command);
  if (!String(r?.verification?.unverified_override).startsWith('BASELINE_ALLOW_UNVERIFIED=1')) bad('verification.unverified_override must name BASELINE_ALLOW_UNVERIFIED=1');
  const notRecomputed = list(r?.verification?.not_recomputed);
  if (!notRecomputed.every((x) => typeof x === 'string' && x.trim() !== '')) bad('verification.not_recomputed must list what the test does not recompute');
  sets('verification.not_recomputed', notRecomputed.map((x) => expectedVerification.labels.find((l) => String(x).startsWith(l)) ?? x), expectedVerification.labels);
  if (read) {
    problems.push(...recomputeProblems([...pinnedEntries(r), ...gitOnlyPins(r)], read, label));
    problems.push(...originProblems(r, read));
  }
  return problems;
}

// What only the pinned commit can arbitrate. `tree` is {read(path) -> Buffer|null, list(dir) -> paths, id(dir) -> git tree id}.
export const commitTree = (root, commit) => ({ read: commitReader(root, commit), list: (dir) => listAtCommit(root, commit, dir) ?? [], id: (dir) => revParse(root, `${commit}:${dir}`) });

// Static import closure of the scanner: the entry points, every adapter the registry loads by directory listing (a leading
// underscore marks a helper that is only reached by import), and each relative .mjs file they import.
export function closureOf(tree) {
  const seen = new Set();
  const todo = ['scanners/index.mjs', 'scanners/registry.mjs', ...tree.list('scanners/adapters').filter((p) => p.endsWith('.mjs') && !path.posix.basename(p).startsWith('_'))];
  while (todo.length > 0) {
    const rel = todo.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const buf = tree.read(rel);
    for (const spec of buf ? importsOf(buf.toString('utf8')).specs : []) if (/^\.\.?\/.+\.mjs$/.test(spec)) todo.push(path.posix.join(path.posix.dirname(rel), spec));
  }
  return [...seen].sort();
}

// The tables of this file against the pinned commit's tree: the modules, tests, scanner files (listing and import closure) and
// fixture trees it holds, with their tree ids and file counts. The record is compared with the same tables by verifyRecord.
export function treeProblems(r, tree) {
  const files = (dir, suffix) => tree.list(dir).filter((p) => p.endsWith(suffix));
  const problems = [
    ...exactSet('pinned tree modules', files(EXPECTED.identity.source_dir, '.mjs'), EXPECTED.sources),
    ...exactSet('pinned tree tests', files(EXPECTED.identity.test_dir, '.test.mjs'), Object.keys(EXPECTED.tests)),
    ...exactSet('pinned tree scanner adapters', files(EXPECTED.identity.scanner_dir, '.mjs'), EXPECTED.scanner.filter((p) => p.startsWith(`${EXPECTED.identity.scanner_dir}/`))),
    ...exactSet('pinned tree scanner closure', closureOf(tree), EXPECTED.scanner)
  ];
  for (const [id, dir, n] of EXPECTED.inputs) {
    const [g, listed, treeId] = [(Array.isArray(r?.inputs) ? r.inputs : []).find((x) => x?.id === id), tree.list(dir), tree.id(dir)];
    if (listed.length !== n) problems.push(`pinned tree ${dir}: ${listed.length} files, expected ${n}`);
    problems.push(...exactSet(`${id} files, record against pinned tree`, (g?.files ?? []).map((e) => e?.path), listed));
    if (g?.git_tree_id !== treeId) problems.push(`${id}: git_tree_id ${g?.git_tree_id} != pinned tree ${treeId}`);
  }
  return problems;
}

// The baselines.mjs of the tree under test must list exactly the adapters and fixture directories the tables name.
export function expectationProblems(m) {
  return [
    ...exactSet('baselines.mjs LEGACY_HTTP_ADAPTER_IDS', m.baselines.LEGACY_HTTP_ADAPTER_IDS, EXPECTED.inputs.map(([id]) => id)),
    ...EXPECTED.inputs.filter(([id, dir]) => m.baselines.legacyHttpBaseline(id)?.fixture !== dir).map(([id, dir]) => `baselines.mjs: ${id} fixture is not ${dir}`)
  ];
}

// An origin of the form `path.mjs:LINE (title)` must name a recorded test file whose line LINE holds that title.
export function originProblems(r, read) {
  const problems = [];
  for (const f of r?.fixtures ?? []) {
    const m = /^(\S+\.mjs):(\d+) \((.+)\)$/.exec(f.origin ?? '');
    if (!m) continue;
    const buf = (r.tests ?? []).some((t) => t.path === m[1]) ? read(m[1]) : null;
    if (!buf) problems.push(`${f.id}: origin file ${m[1]} is not a readable recorded test`);
    else if (!(buf.toString('utf8').split('\n')[Number(m[2]) - 1] ?? '').includes(m[3])) problems.push(`${f.id}: ${m[1]} line ${m[2]} does not hold "${m[3]}"`);
  }
  return problems;
}

function listFiles(root, rel) {
  const out = [];
  const visit = (dir) => {
    if (!fs.existsSync(path.join(root, dir))) return;
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name !== '.DS_Store') out.push(child);
    }
  };
  visit(rel);
  return out.sort();
}

// The record is a baseline of base_commit. Every pinned file is compared with the live file by size, sha256 and blob id
// (never by the record's own blob id alone): `corrupt` entries are damage and must fail the caller, `moved` files mean
// the tree has left the baseline (live replays are skipped and the pinned commit decides), `fresh` means all agree.
export function classifyLive(record, root = REPO_ROOT, inputDirs = EXPECTED.inputs.map(([, dir]) => dir)) {
  const read = liveReader(root);
  const states = [...pinnedEntries(record), ...gitOnlyPins(record)].map((e) => ({ path: e.path, ...classifyEntry(e, read(e.path)) }));
  const recorded = new Set(states.map((s) => s.path));
  // The fixture trees come from the table as well as from the record, so a record that dropped a tree cannot hide a changed file in it.
  const trees = new Set([...inputDirs, ...(Array.isArray(record.inputs) ? record.inputs : []).map((g) => g?.dir)].filter(Boolean));
  const extras = [
    ...listFiles(root, record.source_dir).filter((p) => !p.endsWith('.md') && p !== RECORD_FILE && !recorded.has(p)),
    ...(record.scanner_dir ? listFiles(root, record.scanner_dir) : []).filter((p) => p.endsWith('.mjs') && !recorded.has(p)),
    ...listFiles(root, record.test_dir).filter((p) => !recorded.has(p) && !OWN_FILES.includes(p)),
    ...[...trees].flatMap((dir) => listFiles(root, dir).filter((p) => !recorded.has(p)))
  ];
  const corrupt = states.filter((s) => s.state === 'corrupt').map((s) => s.detail);
  const moved = [...states.filter((s) => s.state === 'drift' || s.state === 'missing').map((s) => s.path), ...extras];
  return { corrupt, moved, fresh: corrupt.length === 0 && moved.length === 0 };
}

// ---- fixtures: every API call below goes through the T11 modules and the stable scanner of one tree (live or exported) ----

export async function loadModules(dir) {
  const load = (rel) => import(pathToFileURL(path.join(dir, rel)).href);
  const t11 = (name) => load(`adapters/http-legacy-next/${name}.mjs`);
  return {
    dir,
    scan: await load('scanners/index.mjs'),
    registry: await load('scanners/registry.mjs'),
    baselines: await t11('baselines'),
    bridge: await t11('bridge'),
    parity: await t11('parity'),
    shadow: await t11('shadow-projection'),
    cutover: await t11('cutover-readiness'),
    checkout: await t11('checkout-completeness')
  };
}

const PROJECTOR_ID = 'baseline-record-projector';
const PROJECTOR_CONTRACT = 'baseline-record-projector/0';
const PROJECTORS = {
  identity: ({ legacy_semantic_snapshot: s }) => ({ projector_contract: PROJECTOR_CONTRACT, semantic_snapshot: structuredClone(s) }),
  'wrong-contract': () => ({ projector_contract: 'other/0', semantic_snapshot: {} }),
  async: async () => ({ projector_contract: PROJECTOR_CONTRACT }),
  'flip-first-verb': ({ legacy_semantic_snapshot: s }) => {
    const copy = structuredClone(s);
    const endpoint = copy.modules[0].controllers[0].endpoints[0];
    endpoint.verb = endpoint.verb === 'GET' ? 'POST' : 'GET';
    return { projector_contract: PROJECTOR_CONTRACT, semantic_snapshot: copy };
  }
};

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T11 Fixture',
  GIT_AUTHOR_EMAIL: 't11@example.invalid',
  GIT_COMMITTER_NAME: 'T11 Fixture',
  GIT_COMMITTER_EMAIL: 't11@example.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
};

const adapterOf = (m, spec) => ({ ...m.registry.ADAPTERS.find((a) => a.id === spec.id), ...(spec.patch ?? {}) });

function scanOf(m, id) {
  const root = path.resolve(m.dir, m.baselines.legacyHttpBaseline(id).fixture);
  return { root, report: m.scan.runScan({ repoRoot: root, terms: [] }) };
}

// A throw-away git repository with a pinned identity and dates, so the checked head is the same everywhere.
export function checkoutOutcome(m, input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t11-baseline-'));
  try {
    const git = (...args) => {
      const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
      if (res.status !== 0) throw new Error(`fixture setup: git ${args.join(' ')} failed: ${res.stderr}`);
    };
    git('init', '--quiet', '--initial-branch=main');
    for (const [rel, content] of Object.entries(input.files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    if (input.sparse) {
      git('sparse-checkout', 'init', '--cone');
      git('sparse-checkout', 'set', ...input.sparse);
    }
    const options = { repoRoot: dir, adapterId: input.adapter, ...(input.max_missing ? { maxMissing: input.max_missing } : {}) };
    const inspect = m.checkout.inspectLegacyCorpusCheckout(options);
    let assertThrew = null;
    try {
      m.checkout.assertLegacyCorpusCheckoutComplete(options);
    } catch (error) {
      assertThrew = { name: error.name, code: error.code, message: error.message };
    }
    return { inspect, assert_threw: assertThrew };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Absolute fixture roots differ per machine, so every occurrence is replaced by a placeholder before hashing; nothing else is dropped.
const relocate = (value, root) => {
  if (typeof value === 'string') return value.split(root).join('<root>');
  if (Array.isArray(value)) return value.map((x) => relocate(x, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relocate(v, root)]));
  return value;
};

// `edit` mutates a copy of the report, so a negative test can change one field and see which digests notice.
export function scanOutcome(m, id, edit = () => {}) {
  const { root, report: scanned } = scanOf(m, id);
  const report = structuredClone(scanned);
  edit(report);
  const bridged = m.bridge.bridgeLegacyHttpScan({ adapter: adapterOf(m, { id }), report });
  return {
    adapter: report.adapter,
    verdict: report.verdict,
    confidence: report.confidence,
    inventory: m.bridge.summarizeLegacyHttpReport(report),
    descriptor: bridged.source_adapter,
    bridge: { schema: bridged.schema, mode: bridged.mode, source_scan_schema: bridged.source_scan_schema, lossless: canonical(bridged.legacy_report) === canonical(report) },
    semantic_sha256: m.parity.legacyHttpSemanticDigest(report, { root }),
    semantic_snapshot: m.parity.legacyHttpSemanticSnapshot(report, { root }),
    legacy_report: relocate(report, root)
  };
}

function execute(f, m) {
  const i = f.input;
  switch (f.api) {
    case 'scan':
      return scanOutcome(m, i.adapter);
    case 'bridge': {
      const bridged = m.bridge.bridgeLegacyHttpScan({ adapter: adapterOf(m, i.adapter), report: i.report });
      return { schema: bridged.schema, mode: bridged.mode, source_adapter: bridged.source_adapter };
    }
    case 'snapshot-adapter':
      return m.bridge.snapshotLegacyHttpAdapter(adapterOf(m, i.adapter));
    case 'semantic-snapshot':
      return m.parity.legacyHttpSemanticSnapshot(i.report, { root: i.root });
    case 'shadow': {
      const { root, report } = scanOf(m, i.adapter);
      return m.shadow.runLegacyHttpShadowProjection({
        adapter: adapterOf(m, { id: i.adapter }),
        report,
        projector: PROJECTORS[i.projector],
        projectorId: PROJECTOR_ID,
        projectorContract: PROJECTOR_CONTRACT,
        root
      });
    }
    case 'cutover':
      return m.cutover.evaluateLegacyHttpCutoverReadiness(i);
    case 'checkout':
      return checkoutOutcome(m, i);
    default:
      throw new Error(`unknown api ${f.api}`);
  }
}

export function runFixture(f, modules) {
  try {
    return JSON.parse(JSON.stringify(execute(f, modules)));
  } catch (error) {
    return { threw: { name: error.name, message: error.message, ...(error.code ? { code: error.code } : {}) } };
  }
}

export function summarize(api, out) {
  if (out.threw) return { threw: `${out.threw.name}${out.threw.code ? ` [${out.threw.code}]` : ''}: ${out.threw.message}` };
  switch (api) {
    case 'scan':
      return { adapter: out.adapter, verdict: out.verdict, confidence: out.confidence, inventory: out.inventory, bridge: out.bridge, semantic_sha256: out.semantic_sha256 };
    case 'bridge':
      return { schema: out.schema, mode: out.mode, adapter: out.source_adapter.id };
    case 'snapshot-adapter':
      return { adapter: out.id, contract: out.contract };
    case 'semantic-snapshot':
      return { adapter: out.adapter, controller_files: out.modules.flatMap((mod) => mod.controllers.map((c) => c.file)) };
    case 'shadow':
      return {
        mode: out.mode,
        adapter_id: out.adapter_id,
        authoritative_source: out.authoritative_source,
        promotion_allowed: out.promotion_allowed,
        equal: out.parity.equal,
        diffs: out.parity.diffs.map((d) => `${d.path} ${d.kind}`),
        legacy_semantic_sha256: out.legacy_semantic_sha256
      };
    case 'cutover':
      return { ready_for_t00_integration: out.ready_for_t00_integration, apply_allowed: out.apply_allowed, blockers: out.blockers };
    case 'checkout':
      return {
        complete: out.inspect.complete,
        mode: out.inspect.mode,
        missing_count: out.inspect.missing_count,
        missing_paths: out.inspect.missing_paths,
        assert_threw: out.assert_threw ? `${out.assert_threw.code}: ${out.assert_threw.message}` : null
      };
    default:
      throw new Error(`unknown api ${api}`);
  }
}

export function replay(record, modules) {
  return record.fixtures.map((f) => {
    const out = runFixture(f, modules);
    const text = canonical(out);
    return { id: f.id, deterministic: text === canonical(runFixture(f, modules)), output_sha256: sha256(text), expected: summarize(f.api, out) };
  });
}

// The replayed ids must be exactly the table's 24, so a record that lost fixtures cannot make the replay run only the survivors.
export function replayProblems(record, computed) {
  const problems = exactSet('replayed fixture ids', computed.map((c) => c.id), EXPECTED.fixtureIds);
  for (const f of record.fixtures) {
    const c = computed.find((x) => x.id === f.id);
    if (!c) { problems.push(`${f.id}: not replayed`); continue; }
    if (!c.deterministic) problems.push(`${f.id}: two runs differ`);
    if (c.output_sha256 !== f.output_sha256) problems.push(`${f.id}: output sha256 ${c.output_sha256} != recorded ${f.output_sha256}`);
    if (canonical(c.expected) !== canonical(f.expected)) problems.push(`${f.id}: expected summary differs: ${canonical(c.expected)}`);
  }
  return problems;
}

// ---- git: the pinned commit is read from the checkout, fetched once when absent, and never silently skipped ----

function git(root, args, options = {}) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options });
}

export const isShallow = (root) => git(root, ['rev-parse', '--is-shallow-repository']).stdout?.trim() === 'true';
export const hasCommit = (root, commit) => git(root, ['cat-file', '-e', `${commit}^{commit}`]).status === 0;

// A checkout that lacks the commit gets one fetch of exactly that commit (--depth=1 only when the checkout is already
// shallow, so a full clone never becomes shallow).
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

const IDENT = ['-c', 'user.name=baseline-test', '-c', 'user.email=baseline-test@example.invalid', '-c', 'commit.gpgsign=false'];
function run(cwd, ...args) {
  const res = git(cwd, [...IDENT, ...args]);
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

// A throw-away upstream with two commits and a depth-1 clone of the second one. The clone lacks the first (pinned) commit
// the way a CI checkout lacks the real base commit, and `origin` can serve it, so the shallow path needs no network.
export function depthOneCase(dir) {
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
  write('scan/x.mjs', 'export const x = 1;\n');
  run(upstream, 'add', '.');
  run(upstream, 'commit', '-q', '-m', 'pinned baseline');
  const entry = (rel) => fileEntry(upstream, rel);
  const record = {
    base_commit: run(upstream, 'rev-parse', 'HEAD'),
    source_dir: 'src',
    test_dir: 'tests',
    scanner_dir: 'scan',
    scanner_files: [entry('scan/x.mjs')],
    sources: [entry('src/a.mjs'), entry('src/b.mjs')],
    tests: [{ ...entry('tests/a.test.mjs'), test_count: 1 }],
    inputs: []
  };
  write('src/a.mjs', 'export const a = 100; // the tree moved on\n');
  write('scan/new.mjs', 'export const added = true;\n');
  run(upstream, 'add', '.');
  run(upstream, 'commit', '-q', '-m', 'moved on');
  run(dir, 'clone', '-q', '--depth=1', `file://${upstream}`, 'checkout');
  return { checkout: path.join(dir, 'checkout'), record };
}

// What the pinned commit exists to refuse: a well-formed, re-sealed record whose base_commit and base_tree are invented while
// every live hash matches. The working tree is copied into a throw-away upstream and cloned with --depth=1, so the checkout
// lacks the commit the record names and `origin` cannot serve an invented one.
export function forgedCheckout(dir) {
  const upstream = path.join(dir, 'upstream');
  const skip = [path.join(REPO_ROOT, '.git'), path.join(REPO_ROOT, 'node_modules')];
  fs.cpSync(REPO_ROOT, upstream, { recursive: true, verbatimSymlinks: true, filter: (src) => !skip.includes(src) });
  run(upstream, 'init', '-q');
  run(upstream, 'add', '-A');
  run(upstream, 'commit', '-q', '-m', 'copy of the working tree');
  run(dir, 'clone', '-q', '--depth=1', `file://${upstream}`, 'checkout');
  const checkout = path.join(dir, 'checkout');
  const real = readRecord(checkout);
  const invent = (text) => text.replaceAll(real.base_commit, 'a'.repeat(40)).replaceAll(real.base_tree, 'b'.repeat(40));
  const forged = JSON.parse(invent(JSON.stringify(real)));
  forged.artifact_digest.value = artifactDigest(forged);
  fs.writeFileSync(path.join(checkout, RECORD_FILE), `${JSON.stringify(forged, null, 2)}\n`);
  return checkout;
}

export function revParse(root, spec) {
  const res = git(root, ['rev-parse', spec]);
  return res.status === 0 ? res.stdout.trim() : null;
}

export const isAncestor = (root, commit) => git(root, ['merge-base', '--is-ancestor', commit, 'HEAD']).status === 0;

export function listAtCommit(root, commit, dir) {
  const res = git(root, ['ls-tree', '-r', '--full-name', '--name-only', commit, '--', dir]);
  return res.status === 0 ? res.stdout.split('\n').filter(Boolean).sort() : null;
}

// The whole tree of the pinned commit, so the scanner and the T11 modules run exactly as they did at that commit.
// node_modules is shared with the live checkout; it holds no repository code.
export function extractTree(root, commit, dest) {
  const archive = spawnSync('git', ['archive', '--format=tar', commit], { cwd: root, maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive ${commit} failed: ${archive.stderr}`);
  const unpack = spawnSync('tar', ['-xf', '-', '-C', dest], { input: archive.stdout, maxBuffer: 64 * 1024 * 1024 });
  if (unpack.status !== 0) throw new Error(`tar failed: ${unpack.stderr}`);
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(dest, 'node_modules'), 'dir');
}

// The recorded commands, run as child processes (concurrently when awaited together). NODE_TEST_CONTEXT is removed so a
// child `node --test` is a top-level run, not a reporter of the test process that started it.
function runNode(root, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => {
      const result = {};
      for (const m of stdout.matchAll(/^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) result[m[1]] = Number(m[2]);
      resolve({ exit_code: code, stdout, stdout_first_line: stdout.split('\n')[0], result });
    });
  });
}

export const runNestedRunner = (root, suiteId) => runNode(root, [RUNNER_SCRIPT, suiteId]);
export const runTapTests = (root, files) => runNode(root, ['--test', '--test-reporter=tap', ...files]);
// Only the pinned-commit test of this record, as a top-level run in `root`; the override is off unless the caller sets it.
export const runPinnedCheck = (root, env = {}) => runNode(root, ['--test', '--test-reporter=tap', '--test-name-pattern=the pinned commit has the recorded tree', OWN_TESTS[0]], { BASELINE_ALLOW_UNVERIFIED: '', ...env });
