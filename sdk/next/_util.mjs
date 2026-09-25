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

export function validIdentifier(value) {
	return typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
}

export function validSha256(value) {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function parseSemver(value) {
	if (typeof value !== 'string') return null;
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
	if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) return false;
	if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
	const parts = value.split('/');
	if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
	return true;
}

export function validPermissionRoot(value) {
	return value === '.' || validPackageRelativePath(value);
}

export function validEnvironmentName(value) {
	return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
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
