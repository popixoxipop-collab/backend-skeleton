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

// D-business-rules (R9): rules check -> rules emit BEFORE the --build check below, so the same
// real ./gradlew compileJava run also proves RuleCheck.java/RuleSetLoader.java compile cleanly
// against real Jackson + Spring types. This fixture's contract is emitted without --openapi-file,
// so it carries no requestBodySchema and therefore projects zero rules -- that is the point of
// running it here anyway: the generated executor must compile and load correctly even with an
// empty rule set, which is the state every repo starts in.
console.log('java-compile-smoke: rules check -> rules emit...');
r = bskel(['rules', 'check', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`rules check: ${r.stderr || r.stdout}`);
r = bskel(['rules', 'emit', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`rules emit: ${r.stderr || r.stdout}`);
for (const expected of ['src/main/java/com/example/demo/global/rules/RuleCheck.java', 'src/main/resources/bskel/001-widget-management.rules.json']) {
	if (!fs.existsSync(path.join(scratch, expected))) fail(`rules emit did not write ${expected}`);
}

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

// D-business-rules (R9): the real-toolchain proof the plan's own Verification section requires --
// not just "compiles with zero rules" (already proven above) but "a genuine violation is detected
// at runtime, in a real JVM, against real generated code". Re-emits the contract with a real
// OpenAPI document carrying enough shape to exercise all three predicate kinds (field, cross,
// transition), authors real rules against it, re-emits the runtime resources, and drives the real
// generated RuleSetLoader/RuleCheck from a JUnit test -- same "read a Node-written input, write a
// Node-read output" shape SignSmokeTest above already established.
console.log('java-compile-smoke: business rules -- real OpenAPI doc, real rules, real JVM execution...');
const rulesOpenApiDoc = {
	openapi: '3.1.0',
	info: { title: 'widget', version: '1' },
	paths: {
		'/widgets/{widgetId}': {
			get: {
				operationId: 'findWidget',
				parameters: [{ name: 'widgetId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
				responses: { 200: { description: 'ok' } },
			},
			patch: {
				operationId: 'updateWidget',
				parameters: [{ name: 'widgetId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									capacity: { type: 'integer' },
									ownerName: { type: 'string' },
									status: { type: 'string', enum: ['draft', 'published', 'archived'] },
									startWindow: { type: 'string' },
									endWindow: { type: 'string' },
								},
							},
						},
					},
				},
				responses: { 200: { description: 'ok' } },
			},
		},
	},
};
fs.writeFileSync(path.join(scratch, 'rules-openapi.json'), JSON.stringify(rulesOpenApiDoc));
r = bskel(['contract', 'emit', '--feature', FEATURE_ID, '--openapi-file', 'rules-openapi.json'], scratch);
if (r.code !== 0) fail(`contract emit --openapi-file (rules phase): ${r.stderr || r.stdout}`);

fs.writeFileSync(path.join(scratch, 'specs', FEATURE_ID, 'rules.yaml'), `schema: sbf.feature-rules-source/1
rules:
  - id: capacity-cap
    kind: field
    operation: updateWidget
    pointer: /capacity
    assert: maximum
    value: 500
    reason: java-compile-smoke
  - id: owner-min
    kind: field
    operation: updateWidget
    pointer: /ownerName
    assert: minLength
    value: 3
    reason: java-compile-smoke
  - id: window-order
    kind: cross
    operation: updateWidget
    pointers: [/startWindow, /endWindow]
    assert: lt
    reason: java-compile-smoke
  - id: publish-flow
    kind: transition
    operation: updateWidget
    pointer: /status
    from: [draft]
    to: [published]
    reason: java-compile-smoke
`);
r = bskel(['rules', 'check', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`rules check (real rules): ${r.stderr || r.stdout}`);
r = bskel(['rules', 'emit', '--feature', FEATURE_ID], scratch);
if (r.code !== 0) fail(`rules emit (real rules): ${r.stderr || r.stdout}`);

const ruleExecTestDir = path.join(scratch, 'src', 'test', 'java', 'com', 'example', 'demo', 'global', 'rules');
fs.mkdirSync(ruleExecTestDir, { recursive: true });
fs.writeFileSync(path.join(ruleExecTestDir, 'RuleExecSmokeTest.java'), `package com.example.demo.global.rules;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * Test-only driver for scripts/java-compile-smoke.mjs -- NOT a bskel template, never generated.
 * Drives the REAL generated RuleSetLoader/RuleCheck against a violating payload and a valid one,
 * writes both violation lists to rule-exec-output.json for the Node script to assert against.
 */
class RuleExecSmokeTest {

	@Test
	void checksRealPayloadsAndWritesResultsForNodeToVerify() throws Exception {
		ObjectMapper mapper = new ObjectMapper();
		RuleSetLoader loader = new RuleSetLoader(mapper);
		RuleSetLoader.RuleOperation rules = loader.forOperation("updateWidget");

		JsonNode violating = mapper.readTree("""
			{"capacity": 999, "ownerName": "x", "startWindow": "2026-01-02", "endWindow": "2026-01-01", "status": "published"}
			""");
		JsonNode valid = mapper.readTree("""
			{"capacity": 100, "ownerName": "widget-owner", "startWindow": "2026-01-01", "endWindow": "2026-01-02", "status": "published"}
			""");

		List<RuleCheck.Violation> violatingResult = new java.util.ArrayList<>(RuleCheck.check(rules, violating));
		violatingResult.addAll(RuleCheck.checkTransitions(rules, violating, Map.of("/status", "archived")));

		List<RuleCheck.Violation> validResult = new java.util.ArrayList<>(RuleCheck.check(rules, valid));
		validResult.addAll(RuleCheck.checkTransitions(rules, valid, Map.of("/status", "draft")));

		StringBuilder out = new StringBuilder("{");
		out.append("\\"violatingCount\\":").append(violatingResult.size()).append(",");
		out.append("\\"violatingRuleIds\\":[");
		for (int i = 0; i < violatingResult.size(); i++) {
			if (i > 0) out.append(",");
			out.append("\\"").append(violatingResult.get(i).ruleId()).append("\\"");
		}
		out.append("],");
		out.append("\\"validCount\\":").append(validResult.size());
		out.append("}");
		Files.writeString(Path.of("rule-exec-output.json"), out.toString());
	}
}
`);

try {
	sh('./gradlew', ['test', '--tests', 'com.example.demo.global.rules.RuleExecSmokeTest', '--console=plain'], scratch, { quiet: true });
} catch (err) {
	fail(`./gradlew test (RuleExecSmokeTest) failed (exit ${err.status}): ${err.stdout || ''}${err.stderr || ''}`);
}

let ruleExecResult;
try {
	ruleExecResult = JSON.parse(fs.readFileSync(path.join(scratch, 'rule-exec-output.json'), 'utf8'));
} catch (err) {
	fail(`could not read rule-exec-output.json -- RuleExecSmokeTest did not run or did not write it (${err.message})`);
}
if (ruleExecResult.violatingCount !== 4) {
	fail(`expected exactly 4 violations (capacity-cap, owner-min, window-order, publish-flow) against the deliberately-violating payload, got ${ruleExecResult.violatingCount}: ${JSON.stringify(ruleExecResult.violatingRuleIds)}`);
}
const expectedIds = ['capacity-cap', 'owner-min', 'window-order', 'publish-flow'].sort();
if (JSON.stringify([...ruleExecResult.violatingRuleIds].sort()) !== JSON.stringify(expectedIds)) {
	fail(`violation rule ids did not match -- expected ${JSON.stringify(expectedIds)}, got ${JSON.stringify(ruleExecResult.violatingRuleIds)}`);
}
if (ruleExecResult.validCount !== 0) {
	fail(`expected 0 violations against a payload deliberately constructed to satisfy every rule, got ${ruleExecResult.validCount}`);
}
console.log('java-compile-smoke: PASS -- real generated RuleCheck/RuleSetLoader correctly detected all 4 real violations, and correctly passed a valid payload, in a real JVM.');

fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
