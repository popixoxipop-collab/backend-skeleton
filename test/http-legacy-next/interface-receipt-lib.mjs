import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as base from './baseline-record-lib.mjs';

// The receipt of T11-02: one run of two commands at a named commit, tied to the hashes of the texts it checked. Self-run, unsigned and not an
// independent attestation (LIMITS says so inside the file). Everything that reads or writes it lives here; the generator and the test are
// thin. Nothing in this file changes what the interface test or the nested runner check.
export const RECEIPT_FILE = base.RECEIPT_FILE;
export const RECEIPT_SCHEMA = 'bskel.interface-receipt/1';
export const RECEIPT_STATUS = 'provisional';
// A commit cannot hold the receipt of its own run, and a replay must not replay itself: both the generator's runs and the replays set this
// variable to exactly 1. The receipt test then reads no receipt (its other checks and its negatives still run), and the RFC test accepts a
// directory without the receipt. The variable is documented in the RFC; it is never read for anything else.
export const REPLAY_ENV = 'T11_RECEIPT_REPLAY';
export const isReplay = (env = process.env) => env[REPLAY_ENV] === '1';
export const RECEIPT_TRACK = 'T11';
export const RECEIPT_ITEMS = ['T11-01', 'T11-02'];
export const RECEIPT_KEYS = ['schema', 'status', 'track', 'items', 'revision', 'tree', 'node_version', 'commands', 'files', 'limits', 'receipt_digest'];
export const COMMAND_KEYS = ['id', 'argv', 'exit_code', 'tests', 'pass', 'fail', 'skipped', 'pass_text'];
export const FILE_KEYS = ['path', 'bytes', 'git_blob_sha1', 'sha256'];
export const GENERATOR_FILE = 'test/http-legacy-next/interface-receipt-generate.mjs';
export const TEST_FILE = 'test/http-legacy-next/interface-receipt.test.mjs';
export const COMMANDS = [
  { id: 'interface-test', argv: ['node', '--test', '--test-reporter=tap', 'test/http-legacy-next/interface-rfc.test.mjs'] },
  { id: 'nested-runner', argv: ['node', 'scripts/run-next-nested-tests.mjs', 'T11'] }
];
// The texts the run is tied to: what the interface test compares (RFC, vocabulary, the six modules), the two documents that state its
// results, the files that run it and the receipt's own code. The scanner and the fixtures are pinned by BASELINE.json, which is listed.
export const FILES = [
  'adapters/http-legacy-next/BASELINE.json',
  'adapters/http-legacy-next/INTEGRATION.md',
  'adapters/http-legacy-next/INTERFACE_RFC.md',
  'adapters/http-legacy-next/baselines.mjs',
  'adapters/http-legacy-next/bridge.mjs',
  'adapters/http-legacy-next/checkout-completeness.mjs',
  'adapters/http-legacy-next/cutover-readiness.mjs',
  'adapters/http-legacy-next/parity.mjs',
  'adapters/http-legacy-next/shadow-projection.mjs',
  'test/http-legacy-next/baseline-record-lib.mjs',
  'test/http-legacy-next/baseline-record.test.mjs',
  GENERATOR_FILE,
  'test/http-legacy-next/interface-receipt-lib.mjs',
  TEST_FILE,
  'test/http-legacy-next/interface-rfc.test.mjs',
  'test/http-legacy-next/interface-rfc.vocabulary.json'
];
// Copied verbatim into the receipt, the vocabulary and the RFC; the RFC test compares all three.
export const LIMITS = [
  'self-run: the generator ran both commands on one machine and nobody else observed the run.',
  'unsigned: no key or signature covers the file, and receipt_digest only detects an edit that did not recompute it.',
  'not an independent attestation: the receipt is produced by the code it describes, so a CI log or a reviewer is the independent record.',
  "replay needs the revision's history: a checkout without that commit must fetch it, and on a shallow checkout a revision outside the visible history cannot be told from an ancestor whose history is cut off, so the test prints a note instead of failing.",
  'provisional: the receipt describes the commit before the one that holds it, so a later change to a listed file makes it stale and it must be regenerated.',
  'scope of the hashes: the counts cover every test file of the T11 suite at the revision but only the listed files are hashed; the other test files, the nested runner script, the scanner and the fixtures are covered by the revision alone.',
  "replay without history: the replayed nested run has no git history, so the pinned-commit checks of the record test run there under BASELINE_ALLOW_UNVERIFIED=1 and are reported as not run, and it uses the node_modules of the checkout that replays it; the generator's own run had the history."
];
const SUMMARY_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const count = (n) => Number.isInteger(n) && n >= 0;
// The reporter prints `ℹ ` before a count on Node 24 and TAP's `# ` on Node 22 when the output is not a terminal; the numbers are what is compared.
export const summaryCounts = (lines) => Object.fromEntries(lines.map((line) => [line.split(' ')[1], Number(line.split(' ')[2])]));

export function receiptDigest(receipt) {
  const rest = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'receipt_digest'));
  return base.sha256(base.canonical(rest));
}

export const readReceipt = (root = base.REPO_ROOT) => JSON.parse(fs.readFileSync(path.join(root, RECEIPT_FILE), 'utf8'));

// Every problem of the receipt as a document: exact keys, the literal tables above, counts that agree with the printed summary, and a digest
// that matches. Never throws. Passing this says the file is well formed and sealed, not that anything was run. The commands and files it expects
// default to the tables above; the generator passes its own so that a receipt of other commands is held to the same rules.
export function shapeProblems(receipt, { commands: wantedCommands = COMMANDS, files: wantedFiles = FILES } = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['receipt: must be an object'];
  const problems = [...base.exactKeys('receipt', receipt, RECEIPT_KEYS)];
  const is = (what, actual, expected) => { if (base.canonical(actual) !== base.canonical(expected)) problems.push(`${what} must be ${base.canonical(expected)}, not ${base.canonical(actual)}`); };
  is('schema', receipt.schema, RECEIPT_SCHEMA);
  is('status', receipt.status, RECEIPT_STATUS);
  is('track', receipt.track, RECEIPT_TRACK);
  is('items', receipt.items, RECEIPT_ITEMS);
  for (const key of ['revision', 'tree']) if (!SHA1.test(receipt[key] ?? '')) problems.push(`${key} must be 40 hex digits`);
  if (!/^v\d+\.\d+\.\d+$/.test(receipt.node_version ?? '')) problems.push('node_version must look like v24.19.0');
  const ran = Array.isArray(receipt.commands) ? receipt.commands : [];
  if (!Array.isArray(receipt.commands) || ran.length !== wantedCommands.length) problems.push(`commands must list exactly ${wantedCommands.map((c) => c.id).join(' and ')}`);
  wantedCommands.forEach((expected, i) => {
    const c = ran[i];
    const label = `command ${expected.id}`;
    if (!c || typeof c !== 'object') return;
    problems.push(...base.exactKeys(label, c, COMMAND_KEYS));
    is(`${label} id`, c.id, expected.id);
    is(`${label} argv`, c.argv, expected.argv);
    for (const key of ['tests', 'pass', 'fail', 'skipped']) if (!count(c[key])) problems.push(`${label}: ${key} must be a count`);
    if (c.exit_code !== 0) problems.push(`${label}: exit_code must be 0, not ${c.exit_code}; a receipt records a passing run`);
    const lines = Array.isArray(c.pass_text) ? c.pass_text : [];
    const shaped = lines.length === SUMMARY_KEYS.length && lines.every((line, k) => typeof line === 'string' && new RegExp(`^(?:ℹ|#) ${SUMMARY_KEYS[k]} \\d+$`).test(line));
    if (!shaped) {
      problems.push(`${label}: pass_text must be the ${SUMMARY_KEYS.length} summary lines (${SUMMARY_KEYS.join(', ')}) as printed`);
      return;
    }
    const counts = summaryCounts(lines);
    for (const key of ['tests', 'pass', 'fail', 'skipped']) if (counts[key] !== c[key]) problems.push(`${label}: ${key} ${c[key]} != ${counts[key]} in pass_text`);
    if (counts.fail !== 0 || counts.cancelled !== 0 || counts.todo !== 0) problems.push(`${label}: pass_text records fail ${counts.fail}, cancelled ${counts.cancelled}, todo ${counts.todo}; all must be 0`);
    if (counts.tests === 0 || counts.tests !== counts.pass + counts.skipped) problems.push(`${label}: tests ${counts.tests} != pass ${counts.pass} + skipped ${counts.skipped}`);
  });
  const files = Array.isArray(receipt.files) ? receipt.files : [];
  problems.push(...base.exactSet('files paths', files.map((f) => f?.path), wantedFiles));
  for (const f of files) {
    if (typeof f?.path !== 'string') problems.push('file path must be a string');
    problems.push(...base.exactKeys(`file ${f?.path}`, f, FILE_KEYS));
    if (!count(f?.bytes) || !SHA1.test(f?.git_blob_sha1 ?? '') || !SHA256.test(f?.sha256 ?? '')) problems.push(`file ${f?.path}: bytes, git_blob_sha1 and sha256 must be a count and two hex digests`);
  }
  is('limits', receipt.limits, LIMITS);
  if (!SHA256.test(receipt.receipt_digest ?? '')) problems.push('receipt_digest must be 64 hex digits');
  else if (receipt.receipt_digest !== receiptDigest(receipt)) problems.push(`receipt_digest ${receipt.receipt_digest} != ${receiptDigest(receipt)} recomputed from the other keys`);
  return problems;
}

// The live files against the receipt: size, git blob id and sha256 recomputed from the bytes. No file is skipped, including this track's own.
export const liveFileProblems = (receipt, root = base.REPO_ROOT) => base.recomputeProblems(Array.isArray(receipt?.files) ? receipt.files : [], base.liveReader(root), 'live');

// ---- the revision: the commit the run was made at ----

// The receipt's revision in `root`. It is found in the checkout or fetched exactly like the pinned commit of the record (commitVerdict), so a
// checkout that lacks it fetches it or fails; only BASELINE_ALLOW_UNVERIFIED=1 turns that into a note saying the checks were NOT run. Then the tree
// id and the size, blob id and sha256 of every listed file as stored in the commit must equal the receipt, and the commit must be an ancestor of
// HEAD. A shallow checkout cannot tell a missing ancestor from a cut history, so there a negative answer is only a note. The caller prints every
// note, so no branch is silent. Returns { problems, notes, via }.
export function revisionProblems(receipt, root = base.REPO_ROOT, env = process.env) {
  const out = { problems: [], notes: [], via: null };
  if (!SHA1.test(receipt?.revision ?? '')) {
    out.problems.push('revision must be 40 hex digits');
    return out;
  }
  const found = base.commitVerdict(root, receipt.revision, env);
  if (found.verdict === 'fail') {
    out.problems.push(found.message);
    return out;
  }
  if (found.verdict === 'unverified') {
    out.via = 'unverified';
    out.notes.push(found.message);
    return out;
  }
  out.via = found.via;
  const tree = base.revParse(root, `${receipt.revision}^{tree}`);
  if (tree !== receipt.tree) out.problems.push(`revision ${receipt.revision} has tree ${tree}, not the recorded ${receipt.tree}`);
  out.problems.push(...base.recomputeProblems(Array.isArray(receipt.files) ? receipt.files : [], base.commitReader(root, receipt.revision), 'revision'));
  if (base.isAncestor(root, receipt.revision)) out.notes.push(`ancestry checked: ${receipt.revision} is an ancestor of HEAD`);
  else if (base.isShallow(root)) out.notes.push(`ancestry NOT checked: this checkout is shallow, so ${receipt.revision} may be an ancestor of HEAD whose history is cut off; the tree and file checks ran on the commit found here (${out.via})`);
  else out.problems.push(`revision ${receipt.revision} is not an ancestor of HEAD`);
  return out;
}

// ---- replay: the recorded commands run again in an export of the revision ----

export const REPLAY_TIMEOUT_MS = 600000;
const scratchEnv = (dir, extra = {}) => ({ HOME: path.join(dir, 'home'), TMPDIR: path.join(dir, 'tmp'), ...extra });
const scratchDirs = (dir) => { for (const sub of ['home', 'tmp']) fs.mkdirSync(path.join(dir, sub), { recursive: true }); return dir; };

// One recorded command as a child process of `cwd`; `node` in argv[0] stands for the binary that runs this code.
export function runRecorded(command, cwd, extraEnv, timeoutMs = REPLAY_TIMEOUT_MS) {
  if (command?.argv?.[0] !== 'node') throw new Error(`command ${command?.id}: argv[0] must be node`);
  return base.runNode(cwd, command.argv.slice(1), extraEnv, { timeoutMs });
}

// What a replayed run must equal: the exit code and the four recorded counts, with cancelled and todo at 0. The suites count, the duration and the
// reporter's line prefix are not compared; the prefix differs between Node versions and the other two are not recorded as numbers.
export function compareRun(recorded, outcome) {
  const label = `command ${recorded?.id}`;
  const problems = [];
  if (outcome.timed_out) problems.push(`${label}: killed after the time limit`);
  if (outcome.exit_code !== recorded.exit_code) problems.push(`${label}: exit code ${outcome.exit_code} != recorded ${recorded.exit_code}`);
  for (const key of ['tests', 'pass', 'fail', 'skipped']) {
    if (outcome.result?.[key] !== recorded[key]) problems.push(`${label}: ${key} ${outcome.result?.[key]} != recorded ${recorded[key]}`);
  }
  for (const key of ['cancelled', 'todo']) {
    if (outcome.result?.[key] !== 0) problems.push(`${label}: ${key} ${outcome.result?.[key]} != 0`);
  }
  return problems;
}

// Every recorded command, one after the other, in a fresh export of the revision under `work` (no .git; node_modules is the checkout's). The replay
// switch stops the replayed test run from replaying again, and BASELINE_ALLOW_UNVERIFIED=1 is set because an export has no history (limit "replay
// without history"). Returns { problems, lines } where each line says what one command printed, for the caller to show.
export async function replayRevision(receipt, root, work, timeoutMs = REPLAY_TIMEOUT_MS) {
  const dest = path.join(work, 'export');
  fs.mkdirSync(dest, { recursive: true });
  base.extractTree(root, receipt.revision, dest);
  const out = { problems: [], lines: [] };
  for (const recorded of receipt.commands) {
    const dir = scratchDirs(path.join(work, `run-${recorded.id}`));
    const outcome = await runRecorded(recorded, dest, scratchEnv(dir, { [REPLAY_ENV]: '1', BASELINE_ALLOW_UNVERIFIED: '1' }), timeoutMs);
    const seen = outcome.result ?? {};
    out.lines.push(`${recorded.id} replayed: exit ${outcome.exit_code}, tests ${seen.tests}, pass ${seen.pass}, fail ${seen.fail}, skipped ${seen.skipped} (recorded: exit ${recorded.exit_code}, tests ${recorded.tests}, pass ${recorded.pass}, fail ${recorded.fail}, skipped ${recorded.skipped})`);
    out.problems.push(...compareRun(recorded, outcome));
  }
  return out;
}

// ---- building and writing the receipt ----

// The receipt of `runs` (one observed outcome per command, as base.runNode returns it) at `revision`, with the listed files hashed from `root`.
export function buildReceipt({ root, revision, tree, runs, nodeVersion = process.version, commands = COMMANDS, files = FILES }) {
  const receipt = {
    schema: RECEIPT_SCHEMA,
    status: RECEIPT_STATUS,
    track: RECEIPT_TRACK,
    items: [...RECEIPT_ITEMS],
    revision,
    tree,
    node_version: nodeVersion,
    commands: commands.map((c, i) => ({
      id: c.id,
      argv: [...c.argv],
      exit_code: runs[i].exit_code,
      tests: runs[i].result.tests,
      pass: runs[i].result.pass,
      fail: runs[i].result.fail,
      skipped: runs[i].result.skipped,
      pass_text: [...runs[i].summary]
    })),
    files: files.map((rel) => base.fileEntry(root, rel)),
    limits: [...LIMITS]
  };
  receipt.receipt_digest = receiptDigest(receipt);
  return receipt;
}

export const receiptText = (receipt) => `${JSON.stringify(receipt, null, 2)}\n`;

// Why a run may not go into a receipt: it was killed, exited with anything but 0, did not print the seven summary lines, or counted a failure,
// a cancellation, a todo or no test at all.
export function passProblems(command, outcome) {
  const label = `command ${command.id}`;
  const problems = [];
  if (outcome.timed_out) problems.push(`${label} was killed after the time limit`);
  else if (outcome.exit_code !== 0) problems.push(`${label} exited with ${outcome.exit_code}${outcome.signal ? ` (${outcome.signal})` : ''}`);
  if (outcome.summary.length !== SUMMARY_KEYS.length) problems.push(`${label} printed ${outcome.summary.length} summary lines, not ${SUMMARY_KEYS.length}`);
  else {
    const r = outcome.result;
    if (r.fail !== 0 || r.cancelled !== 0 || r.todo !== 0) problems.push(`${label} counted fail ${r.fail}, cancelled ${r.cancelled}, todo ${r.todo}`);
    if (r.tests === 0 || r.tests !== r.pass + r.skipped) problems.push(`${label} counted tests ${r.tests}, pass ${r.pass}, skipped ${r.skipped}`);
  }
  return problems;
}

const treeState = (root) => {
  const res = base.spawnGit(root, ['status', '--porcelain', '--untracked-files=all']);
  return res.status === 0 ? { clean: res.stdout === '', listing: res.stdout.split('\n').filter(Boolean).slice(0, 5) } : { clean: false, listing: [`git status failed: ${(res.error?.message ?? res.stderr ?? '').trim()}`] };
};

// Runs every command in `root`, a checkout whose tracked files and untracked files are all committed, in a scratch HOME and TMPDIR with the replay
// switch on and the unverified override off, and builds the receipt from what was printed. It refuses a tree that is not clean (before the runs, and
// after them, so a command that edits a file is caught), a command that did not pass, and a receipt that fails its own shape check. It writes the
// bytes to RECEIPT_FILE under `root` when `write` is true; the same tree and the same counts always give the same bytes.
export async function generate({ root = base.REPO_ROOT, commands = COMMANDS, files = FILES, write = true, timeoutMs = REPLAY_TIMEOUT_MS, nodeVersion = process.version } = {}) {
  const before = treeState(root);
  if (!before.clean) throw new Error(`refusing to write a receipt: the working tree is not clean (${before.listing.join('; ')})`);
  const revision = base.revParse(root, 'HEAD');
  const tree = base.revParse(root, 'HEAD^{tree}');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 't11-receipt-'));
  const runs = [];
  try {
    for (const command of commands) {
      const dir = scratchDirs(path.join(work, command.id));
      const outcome = await runRecorded(command, root, scratchEnv(dir, { [REPLAY_ENV]: '1', BASELINE_ALLOW_UNVERIFIED: '' }), timeoutMs);
      const bad = passProblems(command, outcome);
      if (bad.length > 0) throw new Error(`refusing to write a receipt: ${bad.join('; ')}`);
      runs.push(outcome);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const after = treeState(root);
  if (!after.clean || base.revParse(root, 'HEAD') !== revision) throw new Error(`refusing to write a receipt: the commands changed the working tree or HEAD (${after.listing.join('; ')})`);
  const receipt = buildReceipt({ root, revision, tree, runs, nodeVersion, commands, files });
  const shaped = shapeProblems(receipt, { commands, files });
  if (shaped.length > 0) throw new Error(`refusing to write a receipt that fails its own check: ${shaped.join('; ')}`);
  const text = receiptText(receipt);
  if (write) {
    fs.mkdirSync(path.dirname(path.join(root, RECEIPT_FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, RECEIPT_FILE), text);
  }
  return { receipt, text, revision, tree };
}
