import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digestJson } from './cache-key.mjs';

export const DEFAULT_EXCLUDED_DIRS = Object.freeze([
	'.git', '.sbf', 'node_modules', '.venv', 'venv', '__pycache__', 'coverage', 'dist', 'build',
]);

function toPosix(rel) {
	return rel.split(path.sep).join('/');
}

function failBudget(kind, actual, limit) {
	const err = new Error(`scan file-index ${kind} budget exceeded: ${actual} > ${limit}`);
	err.code = 'INDEX_BUDGET_EXCEEDED';
	err.kind = kind;
	err.actual = actual;
	err.limit = limit;
	throw err;
}

function hashFile(filePath) {
	const hash = createHash('sha256');
	hash.update(fs.readFileSync(filePath));
	return hash.digest('hex');
}

// Builds one deterministic, content-addressed view of a project tree. Symlinks are recorded as
// skipped and never traversed: following them here would let a repository escape its own root or
// recursively walk a cycle. Adapters can consume this shared index later without each doing a
// second unbounded discovery walk.
export function buildFileIndex(repoRoot, {
	excludedDirs = DEFAULT_EXCLUDED_DIRS,
	include = null,
	maxFiles = 200_000,
	maxBytes = 2 * 1024 * 1024 * 1024,
} = {}) {
	const root = path.resolve(repoRoot);
	const excludes = new Set(excludedDirs);
	const entries = [];
	const skippedSymlinks = [];
	let totalBytes = 0;
	let directoriesVisited = 0;
	const stack = [root];

	while (stack.length > 0) {
		const dir = stack.pop();
		directoriesVisited += 1;
		const children = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			const abs = path.join(dir, child.name);
			const rel = toPosix(path.relative(root, abs));
			if (child.isSymbolicLink()) {
				skippedSymlinks.push(rel);
				continue;
			}
			if (child.isDirectory()) {
				if (!excludes.has(child.name)) stack.push(abs);
				continue;
			}
			if (!child.isFile()) continue;
			if (include && !include(rel)) continue;

			const stat = fs.statSync(abs);
			if (entries.length + 1 > maxFiles) failBudget('file-count', entries.length + 1, maxFiles);
			if (totalBytes + stat.size > maxBytes) failBudget('byte-count', totalBytes + stat.size, maxBytes);
			totalBytes += stat.size;
			entries.push({
				path: rel,
				size: stat.size,
				mode: stat.mode & 0o777,
				sha256: hashFile(abs),
			});
		}
	}

	entries.sort((a, b) => a.path.localeCompare(b.path));
	skippedSymlinks.sort();
	const sourceDigest = digestJson(entries);
	return {
		schema: 'sbf.scan-file-index/1',
		source_digest: sourceDigest,
		entries,
		stats: {
			files: entries.length,
			bytes: totalBytes,
			directories_visited: directoriesVisited,
			skipped_symlinks: skippedSymlinks.length,
		},
		skipped_symlinks: skippedSymlinks,
	};
}

export function indexEntryMap(index) {
	if (!index || index.schema !== 'sbf.scan-file-index/1' || !Array.isArray(index.entries)) {
		throw new TypeError('expected sbf.scan-file-index/1');
	}
	return new Map(index.entries.map((entry) => [entry.path, entry]));
}
