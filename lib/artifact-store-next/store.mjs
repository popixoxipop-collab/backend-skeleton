import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const SHA256_RE = /^[0-9a-f]{64}$/;

function bytes(value) {
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value);
	if (typeof value === 'string') return Buffer.from(value, 'utf8');
	throw new TypeError('artifact content must be a string, Buffer or Uint8Array');
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

function assertRef(ref) {
	if (!ref || ref.algorithm !== 'sha256' || !SHA256_RE.test(ref.digest) || !Number.isInteger(ref.size) || ref.size < 0) {
		throw new TypeError('invalid sha256 artifact ref');
	}
}

function writeAtomic(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
	try {
		fs.renameSync(temp, filePath);
	} catch (error) {
		fs.rmSync(temp, { force: true });
		if (error.code !== 'EEXIST') throw error;
	}
}

export function createArtifactStore(storeRoot, { maxArtifactBytes = 512 * 1024 * 1024 } = {}) {
	if (!Number.isInteger(maxArtifactBytes) || maxArtifactBytes <= 0) throw new TypeError('maxArtifactBytes must be a positive integer');
	const root = path.resolve(storeRoot);
	const blobsRoot = path.join(root, 'blobs', 'sha256');

	function blobPath(digest) {
		if (!SHA256_RE.test(digest)) throw new TypeError('invalid sha256 digest');
		return path.join(blobsRoot, digest.slice(0, 2), digest);
	}

	function put(content) {
		const data = bytes(content);
		if (data.length > maxArtifactBytes) {
			const error = new Error(`artifact exceeds maxArtifactBytes: ${data.length} > ${maxArtifactBytes}`);
			error.code = 'ARTIFACT_BUDGET_EXCEEDED';
			throw error;
		}
		const digest = sha256(data);
		const target = blobPath(digest);
		if (!fs.existsSync(target)) writeAtomic(target, data);
		const stored = fs.readFileSync(target);
		if (stored.length !== data.length || sha256(stored) !== digest) {
			const error = new Error(`artifact store corruption at ${target}`);
			error.code = 'ARTIFACT_CORRUPT';
			throw error;
		}
		return { algorithm: 'sha256', digest, size: data.length };
	}

	function has(ref) {
		assertRef(ref);
		return fs.existsSync(blobPath(ref.digest));
	}

	function read(ref) {
		assertRef(ref);
		const target = blobPath(ref.digest);
		if (!fs.existsSync(target)) {
			const error = new Error(`artifact not found: ${ref.digest}`);
			error.code = 'ARTIFACT_NOT_FOUND';
			throw error;
		}
		const data = fs.readFileSync(target);
		if (data.length !== ref.size || sha256(data) !== ref.digest) {
			const error = new Error(`artifact failed integrity check: ${ref.digest}`);
			error.code = 'ARTIFACT_CORRUPT';
			throw error;
		}
		return data;
	}

	return { root, put, has, read, pathForDigest: blobPath };
}
