import { createHash } from 'node:crypto';

const DIGEST_RE = /^[0-9a-f]{64}$/;

function canonical(value, path = '$') {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError(`${path}: cache-key material must not contain non-finite numbers`);
		return value;
	}
	if (Array.isArray(value)) return value.map((item, index) => canonical(item, `${path}[${index}]`));
	if (typeof value === 'object') {
		const out = {};
		for (const key of Object.keys(value).sort()) {
			const child = value[key];
			if (child === undefined || typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint') {
				throw new TypeError(`${path}.${key}: unsupported cache-key material type ${typeof child}`);
			}
			out[key] = canonical(child, `${path}.${key}`);
		}
		return out;
	}
	throw new TypeError(`${path}: unsupported cache-key material type ${typeof value}`);
}

export function stableJson(value) {
	return JSON.stringify(canonical(value));
}

export function sha256Bytes(value) {
	const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
	return createHash('sha256').update(bytes).digest('hex');
}

export function digestJson(value) {
	return sha256Bytes(stableJson(value));
}

function requireDigest(name, value) {
	if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
		throw new TypeError(`${name} must be a lowercase sha256 hex digest`);
	}
	return value;
}

function requireText(name, value) {
	if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
	return value;
}

// This is deliberately a CACHE identity, not a ContractRef identity. Every dimension that can
// change parse/scan semantics is labeled so a caller cannot accidentally reuse a cache entry after
// changing a parser, adapter, schema, policy or runtime profile while source bytes stay unchanged.
export function buildScanCacheKey({
	namespace = 'bskel.scan-cache/1',
	sourceDigest,
	resolverDigest,
	configDigest,
	parserDigest,
	adapterDigest,
	schemaDigest,
	policyDigest,
	runtimeFingerprint,
}) {
	const material = {
		namespace: requireText('namespace', namespace),
		source_digest: requireDigest('sourceDigest', sourceDigest),
		resolver_digest: requireDigest('resolverDigest', resolverDigest),
		config_digest: requireDigest('configDigest', configDigest),
		parser_digest: requireDigest('parserDigest', parserDigest),
		adapter_digest: requireDigest('adapterDigest', adapterDigest),
		schema_digest: requireDigest('schemaDigest', schemaDigest),
		policy_digest: requireDigest('policyDigest', policyDigest),
		runtime_fingerprint: requireText('runtimeFingerprint', runtimeFingerprint),
	};
	return {
		algorithm: 'sha256',
		digest: digestJson(material),
		material,
	};
}
