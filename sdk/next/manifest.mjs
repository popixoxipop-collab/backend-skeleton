import {
	compareSemver,
	hasOnlyKeys,
	isPlainObject,
	pushError,
	validIdentifier,
	validPackageRelativePath,
	validSemver,
} from './_util.mjs';

export const SDK_MANIFEST_CONTRACT = 'sbf.adapter-sdk-manifest/1';
export const SDK_ENTRYPOINT_PROTOCOL = 'sbf.adapter-worker/1';
export const CURRENT_ADAPTER_DESCRIPTOR_CONTRACT = 'sbf.adapter/2';
export const ACTIVATION_MODE = 'manual-approval-required';

const VERIFICATION_BASIS = new Set([
	'official-reference',
	'production-repo',
	'community-sample',
	'synthetic-only',
	'not-applicable',
]);

function validateVersionRange(range, errors) {
	if (!isPlainObject(range) || !hasOnlyKeys(range, ['minInclusive', 'maxExclusive'])) {
		pushError(errors, '/compatibility/bskel', 'must contain only minInclusive and maxExclusive');
		return;
	}
	if (!validSemver(range.minInclusive)) pushError(errors, '/compatibility/bskel/minInclusive', 'must be an exact semantic version');
	if (!validSemver(range.maxExclusive)) pushError(errors, '/compatibility/bskel/maxExclusive', 'must be an exact semantic version');
	if (validSemver(range.minInclusive) && validSemver(range.maxExclusive) &&
		compareSemver(range.minInclusive, range.maxExclusive) >= 0) {
		pushError(errors, '/compatibility/bskel', 'minInclusive must be lower than maxExclusive');
	}
}

function validateEntrypoint(entrypoint, errors) {
	if (!isPlainObject(entrypoint) || !hasOnlyKeys(entrypoint, ['protocol', 'path', 'export'])) {
		pushError(errors, '/entrypoint', 'must contain only protocol, path, and export');
		return;
	}
	if (entrypoint.protocol !== SDK_ENTRYPOINT_PROTOCOL) {
		pushError(errors, '/entrypoint/protocol', `must equal ${SDK_ENTRYPOINT_PROTOCOL}`);
	}
	if (!validPackageRelativePath(entrypoint.path)) {
		pushError(errors, '/entrypoint/path', 'must be a package-relative path without traversal, absolute paths, or backslashes');
	}
	if (entrypoint.export !== 'adapterWorker') {
		pushError(errors, '/entrypoint/export', 'must equal adapterWorker');
	}
}

function validatePermissions(permissions, errors) {
	if (!isPlainObject(permissions) || !hasOnlyKeys(permissions, ['readRoots', 'writeRoots', 'network', 'environment', 'subprocess'])) {
		pushError(errors, '/permissions', 'must contain only readRoots, writeRoots, network, environment, and subprocess');
		return;
	}
	for (const [key, values] of [['readRoots', permissions.readRoots], ['writeRoots', permissions.writeRoots], ['environment', permissions.environment]]) {
		if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length === 0)) {
			pushError(errors, `/permissions/${key}`, 'must be an array of non-empty strings');
		}
	}
	if (permissions.network !== 'deny-by-default') {
		pushError(errors, '/permissions/network', 'must equal deny-by-default; an executor may grant a narrower approved policy later');
	}
	if (permissions.subprocess !== 'deny-by-default') {
		pushError(errors, '/permissions/subprocess', 'must equal deny-by-default; an executor may grant a narrower approved policy later');
	}
}

export function validateAdapterSdkManifest(manifest) {
	const errors = [];
	if (!isPlainObject(manifest)) return { ok: false, errors: [{ path: '', message: 'manifest must be an object' }] };
	if (!hasOnlyKeys(manifest, [
		'contract', 'adapter', 'compatibility', 'entrypoint', 'permissions',
		'fixtures', 'verificationBasis', 'activation',
	])) {
		pushError(errors, '', 'contains unknown top-level keys');
	}
	if (manifest.contract !== SDK_MANIFEST_CONTRACT) pushError(errors, '/contract', `must equal ${SDK_MANIFEST_CONTRACT}`);

	if (!isPlainObject(manifest.adapter) || !hasOnlyKeys(manifest.adapter, ['id', 'title', 'version', 'descriptorContract'])) {
		pushError(errors, '/adapter', 'must contain only id, title, version, and descriptorContract');
	} else {
		if (!validIdentifier(manifest.adapter.id)) pushError(errors, '/adapter/id', 'must be a lowercase kebab-case identifier');
		if (typeof manifest.adapter.title !== 'string' || manifest.adapter.title.length === 0) pushError(errors, '/adapter/title', 'must be a non-empty string');
		if (!validSemver(manifest.adapter.version)) pushError(errors, '/adapter/version', 'must be an exact semantic version');
		if (manifest.adapter.descriptorContract !== CURRENT_ADAPTER_DESCRIPTOR_CONTRACT) {
			pushError(errors, '/adapter/descriptorContract', `must equal ${CURRENT_ADAPTER_DESCRIPTOR_CONTRACT} in this SDK revision`);
		}
	}

	if (!isPlainObject(manifest.compatibility) || !hasOnlyKeys(manifest.compatibility, ['bskel'])) {
		pushError(errors, '/compatibility', 'must contain only bskel');
	} else validateVersionRange(manifest.compatibility.bskel, errors);

	validateEntrypoint(manifest.entrypoint, errors);
	validatePermissions(manifest.permissions, errors);

	if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0 ||
		manifest.fixtures.some((value) => !validPackageRelativePath(value))) {
		pushError(errors, '/fixtures', 'must contain at least one package-relative fixture path');
	}
	if (!VERIFICATION_BASIS.has(manifest.verificationBasis)) {
		pushError(errors, '/verificationBasis', 'must use the existing adapter verification-basis vocabulary');
	}
	if (!isPlainObject(manifest.activation) || !hasOnlyKeys(manifest.activation, ['mode']) ||
		manifest.activation.mode !== ACTIVATION_MODE) {
		pushError(errors, '/activation/mode', `must equal ${ACTIVATION_MODE}; validation never authorizes execution`);
	}
	return { ok: errors.length === 0, errors };
}

export function supportsBskelVersion(manifest, version) {
	const result = validateAdapterSdkManifest(manifest);
	if (!result.ok || !validSemver(version)) return false;
	const range = manifest.compatibility.bskel;
	return compareSemver(version, range.minInclusive) >= 0 && compareSemver(version, range.maxExclusive) < 0;
}

export function planExternalAdapterActivation(manifest) {
	const validation = validateAdapterSdkManifest(manifest);
	return {
		contract: 'sbf.adapter-sdk-activation-plan/1',
		adapterId: manifest?.adapter?.id ?? null,
		valid: validation.ok,
		executable: false,
		requiresApproval: true,
		autoInstall: false,
		autoImport: false,
		requestedPermissions: validation.ok ? manifest.permissions : null,
		errors: validation.errors,
		next: validation.ok
			? ['review fixtures', 'verify package digest and signer policy', 'approve an isolated executor profile']
			: ['fix manifest validation errors before any execution review'],
	};
}
