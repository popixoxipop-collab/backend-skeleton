// D-runtime-conformance-receipts (cryptographic receipt attestation): executed cross-language
// verification that receiptSign.ts.tmpl's signatures are genuinely checkable by lib/attest.mjs's
// own verifyPayload() -- the same "prove it, don't just design it" rigor
// test/handles-typescript-codec.test.mjs already established for handles/codec.mjs. Needs no
// external toolchain (Node is this whole CLI's own runtime) -- runs inside plain `npm test`, no
// new CI job. The Java/Python equivalents of this proof (a real javac/pip-installed runtime
// signing, Node verifying) live in scripts/java-compile-smoke.mjs / scripts/python-import-smoke.mjs
// instead, since those two genuinely need a heavier toolchain this file does not.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeypair, verifyPayload } from '../lib/attest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIGN_TEMPLATE = path.join(__dirname, '..', 'handles', 'providers', 'typescript-express', 'templates', 'receiptSign.ts.tmpl');

// A small, test-only driver -- not a generated artifact, never shipped -- that lets this JS test
// exercise the rendered receiptSign.ts the same way a real observeContract.ts would import it.
const DRIVER_SOURCE = `
import { readFileSync } from 'node:fs';
import { setSigningKey, sign, isConfigured } from './receiptSign.ts';

const ops: any[] = JSON.parse(readFileSync(0, 'utf8'));
const results: any[] = [];
for (const op of ops) {
  try {
    if (op.op === 'setSigningKey') {
      setSigningKey(op.pem ?? null);
      results.push({ ok: true, result: isConfigured() });
    } else if (op.op === 'sign') {
      results.push({ ok: true, result: sign(op.receipt) });
    } else {
      results.push({ ok: false, error: \`unknown op \${op.op}\` });
    }
  } catch (e) {
    results.push({ ok: false, error: (e as Error).message });
  }
}
console.log(JSON.stringify(results));
`;

let workDir;
let driverPath;

before(() => {
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-typescript-receipt-sign-'));
	fs.copyFileSync(SIGN_TEMPLATE, path.join(workDir, 'receiptSign.ts')); // zero {{VAR}} substitutions
	driverPath = path.join(workDir, 'driver.ts');
	fs.writeFileSync(driverPath, DRIVER_SOURCE);
});

function runTypeScript(ops) {
	const out = execFileSync('node', ['--experimental-strip-types', driverPath], { input: JSON.stringify(ops), encoding: 'utf8' });
	return JSON.parse(out);
}

function makeReceipt(overrides = {}) {
	return {
		feature_id: '001-widget-management',
		feature_uid: 'e957347e-3794-4c71-92a8-cec75dec1c97',
		operation_id: 'findWidget',
		contract_ref: 'deadbeef'.repeat(8),
		verb: 'GET',
		status: 200,
		recorded_at: '2026-09-10T00:00:00.000Z',
		violations: [{ pointer: '/body/name', keyword: 'type', message: 'expected string' }],
		...overrides,
	};
}

test('sign in TypeScript, verify in Node (lib/attest.mjs) -- a real Ed25519 keypair, byte-identical canonicalization', () => {
	const { publicKeyPem, privateKeyPem } = generateKeypair();
	const receipt = makeReceipt();
	const [setResult, signResult] = runTypeScript([
		{ op: 'setSigningKey', pem: privateKeyPem },
		{ op: 'sign', receipt },
	]);
	assert.equal(setResult.ok, true);
	assert.equal(setResult.result, true, 'isConfigured() must be true once a real key is set');
	assert.equal(signResult.ok, true, signResult.error);

	const valid = verifyPayload(receipt, signResult.result, publicKeyPem);
	assert.equal(valid, true, "a signature produced by the TypeScript template must verify against lib/attest.mjs's own verifyPayload()");
});

test('cross-language canonicalization survives non-ASCII, a forward slash, and a quote in a violation message', () => {
	const { publicKeyPem, privateKeyPem } = generateKeypair();
	const receipt = makeReceipt({
		violations: [{ pointer: '/body/name', keyword: 'pattern', message: 'héllo wörld / slash "quote" 日本語' }],
	});
	const [, signResult] = runTypeScript([
		{ op: 'setSigningKey', pem: privateKeyPem },
		{ op: 'sign', receipt },
	]);
	assert.equal(signResult.ok, true, signResult.error);
	assert.equal(verifyPayload(receipt, signResult.result, publicKeyPem), true);
});

test('tamper detection: a signature produced in TypeScript fails Node verification once the receipt is mutated after signing', () => {
	const { publicKeyPem, privateKeyPem } = generateKeypair();
	const receipt = makeReceipt();
	const [, signResult] = runTypeScript([
		{ op: 'setSigningKey', pem: privateKeyPem },
		{ op: 'sign', receipt },
	]);
	assert.equal(signResult.ok, true, signResult.error);
	const tampered = { ...receipt, status: 500 };
	assert.equal(verifyPayload(tampered, signResult.result, publicKeyPem), false);
});

test('wrong keypair: a genuine signature does not verify against an unrelated public key', () => {
	const { privateKeyPem } = generateKeypair();
	const { publicKeyPem: wrongPublicKeyPem } = generateKeypair();
	const receipt = makeReceipt();
	const [, signResult] = runTypeScript([
		{ op: 'setSigningKey', pem: privateKeyPem },
		{ op: 'sign', receipt },
	]);
	assert.equal(signResult.ok, true, signResult.error);
	assert.equal(verifyPayload(receipt, signResult.result, wrongPublicKeyPem), false);
});

test('isConfigured() is false before setSigningKey, and sign() throws -- unconfigured means no accidental signing', () => {
	const [signResult] = runTypeScript([{ op: 'sign', receipt: makeReceipt() }]);
	assert.equal(signResult.ok, false);
	assert.match(signResult.error, /called before setSigningKey/);
});

test("setSigningKey(null) / a blank string both mean unconfigured -- matches every provider's \"unset stays unsigned\" contract", () => {
	const [nullResult] = runTypeScript([{ op: 'setSigningKey', pem: null }]);
	assert.equal(nullResult.result, false);
	const [emptyResult] = runTypeScript([{ op: 'setSigningKey', pem: '   ' }]);
	assert.equal(emptyResult.result, false);
});
