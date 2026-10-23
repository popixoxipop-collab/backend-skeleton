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
	item: 'T12-01',
	suiteId: 'T12',
	recordFile: 'adapters/http-wave-a/BASELINE.json',
	sourceDir: 'adapters/http-wave-a',
	testDir: 'test/http-wave-a',
	docs: {},
	ownFiles: [
		'adapters/http-wave-a/leaf-contract.schema.json',
		'test/http-wave-a/baseline-record.test.mjs',
		'test/http-wave-a/baseline-record-lib.mjs',
		'test/http-wave-a/interface-rfc.test.mjs',
		'test/http-wave-a/interface-rfc.vocabulary.json',
		'test/http-wave-a/rfc-boundaries.test.mjs',
		'test/http-wave-a/interface-rfc-evidence.mjs',
		'test/http-wave-a/interface-rfc-evidence.test.mjs'
	]
};
//@@TRACK-END

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RECORD_SCHEMA = 'bskel.track-baseline-record/2';
export const RUNNER_SCRIPT = 'scripts/run-next-nested-tests.mjs';
export const SHARED_MODULE = `${TRACK.sourceDir}/_shared.mjs`;
export const STATIC_RUNNER = `${TRACK.sourceDir}/python-scope/static-runner.mjs`;
export const LEAF_CONTRACT = 'bskel.internal.http-wave-a-leaf/0';

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ROLES = ['source', 'test', 'test_support', 'external_dependency', 'runner'];
export const LIMIT_STATUSES = ['UNSUPPORTED', 'UNKNOWN', 'BLOCKED', 'NOT_RECORDED'];
export const INPUT_KINDS = ['upstream-real', 'hand-fed'];
const COUNT_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const DIGEST_KEYS = ['bytes', 'git_blob_sha1', 'sha256'];
const GENERATED = /(^|\/)(__pycache__|node_modules)(\/|$)|\.pyc$/;
// Numbers of pull requests and issues are not written into the record: the record pins by commit id.
const BY_NUMBER = /#\d|\bPR\s*\d|\/pull\/\d|\/issues\/\d|\bGH-\d|refs\/pull/;
const SCRIPT = /\.(mjs|cjs|js)$/;
const PROFILE_KEYS = ['export', 'forced', 'framework_version', 'id', 'module', 'real_repo_comparison', 'state', 'supported_syntax', 'title', 'unknown_conditions', 'upstream_contracts', 'upstream_owner', 'version_pin'];

// How the author of this record classifies each realRepoComparison marker that the seven profiles carry. A marker the
// table does not know is UNCLASSIFIED, which the profile check reports, so a new or reworded marker is never silently accepted.
export const MARKER_KINDS = {
	'historical-pass-needs-leaf-rerun': 'history-needs-leaf-rerun',
	'historical-pass-does-not-certify-drf-method-projection': 'history-does-not-certify',
	'historical-pass-does-not-certify-fact-projector': 'history-does-not-certify',
	PASS_STATIC_REAL_REPO: 'pass-claim-not-reproduced',
	BLOCKED_INFRA: 'blocked-infra'
};

// The canonical form is that of the JSON text: a key whose value is undefined is left out and an undefined array item is null, so a record
// has the same digest in memory and after it was written to and read back from its file.
export function canonical(value) {
	if (Array.isArray(value)) return `[${value.map((item) => canonical(item === undefined ? null : item)).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
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

// The leaf modules of the layer: every top-level module of the source directory except the shared helpers.
export const leafModules = (root = REPO_ROOT) => fs.readdirSync(path.join(root, TRACK.sourceDir), { withFileTypes: true })
	.filter((e) => e.isFile() && e.name.endsWith('.mjs') && e.name !== '_shared.mjs').map((e) => `${TRACK.sourceDir}/${e.name}`).sort();

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
export const ofRole = (r, ...roles) => (Array.isArray(r?.files) ? r.files : []).filter((f) => roles.includes(f?.role));

function walk(value, trail, visit) {
	visit(value, trail);
	if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${trail}[${i}]`, visit));
	else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${trail}.${k}`, visit);
}

// Every module, $file and $path that a fixture call names, nested calls included. The scan follows the shape of the call
// (arguments, chain steps, $map, $call) and never reads a key called "module" inside a literal argument: a hand-fed
// registration may carry one.
function argRefs(arg, out) {
	if (Array.isArray(arg)) arg.forEach((a) => argRefs(a, out));
	else if (arg && typeof arg === 'object') {
		if ('$file' in arg) out.files.push(arg.$file);
		else if ('$path' in arg) out.dirs.push(arg.$path);
		else if ('$map' in arg) argRefs(arg.$map, out);
		else if ('$call' in arg) callRefs(arg.$call, out);
		else Object.values(arg).forEach((a) => argRefs(a, out));
	}
}

export function callRefs(call, out = { modules: [], files: [], dirs: [] }) {
	out.modules.push(call?.module);
	argRefs(call?.args ?? [], out);
	for (const step of call?.chain ?? []) argRefs(step?.args ?? [], out);
	return out;
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
	const programs = r?.environment?.external_programs;
	if (!programs || typeof programs !== 'object' || Array.isArray(programs) || Object.keys(programs).length === 0 || !Object.values(programs).every((v) => typeof v === 'string' && v !== '')) bad('environment.external_programs must map program names to version strings');
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
	const profileIds = new Set();
	for (const p of r?.profiles ?? []) {
		const where = `profile ${p?.id}`;
		if (JSON.stringify(Object.keys(p ?? {}).sort()) !== JSON.stringify(PROFILE_KEYS)) bad(`${where}: keys must be exactly ${PROFILE_KEYS.join('/')}`);
		if (typeof p?.id !== 'string' || p.id === '' || profileIds.has(p.id)) bad(`${where}: id is missing or duplicated`);
		profileIds.add(p?.id);
		if (!paths.has(p?.module) || !p.module.startsWith(`${TRACK.sourceDir}/`)) bad(`${where}: module must be a pinned file of ${TRACK.sourceDir}`);
		if (!SHA1.test(p?.version_pin?.ref ?? '')) bad(`${where}: version_pin.ref must be a 40-hex commit id`);
		const unknownVersion = p?.version_pin?.framework === null;
		if (p?.framework_version?.status !== (unknownVersion ? 'UNKNOWN' : 'DECLARED') || p?.framework_version?.value !== (p?.version_pin?.framework ?? null)) bad(`${where}: framework_version must be UNKNOWN with value null exactly when version_pin.framework is null, DECLARED with that value (stated by the profile, not verified here) otherwise`);
		if (p?.real_repo_comparison?.kind !== (MARKER_KINDS[p?.real_repo_comparison?.marker] ?? 'UNCLASSIFIED')) bad(`${where}: real_repo_comparison.kind does not follow from the marker`);
	}
	if (profileIds.size === 0) bad('profiles must list the leaf profiles');
	const ids = new Set();
	for (const f of r?.fixtures ?? []) {
		if (typeof f?.id !== 'string' || f.id === '' || ids.has(f.id)) bad(`fixture id ${f?.id} is missing or duplicated`);
		ids.add(f?.id);
		if (f?.class !== 'normal' && f?.class !== 'negative') bad(`${f?.id}: class must be normal or negative`);
		if (!INPUT_KINDS.includes(f?.input_kind)) bad(`${f?.id}: input_kind must be one of ${INPUT_KINDS.join('/')}`);
		if (f?.profile !== null && !profileIds.has(f?.profile)) bad(`${f?.id}: profile must be null or the id of a listed profile`);
		if (typeof f?.origin !== 'string' || f.origin === '') bad(`${f?.id}: origin is missing`);
		if (!paths.has(f?.call?.module) || (typeof f?.call?.fn === 'string') === (typeof f?.call?.export === 'string')) bad(`${f?.id}: call must name a pinned module and exactly one of fn and export`);
		const refs = callRefs(f?.call);
		const upstream = refs.modules.filter((m) => typeof m === 'string' && (m.startsWith('scanners/') || m === STATIC_RUNNER));
		if ((f?.input_kind === 'upstream-real') !== (upstream.length > 0)) bad(`${f?.id}: input_kind ${f?.input_kind} does not match the modules the call reaches (an upstream-real call reaches a scanner module or the python-scope static runner, a hand-fed call reaches neither)`);
		for (const module of refs.modules) if (!paths.has(module)) bad(`${f?.id}: module ${module} is not a pinned file`);
		for (const ref of refs.files) if (!paths.has(ref)) bad(`${f?.id}: $file ${ref} is not a pinned file`);
		for (const dir of refs.dirs) if (![...paths].some((p) => p.startsWith(`${dir}/`))) bad(`${f?.id}: $path ${dir} holds no pinned file`);
		const pairs = Array.isArray(f?.expect) ? f.expect : [];
		if (pairs.length === 0 || !pairs.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && (e[0] === '' || e[0].startsWith('/')))) bad(`${f?.id}: expect needs [json-pointer, value] pairs`);
		if (!SHA256.test(f?.output_sha256 ?? '')) bad(`${f?.id}: output_sha256 must be a 64-hex digest`);
	}
	for (const cls of ['normal', 'negative']) {
		if (!(r?.fixtures ?? []).some((f) => f.class === cls)) bad(`needs at least one ${cls} fixture`);
	}
	// Every profile is exercised: an implemented (candidate) profile by a normal fixture, a blocked profile by a negative one and by no normal one,
	// and a marker that says "needs a leaf re-run" is backed by a fixture whose input came out of the in-repo upstream analyzer.
	for (const p of r?.profiles ?? []) {
		const own = (r?.fixtures ?? []).filter((f) => f.profile === p.id);
		if (p.state === 'candidate' && !own.some((f) => f.class === 'normal')) bad(`profile ${p.id}: a candidate profile needs a normal fixture`);
		if (p.state === 'blocked-upstream-fact-gap' && (own.some((f) => f.class === 'normal') || !own.some((f) => f.class === 'negative'))) bad(`profile ${p.id}: a blocked profile is shown by negative fixtures only, and by at least one`);
		if (p.real_repo_comparison?.kind === 'history-needs-leaf-rerun' && !own.some((f) => f.input_kind === 'upstream-real')) bad(`profile ${p.id}: a marker that needs a leaf re-run needs an upstream-real fixture`);
	}
	for (const pair of r?.equal_outputs ?? []) {
		const [a, b] = Array.isArray(pair) ? pair.map((id) => (r.fixtures ?? []).find((f) => f.id === id)) : [];
		if (!a || !b || a === b) bad(`equal_outputs: ${JSON.stringify(pair)} must name two different fixtures`);
		else if (a.output_sha256 !== b.output_sha256) bad(`equal_outputs: ${a.id} and ${b.id} have different output hashes`);
	}
	if (!Array.isArray(r?.equal_outputs) || r.equal_outputs.length === 0) bad('equal_outputs must name at least one pair of fixtures whose outputs are equal');
	if (r?.artifact_digest?.value !== artifactDigest(r)) bad('artifact_digest does not match the record (it covers every field except its own value)');
	if (!Array.isArray(r?.limits) || r.limits.length === 0) bad('limits must record the remaining limits');
	const limitIds = new Set();
	for (const l of r?.limits ?? []) {
		if (typeof l.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(l.id) || limitIds.has(l.id)) bad(`limit ${l.id}: id must be a unique kebab-case string`);
		limitIds.add(l.id);
		if (!LIMIT_STATUSES.includes(l.status)) bad(`limit ${l.id}: status ${l.status} is not one of ${LIMIT_STATUSES.join('/')}`);
		if (typeof l.statement !== 'string' || l.statement.trim() === '') bad(`limit ${l.id}: statement is empty`);
		for (const id of l.fixtures ?? []) if (!ids.has(id)) bad(`limit ${l.id}: unknown fixture ${id}`);
		if (l.references !== undefined && (typeof l.references.pattern !== 'string' || l.references.pattern === '' || !Array.isArray(l.references.paths) || !l.references.paths.every((p) => typeof p === 'string'))) bad(`limit ${l.id}: references needs a pattern and a list of paths (the list may be empty)`);
		for (const e of l.evidence ?? []) {
			if (!paths.has(e?.path) || typeof e.pattern !== 'string' || e.pattern === '' || !isCount(e.matches)) bad(`limit ${l.id}: evidence needs a pinned path, a pattern and a count of matches`);
		}
		for (const t of l.trees ?? []) {
			if (typeof t?.path !== 'string' || t.path === '' || t.path.startsWith('/') || !SHA1.test(t.git_tree_id ?? '')) bad(`limit ${l.id}: trees needs a repo-relative path and a 40-hex tree id`);
		}
	}
	const v = r?.verification;
	if (typeof v?.recomputed !== 'string' || v.recomputed === '' || !Array.isArray(v.levels) || v.levels.length === 0 || !Array.isArray(v.not_recomputed) || v.not_recomputed.length === 0 || ![...v.levels, ...v.not_recomputed].every((s) => typeof s === 'string' && s !== '')) bad('verification needs a recomputed text and non-empty levels and not_recomputed lists of strings');
	for (const o of r?.ci_observations ?? []) if (o.head_sha !== r.base_commit) bad(`ci run ${o.run_id}: head_sha is not the base commit`);
	if (BY_NUMBER.test(JSON.stringify(r ?? null).replaceAll(/"(?:sha256|git_blob_sha1|output_sha256|base_commit|base_tree|head_sha|ref|git_tree_id|value)":"[0-9a-f]+"/g, ''))) bad('the record pins by commit sha: no pull request or issue number may appear in it');
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
// `fresh` means every file agrees and the track directories hold no unrecorded file other than the record, markdown
// documents and the files this item adds (TRACK.ownFiles).
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
// The object id (blob or tree) that a path has in the tree of a commit.
export const blobAtCommit = (root, commit, rel) => {
	const res = git(root, ['rev-parse', `${commit}:${rel}`]);
	return res.status === 0 ? res.stdout.trim() : null;
};
export const isAncestor = (root, commit) => git(root, ['merge-base', '--is-ancestor', commit, 'HEAD']).status === 0;
export const listAtCommit = (root, commit, dir) => {
	const res = git(root, ['ls-tree', '-r', '--full-name', '--name-only', commit, '--', dir]);
	return res.status === 0 ? res.stdout.split('\n').filter(Boolean).sort() : null;
};

// Files outside the excluded directories that mention `pattern` (git grep -l -E) in the tree of the pinned commit.
export const referencesAtCommit = (root, commit, pattern, excluded) => {
	const res = git(root, ['grep', '-l', '-E', pattern, commit, '--', '.', ...excluded.map((d) => `:!${d}`)]);
	if (res.status !== 0 && res.status !== 1) throw new Error(`git grep failed: ${res.stderr}`);
	return res.stdout.split('\n').filter(Boolean).map((line) => line.slice(commit.length + 1)).sort();
};

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
// literal. A specifier that is built at run time is not seen, and a line that starts with // , /* or * is a comment line and is
// skipped (the scanners of this repository quote the code they look for, for example require('express'), in their comments).
const IMPORT_FORMS = /^[ \t]*(?:import|export)\b[\w$*\s,{}]*?\bfrom\s*(['"])([^'"\n]+)\1|^[ \t]*import\s*(['"])([^'"\n]+)\3|\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\5\s*\)/gm;
const withoutCommentLines = (source) => source.split('\n').filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n');
export const importedPackages = (source) => [...new Set([...withoutCommentLines(source).matchAll(IMPORT_FORMS)].map((m) => packageOf(m[2] ?? m[4] ?? m[6])).filter(Boolean))].sort();
// Analysis input is read as text and never loaded as code: a script below a fixtures directory is not scanned for imports.
const FIXTURE_DATA = /(^|\/)fixtures\//;

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

// A copy of the base commit runs against the node_modules of this checkout. That is evidence for the base commit only while
// every package the copy can load is installed at the version the base commit's package-lock.json states; otherwise the
// copy is not linked and the caller fails. A missing node_modules fails loudly too. Returns the checked versions.
export function linkModules(root, dest, paths) {
	const modules = path.join(root, 'node_modules');
	if (!fs.existsSync(modules)) throw new Error(`${modules} does not exist; run npm ci first`);
	const texts = paths.filter((p) => SCRIPT.test(p) && !FIXTURE_DATA.test(p)).map((p) => ({ path: p, text: fs.readFileSync(path.join(dest, p), 'utf8') }));
	const { versions, problems } = lockedVersions(JSON.parse(fs.readFileSync(path.join(dest, 'package-lock.json'), 'utf8')), texts);
	problems.push(...installedProblems(versions, modules));
	if (problems.length > 0) throw new Error(`node_modules of this checkout is not the dependency set of the base commit: ${problems.join('; ')}`);
	fs.symlinkSync(modules, path.join(dest, 'node_modules'), 'dir');
	return versions;
}

// Text evidence of a limit: the number of matches of `pattern` in the text of a pinned file. A statement such as "this
// profile pins no framework version" or "no module of the layer names that package" is recomputed from the file itself.
export function evidenceProblems(record, read) {
	const problems = [];
	for (const l of record.limits ?? []) {
		for (const e of l.evidence ?? []) {
			const buf = read(e.path);
			if (!Buffer.isBuffer(buf)) {
				problems.push(`limit ${l.id}: cannot read ${e.path}`);
				continue;
			}
			const count = [...buf.toString('utf8').matchAll(new RegExp(e.pattern, 'g'))].length;
			if (count !== e.matches) problems.push(`limit ${l.id}: ${e.path} has ${count} matches of /${e.pattern}/, recorded ${e.matches}`);
		}
	}
	return problems;
}

// Tree ids of the directories that tests read by name (python-scope/verify.mjs lists scanners/ and adapters/ to see whether an
// adapter for a scope-only framework has appeared). They are pinned by git tree id, which only the pinned commit can answer.
export function treeIdProblems(record, root, commit) {
	const problems = [];
	for (const l of record.limits ?? []) {
		for (const t of l.trees ?? []) {
			const actual = blobAtCommit(root, commit, t.path);
			if (actual !== t.git_tree_id) problems.push(`limit ${l.id}: ${t.path} is tree ${actual} at ${commit}, recorded ${t.git_tree_id}`);
		}
	}
	return problems;
}

// What a profile says about itself, flattened into the row that the record keeps. The row of the record equals this value
// (the live export is the authority); judgments the record adds are the marker kind and the framework-version status.
export function profileRow(moduleRel, exportName, profile) {
	const unknownVersion = profile.versionPin?.framework === null;
	return {
		id: profile.id,
		module: moduleRel,
		export: exportName,
		title: profile.title,
		state: profile.state,
		upstream_owner: profile.upstreamOwner,
		upstream_contracts: [...profile.upstreamContracts],
		forced: { registration: profile.registration, production_default: profile.productionDefault, runtime_tested: profile.runtimeTested, t19_review: profile.t19Review },
		version_pin: JSON.parse(JSON.stringify(profile.versionPin)),
		framework_version: unknownVersion ? { status: 'UNKNOWN', value: null } : { status: 'DECLARED', value: profile.versionPin.framework },
		real_repo_comparison: { marker: profile.realRepoComparison, kind: MARKER_KINDS[profile.realRepoComparison] ?? 'UNCLASSIFIED' },
		supported_syntax: [...(profile.supportedSyntax ?? [])],
		unknown_conditions: [...(profile.unknownConditions ?? [])]
	};
}

// The rows of the record against the live exports of the modules they name; a leaf module that has no row, or a row whose
// module or export is gone, is a problem.
export async function liveProfileRows(record, root) {
	const rows = [];
	for (const p of record.profiles) {
		let mod;
		try {
			mod = await import(pathToFileURL(path.join(root, p.module)).href);
		} catch (error) {
			rows.push({ error: `${p.module} cannot be imported (${error.code ?? error.message})` });
			continue;
		}
		rows.push(mod[p.export] ? profileRow(p.module, p.export, mod[p.export]) : { error: `${p.module} has no export ${p.export}` });
	}
	return rows;
}

export function profileProblems(record, root, live) {
	const problems = [];
	const named = new Set(record.profiles.map((p) => p.module));
	for (const mod of leafModules(root)) if (!named.has(mod)) problems.push(`${mod} is a leaf module of the layer and has no profile row`);
	record.profiles.forEach((p, i) => {
		if (live[i]?.error) return problems.push(`${p.id}: ${live[i].error}`);
		const mine = JSON.stringify(canonical(p));
		if (mine !== JSON.stringify(canonical(live[i]))) problems.push(`${p.id}: the row differs from the live profile (${Object.keys(p).filter((k) => canonical(p[k]) !== canonical(live[i][k])).join(', ')})`);
	});
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

// Fixture calls: { module, fn | export, args, chain }. `fn` calls the named function with `args`; `export` reads the named export
// as it is. An argument may be { $file: <pinned path> } (the file text), { $path: <pinned directory or file> } (its absolute
// path under the root that is being replayed), { $call: <call> } (a nested call; with $get the named property of its
// result) or { $map: [[key, value], ...] } (a Map). Maps and Sets in the output are normalised, errors are recorded as
// { threw }. A call that cannot be set up (a module, function or export that does not exist) is a FixtureSetupError, which
// the replay reports whatever the record expects.
const setupError = (message) => Object.assign(new Error(message), { fixtureSetup: true });

async function evalArg(arg, ctx) {
	if (Array.isArray(arg)) {
		const out = [];
		for (const a of arg) out.push(await evalArg(a, ctx));
		return out;
	}
	if (arg && typeof arg === 'object') {
		if ('$file' in arg) return ctx.readText(arg.$file);
		if ('$path' in arg) return ctx.absolute(arg.$path);
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

export async function evalCall(spec, ctx) {
	let mod;
	try {
		mod = await ctx.load(spec.module);
	} catch (error) {
		throw setupError(`cannot load ${spec.module} (${error.code ?? error.name})`);
	}
	let value;
	if (typeof spec.export === 'string') {
		if (!(spec.export in mod)) throw setupError(`${spec.module} has no export ${spec.export}`);
		value = mod[spec.export];
	} else {
		if (typeof mod[spec.fn] !== 'function') throw setupError(`${spec.module} has no function ${spec.fn}`);
		value = await mod[spec.fn](...(await evalArg(spec.args ?? [], ctx)));
	}
	for (const step of spec.chain ?? []) {
		if (typeof value?.[step.method] !== 'function') throw setupError(`the result of ${spec.module} has no method ${step.method}`);
		value = await value[step.method](...(await evalArg(step.args ?? [], ctx)));
	}
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

export const fixtureContext = (root) => ({
	readText: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
	absolute: (rel) => path.join(root, rel),
	load: (rel) => import(pathToFileURL(path.join(root, rel)).href)
});

export async function runFixture(f, ctx) {
	try {
		return normalize(await evalCall(f.call, ctx));
	} catch (error) {
		return { threw: { name: error.fixtureSetup ? 'FixtureSetupError' : error.name, message: error.message } };
	}
}

export async function replay(record, root) {
	const ctx = fixtureContext(root);
	const out = [];
	for (const f of record.fixtures) {
		const first = await runFixture(f, ctx);
		const again = await runFixture(f, ctx);
		out.push({ id: f.id, deterministic: canonical(first) === canonical(again), output_sha256: sha256(canonical(first)), observed: f.expect.map(([pointer]) => pointerGet(first, pointer)), setup_error: first.threw?.name === 'FixtureSetupError' ? first.threw.message : null, output: first });
	}
	return out;
}

export function replayProblems(record, computed) {
	const problems = [];
	if (computed.length !== record.fixtures.length) problems.push(`replayed ${computed.length} fixtures, record has ${record.fixtures.length}`);
	record.fixtures.forEach((f, i) => {
		const c = computed[i];
		if (!c || c.id !== f.id) return problems.push(`${f.id}: not replayed`);
		if (c.setup_error) problems.push(`${f.id}: the call cannot be set up: ${c.setup_error}`);
		if (!c.deterministic) problems.push(`${f.id}: two runs differ`);
		if (c.output_sha256 !== f.output_sha256) problems.push(`${f.id}: output sha256 ${c.output_sha256} != recorded ${f.output_sha256}`);
		f.expect.forEach(([pointer, want], j) => {
			if (canonical(c.observed[j]) !== canonical(want)) problems.push(`${f.id}: ${pointer} is ${canonical(c.observed[j])}, recorded ${canonical(want)}`);
		});
	});
	for (const [a, b] of record.equal_outputs ?? []) {
		const [x, y] = [a, b].map((id) => computed.find((c) => c.id === id));
		if (!x || !y || x.output_sha256 !== y.output_sha256) problems.push(`equal_outputs: ${a} and ${b} do not give the same output when replayed`);
	}
	return problems;
}

export const sealRecord = (record) => ({ ...record, artifact_digest: { ...record.artifact_digest, value: artifactDigest(record) } });

const LEAF_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const SUPPORT_KEYS = ['supported', 'support', 'capability', 'capabilities'];
const keysOf = (value, out = new Set()) => {
	if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
	else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) keysOf(v, out.add(k));
	return out;
};

// Invariants that every replayed output of a leaf module keeps whatever the input: a leaf-shaped output is unregistered, not a
// production default and never marked supported (its status is candidate or blocked; a blocked output has no route), every route
// carries one of the seven explicit methods, an absolute path, a provenance and no operationId, every unknown carries a code, and
// the status follows the state of the profile the fixture names. A normal fixture never throws and a negative fixture that throws
// throws a TypeError (the contract refusal), never another error. A fixture that calls the shared helper module directly is not
// held to the shape invariants (it shows what the helper does not check, see the limit projection-does-not-validate-routes), but
// it is held to the throw rule.
export function outputProblems(record, computed) {
	const problems = [];
	record.fixtures.forEach((f, i) => {
		const output = computed[i]?.output;
		const bad = (message) => problems.push(`${f.id}: ${message}`);
		if (output?.threw) {
			if (f.class === 'normal') bad(`a normal fixture must not throw (${output.threw.name}: ${output.threw.message})`);
			else if (output.threw.name !== 'TypeError') bad(`a refusal must be a TypeError, not ${output.threw.name}`);
			return;
		}
		if (output?.contract !== LEAF_CONTRACT || f.call.module === SHARED_MODULE) return;
		if (output.registration !== 'unregistered' || output.productionDefault !== false) bad('registration must be unregistered and productionDefault false');
		if (!['candidate', 'blocked'].includes(output.status)) bad(`status ${JSON.stringify(output.status)} is not candidate or blocked`);
		const profile = record.profiles.find((p) => p.id === f.profile);
		if (profile && output.status !== (profile.state === 'candidate' ? 'candidate' : 'blocked')) bad(`status ${output.status} does not follow the state ${profile.state} of profile ${profile.id}`);
		if (output.status === 'blocked' && !(Array.isArray(output.routes) && output.routes.length === 0)) bad('a blocked output must have no route');
		for (const [j, route] of (Array.isArray(output.routes) ? output.routes : []).entries()) {
			if (!LEAF_METHODS.includes(route?.method)) bad(`route ${j}: method ${JSON.stringify(route?.method)} is not one of the explicit methods`);
			if (typeof route?.path !== 'string' || !route.path.startsWith('/')) bad(`route ${j}: path is not an absolute path`);
			if (typeof route?.provenance !== 'string' || route.provenance === '') bad(`route ${j}: provenance is missing`);
			if (route && Object.hasOwn(route, 'operationId')) bad(`route ${j}: carries an operationId`);
		}
		for (const [j, unknown] of (Array.isArray(output.unknowns) ? output.unknowns : []).entries()) if (typeof unknown?.code !== 'string' || unknown.code === '') bad(`unknown ${j}: code is missing`);
		for (const key of SUPPORT_KEYS) if (keysOf(output).has(key)) bad(`the output has a key named ${key}; a leaf output never marks anything supported`);
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
