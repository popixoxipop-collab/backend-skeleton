import assert from 'node:assert/strict';
import test from 'node:test';

import {
	ACTIVATION_MODE,
	CURRENT_ADAPTER_DESCRIPTOR_CONTRACT,
	createAdapterSdkManifest,
	SDK_ENTRYPOINT_PROTOCOL,
	SDK_MANIFEST_CONTRACT,
	planExternalAdapterActivation,
	supportsBskelVersion,
	validateAdapterSdkManifest,
} from '../../sdk/next/index.mjs';

function validManifest() {
	return {
		contract: SDK_MANIFEST_CONTRACT,
		adapter: {
			id: 'typescript-nestjs',
			title: 'NestJS',
			version: '0.1.0',
			descriptorContract: CURRENT_ADAPTER_DESCRIPTOR_CONTRACT,
		},
		compatibility: {
			bskel: { minInclusive: '1.9.0', maxExclusive: '2.0.0' },
		},
		entrypoint: {
			protocol: SDK_ENTRYPOINT_PROTOCOL,
			path: 'adapter-worker.mjs',
			export: 'adapterWorker',
		},
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

test('valid SDK manifest stays data-only and has an explicit version range', () => {
	const manifest = validManifest();
	assert.deepEqual(validateAdapterSdkManifest(manifest), { ok: true, errors: [] });
	assert.equal(supportsBskelVersion(manifest, '1.9.0'), true);
	assert.equal(supportsBskelVersion(manifest, '1.99.0'), true);
	assert.equal(supportsBskelVersion(manifest, '2.0.0'), false);

	const plan = planExternalAdapterActivation(manifest);
	assert.equal(plan.valid, true);
	assert.equal(plan.executable, false);
	assert.equal(plan.requiresApproval, true);
	assert.equal(plan.autoInstall, false);
	assert.equal(plan.autoImport, false);
	assert.deepEqual(plan.requestedPermissions, manifest.permissions);
});

test('manifest rejects traversal and permissive execution defaults', () => {
	const manifest = validManifest();
	manifest.entrypoint.path = '../adapter-worker.mjs';
	manifest.permissions.network = 'allow';
	manifest.permissions.subprocess = 'allow';
	manifest.unreviewed = true;

	const result = validateAdapterSdkManifest(manifest);
	assert.equal(result.ok, false);
	assert.match(result.errors.map((e) => `${e.path} ${e.message}`).join('\n'), /unknown top-level/);
	assert.match(result.errors.map((e) => `${e.path} ${e.message}`).join('\n'), /package-relative path/);
	assert.match(result.errors.map((e) => `${e.path} ${e.message}`).join('\n'), /deny-by-default/);
});

test('manifest rejects an inverted compatibility interval', () => {
	const manifest = validManifest();
	manifest.compatibility.bskel = { minInclusive: '2.0.0', maxExclusive: '1.9.0' };
	const result = validateAdapterSdkManifest(manifest);
	assert.equal(result.ok, false);
	assert.match(result.errors.map((e) => e.message).join('\n'), /minInclusive must be lower/);
});


test('SemVer precedence handles prereleases instead of treating them as the final release', () => {
	const manifest = validManifest();
	manifest.compatibility.bskel = { minInclusive: '2.0.0-beta.1', maxExclusive: '2.0.0' };
	assert.equal(validateAdapterSdkManifest(manifest).ok, true);
	assert.equal(supportsBskelVersion(manifest, '2.0.0-beta.1'), true);
	assert.equal(supportsBskelVersion(manifest, '2.0.0-beta.2'), true);
	assert.equal(supportsBskelVersion(manifest, '2.0.0'), false);
});

test('manifest rejects traversal/absolute permission roots and environment assignments', () => {
	const manifest = validManifest();
	manifest.permissions.readRoots = ['../outside'];
	manifest.permissions.writeRoots = ['/tmp/output'];
	manifest.permissions.environment = ['TOKEN=secret'];

	const result = validateAdapterSdkManifest(manifest);
	assert.equal(result.ok, false);
	const messages = result.errors.map((e) => `${e.path} ${e.message}`).join('\n');
	assert.match(messages, /\/permissions\/readRoots/);
	assert.match(messages, /\/permissions\/writeRoots/);
	assert.match(messages, /\/permissions\/environment/);
});

test('manifest rejects SemVer prerelease numeric identifiers with leading zeroes', () => {
	const manifest = validManifest();
	manifest.adapter.version = '1.0.0-01';
	const result = validateAdapterSdkManifest(manifest);
	assert.equal(result.ok, false);
	assert.match(result.errors.map((e) => `${e.path} ${e.message}`).join('\n'), /\/adapter\/version/);
});


test('manifest builder emits deny-by-default permissions and manual activation', () => {
	const built = createAdapterSdkManifest({
		adapter: { id: 'typescript-nestjs', title: 'NestJS', version: '0.1.0' },
		bskel: { minInclusive: '1.9.0', maxExclusive: '2.0.0' },
		entrypointPath: 'adapter-worker.mjs',
		fixtures: ['fixtures/minimal'],
		verificationBasis: 'synthetic-only',
		environment: ['NODE_ENV'],
	});
	assert.equal(built.permissions.network, 'deny-by-default');
	assert.equal(built.permissions.subprocess, 'deny-by-default');
	assert.deepEqual(built.permissions.writeRoots, []);
	assert.deepEqual(built.permissions.readRoots, ['.']);
	assert.equal(built.activation.mode, ACTIVATION_MODE);
	assert.equal(validateAdapterSdkManifest(built).ok, true);
});

test('manifest builder refuses unsafe roots instead of returning a partial manifest', () => {
	assert.throws(() => createAdapterSdkManifest({
		adapter: { id: 'typescript-nestjs', title: 'NestJS', version: '0.1.0' },
		bskel: { minInclusive: '1.9.0', maxExclusive: '2.0.0' },
		entrypointPath: 'adapter-worker.mjs',
		fixtures: ['fixtures/minimal'],
		verificationBasis: 'synthetic-only',
		readRoots: ['../outside'],
	}), /invalid adapter SDK manifest/);
});


test('manifest rejects T20 injection-class inherited environment names', () => {
	for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'RUBYOPT', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'JAVA_TOOL_OPTIONS']) {
		const manifest = validManifest();
		manifest.permissions.environment = [name];
		const result = validateAdapterSdkManifest(manifest);
		assert.equal(result.ok, false, name);
		assert.match(result.errors.map((e) => e.message).join('\n'), /injection|runner-owned|forbidden/i);
	}
});

test('manifest bounds large permission and fixture collections', () => {
	const roots = validManifest();
	roots.permissions.readRoots = Array.from({ length: 257 }, (_, i) => `src/r${i}`);
	assert.equal(validateAdapterSdkManifest(roots).ok, false);

	const fixtures = validManifest();
	fixtures.fixtures = Array.from({ length: 257 }, (_, i) => `fixtures/f${i}`);
	assert.equal(validateAdapterSdkManifest(fixtures).ok, false);
});
