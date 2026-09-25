import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { digestJson } from '../../lib/scan-scheduler-next/cache-key.mjs';
import { runLegacyScanCached } from '../../lib/scan-scheduler-next/legacy-cache.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FIXTURES = {
	'java-spring': 'test/fixtures/java-spring',
	'ruby-rails': 'test/fixtures/ruby-rails/backend',
	'python-fastapi': 'test/fixtures/python-fastapi/backend',
	'typescript-express': 'test/fixtures/typescript-express/backend',
	'javascript-express': 'test/fixtures/javascript-express/backend',
};

function adapterById(id) {
	const adapter = ADAPTERS.find((candidate) => candidate.id === id);
	assert.ok(adapter, `expected shipped adapter ${id}`);
	return adapter;
}

for (const [id, fixtureRel] of Object.entries(FIXTURES)) {
	test(`T21 cache OFF/miss/hit equivalence: ${id}`, async () => {
		const sourceRoot = path.join(ROOT, fixtureRel);
		const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), `bskel-t21-${id}-`));
		const adapter = adapterById(id);
		const implementationDigest = digestJson({ t21_test_revision: 1, adapter_id: id });

		const off = await runLegacyScanCached({
			repoRoot: sourceRoot, cacheRoot, adapter, terms: [], implementationDigest, useCache: false,
		});
		const miss = await runLegacyScanCached({
			repoRoot: sourceRoot, cacheRoot, adapter, terms: [], implementationDigest, useCache: true,
		});
		const hit = await runLegacyScanCached({
			repoRoot: sourceRoot, cacheRoot, adapter, terms: [], implementationDigest, useCache: true,
		});

		assert.equal(off.cache_used, false);
		assert.equal(miss.cache_used, true);
		assert.equal(miss.cache_hit, false);
		assert.equal(hit.cache_hit, true);
		assert.equal(off.cache_key, miss.cache_key);
		assert.equal(miss.cache_key, hit.cache_key);
		assert.equal(off.source_digest, miss.source_digest);
		assert.equal(miss.source_digest, hit.source_digest);
		assert.deepEqual(miss.report, off.report);
		assert.deepEqual(hit.report, off.report);
		assert.equal(JSON.stringify(miss.report), JSON.stringify(off.report));
		assert.equal(JSON.stringify(hit.report), JSON.stringify(off.report));
		assert.deepEqual(hit.artifact, miss.artifact);
	});
}

test('T21 legacy scan cache key changes when terms or implementation revision changes', async () => {
	const sourceRoot = path.join(ROOT, FIXTURES['javascript-express']);
	const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-key-drift-'));
	const adapter = adapterById('javascript-express');
	const v1 = digestJson({ revision: 1 });
	const v2 = digestJson({ revision: 2 });
	const a = await runLegacyScanCached({ repoRoot: sourceRoot, cacheRoot, adapter, terms: [], implementationDigest: v1, useCache: false });
	const b = await runLegacyScanCached({ repoRoot: sourceRoot, cacheRoot, adapter, terms: ['user'], implementationDigest: v1, useCache: false });
	const c = await runLegacyScanCached({ repoRoot: sourceRoot, cacheRoot, adapter, terms: [], implementationDigest: v2, useCache: false });
	assert.notEqual(a.cache_key, b.cache_key);
	assert.notEqual(a.cache_key, c.cache_key);
});

test('T21 legacy scan cache refuses missing implementation identity', async () => {
	const sourceRoot = path.join(ROOT, FIXTURES['python-fastapi']);
	await assert.rejects(
		runLegacyScanCached({ repoRoot: sourceRoot, cacheRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-noimpl-')), adapter: adapterById('python-fastapi') }),
		/implementationDigest/,
	);
});

test('T21 project cache namespace changes the key without changing the legacy report', async () => {
	const sourceRoot = path.join(ROOT, FIXTURES['javascript-express']);
	const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-namespace-'));
	const adapter = adapterById('javascript-express');
	const implementationDigest = digestJson({ revision: 'namespace-test' });
	const ns1 = digestJson({ project: 'one' });
	const ns2 = digestJson({ project: 'two' });
	const first = await runLegacyScanCached({ repoRoot: sourceRoot, cacheRoot, adapter, terms: [], implementationDigest, cacheNamespace: ns1, useCache: false });
	const second = await runLegacyScanCached({ repoRoot: sourceRoot, cacheRoot, adapter, terms: [], implementationDigest, cacheNamespace: ns2, useCache: false });
	assert.notEqual(first.cache_key, second.cache_key);
	assert.deepEqual(first.report, second.report);
});
