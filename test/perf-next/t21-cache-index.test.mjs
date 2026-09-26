import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createArtifactStore } from '../../lib/artifact-store-next/store.mjs';
import { createCacheIndex } from '../../lib/artifact-store-next/cache-index.mjs';
import { digestJson } from '../../lib/scan-scheduler-next/cache-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_INDEX_MODULE = path.resolve(__dirname, '../../lib/artifact-store-next/cache-index.mjs');
const CACHE_INDEX_MODULE_URL = pathToFileURL(CACHE_INDEX_MODULE).href;

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-cache-index-')); }

test('cache index persists exact artifact refs, dependencies and sorted listing', () => {
	const root = scratch();
	const store = createArtifactStore(path.join(root, '.sbf', 'cache-next', 'artifacts'));
	const index = createCacheIndex(root);
	const aKey = digestJson({ key: 'a' });
	const bKey = digestJson({ key: 'b' });
	const a = store.put('A');
	const b = store.put('B');
	index.set(bKey, b, { dependencies: ['src/z.js', 'src/a.js', 'src/a.js'] });
	index.set(aKey, a, { metadata: { adapter: 'example' } });
	assert.deepEqual(index.get(bKey).dependencies, ['src/a.js', 'src/z.js']);
	assert.deepEqual(index.list().map((x) => x.cache_key), [aKey, bKey].sort());
	assert.deepEqual(index.reachableArtifactRefs().map((x) => x.digest).sort(), [a.digest, b.digest].sort());
	assert.equal(createCacheIndex(root).get(aKey).artifact.digest, a.digest);
});

test('cache index fails closed on corrupted state instead of silently resetting it', () => {
	const root = scratch();
	const index = createCacheIndex(root);
	fs.mkdirSync(path.dirname(index.path), { recursive: true });
	fs.writeFileSync(index.path, '{"schema":"wrong","entries":{}}\n');
	assert.throws(() => index.list(), /invalid cache index/);
});

test('cache index path cannot escape the repo root', () => {
	const root = scratch();
	assert.throws(() => createCacheIndex(root, { relativePath: '../outside.json' }), /inside repoRoot/);
});

test('two OS processes updating the same cache index preserve both entries', async () => {
	const root = scratch();
	const driver = path.join(root, 'writer.mjs');
	fs.writeFileSync(driver, `
		import { createCacheIndex } from ${JSON.stringify(CACHE_INDEX_MODULE_URL)};
		const [, , root, key, digest] = process.argv;
		createCacheIndex(root).set(key, { algorithm: 'sha256', digest, size: 1 }, { dependencies: ['src/' + key.slice(0, 4)] });
	`);
	const key1 = digestJson({ process: 1 });
	const key2 = digestJson({ process: 2 });
	const artifact1 = digestJson({ artifact: 1 });
	const artifact2 = digestJson({ artifact: 2 });
	function run(key, digest) {
		return new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [driver, root, key, digest], { stdio: ['ignore', 'ignore', 'pipe'] });
			let stderr = '';
			child.stderr.on('data', (x) => { stderr += x; });
			child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}: ${stderr}`)));
		});
	}
	await Promise.all([run(key1, artifact1), run(key2, artifact2)]);
	const index = createCacheIndex(root);
	assert.deepEqual(index.list().map((x) => x.cache_key), [key1, key2].sort());
});

test('dependency invalidation removes only cache entries that read changed paths', () => {
	const root = scratch();
	const index = createCacheIndex(root);
	const a = digestJson({ key: 'a' });
	const b = digestJson({ key: 'b' });
	const ar = { algorithm: 'sha256', digest: digestJson({ artifact: 'a' }), size: 1 };
	const br = { algorithm: 'sha256', digest: digestJson({ artifact: 'b' }), size: 1 };
	index.set(a, ar, { dependencies: ['src/a.js'] });
	index.set(b, br, { dependencies: ['src/b.js'] });
	const removed = index.invalidateDependencies(['src/a.js', 'src/unrelated.js']);
	assert.deepEqual(removed.map((x) => x.cache_key), [a]);
	assert.equal(index.get(a), null);
	assert.equal(index.get(b).artifact.digest, br.digest);
});
