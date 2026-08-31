// D-gate-attestation-signing: cryptographic primitives for signed gate attestations -- Node's
// built-in `crypto` module only (Ed25519, available since Node 12, well within this project's
// >=18 floor), zero new dependencies. Deliberately minimal: this module knows how to canonicalize,
// sign, and verify a JSON payload -- it has no opinion about WHERE a key lives (bin/bskel.mjs's
// `--key`/`--pubkey` flags are the only interface, per the user's own explicit choice to reject a
// new home-directory key-storage convention for this slice -- see DECISIONS.md).
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { sortKeysDeep } from './gates.mjs';

export function generateKeypair() {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	return {
		publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
		privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
	};
}

// Deep-sorted, whitespace-free JSON -- the ONLY thing that's ever actually signed/verified.
// Reusing lib/gates.mjs's own sortKeysDeep() (already proven correct via every gate's `inputs`
// field) rather than a second, possibly-subtly-different implementation.
export function canonicalize(value) {
	return JSON.stringify(sortKeysDeep(value));
}

export function signPayload(payload, privateKeyPem) {
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
