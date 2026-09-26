import { stableJson } from './cache-key.mjs';

function defaultSerialize(value) {
	return Buffer.from(`${stableJson(value)}\n`, 'utf8');
}

function defaultDeserialize(bytes) {
	return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

// Cache is an optimization only: compute() remains the source of truth on misses. A referenced
// artifact that is missing or corrupt is NOT silently converted into a miss, because doing so
// would hide an index/store integrity bug (or unsafe GC) and make cache poisoning non-observable.
export async function runCachedTask({
	cacheKey,
	cacheIndex,
	artifactStore,
	compute,
	dependencies = [],
	metadata = null,
	serialize = defaultSerialize,
	deserialize = defaultDeserialize,
	validate = null,
}) {
	if (!cacheIndex || typeof cacheIndex.get !== 'function' || typeof cacheIndex.set !== 'function') throw new TypeError('cacheIndex must implement get/set');
	if (!artifactStore || typeof artifactStore.put !== 'function' || typeof artifactStore.read !== 'function') throw new TypeError('artifactStore must implement put/read');
	if (typeof compute !== 'function') throw new TypeError('compute must be a function');
	if (typeof serialize !== 'function' || typeof deserialize !== 'function') throw new TypeError('serialize/deserialize must be functions');
	if (validate !== null && typeof validate !== 'function') throw new TypeError('validate must be a function or null');

	const hit = cacheIndex.get(cacheKey);
	if (hit) {
		const raw = artifactStore.read(hit.artifact);
		const value = deserialize(raw);
		if (validate) await validate(value, { cache_hit: true, artifact: hit.artifact });
		return { cache_hit: true, value, artifact: hit.artifact };
	}

	const value = await compute();
	if (validate) await validate(value, { cache_hit: false, artifact: null });
	const raw = serialize(value);
	const artifact = artifactStore.put(raw);
	cacheIndex.set(cacheKey, artifact, { dependencies, metadata });
	return { cache_hit: false, value, artifact };
}
