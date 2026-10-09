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
export const APIS = ['scan', 'bridge', 'snapshot-adapter', 'semantic-snapshot', 'shadow', 'cutover', 'checkout'];

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LIMIT_STATUSES = ['UNSUPPORTED', 'UNKNOWN', 'BLOCKED', 'NOT_RECORDED'];
const COUNT_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const DIGEST_KEYS = ['bytes', 'git_blob_sha1', 'sha256'];

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

// Without `read` only the record itself is checked. With `read` (a path -> Buffer|null function over the live tree or the
// pinned commit) the size and both digests of every pinned file, the runner script and the lock file are recomputed.
export function verifyRecord(r, read, label = 'recompute') {
  const problems = [];
  const bad = (message) => problems.push(message);
  const count = (n) => Number.isInteger(n) && n >= 0;
  const entryOk = (e, dir) => typeof e?.path === 'string' && e.path.startsWith(`${dir}/`) && count(e.bytes) && SHA1.test(e.git_blob_sha1 ?? '') && SHA256.test(e.sha256 ?? '');
  if (r?.schema !== RECORD_SCHEMA) bad(`schema must be ${RECORD_SCHEMA}`);
  for (const key of ['track', 'item', 'suite_id', 'source_dir', 'test_dir']) {
    if (typeof r?.[key] !== 'string' || r[key] === '') bad(`${key} must be a non-empty string`);
  }
  if (!SHA1.test(r?.base_commit ?? '')) bad('base_commit must be a 40-hex commit id');
  if (!SHA1.test(r?.base_tree ?? '')) bad('base_tree must be a 40-hex tree id');
  for (const [group, dirKey] of [['sources', 'source_dir'], ['tests', 'test_dir']]) {
    if (!Array.isArray(r?.[group]) || r[group].length === 0) { bad(`${group} must list at least one file`); continue; }
    for (const e of r[group]) {
      if (!entryOk(e, r[dirKey])) bad(`${group}: malformed entry ${e?.path}`);
      if (group === 'tests' && !count(e?.test_count)) bad(`tests: ${e?.path} needs an integer test_count`);
    }
  }
  if (typeof r?.scanner_dir !== 'string' || r.scanner_dir === '') bad('scanner_dir must name the directory the registry loads adapters from');
  if (!Array.isArray(r?.scanner_files) || r.scanner_files.length === 0) bad('scanner_files must list the stable scanner files');
  for (const e of Array.isArray(r?.scanner_files) ? r.scanner_files : []) if (!entryOk(e, 'scanners')) bad(`scanner_files: malformed entry ${e?.path}`);
  for (const wanted of ['scanners/index.mjs', 'scanners/registry.mjs']) if (!(r?.scanner_files ?? []).some((e) => e.path === wanted)) bad(`scanner_files must pin ${wanted}`);
  if (!Array.isArray(r?.inputs) || r.inputs.length === 0) bad('inputs must list the fixture trees');
  for (const g of Array.isArray(r?.inputs) ? r.inputs : []) {
    if (typeof g?.id !== 'string' || typeof g?.dir !== 'string' || !SHA1.test(g?.git_tree_id ?? '') || !Array.isArray(g?.files) || g.files.length === 0) { bad(`inputs: malformed tree ${g?.id}`); continue; }
    for (const e of g.files) if (!entryOk(e, g.dir)) bad(`inputs: ${g.id}: malformed entry ${e?.path}`);
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
    const names = (r.tests ?? []).map((t) => t.path);
    const total = (r.tests ?? []).reduce((sum, t) => sum + (t.test_count ?? 0), 0);
    if (runner.command !== `node scripts/run-next-nested-tests.mjs ${r.suite_id}`) bad('nested-runner command does not name the suite');
    if (runner.runner_files !== names.length) bad('nested-runner runner_files does not match the recorded test files');
    if (runner.stdout_first_line !== `NESTED_SUITE ${r.suite_id} RUN ${runner.runner_files} files`) bad('nested-runner stdout_first_line does not match the suite and file count');
    if (runner.runner_script?.path !== RUNNER_SCRIPT || !entryOk(runner.runner_script, 'scripts')) bad(`nested-runner runner_script must pin ${RUNNER_SCRIPT} by size, blob id and sha256`);
    if (direct.command !== tapCommand(names)) bad('direct-tap command does not list exactly the recorded test files');
    if (direct.result?.tests !== total) bad(`direct-tap tests ${direct.result?.tests} != sum of per-file test_count ${total}`);
    if (runner.result?.tests !== direct.result?.tests) bad('nested-runner and direct-tap disagree on the test count');
  }
  const lock = r?.environment?.package_lock;
  if (lock?.path !== 'package-lock.json' || !count(lock.bytes) || !SHA1.test(lock.git_blob_sha1 ?? '') || !SHA256.test(lock.sha256 ?? '')) bad('environment.package_lock must pin package-lock.json by size, blob id and sha256');
  const ids = new Set();
  for (const f of r?.fixtures ?? []) {
    if (ids.has(f.id)) bad(`duplicate fixture id ${f.id}`);
    ids.add(f.id);
    if (f.class !== 'normal' && f.class !== 'negative') bad(`${f.id}: class must be normal or negative`);
    if (f.class === 'negative' && (typeof f.counterexample !== 'string' || f.counterexample === '')) bad(`${f.id}: a negative fixture must say what it is a counterexample of`);
    if (!APIS.includes(f.api)) bad(`${f.id}: api ${f.api} is not one of ${APIS.join('/')}`);
    if (!(f.origin === AUTHORED || /^\S+\.mjs:\d+ \(.+\)$/.test(f.origin ?? ''))) bad(`${f.id}: origin must cite a test file line or say it was authored for this record`);
    if (sha256(canonical(f.input)) !== f.input_sha256) bad(`${f.id}: input_sha256 does not match the recorded input`);
    if (!SHA256.test(f.output_sha256 ?? '')) bad(`${f.id}: output_sha256 must be a 64-hex digest`);
    if (!f.expected || typeof f.expected !== 'object') bad(`${f.id}: expected summary is missing`);
  }
  for (const cls of ['normal', 'negative']) {
    if (!(r?.fixtures ?? []).some((f) => f.class === cls)) bad(`needs at least one ${cls} fixture`);
  }
  if (r?.artifact_digest?.algorithm !== 'sha256' || !SHA256.test(r?.artifact_digest?.value ?? '')) bad('artifact_digest needs algorithm sha256 and a 64-hex value');
  else if (r.artifact_digest.value !== artifactDigest(r)) bad('artifact_digest does not match the record (it covers every field except its own value)');
  const notRecomputed = r?.verification?.not_recomputed;
  if (!Array.isArray(notRecomputed) || notRecomputed.length === 0 || !notRecomputed.every((x) => typeof x === 'string' && x !== '')) bad('verification.not_recomputed must list what the test does not recompute');
  if (!Array.isArray(r?.limits) || r.limits.length === 0) bad('limits must record the remaining limits');
  for (const l of r?.limits ?? []) {
    if (!LIMIT_STATUSES.includes(l.status)) bad(`limit ${l.id}: status ${l.status} is not one of ${LIMIT_STATUSES.join('/')}`);
    if (typeof l.statement !== 'string' || l.statement.trim() === '') bad(`limit ${l.id}: statement is empty`);
    for (const id of l.fixtures ?? []) if (!ids.has(id)) bad(`limit ${l.id}: unknown fixture ${id}`);
  }
  for (const o of r?.ci_observations ?? []) if (o.head_sha !== r.base_commit) bad(`ci run ${o.run_id}: head_sha is not the base commit`);
  if (read) {
    problems.push(...recomputeProblems([...pinnedEntries(r), ...gitOnlyPins(r)], read, label));
    problems.push(...originProblems(r, read));
  }
  return problems;
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
export function classifyLive(record, root = REPO_ROOT) {
  const read = liveReader(root);
  const states = [...pinnedEntries(record), ...gitOnlyPins(record)].map((e) => ({ path: e.path, ...classifyEntry(e, read(e.path)) }));
  const recorded = new Set(states.map((s) => s.path));
  const extras = [
    ...listFiles(root, record.source_dir).filter((p) => !p.endsWith('.md') && p !== RECORD_FILE && !recorded.has(p)),
    ...(record.scanner_dir ? listFiles(root, record.scanner_dir) : []).filter((p) => p.endsWith('.mjs') && !recorded.has(p)),
    ...listFiles(root, record.test_dir).filter((p) => !recorded.has(p) && !OWN_FILES.includes(p)),
    ...record.inputs.flatMap((g) => listFiles(root, g.dir).filter((p) => !recorded.has(p)))
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
function checkoutOutcome(m, input) {
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
    const options = { repoRoot: dir, adapterId: input.adapter };
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

function execute(f, m) {
  const i = f.input;
  switch (f.api) {
    case 'scan': {
      const { root, report } = scanOf(m, i.adapter);
      const bridged = m.bridge.bridgeLegacyHttpScan({ adapter: adapterOf(m, { id: i.adapter }), report });
      return {
        adapter: report.adapter,
        verdict: report.verdict,
        confidence: report.confidence,
        inventory: m.bridge.summarizeLegacyHttpReport(report),
        descriptor: bridged.source_adapter,
        bridge: { schema: bridged.schema, mode: bridged.mode, source_scan_schema: bridged.source_scan_schema, lossless: canonical(bridged.legacy_report) === canonical(report) },
        semantic_sha256: m.parity.legacyHttpSemanticDigest(report, { root }),
        semantic_snapshot: m.parity.legacyHttpSemanticSnapshot(report, { root })
      };
    }
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
