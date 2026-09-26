import {
	SDK_INPUT_LIMITS,
	cloneAndFreezeJson,
	compareSemver,
	hasOnlyKeys,
	isJsonValue,
	isPlainObject,
	pushError,
	utf8Bytes,
	validBoundedString,
	validEnvironmentName,
	validIdentifier,
	validPackageRelativePath,
	validPermissionRoot,
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

function duplicate(values) {
	return Array.isArray(values) && new Set(values).size !== values.length;
}

function validateVersionRange(range, errors) {
	if (!isPlainObject(range) || !hasOnlyKeys(range, ['minInclusive', 'maxExclusive'])) {
		pushError(errors, '/compatibility/bskel', 'must contain only minInclusive and maxExclusive');
		return;
	}
	if (!validSemver(range.minInclusive)) pushError(errors, '/compatibility/bskel/minInclusive', 'must be a bounded exact semantic version');
	if (!validSemver(range.maxExclusive)) pushError(errors, '/compatibility/bskel/maxExclusive', 'must be a bounded exact semantic version');
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
		pushError(errors, '/entrypoint/path', `must be a package-relative path of at most ${SDK_INPUT_LIMITS.pathBytes} UTF-8 bytes without traversal, absolute paths, URI schemes, controls, or backslashes`);
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
	for (const [key, values] of [['readRoots', permissions.readRoots], ['writeRoots', permissions.writeRoots]]) {
		if (!Array.isArray(values)) {
			pushError(errors, `/permissions/${key}`, 'must be an array');
			continue;
		}
		if (values.length > SDK_INPUT_LIMITS.permissionRoots) {
			pushError(errors, `/permissions/${key}`, `must contain at most ${SDK_INPUT_LIMITS.permissionRoots} roots`);
		}
		if (values.some((value) => !validPermissionRoot(value))) {
			pushError(errors, `/permissions/${key}`, `must contain package-relative roots (or ".") of at most ${SDK_INPUT_LIMITS.pathBytes} UTF-8 bytes, without traversal, absolute paths, URI schemes, controls, or backslashes`);
		}
		if (duplicate(values)) pushError(errors, `/permissions/${key}`, 'must not contain duplicate roots');
	}
	if (!Array.isArray(permissions.environment)) {
		pushError(errors, '/permissions/environment', 'must be an array');
	} else {
		if (permissions.environment.length > SDK_INPUT_LIMITS.environmentNames) {
			pushError(errors, '/permissions/environment', `must contain at most ${SDK_INPUT_LIMITS.environmentNames} names`);
		}
		if (permissions.environment.some((value) => !validEnvironmentName(value))) {
			pushError(errors, '/permissions/environment', 'must contain T20-compatible uppercase environment variable names only; injection-class inherited names and assignments are rejected');
		}
		if (duplicate(permissions.environment)) pushError(errors, '/permissions/environment', 'must not contain duplicate names');
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
	if (!isJsonValue(manifest, {
		maxDepth: 16,
		maxNodes: 4096,
		maxStringBytes: SDK_INPUT_LIMITS.pathBytes,
		maxKeyBytes: 128,
		maxSerializedBytes: SDK_INPUT_LIMITS.manifestBytes,
	})) {
		pushError(errors, '', `manifest must be bounded JSON data no larger than ${SDK_INPUT_LIMITS.manifestBytes} serialized UTF-8 bytes`);
	}
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
		if (!validIdentifier(manifest.adapter.id)) pushError(errors, '/adapter/id', `must be a lowercase kebab-case identifier of at most ${SDK_INPUT_LIMITS.identifierBytes} UTF-8 bytes`);
		if (!validBoundedString(manifest.adapter.title, SDK_INPUT_LIMITS.titleBytes, { forbidControls: true })) {
			pushError(errors, '/adapter/title', `must be a non-empty control-free string of at most ${SDK_INPUT_LIMITS.titleBytes} UTF-8 bytes`);
		}
		if (!validSemver(manifest.adapter.version)) pushError(errors, '/adapter/version', `must be an exact semantic version of at most ${SDK_INPUT_LIMITS.semverBytes} UTF-8 bytes`);
		if (manifest.adapter.descriptorContract !== CURRENT_ADAPTER_DESCRIPTOR_CONTRACT) {
			pushError(errors, '/adapter/descriptorContract', `must equal ${CURRENT_ADAPTER_DESCRIPTOR_CONTRACT} in this SDK revision`);
		}
	}

	if (!isPlainObject(manifest.compatibility) || !hasOnlyKeys(manifest.compatibility, ['bskel'])) {
		pushError(errors, '/compatibility', 'must contain only bskel');
	} else validateVersionRange(manifest.compatibility.bskel, errors);

	validateEntrypoint(manifest.entrypoint, errors);
	validatePermissions(manifest.permissions, errors);

	if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
		pushError(errors, '/fixtures', 'must contain at least one package-relative fixture path');
	} else {
		if (manifest.fixtures.length > SDK_INPUT_LIMITS.fixtures) {
			pushError(errors, '/fixtures', `must contain at most ${SDK_INPUT_LIMITS.fixtures} fixture paths`);
		}
		if (manifest.fixtures.some((value) => !validPackageRelativePath(value))) {
			pushError(errors, '/fixtures', `must contain package-relative paths of at most ${SDK_INPUT_LIMITS.pathBytes} UTF-8 bytes`);
		}
		if (duplicate(manifest.fixtures)) pushError(errors, '/fixtures', 'must not contain duplicate paths');
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

export function createAdapterSdkManifest({
	adapter,
	bskel,
	entrypointPath,
	fixtures,
	verificationBasis,
	readRoots = ['.'],
	writeRoots = [],
	environment = [],
}) {
	const manifest = {
		contract: SDK_MANIFEST_CONTRACT,
		adapter: {
			id: adapter?.id,
			title: adapter?.title,
			version: adapter?.version,
			descriptorContract: CURRENT_ADAPTER_DESCRIPTOR_CONTRACT,
		},
		compatibility: {
			bskel: {
				minInclusive: bskel?.minInclusive,
				maxExclusive: bskel?.maxExclusive,
			},
		},
		entrypoint: {
			protocol: SDK_ENTRYPOINT_PROTOCOL,
			path: entrypointPath,
			export: 'adapterWorker',
		},
		permissions: {
			readRoots: [...readRoots],
			writeRoots: [...writeRoots],
			network: 'deny-by-default',
			environment: [...environment],
			subprocess: 'deny-by-default',
		},
		fixtures: [...(fixtures ?? [])],
		verificationBasis,
		activation: { mode: ACTIVATION_MODE },
	};
	const validation = validateAdapterSdkManifest(manifest);
	if (!validation.ok) {
		const details = validation.errors.map((error) => `${error.path || '(root)'}: ${error.message}`).join('; ');
		throw new TypeError(`invalid adapter SDK manifest: ${details}`);
	}
	return cloneAndFreezeJson(manifest, {
		maxDepth: 16,
		maxNodes: 4096,
		maxStringBytes: SDK_INPUT_LIMITS.pathBytes,
		maxKeyBytes: 128,
		maxSerializedBytes: SDK_INPUT_LIMITS.manifestBytes,
	});
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
		requestedPermissions: validation.ok ? cloneAndFreezeJson(manifest.permissions) : null,
		errors: validation.errors,
		next: validation.ok
			? ['review fixtures', 'verify package digest and signer policy', 'approve an isolated executor profile']
			: ['fix manifest validation errors before any execution review'],
	};
}
