// D-gate-attestation-signing: cryptographic primitives for signed gate attestations -- Node's
// built-in `crypto` module only (Ed25519, available since Node 12, well within this project's
// >=18 floor), zero new dependencies. Deliberately minimal: this module knows how to canonicalize,
// sign, and verify a JSON payload -- it has no opinion about WHERE a key lives (bin/bskel.mjs's
// `--key`/`--pubkey` flags are the only interface, per the user's own explicit choice to reject a
// new home-directory key-storage convention for this slice -- see DECISIONS.md).
import { generateKeyPairSync, createPublicKey, createHash, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { sortKeysDeep } from './gates.mjs';

export function generateKeypair() {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	return {
		publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
		privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
	};
}

// D-attestation-payload-completeness (K1): the named canonicalization algorithm this module
// implements -- recorded in a signed payload's own `tool.canonicalization` field so a verifier on
// a future bskel build can tell whether it's speaking the same dialect. Kept as `sortkeysdeep-json`
// forever (never silently redefined) -- see K1 in DECISIONS.md for why RFC 8785/JCS was considered
// and rejected for this codebase's value space.
export const CANONICALIZATION_ID = 'sortkeysdeep-json';

// Deep-sorted, whitespace-free JSON -- the ONLY thing that's ever actually signed/verified.
// Reusing lib/gates.mjs's own sortKeysDeep() (already proven correct via every gate's `inputs`
// field) rather than a second, possibly-subtly-different implementation.
export function canonicalize(value) {
	return JSON.stringify(sortKeysDeep(value));
}

// D-attestation-payload-completeness (K1): fail-closed guard, called ONLY from signPayload() --
// verifyPayload() keeps its shipped never-throws contract. A NaN/Infinity/undefined/BigInt/Date/
// function/symbol reaching JSON.stringify would silently serialize to something other than
// itself (or be dropped entirely) -- signing that payload would be signing a lie about what the
// value actually was. Walks the value with the exact JSON path of the first offending node in the
// thrown message, so a caller can find it without a second investigation.
export function assertCanonicalizable(value, jsonPath = '$') {
	if (value === null) return;
	const t = typeof value;
	if (t === 'string' || t === 'boolean') return;
	if (t === 'number') {
		if (!Number.isFinite(value)) throw new Error(`assertCanonicalizable: ${jsonPath} is ${Number.isNaN(value) ? 'NaN' : value}, not a finite JSON number`);
		return;
	}
	if (t === 'undefined') throw new Error(`assertCanonicalizable: ${jsonPath} is undefined`);
	if (t === 'bigint') throw new Error(`assertCanonicalizable: ${jsonPath} is a BigInt, which JSON.stringify cannot represent`);
	if (t === 'function') throw new Error(`assertCanonicalizable: ${jsonPath} is a function`);
	if (t === 'symbol') throw new Error(`assertCanonicalizable: ${jsonPath} is a symbol`);
	if (Array.isArray(value)) {
		value.forEach((item, i) => assertCanonicalizable(item, `${jsonPath}[${i}]`));
		return;
	}
	// t === 'object' from here -- reject anything whose prototype isn't a plain object (Date, Map,
	// Set, a class instance, ...): JSON.stringify would silently call .toJSON() or drop it instead
	// of representing its real shape.
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		throw new Error(`assertCanonicalizable: ${jsonPath} is a non-plain object (${value?.constructor?.name ?? 'unknown'}), not a plain {} or []`);
	}
	for (const [key, v] of Object.entries(value)) assertCanonicalizable(v, `${jsonPath}.${key}`);
}

// D-attestation-payload-completeness (K6): 'ed25519:<32 hex chars>' -- sha256 over the public
// key's SPKI DER bytes, first 16 bytes hex-encoded. A SELECTION HINT for `attest verify`'s error
// message, never a trust claim: it lives OUTSIDE the signed bytes (only `report` is signed), so it
// is exactly as attacker-modifiable as any other envelope field. See K6 in DECISIONS.md.
function keyIdFromDer(der) {
	return `ed25519:${createHash('sha256').update(der).digest('hex').slice(0, 32)}`;
}

export function publicKeyIdFromPublic(publicKeyPem) {
	const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
	return keyIdFromDer(der);
}

export function publicKeyIdFromPrivate(privateKeyPem) {
	const der = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
	return keyIdFromDer(der);
}

export function signPayload(payload, privateKeyPem) {
	assertCanonicalizable(payload);
	const canonical = canonicalize(payload);
	return cryptoSign(null, Buffer.from(canonical), privateKeyPem).toString('base64');
}

// Returns a plain boolean, never throws on a malformed signature/key -- a corrupt or wrong-format
// signature is exactly as "not valid" as a mismatched one, not a distinct error class a caller
// needs to handle differently.
export function verifyPayload(payload, signatureB64, publicKeyPem) {
	const canonical = canonicalize(payload);
	try {
		return cryptoVerify(null, Buffer.from(canonical), publicKeyPem, Buffer.from(signatureB64, 'base64'));
	} catch {
		return false;
	}
}
