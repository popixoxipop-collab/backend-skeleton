// D-gate-attestation-signing: e2e CLI coverage for `bskel attest keygen`/`bskel gate export --sign`/
// `bskel attest verify`. Formalizes the same sequence already proven manually during implementation
// (keygen writes a 0600 private key + refuses to overwrite without --force, sign requires --key,
// a genuine sign+verify round-trip, tamper detection, wrong-pubkey detection, unsigned export still
// works and is now schema-validated).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, buildFixtureRepo, initThroughScanDisposition } from './_contract-fixture.mjs';

const FEATURE = '001-widget-management';

function keysDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-attest-keys-'));
}

function keygen(dir) {
	const result = run(['attest', 'keygen', '--out', dir, '--json'], dir);
	assert.equal(result.code, 0, result.stderr);
	return JSON.parse(result.stdout);
}

test('attest keygen: writes a private key (0600) and a public key, refuses to overwrite without --force', () => {
	const dir = keysDir();
	const { private_key: privateKey, public_key: publicKey } = keygen(dir);
	assert.ok(fs.existsSync(privateKey));
	assert.ok(fs.existsSync(publicKey));
	assert.equal((fs.statSync(privateKey).mode & 0o777).toString(8), '600');
	assert.match(fs.readFileSync(privateKey, 'utf8'), /-----BEGIN PRIVATE KEY-----/);
	assert.match(fs.readFileSync(publicKey, 'utf8'), /-----BEGIN PUBLIC KEY-----/);

	const secondAttempt = run(['attest', 'keygen', '--out', dir], dir);
	assert.equal(secondAttempt.code, 14); // BAD_ARGS
	assert.match(secondAttempt.stderr, /refusing to overwrite existing key file\(s\) without --force/);
});

test('attest keygen --force overwrites an existing keypair', () => {
	const dir = keysDir();
	const first = keygen(dir);
	const firstPrivateContent = fs.readFileSync(first.private_key, 'utf8');
	const second = run(['attest', 'keygen', '--out', dir, '--force', '--json'], dir);
	assert.equal(second.code, 0);
	assert.notEqual(fs.readFileSync(first.private_key, 'utf8'), firstPrivateContent, 'a fresh keypair must actually be generated, not a no-op');
});

test('gate export --sign requires --key, and --key without --sign is refused (avoids a silently-ignored flag)', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const dir = keysDir();
	const { private_key: privateKey } = keygen(dir);

	const noKey = run(['gate', 'export', '--feature', FEATURE, '--sign'], root);
	assert.equal(noKey.code, 14);
	assert.match(noKey.stderr, /--sign requires --key/);

	const keyWithoutSign = run(['gate', 'export', '--feature', FEATURE, '--key', privateKey], root);
	assert.equal(keyWithoutSign.code, 14);
	assert.match(keyWithoutSign.stderr, /--key only has an effect together with --sign/);
});

test('unsigned gate export is unchanged from its pre-signing shape and passes the new schema', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const result = run(['gate', 'export', '--feature', FEATURE, '--json'], root);
	assert.equal(result.code, 0);
	const report = JSON.parse(result.stdout);
	assert.equal(report.schema, 'sbf.gate-export/1');
	assert.equal(report.gates.preflight.current.status, 'pass');
});

test('e2e: full sign -> verify round-trip -- VALID against the genuine file + matching pubkey', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const dir = keysDir();
	const { private_key: privateKey, public_key: publicKey } = keygen(dir);
	const outFile = path.join(root, 'attestation.json');

	const sign = run(['gate', 'export', '--feature', FEATURE, '--sign', '--key', privateKey, '--out', outFile], root);
	assert.equal(sign.code, 0, sign.stderr);
	assert.match(sign.stdout, /\(signed\)/);

	const attestation = JSON.parse(fs.readFileSync(outFile, 'utf8'));
	assert.equal(attestation.schema, 'sbf.gate-attestation/1');
	assert.equal(attestation.signature.algorithm, 'ed25519');
	assert.equal(attestation.report.feature_id, FEATURE);

	const verify = run(['attest', 'verify', '--file', outFile, '--pubkey', publicKey, '--json'], root);
	assert.equal(verify.code, 0);
	const verifyBody = JSON.parse(verify.stdout);
	assert.equal(verifyBody.valid, true);
	assert.equal(verifyBody.report_summary.feature_id, FEATURE);
});

test('e2e: attest verify reports INVALID (and exits non-zero) against a hand-tampered report', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const dir = keysDir();
	const { private_key: privateKey, public_key: publicKey } = keygen(dir);
	const outFile = path.join(root, 'attestation.json');
	assert.equal(run(['gate', 'export', '--feature', FEATURE, '--sign', '--key', privateKey, '--out', outFile], root).code, 0);

	const attestation = JSON.parse(fs.readFileSync(outFile, 'utf8'));
	attestation.report.feature_id = '002-tampered-management';
	const tamperedFile = path.join(root, 'attestation-tampered.json');
	fs.writeFileSync(tamperedFile, JSON.stringify(attestation, null, 2));

	const verify = run(['attest', 'verify', '--file', tamperedFile, '--pubkey', publicKey, '--json'], root);
	assert.equal(verify.code, 1);
	assert.equal(JSON.parse(verify.stdout).valid, false);
});

test('e2e: attest verify reports INVALID against the wrong public key', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const dir = keysDir();
	const { private_key: privateKey } = keygen(dir);
	const otherDir = keysDir();
	const { public_key: wrongPublicKey } = keygen(otherDir);
	const outFile = path.join(root, 'attestation.json');
	assert.equal(run(['gate', 'export', '--feature', FEATURE, '--sign', '--key', privateKey, '--out', outFile], root).code, 0);

	const verify = run(['attest', 'verify', '--file', outFile, '--pubkey', wrongPublicKey, '--json'], root);
	assert.equal(verify.code, 1);
	assert.equal(JSON.parse(verify.stdout).valid, false);
});

test('e2e: attest verify refuses a file that is not a well-formed gate attestation', () => {
	const dir = keysDir();
	const { public_key: publicKey } = keygen(dir);
	const notAnAttestation = path.join(dir, 'not-an-attestation.json');
	fs.writeFileSync(notAnAttestation, JSON.stringify({ hello: 'world' }));

	const verify = run(['attest', 'verify', '--file', notAnAttestation, '--pubkey', publicKey], dir);
	assert.equal(verify.code, 14); // BAD_ARGS
	assert.match(verify.stderr, /not a valid gate attestation/);
});
