export const SDK_INPUT_LIMITS = Object.freeze({
	identifierBytes: 128,
	titleBytes: 512,
	semverBytes: 128,
	pathBytes: 4096,
	permissionRoots: 256,
	environmentNames: 128,
	fixtures: 256,
	manifestBytes: 262144,
	snapshotRefBytes: 4096,
	jsonDepth: 64,
	jsonNodes: 100000,
	jsonStringBytes: 262144,
	jsonKeyBytes: 4096,
	protocolJsonBytes: 1048576,
	diagnostics: 1024,
	conformanceCases: 256,
	packageFiles: 4096,
	packageDeclaredBytes: 536870912,
});

export const FORBIDDEN_INHERITED_ENV = Object.freeze([
	'BASH_ENV',
	'CLASSPATH',
	'DYLD_INSERT_LIBRARIES',
	'DYLD_LIBRARY_PATH',
	'ENV',
	'GEM_HOME',
	'GEM_PATH',
	'JDK_JAVA_OPTIONS',
	'JAVA_TOOL_OPTIONS',
	'LD_LIBRARY_PATH',
	'LD_PRELOAD',
	'NODE_OPTIONS',
	'NODE_PATH',
	'PERL5LIB',
	'PERL5OPT',
	'PYTHONPATH',
	'PYTHONSTARTUP',
	'RUBYLIB',
	'RUBYOPT',
	'_JAVA_OPTIONS',
]);

const FORBIDDEN_ENV_SET = new Set(FORBIDDEN_INHERITED_ENV);

export function utf8Bytes(value) {
	return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : Infinity;
}

export function isPlainObject(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

export function hasOnlyKeys(value, allowed) {
	if (!isPlainObject(value)) return false;
	const set = new Set(allowed);
	return Object.keys(value).every((key) => set.has(key));
}

export function pushError(errors, path, message) {
	errors.push({ path, message });
}

export function validBoundedString(value, maxBytes, { allowEmpty = false, forbidControls = false } = {}) {
	if (typeof value !== 'string') return false;
	if (!allowEmpty && value.length === 0) return false;
	if (utf8Bytes(value) > maxBytes) return false;
	if (forbidControls && /[\u0000-\u001f\u007f]/.test(value)) return false;
	return true;
}

export function validIdentifier(value) {
	return validBoundedString(value, SDK_INPUT_LIMITS.identifierBytes) &&
		/^[a-z][a-z0-9-]*$/.test(value);
}

export function validSha256(value) {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function parseSemver(value) {
	if (!validBoundedString(value, SDK_INPUT_LIMITS.semverBytes)) return null;
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value);
	if (!match) return null;
	const prerelease = match[4] ? match[4].split('.') : [];
	const build = match[5] ? match[5].split('.') : [];
	if (prerelease.some((part) => part.length === 0 || !/^[0-9A-Za-z-]+$/.test(part) ||
		(/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) return null;
	if (build.some((part) => part.length === 0 || !/^[0-9A-Za-z-]+$/.test(part))) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease,
	};
}

export function validSemver(value) {
	return parseSemver(value) !== null;
}

export function compareSemver(a, b) {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!pa || !pb) throw new TypeError('compareSemver requires two valid semantic versions');
	for (const key of ['major', 'minor', 'patch']) {
		if (pa[key] < pb[key]) return -1;
		if (pa[key] > pb[key]) return 1;
	}
	if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
	if (pa.prerelease.length === 0) return 1;
	if (pb.prerelease.length === 0) return -1;
	const length = Math.max(pa.prerelease.length, pb.prerelease.length);
	for (let i = 0; i < length; i += 1) {
		const aPart = pa.prerelease[i];
		const bPart = pb.prerelease[i];
		if (aPart === undefined) return -1;
		if (bPart === undefined) return 1;
		if (aPart === bPart) continue;
		const aNumeric = /^\d+$/.test(aPart);
		const bNumeric = /^\d+$/.test(bPart);
		if (aNumeric && bNumeric) return Number(aPart) < Number(bPart) ? -1 : 1;
		if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
		return aPart < bPart ? -1 : 1;
	}
	return 0;
}

export function validPackageRelativePath(value) {
	if (!validBoundedString(value, SDK_INPUT_LIMITS.pathBytes, { forbidControls: true }) || value.includes('\\')) return false;
	if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
	const parts = value.split('/');
	if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
	return true;
}

export function validPermissionRoot(value) {
	return value === '.' || validPackageRelativePath(value);
}

export function validEnvironmentName(value) {
	return validBoundedString(value, SDK_INPUT_LIMITS.identifierBytes) &&
		/^[A-Z_][A-Z0-9_]*$/.test(value) &&
		!FORBIDDEN_ENV_SET.has(value);
}

export function validOpaqueRef(value) {
	return validBoundedString(value, SDK_INPUT_LIMITS.snapshotRefBytes, { forbidControls: true });
}

export function normalizeArtifactRef(ref) {
	if (!isPlainObject(ref)) throw new TypeError('ArtifactRef must be a plain object');
	const actual = Object.keys(ref).sort();
	const expected = ['artifact_ref', 'byte_sha256', 'family', 'media_type', 'size_bytes', 'version'];
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new TypeError('ArtifactRef must contain exactly artifact_ref, family, version, media_type, byte_sha256, size_bytes');
	}
	if (ref.artifact_ref !== 'sbf.artifact-ref/1') throw new TypeError('unsupported ArtifactRef contract');
	if (typeof ref.family !== 'string' || !/^[a-z][a-z0-9.-]*$/.test(ref.family)) throw new TypeError('ArtifactRef.family is invalid');
	if (!validBoundedString(ref.version, SDK_INPUT_LIMITS.semverBytes, { forbidControls: true })) throw new TypeError('ArtifactRef.version is invalid');
	if (typeof ref.media_type !== 'string' || !/^[^\s/]+\/[^\s]+$/.test(ref.media_type)) throw new TypeError('ArtifactRef.media_type is invalid');
	if (!validSha256(ref.byte_sha256)) throw new TypeError('ArtifactRef.byte_sha256 is invalid');
	if (!Number.isSafeInteger(ref.size_bytes) || ref.size_bytes < 0) throw new TypeError('ArtifactRef.size_bytes is invalid');
	return Object.freeze({
		artifact_ref: 'sbf.artifact-ref/1',
		family: ref.family,
		version: ref.version,
		media_type: ref.media_type,
		byte_sha256: ref.byte_sha256,
		size_bytes: ref.size_bytes,
	});
}

export function formatArtifactRef(ref) {
	return JSON.stringify(normalizeArtifactRef(ref));
}

export function cloneJsonValue(value, {
	maxDepth = SDK_INPUT_LIMITS.jsonDepth,
	maxNodes = SDK_INPUT_LIMITS.jsonNodes,
	maxStringBytes = SDK_INPUT_LIMITS.jsonStringBytes,
	maxKeyBytes = SDK_INPUT_LIMITS.jsonKeyBytes,
	maxSerializedBytes = SDK_INPUT_LIMITS.protocolJsonBytes,
} = {}) {
	let nodes = 0;
	const active = new Set();

	function visit(current, depth) {
		nodes += 1;
		if (nodes > maxNodes) throw new TypeError('JSON value exceeds node budget');
		if (depth > maxDepth) throw new TypeError('JSON value exceeds depth budget');

		if (current === null || typeof current === 'boolean') return current;
		if (typeof current === 'string') {
			if (utf8Bytes(current) > maxStringBytes) throw new TypeError('JSON string exceeds byte budget');
			return current;
		}
		if (typeof current === 'number') {
			if (!Number.isFinite(current)) throw new TypeError('JSON numbers must be finite');
			return current;
		}
		if (Array.isArray(current)) {
			if (Object.keys(current).length !== current.length) throw new TypeError('JSON arrays must not be sparse or carry extra enumerable keys');
			if (active.has(current)) throw new TypeError('JSON value must not contain cycles');
			active.add(current);
			const out = current.map((item) => visit(item, depth + 1));
			active.delete(current);
			return out;
		}
		if (isPlainObject(current)) {
			if (active.has(current)) throw new TypeError('JSON value must not contain cycles');
			active.add(current);
			const out = {};
			for (const key of Object.keys(current).sort()) {
				if (utf8Bytes(key) > maxKeyBytes || /[\u0000-\u001f\u007f]/.test(key)) {
					throw new TypeError('JSON object key exceeds byte budget or contains control characters');
				}
				Object.defineProperty(out, key, {
					value: visit(current[key], depth + 1),
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
			active.delete(current);
			return out;
		}
		throw new TypeError('value is not JSON-serializable data');
	}

	const cloned = visit(value, 0);
	const serialized = JSON.stringify(cloned);
	if (utf8Bytes(serialized) > maxSerializedBytes) throw new TypeError('JSON value exceeds serialized byte budget');
	return cloned;
}

export function isJsonValue(value, options) {
	try {
		cloneJsonValue(value, options);
		return true;
	} catch {
		return false;
	}
}

export function deepFreezeJson(value) {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreezeJson(child);
	return Object.freeze(value);
}

export function cloneAndFreezeJson(value, options) {
	return deepFreezeJson(cloneJsonValue(value, options));
}

export function stableClone(value) {
	if (Array.isArray(value)) return value.map(stableClone);
	if (isPlainObject(value)) {
		const out = {};
		for (const key of Object.keys(value).sort()) {
			Object.defineProperty(out, key, {
				value: stableClone(value[key]),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return out;
	}
	return value;
}
