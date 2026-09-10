#!/usr/bin/env node
// P3 (D-fixture-corpus): the one thing this project has never automated -- proof that
// `bskel handles emit`'s generated Java actually compiles. Runs the full gated workflow against
// test/fixtures/java-compile/ in a scratch copy, then routes the final check through
// `bskel verify --feature ... --build` (not a direct `gradle` call) so this also exercises
// lib/verify.mjs::detectBuildCommand()'s real ./gradlew path end-to-end -- the same code path a
// real user's `bskel verify --build` takes, not a shortcut around it.
//
// Requires `gradle` on PATH (used once, to generate the wrapper -- CI installs it via
// gradle/actions/setup-gradle). Everything after that runs through the generated ./gradlew, the
// same as a real consumer of this tool would have.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bskel, makeFail, establishThroughContract, REPO_ROOT } from './_smoke-lib.mjs';
import { generateKeypair, verifyPayload } from '../lib/attest.mjs';

const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'java-compile');

function sh(cmd, args, cwd, opts = {}) {
	return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
}

const fail = makeFail('java-compile-smoke');

console.log('java-compile-smoke: copying fixture to a scratch git repo...');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-compile-smoke-'));
fs.cpSync(FIXTURE, scratch, { recursive: true });
// D-fixture-corpus (P3): `gradle wrapper` (below) runs AFTER this commit and writes gradlew/
// gradlew.bat/gradle/wrapper/* into the scratch repo -- all of that must be gitignored here too
// (matching this skill's own root .gitignore for test/fixtures/java-compile/), or `bskel
// preflight`'s DIRTY check correctly (and unhelpfully, for this throwaway repo) fails on files
// that were never meant to be tracked. Found by direct execution against a real GitHub Actions
// run, not assumed -- confirmed live.
fs.writeFileSync(path.join(scratch, '.gitignore'), 'specs/\n.sbf/\n.gradle/\nbuild/\ngradlew\ngradlew.bat\ngradle/wrapper/\n');

sh('git', ['init', '--quiet', '--initial-branch=develop'], scratch, { quiet: true });
sh('git', ['config', 'user.email', 'test@example.com'], scratch, { quiet: true });
sh('git', ['config', 'user.name', 'Test'], scratch, { quiet: true });
sh('git', ['add', '-A'], scratch, { quiet: true });
sh('git', ['commit', '--quiet', '-m', 'chore: java-compile-smoke fixture'], scratch, { quiet: true });
const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-compile-smoke-origin-'));
sh('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], bareOrigin, { quiet: true });
sh('git', ['remote', 'add', 'origin', bareOrigin], scratch, { quiet: true });
sh('git', ['push', '--quiet', 'origin', 'develop'], scratch, { quiet: true });

console.log('java-compile-smoke: generating the Gradle wrapper (gradle wrapper --gradle-version 8.8)...');
try {
	sh('gradle', ['wrapper', '--gradle-version', '8.8'], scratch, { quiet: true });
} catch (err) {
	fail(`could not generate the Gradle wrapper -- is \`gradle\` on PATH? (${err.message})`);
}

const FEATURE_ID = '001-widget-management';

console.log('java-compile-smoke: preflight -> feature init -> scan -> disposition -> contract emit -> cross-feature-check -> handles emit...');
establishThroughContract(scratch, fail, {
	featureId: FEATURE_ID, slug: 'widget-management', terms: 'widget', mode: 'reuse', note: 'java-compile-smoke',
	contractStep: { kind: 'emit', args: [] },
});

// A3 (D-patch-strategy): approves Widget's two codegen-eligible fields (see
// test/fixtures/java-compile/.../dto/UpdateWidgetRequest.java) BEFORE handles emit, so this smoke
// test proves the real generated switch-case (Validator + ObjectMapper.convertValue + the
// service's real update method) compiles -- not just the "classified but not approved" stub path,
// which every other resource in this corpus already exercises implicitly.
let r = bskel(['handles', 'patch', 'approve', '--feature', FEATURE_ID, '--resource', 'Widget', '--field', 'label', '--strategy', 'patch-wrapper', '--reason', 'java-compile-smoke'], scratch);
if (r.code !== 0) fail(`handles patch approve (label): ${r.stderr || r.stdout}`);
r = bskel(['handles', 'patch', 'approve', '--feature', FEATURE_ID, '--resource', 'Widget', '--field', 'capacity', '--strategy', 'null-means-unchanged', '--reason', 'java-compile-smoke'], scratch);
if (r.code !== 0) fail(`handles patch approve (capacity): ${r.stderr || r.stdout}`);

r = bskel(['handles', 'emit', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`handles emit: ${r.stderr || r.stdout}`);

// D-runtime-conformance-receipts (cryptographic receipt attestation): observe emit BEFORE the
// --build check below, so the same real ./gradlew compileJava run also proves ReceiptSigner.java/
// ContractObservationAspect.java compile cleanly (spring-boot-starter-aop is already on this
// fixture's own build.gradle). The actual sign->verify round trip runs separately, after --build
// passes -- see the bottom of this script.
console.log('java-compile-smoke: observe emit...');
r = bskel(['observe', 'emit', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`observe emit: ${r.stderr || r.stdout}`);

console.log('java-compile-smoke: bskel verify --feature ... --build (real ./gradlew compileJava)...');
r = bskel(['verify', '--feature', FEATURE_ID, '--build', '--json'], scratch);
let report;
try {
	report = JSON.parse(r.stdout);
} catch {
	fail(`verify --build produced no parseable JSON (exit ${r.code}): ${r.stderr || r.stdout}`);
}
if (report.pass !== true) {
	fail(`verify --build reported pass:false -- ${JSON.stringify(report, null, 2)}`);
}

console.log('java-compile-smoke: PASS -- generated Java compiled cleanly via bskel verify --build.');

// D-runtime-conformance-receipts (cryptographic receipt attestation): the real cross-language
// proof -- sign a receipt in a REAL running JVM via the REAL generated ReceiptSigner.java, verify
// the result in Node via lib/attest.mjs's own verifyPayload() (unmodified). The same rigor
// test/handles-java-codec.test.mjs already established for a different byte-identical claim,
// applied here to canonicalization/signing instead of the handle codec. A JUnit test (not a plain
// `java -cp ...` invocation) is the cheapest way to get a real Gradle-resolved classpath without
// hand-computing one -- reads a Node-written input file, writes a Node-read output file, since
// relaying a return value through Gradle's own console output would be fragile.
console.log('java-compile-smoke: signing a receipt in a real JVM (ReceiptSigner) and verifying it in Node (lib/attest.mjs)...');
const { publicKeyPem, privateKeyPem } = generateKeypair();
const receipt = {
	feature_id: FEATURE_ID,
	feature_uid: '6bcbb17e-72fe-4049-92b5-712125c5c1ec',
	operation_id: 'findWidget',
	contract_ref: 'deadbeef'.repeat(8),
	verb: 'GET',
	status: 200,
	recorded_at: '2026-09-10T00:00:00.000Z',
	violations: [{ pointer: '/body/name', keyword: 'pattern', message: 'héllo wörld / slash "quote" 日本語' }],
};
fs.writeFileSync(path.join(scratch, 'sign-smoke-input.json'), JSON.stringify({ privateKeyPem, receipt }));

const signSmokeTestDir = path.join(scratch, 'src', 'test', 'java', 'com', 'example', 'demo', 'global', 'observe');
fs.mkdirSync(signSmokeTestDir, { recursive: true });
fs.writeFileSync(path.join(signSmokeTestDir, 'SignSmokeTest.java'), `package com.example.demo.global.observe;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Test-only driver for scripts/java-compile-smoke.mjs -- NOT a bskel template, never generated.
 * Reads sign-smoke-input.json (a receipt object + a PKCS#8 Ed25519 private key PEM, both written
 * by the calling Node script), signs the receipt via the REAL generated ReceiptSigner (same
 * package, so its package-private sign()/configure() are directly reachable), and writes the
 * base64 signature to sign-smoke-output.txt so the Node script can verify it against
 * lib/attest.mjs's own verifyPayload().
 */
class SignSmokeTest {

	@Test
	void signsAndWritesTheSignatureForNodeToVerify() throws Exception {
		ObjectMapper mapper = new ObjectMapper();
		JsonNode input = mapper.readTree(new File("sign-smoke-input.json"));
		ReceiptSigner.configure(input.get("privateKeyPem").asText());
		ObjectNode receipt = (ObjectNode) input.get("receipt");
		String signature = ReceiptSigner.sign(receipt);
		Files.writeString(Path.of("sign-smoke-output.txt"), signature);
	}
}
`);

try {
	sh('./gradlew', ['test', '--tests', 'com.example.demo.global.observe.SignSmokeTest', '--console=plain'], scratch, { quiet: true });
} catch (err) {
	fail(`./gradlew test (SignSmokeTest) failed (exit ${err.status}): ${err.stdout || ''}${err.stderr || ''}`);
}

let javaSignature;
try {
	javaSignature = fs.readFileSync(path.join(scratch, 'sign-smoke-output.txt'), 'utf8').trim();
} catch (err) {
	fail(`could not read sign-smoke-output.txt -- SignSmokeTest did not run or did not write it (${err.message})`);
}
if (!verifyPayload(receipt, javaSignature, publicKeyPem)) {
	fail('a signature produced by the real generated ReceiptSigner.java did not verify against lib/attest.mjs\'s own verifyPayload() -- cross-language canonicalization has diverged.');
}
console.log('java-compile-smoke: PASS -- a real Java-signed receipt verified correctly in Node.');

fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
