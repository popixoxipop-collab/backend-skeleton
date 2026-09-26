import assert from 'node:assert/strict';
import test from 'node:test';

import {
	ACTIVATION_MODE,
	CURRENT_ADAPTER_DESCRIPTOR_CONTRACT,
	SDK_ENTRYPOINT_PROTOCOL,
	SDK_MANIFEST_CONTRACT,
	createAdapterPackageInventory,
	reviewAdapterPackage,
	validateAdapterPackageInventory,
} from '../../sdk/next/index.mjs';

function manifest() {
	return {
		contract: SDK_MANIFEST_CONTRACT,
		adapter: {
			id: 'typescript-nestjs',
			title: 'NestJS',
			version: '0.1.0',
			descriptorContract: CURRENT_ADAPTER_DESCRIPTOR_CONTRACT,
		},
		compatibility: { bskel: { minInclusive: '1.9.0', maxExclusive: '2.0.0' } },
		entrypoint: { protocol: SDK_ENTRYPOINT_PROTOCOL, path: 'adapter-worker.mjs', export: 'adapterWorker' },
		permissions: {
			readRoots: ['.'],
			writeRoots: [],
			network: 'deny-by-default',
			environment: [],
			subprocess: 'deny-by-default',
		},
		fixtures: ['fixtures/minimal'],
		verificationBasis: 'synthetic-only',
		activation: { mode: ACTIVATION_MODE },
	};
}

function inventory() {
	return createAdapterPackageInventory({
		packageSha256: 'a'.repeat(64),
		files: [
			{ path: 'adapter-worker.mjs', sha256: 'b'.repeat(64), sizeBytes: 100, kind: 'file' },
			{ path: 'fixtures/minimal/input.ts', sha256: 'c'.repeat(64), sizeBytes: 20, kind: 'file' },
		],
	});
}

test('package review verifies inventory references but never authorizes execution', () => {
	const value = inventory();
	assert.equal(validateAdapterPackageInventory(value).ok, true);
	const report = reviewAdapterPackage({
		manifest: manifest(),
		inventory: value,
		observedPackageSha256: 'a'.repeat(64),
	});
	assert.equal(report.inventoryValid, true);
	assert.equal(report.referencesSatisfied, true);
	assert.equal(report.digestMatch, true);
	assert.equal(report.packageBytesTrusted, false);
	assert.equal(report.executable, false);
	assert.equal(report.requiresApproval, true);
	assert.deepEqual(report.errors, []);
	assert.deepEqual(report.missing, []);
	assert.match(report.note, /caller-supplied digests only/);
});

test('package review rejects missing entrypoint and fixture references', () => {
	const value = createAdapterPackageInventory({
		packageSha256: 'a'.repeat(64),
		files: [{ path: 'README.md', sha256: 'b'.repeat(64), sizeBytes: 20, kind: 'file' }],
	});
	const report = reviewAdapterPackage({ manifest: manifest(), inventory: value });
	assert.equal(report.inventoryValid, true);
	assert.equal(report.referencesSatisfied, false);
	assert.deepEqual(report.missing.sort(), [
		'entrypoint:adapter-worker.mjs',
		'fixture:fixtures/minimal',
	].sort());
	assert.equal(report.executable, false);
});

test('inventory rejects duplicate, unsafe, and non-regular entries', () => {
	for (const files of [
		[
			{ path: 'worker.mjs', sha256: 'a'.repeat(64), sizeBytes: 1, kind: 'file' },
			{ path: 'worker.mjs', sha256: 'b'.repeat(64), sizeBytes: 2, kind: 'file' },
		],
		[{ path: '../worker.mjs', sha256: 'a'.repeat(64), sizeBytes: 1, kind: 'file' }],
		[{ path: '/tmp/worker.mjs', sha256: 'a'.repeat(64), sizeBytes: 1, kind: 'file' }],
		[{ path: 'worker.mjs', sha256: 'a'.repeat(64), sizeBytes: 1, kind: 'symlink' }],
	]) {
		const result = validateAdapterPackageInventory({
			contract: 'sbf.adapter-package-inventory/1',
			packageSha256: 'c'.repeat(64),
			files,
		});
		assert.equal(result.ok, false, JSON.stringify(files));
	}
});

test('digest mismatch is reported without pretending to read archive bytes', () => {
	const report = reviewAdapterPackage({
		manifest: manifest(),
		inventory: inventory(),
		observedPackageSha256: 'd'.repeat(64),
	});
	assert.equal(report.digestMatch, false);
	assert.equal(report.packageBytesTrusted, false);
	assert.equal(report.executable, false);
	assert.match(report.errors.map((item) => item.message).join('\n'), /does not match/);
});

test('fixture directory reference requires at least one regular file below it', () => {
	const value = createAdapterPackageInventory({
		packageSha256: 'a'.repeat(64),
		files: [
			{ path: 'adapter-worker.mjs', sha256: 'b'.repeat(64), sizeBytes: 100, kind: 'file' },
			{ path: 'fixtures-other/minimal.ts', sha256: 'c'.repeat(64), sizeBytes: 20, kind: 'file' },
		],
	});
	const report = reviewAdapterPackage({ manifest: manifest(), inventory: value });
	assert.equal(report.referencesSatisfied, false);
	assert.deepEqual(report.missing, ['fixture:fixtures/minimal']);
});


test('inventory rejects cross-platform case and Unicode normalization collisions', () => {
	for (const paths of [
		['src/Worker.mjs', 'src/worker.mjs'],
		['fixtures/caf\u00e9.txt', 'fixtures/cafe\u0301.txt'],
	]) {
		const result = validateAdapterPackageInventory({
			contract: 'sbf.adapter-package-inventory/1',
			packageSha256: 'c'.repeat(64),
			files: paths.map((path, index) => ({
				path,
				sha256: String(index + 1).repeat(64).slice(0, 64),
				sizeBytes: 1,
				kind: 'file',
			})),
		});
		assert.equal(result.ok, false, JSON.stringify(paths));
		assert.match(result.errors.map((item) => item.message).join('\n'), /collides portably/);
	}
});

test('inventory rejects reserved device names and trailing dot/space segments', () => {
	for (const path of ['CON', 'src/NUL.txt', 'src/name.', 'src/name ', 'src/line\nfeed.txt']) {
		const result = validateAdapterPackageInventory({
			contract: 'sbf.adapter-package-inventory/1',
			packageSha256: 'c'.repeat(64),
			files: [{ path, sha256: 'a'.repeat(64), sizeBytes: 1, kind: 'file' }],
		});
		assert.equal(result.ok, false, path);
		assert.match(result.errors.map((item) => item.message).join('\n'), /portable package-relative path/);
	}
});


test('inventory rejects excessive file counts and aggregate declared bytes', () => {
	const tooMany = validateAdapterPackageInventory({
		contract: 'sbf.adapter-package-inventory/1',
		packageSha256: 'a'.repeat(64),
		files: Array.from({ length: 4097 }, (_, i) => ({
			path: 'f/' + i + '.txt',
			sha256: 'b'.repeat(64),
			sizeBytes: 1,
			kind: 'file',
		})),
	});
	assert.equal(tooMany.ok, false);
	assert.match(tooMany.errors.map((e) => e.message).join('\n'), /at most 4096/);

	const tooLarge = validateAdapterPackageInventory({
		contract: 'sbf.adapter-package-inventory/1',
		packageSha256: 'a'.repeat(64),
		files: [
			{ path: 'a.bin', sha256: 'b'.repeat(64), sizeBytes: 300_000_000, kind: 'file' },
			{ path: 'b.bin', sha256: 'c'.repeat(64), sizeBytes: 300_000_000, kind: 'file' },
		],
	});
	assert.equal(tooLarge.ok, false);
	assert.match(tooLarge.errors.map((e) => e.message).join('\n'), /declared package bytes|no greater than/);
});
