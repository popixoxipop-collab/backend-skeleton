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

export function validSemver(value) {
	return typeof value === 'string' &&
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

export function compareSemver(a, b) {
	const pa = a.split('-', 1)[0].split('.').map(Number);
	const pb = b.split('-', 1)[0].split('.').map(Number);
	for (let i = 0; i < 3; i += 1) {
		if (pa[i] < pb[i]) return -1;
		if (pa[i] > pb[i]) return 1;
	}
	return 0;
}

export function validPackageRelativePath(value) {
	if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) return false;
	if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
	const parts = value.split('/');
	if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
	return true;
}

export function stableClone(value) {
	if (Array.isArray(value)) return value.map(stableClone);
	if (isPlainObject(value)) {
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = stableClone(value[key]);
		return out;
	}
	return value;
}
