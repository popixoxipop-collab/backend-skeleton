import fs from 'node:fs';
import path from 'node:path';
import { withLockSync } from '../lock.mjs';
import { writeFileAtomic } from '../fsutil.mjs';
import { stableJson } from '../scan-scheduler-next/cache-key.mjs';

const SHA256_RE = /^[0-9a-f]{64}$/;
const SCHEMA = 'sbf.scan-cache-index/1';

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function requireDigest(label, value) {
	if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new TypeError(`${label} must be a lowercase sha256 digest`);
	return value;
}

function requireArtifactRef(ref) {
	if (!ref || ref.algorithm !== 'sha256') throw new TypeError('artifact ref must use sha256');
	requireDigest('artifact digest', ref.digest);
	if (!Number.isInteger(ref.size) || ref.size < 0) throw new TypeError('artifact size must be a non-negative integer');
	return { algorithm: 'sha256', digest: ref.digest, size: ref.size };
}

function emptyState() {
	return { schema: SCHEMA, entries: {} };
}

function validateState(value) {
	if (!value || value.schema !== SCHEMA || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
		throw new Error(`invalid cache index: expected ${SCHEMA}`);
	}
	for (const [key, entry] of Object.entries(value.entries)) {
		requireDigest('cache key', key);
		if (!entry || typeof entry !== 'object') throw new Error(`invalid cache index entry: ${key}`);
		requireArtifactRef(entry.artifact);
		if (!Array.isArray(entry.dependencies) || entry.dependencies.some((x) => typeof x !== 'string')) {
			throw new Error(`invalid cache index dependencies: ${key}`);
		}
	}
	return value;
}

function normalizeKey(cacheKey) {
	return requireDigest('cache key', typeof cacheKey === 'string' ? cacheKey : cacheKey?.digest);
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

export function createCacheIndex(repoRoot, { relativePath = '.sbf/cache-next/index.json', lockName = 't21-cache-index' } = {}) {
	const root = path.resolve(repoRoot);
	const statePath = path.resolve(root, relativePath);
	const rel = path.relative(root, statePath);
	if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('cache index path must stay inside repoRoot');

	function load() {
		if (!fs.existsSync(statePath)) return emptyState();
		return validateState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
	}

	function save(state) {
		validateState(state);
		writeFileAtomic(statePath, `${stableJson(state)}\n`);
	}

	function get(cacheKey) {
		const key = normalizeKey(cacheKey);
		const entry = load().entries[key];
		return entry ? clone(entry) : null;
	}

	function set(cacheKey, artifactRef, { dependencies = [], metadata = null } = {}) {
		const key = normalizeKey(cacheKey);
		const artifact = requireArtifactRef(artifactRef);
		if (!Array.isArray(dependencies) || dependencies.some((x) => typeof x !== 'string')) throw new TypeError('dependencies must be a string array');
		const normalizedDependencies = [...new Set(dependencies)].sort(compareText);
		if (metadata !== null) stableJson(metadata);
		return withLockSync(root, lockName, () => {
			const state = load();
			state.entries[key] = { artifact, dependencies: normalizedDependencies, ...(metadata === null ? {} : { metadata }) };
			save(state);
			return clone(state.entries[key]);
		});
	}

	function remove(cacheKey) {
		const key = normalizeKey(cacheKey);
		return withLockSync(root, lockName, () => {
			const state = load();
			if (!(key in state.entries)) return false;
			delete state.entries[key];
			save(state);
			return true;
		});
	}

	function list() {
		const state = load();
		return Object.entries(state.entries).sort(([a], [b]) => compareText(a, b)).map(([cache_key, entry]) => ({ cache_key, ...clone(entry) }));
	}

	function invalidateDependencies(paths) {
		if (!Array.isArray(paths) || paths.some((x) => typeof x !== 'string')) throw new TypeError('paths must be a string array');
		const changed = new Set(paths);
		if (changed.size === 0) return [];
		return withLockSync(root, lockName, () => {
			const state = load();
			const removed = [];
			for (const key of Object.keys(state.entries).sort(compareText)) {
				const entry = state.entries[key];
				if (!entry.dependencies.some((dep) => changed.has(dep))) continue;
				removed.push({ cache_key: key, ...clone(entry) });
				delete state.entries[key];
			}
			if (removed.length > 0) save(state);
			return removed;
		});
	}

	function reachableArtifactRefs() {
		return list().map((entry) => entry.artifact);
	}

	return { schema: SCHEMA, path: statePath, get, set, remove, list, invalidateDependencies, reachableArtifactRefs };
}
