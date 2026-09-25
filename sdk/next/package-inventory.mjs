import {
	hasOnlyKeys,
	isPlainObject,
	pushError,
	validPackageRelativePath,
	validSha256,
} from './_util.mjs';
import { validateAdapterSdkManifest } from './manifest.mjs';


const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function portablePackagePath(pathValue) {
	if (!validPackageRelativePath(pathValue)) return false;
	for (const segment of pathValue.split('/')) {
		if (/[. ]$/.test(segment)) return false;
		if (WINDOWS_RESERVED_SEGMENT.test(segment)) return false;
		if (/[\u0000-\u001f\u007f]/.test(segment)) return false;
	}
	return true;
}

function portablePathKey(pathValue) {
	return pathValue.normalize('NFC').toLowerCase();
}

export const PACKAGE_INVENTORY_CONTRACT = 'sbf.adapter-package-inventory/1';
export const PACKAGE_REVIEW_CONTRACT = 'sbf.adapter-package-review/1';

function validateFileEntry(file, index, errors) {
	const base = `/files/${index}`;
	if (!isPlainObject(file) || !hasOnlyKeys(file, ['path', 'sha256', 'sizeBytes', 'kind'])) {
		pushError(errors, base, 'must contain only path, sha256, sizeBytes, and kind');
		return;
	}
	if (!portablePackagePath(file.path)) {
		pushError(errors, `${base}/path`, 'must be a portable package-relative path without traversal, reserved device names, control characters, or trailing dot/space segments');
	}
	if (!validSha256(file.sha256)) {
		pushError(errors, `${base}/sha256`, 'must be a lowercase SHA-256 digest');
	}
	if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) {
		pushError(errors, `${base}/sizeBytes`, 'must be a non-negative safe integer');
	}
	if (file.kind !== 'file') {
		pushError(errors, `${base}/kind`, 'must equal file; symlinks/special entries are not accepted by this preview');
	}
}

export function validateAdapterPackageInventory(inventory) {
	const errors = [];
	if (!isPlainObject(inventory)) {
		return { ok: false, errors: [{ path: '', message: 'inventory must be an object' }] };
	}
	if (!hasOnlyKeys(inventory, ['contract', 'packageSha256', 'files'])) {
		pushError(errors, '', 'contains unknown inventory keys');
	}
	if (inventory.contract !== PACKAGE_INVENTORY_CONTRACT) {
		pushError(errors, '/contract', `must equal ${PACKAGE_INVENTORY_CONTRACT}`);
	}
	if (!validSha256(inventory.packageSha256)) {
		pushError(errors, '/packageSha256', 'must be a lowercase SHA-256 digest');
	}
	if (!Array.isArray(inventory.files) || inventory.files.length === 0) {
		pushError(errors, '/files', 'must be a non-empty array of regular-file entries');
	} else {
		const seen = new Map();
		const portableSeen = new Map();
		for (let index = 0; index < inventory.files.length; index += 1) {
			const file = inventory.files[index];
			validateFileEntry(file, index, errors);
			if (isPlainObject(file) && typeof file.path === 'string') {
				if (seen.has(file.path)) {
					pushError(errors, `/files/${index}/path`, `duplicates files/${seen.get(file.path)}/path`);
				} else {
					seen.set(file.path, index);
				}
				if (portablePackagePath(file.path)) {
					const portableKey = portablePathKey(file.path);
					if (portableSeen.has(portableKey) && portableSeen.get(portableKey).path !== file.path) {
						const previous = portableSeen.get(portableKey);
						pushError(errors, `/files/${index}/path`,
							`collides portably with files/${previous.index}/path after Unicode normalization/case folding`);
					} else if (!portableSeen.has(portableKey)) {
						portableSeen.set(portableKey, { index, path: file.path });
					}
				}
			}
		}
	}
	return { ok: errors.length === 0, errors };
}

export function createAdapterPackageInventory({ packageSha256, files }) {
	const inventory = {
		contract: PACKAGE_INVENTORY_CONTRACT,
		packageSha256,
		files: files.map((file) => ({ ...file })),
	};
	const validation = validateAdapterPackageInventory(inventory);
	if (!validation.ok) {
		const details = validation.errors.map((error) => `${error.path || '(root)'}: ${error.message}`).join('; ');
		throw new TypeError(`invalid adapter package inventory: ${details}`);
	}
	return inventory;
}

function fixturePresent(paths, fixture) {
	return paths.has(fixture) || [...paths].some((entry) => entry.startsWith(`${fixture}/`));
}

export function reviewAdapterPackage({
	manifest,
	inventory,
	observedPackageSha256 = null,
}) {
	const manifestValidation = validateAdapterSdkManifest(manifest);
	const inventoryValidation = validateAdapterPackageInventory(inventory);
	const errors = [
		...manifestValidation.errors.map((error) => ({ source: 'manifest', ...error })),
		...inventoryValidation.errors.map((error) => ({ source: 'inventory', ...error })),
	];
	const missing = [];

	if (manifestValidation.ok && inventoryValidation.ok) {
		const paths = new Set(inventory.files.map((file) => file.path));
		if (!paths.has(manifest.entrypoint.path)) missing.push(`entrypoint:${manifest.entrypoint.path}`);
		for (const fixture of manifest.fixtures) {
			if (!fixturePresent(paths, fixture)) missing.push(`fixture:${fixture}`);
		}
	}

	let digestMatch = null;
	if (observedPackageSha256 !== null) {
		if (!validSha256(observedPackageSha256)) {
			errors.push({ source: 'observed-package', path: '/observedPackageSha256', message: 'must be a lowercase SHA-256 digest' });
			digestMatch = false;
		} else {
			digestMatch = inventoryValidation.ok && observedPackageSha256 === inventory.packageSha256;
			if (!digestMatch) {
				errors.push({ source: 'observed-package', path: '/observedPackageSha256', message: 'does not match inventory.packageSha256' });
			}
		}
	}

	const inventoryValid = inventoryValidation.ok;
	const referencesSatisfied = manifestValidation.ok && inventoryValid && missing.length === 0;
	return {
		contract: PACKAGE_REVIEW_CONTRACT,
		adapterId: manifest?.adapter?.id ?? null,
		inventoryValid,
		referencesSatisfied,
		digestMatch,
		packageBytesTrusted: false,
		executable: false,
		requiresApproval: true,
		errors,
		missing,
		next: errors.length === 0 && referencesSatisfied
			? [
				'compute/verify the package digest in the approved acquisition boundary',
				'verify signer/revocation policy',
				'execute only through a T20-approved isolated executor',
			]
			: ['fix inventory/manifest reference failures before execution review'],
		note: 'digestMatch compares caller-supplied digests only; this SDK does not read or trust archive bytes itself',
	};
}
