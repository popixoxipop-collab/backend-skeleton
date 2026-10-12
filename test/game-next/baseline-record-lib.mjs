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
	item: 'T17-01',
	suiteId: 'T17',
	recordFile: 'adapters/game-next/BASELINE.json',
	sourceDir: 'adapters/game-next',
	testDir: 'test/game-next',
	legacyTest: 'test/webgame-contract.test.mjs',
	docs: { readme: 'README.md', rfc: 'INTERFACE_RFC.md', integration: 'INTEGRATION.md' },
	// Files this track adds after the base commit. The record cannot hash them (they do not exist at the base commit), so
	// they are listed here instead; any other unrecorded file in the track directories moves the tree off the baseline.
	ownFiles: [
		'test/game-next/baseline-record.test.mjs',
		'test/game-next/baseline-record-lib.mjs',
		'test/game-next/native-export-envelope-schema.test.mjs',
		'test/game-next/interface-doc.test.mjs',
		'adapters/game-next/native-export-envelope.schema.json'
	]
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
export const BY_NUMBER = /#\d|\bPR\s*\d|\/pull\/\d|\/issues\/\d|\bGH-\d|refs\/pull/;
const SCRIPT = /\.(mjs|cjs|js)$/;

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

// Every $file, every module that a nested $call names, and every $use in a fixture call or shared input.
function grammarRefs(value) {
	const refs = { files: [], modules: [], uses: [] };
	walk(value, '', (v) => {
		if (!v || typeof v !== 'object' || Array.isArray(v)) return;
		if (typeof v.$file === 'string') refs.files.push(v.$file);
		if (typeof v.$use === 'string') refs.uses.push(v.$use);
		if (v.$call && typeof v.$call === 'object' && typeof v.$call.module === 'string') refs.modules.push(v.$call.module);
	});
	return refs;
}

// A reference check is a git grep at the pinned commit (-l -E). An empty result is evidence only when a control pattern finds
// files in the same scope with the same options, so `paths: []` is accepted only together with a control that lists some.
const stringList = (list) => Array.isArray(list) && list.every((p) => typeof p === 'string' && p !== '');
const repoRelative = (p) => typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.endsWith('/') && !p.split('/').includes('..');
export function referenceShapeProblems(id, x) {
	const problems = [];
	const control = x?.control;
	if (typeof x?.pattern !== 'string' || x.pattern === '') problems.push(`limit ${id}: references needs a pattern`);
	if (!stringList(x?.paths) || (x.paths.length === 0 && control === undefined)) problems.push(`limit ${id}: references needs a non-empty list of paths (an empty list needs a control)`);
	if (control !== undefined && (typeof control?.pattern !== 'string' || control.pattern === '' || !stringList(control.paths) || control.paths.length === 0)) problems.push(`limit ${id}: references.control needs a pattern and a non-empty list of paths`);
	for (const key of ['within', 'excluded']) {
		if (x?.[key] !== undefined && (!stringList(x[key]) || (key === 'within' && x[key].length === 0))) problems.push(`limit ${id}: references.${key} must be a ${key === 'within' ? 'non-empty ' : ''}list of repo-relative paths`);
	}
	if (x?.ignore_case !== undefined && x.ignore_case !== true) problems.push(`limit ${id}: references.ignore_case is true or absent`);
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
	const textOnly = r?.environment?.fixture_text_packages;
	if (!Array.isArray(textOnly) || !textOnly.every((name) => typeof name === 'string' && name !== '' && !Object.hasOwn(loaded ?? {}, name)) || canonical(textOnly) !== canonical([...new Set(textOnly)].sort())) bad('environment.fixture_text_packages must be a sorted list of package names that are not loaded packages');
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
	const legacy = byId.get('legacy-tap');
	if (!runner || !direct || !legacy) bad('commands must include nested-runner, direct-tap and legacy-tap');
	else {
		if (runner.command !== `node ${RUNNER_SCRIPT} ${r.suite_id}`) bad('nested-runner command does not name the suite');
		if (runner.runner_files !== testPaths.length) bad('nested-runner runner_files does not match the recorded test files');
		if (runner.first_line !== `NESTED_SUITE ${r.suite_id} RUN ${runner.runner_files} files`) bad('nested-runner first_line does not match the suite and file count');
		if (direct.command !== tapCommand(testPaths)) bad('direct-tap command does not list exactly the recorded test files');
		if (direct.result?.tests !== total) bad(`direct-tap tests ${direct.result?.tests} != sum of per-file test_count ${total}`);
		if (runner.result?.tests !== direct.result?.tests) bad('nested-runner and direct-tap disagree on the test count');
		if (legacy.command !== tapCommand([TRACK.legacyTest])) bad(`legacy-tap command must run exactly ${TRACK.legacyTest}`);
		if (!ofRole(r, 'external_dependency').some((f) => f.path === TRACK.legacyTest)) bad(`${TRACK.legacyTest} must be pinned as an external_dependency`);
		if (legacy.result?.tests < 1) bad('legacy-tap ran no test');
	}
	const ids = new Set();
	const shared = r?.shared && typeof r.shared === 'object' && !Array.isArray(r.shared) ? r.shared : {};
	const checkRefs = (value, where) => {
		const refs = grammarRefs(value);
		for (const ref of refs.files) if (!paths.has(ref)) bad(`${where}: $file ${ref} is not a pinned file`);
		for (const module of refs.modules) if (!paths.has(module)) bad(`${where}: module ${module} is not a pinned file`);
		for (const name of refs.uses) if (!Object.hasOwn(shared, name)) bad(`${where}: $use ${name} names no shared input`);
	};
	for (const [name, value] of Object.entries(shared)) checkRefs(value, `shared ${name}`);
	for (const f of r?.fixtures ?? []) {
		if (typeof f?.id !== 'string' || f.id === '' || ids.has(f.id)) bad(`fixture id ${f?.id} is missing or duplicated`);
		ids.add(f?.id);
		if (f?.class !== 'normal' && f?.class !== 'negative') bad(`${f?.id}: class must be normal or negative`);
		if (typeof f?.origin !== 'string' || f.origin === '') bad(`${f?.id}: origin is missing`);
		if (!paths.has(f?.call?.module) || typeof f?.call?.fn !== 'string') bad(`${f?.id}: call must name a pinned module and a function`);
		checkRefs(f?.call, f?.id);
		const pairs = Array.isArray(f?.expect) ? f.expect : [];
		if (pairs.length === 0 || !pairs.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && (e[0] === '' || e[0].startsWith('/')))) bad(`${f?.id}: expect needs [json-pointer, value] pairs`);
		if (!SHA256.test(f?.output_sha256 ?? '')) bad(`${f?.id}: output_sha256 must be a 64-hex digest`);
	}
	for (const cls of ['normal', 'negative']) {
		if (!(r?.fixtures ?? []).some((f) => f.class === cls)) bad(`needs at least one ${cls} fixture`);
	}
	if (r?.artifact_digest?.value !== artifactDigest(r)) bad('artifact_digest does not match the record (it covers every field except its own value)');
	if (!Array.isArray(r?.limits) || r.limits.length === 0) bad('limits must record the remaining limits');
	for (const l of r?.limits ?? []) {
		if (!LIMIT_STATUSES.includes(l.status)) bad(`limit ${l.id}: status ${l.status} is not one of ${LIMIT_STATUSES.join('/')}`);
		if (typeof l.statement !== 'string' || l.statement.trim() === '') bad(`limit ${l.id}: statement is empty`);
		for (const id of l.fixtures ?? []) if (!ids.has(id)) bad(`limit ${l.id}: unknown fixture ${id}`);
		if (l.references !== undefined) problems.push(...referenceShapeProblems(l.id, l.references));
		if (l.absent !== undefined && !(Array.isArray(l.absent) && l.absent.length > 0 && l.absent.every(repoRelative))) bad(`limit ${l.id}: absent needs a non-empty list of repo-relative paths`);
		if (l.status !== 'NOT_RECORDED' && !(l.fixtures?.length > 0) && l.references === undefined && l.absent === undefined) bad(`limit ${l.id}: needs evidence (fixtures, references or absent), only a NOT_RECORDED limit may stand on its statement`);
	}
	walk(r?.pins ?? {}, 'pins', (v, trail) => {
		if (!v || typeof v !== 'object' || Array.isArray(v)) return;
		for (const [k, x] of Object.entries(v)) {
			if (/(^|_)commit$/.test(k) && !SHA1.test(x ?? '')) bad(`${trail}.${k} must be a 40-hex commit id`);
			if (/blob_sha1$/.test(k) && !SHA1.test(x ?? '')) bad(`${trail}.${k} must be a 40-hex blob id`);
			if (/sha256$/.test(k) && !SHA256.test(x ?? '')) bad(`${trail}.${k} must be a 64-hex digest`);
		}
	});
	for (const o of r?.ci_observations ?? []) if (o.head_sha !== r.base_commit) bad(`ci run ${o.run_id}: head_sha is not the base commit`);
	if (BY_NUMBER.test(JSON.stringify([r?.limits, r?.ci_observations, r?.pins, (r?.fixtures ?? []).map((f) => f.origin)]))) bad('limits, ci_observations, pins and origins must pin by commit sha, not by PR or issue number');
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
		...listFiles(root, record.source_dir).filter((p) => !p.endsWith('.md') && p !== TRACK.recordFile && !recorded.has(p) && !TRACK.ownFiles.includes(p)),
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

// A path is absent at the pinned commit when neither a file nor a directory has that name there. The directory that would
// hold it must exist at the commit, so a mistyped parent cannot pass as absence.
export function absentProblems(root, commit, paths) {
	const problems = [];
	for (const rel of paths) {
		if (blobAtCommit(root, commit, rel) !== null) problems.push(`${rel} exists at ${commit}`);
		else if (path.posix.dirname(rel) !== '.' && blobAtCommit(root, commit, path.posix.dirname(rel)) === null) problems.push(`${rel}: its directory does not exist at ${commit}, so the absence proves nothing`);
	}
	return problems;
}

// Files inside `within` (default: the whole tree) and outside the excluded directories that match `pattern` (git grep -l -E,
// -i when ignoreCase) in the tree of the pinned commit.
export const referencesAtCommit = (root, commit, pattern, excluded, { within = ['.'], ignoreCase = false } = {}) => {
	const res = git(root, ['grep', '-l', '-E', ...(ignoreCase ? ['-i'] : []), '-e', pattern, commit, '--', ...within, ...excluded.map((d) => `:!${d}`)]);
	if (res.status !== 0 && res.status !== 1) throw new Error(`git grep failed: ${res.stderr}`);
	return res.stdout.split('\n').filter(Boolean).map((line) => line.slice(commit.length + 1)).sort();
};

// What a limit's `references` entry states, recomputed: the matching files and, when the entry has one, the control's files.
export function referenceResult(root, commit, record, x) {
	const excluded = x.excluded ?? [record.source_dir, record.test_dir];
	const options = { within: x.within, ignoreCase: x.ignore_case === true };
	return {
		found: referencesAtCommit(root, commit, x.pattern, excluded, options),
		control: x.control ? referencesAtCommit(root, commit, x.control.pattern, excluded, options) : null
	};
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

// The code of a script: comments, template literals and regular expression literals are replaced by blanks (newlines are
// kept, so a line that starts with `import` is still a line start), strings stay because a specifier is a string. The legacy
// webgame test keeps whole fixture sources in template literals, and those texts contain import lines that the scanner under
// test reads and nobody loads. A slash starts a regular expression after an operator, an opening bracket or one of a few
// keywords, otherwise it divides; a regular expression ends on its own line. A text that ends inside a string, a comment or
// a template is refused, never guessed.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await']);
const keepNewlines = (text) => `0${'\n'.repeat(text.split('\n').length - 1)}`;

function stringEnd(src, start) {
	for (let i = start + 1; i < src.length; i += 1) {
		if (src[i] === '\\') i += 1;
		else if (src[i] === src[start]) return i + 1;
		else if (src[i] === '\n') break;
	}
	throw new Error(`unterminated string literal at offset ${start}`);
}

function regexEnd(src, start) {
	let inClass = false;
	for (let i = start + 1; i < src.length && src[i] !== '\n'; i += 1) {
		if (src[i] === '\\') i += 1;
		else if (src[i] === '[') inClass = true;
		else if (src[i] === ']') inClass = false;
		else if (src[i] === '/' && !inClass) {
			let end = i + 1;
			while (/[a-z]/.test(src[end] ?? '')) end += 1;
			return end;
		}
	}
	return -1;
}

function templateEnd(src, start) {
	for (let i = start + 1; i < src.length; i += 1) {
		if (src[i] === '\\') i += 1;
		else if (src[i] === '`') return i + 1;
		else if (src[i] === '$' && src[i + 1] === '{') i = lexCode(src, i + 2, true).end - 1;
	}
	throw new Error(`unterminated template literal at offset ${start}`);
}

function lexCode(src, start, nested) {
	let out = '';
	let depth = 0;
	let prev = '';
	let word = '';
	let i = start;
	if (!nested && src.startsWith('#!')) {
		const end = src.indexOf('\n');
		i = end < 0 ? src.length : end;
	}
	const emit = (text, significant = text) => {
		out += text;
		if (/\S/.test(significant)) {
			prev = significant.at(-1);
			word = /[\w$]/.test(prev) ? (/[\w$]/.test(out.at(-2) ?? '') ? word : '') + prev : '';
		}
	};
	while (i < src.length) {
		const c = src[i];
		if (c === '/' && src[i + 1] === '/') {
			const end = src.indexOf('\n', i);
			i = end < 0 ? src.length : end;
		} else if (c === '/' && src[i + 1] === '*') {
			const close = src.indexOf('*/', i + 2);
			if (close < 0) throw new Error(`unterminated comment at offset ${i}`);
			out += ' ' + '\n'.repeat(src.slice(i, close).split('\n').length - 1);
			i = close + 2;
		} else if (c === '"' || c === "'") {
			const end = stringEnd(src, i);
			emit(src.slice(i, end));
			i = end;
		} else if (c === '`') {
			const end = templateEnd(src, i);
			emit(keepNewlines(src.slice(i, end)), '0');
			i = end;
		} else if (c === '/' && (prev === '' || !/[\w$)\]}'"`]/.test(prev) || REGEX_AFTER_WORD.has(word)) && regexEnd(src, i) > 0) {
			const end = regexEnd(src, i);
			emit('0');
			i = end;
		} else if (c === '}' && nested && depth === 0) {
			return { end: i + 1, out };
		} else {
			if (c === '{') depth += 1;
			if (c === '}') depth -= 1;
			emit(c);
			i += 1;
		}
	}
	if (nested) throw new Error('unterminated template expression');
	return { end: i, out };
}

export const codeText = (source) => lexCode(source, 0, false).out;

// A textual scan: import and export clauses that start a line, side-effect imports, and import() and require() with a string
// literal. A specifier that is built at run time is not seen.
const IMPORT_FORMS = /^[ \t]*(?:import|export)\b[\w$*\s,{}]*?\bfrom\s*(['"])([^'"\n]+)\1|^[ \t]*import\s*(['"])([^'"\n]+)\3|\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\5\s*\)/gm;
const packagesIn = (text) => [...new Set([...text.matchAll(IMPORT_FORMS)].map((m) => packageOf(m[2] ?? m[4] ?? m[6])).filter(Boolean))].sort();
export const importedPackages = (source) => packagesIn(codeText(source));
// Packages that an import-shaped line names only inside text (a template literal, a comment): scanned fixture sources, not loads.
export const fixtureTextPackages = (source) => {
	const loaded = new Set(importedPackages(source));
	return packagesIn(source).filter((name) => !loaded.has(name));
};

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

// The pinned legacy test imports ajv (ajv/dist/2020.js), so a copy of the base commit runs against the node_modules of this
// checkout. That is evidence for the base commit only while every package the copy can
// load is installed at the version the base commit's package-lock.json states; otherwise the copy is not linked and the
// caller fails. A missing node_modules fails loudly too. Returns the checked versions.
const scriptTexts = (dest, paths) => paths.filter((p) => SCRIPT.test(p)).map((p) => ({ path: p, text: fs.readFileSync(path.join(dest, p), 'utf8') }));

// The packages that import-shaped lines of the pinned scripts name only inside text (the legacy test keeps scanner fixture
// sources in template literals): not loaded, not in the lock, and recorded so that a package cannot move out of sight.
export const fixtureTextNames = (dest, paths) => [...new Set(scriptTexts(dest, paths).flatMap(({ text }) => fixtureTextPackages(text)))].sort();

export function linkModules(root, dest, paths) {
	const modules = path.join(root, 'node_modules');
	if (!fs.existsSync(modules)) throw new Error(`${modules} does not exist; run npm ci first`);
	const { versions, problems } = lockedVersions(JSON.parse(fs.readFileSync(path.join(dest, 'package-lock.json'), 'utf8')), scriptTexts(dest, paths));
	problems.push(...installedProblems(versions, modules));
	if (problems.length > 0) throw new Error(`node_modules of this checkout is not the dependency set of the base commit: ${problems.join('; ')}`);
	fs.symlinkSync(modules, path.join(dest, 'node_modules'), 'dir');
	return versions;
}

// The documents describe the pinned base commit, so every number they state is recomputed from the record: the table rows
// equal the pinned per-file counts, each "<n> tests" equals the direct-tap total, each "<n> legacy tests" equals the
// legacy-tap total, each "NESTED_SUITE ... RUN <n> files" equals the recorded first runner line, and each document names
// the base commit.
export function docProblems(record, docs) {
	const problems = [];
	const command = (id) => (record.commands ?? []).find((c) => c.id === id);
	const total = command('direct-tap')?.result?.tests;
	const legacyTotal = command('legacy-tap')?.result?.tests;
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
		for (const m of text.matchAll(/(?<![\w.])\*{0,2}(\d+)\*{0,2} legacy tests\b/g)) if (Number(m[1]) !== legacyTotal) problems.push(`${name}: "${m[0]}" but the recorded legacy total is ${legacyTotal}`);
		if (/\brecomput\w*\s+(?:everything|all)\b/i.test(text)) problems.push(`${name}: says that a test recomputes everything, but verification.not_recomputed lists what it does not`);
	}
	// What the record test does not recompute is named in the README by the label that the record gives it.
	for (const entry of record.verification?.not_recomputed ?? []) {
		const label = entry.split(/\s*[:(]/)[0];
		if (!(docs.readme ?? '').replaceAll('`', '').includes(label)) problems.push(`README: does not name "${label}", which verification.not_recomputed lists as not recomputed`);
	}
	const runs =[...(docs.readme ?? '').matchAll(/NESTED_SUITE \w+ RUN \d+ files/g)].map((m) => m[0]);
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

// Fixture calls: { module, fn, args, chain }. An argument may be { $file: <pinned path> } (the file text), { $call: <call> }
// (a nested call; with $get the named property of its result), { $map: [[key, value], ...] } (a Map), { $use: <name> } (the
// shared input of that name), { $lines: [text, ...] } (the texts joined by a newline and ended by one), { $concat: [text, ...] },
// { $json: <value>, $indent } (JSON text), { $project: { <path>: <text>, ... } } (the path of a throw-away directory that holds
// those files) or { $edit: <value>, set: [[pointer, value], ...], delete: [pointer, ...] } (a deep copy with those changes). A
// call whose fn is $exports (no args, no chain) returns the sorted export names of its module. Maps, Sets and byte arrays in the
// output are normalised, errors are recorded as { threw }. A key that starts with $ and is not one of these is an error, never
// plain data.
const GRAMMAR = ['$file', '$use', '$lines', '$concat', '$json', '$project', '$edit', '$map', '$call'];
const GRAMMAR_KEYS = { $call: ['$get'], $json: ['$indent'], $edit: ['set', 'delete'] };

async function evalAll(list, ctx) {
	const out = [];
	for (const item of list) out.push(await evalArg(item, ctx));
	return out;
}

const pointerParts = (pointer) => pointer.slice(1).split('/').map((raw) => raw.replace(/~1/g, '/').replace(/~0/g, '~'));

function parentOf(value, pointer) {
	if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new Error(`bad json pointer ${pointer}`);
	const parts = pointerParts(pointer);
	let cur = value;
	for (const key of parts.slice(0, -1)) {
		if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) throw new Error(`json pointer ${pointer} does not exist`);
		cur = cur[key];
	}
	if (cur === null || typeof cur !== 'object') throw new Error(`json pointer ${pointer} does not exist`);
	return [cur, parts[parts.length - 1]];
}

async function evalArg(arg, ctx) {
	if (Array.isArray(arg)) return evalAll(arg, ctx);
	if (!arg || typeof arg !== 'object') return arg;
	const head = GRAMMAR.find((k) => k in arg);
	const marked = Object.keys(arg).filter((k) => k.startsWith('$'));
	if (!head && marked.length > 0) throw new Error(`unknown fixture grammar element ${marked[0]}`);
	if (head) {
		const stray = Object.keys(arg).filter((k) => k !== head && !(GRAMMAR_KEYS[head] ?? []).includes(k));
		if (stray.length > 0) throw new Error(`fixture grammar element ${head} does not take ${stray.join(', ')}`);
	}
	switch (head) {
		case '$file': return ctx.readText(arg.$file);
		case '$use':
			if (!Object.hasOwn(ctx.shared, arg.$use)) throw new Error(`no shared input named ${arg.$use}`);
			return evalArg(ctx.shared[arg.$use], ctx);
		case '$lines': return `${(await evalAll(arg.$lines, ctx)).join('\n')}\n`;
		case '$concat': return (await evalAll(arg.$concat, ctx)).join('');
		case '$json': return JSON.stringify(await evalArg(arg.$json, ctx), null, arg.$indent);
		case '$project': {
			const files = {};
			for (const [rel, content] of Object.entries(arg.$project)) files[rel] = await evalArg(content, ctx);
			return ctx.project(files);
		}
		case '$edit': {
			const value = structuredClone(await evalArg(arg.$edit, ctx));
			for (const [pointer, to] of arg.set ?? []) {
				const [parent, key] = parentOf(value, pointer);
				parent[key] = await evalArg(to, ctx);
			}
			for (const pointer of arg.delete ?? []) {
				const [parent, key] = parentOf(value, pointer);
				if (!Object.hasOwn(parent, key)) throw new Error(`json pointer ${pointer} does not exist`);
				if (Array.isArray(parent)) parent.splice(Number(key), 1);
				else delete parent[key];
			}
			return value;
		}
		case '$map': return new Map(await evalArg(arg.$map, ctx));
		case '$call': {
			const value = await evalCall(arg.$call, ctx);
			return arg.$get === undefined ? value : value[arg.$get];
		}
		default: {
			const out = {};
			for (const [k, v] of Object.entries(arg)) out[k] = await evalArg(v, ctx);
			return out;
		}
	}
}

export async function evalCall(spec, ctx) {
	const mod = await ctx.load(spec.module);
	if (spec.fn === '$exports') {
		if (spec.args !== undefined || spec.chain !== undefined) throw new Error('a $exports call takes no args and no chain');
		return Object.keys(mod).sort();
	}
	let value = await mod[spec.fn](...(await evalArg(spec.args ?? [], ctx)));
	for (const step of spec.chain ?? []) value = await value[step.method](...(await evalArg(step.args ?? [], ctx)));
	return value;
}

export function normalize(value) {
	if (value instanceof Uint8Array) return { $bytes: { length: value.length, sha256: sha256(value) } };
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

// `project` writes the given files into a new throw-away directory (removed at process exit) and returns its path.
export const fixtureContext = (root, record = {}) => ({
	readText: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
	load: (rel) => import(pathToFileURL(path.join(root, rel)).href),
	shared: record.shared ?? {},
	project: (files) => {
		const dir = tmpDir('t17-fixture-');
		for (const [rel, text] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
			fs.writeFileSync(path.join(dir, rel), text);
		}
		return dir;
	}
});

export async function runFixture(f, ctx) {
	try {
		return normalize(await evalCall(f.call, ctx));
	} catch (error) {
		return { threw: { name: error.name, message: error.message } };
	}
}

export async function replay(record, root) {
	const ctx = fixtureContext(root, record);
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

// `extra` replaces the inherited PATH, HOME or TMPDIR for one step (the legacy test leaves temporary directories behind, so
// that step gets a private TMPDIR); STEP_ENV always wins.
function runNode(root, args, extra = {}) {
	const inherited = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
	return spawnSync(process.execPath, args, { cwd: root, env: { ...inherited, ...extra, ...STEP_ENV }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function counts(stdout, pattern) {
	const result = {};
	for (const m of stdout.matchAll(pattern)) result[m[1]] = Number(m[2]);
	return result;
}

export function runTapTests(root, files, extra = {}) {
	const res = runNode(root, ['--test', ...files], extra);
	return { exit_code: res.status, result: counts(res.stdout ?? '', /^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/gm) };
}

export function runNestedRunner(root, suiteId) {
	const res = runNode(root, [RUNNER_SCRIPT, suiteId]);
	const stdout = res.stdout ?? '';
	return { exit_code: res.status, first_line: stdout.split('\n')[0], result: counts(stdout, /^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/gm) };
}
