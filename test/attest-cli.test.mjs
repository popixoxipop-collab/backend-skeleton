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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, buildFixtureRepo, initThroughScanDisposition } from './_contract-fixture.mjs';
import { signPayload } from '../lib/attest.mjs';

const FEATURE = '001-widget-management';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

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
	assert.equal(report.schema, 'sbf.gate-export/3');
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

// D-attestation-payload-completeness (K2-K6): the new schema /2 payload fields, dirty-tree
// refusal, opt-in verify assertions, and key_id.

test('a signed attestation carries a real signature.key_id that round-trips through attest verify', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const dir = keysDir();
	const { private_key: privateKey, public_key: publicKey } = keygen(dir);
	const outFile = path.join(root, 'attestation.json');
	assert.equal(run(['gate', 'export', '--feature', FEATURE, '--sign', '--key', privateKey, '--out', outFile], root).code, 0);

	const attestation = JSON.parse(fs.readFileSync(outFile, 'utf8'));
	assert.match(attestation.signature.key_id, /^ed25519:[0-9a-f]{32}$/);
	assert.equal(attestation.report.schema, 'sbf.gate-export/3');
	assert.match(attestation.report.tool.version, /^\d+\.\d+\.\d+/);
	assert.deepEqual(attestation.report.tool.gate_names.length > 0, true);
	assert.equal(attestation.report.tool.canonicalization, 'sortkeysdeep-json');

	const verify = run(['attest', 'verify', '--file', outFile, '--pubkey', publicKey, '--json'], root);
	assert.equal(verify.code, 0);
});

test('attest verify prints a key_id mismatch note (and still fails) when the wrong --pubkey is supplied', () => {
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
	const body = JSON.parse(verify.stdout);
	assert.equal(body.valid, false);
	assert.match(body.key_id_note, /you may have the wrong public key/);
});

test('tampering with newly-added /2 fields (tool.version, artifacts.contract_hash, verdict.ok) each independently fails verification', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const dir = keysDir();
	const { private_key: privateKey, public_key: publicKey } = keygen(dir);
	// Written OUTSIDE the git repo (a fresh tmpdir per iteration) -- writing into `root` itself
	// would make the tree dirty and trip this same item's OWN new --sign dirty-tree refusal on the
	// next loop iteration, which is a test-harness artifact, not the thing under test here.
	const scratch = keysDir();

	for (const mutate of [
		(a) => { a.report.tool.version = '999.999.999'; },
		(a) => { a.report.artifacts.contract_hash = 'f'.repeat(64); },
		(a) => { a.report.verdict.ok = !a.report.verdict.ok; },
	]) {
		const outFile = path.join(scratch, `attestation-${Math.random()}.json`);
		assert.equal(run(['gate', 'export', '--feature', FEATURE, '--sign', '--key', privateKey, '--out', outFile], root).code, 0);
		const attestation = JSON.parse(fs.readFileSync(outFile, 'utf8'));
		mutate(attestation);
		const tamperedFile = `${outFile}.tampered.json`;
		fs.writeFileSync(tamperedFile, JSON.stringify(attestation, null, 2));
		const verify = run(['attest', 'verify', '--file', tamperedFile, '--pubkey', publicKey, '--json'], root);
		assert.equal(verify.code, 1);
		assert.equal(JSON.parse(verify.stdout).valid, false);
	}
});

test('gate export --sign refuses a dirty working tree (exit 13 DIRTY), and --allow-dirty overrides it, recording the acknowledgement inside the signed payload', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	fs.writeFileSync(path.join(root, 'untracked-scratch-file.txt'), 'x');
	const dir = keysDir();
	const { private_key: privateKey, public_key: publicKey } = keygen(dir);
	const outFile = path.join(root, 'attestation.json');

	const refused = run(['gate', 'export', '--feature', FEATURE, '--sign', '--key', privateKey, '--out', outFile], root);
	assert.equal(refused.code, 13); // DIRTY
	assert.match(refused.stderr, /refusing to sign an attestation over a dirty working tree/);
	assert.ok(!fs.existsSync(outFile));

	const allowed = run(['gate', 'export', '--feature', FEATURE, '--sign', '--key', privateKey, '--out', outFile, '--allow-dirty'], root);
	assert.equal(allowed.code, 0, allowed.stderr);
	const attestation = JSON.parse(fs.readFileSync(outFile, 'utf8'));
	assert.equal(attestation.report.git.dirty, true);
	assert.equal(attestation.report.git.dirty_acknowledged, true);
	assert.ok(attestation.report.git.dirty_file_count >= 1);

	const verify = run(['attest', 'verify', '--file', outFile, '--pubkey', publicKey, '--json'], root);
	assert.equal(verify.code, 0);
});

test('--allow-dirty without --sign is refused as a silently-ignored flag would be (BAD_ARGS)', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const result = run(['gate', 'export', '--feature', FEATURE, '--allow-dirty'], root);
	assert.equal(result.code, 14); // BAD_ARGS
	assert.match(result.stderr, /--allow-dirty only has an effect together with --sign/);
});

test('unsigned gate export on a dirty tree is completely unaffected (no refusal, unchanged behavior)', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	fs.writeFileSync(path.join(root, 'untracked-scratch-file.txt'), 'x');
	const result = run(['gate', 'export', '--feature', FEATURE, '--json'], root);
	assert.equal(result.code, 0);
	assert.equal(JSON.parse(result.stdout).git.dirty, true);
});

test('attest verify --expect-head: passes for the real HEAD, fails (exit 22, valid still true) for a wrong one', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const dir = keysDir();
	const { private_key: privateKey, public_key: publicKey } = keygen(dir);
	const outFile = path.join(root, 'attestation.json');
	assert.equal(run(['gate', 'export', '--feature', FEATURE, '--sign', '--key', privateKey, '--out', outFile], root).code, 0);
	const realHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

	const ok = run(['attest', 'verify', '--file', outFile, '--pubkey', publicKey, '--expect-head', realHead, '--json'], root);
	assert.equal(ok.code, 0);
	assert.equal(JSON.parse(ok.stdout).assertions[0].ok, true);

	const wrong = run(['attest', 'verify', '--file', outFile, '--pubkey', publicKey, '--expect-head', '0'.repeat(40), '--json'], root);
	assert.equal(wrong.code, 22); // ATTESTATION_ASSERTION_FAILED
	const wrongBody = JSON.parse(wrong.stdout);
	assert.equal(wrongBody.valid, true, 'a genuinely valid signature must not be reported as invalid just because an opt-in assertion failed');
	assert.equal(wrongBody.assertions[0].ok, false);
});

test('attest verify --max-age-minutes: 0 disables the check entirely; a real recent attestation passes a generous limit', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const dir = keysDir();
	const { private_key: privateKey, public_key: publicKey } = keygen(dir);
	const outFile = path.join(root, 'attestation.json');
	assert.equal(run(['gate', 'export', '--feature', FEATURE, '--sign', '--key', privateKey, '--out', outFile], root).code, 0);

	const disabled = run(['attest', 'verify', '--file', outFile, '--pubkey', publicKey, '--max-age-minutes', '0', '--json'], root);
	assert.equal(disabled.code, 0);
	assert.equal(JSON.parse(disabled.stdout).assertions.length, 0);

	const fresh = run(['attest', 'verify', '--file', outFile, '--pubkey', publicKey, '--max-age-minutes', '5', '--json'], root);
	assert.equal(fresh.code, 0);
	assert.equal(JSON.parse(fresh.stdout).assertions[0].ok, true);
});

test('attest verify --max-age-minutes: a hand-edited-then-re-signed attestation two hours in the past fails with exit 22 (valid still true)', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const dir = keysDir();
	const { private_key: privateKey, public_key: publicKey } = keygen(dir);
	const outFile = path.join(root, 'attestation.json');
	assert.equal(run(['gate', 'export', '--feature', FEATURE, '--sign', '--key', privateKey, '--out', outFile], root).code, 0);

	const attestation = JSON.parse(fs.readFileSync(outFile, 'utf8'));
	attestation.report.generated_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
	attestation.signature.value = signPayload(attestation.report, fs.readFileSync(privateKey, 'utf8'));
	fs.writeFileSync(outFile, JSON.stringify(attestation, null, 2));

	const result = run(['attest', 'verify', '--file', outFile, '--pubkey', publicKey, '--max-age-minutes', '5', '--json'], root);
	assert.equal(result.code, 22);
	const body = JSON.parse(result.stdout);
	assert.equal(body.valid, true);
	assert.equal(body.assertions[0].ok, false);
});

test('attest verify --reject-dirty: passes a clean-tree attestation, fails (exit 22) one signed with --allow-dirty', () => {
	const root = buildFixtureRepo({ coverage: 'complete' });
	initThroughScanDisposition(root);
	const dir = keysDir();
	const { private_key: privateKey, public_key: publicKey } = keygen(dir);

	const cleanOut = path.join(root, 'attestation-clean.json');
	assert.equal(run(['gate', 'export', '--feature', FEATURE, '--sign', '--key', privateKey, '--out', cleanOut], root).code, 0);
	const clean = run(['attest', 'verify', '--file', cleanOut, '--pubkey', publicKey, '--reject-dirty', '--json'], root);
	assert.equal(clean.code, 0);

	fs.writeFileSync(path.join(root, 'untracked-scratch-file.txt'), 'x');
	const dirtyOut = path.join(root, 'attestation-dirty.json');
	assert.equal(run(['gate', 'export', '--feature', FEATURE, '--sign', '--key', privateKey, '--out', dirtyOut, '--allow-dirty'], root).code, 0);
	const dirty = run(['attest', 'verify', '--file', dirtyOut, '--pubkey', publicKey, '--reject-dirty', '--json'], root);
	assert.equal(dirty.code, 22);
	assert.equal(JSON.parse(dirty.stdout).valid, true);
});

test('backward compatibility: a real sbf.gate-export/1 attestation (checked-in fixture, signed at fixture-creation time) still verifies, and names the legacy format', () => {
	const file = path.join(FIXTURES, 'gate-attestation-v1.json');
	const pubkey = path.join(FIXTURES, 'gate-attestation-v1.pub.pem');
	const verify = run(['attest', 'verify', '--file', file, '--pubkey', pubkey, '--json'], FIXTURES);
	assert.equal(verify.code, 0, verify.stderr);
	const body = JSON.parse(verify.stdout);
	assert.equal(body.valid, true);
	assert.equal(body.report_format, 'sbf.gate-export/1');

	const textMode = run(['attest', 'verify', '--file', file, '--pubkey', pubkey], FIXTURES);
	assert.match(textMode.stdout, /pre-D-attestation-payload-completeness/);
});
