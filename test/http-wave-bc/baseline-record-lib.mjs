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
	item: 'T13-01',
	suiteId: 'T13',
	recordFile: 'adapters/http-wave-bc/BASELINE.json',
	sourceDir: 'adapters/http-wave-bc',
	testDir: 'test/http-wave-bc',
	docs: { readme: 'README.md' },
	ownFiles: [
		'test/http-wave-bc/baseline-record.test.mjs',
		'test/http-wave-bc/baseline-record-lib.mjs',
		'test/http-wave-bc/interface-rfc.test.mjs',
		'test/http-wave-bc/interface-rfc.vocabulary.json',
		'test/http-wave-bc/interface-rfc-evidence.test.mjs',
		'test/http-wave-bc/interface-rfc-evidence.mjs',
		'test/http-wave-bc/interface-rfc-evidence.json'
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
const BY_NUMBER = /#\d|\bPR\s*\d|\/pull\/\d/;
const SCRIPT = /\.(mjs|cjs|js)$/;
// What a fixture shows. `defect` marks behaviour that is recorded but is not correct (see the limits that name it).
export const CATEGORIES = ['upstream-example', 'descriptor', 'not-detected', 'dynamic-route-factory', 'generated-routes', 'withheld-form', 'catalog-validation', 'profile-evidence'];
export const DEFECTS = ['silent-drop', 'incomplete-path', 'scope-insensitive', 'undetected-router'];
// A limit or verification sentence that states a universal needs its scope written out and a test for that sentence.
export const UNIVERSAL = /\b(all|every|never|always|complete|completely|entire|entirely|bounded|recomputes?|guarantees?|none|nothing)\b/i;

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

// A missing or unparsable record must not stop the test file from loading: the first test reports it.
export function tryReadRecord(root = REPO_ROOT) {
	try {
		return { record: readRecord(root) };
	} catch (error) {
		return { error: `${TRACK.recordFile}: ${error.message}` };
	}
}
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

// A pinned file that this change itself edits keeps its base digests (the pinned commit is judged against them) and states the
// digests of the edited file in live_after_change (the live tree is judged against those).
export const effectiveEntry = (entry) => (entry?.live_after_change ? { ...entry, ...entry.live_after_change } : entry);

// The command that is recorded for a file list is exactly the command that gets run.
const ofRole = (r, ...roles) => (Array.isArray(r?.files) ? r.files : []).filter((f) => roles.includes(f?.role));

function walk(value, trail, visit) {
	visit(value, trail);
	if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${trail}[${i}]`, visit));
	else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${trail}.${k}`, visit);
}

// `$file` and `$path` name pinned files (a `$path` may also name a directory of pinned files); `$tree` is an inline tree.
function fileRefs(value) {
	const refs = { file: [], path: [], tree: [] };
	walk(value, '', (v) => {
		if (!v || typeof v !== 'object' || Array.isArray(v)) return;
		if (typeof v.$file === 'string') refs.file.push(v.$file);
		if (typeof v.$path === 'string') refs.path.push(v.$path);
		if ('$tree' in v) refs.tree.push(v.$tree);
	});
	return refs;
}

const NORMAL_ONLY = ['upstream-example', 'descriptor', 'profile-evidence'];
const NEGATIVE_ONLY = ['not-detected', 'dynamic-route-factory', 'generated-routes', 'withheld-form'];
const COVERED = ['upstream-example', 'descriptor', 'not-detected', 'dynamic-route-factory', 'generated-routes'];

const integersIn = (value) => {
	const found = new Set();
	walk(value, '', (v) => {
		if (Number.isInteger(v)) found.add(v);
	});
	return found;
};

// Every integer that a limit statement states (a bare number, not part of a name, date or contract id) must equal some value of
// the limit's facts, which the tests derive again. An integer that no fact states is reported; an integer that equals a
// different value of the facts is not told apart from the right one.
export function statementProblems(limit) {
	const facts = integersIn(limit?.facts);
	const stated = [...String(limit?.statement ?? '').matchAll(/(?<![\w./@:-])(\d+)(?![\w./@:-])/g)].map((m) => Number(m[1]));
	return stated.filter((n) => !facts.has(n)).map((n) => `limit ${limit?.id}: the statement says ${n} but no fact of the limit has that value`);
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
		if (f?.live_after_change !== undefined) {
			const l = f.live_after_change;
			if (!l || typeof l !== 'object' || Object.keys(l).sort().join() !== [...DIGEST_KEYS].sort().join() || !isCount(l.bytes) || !SHA1.test(l.git_blob_sha1 ?? '') || !SHA256.test(l.sha256 ?? '')) bad(`${where}: live_after_change needs ${DIGEST_KEYS.join('/')} and nothing else`);
			else if (DIGEST_KEYS.every((k) => l[k] === f[k])) bad(`${where}: live_after_change equals the base digests`);
			if (f.role === 'runner') bad(`${where}: the runner is judged by the pinned commit only, so it carries no live_after_change`);
		}
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
	const targetIds = new Set();
	for (const t of r?.targets ?? []) {
		if (typeof t?.id !== 'string' || t.id === '' || targetIds.has(t.id)) bad(`target ${t?.id} is missing or duplicated`);
		targetIds.add(t?.id);
		if (t?.leaf !== null && !paths.has(t?.leaf)) bad(`target ${t?.id}: leaf must be null or a pinned file`);
		const pinned = t?.leaf !== null && t?.framework_pin !== null;
		if (t?.record_status !== (pinned ? 'PINNED' : 'NOT_RECORDED')) bad(`target ${t?.id}: record_status must be ${pinned ? 'PINNED' : 'NOT_RECORDED'}`);
		if (t?.support_status !== (t?.leaf === null ? 'UNSUPPORTED' : 'EXPERIMENTAL_SYNTHETIC_ONLY')) bad(`target ${t?.id}: support_status does not follow from leaf`);
		if (t?.framework_pin !== null && !SHA1.test(t?.framework_pin?.commit ?? '')) bad(`target ${t?.id}: framework_pin.commit must be a 40-hex commit id`);
		if (t?.scope_record !== null && !paths.has(t?.scope_record)) bad(`target ${t?.id}: scope_record must be null or a pinned file`);
	}
	if (targetIds.size === 0) bad('targets must record the catalog targets');
	const ids = new Set();
	for (const f of r?.fixtures ?? []) {
		if (typeof f?.id !== 'string' || f.id === '' || ids.has(f.id)) bad(`fixture id ${f?.id} is missing or duplicated`);
		ids.add(f?.id);
		if (f?.class !== 'normal' && f?.class !== 'negative') bad(`${f?.id}: class must be normal or negative`);
		if (typeof f?.origin !== 'string' || f.origin === '') bad(`${f?.id}: origin is missing`);
		if (!paths.has(f?.call?.module) || typeof f?.call?.fn !== 'string') bad(`${f?.id}: call must name a pinned module and a function`);
		for (const nested of f?.call && typeof f.call === 'object' ? callModules(f.call) : []) if (!paths.has(nested)) bad(`${f?.id}: call module ${nested} is not a pinned file`);
		const refs = fileRefs(f?.call);
		for (const ref of refs.file) if (!paths.has(ref)) bad(`${f?.id}: $file ${ref} is not a pinned file`);
		for (const ref of refs.path) if (!paths.has(ref) && ![...paths].some((p) => p.startsWith(`${ref.replace(/\/$/, '')}/`))) bad(`${f?.id}: $path ${ref} is neither a pinned file nor a directory of pinned files`);
		for (const tree of refs.tree) {
			const entries = tree && typeof tree === 'object' && !Array.isArray(tree) ? Object.entries(tree) : [];
			if (entries.length === 0 || !entries.every(([rel, text]) => typeof text === 'string' && rel !== '' && !rel.startsWith('/') && !rel.split('/').includes('..'))) bad(`${f?.id}: $tree needs a non-empty map of relative paths to text`);
		}
		if (refs.tree.length > 0 ? f?.origin !== AUTHORED : f?.origin === AUTHORED) bad(`${f?.id}: an inline $tree is origin "${AUTHORED}" and a pinned input is not`);
		if (!CATEGORIES.includes(f?.category)) bad(`${f?.id}: category must be one of ${CATEGORIES.join('/')}`);
		const catalogLevel = ['catalog-validation', 'profile-evidence'].includes(f?.category);
		if (f?.target === null ? !catalogLevel : catalogLevel || !targetIds.has(f?.target)) bad(`${f?.id}: target must be a catalog target id for a leaf fixture and null for a catalog or profile-evidence fixture`);
		if (NORMAL_ONLY.includes(f?.category) && f.class !== 'normal') bad(`${f?.id}: a ${f.category} fixture is normal`);
		if (NEGATIVE_ONLY.includes(f?.category) && f.class !== 'negative') bad(`${f?.id}: a ${f.category} fixture is negative`);
		if (f?.defect !== undefined && (!DEFECTS.includes(f.defect) || f.class !== 'negative')) bad(`${f?.id}: defect must be a negative fixture flagged with one of ${DEFECTS.join('/')}`);
		const pairs = Array.isArray(f?.expect) ? f.expect : [];
		if (pairs.length === 0 || !pairs.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && (e[0] === '' || e[0].startsWith('/')))) bad(`${f?.id}: expect needs [json-pointer, value] pairs`);
		if (!SHA256.test(f?.output_sha256 ?? '')) bad(`${f?.id}: output_sha256 must be a 64-hex digest`);
	}
	for (const cls of ['normal', 'negative']) {
		if (!(r?.fixtures ?? []).some((f) => f.class === cls)) bad(`needs at least one ${cls} fixture`);
	}
	for (const t of (r?.targets ?? []).filter((x) => x?.leaf)) {
		for (const cat of COVERED) {
			if (!(r?.fixtures ?? []).some((f) => f.target === t.id && f.category === cat)) bad(`${t.id}: needs a ${cat} fixture`);
		}
	}
	for (const d of DEFECTS) {
		const flagged = (r?.fixtures ?? []).filter((f) => f.defect === d).map((f) => f.id).sort();
		const limit = (r?.limits ?? []).find((l) => l.id === d);
		if (flagged.length > 0 && !limit) bad(`fixtures flag the defect ${d} but no limit ${d} exists`);
		if (limit && JSON.stringify([...(limit.fixtures ?? [])].sort()) !== JSON.stringify(flagged)) bad(`limit ${d}: fixtures must be exactly the fixtures that flag the defect`);
	}
	const verification = r?.verification;
	if (typeof verification?.recomputed !== 'string' || verification.recomputed.trim() === '' || !Array.isArray(verification?.levels) || verification.levels.length === 0 || !Array.isArray(verification?.not_recomputed) || verification.not_recomputed.length === 0) bad('verification needs recomputed (text), levels and not_recomputed');
	else if (UNIVERSAL.test([verification.recomputed, ...verification.levels, ...verification.not_recomputed].join('\n'))) bad('verification uses a universal word; write the scope out');
	if (r?.artifact_digest?.value !== artifactDigest(r)) bad('artifact_digest does not match the record (it covers every field except its own value)');
	if (!Array.isArray(r?.limits) || r.limits.length === 0) bad('limits must record the remaining limits');
	for (const l of r?.limits ?? []) {
		if (!LIMIT_STATUSES.includes(l.status)) bad(`limit ${l.id}: status ${l.status} is not one of ${LIMIT_STATUSES.join('/')}`);
		if (typeof l.statement !== 'string' || l.statement.trim() === '') bad(`limit ${l.id}: statement is empty`);
		if (!l.facts || typeof l.facts !== 'object' || Array.isArray(l.facts) || Object.keys(l.facts).length === 0) bad(`limit ${l.id}: facts must be a non-empty object that the tests recompute`);
		else problems.push(...statementProblems(l));
		if (UNIVERSAL.test(l.statement ?? '')) bad(`limit ${l.id}: the statement uses the universal word "${l.statement.match(UNIVERSAL)[0]}"; write the scope out`);
		for (const id of l.fixtures ?? []) if (!ids.has(id)) bad(`limit ${l.id}: unknown fixture ${id}`);
		if (l.references !== undefined && (typeof l.references.pattern !== 'string' || l.references.pattern === '' || !Array.isArray(l.references.paths) || l.references.paths.length === 0 || !l.references.paths.every((p) => typeof p === 'string'))) bad(`limit ${l.id}: references needs a pattern and a non-empty list of paths`);
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
	if (BY_NUMBER.test(JSON.stringify([r?.limits, r?.ci_observations, r?.pins, r?.targets, (r?.fixtures ?? []).map((f) => f.origin)]))) bad('limits, ci_observations, pins, targets and origins must pin by commit sha, not by PR or issue number');
	if (reading) {
		const pinned = ofRole(r, 'source', 'test', 'test_support', 'external_dependency', ...(reading.includeRunner ? ['runner'] : []));
		problems.push(...recomputeProblems(reading.live ? pinned.map(effectiveEntry) : pinned, reading.read, reading.label ?? 'recompute'));
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
	const states = ofRole(record, 'source', 'test', 'test_support', 'external_dependency').map((e) => ({ path: e.path, ...classifyEntry(effectiveEntry(e), read(e.path)) }));
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
// literal. A specifier that is built at run time is not seen.
const IMPORT_FORMS = /^[ \t]*(?:import|export)\b[\w$*\s,{}]*?\bfrom\s*(['"])([^'"\n]+)\1|^[ \t]*import\s*(['"])([^'"\n]+)\3|\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\5\s*\)/gm;
// A match that sits inside a string literal on its line (a fixture source such as "const app = require('koa')") is text, not an import.
function insideString(source, index) {
	let quote = null;
	for (let i = source.lastIndexOf('\n', index - 1) + 1; i < index; i += 1) {
		const c = source[i];
		if (quote === null) quote = c === "'" || c === '"' || c === '`' ? c : null;
		else if (c === '\\') i += 1;
		else if (c === quote) quote = null;
	}
	return quote !== null;
}
export const importedPackages = (source) => [...new Set([...source.matchAll(IMPORT_FORMS)].filter((m) => !insideString(source, m.index)).map((m) => packageOf(m[2] ?? m[4] ?? m[6])).filter(Boolean))].sort();

// The Node built-in modules a text imports (the same scan, without the node: prefix).
export const builtinsImported = (source) => [...new Set([...source.matchAll(IMPORT_FORMS)].filter((m) => !insideString(source, m.index)).map((m) => (m[2] ?? m[4] ?? m[6]).replace(/^node:/, '')).filter((s) => builtinModules.includes(s)))].sort();

// Every specifier the same scan sees, relative paths and Node built-ins included, sorted and without duplicates. A specifier
// that is built at run time is not seen, and a text inside a comment that looks like an import() call is.
export const specifiersOf = (source) => [...new Set([...source.matchAll(IMPORT_FORMS)].filter((m) => !insideString(source, m.index)).map((m) => m[2] ?? m[4] ?? m[6]))].sort();

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

// The pinned modules import ajv (contracts/completeness.mjs -> lib/schema-validate.mjs), so a copy of the base commit runs
// against the node_modules of this checkout. That is evidence for the base commit only while every package the copy can
// load is installed at the version the base commit's package-lock.json states; otherwise the copy is not linked and the
// caller fails. A missing node_modules fails loudly too. Returns the checked versions.
export function linkModules(root, dest, paths) {
	const modules = path.join(root, 'node_modules');
	if (!fs.existsSync(modules)) throw new Error(`${modules} does not exist; run npm ci first`);
	// Fixture scripts (the framework oracles under fixtures/) are pinned data that the record never runs, so what they import
	// is not part of the dependency set the pinned tests load.
	const texts = paths.filter((p) => SCRIPT.test(p) && !p.split('/').includes('fixtures')).map((p) => ({ path: p, text: fs.readFileSync(path.join(dest, p), 'utf8') }));
	const { versions, problems } = lockedVersions(JSON.parse(fs.readFileSync(path.join(dest, 'package-lock.json'), 'utf8')), texts);
	problems.push(...installedProblems(versions, modules));
	if (problems.length > 0) throw new Error(`node_modules of this checkout is not the dependency set of the base commit: ${problems.join('; ')}`);
	fs.symlinkSync(modules, path.join(dest, 'node_modules'), 'dir');
	return versions;
}

// The documents describe the pinned base commit. Four things are compared with the record: the table holds one row per test
// file and every row equals the pinned per-file count (all rows are compared, so a second row for a file is reported on
// whichever side of the right row it stands), each "<n> tests" and "<n> test files" equals the recorded total, each
// "NESTED_SUITE ... RUN <n> files" equals the recorded first runner line, and each document names the base commit. Other
// sentences and numbers are not compared.
export function docProblems(record, docs) {
	const problems = [];
	const command = (id) => (record.commands ?? []).find((c) => c.id === id);
	const total = command('direct-tap')?.result?.tests;
	const rows = [...(docs.readme ?? '').matchAll(/^\| `([^`]+\.test\.mjs)` \| (\d+) \|/gm)].map((m) => [m[1], Number(m[2])]);
	const stated = (name) => rows.filter(([row]) => row === name).map(([, count]) => count);
	for (const f of ofRole(record, 'test')) {
		const name = path.posix.basename(f.path);
		const counts = stated(name);
		for (const count of counts.length > 0 ? counts : [undefined]) if (count !== f.test_count) problems.push(`README table: ${name} states ${count}, recorded ${f.test_count}`);
		if (counts.length > 1) problems.push(`README table: ${name} has ${counts.length} rows, the table holds one row per test file`);
	}
	const recordedNames = new Set(ofRole(record, 'test').map((f) => path.posix.basename(f.path)));
	for (const name of new Set(rows.map(([row]) => row))) if (!recordedNames.has(name)) problems.push(`README table: ${name} is not a recorded test file`);
	for (const [name, text] of Object.entries(docs)) {
		if (!text.includes(record.base_commit)) problems.push(`${name}: does not name the base commit ${record.base_commit}`);
		for (const m of text.matchAll(/(?<![\w.])\*{0,2}(\d+)\*{0,2} tests\b/g)) if (Number(m[1]) !== total) problems.push(`${name}: "${m[0]}" but the recorded total is ${total}`);
		for (const m of text.matchAll(/(?<![\w.])\*{0,2}(\d+)\*{0,2} test files\b/g)) if (Number(m[1]) !== ofRole(record, 'test').length) problems.push(`${name}: "${m[0]}" but the record pins ${ofRole(record, 'test').length} test files`);
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

// Fixture calls: { module, fn, args, chain }. `fn` may be a dotted path into the module ("adapter.scan" calls scan with
// this = adapter); without `args` a member that is not a function is returned as it is (a constant, or a member of a parsed
// .json file). An argument may be { $file: <pinned path> } (the file text), { $path: <pinned path or directory> } (its
// location under the replay root), { $tree: { <relative path>: <text>, ... } } (a fresh temporary directory that holds exactly
// those files), { $call: <call> } (a nested call; with $get the named property of its result) or { $map: [[key, value], ...] }
// (a Map). Maps and Sets in the output are normalised, errors are recorded as { threw }, and the temporary directories and the
// replay root are scrubbed from the output, so a hash does not depend on where the replay ran.
async function evalArg(arg, ctx) {
	if (Array.isArray(arg)) {
		const out = [];
		for (const a of arg) out.push(await evalArg(a, ctx));
		return out;
	}
	if (arg && typeof arg === 'object') {
		if ('$file' in arg) return ctx.readText(arg.$file);
		if ('$path' in arg) return path.join(ctx.root, arg.$path);
		if ('$tree' in arg) return ctx.tree(arg.$tree);
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
	const parts = spec.fn.split('.');
	let owner = await ctx.load(spec.module);
	for (const name of parts.slice(0, -1)) owner = Object.hasOwn(Object(owner), name) ? owner[name] : undefined;
	const member = Object.hasOwn(Object(owner), parts.at(-1)) ? owner[parts.at(-1)] : undefined;
	if (member === undefined) throw new TypeError(`${spec.module} has no member ${spec.fn}`);
	let value = spec.args === undefined && typeof member !== 'function' ? member : await member.apply(owner, await evalArg(spec.args ?? [], ctx));
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

// Replaces every occurrence of each `from` in the string values (longest first), so a path that contains another is scrubbed whole.
export function scrub(value, pairs) {
	const ordered = [...pairs].sort((a, b) => b[0].length - a[0].length);
	const walkValue = (v) => {
		if (typeof v === 'string') return ordered.reduce((s, [from, to]) => s.split(from).join(to), v);
		if (Array.isArray(v)) return v.map(walkValue);
		if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walkValue(x)]));
		return v;
	};
	return walkValue(value);
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

// One context per run: its temporary trees are fresh directories and are removed when the process exits.
export function fixtureContext(root) {
	const real = fs.realpathSync(root);
	const ctx = {
		root: real,
		trees: [],
		readText: (rel) => fs.readFileSync(path.join(real, rel), 'utf8'),
		load: (rel) => (rel.endsWith('.json') ? Promise.resolve(JSON.parse(fs.readFileSync(path.join(real, rel), 'utf8'))) : import(pathToFileURL(path.join(real, rel)).href)),
		tree(files) {
			const dir = fs.realpathSync(tmpDir('bskel-t13-tree-'));
			for (const [rel, text] of Object.entries(files)) {
				fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
				fs.writeFileSync(path.join(dir, rel), text);
			}
			ctx.trees.push(dir);
			return dir;
		}
	};
	return ctx;
}

export async function runFixture(f, root) {
	const ctx = fixtureContext(root);
	const pairs = () => [...ctx.trees.map((dir) => [dir, '<tree>']), [ctx.root, '<root>'], [root, '<root>']];
	try {
		return scrub(normalize(await evalCall(f.call, ctx)), pairs());
	} catch (error) {
		return scrub({ threw: { name: error.name, message: error.message } }, pairs());
	}
}

export async function replay(record, root) {
	const out = [];
	for (const f of record.fixtures) {
		const first = await runFixture(f, root);
		const again = await runFixture(f, root);
		out.push({ id: f.id, deterministic: canonical(first) === canonical(again), output_sha256: sha256(canonical(first)), observed: f.expect.map(([pointer]) => pointerGet(first, pointer)), output: first });
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

// Import specifiers of a source text, comments ignored. `opaque` counts the forms whose specifier is built at run time.
export function importsOf(source) {
	const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');
	const specs = [...code.matchAll(/\b(?:import|export)\b[^'"`;()]*?\bfrom\s*(['"])([^'"\n]+)\1|\bimport\s*(['"])([^'"\n]+)\3|\bimport\s*\(\s*(['"])([^'"\n]+)\5\s*\)/g)].map((m) => m[2] ?? m[4] ?? m[6]);
	const opaque = [...code.matchAll(/\bimport\s*\((?!\s*['"][^'"\n]+['"]\s*\))|\brequire\s*\(|\bcreateRequire\b/g)].map((m) => m[0]);
	return { specs, opaque };
}

// One entry per catalog target, derived from the catalog, profile-evidence.json and the list of pinned paths. A target is PINNED
// when a leaf adapter is pinned and profile-evidence.json carries a framework reference for it; every other target is
// NOT_RECORDED and UNSUPPORTED. A SCOPE.json that another item wrote is listed as scope_record and claimed by no one here.
export function deriveTargets(catalog, evidence, filePaths) {
	const have = new Set(filePaths);
	const profiles = new Map((evidence?.profiles ?? []).map((p) => [p.id, p]));
	return (catalog ?? []).map((t) => {
		const leaf = `${TRACK.sourceDir}/${t.id}/adapter.mjs`;
		const ref = profiles.get(t.id)?.official_reference;
		return {
			id: t.id,
			wave: t.wave,
			language_track: t.languageTrack,
			runtime: t.runtime,
			leaf: have.has(leaf) ? leaf : null,
			profile_state: profiles.get(t.id)?.state ?? null,
			framework_pin: ref ? { repo: ref.repo, commit: ref.commit, package_version: ref.package_version } : null,
			scope_record: [`${TRACK.sourceDir}/scope/${t.id}.SCOPE.json`, `${TRACK.sourceDir}/${t.id}/SCOPE.json`].find((p) => have.has(p)) ?? null,
			record_status: have.has(leaf) && ref ? 'PINNED' : 'NOT_RECORDED',
			support_status: have.has(leaf) ? 'EXPERIMENTAL_SYNTHETIC_ONLY' : 'UNSUPPORTED'
		};
	});
}

// The identifier of the helper function that the scope-insensitive fixtures define and never call.
export const HELPER_NAME = 'uncalledHelper';
export const REFERENCE_PATTERN = 'http-wave-bc|node-hono|node-koa|typescript-nextjs';
const IMPORT_PATTERN = "(from|import[(]|require[(])[[:space:]]*['\"][^'\"]*http-wave-bc/";
export const REGISTRY_FILES = ['scanners/registry.mjs', 'scanners/index.mjs'];

// Facts about the repository at the pinned commit (never the live tree): package.json, the registry entry points and the
// files outside the two track directories that name a T13 path or leaf id.
export function commitView(root, commit) {
	const read = commitReader(root, commit);
	const packageJson = read('package.json');
	const excluded = [TRACK.sourceDir, TRACK.testDir];
	const mentions = REGISTRY_FILES.map((rel) => read(rel)).map((buf) => (buf ? [...buf.toString('utf8').matchAll(new RegExp(REFERENCE_PATTERN, 'g'))].length : null));
	return {
		packageJson: packageJson ? JSON.parse(packageJson.toString('utf8')) : null,
		packageJsonBlob: blobAtCommit(root, commit, 'package.json'),
		registryMentions: mentions.includes(null) ? null : mentions.reduce((a, b) => a + b, 0),
		referencePaths: referencesAtCommit(root, commit, REFERENCE_PATTERN, excluded),
		importersOutside: referencesAtCommit(root, commit, IMPORT_PATTERN, excluded)
	};
}

// Every module that a fixture call, including its nested calls, loads.
const callModules = (call) => {
	const modules = [];
	walk(call, '', (v) => {
		if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.module === 'string') modules.push(v.module);
	});
	return modules;
};
const endpointsOf = (output) => (output?.modules ?? []).flatMap((m) => (m.controllers ?? []).flatMap((c) => c.endpoints ?? []));
const notesOf = (view, id) => view.outputs.get(id)?.scanNotes ?? [];
const fixturesOf = (view, pick) => view.record.fixtures.filter(pick);
// The notes of a scan whose text the scan of the target's upstream-example fixture does not carry.
const baseNotes = (view, target) => new Set(notesOf(view, view.record.fixtures.find((f) => f.target === target && f.category === 'upstream-example')?.id));
const extraNoteTexts = (view, f) => notesOf(view, f.id).filter((n) => !baseNotes(view, f.target).has(n));
const extraNotes = (view, f) => extraNoteTexts(view, f).length;
// The text of every file of the inline tree that a fixture scans.
const treeText = (f) => Object.values(f.call?.args?.[0]?.$tree ?? {}).join('\n');
const sorted = (values) => [...new Set(values)].sort();
const covers = (entry, file) => {
	const e = entry.replace(/^\.\//, '').replace(/\/+$/, '');
	return e === '' || e === '.' || e.includes('*') || file === e || file.startsWith(`${e}/`);
};

function defectFacts(view, defect) {
	const flagged = fixturesOf(view, (f) => f.defect === defect);
	return {
		fixtures: flagged.length,
		fixtures_with_an_extra_note: flagged.filter((f) => extraNotes(view, f) > 0).length,
		extra_note_texts: flagged.map((f) => extraNoteTexts(view, f)),
		endpoint_paths: flagged.map((f) => endpointsOf(view.outputs.get(f.id)).map((e) => e.path))
	};
}

// The value of every limit's `facts`, recomputed from the replayed outputs (view.outputs: fixture id -> scrubbed output), the
// pinned files at the replay root (view.read) and the repository at the pinned commit (view.commit). A limit that has no
// entry here cannot be recorded.
export const LIMIT_FACTS = {
	'absent-leaves': ({ record }) => {
		const without = record.targets.filter((t) => t.leaf === null);
		return {
			catalog_targets: record.targets.length,
			targets_with_leaf: record.targets.length - without.length,
			targets_without_leaf: without.length,
			without_leaf_with_scope_record: without.filter((t) => t.scope_record !== null).length,
			without_leaf_without_scope_record: without.filter((t) => t.scope_record === null).length
		};
	},
	'no-runtime': (view) => {
		const descriptors = fixturesOf(view, (f) => f.category === 'descriptor');
		const modules = ofRole(view.record, 'source').filter((e) => e.path.endsWith('.mjs'));
		const packages = sorted(modules.flatMap((e) => importedPackages(view.read(e.path)?.toString('utf8') ?? '')));
		const flags = descriptors.flatMap((f) => Object.values(view.outputs.get(f.id)?.capabilities ?? { missing: true }));
		return {
			source_modules_scanned: modules.length,
			packages_imported_by_them: packages,
			packages_imported_count: packages.length,
			builtin_modules_imported: sorted(modules.flatMap((e) => builtinsImported(view.read(e.path)?.toString('utf8') ?? ''))),
			leaf_descriptors: descriptors.length,
			capability_flags: flags.length,
			capability_flags_not_false: flags.filter((v) => v !== false).length,
			verification_bases: sorted(descriptors.map((f) => view.outputs.get(f.id)?.verificationBasis)),
			oracle_scripts_pinned: ofRole(view.record, 'test_support').filter((e) => path.posix.basename(e.path) === 'oracle.mjs').length,
			fixtures_calling_an_oracle: fixturesOf(view, (f) => callModules(f.call).some((m) => path.posix.basename(m) === 'oracle.mjs')).length
		};
	},
	'legacy-contract': (view) => {
		const sources = ofRole(view.record, 'source').filter((e) => e.path.endsWith('.mjs'));
		const imports = sources.map((e) => importsOf(view.read(e.path)?.toString('utf8') ?? ''));
		return {
			descriptor_contracts: sorted(fixturesOf(view, (f) => f.category === 'descriptor').map((f) => view.outputs.get(f.id)?.contract)),
			scan_output_keys: sorted(fixturesOf(view, (f) => f.category === 'upstream-example').flatMap((f) => Object.keys(view.outputs.get(f.id) ?? {}))),
			source_files_checked: sources.length,
			imports_of_contracts_next: imports.flatMap((i) => i.specs).filter((s) => /(^|\/)contracts\/next(\/|$)/.test(s)).length,
			computed_import_specifiers: imports.reduce((sum, i) => sum + i.opaque.length, 0)
		};
	},
	'outside-npm-files': ({ commit }) => ({
		package_json_blob_sha1: commit.packageJsonBlob,
		files_entries: commit.packageJson?.files?.length ?? null,
		entries_covering_adapters: (commit.packageJson?.files ?? []).filter((entry) => covers(entry, `${TRACK.sourceDir}/catalog.mjs`)).length
	}),
	'not-registered': ({ commit, read }) => {
		const shipped = (commit.packageJson?.files ?? []).filter((entry) => entry.endsWith('/'));
		const evidence = JSON.parse(read(`${TRACK.sourceDir}/profile-evidence.json`)?.toString('utf8') ?? '{}');
		return {
			registry_files_checked: REGISTRY_FILES,
			registry_mentions: commit.registryMentions,
			files_naming_t13_outside_track_dirs: commit.referencePaths.length,
			shipped_code_files_naming_t13: commit.referencePaths.filter((p) => shipped.some((d) => p.startsWith(d)) && /\.(mjs|cjs|js)$/.test(p)).length,
			files_importing_a_t13_module: commit.importersOutside.length,
			importer_paths: commit.importersOutside,
			profile_evidence_promotion_state: evidence.promotion_state ?? null
		};
	},
	'historical-ci': ({ record, read }) => {
		const evidence = JSON.parse(read(`${TRACK.sourceDir}/profile-evidence.json`)?.toString('utf8') ?? '{}');
		return {
			profile_evidence_exact_head: evidence.exact_head ?? null,
			profile_evidence_run_id: evidence.ci?.run_id ?? null,
			profile_evidence_head_is_the_base_commit: evidence.exact_head === record.base_commit,
			observed_run_ids: record.ci_observations.map((o) => o.run_id),
			observed_heads_are_the_base_commit: record.ci_observations.every((o) => o.head_sha === record.base_commit)
		};
	},
	'upstream-example-fixtures': (view) => {
		const notes = ofRole(view.record, 'test_support').filter((e) => /^test\/http-wave-bc\/fixtures\/[^/]+\/SOURCE\.md$/.test(e.path));
		const sourceLines = notes.map((e) => (view.read(e.path)?.toString('utf8') ?? '').split('\n').find((l) => /^- Source\b/.test(l)) ?? '');
		return {
			upstream_example_scans: fixturesOf(view, (f) => f.category === 'upstream-example').length,
			source_notes_pinned: notes.length,
			source_notes_naming_a_readme_file: sourceLines.filter((l) => /README\.md/.test(l)).length,
			source_notes_naming_a_docs_page: sourceLines.filter((l) => /\.mdx/.test(l)).length
		};
	},
	'authored-inputs': (view) => ({
		fixtures_with_an_authored_tree: fixturesOf(view, (f) => f.origin === AUTHORED).length
	}),
	'withheld-forms': (view, limit) => {
		const listed = fixturesOf(view, (f) => (limit.fixtures ?? []).includes(f.id));
		return {
			fixtures: listed.length,
			fixtures_with_an_extra_note: listed.filter((f) => extraNotes(view, f) > 0).length,
			endpoints_emitted_by_them: listed.reduce((sum, f) => sum + endpointsOf(view.outputs.get(f.id)).length, 0)
		};
	},
	'unknown-not-structured': (view) => {
		const outputs = fixturesOf(view, (f) => f.call.fn === 'adapter.scan').map((f) => view.outputs.get(f.id));
		const codes = sorted(outputs.flatMap((o) => (o?.scanNotes ?? []).flatMap((n) => [...n.matchAll(/ uses ([a-z-]+); no endpoint path was emitted/g)].map((m) => m[1]))));
		return {
			scan_fixtures: outputs.length,
			endpoint_keys: sorted(outputs.flatMap((o) => endpointsOf(o).flatMap((e) => Object.keys(e)))),
			reason_codes_in_notes: codes,
			reason_code_count: codes.length
		};
	},
	'silent-drop': (view) => defectFacts(view, 'silent-drop'),
	'incomplete-path': (view) => defectFacts(view, 'incomplete-path'),
	'scope-insensitive': (view) => ({
		...defectFacts(view, 'scope-insensitive'),
		helper_name_occurrences: fixturesOf(view, (f) => f.defect === 'scope-insensitive').map((f) => treeText(f).split(HELPER_NAME).length - 1)
	}),
	'undetected-router': (view) => {
		const flagged = fixturesOf(view, (f) => f.defect === 'undetected-router');
		const declared = flagged.map((f) => Object.keys(JSON.parse(f.call?.args?.[0]?.$tree?.['package.json'] ?? '{}').dependencies ?? {}));
		return { fixtures: flagged.length, endpoints: flagged.reduce((sum, f) => sum + endpointsOf(view.outputs.get(f.id)).length, 0), notes: flagged.map((f) => notesOf(view, f.id)), declared_dependencies: declared.map((d) => d.sort()) };
	}
};

// Every limit's facts equal the recomputed facts, and every limit that can be recomputed is present.
export function limitProblems(record, view) {
	const problems = [];
	for (const l of record.limits ?? []) {
		const compute = LIMIT_FACTS[l.id];
		if (!compute) problems.push(`limit ${l.id}: its facts have no recomputation`);
		else if (canonical(l.facts) !== canonical(compute(view, l))) problems.push(`limit ${l.id}: facts ${canonical(l.facts)} != recomputed ${canonical(compute(view, l))}`);
	}
	for (const id of Object.keys(LIMIT_FACTS)) if (!(record.limits ?? []).some((l) => l.id === id)) problems.push(`limit ${id} is not recorded`);
	return problems;
}
