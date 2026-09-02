// D5/D6 (DECISIONS.md): the "handle" is a composite address -- kind:type:uuid[:pointer],
// base64url-encoded with an `sbf1_` prefix -- extending Relay's `base64(Type:id)` global-ID
// pattern with an RFC 6901 JSON Pointer for field-level addressing. This is the JS reference
// implementation; handles/providers/java-spring/templates/HandleCodec.java.tmpl and
// handles/providers/python-fastapi/templates/codec.py.tmpl must stay byte-identical in behavior --
// executed, both directions, cross-checked against test/handles-java-codec.test.mjs and
// test/handles-python-codec.test.mjs respectively (test/handles-codec.test.mjs only self-tests
// this file's own JS-side behavior, it does not cross-check either other language).
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

// D-handle-identity-contract-freeze (Phase 3): scheme-dispatch table, not a hardcoded 'sbf1_'
// check -- reserves the discriminant for a future `sbf2_` scheme (Phase 6, capability-scoped
// handles) to register itself here additively, without ever changing how an existing 'sbf1_'
// token decodes. encodeHandle() is untouched -- it still only ever emits 'sbf1_' tokens.
const HANDLE_DECODERS = { sbf1: decodeSbf1Handle };

export function decodeHandle(token) {
	const scheme = typeof token === 'string' && token.includes('_') ? token.slice(0, token.indexOf('_')) : token;
	const decoder = typeof scheme === 'string' ? HANDLE_DECODERS[scheme] : undefined;
	if (!decoder) throw new Error('not an sbf1 handle (missing "sbf1_" prefix)');
	return decoder(token);
}

function decodeSbf1Handle(token) {
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
// offline without a DB round-trip. O3 (D-handle-uid-type-binding): ALL three kinds now hash a
// `type:uuid[:...]` discriminant through UUIDv5 -- kind=r used to return `uuid` verbatim (no type
// binding at all), so two different resource TYPES sharing the same resourceUid derived the SAME
// handle_uid and collided on the same `sbf_handle` primary key (silently blending their
// featureUid/operationId/contractRef, and letting HandleService.revoke() on one type's handle
// also revoke the other's -- the literal same row). Provably collision-free across kinds without
// a token-format change: kind=f's discriminant always has a pointer segment starting with "/"
// (RFC 6901), kind=o's always ends in the literal ":o" with no leading slash, and kind=r's never
// has a third segment at all -- no two different (kind, type, uuid, pointer) tuples can ever
// produce the same discriminant string.
export function deriveHandleUid({ kind, type, uuid, pointer }) {
	if (kind === 'r') return uuidv5(NS_SBF_FIELD, `${type}:${uuid}`);
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
