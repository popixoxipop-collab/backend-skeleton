// D5/D6 (DECISIONS.md): the "handle" is a composite address -- kind:type:uuid[:pointer],
// base64url-encoded with an `sbf1_` prefix -- extending Relay's `base64(Type:id)` global-ID
// pattern with an RFC 6901 JSON Pointer for field-level addressing. This is the JS reference
// implementation; handles/providers/java-spring/templates/HandleCodec.java.tmpl must stay byte-identical
// in behavior (see test/handles-codec.test.mjs's cross-check against fixed vectors).
import { createHash } from 'node:crypto';

// Fixed namespace UUID for this skill's field-handle derivation (arbitrary but permanent --
// changing it would silently re-derive every existing field_uid to a different value).
export const NS_SBF_FIELD = 'a3f1c2e0-8b4d-4f1a-9c3e-1d2b3a4c5d6e';

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HANDLE_RE = new RegExp(`^([rfo]):([^:]+):(${UUID_RE})(?::(.*))?$`, 'i');
const BASE64URL_CHARSET_RE = /^[A-Za-z0-9_-]*$/;

// D-security-10: no upper bound on token length before attempting to decode -- a defense-in-
// depth cap, not a functional requirement (real handles are well under this). Found by the
// Codex security review as part of the "other requested checks" pass.
const MAX_HANDLE_TOKEN_LENGTH = 2048;

function base64url(buf) {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// D-security-10: Node's `Buffer.from(str, 'base64')` silently IGNORES characters outside the
// base64 alphabet instead of rejecting them, while Java's `Base64.getUrlDecoder().decode()`
// throws on the same input -- the two implementations' "byte-identical behavior" claim (D5/D6)
// didn't actually hold for malformed input. Found by the Codex security review. The explicit
// charset check below makes the JS side reject exactly what the Java side rejects, before either
// one gets a chance to decode it differently.
function base64urlDecode(str) {
	if (!BASE64URL_CHARSET_RE.test(str)) {
		throw new Error('not valid base64url after the sbf1_ prefix');
	}
	const pad = (4 - (str.length % 4)) % 4;
	const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
	return Buffer.from(padded, 'base64');
}

export function encodeHandle({ kind, type, uuid, pointer = null }) {
	if (!['r', 'f', 'o'].includes(kind)) throw new Error(`invalid handle kind "${kind}" (expected r, f, or o)`);
	if (!type || !uuid) throw new Error('encodeHandle requires both type and uuid');
	if (kind === 'f' && !pointer) throw new Error('field handles (kind=f) require a JSON Pointer');
	// D-security-10: the symmetric case was previously unchecked -- a non-field handle silently
	// carrying a pointer would encode fine and only cause confusion downstream (e.g. patch()
	// deciding "field handle" purely from pointer-presence, not kind). Found by the Codex
	// security review.
	if (kind !== 'f' && pointer) throw new Error(`handle kind "${kind}" must not carry a JSON Pointer (only kind=f field handles do)`);
	const raw = `${kind}:${type}:${uuid}${pointer ? `:${pointer}` : ''}`;
	return `sbf1_${base64url(Buffer.from(raw, 'utf8'))}`;
}

export function decodeHandle(token) {
	if (typeof token !== 'string' || !token.startsWith('sbf1_')) {
		throw new Error('not an sbf1 handle (missing "sbf1_" prefix)');
	}
	if (token.length > MAX_HANDLE_TOKEN_LENGTH) {
		throw new Error(`handle token exceeds the maximum length of ${MAX_HANDLE_TOKEN_LENGTH} characters`);
	}
	const raw = base64urlDecode(token.slice('sbf1_'.length)).toString('utf8');
	const match = raw.match(HANDLE_RE);
	if (!match) throw new Error(`malformed handle payload after decoding: "${raw}"`);
	const [, kind, type, uuid, pointer] = match;
	return { kind: kind.toLowerCase(), type, uuid: uuid.toLowerCase(), pointer: pointer ?? null };
}

function uuidToBytes(uuid) {
	return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(bytes) {
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// RFC 4122 UUIDv5 (name-based, SHA-1). Implemented directly rather than pulling in the `uuid`
// package -- this is the only place a v5 is needed and the algorithm is ~10 lines. Verified
// against the standard test vector in test/handles-codec.test.mjs (NAMESPACE_DNS + "example.com").
export function uuidv5(namespaceUuid, name) {
	const hash = createHash('sha1')
		.update(Buffer.concat([uuidToBytes(namespaceUuid), Buffer.from(name, 'utf8')]))
		.digest();
	const bytes = Buffer.from(hash.subarray(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 4122
	return bytesToUuid(bytes);
}

// The plain-UUID identity of a handle (for use as a DB primary key / foreign key), derivable
// offline without a DB round-trip: kind=r handles ARE the resource's own uuid (no derivation
// needed -- a resource handle and the entity's own PK are the same identity); kind=f handles
// derive a UUIDv5 from type+uuid+pointer, so the same field always gets the same handle_uid
// without ever needing to look it up first.
export function deriveHandleUid({ kind, type, uuid, pointer }) {
	if (kind === 'r') return uuid;
	if (kind === 'f') {
		if (!pointer) throw new Error('field handles require a pointer to derive handle_uid');
		return uuidv5(NS_SBF_FIELD, `${type}:${uuid}:${pointer}`);
	}
	if (kind === 'o') return uuidv5(NS_SBF_FIELD, `${type}:${uuid}:o`);
	throw new Error(`invalid handle kind "${kind}"`);
}

// RFC 6901 JSON Pointer resolution -- used by the `fetch` verb to extract a field's value from
// a resource's serialized shape once the resolver has fetched the whole resource.
export function resolveJsonPointer(obj, pointer) {
	if (pointer == null || pointer === '') return obj;
	if (!pointer.startsWith('/')) throw new Error(`invalid JSON Pointer "${pointer}" -- must start with "/"`);
	const parts = pointer.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
	let current = obj;
	for (const part of parts) {
		if (current == null) return undefined;
		current = Array.isArray(current) ? current[Number(part)] : current[part];
	}
	return current;
}
