// ROADMAP.md Phase 6, item 1 (D-sbf2-capability-codec): the `sbf2_` token FORMAT and its
// Ed25519 sign/verify mechanics -- deliberately INFRASTRUCTURE ONLY. Not wired into
// `handles/codec.mjs`'s `HANDLE_DECODERS` dispatch table, not called from `HandleController`/
// `ResourceResolver`, no CLI command issues or consumes one. ROADMAP's own Phase 6 text is explicit
// about why: `sbf1_` conveys no authority by design (all authority comes from the target app's own
// `@PreAuthorize`-derived check) -- a capability token is a genuinely DIFFERENT design, and this
// project's own Phase 4 pilot (D-handles-pilot-cohort) never exercised a single real cross-tenant
// or delegated-access use case (one resource, one org, straightforward CRUD). Building the actual
// delegation MODEL -- what "scope" grants, how a capability token interacts with the real
// authorization flow, key rotation/multiple-signers/revocation -- against zero real delegation
// requirements is exactly what this project has refused to do everywhere else (D-security-8's own
// "never guess, always explicit" boundary, D-write-safety-phase1's non-UUID refusal, this whole
// project's Data-First Numerics discipline). This module exists so that work, once real
// requirements exist, has real, tested crypto/envelope plumbing to start from rather than a blank
// page -- not because the delegation model itself is considered designed.
//
// Reuses lib/attest.mjs's Ed25519 primitives directly (Node built-in `crypto`, zero new
// dependencies) -- the same canonicalize/sign/verify this project's own gate attestations already
// use, not a second, independently-written crypto path.
import { signPayload, verifyPayload } from '../lib/attest.mjs';

// D-security-10 precedent (handles/codec.mjs's own MAX_HANDLE_TOKEN_LENGTH): a defense-in-depth
// cap before attempting to decode, not a functional requirement. Larger than sbf1's 2048 -- this
// envelope carries a JSON payload plus a base64 Ed25519 signature (~88 bytes), not a bare
// kind:type:uuid:pointer address.
const MAX_CAPABILITY_TOKEN_LENGTH = 4096;
const PREFIX = 'sbf2_';
const BASE64URL_CHARSET_RE = /^[A-Za-z0-9_-]*$/;

// Byte-for-byte the same base64url encode/decode handles/codec.mjs's own encodeHandle/
// decodeSbf1Handle use (duplicated rather than imported -- these are ~3-line helpers with no
// handle-specific meaning, and importing them would wire this file into handles/codec.mjs's own
// module for no real reason beyond avoiding a duplicate).
function base64url(buf) {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
	if (!BASE64URL_CHARSET_RE.test(str)) throw new Error('not valid base64url after the sbf2_ prefix');
	const pad = (4 - (str.length % 4)) % 4;
	const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
	return Buffer.from(padded, 'base64');
}

// The payload shape ROADMAP.md Phase 6 itself names: issuer, audience, expiry, and a scope.
// `scope`'s internal shape is deliberately UNINTERPRETED by this module -- it's carried through
// verbatim, JSON-serializable, nothing more. This module has no opinion about what a "scope"
// value means or how it should be checked against a real request; that's exactly the delegation-
// model design this module deliberately does not make.
export function encodeCapabilityToken({ iss, aud, exp, scope }, privateKeyPem) {
	if (typeof iss !== 'string' || !iss) throw new Error('encodeCapabilityToken requires a non-empty "iss" (issuer)');
	if (typeof aud !== 'string' || !aud) throw new Error('encodeCapabilityToken requires a non-empty "aud" (audience)');
	if (typeof exp !== 'number' || !Number.isFinite(exp)) throw new Error('encodeCapabilityToken requires a numeric "exp" (Unix seconds)');
	if (scope === undefined) throw new Error('encodeCapabilityToken requires a "scope" (any JSON-serializable value, uninterpreted by this codec)');

	const payload = { iss, aud, exp, scope };
	const sig = signPayload(payload, privateKeyPem);
	const envelope = { payload, sig };
	return `${PREFIX}${base64url(Buffer.from(JSON.stringify(envelope), 'utf8'))}`;
}

// Returns { ok: true, payload } or { ok: false, reason } -- never throws on a malformed/tampered/
// expired token. Matches this project's own established convention for routine, expected
// verification failures (contracts/openapi.mjs's loadOpenApiDocument/inlineSchema,
// lib/schema-validate.mjs's validateAgainstSchema), not handles/codec.mjs's own throw-based
// decodeHandle() -- an invalid capability token is an ordinary, expected outcome a caller needs
// to branch on cleanly, not an exceptional program error.
export function decodeCapabilityToken(token, publicKeyPem, { now = Math.floor(Date.now() / 1000) } = {}) {
	if (typeof token !== 'string' || !token.startsWith(PREFIX)) return { ok: false, reason: 'missing sbf2_ prefix' };
	if (token.length > MAX_CAPABILITY_TOKEN_LENGTH) return { ok: false, reason: `token exceeds the maximum length of ${MAX_CAPABILITY_TOKEN_LENGTH} characters` };

	let envelope;
	try {
		const raw = base64urlDecode(token.slice(PREFIX.length)).toString('utf8');
		envelope = JSON.parse(raw);
	} catch (err) {
		return { ok: false, reason: `malformed token: ${err.message}` };
	}
	if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { ok: false, reason: 'malformed token: not an object' };
	const { payload, sig } = envelope;
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'malformed token: missing payload' };
	if (typeof sig !== 'string' || !sig) return { ok: false, reason: 'malformed token: missing signature' };

	if (!verifyPayload(payload, sig, publicKeyPem)) return { ok: false, reason: 'invalid signature' };

	const { iss, aud, exp, scope } = payload;
	if (typeof iss !== 'string' || !iss) return { ok: false, reason: 'malformed payload: missing iss' };
	if (typeof aud !== 'string' || !aud) return { ok: false, reason: 'malformed payload: missing aud' };
	if (typeof exp !== 'number' || !Number.isFinite(exp)) return { ok: false, reason: 'malformed payload: missing exp' };
	if (scope === undefined) return { ok: false, reason: 'malformed payload: missing scope' };
	if (exp <= now) return { ok: false, reason: 'expired' };

	return { ok: true, payload: { iss, aud, exp, scope } };
}
