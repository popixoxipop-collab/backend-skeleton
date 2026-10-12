// Scenarios replayed by the T21 baseline record (lib/scan-scheduler-next/BASELINE.json).
//
// Each export calls the real T21 modules and returns plain data; an export that needs files builds its own throw-away
// directory and deletes it. The data holds no absolute path, no timestamp, no Buffer and no measured duration: the record stores the sha256
// of the returned value, so a scenario that leaked such a value would fail its own determinism check (each fixture runs
// twice). This file is authored for the record and is not hashed by it (it is named in TRACK.ownFiles); its outputs are.
// A scenario that needs the text of a pinned file receives it as an argument; a scenario that needs a pinned fixture project copies it from this checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { createArtifactStore } from '../../lib/artifact-store-next/store.mjs';
import { createCacheIndex } from '../../lib/artifact-store-next/cache-index.mjs';
import { collectArtifactGarbage } from '../../lib/artifact-store-next/gc.mjs';
import { buildScanCacheKey, digestJson, sha256Bytes, stableJson } from '../../lib/scan-scheduler-next/cache-key.mjs';
import { runCachedTask } from '../../lib/scan-scheduler-next/cache-runtime.mjs';
import { DEFAULT_EXCLUDED_DIRS, buildFileIndex, portablePathIssuesForPaths } from '../../lib/scan-scheduler-next/file-index.mjs';
import { computeInvalidation } from '../../lib/scan-scheduler-next/invalidation.mjs';
import { runTaskGraph } from '../../lib/scan-scheduler-next/scheduler.mjs';
import { deriveMemoryAdmission } from '../../lib/scan-scheduler-next/resource-budget.mjs';
import { evaluatePerformanceGate } from '../../lib/scan-scheduler-next/performance-policy.mjs';
import { runLegacyScanCached } from '../../lib/scan-scheduler-next/legacy-cache.mjs';
import { buildProjectCachePlan, propagateProjectInvalidation } from '../../lib/scan-scheduler-next/project-cache-plan.mjs';
import { runProjectGraphCached } from '../../lib/scan-scheduler-next/project-cache-runner.mjs';

const MIB = 1024 * 1024;
// The repository this module sits in (a live checkout, or the extracted copy of the pinned commit during a replay).
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function inTemp(fn) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 't21-baseline-'));
	try {
		return await fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// What a refusal looks like in a record: the error class, its code when it has one, and its message with the scratch
// directory replaced, so two runs in two different directories give the same value.
function scrubber(root) {
	const names = new Set([root, fs.realpathSync(root)]);
	return (text) => [...names].reduce((acc, name) => acc.split(name).join('<root>'), text);
}

function refusal(error, scrub = (text) => text) {
	return { name: error.name, ...(error.code === undefined ? {} : { code: error.code }), message: scrub(error.message) };
}

function attempt(fn, scrub) {
	try {
		fn();
		return { returned: true };
	} catch (error) {
		return { threw: refusal(error, scrub) };
	}
}

// A read: what was served, or why it was refused.
function served(fn, scrub) {
	try {
		return { served: fn().toString('utf8') };
	} catch (error) {
		return { threw: refusal(error, scrub) };
	}
}

async function attemptAsync(fn, scrub) {
	try {
		await fn();
		return { returned: true };
	} catch (error) {
		return { threw: refusal(error, scrub) };
	}
}

const mode = (file) => (fs.statSync(file).mode & 0o777).toString(8);
const digestOf = (label) => sha256Bytes(`t21-baseline:${label}`);

function write(root, rel, text, fileMode = 0o644) {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	fs.chmodSync(file, fileMode);
	return file;
}

// Every file under dir, sorted, as posix paths relative to dir.
function filesUnder(dir) {
	const out = [];
	const visit = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) visit(full);
			else out.push(path.relative(dir, full).split(path.sep).join('/'));
		}
	};
	if (fs.existsSync(dir)) visit(dir);
	return out.sort();
}

const keyInput = (over = {}) => ({
	sourceDigest: digestOf('source'),
	resolverDigest: digestOf('resolver'),
	configDigest: digestOf('config'),
	parserDigest: digestOf('parser'),
	adapterDigest: digestOf('adapter'),
	schemaDigest: digestOf('schema'),
	policyDigest: digestOf('policy'),
	runtimeFingerprint: 'node-24/linux-x64',
	...over
});

// ---- cache key ---------------------------------------------------------------------------------------------------

export async function cacheKeyFieldSensitivity() {
	const base = buildScanCacheKey(keyInput());
	const changes = {
		sourceDigest: digestOf('other-source'),
		resolverDigest: digestOf('other-resolver'),
		configDigest: digestOf('other-config'),
		parserDigest: digestOf('other-parser'),
		adapterDigest: digestOf('other-adapter'),
		schemaDigest: digestOf('other-schema'),
		policyDigest: digestOf('other-policy'),
		runtimeFingerprint: 'node-22/linux-x64',
		namespace: 'bskel.scan-cache/2'
	};
	const changesKey = {};
	for (const [field, value] of Object.entries(changes)) changesKey[field] = buildScanCacheKey(keyInput({ [field]: value })).digest !== base.digest;
	return {
		base_digest: base.digest,
		material_keys: Object.keys(base.material),
		same_inputs_same_key: buildScanCacheKey(keyInput()).digest === base.digest,
		each_field_changes_the_key: changesKey,
		json_key_order_does_not_matter: digestJson({ b: 1, a: [2, { d: 4, c: 3 }] }) === digestJson({ a: [2, { c: 3, d: 4 }], b: 1 })
	};
}

export async function cacheKeyInputRefusals() {
	const key = (over) => attempt(() => buildScanCacheKey(keyInput(over)));
	return {
		uppercase_digest: key({ sourceDigest: digestOf('x').toUpperCase() }),
		short_digest: key({ parserDigest: 'abc' }),
		missing_digest: key({ adapterDigest: undefined }),
		empty_namespace: key({ namespace: '  ' }),
		empty_runtime_fingerprint: key({ runtimeFingerprint: '' }),
		undefined_material: attempt(() => stableJson({ a: undefined })),
		non_finite_material: attempt(() => stableJson({ a: Number.NaN })),
		bigint_material: attempt(() => stableJson({ a: 1n })),
		function_material: attempt(() => stableJson({ a: () => 1 }))
	};
}

// ---- file index --------------------------------------------------------------------------------------------------

export async function fileIndexDigests() {
	return inTemp(async (root) => {
		write(root, 'src/a.js', 'export const a = 1;\n');
		write(root, 'src/b.js', 'export const b = 2;\n');
		write(root, 'src/nested/c.txt', 'hello\n');
		write(root, 'bin/run.sh', '#!/bin/sh\nexit 0\n', 0o755);
		for (const ignored of ['node_modules/dep/index.js', '.git/config', '.sbf/state.json', 'dist/out.js', 'coverage/lcov.info', 'build/out.js']) write(root, ignored, 'ignored\n');
		fs.symlinkSync(path.join(root, 'src', 'a.js'), path.join(root, 'link-to-file'));
		fs.symlinkSync(path.join(root, 'src'), path.join(root, 'link-to-dir'));
		const first = buildFileIndex(root);
		const second = buildFileIndex(root);
		const withoutDist = buildFileIndex(root, { excludedDirs: ['.git', '.sbf', 'node_modules', 'coverage', 'build'] });
		return {
			schema: first.schema,
			source_digest: first.source_digest,
			entries: first.entries.map((entry) => ({ path: entry.path, size: entry.size, mode_octal: entry.mode.toString(8), sha256: entry.sha256 })),
			stats: first.stats,
			skipped_symlinks: first.skipped_symlinks,
			portable_path_issues: first.portable_path_issues,
			repeat_is_identical: stableJson(first) === stableJson(second),
			source_digest_is_digest_of_entries: first.source_digest === digestJson(first.entries),
			narrower_exclusion_list_adds_dist: withoutDist.entries.map((entry) => entry.path).filter((rel) => !first.entries.some((x) => x.path === rel))
		};
	});
}

// Regenerates the smallest workload of the old advisory measurement file with the layout of test/perf-next/benchmark.mjs
// (src/<bucket>/file-<index>.js, the same text, every file chmod 0644 because the mode is part of the index identity) and
// compares the source digest with the one that file recorded. Nothing about timing is replayed.
export async function workloadDigestAgainstOldBaseline(oldBaselineText) {
	const old = JSON.parse(oldBaselineText);
	const recorded = old.workloads.find((workload) => workload.files === 100 && workload.bytes_per_file === 256);
	return inTemp(async (root) => {
		const files = 100;
		const bytesPerFile = 256;
		const payload = 'x'.repeat(Math.max(0, bytesPerFile - 32));
		for (let i = 0; i < files; i++) {
			write(root, `src/${String(Math.floor(i / 1000)).padStart(4, '0')}/file-${String(i).padStart(6, '0')}.js`, `export const n${i}=${i};/*${payload}*/\n`);
		}
		const index = buildFileIndex(root, { maxFiles: Math.max(files + 10, 1000), maxBytes: Math.max(files * bytesPerFile * 4, 64 * MIB) });
		return {
			old_file_schema: old.schema,
			old_file_status: old.status,
			workloads_in_old_file: old.workloads.map((workload) => `${workload.files}x${workload.bytes_per_file}`),
			replayed_workload: '100x256',
			files: index.stats.files,
			bytes: index.stats.bytes,
			old_file_source_digest: recorded.source_digest,
			recomputed_source_digest: index.source_digest,
			recomputed_digest_equals_old_file: index.source_digest === recorded.source_digest
		};
	});
}

// Names are built from code points so the source file holds no precomposed or decomposed text that an editor could normalise.
export async function portablePathIssues() {
	const nfc = `caf${String.fromCharCode(0xe9)}.txt`;
	const nfd = `cafe${String.fromCharCode(0x301)}.txt`;
	return {
		nfc_and_nfd_differ_as_strings: nfc !== nfd,
		both_normalise_to_the_same_name: nfc.normalize('NFC') === nfd.normalize('NFC'),
		case_and_unicode_collisions: portablePathIssuesForPaths(['docs/Readme.md', 'docs/README.md', 'src/only.js', nfc, nfd]).map((issue) => ({
			kind: issue.kind,
			paths_in_code_units: issue.paths.map((p) => [...p].map((ch) => ch.charCodeAt(0).toString(16)).join(' '))
		})),
		no_collision: portablePathIssuesForPaths(['a.js', 'b.js', 'dir/a.js']),
		not_an_array: attempt(() => portablePathIssuesForPaths('src/a.js'))
	};
}

export async function fileIndexBudgetRefused() {
	return inTemp(async (root) => {
		for (let i = 0; i < 5; i++) write(root, `src/f${i}.txt`, `${'x'.repeat(10)}\n`);
		const tooMany = {};
		try {
			buildFileIndex(root, { maxFiles: 3 });
		} catch (error) {
			tooMany.threw = { ...refusal(error), kind: error.kind, actual: error.actual, limit: error.limit };
		}
		const tooBig = {};
		try {
			buildFileIndex(root, { maxBytes: 30 });
		} catch (error) {
			tooBig.threw = { ...refusal(error), kind: error.kind, actual: error.actual, limit: error.limit };
		}
		const exactlyAtTheLimit = buildFileIndex(root, { maxFiles: 5, maxBytes: 55 }).stats;
		return { file_count_budget: tooMany, byte_count_budget: tooBig, exactly_at_both_limits_is_accepted: exactlyAtTheLimit };
	});
}

// ---- invalidation ------------------------------------------------------------------------------------------------

// Literal file indexes (no file system): the decision depends on the two indexes and the edges alone.
export async function invalidationDecisions() {
	const entry = (file, text, fileMode = 0o644) => ({ path: file, size: Buffer.byteLength(text), mode: fileMode, sha256: sha256Bytes(text) });
	const index = (...entries) => ({ schema: 'sbf.scan-file-index/1', entries });
	const files = { a: ['src/a.js', 'a'], b: ['src/b.js', 'b'], c: ['src/c.js', 'c'], d: ['src/d.js', 'd'] };
	const make = (override = {}, drop = []) => index(...Object.entries(files).filter(([key]) => !drop.includes(key)).map(([key, [file, text]]) => (override[key] ? entry(file, ...override[key]) : entry(file, text))));
	const before = make();
	const decide = (next, options = {}) => computeInvalidation({ previousIndex: before, nextIndex: next, ...options });
	const chain = [{ dependent: 'src/b.js', dependency: 'src/a.js' }, { dependent: 'src/c.js', dependency: 'src/b.js' }];
	const reordered = index(...make({ a: ['changed'] }).entries.reverse());
	return {
		nothing_changed: decide(make()),
		content_changed_with_the_same_size: decide(make({ a: ['x'] })),
		size_changed: decide(make({ a: ['aa'] })),
		mode_alone_changed: decide(make({ a: ['a', 0o755] })),
		file_added: decide(index(...make().entries, entry('src/e.js', 'e'))),
		file_deleted: decide(make({}, ['d'])),
		rename_is_a_deletion_and_an_addition: decide(index(...make({}, ['d']).entries, entry('src/e.js', 'd'))),
		dependents_are_invalidated_transitively: decide(make({ a: ['changed'] }), { dependencyEdges: chain }),
		a_changed_dependent_does_not_invalidate_its_dependency: decide(make({ c: ['changed'] }), { dependencyEdges: chain }),
		a_dependency_cycle_terminates: decide(make({ a: ['changed'] }), { dependencyEdges: [{ dependent: 'src/a.js', dependency: 'src/b.js' }, { dependent: 'src/b.js', dependency: 'src/a.js' }] }),
		an_edge_may_name_a_path_outside_both_indexes: decide(make({ a: ['changed'] }), { dependencyEdges: [{ dependent: 'src/z.js', dependency: 'src/a.js' }] }),
		global_inputs_changed_invalidates_every_path: decide(make(), { globalInputsChanged: true }),
		input_order_does_not_change_the_decision: stableJson(decide(reordered)) === stableJson(decide(make({ a: ['changed'] })))
	};
}

// The inputs that computeInvalidation refuses; the pinned file-index and invalidation tests do not cover any of these refusals.
export async function invalidationRefusals() {
	const entry = (file, text) => ({ path: file, size: Buffer.byteLength(text), mode: 0o644, sha256: sha256Bytes(text) });
	const index = { schema: 'sbf.scan-file-index/1', entries: [entry('src/a.js', 'a')] };
	return {
		edge_that_is_not_a_pair_of_strings: attempt(() => computeInvalidation({ previousIndex: index, nextIndex: index, dependencyEdges: [{ dependent: 1, dependency: 'src/a.js' }] })),
		edge_that_is_null: attempt(() => computeInvalidation({ previousIndex: index, nextIndex: index, dependencyEdges: [null] })),
		previous_index_of_another_schema: attempt(() => computeInvalidation({ previousIndex: { schema: 'other', entries: [] }, nextIndex: index })),
		next_index_without_entries: attempt(() => computeInvalidation({ previousIndex: index, nextIndex: { schema: 'sbf.scan-file-index/1' } })),
		no_arguments: attempt(() => computeInvalidation({}))
	};
}

// ---- artifact store ----------------------------------------------------------------------------------------------

export async function storeLayoutAndRefs() {
	return inTemp(async (root) => {
		const store = createArtifactStore(path.join(root, 'store'));
		const fromString = store.put('hello\n');
		const fromBuffer = store.put(Buffer.from('hello\n'));
		const fromBytes = store.put(new Uint8Array([104, 101, 108, 108, 111, 10]));
		const empty = store.put('');
		const target = store.pathForDigest(fromString.digest);
		return {
			ref: fromString,
			string_buffer_and_uint8array_give_the_same_ref: stableJson(fromString) === stableJson(fromBuffer) && stableJson(fromString) === stableJson(fromBytes),
			ref_digest_is_sha256_of_the_bytes: fromString.digest === sha256Bytes('hello\n'),
			empty_content_ref: empty,
			blob_path_relative_to_store_root: path.relative(store.root, target).split(path.sep).join('/'),
			blob_file_mode_octal: mode(target),
			read_back_text: store.read(fromString).toString('utf8'),
			has_stored_ref: store.has(fromString),
			has_ref_that_was_never_stored: store.has({ algorithm: 'sha256', digest: digestOf('never stored'), size: 3 }),
			files_in_store: filesUnder(store.root)
		};
	});
}

export async function storeCorruptEntryRejected() {
	return inTemp(async (root) => {
		const scrub = scrubber(root);
		const store = createArtifactStore(path.join(root, 'store'));
		const sameSize = store.put('same-size content\n');
		const cut = store.put('to be truncated, longer text\n');
		const gone = store.put('to be removed\n');
		const intact = store.put('left alone\n');
		fs.writeFileSync(store.pathForDigest(sameSize.digest), 'SAME-SIZE CONTENT\n');
		fs.truncateSync(store.pathForDigest(cut.digest), 5);
		fs.rmSync(store.pathForDigest(gone.digest));
		const outcome = (fn) => served(fn, scrub);
		const before = {
			same_size_tamper: outcome(() => store.read(sameSize)),
			truncated: outcome(() => store.read(cut)),
			removed: outcome(() => store.read(gone)),
			intact_neighbour_still_served: outcome(() => store.read(intact)),
			ref_with_wrong_size: outcome(() => store.read({ ...intact, size: intact.size + 1 })),
			has_is_an_existence_check_only: { tampered: store.has(sameSize), truncated: store.has(cut), removed: store.has(gone) }
		};
		const putOverTampered = attempt(() => store.put('same-size content\n'), scrub);
		const stillDamaged = outcome(() => store.read(sameSize));
		const rewritten = store.put('to be removed\n');
		return {
			...before,
			put_over_a_tampered_blob: putOverTampered,
			tampered_blob_is_not_repaired_by_put: stillDamaged,
			put_after_removal_writes_the_blob_again: { same_ref: stableJson(rewritten) === stableJson(gone), served: outcome(() => store.read(gone)) }
		};
	});
}

export async function storeBudgetRefused() {
	return inTemp(async (root) => {
		const scrub = scrubber(root);
		const store = createArtifactStore(path.join(root, 'store'), { maxArtifactBytes: 16 });
		const exactly = store.put('0123456789abcdef');
		const overByOne = attempt(() => store.put('0123456789abcdefg'), scrub);
		const overBuffer = attempt(() => store.put(Buffer.alloc(100)), scrub);
		const wrongType = attempt(() => store.put(42), scrub);
		const badBudgets = {};
		for (const [label, value] of [['zero', 0], ['negative', -1], ['fraction', 1.5], ['text', '16'], ['not_a_number', Number.NaN]]) {
			badBudgets[label] = attempt(() => createArtifactStore(path.join(root, 'other'), { maxArtifactBytes: value }), scrub);
		}
		return {
			content_of_exactly_the_budget: exactly,
			one_byte_over: overByOne,
			large_buffer_over: overBuffer,
			content_of_a_wrong_type: wrongType,
			invalid_budget_values: badBudgets,
			files_in_store_after_the_refusals: filesUnder(store.root)
		};
	});
}

export async function pathEscapeRefused() {
	return inTemp(async (root) => {
		const scrub = scrubber(root);
		const store = createArtifactStore(path.join(root, 'store'));
		const ref = store.put('inside\n');
		const digests = {
			parent_traversal: '../../../etc/passwd',
			dot_dot: '..',
			digest_then_traversal: `${ref.digest}/../../x`,
			uppercase_digest: ref.digest.toUpperCase(),
			digest_one_character_short: ref.digest.slice(1),
			digest_one_character_long: `${ref.digest}0`,
			empty: '',
			null_value: null,
			number_value: 42
		};
		const digestRefusals = {};
		for (const [label, value] of Object.entries(digests)) digestRefusals[label] = attempt(() => store.pathForDigest(value), scrub);
		const refs = {
			traversal_digest: { algorithm: 'sha256', digest: '../../../../etc/passwd', size: 1 },
			other_algorithm: { algorithm: 'md5', digest: ref.digest, size: ref.size },
			negative_size: { algorithm: 'sha256', digest: ref.digest, size: -1 },
			fractional_size: { algorithm: 'sha256', digest: ref.digest, size: 1.5 },
			null_ref: null,
			text_ref: 'sha256:abc'
		};
		const refRefusals = {};
		for (const [label, value] of Object.entries(refs)) refRefusals[label] = { has: attempt(() => store.has(value), scrub), read: attempt(() => store.read(value), scrub) };
		const index = (relativePath) => attempt(() => createCacheIndex(root, { relativePath }), scrub);
		return {
			the_one_valid_blob_path: path.relative(store.root, store.pathForDigest(ref.digest)).split(path.sep).join('/'),
			digests_refused_by_pathForDigest: digestRefusals,
			refs_refused_by_has_and_read: refRefusals,
			cache_index_paths: {
				parent_directory: index('../outside.json'),
				deeper_traversal: index('.sbf/../../outside.json'),
				absolute_path_outside_repo_root: index(path.join(path.dirname(root), 'outside.json')),
				traversal_that_returns_inside: index('.sbf/../.sbf/inside.json'),
				default_path: attempt(() => createCacheIndex(root), scrub)
			},
			files_under_the_root_after_all_refusals: filesUnder(root)
		};
	});
}

// ---- cache index -------------------------------------------------------------------------------------------------

export async function cacheIndexState() {
	return inTemp(async (root) => {
		const store = createArtifactStore(path.join(root, '.sbf', 'cache-next', 'artifacts'));
		const index = createCacheIndex(root);
		const refA = store.put('artifact a\n');
		const refB = store.put('artifact b\n');
		const keyA = digestOf('key a');
		const keyB = digestOf('key b');
		const storedB = index.set(keyB, refB, { dependencies: ['src/z.js', 'src/a.js', 'src/z.js'], metadata: { adapter: 'demo', note: 'second' } });
		const storedA = index.set({ digest: keyA }, refA);
		const listing = index.list();
		const text = fs.readFileSync(index.path, 'utf8');
		const reachable = index.reachableArtifactRefs();
		const getKnown = index.get(keyA);
		const getUnknown = index.get(digestOf('unknown key'));
		const getWithKeyObject = stableJson(index.get({ digest: keyB })) === stableJson(index.get(keyB));
		const removedKnown = index.remove(keyA);
		const removedAgain = index.remove(keyA);
		return {
			index_schema: index.schema,
			index_path_relative_to_repo_root: path.relative(root, index.path).split(path.sep).join('/'),
			entry_b_as_stored: storedB,
			entry_a_as_stored: storedA,
			dependencies_are_deduplicated_and_sorted: storedB.dependencies,
			listing_is_sorted_by_cache_key: listing.map((entry) => entry.cache_key).join(',') === [keyA, keyB].sort().join(','),
			listing,
			get_known_key: getKnown,
			get_unknown_key: getUnknown,
			get_accepts_a_key_object: getWithKeyObject,
			reachable_artifact_refs: reachable,
			persisted_text_is_stable_json_plus_newline: text === `${stableJson(JSON.parse(text))}\n`,
			persisted_text_sha256: sha256Bytes(text),
			remove_known_key: removedKnown,
			remove_same_key_again: removedAgain,
			entries_left: index.list().map((entry) => entry.cache_key).length,
			lock_directory_left_behind: fs.existsSync(path.join(root, '.sbf', '.locks', 't21-cache-index.lock'))
		};
	});
}

export async function cacheIndexFailsClosed() {
	return inTemp(async (root) => {
		const scrub = scrubber(root);
		const store = createArtifactStore(path.join(root, 'store'));
		const ref = store.put('artifact\n');
		const key = digestOf('key');
		const stateFile = path.join(root, '.sbf', 'cache-next', 'index.json');
		const index = createCacheIndex(root);
		const states = {
			wrong_schema: JSON.stringify({ schema: 'other/1', entries: {} }),
			entries_is_an_array: JSON.stringify({ schema: 'sbf.scan-cache-index/1', entries: [] }),
			key_is_not_a_digest: JSON.stringify({ schema: 'sbf.scan-cache-index/1', entries: { 'not-a-digest': { artifact: ref, dependencies: [] } } }),
			entry_is_not_an_object: JSON.stringify({ schema: 'sbf.scan-cache-index/1', entries: { [key]: 'text' } }),
			artifact_ref_other_algorithm: JSON.stringify({ schema: 'sbf.scan-cache-index/1', entries: { [key]: { artifact: { ...ref, algorithm: 'md5' }, dependencies: [] } } }),
			dependencies_not_strings: JSON.stringify({ schema: 'sbf.scan-cache-index/1', entries: { [key]: { artifact: ref, dependencies: [1] } } })
		};
		const out = {};
		for (const [label, text] of Object.entries(states)) {
			fs.mkdirSync(path.dirname(stateFile), { recursive: true });
			fs.writeFileSync(stateFile, text);
			out[label] = {
				get: attempt(() => index.get(key), scrub),
				set: attempt(() => index.set(digestOf('other key'), ref), scrub),
				list: attempt(() => index.list(), scrub),
				file_unchanged_by_the_failed_set: fs.readFileSync(stateFile, 'utf8') === text
			};
		}
		// A file that is not JSON at all: the engine's own parse error text differs between Node versions, so only its class is recorded.
		fs.writeFileSync(stateFile, '{"schema": ');
		const parse = (fn) => {
			try {
				fn();
				return { returned: true };
			} catch (error) {
				return { threw_class: error.name };
			}
		};
		out.not_json = { get: parse(() => index.get(key)), set: parse(() => index.set(digestOf('other key'), ref)), file_unchanged_by_the_failed_set: fs.readFileSync(stateFile, 'utf8') === '{"schema": ' };
		fs.rmSync(stateFile);
		const argumentRefusals = {
			key_is_not_a_digest: attempt(() => index.set('not-a-digest', ref), scrub),
			ref_other_algorithm: attempt(() => index.set(key, { ...ref, algorithm: 'md5' }), scrub),
			ref_negative_size: attempt(() => index.set(key, { ...ref, size: -1 }), scrub),
			ref_missing: attempt(() => index.set(key, null), scrub),
			dependencies_not_an_array: attempt(() => index.set(key, ref, { dependencies: 'src/a.js' }), scrub),
			dependencies_not_strings: attempt(() => index.set(key, ref, { dependencies: [1] }), scrub),
			metadata_not_representable: attempt(() => index.set(key, ref, { metadata: { value: undefined } }), scrub),
			invalidate_paths_not_an_array: attempt(() => index.invalidateDependencies('src/a.js'), scrub)
		};
		return {
			stored_state_that_is_refused: out,
			argument_refusals: argumentRefusals,
			index_file_exists_after_all_refusals: fs.existsSync(stateFile),
			lock_directory_left_behind: fs.existsSync(path.join(root, '.sbf', '.locks', 't21-cache-index.lock'))
		};
	});
}

// The path check of the cache index is lexical (path.resolve and path.relative, no realpath). A directory that is a symlink
// inside the repository root and points outside is therefore followed: the index file is written outside the root.
export async function cacheIndexSymlinkedDirectoryIsFollowed() {
	return inTemp(async (root) => {
		const repo = path.join(root, 'repo');
		const outside = path.join(root, 'outside');
		fs.mkdirSync(repo);
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(repo, 'linked'));
		const store = createArtifactStore(path.join(root, 'store'));
		let index = null;
		const created = attempt(() => {
			index = createCacheIndex(repo, { relativePath: 'linked/index.json' });
		});
		const written = attempt(() => index.set(digestOf('key'), store.put('artifact\n')));
		return {
			create_cache_index_through_the_symlink: created,
			set_through_the_symlink: written,
			visible_through_the_link_inside_the_repo: fs.existsSync(path.join(repo, 'linked', 'index.json')),
			written_outside_the_repo_root: filesUnder(outside)
		};
	});
}

// ---- garbage collection ------------------------------------------------------------------------------------------

function ageBlob(store, ref, seconds) {
	fs.utimesSync(store.pathForDigest(ref.digest), seconds, seconds);
}

export async function gcDryRunPlan() {
	return inTemp(async (root) => {
		const store = createArtifactStore(path.join(root, 'store'));
		const keep = store.put('referenced and old\n');
		const oldA = store.put('old unreferenced a\n');
		const oldB = store.put('old unreferenced bb\n');
		const young = store.put('young unreferenced\n');
		const nowMs = 20_000_000;
		for (const ref of [keep, oldA, oldB]) ageBlob(store, ref, 1_000);
		ageBlob(store, young, 19_999);
		const plan = (options) => collectArtifactGarbage(store.root, { nowMs, ...options });
		const blobCount = () => filesUnder(path.join(store.root, 'blobs')).length;
		const defaults = plan({ reachable: [keep] });
		const afterDefaults = blobCount();
		const aged = plan({ reachable: [keep], minAgeMs: 60_000 });
		const countLimited = plan({ reachable: [keep], maxDeleteCount: 1 });
		const byteLimited = plan({ reachable: [keep], maxDeleteBytes: 20 });
		const candidates = (result) => result.candidates.map((c) => c.digest);
		const blobsAfterEveryPlan = blobCount();
		// The age test is nowMs - mtime < minAgeMs, so a blob stamped after nowMs is young even when minAgeMs is 0.
		const future = store.put('modified after the plan time\n');
		ageBlob(store, future, 20_001);
		const withFutureBlob = plan({ reachable: [keep] });
		return {
			blob_sizes: { keep: keep.size, old_a: oldA.size, old_b: oldB.size, young: young.size },
			default_options_plan: defaults,
			blobs_after_the_default_plan: afterDefaults,
			min_age_keeps_the_young_blob_out: { candidates_exclude_young: !candidates(aged).includes(young.digest), candidates: aged.candidates.length, candidate_bytes: aged.candidate_bytes },
			default_plan_includes_the_young_blob: candidates(defaults).includes(young.digest),
			no_candidate_is_the_referenced_blob: [defaults, aged, countLimited, byteLimited].every((result) => !candidates(result).includes(keep.digest)),
			max_delete_count_one: { candidates: countLimited.candidates.length, candidate_bytes: countLimited.candidate_bytes },
			max_delete_bytes_twenty: { candidates: byteLimited.candidates.length, candidate_bytes: byteLimited.candidate_bytes },
			candidate_order_is_by_prefix_directory_then_name: defaults.candidates.map((c) => c.relative_path).join(',') === defaults.candidates.map((c) => c.relative_path).sort().join(','),
			blobs_after_every_plan: blobsAfterEveryPlan,
			blob_modified_after_nowMs_is_never_a_candidate_even_at_min_age_zero: { future_blob_is_a_candidate: candidates(withFutureBlob).includes(future.digest), other_candidates_unchanged: candidates(withFutureBlob).join(',') === candidates(defaults).join(',') }
		};
	});
}

export async function gcKeepsReferencedArtifacts() {
	return inTemp(async (root) => {
		const scrub = scrubber(root);
		const store = createArtifactStore(path.join(root, '.sbf', 'cache-next', 'artifacts'));
		const index = createCacheIndex(root);
		const referencedA = store.put('referenced a\n');
		const referencedB = store.put('referenced b\n');
		const orphan = store.put('orphan\n');
		index.set(digestOf('key a'), referencedA, { dependencies: ['src/a.js'] });
		index.set(digestOf('key b'), referencedB, { dependencies: ['src/b.js'] });
		const blobsDir = path.join(store.root, 'blobs', 'sha256');
		fs.mkdirSync(path.join(blobsDir, 'zz'), { recursive: true });
		fs.writeFileSync(path.join(blobsDir, 'zz', 'stray.txt'), 'not a blob\n');
		const tmpName = `${orphan.digest.slice(0, 2)}/${orphan.digest}.4242.1700000000000.tmp`;
		fs.writeFileSync(path.join(blobsDir, tmpName), 'half written\n');
		const reachable = index.reachableArtifactRefs();
		// Every call names the plan time: with the default (the wall clock) a blob stamped in the same millisecond counts as young.
		const nowMs = 4_102_444_800_000;
		const withNoRoots = collectArtifactGarbage(store.root, { dryRun: true, nowMs });
		const applied = collectArtifactGarbage(store.root, { reachable, dryRun: false, nowMs });
		const readBack = (ref) => served(() => store.read(ref), scrub);
		const bareDigests = collectArtifactGarbage(store.root, { reachable: [referencedA.digest, referencedB.digest], dryRun: true, nowMs });
		return {
			when_no_roots_are_given_every_blob_is_a_candidate: withNoRoots.candidates.length === withNoRoots.total_blobs,
			applied: { dry_run: applied.dry_run, reachable: applied.reachable, total_blobs: applied.total_blobs, deleted_count: applied.deleted.length, unexpected: applied.unexpected },
			deleted_only_the_orphan: applied.deleted.length === 1 && applied.deleted[0].digest === orphan.digest,
			referenced_a_after: readBack(referencedA),
			referenced_b_after: readBack(referencedB),
			orphan_after: readBack(orphan),
			unexpected_entries_survive: { stray_directory_file: fs.existsSync(path.join(blobsDir, 'zz', 'stray.txt')), leftover_temp_file: fs.existsSync(path.join(blobsDir, tmpName)) },
			bare_digests_protect_like_refs: { candidates: bareDigests.candidates.length, reachable: bareDigests.reachable },
			second_apply_finds_nothing_to_delete: collectArtifactGarbage(store.root, { reachable, dryRun: false, nowMs }).deleted.length,
			wrong_shape_of_a_root: attempt(() => collectArtifactGarbage(store.root, { reachable: ['not-a-digest'] }), scrub),
			bad_budget_values: {
				minAgeMs: attempt(() => collectArtifactGarbage(store.root, { minAgeMs: -1 }), scrub),
				maxDeleteCount: attempt(() => collectArtifactGarbage(store.root, { maxDeleteCount: 1.5 }), scrub),
				maxDeleteBytes: attempt(() => collectArtifactGarbage(store.root, { maxDeleteBytes: '1' }), scrub),
				nowMs: attempt(() => collectArtifactGarbage(store.root, { nowMs: Number.NaN }), scrub)
			}
		};
	});
}

// ---- cached task runtime -----------------------------------------------------------------------------------------

function cacheParts(root) {
	return {
		artifactStore: createArtifactStore(path.join(root, '.sbf', 'cache-next', 'artifacts')),
		cacheIndex: createCacheIndex(root)
	};
}

export async function cacheKeyMismatchIsAMiss() {
	return inTemp(async (root) => {
		const parts = cacheParts(root);
		const keyA = buildScanCacheKey(keyInput());
		const keyB = buildScanCacheKey(keyInput({ parserDigest: digestOf('parser, next version') }));
		const calls = [];
		const run = async (cacheKey, label) => {
			const result = await runCachedTask({ ...parts, cacheKey, compute: async () => { calls.push(label); return { computed_for: label }; } });
			return { cache_hit: result.cache_hit, value: result.value };
		};
		const sequence = [await run(keyA, 'A'), await run(keyA, 'A again'), await run(keyB, 'B'), await run(keyA, 'A third time'), await run(keyB, 'B again')];
		return {
			the_two_keys_differ: keyA.digest !== keyB.digest,
			sequence,
			compute_calls: calls,
			entries_in_the_index: parts.cacheIndex.list().length,
			blobs_in_the_store: filesUnder(path.join(parts.artifactStore.root, 'blobs')).length
		};
	});
}

export async function cachedTaskFailsClosedOnDamage() {
	return inTemp(async (root) => {
		const scrub = scrubber(root);
		const parts = cacheParts(root);
		const cacheKey = buildScanCacheKey(keyInput());
		let computeCalls = 0;
		const run = () => runCachedTask({ ...parts, cacheKey, compute: async () => { computeCalls += 1; return { answer: 42, run: computeCalls }; } });
		const first = await run();
		const second = await run();
		const blob = parts.artifactStore.pathForDigest(first.artifact.digest);
		const original = fs.readFileSync(blob, 'utf8');
		fs.writeFileSync(blob, original.replace('42', '43'));
		const callsBeforeDamagedRun = computeCalls;
		const damaged = await attemptAsync(run, scrub);
		fs.rmSync(blob);
		const missing = await attemptAsync(run, scrub);
		return {
			first_run: { cache_hit: first.cache_hit, value: first.value, artifact: first.artifact },
			second_run: { cache_hit: second.cache_hit, value: second.value },
			same_size_damage_is_a_different_text: original.length === original.replace('42', '43').length && original !== original.replace('42', '43'),
			run_with_the_blob_damaged: damaged,
			run_with_the_blob_removed: missing,
			compute_calls_before_the_damaged_run: callsBeforeDamagedRun,
			compute_calls_after_both_failed_runs: computeCalls,
			index_entry_still_present: parts.cacheIndex.get(cacheKey) !== null
		};
	});
}

// The key below is deliberately independent of the file contents, so the only thing that can retire the entry is the
// invalidation step that the caller runs after comparing two file indexes.
export async function invalidatedEntryNotReused() {
	return inTemp(async (root) => {
		const repo = path.join(root, 'repo');
		write(repo, 'src/a.js', 'one\n');
		write(repo, 'src/b.js', 'two\n');
		const parts = cacheParts(repo);
		const cacheKey = buildScanCacheKey(keyInput());
		const calls = [];
		const run = async (label, dependencies) => {
			const result = await runCachedTask({ ...parts, cacheKey, dependencies, compute: async () => { calls.push(label); return { computed_for: label }; } });
			return { cache_hit: result.cache_hit, value: result.value };
		};
		const before = buildFileIndex(repo);
		const dependencies = before.entries.map((entry) => entry.path);
		const firstRun = await run('before the edit', dependencies);
		const secondRun = await run('second run', dependencies);
		write(repo, 'src/a.js', 'one, edited\n');
		const after = buildFileIndex(repo);
		const decision = computeInvalidation({ previousIndex: before, nextIndex: after });
		const staleStillServedWithoutInvalidation = await run('stale, before invalidation', dependencies);
		const unrelated = parts.cacheIndex.invalidateDependencies(['src/not-a-dependency.js']);
		const removed = parts.cacheIndex.invalidateDependencies(decision.invalidated);
		const afterInvalidation = await run('after the edit', dependencies);
		const thenCached = await run('after the edit, again', dependencies);
		return {
			source_digest_changed: before.source_digest !== after.source_digest,
			invalidation_decision: decision,
			first_run: firstRun,
			second_run: secondRun,
			a_key_that_ignores_the_files_serves_the_old_entry_until_it_is_invalidated: staleStillServedWithoutInvalidation,
			invalidating_a_path_nothing_depends_on_removes_nothing: unrelated.length,
			removed_entries: removed.map((entry) => ({ dependencies: entry.dependencies, artifact_size: entry.artifact.size })),
			run_after_invalidation: afterInvalidation,
			run_after_invalidation_then_cached: thenCached,
			compute_calls: calls
		};
	});
}

// ---- scheduler ---------------------------------------------------------------------------------------------------

// Workers only await already-resolved promises: no timer, no I/O, so the order of events depends on the scheduler alone.
async function observe(tasks, options, behaviour = () => undefined) {
	const started = [];
	const finished = [];
	const result = await runTaskGraph(tasks, async (task) => {
		started.push(task.id);
		await Promise.resolve();
		const value = await behaviour(task);
		finished.push(task.id);
		return value === undefined ? `done ${task.id}` : value;
	}, options);
	return { started, finished, results: result.results, metrics: result.metrics };
}

const diamond = () => [{ id: 'd', dependsOn: ['b', 'a'] }, { id: 'a', dependsOn: ['c'] }, { id: 'c' }, { id: 'b' }];

export async function schedulerOrdering() {
	const one = await observe(diamond(), { maxConcurrency: 1 });
	const two = await observe(diamond(), { maxConcurrency: 2 });
	const reversedInput = await observe(diamond().reverse(), { maxConcurrency: 1 });
	const repeated = [];
	for (let i = 0; i < 10; i++) repeated.push(stableJson(await observe(diamond(), { maxConcurrency: 2 })));
	return {
		one_at_a_time: one,
		two_at_a_time: two,
		reversing_the_input_order_does_not_change_the_one_at_a_time_run: stableJson(reversedInput) === stableJson(one),
		ten_runs_with_two_workers_are_identical: new Set(repeated).size === 1,
		result_ids_are_sorted_not_in_start_order: one.results.map((entry) => entry.id).join(',') === [...one.results.map((entry) => entry.id)].sort().join(',')
	};
}

export async function schedulerBudgetBlocked() {
	const budget = await observe([
		{ id: 'small', estimatedBytes: 10 },
		{ id: 'huge', estimatedBytes: 1000 },
		{ id: 'after-huge', dependsOn: ['huge'], estimatedBytes: 1 },
		{ id: 'after-small', dependsOn: ['small'], estimatedBytes: 10 }
	], { maxConcurrency: 4, maxEstimatedBytesInFlight: 100 });
	const deferred = await observe([{ id: 'x', estimatedBytes: 600 }, { id: 'y', estimatedBytes: 600 }], { maxConcurrency: 4, maxEstimatedBytesInFlight: 1000 });
	const exactly = await observe([{ id: 'exact', estimatedBytes: 100 }], { maxConcurrency: 1, maxEstimatedBytesInFlight: 100 });
	return {
		task_over_the_budget_and_its_dependent: budget,
		two_tasks_that_do_not_fit_together: {
			started: deferred.started,
			finished: deferred.finished,
			statuses: deferred.results.map((entry) => `${entry.id}:${entry.status}`),
			peak_estimated_bytes_in_flight: deferred.metrics.peak_estimated_bytes_in_flight,
			peak_concurrency: deferred.metrics.peak_concurrency,
			byte_admission_deferrals_at_least_one: deferred.metrics.byte_admission_deferrals >= 1
		},
		task_exactly_at_the_budget_runs: { statuses: exactly.results.map((entry) => `${entry.id}:${entry.status}`), started: exactly.started }
	};
}

export async function schedulerFailurePropagation() {
	const result = await observe([
		{ id: 'broken' },
		{ id: 'throws-text' },
		{ id: 'needs-broken', dependsOn: ['broken'] },
		{ id: 'needs-needs-broken', dependsOn: ['needs-broken'] },
		{ id: 'independent' }
	], { maxConcurrency: 1 }, (task) => {
		if (task.id === 'broken') throw new Error('worker failed');
		if (task.id === 'throws-text') throw 'plain text';
		return undefined;
	});
	return {
		started: result.started,
		results: result.results,
		blocked_tasks_never_reach_the_worker: !result.started.includes('needs-broken') && !result.started.includes('needs-needs-broken'),
		metrics: result.metrics
	};
}

export async function schedulerGraphRefusals() {
	let workerCalls = 0;
	const worker = async () => {
		workerCalls += 1;
	};
	const refuse = (tasks, options, run = worker) => attemptAsync(() => runTaskGraph(tasks, run, options));
	const out = {
		duplicate_id: await refuse([{ id: 'a' }, { id: 'a' }]),
		missing_dependency: await refuse([{ id: 'a', dependsOn: ['ghost'] }]),
		self_dependency: await refuse([{ id: 'a', dependsOn: ['a'] }]),
		cycle: await refuse([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]),
		empty_id: await refuse([{ id: '' }]),
		task_is_not_an_object: await refuse([null]),
		depends_on_not_an_array: await refuse([{ id: 'a', dependsOn: 'b' }]),
		estimated_bytes_negative: await refuse([{ id: 'a', estimatedBytes: -1 }]),
		estimated_bytes_fractional: await refuse([{ id: 'a', estimatedBytes: 1.5 }]),
		tasks_not_an_array: await refuse({ id: 'a' }),
		worker_not_a_function: await refuse([{ id: 'a' }], undefined, 'worker'),
		max_concurrency_zero: await refuse([{ id: 'a' }], { maxConcurrency: 0 }),
		max_concurrency_fractional: await refuse([{ id: 'a' }], { maxConcurrency: 1.5 }),
		budget_zero: await refuse([{ id: 'a' }], { maxEstimatedBytesInFlight: 0 })
	};
	return { ...out, worker_calls_during_all_refusals: workerCalls };
}

// ---- memory admission --------------------------------------------------------------------------------------------

const GIB = 1024 ** 3;

// Pure arithmetic on the numbers passed in: nothing is read from the host.
export async function memoryAdmissionDecisions() {
	const admit = (input) => deriveMemoryAdmission(input);
	const refuse = (input) => attempt(() => deriveMemoryAdmission(input));
	return {
		large_host: admit({ totalBytes: 64 * GIB }),
		small_host_is_blocked: admit({ totalBytes: 4 * GIB }),
		exactly_the_minimum_reserve_is_blocked: admit({ totalBytes: 8 * GIB }),
		one_byte_over_the_minimum_reserve_is_ready: admit({ totalBytes: 8 * GIB + 1 }),
		admission_is_capped: admit({ totalBytes: 64 * GIB, maxAdmissionBytes: 10 * GIB }),
		a_cap_of_zero_blocks: admit({ totalBytes: 64 * GIB, maxAdmissionBytes: 0 }),
		a_cap_above_the_available_memory_changes_nothing: admit({ totalBytes: 64 * GIB, maxAdmissionBytes: 100 * GIB }),
		no_memory_at_all: admit({ totalBytes: 0 }),
		the_minimum_reserve_wins_on_a_mid_size_host: admit({ totalBytes: 16 * GIB, reserveFraction: 0.1 }),
		no_reserve_at_all: admit({ totalBytes: 1000, reserveFraction: 0, minReserveBytes: 0 }),
		the_fractional_reserve_is_rounded_up: admit({ totalBytes: 10, reserveFraction: 0.25, minReserveBytes: 0 }),
		refusals: {
			no_arguments: attempt(() => deriveMemoryAdmission()),
			total_missing: refuse({}),
			total_negative: refuse({ totalBytes: -1 }),
			total_fractional: refuse({ totalBytes: 1.5 }),
			total_text: refuse({ totalBytes: '1024' }),
			total_beyond_the_safe_integers: refuse({ totalBytes: 2 ** 53 }),
			fraction_of_one: refuse({ totalBytes: GIB, reserveFraction: 1 }),
			fraction_negative: refuse({ totalBytes: GIB, reserveFraction: -0.1 }),
			fraction_not_a_number: refuse({ totalBytes: GIB, reserveFraction: Number.NaN }),
			fraction_text: refuse({ totalBytes: GIB, reserveFraction: '0.5' }),
			minimum_reserve_negative: refuse({ totalBytes: GIB, minReserveBytes: -1 }),
			cap_negative: refuse({ totalBytes: GIB, maxAdmissionBytes: -1 }),
			cap_fractional: refuse({ totalBytes: GIB, maxAdmissionBytes: 0.5 })
		}
	};
}

// ---- performance gate --------------------------------------------------------------------------------------------

// Only decisions that need no measured figure: the gate stops at identity, sample count and semantic checks before it
// compares any timing or memory value. No candidate here carries a duration or a memory figure.
export async function performanceGateDecisions() {
	const environment = (over = {}) => ({ profile_id: 'profile-a', platform: 'linux', arch: 'x64', node_major: 22, ...over });
	const workload = (id, over = {}) => ({ id, samples: 5, semantic_equivalence: true, ...over });
	const decide = (baseline, candidate, policy) => {
		try {
			const gate = evaluatePerformanceGate({ baseline, candidate, policy });
			return { status: gate.status, checks: gate.checks.map((check) => [check.code, check.status, check.workload]) };
		} catch (error) {
			return { threw: refusal(error) };
		}
	};
	const base = (workloads) => ({ environment: environment(), workloads });
	return {
		no_environment_identity: decide({ workloads: [workload('w1')] }, base([workload('w1')])),
		environment_differs: decide(base([workload('w1')]), { environment: environment({ node_major: 24 }), workloads: [workload('w1')] }),
		workload_missing_on_one_side: decide(base([workload('w1'), workload('w2')]), base([workload('w1')])),
		too_few_samples: decide(base([workload('w1')]), base([workload('w1', { samples: 4 })])),
		semantic_mismatch: decide(base([workload('w1')]), base([workload('w1', { semantic_equivalence: false })])),
		semantic_equivalence_unproven: decide(base([workload('w1')]), base([workload('w1', { semantic_equivalence: undefined })])),
		metrics_missing: decide(base([workload('w1')]), base([workload('w1')])),
		one_blocked_and_one_failed_check: decide(base([workload('w1'), workload('w2')]), base([workload('w1', { samples: 1 }), workload('w2', { semantic_equivalence: false })])),
		duplicate_workload_id: decide(base([workload('w1')]), base([workload('w1'), workload('w1')])),
		workloads_not_an_array: decide(base([workload('w1')]), { environment: environment() }),
		workload_without_id: decide(base([workload('w1')]), base([{ samples: 5 }])),
		policy_min_samples_zero: decide(base([workload('w1')]), base([workload('w1')]), { minSamples: 0 }),
		policy_negative_threshold: decide(base([workload('w1')]), base([workload('w1')]), { maxColdRegressionPct: -1 })
	};
}

// ---- project cache plan ------------------------------------------------------------------------------------------

const manifest = (file, text) => ({ path: file, kind: 'manifest', digest: `sha256:${sha256Bytes(text)}` });

// A draft project graph written out by hand (plain data, portable repo_root), the shape T02 documents.
function planGraph() {
	const project = (id, root, kind, selected, fallback, markers) => ({
		project_id: id, root, kind, markers, facets: { http: { selected_adapter: selected } }, fallback_adapter: fallback
	});
	return {
		schema: 'sbf.project-graph/draft-1',
		repo_root: '.',
		projects: [
			project('project:web', 'apps/web', 'application', 'typescript-express', null, [manifest('apps/web/package.json', 'web')]),
			project('project:api', 'apps/api', 'application', 'java-spring', null, [manifest('apps/api/build.gradle', 'api')]),
			project('project:shared', 'libs/shared', 'library', null, 'javascript-express', [manifest('libs/shared/package.json', 'shared')]),
			project('project:upper', 'Apps/upper', 'application', 'ruby-rails', null, []),
			project('project:root', '.', 'aggregate', null, 'python-fastapi', [])
		],
		project_edges: [
			{ kind: 'local-package-dependency', from_project_id: 'project:web', to_project_id: 'project:shared', evidence: [] },
			{ kind: 'local-package-dependency', from_project_id: 'project:api', to_project_id: 'project:shared', evidence: [] },
			{ kind: 'contains', from_project_id: 'project:root', to_project_id: 'project:web', evidence: [] },
			{ kind: 'contains', from_project_id: 'project:root', to_project_id: 'project:api', evidence: [] }
		],
		unresolved: [],
		files_read: []
	};
}

const planRows = (plan) => plan.projects.map((entry) => [entry.project_id, entry.project_root, entry.adapter_id, entry.mode, entry.dependency_project_ids.join(',')]);

function namespacesThatMoved(before, after) {
	const next = new Map(after.projects.map((entry) => [entry.project_id, entry.cache_namespace]));
	return before.projects.filter((entry) => next.get(entry.project_id) !== entry.cache_namespace).map((entry) => entry.project_id);
}

export async function projectCachePlanDecisions() {
	const plan = buildProjectCachePlan(planGraph());
	const withFallback = buildProjectCachePlan(planGraph(), { includeFallback: true });
	const shuffled = planGraph();
	shuffled.projects.reverse();
	shuffled.project_edges.reverse();
	const editedMarker = planGraph();
	editedMarker.projects[0].markers[0] = manifest('apps/web/package.json', 'web, edited');
	const editedSharedMarker = planGraph();
	editedSharedMarker.projects[2].markers[0] = manifest('libs/shared/package.json', 'shared, edited');
	const edgeRemoved = planGraph();
	edgeRemoved.project_edges = edgeRemoved.project_edges.filter((edge) => edge.from_project_id !== 'project:web' || edge.kind !== 'local-package-dependency');
	const propagate = (ids) => {
		try {
			return propagateProjectInvalidation(planGraph(), ids);
		} catch (error) {
			return { threw: refusal(error) };
		}
	};
	const refuse = (mutate) => {
		const graph = planGraph();
		mutate(graph);
		return attempt(() => buildProjectCachePlan(graph));
	};
	return {
		plan_schema: plan.schema,
		graph_schema: plan.graph_schema,
		without_fallback: planRows(plan),
		with_fallback: planRows(withFallback),
		every_namespace_is_a_sha256_digest: [...plan.projects, ...withFallback.projects].every((entry) => /^[0-9a-f]{64}$/.test(entry.cache_namespace)),
		input_order_does_not_change_the_plan: stableJson(buildProjectCachePlan(shuffled)) === stableJson(plan),
		editing_a_marker_moves_only_that_projects_namespace: namespacesThatMoved(plan, buildProjectCachePlan(editedMarker)),
		editing_a_dependency_marker_does_not_move_its_consumers: namespacesThatMoved(withFallback, buildProjectCachePlan(editedSharedMarker, { includeFallback: true })),
		removing_a_dependency_edge_moves_the_consumer: namespacesThatMoved(plan, buildProjectCachePlan(edgeRemoved)),
		invalidation_from_the_shared_library: propagate(['project:shared']),
		invalidation_from_a_consumer: propagate(['project:web']),
		invalidation_ignores_containment: propagate(['project:root']),
		invalidation_from_nothing: propagate([]),
		invalidation_of_an_unknown_project: propagate(['project:ghost']),
		invalidation_ids_not_an_array: propagate('project:web'),
		graph_refusals: {
			not_an_object: attempt(() => buildProjectCachePlan(null)),
			wrong_schema: refuse((graph) => { graph.schema = 'sbf.project-graph/draft-2'; }),
			projects_not_an_array: refuse((graph) => { graph.projects = {}; }),
			project_without_root: refuse((graph) => { delete graph.projects[0].root; }),
			duplicate_project_id: refuse((graph) => { graph.projects[1].project_id = graph.projects[0].project_id; }),
			edge_without_kind: refuse((graph) => { delete graph.project_edges[0].kind; }),
			edge_to_unknown_project: refuse((graph) => { graph.project_edges[0].to_project_id = 'project:ghost'; })
		}
	};
}

// ---- shadow scans over the pinned fixture repositories ----------------------------------------------------------------

// A copy of a pinned fixture directory with every file set to 0644. The file mode is part of a file-index entry and a
// checkout need not keep the committed mode, so a recorded source_digest must not depend on it.
function installFixture(into, rel) {
	const target = path.join(into, rel);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.cpSync(path.join(REPO, rel), target, { recursive: true });
	for (const file of filesUnder(target)) fs.chmodSync(path.join(target, file), 0o644);
	return target;
}

function adapterNamed(id) {
	const adapter = ADAPTERS.find((candidate) => candidate.id === id);
	if (!adapter) throw new Error(`shipped adapter not found: ${id}`);
	return adapter;
}

// The scan report holds absolute paths, so a report is only ever compared, never recorded; the same goes for the artifact
// digest, which is the digest of those bytes. What is recorded is the cache key (its inputs are all fixed here), the
// source digest and booleans.
export async function legacyScanCacheShadow() {
	return inTemp(async (root) => {
		const repoRoot = installFixture(root, 'test/fixtures/javascript-express/backend');
		const cacheRoot = path.join(root, 'cache');
		fs.mkdirSync(cacheRoot);
		const adapter = adapterNamed('javascript-express');
		const implementationDigest = digestOf('implementation:javascript-express');
		const call = (over = {}) => runLegacyScanCached({ repoRoot, cacheRoot, adapter, terms: [], implementationDigest, runtimeFingerprint: 'node-24/linux-x64', ...over });
		const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

		const off = await call({ useCache: false });
		const missed = await call();
		const hit = await call();
		const store = createArtifactStore(path.join(cacheRoot, '.sbf', 'cache-next', 'artifacts'));
		const entries = createCacheIndex(cacheRoot).list();
		const indexedPaths = buildFileIndex(repoRoot).entries.map((entry) => entry.path).sort();
		const afterFirstThree = {
			off: { cache_used: off.cache_used, cache_hit: off.cache_hit, artifact: off.artifact },
			missed: { cache_used: missed.cache_used, cache_hit: missed.cache_hit, artifact_algorithm: missed.artifact.algorithm, artifact_size_is_positive: missed.artifact.size > 0 },
			hit: { cache_used: hit.cache_used, cache_hit: hit.cache_hit },
			result_schema: hit.schema,
			report_schema: hit.report.schema,
			report_adapter: hit.report.adapter,
			one_cache_key_for_off_miss_and_hit: off.cache_key === missed.cache_key && missed.cache_key === hit.cache_key,
			one_source_digest_for_off_miss_and_hit: off.source_digest === missed.source_digest && missed.source_digest === hit.source_digest,
			cache_key: off.cache_key,
			source_digest: off.source_digest,
			miss_and_hit_reports_serialise_exactly_like_the_uncached_report: same(missed.report, off.report) && same(hit.report, off.report),
			hit_artifact_is_the_miss_artifact: same(hit.artifact, missed.artifact),
			index_entries: entries.length,
			index_key_is_the_cache_key: entries[0].cache_key === off.cache_key,
			index_artifact_is_the_returned_artifact: same(entries[0].artifact, missed.artifact),
			index_dependencies_are_every_indexed_file: indexedPaths.length > 0 && same([...entries[0].dependencies].sort(), indexedPaths),
			index_metadata: entries[0].metadata,
			store_blob_count: filesUnder(store.root).length
		};

		const drift = {
			other_terms_give_another_key: (await call({ terms: ['user'], useCache: false })).cache_key !== off.cache_key,
			other_implementation_digest_gives_another_key: (await call({ implementationDigest: digestOf('implementation:changed'), useCache: false })).cache_key !== off.cache_key,
			other_runtime_fingerprint_gives_another_key: (await call({ runtimeFingerprint: 'node-22/linux-x64', useCache: false })).cache_key !== off.cache_key,
			other_cache_namespace_gives_another_key: (await call({ cacheNamespace: digestOf('namespace'), useCache: false })).cache_key !== off.cache_key
		};
		const otherTerms = await call({ terms: ['user'] });
		const afterOtherTerms = { cache_hit: otherTerms.cache_hit, index_entries: createCacheIndex(cacheRoot).list().length, store_blob_count: filesUnder(store.root).length };

		const refuse = (over) => attemptAsync(() => call(over));
		const refusals = {
			missing_implementation_digest: await refuse({ implementationDigest: undefined }),
			uppercase_implementation_digest: await refuse({ implementationDigest: 'A'.repeat(64) }),
			terms_not_an_array: await refuse({ terms: 'user' }),
			cache_namespace_not_a_digest: await refuse({ cacheNamespace: 'namespace' }),
			policy_fingerprint_not_a_digest: await refuse({ policyFingerprint: 'policy' }),
			adapter_missing: await refuse({ adapter: undefined }),
			repo_root_missing: await attemptAsync(() => runLegacyScanCached({ cacheRoot, adapter, implementationDigest }))
		};

		// Damage every stored blob (cut each to ten bytes): the next cached call must refuse, and the uncached call still scans.
		for (const file of filesUnder(store.root)) fs.writeFileSync(path.join(store.root, file), fs.readFileSync(path.join(store.root, file)).subarray(0, 10));
		const damaged = await refuse({});
		const damagedOutcome = damaged.threw
			? { threw: { name: damaged.threw.name, code: damaged.threw.code, message_prefix: damaged.threw.message.split(':')[0] } }
			: damaged;
		const bypass = await call({ useCache: false });
		return {
			...afterFirstThree,
			drift,
			after_other_terms_through_the_cache: afterOtherTerms,
			refusals,
			after_damaging_every_stored_blob: { cached_call: damagedOutcome, uncached_call_still_scans: bypass.cache_used === false && same(bypass.report, off.report) }
		};
	});
}

// The cache key holds file digests and no repository location, so a copied tree (cache included) hits the cache; this scenario records
// what that hit returns. Only booleans, counts and relative pointers are recorded, never an absolute path.
export async function legacyCacheServedFromACopiedTree() {
	return inTemp(async (root) => {
		const original = path.join(root, 'original');
		const relocated = path.join(root, 'relocated');
		fs.mkdirSync(original);
		installFixture(original, 'test/fixtures/javascript-express/backend');
		const adapter = adapterNamed('javascript-express');
		const implementationDigest = digestOf('implementation:javascript-express');
		const call = (base, over = {}) => runLegacyScanCached({ repoRoot: path.join(base, 'test', 'fixtures', 'javascript-express', 'backend'), cacheRoot: base, adapter, terms: [], implementationDigest, runtimeFingerprint: 'node-24/linux-x64', ...over });
		const pointersNaming = (value, tree, at = '') => {
			if (typeof value === 'string') return value.includes(tree) ? [at] : [];
			if (Array.isArray(value)) return value.flatMap((item, index) => pointersNaming(item, tree, `${at}/${index}`));
			if (value && typeof value === 'object') return Object.keys(value).flatMap((key) => pointersNaming(value[key], tree, `${at}/${key}`));
			return [];
		};
		const namesTree = (value, tree) => pointersNaming(value, tree).length > 0;
		const rewritten = (value, from, to) => {
			if (typeof value === 'string') return value.split(from).join(to);
			if (Array.isArray(value)) return value.map((item) => rewritten(item, from, to));
			if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).map((key) => [key, rewritten(value[key], from, to)]));
			return value;
		};

		const created = await call(original);
		const reused = await call(original);
		fs.cpSync(original, relocated, { recursive: true });
		const served = await call(relocated);
		const uncachedHere = await call(relocated, { useCache: false });
		return {
			first_call_in_the_original_tree: { cache_hit: created.cache_hit },
			second_call_in_the_original_tree: { cache_hit: reused.cache_hit },
			call_in_the_copied_tree: { cache_hit: served.cache_hit, same_cache_key_as_the_original: served.cache_key === created.cache_key },
			original_report_names_the_original_tree: namesTree(created.report, original),
			served_report_names_the_original_tree: namesTree(served.report, original),
			served_report_names_the_copied_tree: namesTree(served.report, relocated),
			uncached_report_of_the_copy_names_the_copied_tree: namesTree(uncachedHere.report, relocated),
			served_report_equals_the_uncached_report_of_the_copy: JSON.stringify(served.report) === JSON.stringify(uncachedHere.report),
			served_report_equals_the_uncached_report_once_the_original_path_is_rewritten: JSON.stringify(rewritten(served.report, original, relocated)) === JSON.stringify(uncachedHere.report),
			fields_that_carry_the_original_path: pointersNaming(served.report, original)
		};
	});
}

const SPRING_ROOT = 'test/fixtures/java-spring';
const FASTAPI_ROOT = 'test/fixtures/python-fastapi/backend';

function digestSummary(report) {
	return report.results.map((entry) => ({ id: entry.id, status: entry.status, cache_hit: entry.status === 'passed' ? entry.value.cache_hit : null }));
}

export async function projectGraphCachedRun() {
	return inTemp(async (root) => {
		const repoRoot = path.join(root, 'repo');
		fs.mkdirSync(repoRoot);
		for (const rel of [SPRING_ROOT, FASTAPI_ROOT]) installFixture(repoRoot, rel);
		const markerOf = (rel) => ({ path: rel, kind: 'manifest', digest: `sha256:${sha256Bytes(fs.readFileSync(path.join(repoRoot, rel)))}` });
		const graph = () => ({
			schema: 'sbf.project-graph/draft-1',
			repo_root: '.',
			projects: [
				{ project_id: 'project:spring', root: SPRING_ROOT, kind: 'application', markers: [markerOf(`${SPRING_ROOT}/build.gradle`)], facets: { http: { selected_adapter: 'java-spring' } }, fallback_adapter: null },
				{ project_id: 'project:fastapi', root: FASTAPI_ROOT, kind: 'application', markers: [markerOf(`${FASTAPI_ROOT}/pyproject.toml`)], facets: { http: { selected_adapter: 'python-fastapi' } }, fallback_adapter: null },
				{ project_id: 'project:aggregate', root: '.', kind: 'aggregate', markers: [], facets: { http: { selected_adapter: null } }, fallback_adapter: 'generic-grep' }
			],
			project_edges: [
				{ kind: 'local-package-dependency', from_project_id: 'project:fastapi', to_project_id: 'project:spring', evidence: [] },
				{ kind: 'contains', from_project_id: 'project:aggregate', to_project_id: 'project:spring', evidence: [] },
				{ kind: 'contains', from_project_id: 'project:aggregate', to_project_id: 'project:fastapi', evidence: [] }
			],
			unresolved: [],
			files_read: []
		});
		const implementationDigests = { 'java-spring': digestOf('implementation:java-spring'), 'python-fastapi': digestOf('implementation:python-fastapi') };
		const run = (over = {}) => runProjectGraphCached({ repoRoot, cacheRoot: repoRoot, graph: graph(), adapters: ADAPTERS, implementationDigests, ...over });
		const refuse = async (over) => {
			try {
				await run(over);
				return { returned: true };
			} catch (error) {
				return { threw: refusal(error, scrubber(root)) };
			}
		};
		const reportsOf = (report) => report.results.map((entry) => JSON.stringify(entry.value.report));
		const counts = (report) => ({ tasks: report.metrics.tasks, passed: report.metrics.passed, failed: report.metrics.failed, blocked: report.metrics.blocked });

		const miss = await run();
		const hit = await run();
		const off = await run({ useCache: false });
		const first = {
			schema: miss.schema,
			graph_schema: miss.graph_schema,
			plan_schema: miss.plan_schema,
			miss: digestSummary(miss),
			hit: digestSummary(hit),
			off: digestSummary(off),
			miss_metrics: counts(miss),
			reports_of_miss_hit_and_off_serialise_identically: reportsOf(miss).join('\n') === reportsOf(hit).join('\n') && reportsOf(hit).join('\n') === reportsOf(off).join('\n'),
			hit_artifacts_are_the_miss_artifacts: miss.results.every((entry, i) => stableJson(entry.value.artifact) === stableJson(hit.results[i].value.artifact)),
			namespaces_differ_between_projects: new Set(miss.results.map((entry) => entry.value.cache_namespace)).size === miss.results.length
		};

		const refusals = {
			planned_adapter_missing: await refuse({ adapters: ADAPTERS.filter((adapter) => adapter.id !== 'java-spring') }),
			implementation_digest_missing: await refuse({ implementationDigests: { 'python-fastapi': implementationDigests['python-fastapi'] } }),
			graph_repo_root_is_another_directory: await refuse({ graph: { ...graph(), repo_root: path.join(root, 'elsewhere') } }),
			project_root_outside_the_repository: await refuse({ graph: { ...graph(), projects: [{ ...graph().projects[0], root: '../outside', markers: [] }], project_edges: [] } }),
			implementation_digests_missing: await refuse({ implementationDigests: undefined }),
			graph_of_another_schema: await refuse({ graph: { ...graph(), schema: 'sbf.project-graph/draft-2' } })
		};

		// A marker file edited after the graph was built: the old graph is refused, a fresh graph re-scans only the edited
		// project (its source digest moved, so its old cache key no longer matches) and still reuses the other one.
		const staleGraph = graph();
		fs.appendFileSync(path.join(repoRoot, FASTAPI_ROOT, 'pyproject.toml'), '\n# edited after discovery\n');
		const stale = await refuse({ graph: staleGraph });
		const afterEdit = await run();

		// Every stored blob cut to ten bytes: both projects fail (their cached artifacts no longer match their refs) and nothing is served.
		const store = createArtifactStore(path.join(repoRoot, '.sbf', 'cache-next', 'artifacts'));
		const blobs = filesUnder(store.root);
		for (const file of blobs) fs.writeFileSync(path.join(store.root, file), fs.readFileSync(path.join(store.root, file)).subarray(0, 10));
		const damaged = await run();
		return {
			...first,
			refusals,
			stale_marker: { old_graph: stale, fresh_graph: digestSummary(afterEdit), fresh_graph_metrics: counts(afterEdit) },
			after_damaging_every_stored_blob: {
				blobs_damaged: blobs.length,
				results: damaged.results.map((entry) => ({ id: entry.id, status: entry.status, error_prefix: entry.status === 'failed' ? entry.error.split(':')[0] : null })),
				metrics: counts(damaged)
			}
		};
	});
}

// ---- counterexamples found while grounding the interface document -------------------------------------------------------

// Like installFixture, but the pinned fixture directory becomes the target itself instead of being nested under it.
function copyFixtureTo(target, rel) {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.cpSync(path.join(REPO, rel), target, { recursive: true });
	for (const file of filesUnder(target)) fs.chmodSync(path.join(target, file), 0o644);
	return target;
}

// The file index never enters a directory whose name is in DEFAULT_EXCLUDED_DIRS (at any depth), but a stable adapter lists the
// files it reads with its own rules: the python-fastapi adapter passes ripgrep four exclusion globs (.venv, site-packages,
// node_modules, __pycache__). One new router file is added in turn under each name the index skips (and, as the control, under a
// name it reads) of an otherwise unchanged project. Where the adapter reads the file and the index does not, the source digest
// and the cache key do not move and the cached call is a hit that serves the report from before the change; where both skip the
// directory the old report is still right.
export async function legacyCacheStaleHitInAnExcludedDirectory() {
	return inTemp(async (root) => {
		const adapter = adapterNamed('python-fastapi');
		const implementationDigest = digestOf('implementation:python-fastapi');
		const route = '/stale-probe-route';
		const mentions = (report) => JSON.stringify(report).includes(route);
		const routerFile = `from fastapi import APIRouter\nrouter = APIRouter()\n\n@router.get("${route}")\ndef stale_probe_route():\n    return {}\n`;
		const trial = async (folder, directoryName) => {
			const repoRoot = path.join(root, folder, 'repo');
			const cacheRoot = path.join(root, folder, 'cache');
			fs.mkdirSync(cacheRoot, { recursive: true });
			copyFixtureTo(repoRoot, FASTAPI_ROOT);
			const call = (over = {}) => runLegacyScanCached({ repoRoot, cacheRoot, adapter, terms: [], implementationDigest, runtimeFingerprint: 'node-24/linux-x64', ...over });
			const before = buildFileIndex(repoRoot);
			const created = await call();
			write(repoRoot, `app/api/${directoryName}/stale_probe_router.py`, routerFile);
			const after = buildFileIndex(repoRoot);
			const uncached = await call({ useCache: false });
			const cached = await call();
			const index = createCacheIndex(cacheRoot);
			return {
				the_new_file_is_indexed: after.entries.length === before.entries.length + 1,
				source_digest_moved: after.source_digest !== before.source_digest,
				cache_key_moved: uncached.cache_key !== created.cache_key,
				uncached_report_has_the_route: mentions(uncached.report),
				cached_call: { cache_hit: cached.cache_hit },
				cached_report_has_the_route: mentions(cached.report),
				served_a_report_that_misses_the_route: cached.cache_hit && mentions(uncached.report) && !mentions(cached.report),
				index_entries: index.list().length,
				artifacts_reachable_from_the_index: index.reachableArtifactRefs().length
			};
		};
		const byName = {};
		for (const name of DEFAULT_EXCLUDED_DIRS) byName[name] = await trial(`excluded-${name.replace(/^\./, 'dot-')}`, name);
		const names = Object.keys(byName);
		return {
			directory_names_the_index_never_enters: [...DEFAULT_EXCLUDED_DIRS],
			excluded_names: byName,
			control_a_name_the_index_reads: await trial('control', 'routers'),
			names_where_a_stale_report_was_served: names.filter((name) => byName[name].served_a_report_that_misses_the_route),
			names_where_index_and_adapter_agree: names.filter((name) => !byName[name].served_a_report_that_misses_the_route)
		};
	});
}

// runProjectGraphCached resolves a project root against the repository root with path.resolve and path.relative only (it holds
// no realpath), so a symlink inside the repository that points outside it is followed: the project behind it is indexed and
// scanned. A root that leaves the repository lexically is refused.
export async function projectRootSymlinkIsFollowed() {
	return inTemp(async (root) => {
		const outside = path.join(root, 'outside');
		copyFixtureTo(outside, FASTAPI_ROOT);
		const repoRoot = path.join(root, 'repo');
		fs.mkdirSync(repoRoot);
		fs.symlinkSync(outside, path.join(repoRoot, 'linked'));
		const graph = (projectRoot, markerPath) => ({
			schema: 'sbf.project-graph/draft-1',
			repo_root: '.',
			projects: [{ project_id: 'project:linked', root: projectRoot, kind: 'application', markers: markerPath ? [{ path: markerPath, kind: 'manifest', digest: `sha256:${sha256Bytes(fs.readFileSync(path.join(repoRoot, markerPath)))}` }] : [], facets: { http: { selected_adapter: 'python-fastapi' } }, fallback_adapter: null }],
			project_edges: [],
			unresolved: [],
			files_read: []
		});
		const run = (over) => runProjectGraphCached({ repoRoot, cacheRoot: repoRoot, adapters: ADAPTERS, implementationDigests: { 'python-fastapi': digestOf('implementation:python-fastapi') }, useCache: false, ...over });
		const through = await run({ graph: graph('linked', 'linked/pyproject.toml') });
		const dotdot = await attemptAsync(() => run({ graph: graph('../outside', null) }), scrubber(root));
		const realRepo = fs.realpathSync(repoRoot);
		const realTarget = fs.realpathSync(path.join(repoRoot, 'linked'));
		return {
			the_link_target_is_outside_the_repository_root: path.relative(realRepo, realTarget).startsWith('..'),
			through_the_link: {
				statuses: through.results.map((entry) => entry.status),
				metrics: { tasks: through.metrics.tasks, passed: through.metrics.passed, failed: through.metrics.failed, blocked: through.metrics.blocked },
				indexed_files_are_those_of_the_outside_tree: through.results[0].status === 'passed' && through.results[0].value.source_digest === buildFileIndex(outside).source_digest,
				report_holds_a_route_of_the_outside_tree: JSON.stringify(through.results[0].value?.report).includes('/items')
			},
			a_root_that_leaves_the_repository_lexically: dotdot
		};
	});
}
