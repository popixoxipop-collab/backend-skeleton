import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

//@@TRACK-BEGIN
export const TRACK = {
	item: 'T22-01',
	suiteId: 'T22',
	recordFile: 'sdk/next/BASELINE.json',
	sourceDir: 'sdk/next',
	testDir: 'test/sdk-next',
	docs: { readme: 'README.md' },
	ownFiles: ['test/sdk-next/baseline-record.test.mjs', 'test/sdk-next/baseline-record-lib.mjs']
};
//@@TRACK-END

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RECORD_SCHEMA = 'bskel.track-baseline-record/2';
export const RUNNER_SCRIPT = 'scripts/run-next-nested-tests.mjs';
export const AUTHORED = 'authored for this record';

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ROLES = ['source', 'test', 'test_support', 'external_dependency', 'runner'];
export const LIMIT_STATUSES = ['UNSUPPORTED', 'UNKNOWN', 'BLOCKED', 'NOT_RECORDED'];
const COUNT_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const DIGEST_KEYS = ['bytes', 'git_blob_sha1', 'sha256'];
const GENERATED = /(^|\/)(__pycache__|node_modules)(\/|$)|\.pyc$/;
const BY_NUMBER = /#\d|\bPR\s*\d|\/pull\/\d/;
const SCRIPT = /\.(mjs|cjs|js)$/;
export const BUILTIN = '$builtin';
export const GAP_PREFIX = 'observed-gap-';
const FILE_NODES = ['$file', '$json', '$fileSha256', '$fileBytes'];

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
export const flip = (hex) => `${hex.startsWith('0') ? '1' : '0'}${hex.slice(1)}`;
export const artifactDigest = (record) => sha256(canonical({
	...record,
	artifact_digest: Object.fromEntries(Object.entries(record?.artifact_digest ?? {}).filter(([key]) => key !== 'value'))
}));
export const tapCommand = (files) => ['node', '--test', ...files].join(' ');

// t.after needs Node 18.13 and the declared floor is 18, so temporary directories are removed when the process exits.
const removeAtExit = [];
process.on('exit', () => removeAtExit.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

export function tmpDir(prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	removeAtExit.push(dir);
	return dir;
}

export const readRecord = (root = REPO_ROOT) => JSON.parse(fs.readFileSync(path.join(root, TRACK.recordFile), 'utf8'));
export const readDocs = (root = REPO_ROOT) => Object.fromEntries(Object.entries(TRACK.docs).map(([key, file]) => [key, fs.readFileSync(path.join(root, TRACK.sourceDir, file), 'utf8')]));

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

// Both content hashes describe the same file, so an entry that disagrees with the file in exactly one hash (or in the
// size alone) is damaged, never a moved tree. Only a file that matches neither hash is drift, and only the pinned
// commit can arbitrate drift.
export function classifyEntry(entry, buf) {
	if (!Buffer.isBuffer(buf)) return { state: 'missing', detail: `${entry?.path} cannot be read` };
	const actual = digestsOf(buf);
	const wrong = DIGEST_KEYS.filter((k) => entry?.[k] !== actual[k]);
	if (wrong.length === 0) return { state: 'fresh' };
	if (wrong.includes('git_blob_sha1') && wrong.includes('sha256')) return { state: 'drift', detail: `${entry.path} differs from the record` };
	const agree = DIGEST_KEYS.filter((k) => !wrong.includes(k)).join(' and ');
	return { state: 'corrupt', detail: `${entry?.path}: the record's ${wrong.join(' and ')} disagree with the file while its ${agree} agree` };
}

// The command that is recorded for a file list is exactly the command that gets run.
const ofRole = (r, ...roles) => (Array.isArray(r?.files) ? r.files : []).filter((f) => roles.includes(f?.role));

function walk(value, trail, visit) {
	visit(value, trail);
	if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${trail}[${i}]`, visit));
	else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${trail}.${k}`, visit);
}

// A fixture may only call and read what the record pins: the module of its call, the module of every nested $call and
// $export, and every file named by $file, $json, $fileSha256 and $fileBytes. A name outside the pins is not evidence.
// The only call target that is not a pinned file is the builtin of this library (BUILTINS), addressed as $builtin.
function callProblems(call, pinned, id) {
	const problems = [];
	const need = (rel, what) => {
		if (typeof rel !== 'string' || !pinned.has(rel)) problems.push(`${id}: ${what} ${JSON.stringify(rel)} is not a pinned file`);
	};
	const target = (spec, what) => {
		if (typeof spec?.fn !== 'string') problems.push(`${id}: ${what} must name a function`);
		else if (spec.module === BUILTIN) {
			if (!Object.hasOwn(BUILTINS, spec.fn)) problems.push(`${id}: ${what} names the unknown builtin ${spec.fn}`);
		} else need(spec.module, `${what} module`);
	};
	target(call, 'call');
	walk(call, '', (v) => {
		if (!v || typeof v !== 'object' || Array.isArray(v)) return;
		for (const key of FILE_NODES) if (key in v) need(v[key], key);
		if ('$export' in v) need(v.$export?.module, '$export module');
		if ('$call' in v) target(v.$call, '$call');
	});
	return problems;
}

// An absence is only evidence when the same search, run in the same scope, still finds something that is known to be there.
// The search covers the whole scope at the pinned commit, the track directories included, unless `exclude` lists directories.
function absentShapeProblems(absent) {
	const problems = [];
	if (typeof absent?.pattern !== 'string' || absent.pattern === '') problems.push('absent needs a pattern');
	const listed = Array.isArray(absent?.scope) && absent.scope.length > 0 && absent.scope.every((p) => typeof p === 'string' && p !== '');
	const derived = typeof absent?.scope_from === 'string' && /^[\w./-]+#\w+$/.test(absent.scope_from);
	if (listed === derived) problems.push('absent needs exactly one of scope (a list of paths) and scope_from (<json file>#<key>)');
	if (absent?.exclude !== undefined && !(Array.isArray(absent.exclude) && absent.exclude.every((p) => typeof p === 'string' && p !== ''))) problems.push('absent.exclude is a list of directories');
	const anchor = absent?.anchor;
	if (typeof anchor?.pattern !== 'string' || anchor.pattern === '' || !Array.isArray(anchor.paths) || anchor.paths.length === 0 || !anchor.paths.every((p) => typeof p === 'string')) {
		problems.push('absent needs an anchor: a pattern and the non-empty list of paths that it finds in the same scope');
	}
	return problems;
}

// Without `read` only the record itself is checked. With `read = { read, includeRunner, label }` the size and both
// digests of every pinned file are recomputed from read(path), which returns a Buffer or null.
export function verifyRecord(r, reading) {
	const problems = [];
	const bad = (message) => problems.push(message);
	const isCount = (n) => Number.isInteger(n) && n >= 0;
	if (r?.schema !== RECORD_SCHEMA) bad(`schema must be ${RECORD_SCHEMA}`);
	if (r?.schema_status !== 'provisional') bad('schema_status must be provisional');
	for (const [key, want] of [['item', TRACK.item], ['suite_id', TRACK.suiteId], ['source_dir', TRACK.sourceDir], ['test_dir', TRACK.testDir]]) {
		if (r?.[key] !== want) bad(`${key} must be ${want}`);
	}
	if (!SHA1.test(r?.base_commit ?? '')) bad('base_commit must be a 40-hex commit id');
	if (!SHA1.test(r?.base_tree ?? '')) bad('base_tree must be a 40-hex tree id');
	const loaded = r?.environment?.loaded_packages;
	if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded) || Object.keys(loaded).length === 0 || !Object.values(loaded).every((v) => /^\d+\.\d+\.\d+/.test(v))) bad('environment.loaded_packages must map package names to versions');
	const paths = new Set();
	for (const f of Array.isArray(r?.files) ? r.files : []) {
		const where = `files: ${f?.path}`;
		if (!ROLES.includes(f?.role)) bad(`${where}: role must be one of ${ROLES.join('/')}`);
		if (typeof f?.path !== 'string' || f.path === '' || f.path.startsWith('/') || f.path.split('/').includes('..')) bad(`${where}: path must be repo-relative`);
		else if (paths.has(f.path)) bad(`${where}: listed twice`);
		else paths.add(f.path);
		if (!isCount(f?.bytes) || !SHA1.test(f?.git_blob_sha1 ?? '') || !SHA256.test(f?.sha256 ?? '')) bad(`${where}: bytes, git_blob_sha1 and sha256 must be a count and well-formed digests`);
		const inSource = f?.path?.startsWith?.(`${TRACK.sourceDir}/`);
		const inTests = f?.path?.startsWith?.(`${TRACK.testDir}/`);
		if (f?.role === 'source' && (!inSource || f.path.endsWith('.md'))) bad(`${where}: a source file lives in ${TRACK.sourceDir} and is not markdown`);
		if (f?.role === 'test' && (!inTests || !f.path.endsWith('.test.mjs'))) bad(`${where}: a test file is a *.test.mjs in ${TRACK.testDir}`);
		if (f?.role === 'test_support' && !inTests) bad(`${where}: test support lives in ${TRACK.testDir}`);
		if (f?.role === 'external_dependency' && (inSource || inTests || f.path === RUNNER_SCRIPT)) bad(`${where}: an external dependency lives outside the track directories`);
		if (f?.role === 'runner' && f.path !== RUNNER_SCRIPT) bad(`${where}: the runner is ${RUNNER_SCRIPT}`);
		if (f?.role === 'test' ? !isCount(f.test_count) : 'test_count' in (f ?? {})) bad(`${where}: only test files carry an integer test_count`);
	}
	for (const [role, min] of [['source', 1], ['test', 1], ['runner', 1]]) {
		if (ofRole(r, role).length < min) bad(`files must pin at least ${min} ${role} file`);
	}
	const testPaths = ofRole(r, 'test').map((f) => f.path);
	const total = ofRole(r, 'test').reduce((sum, f) => sum + (f.test_count ?? 0), 0);
	const byId = new Map();
	for (const c of r?.commands ?? []) {
		byId.set(c.id, c);
		if (typeof c.command !== 'string' || c.command.trim() === '') bad(`command ${c.id}: command text is empty`);
		if (!Number.isInteger(c.exit_code)) bad(`command ${c.id}: exit_code must be an integer`);
		if (c.revision !== r.base_commit) bad(`command ${c.id}: revision is not the base commit`);
		if (!COUNT_KEYS.every((k) => isCount(c.result?.[k]))) bad(`command ${c.id}: result needs integer ${COUNT_KEYS.join('/')}`);
		else if (c.exit_code === 0 && (c.result.fail !== 0 || c.result.cancelled !== 0)) bad(`command ${c.id}: exit_code 0 contradicts failing tests`);
	}
	const runner = byId.get('nested-runner');
	const direct = byId.get('direct-tap');
	if (!runner || !direct) bad('commands must include nested-runner and direct-tap');
	else {
		if (runner.command !== `node ${RUNNER_SCRIPT} ${r.suite_id}`) bad('nested-runner command does not name the suite');
		if (runner.runner_files !== testPaths.length) bad('nested-runner runner_files does not match the recorded test files');
		if (runner.first_line !== `NESTED_SUITE ${r.suite_id} RUN ${runner.runner_files} files`) bad('nested-runner first_line does not match the suite and file count');
		if (direct.command !== tapCommand(testPaths)) bad('direct-tap command does not list exactly the recorded test files');
		if (direct.result?.tests !== total) bad(`direct-tap tests ${direct.result?.tests} != sum of per-file test_count ${total}`);
		if (runner.result?.tests !== direct.result?.tests) bad('nested-runner and direct-tap disagree on the test count');
	}
	const ids = new Set();
	for (const f of r?.fixtures ?? []) {
		if (typeof f?.id !== 'string' || f.id === '' || ids.has(f.id)) bad(`fixture id ${f?.id} is missing or duplicated`);
		ids.add(f?.id);
		if (f?.class !== 'normal' && f?.class !== 'negative') bad(`${f?.id}: class must be normal or negative`);
		if (typeof f?.origin !== 'string' || f.origin === '') bad(`${f?.id}: origin is missing`);
		callProblems(f?.call, paths, f?.id).forEach(bad);
		const pairs = Array.isArray(f?.expect) ? f.expect : [];
		if (pairs.length === 0 || !pairs.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && (e[0] === '' || e[0].startsWith('/')))) bad(`${f?.id}: expect needs [json-pointer, value] pairs`);
		if (!SHA256.test(f?.output_sha256 ?? '')) bad(`${f?.id}: output_sha256 must be a 64-hex digest`);
	}
	for (const cls of ['normal', 'negative']) {
		if (!(r?.fixtures ?? []).some((f) => f.class === cls)) bad(`needs at least one ${cls} fixture`);
	}
	if (r?.artifact_digest?.value !== artifactDigest(r)) bad('artifact_digest does not match the record (it covers every field except its own value)');
	if (!Array.isArray(r?.limits) || r.limits.length === 0) bad('limits must record the remaining limits');
	const limitIds = new Set();
	for (const l of r?.limits ?? []) {
		if (typeof l.id !== 'string' || l.id === '' || limitIds.has(l.id)) bad(`limit id ${l.id} is missing or duplicated`);
		limitIds.add(l.id);
		if (!LIMIT_STATUSES.includes(l.status)) bad(`limit ${l.id}: status ${l.status} is not one of ${LIMIT_STATUSES.join('/')}`);
		if (typeof l.statement !== 'string' || l.statement.trim() === '') bad(`limit ${l.id}: statement is empty`);
		for (const id of l.fixtures ?? []) if (!ids.has(id)) bad(`limit ${l.id}: unknown fixture ${id}`);
		if (l.references !== undefined && (typeof l.references.pattern !== 'string' || l.references.pattern === '' || !Array.isArray(l.references.paths) || l.references.paths.length === 0 || !l.references.paths.every((p) => typeof p === 'string'))) bad(`limit ${l.id}: references needs a pattern and a non-empty list of paths`);
		if (l.absent !== undefined) absentShapeProblems(l.absent).forEach((m) => bad(`limit ${l.id}: ${m}`));
		// A limit that no test recomputes would be prose only. Only NOT_RECORDED may stay unbound: it says what the record does
		// not contain, so there is nothing to recompute (the environment, the synthetic inputs, the platform).
		if (l.status !== 'NOT_RECORDED' && !(l.fixtures?.length > 0) && l.references === undefined && l.absent === undefined) bad(`limit ${l.id}: is bound to no fixture, reference list or absence check, so no test recomputes anything about it`);
	}
	// A behaviour that was found by running the code and that the code gets wrong or leaves open is frozen as a negative fixture
	// whose id starts with observed-gap-; such a fixture must be disclosed by a limit, never left to read as normal behaviour.
	const cited = new Set((r?.limits ?? []).flatMap((l) => l.fixtures ?? []));
	for (const f of r?.fixtures ?? []) {
		if (typeof f?.id !== 'string' || !f.id.startsWith(GAP_PREFIX)) continue;
		if (f.class !== 'negative') bad(`${f.id}: an observed gap is a negative fixture`);
		if (!cited.has(f.id)) bad(`${f.id}: an observed gap that no limit cites is not disclosed`);
	}
	if ((r?.fixtures ?? []).some((f) => f?.call?.module === BUILTIN && f.call.fn === 'schemaParity') && !loaded?.ajv) bad('environment.loaded_packages must name ajv, which the schemaParity fixtures load');
	walk(r?.pins ?? {}, 'pins', (v, trail) => {
		if (!v || typeof v !== 'object' || Array.isArray(v)) return;
		for (const [k, x] of Object.entries(v)) {
			if (/(^|_)commit$/.test(k) && !SHA1.test(x ?? '')) bad(`${trail}.${k} must be a 40-hex commit id`);
			if (/blob_sha1$/.test(k) && !SHA1.test(x ?? '')) bad(`${trail}.${k} must be a 40-hex blob id`);
			if (/sha256$/.test(k) && !SHA256.test(x ?? '')) bad(`${trail}.${k} must be a 64-hex digest`);
		}
	});
	for (const o of r?.ci_observations ?? []) if (o.head_sha !== r.base_commit) bad(`ci run ${o.run_id}: head_sha is not the base commit`);
	if (BY_NUMBER.test(JSON.stringify({ ...r, files: undefined }))) bad('the record must pin by commit sha, not by PR or issue number');
	if (reading) {
		const pinned = ofRole(r, 'source', 'test', 'test_support', 'external_dependency', ...(reading.includeRunner ? ['runner'] : []));
		problems.push(...recomputeProblems(pinned, reading.read, reading.label ?? 'recompute'));
	}
	return problems;
}

function listFiles(root, rel) {
	const out = [];
	const visit = (dir) => {
		if (!fs.existsSync(path.join(root, dir))) return;
		for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
			const child = `${dir}/${entry.name}`;
			if (GENERATED.test(child)) continue;
			if (entry.isDirectory()) visit(child);
			else if (entry.isFile()) out.push(child);
		}
	};
	visit(rel);
	return out.sort();
}

// Every pinned file (the hot runner script excepted: only the pinned commit judges it) is compared with the live file by
// size, sha256 and blob id, never by the record's own blob id alone. `corrupt` entries are damage and must fail the
// caller, `moved` means the tree has left the baseline (live replays are skipped and the pinned commit decides), and
// `fresh` means every file agrees and the track directories hold no unrecorded file.
export function classifyLive(record, root = REPO_ROOT) {
	const read = liveReader(root);
	const states = ofRole(record, 'source', 'test', 'test_support', 'external_dependency').map((e) => ({ path: e.path, ...classifyEntry(e, read(e.path)) }));
	const recorded = new Set((record.files ?? []).map((e) => e.path));
	const extras = [
		...listFiles(root, record.source_dir).filter((p) => !p.endsWith('.md') && p !== TRACK.recordFile && !recorded.has(p)),
		...listFiles(root, record.test_dir).filter((p) => !recorded.has(p) && !TRACK.ownFiles.includes(p))
	];
	const corrupt = states.filter((s) => s.state === 'corrupt').map((s) => s.detail);
	const moved = [...states.filter((s) => s.state === 'drift' || s.state === 'missing').map((s) => s.path), ...extras];
	return { corrupt, moved, fresh: corrupt.length === 0 && moved.length === 0 };
}

export function requireFresh(t, tree) {
	if (tree.corrupt.length > 0) assert.fail(`the record disagrees with the live files: ${tree.corrupt.join('; ')}`);
	if (tree.fresh) return true;
	t.skip(`the live tree no longer equals the baseline (${tree.moved.join(', ')}); the live replay is skipped and the pinned commit decides`);
	return false;
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

export function needCommit(t, verdict) {
	if (verdict.verdict === 'fail') assert.fail(verdict.message);
	if (verdict.verdict === 'unverified') {
		t.skip(verdict.message);
		return false;
	}
	return true;
}

export const treeAtCommit = (root, commit) => {
	const res = git(root, ['rev-parse', `${commit}^{tree}`]);
	return res.status === 0 ? res.stdout.trim() : null;
};
export const blobAtCommit = (root, commit, rel) => {
	const res = git(root, ['rev-parse', `${commit}:${rel}`]);
	return res.status === 0 ? res.stdout.trim() : null;
};
export const isAncestor = (root, commit) => git(root, ['merge-base', '--is-ancestor', commit, 'HEAD']).status === 0;
export const listAtCommit = (root, commit, dir) => {
	const res = git(root, ['ls-tree', '-r', '--full-name', '--name-only', commit, '--', dir]);
	return res.status === 0 ? res.stdout.split('\n').filter(Boolean).sort() : null;
};

// Files in `scope` (default: the whole tree) outside the excluded directories that mention `pattern` (git grep -l -E) in the
// tree of the pinned commit.
export const referencesAtCommit = (root, commit, pattern, excluded, scope = ['.']) => {
	const res = git(root, ['grep', '-l', '-E', '-e', pattern, commit, '--', ...scope, ...excluded.map((d) => `:!${d}`)]);
	if (res.status !== 0 && res.status !== 1) throw new Error(`git grep failed: ${res.stderr}`);
	return res.stdout.split('\n').filter(Boolean).map((line) => line.slice(commit.length + 1)).sort();
};

// The paths an absence check searches: the listed paths, or the array stored under <key> in <json file> at the pinned commit
// (the files allowlist of package.json is what ships).
export function absentScope(root, commit, absent) {
	if (Array.isArray(absent.scope)) return absent.scope;
	const [file, key] = absent.scope_from.split('#');
	const res = git(root, ['show', `${commit}:${file}`]);
	if (res.status !== 0) throw new Error(`git show ${commit}:${file} failed: ${res.stderr}`);
	const list = JSON.parse(res.stdout)[key];
	if (!Array.isArray(list) || list.length === 0 || !list.every((p) => typeof p === 'string' && p !== '')) throw new Error(`${file}#${key} is not a non-empty list of paths at ${commit}`);
	return list;
}

// An absence holds when the search finds nothing in the scope and the anchor search, run in the same scope, still finds
// exactly the recorded paths (otherwise an empty result could come from a search that cannot see the files).
export function absentProblems(root, commit, limit) {
	const { absent } = limit;
	const scope = absentScope(root, commit, absent);
	const found = referencesAtCommit(root, commit, absent.pattern, absent.exclude ?? [], scope);
	const anchored = referencesAtCommit(root, commit, absent.anchor.pattern, absent.exclude ?? [], scope);
	const problems = [];
	if (found.length > 0) problems.push(`${limit.id}: ${absent.pattern} is found in ${found.join(', ')}, so the recorded absence does not hold`);
	if (canonical(anchored) !== canonical(absent.anchor.paths)) problems.push(`${limit.id}: the anchor ${absent.anchor.pattern} finds ${anchored.join(', ') || 'nothing'} in the scope, recorded ${absent.anchor.paths.join(', ')}; an absence is only evidence when the same search finds its anchor`);
	return problems;
}

export function extractCommit(root, commit, paths, dest) {
	for (const rel of paths) {
		const buf = commitReader(root, commit)(rel);
		if (!buf) throw new Error(`git cat-file failed for ${commit}:${rel}`);
		fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
		fs.writeFileSync(path.join(dest, rel), buf);
	}
}

// The package a bare specifier names ('ajv/dist/2020.js' -> 'ajv', '@scope/name/x' -> '@scope/name'); relative, absolute,
// node: and builtin specifiers name none.
const packageOf = (specifier) => {
	if (/^(\.|\/|node:|file:|data:)/.test(specifier)) return null;
	const parts = specifier.split('/');
	const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
	return builtinModules.includes(name) ? null : name;
};

// A textual scan: import and export clauses that start a line, side-effect imports, and import() and require() with a string
// literal. A specifier that is built at run time is not seen.
const IMPORT_FORMS = /^[ \t]*(?:import|export)\b[\w$*\s,{}]*?\bfrom\s*(['"])([^'"\n]+)\1|^[ \t]*import\s*(['"])([^'"\n]+)\3|\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\5\s*\)/gm;
export const importedPackages = (source) => [...new Set([...source.matchAll(IMPORT_FORMS)].map((m) => packageOf(m[2] ?? m[4] ?? m[6])).filter(Boolean))].sort();

// The packages the texts can load: what they import, then what those packages require (`dependencies`), each with the
// version the lock states (lockfileVersion 3, flat node_modules/<name>). A package the lock does not state is a problem.
export function lockedVersions(lock, texts) {
	const found = new Map();
	const seen = new Set();
	const problems = [];
	const queue = texts.flatMap(({ path: file, text }) => importedPackages(text).map((name) => [name, file]));
	for (const [name, by] of queue) {
		if (seen.has(name)) continue;
		seen.add(name);
		const entry = lock?.packages?.[`node_modules/${name}`];
		if (typeof entry?.version !== 'string') {
			problems.push(`${name} (required by ${by}) has no node_modules/${name} entry with a version in the pinned package-lock.json`);
			continue;
		}
		found.set(name, entry.version);
		for (const dep of Object.keys(entry.dependencies ?? {})) queue.push([dep, name]);
	}
	return { versions: Object.fromEntries([...found].sort(([a], [b]) => (a < b ? -1 : 1))), problems };
}

export function installedProblems(versions, modules) {
	const problems = [];
	for (const [name, want] of Object.entries(versions)) {
		let have;
		try {
			have = JSON.parse(fs.readFileSync(path.join(modules, name, 'package.json'), 'utf8')).version;
		} catch (error) {
			problems.push(`${name}: node_modules/${name}/package.json cannot be read (${error.code ?? error.message}); the pinned package-lock.json states ${want}`);
			continue;
		}
		if (have !== want) problems.push(`${name}: installed ${have}, the pinned package-lock.json states ${want}`);
	}
	return problems;
}

// The pinned schema-parity test and the schemaParity builtin load ajv, so a copy of the base commit runs against the
// node_modules of this checkout. That is evidence for the base commit only while every package the copy can
// load is installed at the version the base commit's package-lock.json states; otherwise the copy is not linked and the
// caller fails. A missing node_modules fails loudly too. Returns the checked versions.
export function linkModules(root, dest, paths) {
	const modules = path.join(root, 'node_modules');
	if (!fs.existsSync(modules)) throw new Error(`${modules} does not exist; run npm ci first`);
	const texts = paths.filter((p) => SCRIPT.test(p)).map((p) => ({ path: p, text: fs.readFileSync(path.join(dest, p), 'utf8') }));
	const { versions, problems } = lockedVersions(JSON.parse(fs.readFileSync(path.join(dest, 'package-lock.json'), 'utf8')), texts);
	problems.push(...installedProblems(versions, modules));
	if (problems.length > 0) throw new Error(`node_modules of this checkout is not the dependency set of the base commit: ${problems.join('; ')}`);
	fs.symlinkSync(modules, path.join(dest, 'node_modules'), 'dir');
	return versions;
}

// The documents describe the pinned base commit, so every number they state is recomputed from the record: the table rows
// equal the pinned per-file counts, each "<n> tests" equals the direct-tap total, each "NESTED_SUITE ... RUN <n> files"
// equals the recorded first runner line, and each document names the base commit.
export function docProblems(record, docs) {
	const problems = [];
	const command = (id) => (record.commands ?? []).find((c) => c.id === id);
	const total = command('direct-tap')?.result?.tests;
	const rows = new Map([...(docs.readme ?? '').matchAll(/^\| `([^`]+\.test\.mjs)` \| (\d+) \|/gm)].map((m) => [m[1], Number(m[2])]));
	for (const f of ofRole(record, 'test')) {
		const name = path.posix.basename(f.path);
		if (rows.get(name) !== f.test_count) problems.push(`README table: ${name} states ${rows.get(name)}, recorded ${f.test_count}`);
		rows.delete(name);
	}
	for (const name of rows.keys()) problems.push(`README table: ${name} is not a recorded test file`);
	for (const [name, text] of Object.entries(docs)) {
		if (!text.includes(record.base_commit)) problems.push(`${name}: does not name the base commit ${record.base_commit}`);
		for (const m of text.matchAll(/(?<![\w.])\*{0,2}(\d+)\*{0,2} tests\b/g)) if (Number(m[1]) !== total) problems.push(`${name}: "${m[0]}" but the recorded total is ${total}`);
	}
	const runs = [...(docs.readme ?? '').matchAll(/NESTED_SUITE \w+ RUN \d+ files/g)].map((m) => m[0]);
	if (runs.length === 0) problems.push('README: does not state the NESTED_SUITE line of the nested runner');
	for (const run of runs) if (run !== command('nested-runner')?.first_line) problems.push(`README: "${run}" but the recorded first line is "${command('nested-runner')?.first_line}"`);
	return problems;
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
	const entry = (role, rel) => ({ role, path: rel, ...digestsOf(fs.readFileSync(path.join(upstream, rel))) });
	const record = {
		base_commit: run(upstream, 'rev-parse', 'HEAD'),
		source_dir: 'src',
		test_dir: 'tests',
		files: [entry('source', 'src/a.mjs'), entry('source', 'src/b.mjs'), { ...entry('test', 'tests/a.test.mjs'), test_count: 1 }]
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

// A fixture call is { module, fn, args, chain }. The module is a pinned file, or $builtin for a function of this library
// (BUILTINS). A value in args is plain JSON, or one of these nodes (a node is an object with the reserved key):
//   { $file: <pinned path> }         the text of the file
//   { $json: <pinned path> }         the file parsed as JSON
//   { $fileSha256: <pinned path> }   the sha256 of the file, and { $fileBytes: <pinned path> } its size
//   { $repeat: { text, times } }     text repeated, for digests and over-long values that would be unreadable inline
//   { $edit: { base, set: [[pointer, value]], remove: [pointer] } }   a copy of base with the listed edits applied
//   { $export: { module, name } }    an export of a pinned module (the module namespace when name is left out)
//   { $map: [[key, value], ...] }    a Map
//   { $call: <call>, $get: <key> }   the result of a nested call, or one property of it
// Maps, Sets, functions and undefined in the output are normalised, and an error thrown by the called code is recorded as
// { threw }. An error in the call itself (a missing file, a bad pointer) is a DslError and fails the replay instead of being
// recorded as behaviour.
export class DslError extends Error {
	constructor(message) {
		super(message);
		this.name = 'DslError';
	}
}

const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

function pointerSegments(pointer) {
	if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/'))) throw new DslError(`not a json pointer: ${JSON.stringify(pointer)}`);
	return pointer === '' ? [] : pointer.slice(1).split('/').map((raw) => raw.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function editAt(root, pointer, apply) {
	const segments = pointerSegments(pointer);
	if (segments.length === 0) throw new DslError('an edit needs a pointer below the root');
	let parent = root;
	for (const key of segments.slice(0, -1)) {
		if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new DslError(`${pointer}: there is no value at ${key}`);
		parent = parent[key];
	}
	const last = segments.at(-1);
	if (parent === null || typeof parent !== 'object') throw new DslError(`${pointer}: the parent is not an object or an array`);
	if (last === '__proto__') throw new DslError(`${pointer}: __proto__ cannot be edited`);
	apply(parent, last);
}

function setAt(root, pointer, value) {
	editAt(root, pointer, (parent, key) => {
		if (!Array.isArray(parent)) parent[key] = value;
		else if (key === '-') parent.push(value);
		else if (ARRAY_INDEX.test(key) && Number(key) <= parent.length) parent[Number(key)] = value;
		else throw new DslError(`${pointer}: not a position of the array`);
	});
}

function removeAt(root, pointer) {
	editAt(root, pointer, (parent, key) => {
		if (Array.isArray(parent)) {
			if (!ARRAY_INDEX.test(key) || Number(key) >= parent.length) throw new DslError(`${pointer}: not a position of the array`);
			parent.splice(Number(key), 1);
		} else if (Object.hasOwn(parent, key)) delete parent[key];
		else throw new DslError(`${pointer}: there is no such key`);
	});
}

async function evalArg(arg, ctx) {
	if (Array.isArray(arg)) {
		const out = [];
		for (const a of arg) out.push(await evalArg(a, ctx));
		return out;
	}
	if (arg && typeof arg === 'object') {
		if ('$file' in arg) return ctx.readText(arg.$file);
		if ('$json' in arg) {
			try {
				return JSON.parse(ctx.readText(arg.$json));
			} catch (error) {
				throw error instanceof DslError ? error : new DslError(`${arg.$json} is not JSON: ${error.message}`);
			}
		}
		if ('$fileSha256' in arg) return sha256(ctx.readBuffer(arg.$fileSha256));
		if ('$fileBytes' in arg) return ctx.readBuffer(arg.$fileBytes).length;
		if ('$repeat' in arg) {
			const { text, times } = arg.$repeat;
			if (typeof text !== 'string' || text === '' || !Number.isInteger(times) || times < 1 || times > 1000000) throw new DslError('$repeat needs a non-empty text and an integer times from 1 to 1000000');
			return text.repeat(times);
		}
		if ('$edit' in arg) {
			const out = structuredClone(await evalArg(arg.$edit.base, ctx));
			for (const [pointer, value] of arg.$edit.set ?? []) setAt(out, pointer, await evalArg(value, ctx));
			for (const pointer of arg.$edit.remove ?? []) removeAt(out, pointer);
			return out;
		}
		if ('$export' in arg) {
			const { module: rel, name } = arg.$export;
			const mod = await ctx.load(rel);
			if (name === undefined) return mod;
			if (!(name in mod)) throw new DslError(`${rel} has no export ${name}`);
			return mod[name];
		}
		if ('$map' in arg) return new Map(await evalArg(arg.$map, ctx));
		if ('$call' in arg) {
			const value = await evalCall(arg.$call, ctx);
			return arg.$get === undefined ? value : value[arg.$get];
		}
		const out = {};
		for (const [k, v] of Object.entries(arg)) out[k] = await evalArg(v, ctx);
		return out;
	}
	return arg;
}

// Functions of this library that a fixture may call as { module: '$builtin', fn }, with the context as first argument. They
// compare things that no single SDK function exposes, and they are recomputed like every other fixture.
export const BUILTINS = {
	// The verdict of one JSON Schema file and of one runtime validator over the same value. The runtime validator is called as
	// runtime(value, ...extra) and okPointer selects its boolean verdict, so that the two can be compared case by case.
	async schemaParity(ctx, { schema, runtime, okPointer, value, extra = [] }) {
		if (typeof schema !== 'string' || typeof runtime !== 'function' || typeof okPointer !== 'string') throw new DslError('schemaParity needs a schema text ($file), a runtime validator ($export) and an okPointer');
		const Ajv2020 = (await ctx.load('node_modules/ajv/dist/2020.js')).default;
		const validate = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(schema));
		const schemaAccepts = validate(value) === true;
		const verdict = await runtime(value, ...extra);
		const runtimeAccepts = pointerGet(verdict, okPointer);
		if (typeof runtimeAccepts !== 'boolean') throw new DslError(`schemaParity: ${okPointer} of the runtime verdict is not a boolean`);
		return { schemaAccepts, runtimeAccepts, agree: schemaAccepts === runtimeAccepts, runtimeErrors: verdict?.errors ?? null };
	},
	// For every export of a module, the labels of the texts that name it by whole word: { <export>: [labels] }. A name in a comment
	// or a string counts as well, so a label says where a test could use an export, never that it exercises it; an empty list
	// says that none of the given texts names the export at all.
	exportUsage(ctx, { exports, texts }) {
		const isTexts = texts && typeof texts === 'object' && !Array.isArray(texts) && Object.keys(texts).length > 0 && Object.values(texts).every((t) => typeof t === 'string');
		if (!exports || typeof exports !== 'object' || !isTexts) throw new DslError('exportUsage needs a module namespace ($export without name) and texts: { label: file text ($file) }');
		const labels = Object.keys(texts).sort();
		return Object.fromEntries(Object.keys(exports).sort().map((name) => {
			const word = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$&')}(?![\\w$])`);
			return [name, labels.filter((label) => word.test(texts[label]))];
		}));
	}
};

export async function evalCall(spec, ctx) {
	const builtin = spec.module === BUILTIN;
	const fn = builtin ? BUILTINS[spec.fn] : (await ctx.load(spec.module))[spec.fn];
	if (typeof fn !== 'function') throw new DslError(`${spec.module} has no function ${spec.fn}`);
	const args = await evalArg(spec.args ?? [], ctx);
	let value = builtin ? await fn(ctx, ...args) : await fn(...args);
	for (const step of spec.chain ?? []) value = await value[step.method](...(await evalArg(step.args ?? [], ctx)));
	return value;
}

export function normalize(value) {
	if (value instanceof Map) return { $map: [...value.entries()].map(([k, v]) => [normalize(k), normalize(v)]) };
	if (value instanceof Set) return { $set: [...value].map(normalize) };
	if (Array.isArray(value)) return value.map(normalize);
	if (typeof value === 'function') return { $function: value.name };
	if (value === undefined) return { $undefined: true };
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
	return value;
}

export function pointerGet(value, pointer) {
	let cur = value;
	for (const raw of pointer === '' ? [] : pointer.slice(1).split('/')) {
		const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
		if (key === 'length' && (Array.isArray(cur) || typeof cur === 'string')) cur = cur.length;
		else if (cur !== null && typeof cur === 'object' && Object.hasOwn(cur, key)) cur = cur[key];
		else return { $missing: pointer };
	}
	return cur;
}

// A file or module that a fixture names is read below `root`; a path that leaves it, a file that cannot be read and a module that
// cannot be loaded are errors in the record (DslError), never behaviour of the code under test.
export const fixtureContext = (root) => {
	const resolve = (rel) => {
		if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || rel.split('/').includes('..')) throw new DslError(`not a repo-relative path: ${JSON.stringify(rel)}`);
		return path.join(root, rel);
	};
	const readBuffer = (rel) => {
		const file = resolve(rel);
		try {
			return fs.readFileSync(file);
		} catch (error) {
			throw new DslError(`cannot read ${rel}: ${error.code ?? error.message}`);
		}
	};
	return {
		readBuffer,
		readText: (rel) => readBuffer(rel).toString('utf8'),
		load: async (rel) => {
			const file = resolve(rel);
			try {
				return await import(pathToFileURL(file).href);
			} catch (error) {
				throw new DslError(`cannot load ${rel}: ${error.code ?? error.message}`);
			}
		}
	};
};

export async function runFixture(f, ctx) {
	try {
		return normalize(await evalCall(f.call, ctx));
	} catch (error) {
		if (error instanceof DslError) throw error;
		return { threw: { name: error.name, message: error.message } };
	}
}

export async function replay(record, root) {
	const ctx = fixtureContext(root);
	const out = [];
	for (const f of record.fixtures) {
		const first = await runFixture(f, ctx);
		const again = await runFixture(f, ctx);
		out.push({ id: f.id, deterministic: canonical(first) === canonical(again), output_sha256: sha256(canonical(first)), observed: f.expect.map(([pointer]) => pointerGet(first, pointer)) });
	}
	return out;
}

export function replayProblems(record, computed) {
	const problems = [];
	if (computed.length !== record.fixtures.length) problems.push(`replayed ${computed.length} fixtures, record has ${record.fixtures.length}`);
	record.fixtures.forEach((f, i) => {
		const c = computed[i];
		if (!c || c.id !== f.id) return problems.push(`${f.id}: not replayed`);
		if (!c.deterministic) problems.push(`${f.id}: two runs differ`);
		if (c.output_sha256 !== f.output_sha256) problems.push(`${f.id}: output sha256 ${c.output_sha256} != recorded ${f.output_sha256}`);
		f.expect.forEach(([pointer, want], j) => {
			if (canonical(c.observed[j]) !== canonical(want)) problems.push(`${f.id}: ${pointer} is ${canonical(c.observed[j])}, recorded ${canonical(want)}`);
		});
	});
	return problems;
}

// A recorded step gets a pinned environment: the caller's NODE_OPTIONS, NODE_TEST_CONTEXT, CI, FORCE_COLOR, TZ or locale
// cannot change its exit code or counts.
export const STEP_ENV = { LC_ALL: 'C', TZ: 'UTC', NO_COLOR: '1' };

function runNode(root, args) {
	const inherited = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
	return spawnSync(process.execPath, args, { cwd: root, env: { ...inherited, ...STEP_ENV }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function counts(stdout, pattern) {
	const result = {};
	for (const m of stdout.matchAll(pattern)) result[m[1]] = Number(m[2]);
	return result;
}

export function runTapTests(root, files) {
	const res = runNode(root, ['--test', ...files]);
	return { exit_code: res.status, result: counts(res.stdout ?? '', /^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/gm) };
}

export function runNestedRunner(root, suiteId) {
	const res = runNode(root, [RUNNER_SCRIPT, suiteId]);
	const stdout = res.stdout ?? '';
	return { exit_code: res.status, first_line: stdout.split('\n')[0], result: counts(stdout, /^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/gm) };
}
