import fs from 'node:fs';
import path from 'node:path';

const SHA256_RE = /^[0-9a-f]{64}$/;

function requireNonNegativeInteger(name, value) {
	if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
	return value;
}

function normalizeReachable(reachable) {
	const out = new Set();
	for (const item of reachable ?? []) {
		const digest = typeof item === 'string' ? item : item?.digest;
		if (typeof digest !== 'string' || !SHA256_RE.test(digest)) throw new TypeError('reachable entries must be sha256 digests or artifact refs');
		out.add(digest);
	}
	return out;
}

function listBlobs(storeRoot) {
	const blobsRoot = path.join(path.resolve(storeRoot), 'blobs', 'sha256');
	if (!fs.existsSync(blobsRoot)) return { blobsRoot, blobs: [], unexpected: [] };
	const blobs = [];
	const unexpected = [];
	for (const prefix of fs.readdirSync(blobsRoot).sort()) {
		const prefixPath = path.join(blobsRoot, prefix);
		const prefixStat = fs.lstatSync(prefixPath);
		if (!prefixStat.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix)) {
			unexpected.push(path.relative(blobsRoot, prefixPath).split(path.sep).join('/'));
			continue;
		}
		for (const name of fs.readdirSync(prefixPath).sort()) {
			const filePath = path.join(prefixPath, name);
			const stat = fs.lstatSync(filePath);
			const rel = path.relative(blobsRoot, filePath).split(path.sep).join('/');
			if (!stat.isFile() || !SHA256_RE.test(name) || name.slice(0, 2) !== prefix) {
				unexpected.push(rel);
				continue;
			}
			blobs.push({ digest: name, path: filePath, relative_path: rel, size: stat.size, mtime_ms: stat.mtimeMs });
		}
	}
	return { blobsRoot, blobs, unexpected };
}

// Plans or applies deletion of UNREACHABLE content-addressed blobs only. Unknown/malformed files
// are reported and never deleted automatically. Dry-run is the default so retention policy must be
// explicit at the caller boundary rather than an accidental side effect of merely computing reachability.
export function collectArtifactGarbage(storeRoot, {
	reachable = [],
	dryRun = true,
	minAgeMs = 0,
	nowMs = Date.now(),
	maxDeleteCount = 10_000,
	maxDeleteBytes = 1024 * 1024 * 1024,
} = {}) {
	requireNonNegativeInteger('minAgeMs', minAgeMs);
	requireNonNegativeInteger('maxDeleteCount', maxDeleteCount);
	requireNonNegativeInteger('maxDeleteBytes', maxDeleteBytes);
	if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be finite');
	const roots = normalizeReachable(reachable);
	const { blobs, unexpected } = listBlobs(storeRoot);
	const candidates = [];
	let candidateBytes = 0;
	for (const blob of blobs) {
		if (roots.has(blob.digest)) continue;
		if (nowMs - blob.mtime_ms < minAgeMs) continue;
		if (candidates.length >= maxDeleteCount) break;
		if (candidateBytes + blob.size > maxDeleteBytes) break;
		candidates.push(blob);
		candidateBytes += blob.size;
	}

	const deleted = [];
	if (!dryRun) {
		for (const blob of candidates) {
			// Re-check identity at delete time; never follow a path that was replaced by a symlink.
			const stat = fs.lstatSync(blob.path);
			if (!stat.isFile()) throw new Error(`refusing to delete non-file artifact candidate: ${blob.relative_path}`);
			fs.unlinkSync(blob.path);
			deleted.push({ digest: blob.digest, size: blob.size, relative_path: blob.relative_path });
		}
	}

	return {
		schema: 'sbf.artifact-gc-result/1',
		dry_run: Boolean(dryRun),
		reachable: roots.size,
		total_blobs: blobs.length,
		candidates: candidates.map(({ digest, size, relative_path }) => ({ digest, size, relative_path })),
		candidate_bytes: candidateBytes,
		deleted,
		unexpected,
	};
}
