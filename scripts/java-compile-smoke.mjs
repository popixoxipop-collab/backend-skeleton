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

// D-resolver-policy-contract (PC12): a SCRATCH-ONLY resource (never added to test/fixtures/
// java-compile/ on disk) -- scripts/java-integration-smoke.mjs boots that on-disk fixture with a
// real @SpringBootTest, which would fail to start with an unimplemented AuthorizationPolicy bean
// in the way. Injected here, into this script's own throwaway copy, before the first commit.
// LedgerController deliberately carries BOTH a valid @PreAuthorize AND a @PostAuthorize ownership
// check on the SAME method -- the exact real-world shape DECISIONS.md's D-resolver-policy-contract
// WHY names: a naive scanner would materialize ROLE_USER and silently ignore the ownership check.
console.log('java-compile-smoke: injecting a scratch-only Ledger resource (companion-annotation case)...');
const ledgerDomain = path.join(scratch, 'src/main/java/com/example/demo/domain/ledger');
fs.mkdirSync(path.join(ledgerDomain, 'domain'), { recursive: true });
fs.mkdirSync(path.join(ledgerDomain, 'application'), { recursive: true });
fs.mkdirSync(path.join(ledgerDomain, 'presentation'), { recursive: true });
fs.writeFileSync(path.join(ledgerDomain, 'domain', 'Ledger.java'), `package com.example.demo.domain.ledger.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.util.UUID;

@Entity
@Table(name = "ledger")
public class Ledger {
	@Id
	private UUID ledgerId;
}
`);
fs.writeFileSync(path.join(ledgerDomain, 'application', 'LedgerService.java'), `package com.example.demo.domain.ledger.application;

import java.util.UUID;

public interface LedgerService {
	Object findLedger(UUID ledgerId);
}
`);
fs.writeFileSync(path.join(ledgerDomain, 'presentation', 'LedgerController.java'), `package com.example.demo.domain.ledger.presentation;

import io.swagger.v3.oas.annotations.Operation;
import org.springframework.security.access.prepost.PostAuthorize;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

@RestController
@RequestMapping("/ledgers")
public class LedgerController {

	// D-resolver-policy-contract: a perfectly-shaped hasRole('USER') sitting next to a
	// @PostAuthorize ownership check this scanner cannot verify -- must NOT auto-materialize.
	@PreAuthorize("hasRole('USER')")
	@PostAuthorize("returnObject.ownerId == authentication.name")
	@Operation(summary = "Fetch a single ledger", operationId = "findLedger")
	@GetMapping("/{ledgerId}")
	public String findLedger(@PathVariable UUID ledgerId) {
		return "ok";
	}
}
`);
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

// Commits the widget feature's own generated output before starting the ledger feature below --
// `establishThroughContract()` runs `bskel preflight` as its first step, which fails DIRTY on the
// uncommitted files `handles emit` just wrote. Matches how a real user actually works (commit one
// feature's generated code before starting the next), not a smoke-test-only workaround.
sh('git', ['add', '-A'], scratch, { quiet: true });
sh('git', ['commit', '--quiet', '-m', 'chore: widget handles emit'], scratch, { quiet: true });
sh('git', ['push', '--quiet', 'origin', 'develop'], scratch, { quiet: true });

// D-resolver-policy-contract (PC12): the Ledger resource injected above, as its OWN feature (not
// widget's) -- proves, against a REAL scan (not a hand-built scanReport, unlike
// test/handles-policy-contract.test.mjs) that `handles emit` genuinely refuses (exit 23) an
// unresolved policy, that --force --reason genuinely bypasses it, and that the materialized
// Widget resource above stays completely unaffected (no WidgetAuthorizationPolicy.java).
const LEDGER_FEATURE_ID = '002-ledger-management';
console.log('java-compile-smoke: ledger feature (companion-annotation-present case) -> scan -> contract -> handles emit (expect refusal)...');
establishThroughContract(scratch, fail, {
	featureId: LEDGER_FEATURE_ID, slug: 'ledger-management', terms: 'ledger', mode: 'reuse', note: 'java-compile-smoke',
	contractStep: { kind: 'emit', args: [] },
});

r = bskel(['handles', 'emit', '--feature', LEDGER_FEATURE_ID, '--json'], scratch);
if (r.code !== 23) fail(`handles emit (ledger, unresolved policy): expected exit 23, got ${r.code}: ${r.stderr || r.stdout}`);
let ledgerRefusal;
try {
	ledgerRefusal = JSON.parse(r.stdout);
} catch {
	fail(`handles emit (ledger, unresolved policy) exited 23 but produced no parseable JSON: ${r.stdout}`);
}
const ledgerGap = (ledgerRefusal.unresolvedPolicies ?? []).find((u) => u.resourceType === 'Ledger' && u.action === 'fetch');
if (!ledgerGap) fail(`handles emit (ledger) exited 23 but unresolvedPolicies did not name Ledger/fetch: ${JSON.stringify(ledgerRefusal.unresolvedPolicies)}`);
if (ledgerGap.kind !== 'companion-annotation-present') fail(`expected Ledger/fetch's unresolved kind to be companion-annotation-present, got ${ledgerGap.kind}`);
console.log('java-compile-smoke: PASS -- handles emit correctly refused (exit 23) an unresolved policy, naming Ledger/fetch/companion-annotation-present.');

const widgetAuthzPolicyPath = path.join(scratch, 'src/main/java/com/example/demo/domain/widget/infrastructure/WidgetAuthorizationPolicy.java');
if (fs.existsSync(widgetAuthzPolicyPath)) fail('WidgetAuthorizationPolicy.java should not exist -- Widget is fully materialized, not delegated');

r = bskel(['handles', 'emit', '--feature', LEDGER_FEATURE_ID, '--force', '--reason', 'java-compile-smoke'], scratch);
if (r.code !== 0) fail(`handles emit (ledger, --force --reason): ${r.stderr || r.stdout}`);
const ledgerAuthzPolicyPath = path.join(scratch, 'src/main/java/com/example/demo/domain/ledger/infrastructure/LedgerAuthorizationPolicy.java');
if (!fs.existsSync(ledgerAuthzPolicyPath)) fail(`handles emit --force wrote no LedgerAuthorizationPolicy.java at ${ledgerAuthzPolicyPath}`);
console.log('java-compile-smoke: PASS -- --force --reason acknowledged the gap and proceeded; LedgerAuthorizationPolicy.java was written.');

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

// D-resolver-policy-contract (PC12): the load-bearing proof -- a REAL Spring application context,
// not just a compile check, showing the unresolved LedgerAuthorizationPolicy genuinely blocks
// LedgerResolver from being constructed (negative), a hand-supplied policy bean genuinely
// unblocks it (positive), and the materialized WidgetResolver boots with no policy bean at all
// (no-regression) -- the same "does a real component graph actually behave this way" rigor
// test/handles-java-codec.test.mjs already established for a different claim.
console.log('java-compile-smoke: real Spring context -- unresolved policy blocks bean construction, a hand-supplied one unblocks it...');
const unresolvedPolicyTestDir = path.join(scratch, 'src/test/java/com/example/demo/domain/ledger/infrastructure');
fs.mkdirSync(unresolvedPolicyTestDir, { recursive: true });
fs.writeFileSync(path.join(unresolvedPolicyTestDir, 'UnresolvedPolicySmokeTest.java'), `package com.example.demo.domain.ledger.infrastructure;

import com.example.demo.domain.ledger.application.LedgerService;
import com.example.demo.domain.widget.application.WidgetService;
import com.example.demo.domain.widget.infrastructure.WidgetResolver;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.validation.Validator;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * Test-only driver for scripts/java-compile-smoke.mjs -- NOT a bskel template, never generated.
 * Proves, in a REAL Spring application context (not a compile-only check), that an unresolved
 * authorization policy genuinely blocks its resolver bean from being constructed, that a
 * hand-supplied policy bean genuinely unblocks it, and that a fully-materialized resource
 * (Widget) needs no such bean at all.
 */
class UnresolvedPolicySmokeTest {

	@Test
	void negative_noPolicyBean_contextRefreshFails() {
		AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext();
		ctx.registerBean(LedgerService.class, () -> mock(LedgerService.class));
		ctx.register(LedgerResolver.class);
		Exception ex = assertThrows(Exception.class, ctx::refresh);
		String chain = causeChainMessages(ex);
		assertTrue(chain.contains("LedgerAuthorizationPolicy"), "cause chain must name LedgerAuthorizationPolicy: " + chain);
		ctx.close();
	}

	@Test
	void positive_withPolicyBean_contextRefreshSucceeds() {
		AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext();
		ctx.registerBean(LedgerService.class, () -> mock(LedgerService.class));
		ctx.registerBean(LedgerAuthorizationPolicy.class, () -> (authentication, action, resourceUid, pointer) -> false);
		ctx.register(LedgerResolver.class);
		ctx.refresh();
		LedgerResolver resolver = ctx.getBean(LedgerResolver.class);
		assertEquals("delegated", resolver.authorizationMode());
		assertFalse(resolver.authorize(null, "fetch", UUID.randomUUID(), null));
		ctx.close();
	}

	@Test
	void noRegression_materializedWidgetResolver_bootsWithNoPolicyBean() {
		AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext();
		ctx.registerBean(WidgetService.class, () -> mock(WidgetService.class));
		ctx.registerBean(Validator.class, () -> mock(Validator.class));
		ctx.registerBean(ObjectMapper.class, () -> new ObjectMapper());
		ctx.register(WidgetResolver.class);
		ctx.refresh();
		WidgetResolver resolver = ctx.getBean(WidgetResolver.class);
		assertEquals("role", resolver.authorizationMode());
		assertTrue(resolver.authorize(null, "fetch", UUID.randomUUID(), null));
		ctx.close();
	}

	@Test
	void writesResultsForNodeToVerify() throws Exception {
		Files.writeString(Path.of("unresolved-policy-output.json"), "{\\"ranAllAssertions\\":true}");
	}

	private static String causeChainMessages(Throwable t) {
		StringBuilder sb = new StringBuilder();
		while (t != null) {
			sb.append(t.getClass().getName()).append(": ").append(t.getMessage()).append(" | ");
			t = t.getCause();
		}
		return sb.toString();
	}
}
`);

try {
	sh('./gradlew', ['test', '--tests', 'com.example.demo.domain.ledger.infrastructure.UnresolvedPolicySmokeTest', '--console=plain'], scratch, { quiet: true });
} catch (err) {
	fail(`./gradlew test (UnresolvedPolicySmokeTest) failed (exit ${err.status}): ${err.stdout || ''}${err.stderr || ''}`);
}
let unresolvedPolicyResult;
try {
	unresolvedPolicyResult = JSON.parse(fs.readFileSync(path.join(scratch, 'unresolved-policy-output.json'), 'utf8'));
} catch (err) {
	fail(`could not read unresolved-policy-output.json -- UnresolvedPolicySmokeTest did not run or did not write it (${err.message})`);
}
if (unresolvedPolicyResult.ranAllAssertions !== true) {
	fail('UnresolvedPolicySmokeTest ran but did not report success');
}
console.log('java-compile-smoke: PASS -- a real Spring context: unresolved policy blocks bean construction, a hand-supplied policy bean unblocks it, and the materialized Widget resolver boots with no policy bean at all.');

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
// Real, live-reproduced Gradle daemon staleness, found while adding the phases below: a
// brand-new source file created by an EXTERNAL process (Node's fs.writeFileSync, not a
// Gradle-visible build action) was sometimes not picked up by the VERY NEXT `./gradlew`
// invocation -- `compileTestJava` failed with "cannot find symbol" for a class that existed
// correctly on disk (confirmed by inspecting the failed run's scratch dir directly), and a
// second attempt hit the same class of staleness one step later ("No tests found for given
// includes" despite the test file existing). Gradle's own file-system-watching daemon feature
// (default-on since Gradle 6.7, used for incremental-build performance) is the documented cause
// of exactly this race between an OS file-change notification and an immediately-following build
// invocation. Disabled here, for the rest of THIS scratch repo's builds only -- not touching the
// SignSmokeTest phase above, which has run reliably without it.
fs.appendFileSync(path.join(scratch, 'gradle.properties'), '\norg.gradle.vfs.watch=false\n');

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
  - id: widget-total
    kind: derived
    resource: Widget
    field: total
    expr:
      op: sub
      args:
        - op: mul
          args: [{ ref: price }, { ref: quantity }]
        - { ref: discount }
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

		// D-business-rules (R5/Phase 3): the real generated WidgetRules.computeTotal(), called
		// directly with real numbers -- proves the derived-field pure function is not just
		// syntactically valid Java (already proven by ./gradlew compileJava above) but computes
		// the real formula correctly: 25.0 * 4 - 10.0 = 90.0.
		double derivedTotal = com.example.demo.global.rules.WidgetRules.computeTotal(25.0, 4, 10.0);

		StringBuilder out = new StringBuilder("{");
		out.append("\\"violatingCount\\":").append(violatingResult.size()).append(",");
		out.append("\\"violatingRuleIds\\":[");
		for (int i = 0; i < violatingResult.size(); i++) {
			if (i > 0) out.append(",");
			out.append("\\"").append(violatingResult.get(i).ruleId()).append("\\"");
		}
		out.append("],");
		out.append("\\"validCount\\":").append(validResult.size()).append(",");
		out.append("\\"derivedTotal\\":").append(derivedTotal);
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
if (Math.abs(ruleExecResult.derivedTotal - 90.0) > 1e-9) {
	fail(`expected the real generated WidgetRules.computeTotal(25.0, 4, 10.0) to equal 90.0 (25*4-10), got ${ruleExecResult.derivedTotal}`);
}
console.log('java-compile-smoke: PASS -- real generated RuleCheck/RuleSetLoader correctly detected all 4 real violations, correctly passed a valid payload, and WidgetRules.computeTotal() computed the real formula correctly, in a real JVM.');

// D-business-rules (R8): proves the AUTOMATIC @EnforceRules/RuleEnforcementAspect wiring itself --
// not just the pure RuleCheck logic above, but the observe/enforce mode branch, the fail-open
// behavior, and (critically) that an enforce-mode rejection message never contains an observed
// payload value. Tests the aspect class directly (Mockito-mocked ProceedingJoinPoint, reflection
// to set the @Value-injected `mode` field) rather than a full @SpringBootTest context -- this
// fixture also carries spring-boot-starter-data-jpa, so a full context boot would need a real or
// embedded datasource, which this DB-free script deliberately does not take on (that's
// scripts/java-integration-smoke.mjs's job). The AOP proxy mechanism itself
// (@Around + @annotation(...) pointcut matching) is the same infrastructure
// ContractObservationAspect/HandleAspect already exercise elsewhere in this corpus -- what's new
// here is this aspect's OWN logic, which is what this test isolates.
console.log('java-compile-smoke: business rules -- @EnforceRules aspect logic (observe vs enforce, redaction, fail-open)...');
// Same directory RuleExecSmokeTest.java already lives in (created above) -- reused, not
// re-created, to avoid a second mkdirSync on a path that already exists.
fs.writeFileSync(path.join(ruleExecTestDir, 'RuleEnforcementAspectSmokeTest.java'), `package com.example.demo.global.rules;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.reflect.MethodSignature;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.server.ResponseStatusException;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * Test-only driver for scripts/java-compile-smoke.mjs -- NOT a bskel template, never generated.
 * Drives the REAL generated RuleEnforcementAspect directly (bypassing Spring's own AOP proxy
 * machinery, which is exercised elsewhere in this corpus by ContractObservationAspect/HandleAspect
 * integration tests) to prove this aspect's OWN observe/enforce branching, redaction, and
 * fail-open behavior.
 */
class RuleEnforcementAspectSmokeTest {

	// A stand-in for a real controller method -- only its @RequestBody parameter and its own
	// @EnforceRules annotation are ever read by the aspect, via reflection, exactly as a real
	// AspectJ pointcut would see a real controller.
	static class FakeController {
		@EnforceRules(operationId = "updateWidget")
		public String updateWidget(@PathVariable UUID widgetId, @RequestBody Map<String, Object> body) {
			return "REAL_METHOD_RAN";
		}
	}

	private static void setMode(RuleEnforcementAspect aspect, String mode) throws Exception {
		Field field = RuleEnforcementAspect.class.getDeclaredField("mode");
		field.setAccessible(true);
		field.set(aspect, mode);
	}

	private static ProceedingJoinPoint fakeJoinPoint(Map<String, Object> body) throws Throwable {
		Method method = FakeController.class.getMethod("updateWidget", UUID.class, Map.class);
		MethodSignature sig = mock(MethodSignature.class);
		when(sig.getMethod()).thenReturn(method);
		ProceedingJoinPoint joinPoint = mock(ProceedingJoinPoint.class);
		when(joinPoint.getSignature()).thenReturn(sig);
		when(joinPoint.getArgs()).thenReturn(new Object[]{UUID.randomUUID(), body});
		when(joinPoint.proceed()).thenReturn("REAL_METHOD_RAN");
		return joinPoint;
	}

	@Test
	void observeModeLogsButAlwaysProceeds_evenWithRealViolations() throws Throwable {
		ObjectMapper mapper = new ObjectMapper();
		RuleSetLoader loader = new RuleSetLoader(mapper);
		RuleEnforcementAspect aspect = new RuleEnforcementAspect(loader, mapper);
		setMode(aspect, "observe");

		Map<String, Object> violating = Map.of("capacity", 999, "ownerName", "x");
		ProceedingJoinPoint joinPoint = fakeJoinPoint(violating);
		EnforceRules ann = FakeController.class.getMethod("updateWidget", UUID.class, Map.class).getAnnotation(EnforceRules.class);

		Object result = aspect.enforce(joinPoint, ann);
		assertEquals("REAL_METHOD_RAN", result, "observe mode must always call the real method, even with real violations");
		verify(joinPoint, times(1)).proceed();
	}

	@Test
	void enforceModeRejectsBeforeTheRealMethodRuns_andNeverLeaksTheObservedValue() throws Throwable {
		ObjectMapper mapper = new ObjectMapper();
		RuleSetLoader loader = new RuleSetLoader(mapper);
		RuleEnforcementAspect aspect = new RuleEnforcementAspect(loader, mapper);
		setMode(aspect, "enforce");

		String secretMarker = "SECRET_MARKER_VALUE_12345";
		Map<String, Object> violating = Map.of("capacity", 999, "ownerName", secretMarker);
		ProceedingJoinPoint joinPoint = fakeJoinPoint(violating);
		EnforceRules ann = FakeController.class.getMethod("updateWidget", UUID.class, Map.class).getAnnotation(EnforceRules.class);

		ResponseStatusException ex = assertThrows(ResponseStatusException.class, () -> aspect.enforce(joinPoint, ann));
		assertEquals(400, ex.getStatusCode().value());
		verify(joinPoint, never()).proceed();
		String message = String.valueOf(ex.getReason());
		assertTrue(message.contains("capacity-cap") || message.contains("owner-min"), "message should name the real rule id(s): " + message);
		assertFalse(message.contains(secretMarker), "an enforce-mode rejection must NEVER leak an observed payload value: " + message);
		assertFalse(message.contains("999"), "an enforce-mode rejection must NEVER leak an observed numeric value either: " + message);
	}

	@Test
	void enforceModeProceedsNormally_whenThePayloadSatisfiesEveryRule() throws Throwable {
		ObjectMapper mapper = new ObjectMapper();
		RuleSetLoader loader = new RuleSetLoader(mapper);
		RuleEnforcementAspect aspect = new RuleEnforcementAspect(loader, mapper);
		setMode(aspect, "enforce");

		Map<String, Object> valid = Map.of("capacity", 100, "ownerName", "widget-owner", "startWindow", "2026-01-01", "endWindow", "2026-01-02");
		ProceedingJoinPoint joinPoint = fakeJoinPoint(valid);
		EnforceRules ann = FakeController.class.getMethod("updateWidget", UUID.class, Map.class).getAnnotation(EnforceRules.class);

		Object result = aspect.enforce(joinPoint, ann);
		assertEquals("REAL_METHOD_RAN", result, "a valid payload must never be rejected, even in enforce mode");
		verify(joinPoint, times(1)).proceed();
	}

	@Test
	void anOperationWithNoRulesProceedsSilently() throws Throwable {
		ObjectMapper mapper = new ObjectMapper();
		RuleSetLoader loader = new RuleSetLoader(mapper);
		RuleEnforcementAspect aspect = new RuleEnforcementAspect(loader, mapper);
		setMode(aspect, "enforce");

		Method method = FakeController.class.getMethod("updateWidget", UUID.class, Map.class);
		MethodSignature sig = mock(MethodSignature.class);
		when(sig.getMethod()).thenReturn(method);
		ProceedingJoinPoint joinPoint = mock(ProceedingJoinPoint.class);
		when(joinPoint.getSignature()).thenReturn(sig);
		when(joinPoint.getArgs()).thenReturn(new Object[]{UUID.randomUUID(), Map.of()});
		when(joinPoint.proceed()).thenReturn("REAL_METHOD_RAN");
		// A made-up operationId with no compiled rules at all.
		EnforceRules noRules = new EnforceRules() {
			public String operationId() { return "noSuchOperation"; }
			public Class<? extends java.lang.annotation.Annotation> annotationType() { return EnforceRules.class; }
		};

		Object result = aspect.enforce(joinPoint, noRules);
		assertEquals("REAL_METHOD_RAN", result);
		verify(joinPoint, times(1)).proceed();
	}

	@Test
	void writesResultsForNodeToVerify() throws Exception {
		Files.writeString(Path.of("rule-aspect-output.json"), "{\\"ranAllAssertions\\":true}");
	}
}
`);

try {
	sh('./gradlew', ['test', '--tests', 'com.example.demo.global.rules.RuleEnforcementAspectSmokeTest', '--console=plain'], scratch, { quiet: true });
} catch (err) {
	fail(`./gradlew test (RuleEnforcementAspectSmokeTest) failed (exit ${err.status}): ${err.stdout || ''}${err.stderr || ''}`);
}
let aspectResult;
try {
	aspectResult = JSON.parse(fs.readFileSync(path.join(scratch, 'rule-aspect-output.json'), 'utf8'));
} catch (err) {
	fail(`could not read rule-aspect-output.json -- RuleEnforcementAspectSmokeTest did not run or did not write it (${err.message})`);
}
if (aspectResult.ranAllAssertions !== true) {
	fail('RuleEnforcementAspectSmokeTest ran but did not report success');
}
console.log('java-compile-smoke: PASS -- @EnforceRules/RuleEnforcementAspect correctly: observe-mode always proceeds, enforce-mode rejects real violations with a fully redacted message and never runs the real method, a valid payload always proceeds even in enforce mode, and an operation with no rules is a silent no-op.');

// D-java-source-splice (T1/T3/T4/T5/T7/T8): real propose/approve/apply/rollback against the same
// real WidgetServiceImpl.java the rest of this script already established through the gated
// workflow, plus a scratch-only decoy overload (never added to the committed
// test/fixtures/java-compile/ corpus -- same throwaway-injection discipline as the Ledger
// resource above) to prove JS2/JS3 pick the RIGHT overload, not merely "a" overload.
console.log('java-compile-smoke: java-source-splice -- decoy overload, benign upstream drift, compile-failure auto-restore, rollback...');
sh('git', ['add', '-A'], scratch, { quiet: true });
sh('git', ['commit', '--quiet', '-m', 'chore: pre-splice checkpoint'], scratch, { quiet: true });

const widgetServiceImplPath = path.join(scratch, 'src/main/java/com/example/demo/domain/widget/application/WidgetServiceImpl.java');
const preSpliceSource = fs.readFileSync(widgetServiceImplPath, 'utf8');
const DECOY_METHOD = `
	// D-java-source-splice (T7): a decoy overload sharing the real method's NAME but not its erased
	// parameter types -- a locator that picked the wrong overload would silently rewrite this stub.
	public Widget updateWidget(String legacyId) {
		throw new UnsupportedOperationException("legacy path, unused: " + legacyId);
	}
`;
fs.writeFileSync(widgetServiceImplPath, preSpliceSource.replace(/\n\}\s*$/, `${DECOY_METHOD}}\n`));
sh('git', ['add', '-A'], scratch, { quiet: true });
sh('git', ['commit', '--quiet', '-m', 'chore: inject scratch-only decoy overload (T7)'], scratch, { quiet: true });
const decoyMethodText = DECOY_METHOD.trim();

// --- Sequence A: propose a real edit, let an UNRELATED part of the same file drift before
// approve (T3), approve, apply (T1), verify the decoy overload was never touched (T7), verify it
// still compiles, then roll back byte-exact (T5).
const spliceDocA = {
	schema: 'sbf.java-source-splice/1',
	file: 'src/main/java/com/example/demo/domain/widget/application/WidgetServiceImpl.java',
	edits: [
		{
			op: 'replace-method-body',
			locator: {
				type_fqn: 'com.example.demo.domain.widget.application.WidgetServiceImpl',
				member_kind: 'method',
				member_name: 'updateWidget',
				erased_param_types: ['java.util.UUID', 'com.example.demo.domain.widget.presentation.dto.UpdateWidgetRequest'],
			},
			replacement: `{
		// JAVA-SPLICE-TEST-MARKER (T1/T3)
		Widget widget = findWidget(widgetId);
		if (request.label() != null) {
			widget.setName(request.label().value());
		}
		return widgetRepository.save(widget);
	}`,
		},
	],
};
const spliceFileA = path.join(scratch, 'splice-a.json');
fs.writeFileSync(spliceFileA, JSON.stringify(spliceDocA, null, 2));

r = bskel(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'java-source-splice', '--splice-file', spliceFileA, '--json'], scratch);
if (r.code !== 0) fail(`patch propose (splice A): ${r.stderr || r.stdout}`);
const txnA = JSON.parse(r.stdout);

// T3: an edit to a DIFFERENT method in the SAME file, between propose and approve -- must not
// invalidate the transaction (region_hash only covers updateWidget's own region).
const beforeApproveSource = fs.readFileSync(widgetServiceImplPath, 'utf8');
fs.writeFileSync(widgetServiceImplPath, beforeApproveSource.replace(
	'public Widget findWidget(UUID widgetId) {',
	'public Widget findWidget(UUID widgetId) {\n\t\t// benign unrelated drift (T3)',
));

r = bskel(['patch', 'approve', '--feature', FEATURE_ID, '--transaction', txnA.transaction_id, '--reason', 'java-compile-smoke T3'], scratch);
if (r.code !== 0) fail(`patch approve (splice A) unexpectedly refused after a benign UNRELATED edit -- region_hash should only cover updateWidget's own region: ${r.stderr || r.stdout}`);
console.log('java-compile-smoke: PASS (T3) -- an unrelated edit elsewhere in the same file did not invalidate the proposed splice.');

// T4: a hand edit INSIDE the target region itself, after approve -- MUST be refused, then undone
// so the real apply below proceeds against the approved content.
const approvedSource = fs.readFileSync(widgetServiceImplPath, 'utf8');
fs.writeFileSync(widgetServiceImplPath, approvedSource.replace(
	'public Widget updateWidget(UUID widgetId, UpdateWidgetRequest request) {',
	'public Widget updateWidget(UUID widgetId, UpdateWidgetRequest request) {\n\t\t// T4 in-region drift, must invalidate the approval',
));
// D-preflight-freshness (S3): the preflight gate carries a 30-minute TTL -- by this point in the
// script, real `gradle wrapper` generation plus several real `./gradlew`/JVM phases have already
// run, so simply re-asserting preflight here (a cheap, local `git rev-parse`-only recompute, no
// mutation) before every `patch apply`/`patch rollback` call is the correct, expected thing to do
// -- exactly what a real user re-running this over a long working session would do too.
r = bskel(['preflight', '--allow-dirty'], scratch);
if (r.code !== 0) fail(`preflight (re-assert before T4 apply attempt): ${r.stderr || r.stdout}`);
r = bskel(['patch', 'apply', '--feature', FEATURE_ID, '--transaction', txnA.transaction_id, '--confirm', 'WidgetServiceImpl#updateWidget'], scratch);
if (r.code === 0) fail('patch apply (splice A) unexpectedly SUCCEEDED after the target region itself was hand-edited post-approve -- staleness detection (T4) is not working');
fs.writeFileSync(widgetServiceImplPath, approvedSource); // undo the T4 probe edit, restore the approved state
console.log('java-compile-smoke: PASS (T4) -- an edit to the target region itself, after approve, was correctly refused at apply time.');

r = bskel(['preflight', '--allow-dirty'], scratch);
if (r.code !== 0) fail(`preflight (re-assert before the real apply): ${r.stderr || r.stdout}`);
r = bskel(['patch', 'apply', '--feature', FEATURE_ID, '--transaction', txnA.transaction_id, '--confirm', 'WidgetServiceImpl#updateWidget', '--json'], scratch);
if (r.code !== 0) fail(`patch apply (splice A): ${r.stderr || r.stdout}`);

const postApplySource = fs.readFileSync(widgetServiceImplPath, 'utf8');
if (!postApplySource.includes('JAVA-SPLICE-TEST-MARKER')) fail('patch apply (splice A) reported success, but the splice marker is not present in the file');
if (!postApplySource.includes(decoyMethodText)) fail('patch apply (splice A) altered the decoy overload updateWidget(String) -- the locator picked the WRONG method (T7 failed)');
console.log('java-compile-smoke: PASS (T1/T7) -- the real edit landed in the correct overload; the decoy overload with the same name is byte-for-byte untouched.');

r = bskel(['verify', '--feature', FEATURE_ID, '--build', '--json'], scratch);
report = JSON.parse(r.stdout);
// Checks report.build.ok specifically, NOT the aggregate report.pass -- a real source splice
// legitimately makes the unrelated `scan` gate go stale (it hashes the very file just edited,
// exactly as it should for any real hand edit), which is correct, expected behavior this feature
// is not responsible for preventing. The only claim this step makes is "the compile itself
// succeeded", which report.build isolates from every other gate's own freshness.
if (report.build?.ok !== true) fail(`bskel verify --build's compile check failed after the java-source-splice apply: ${JSON.stringify(report.build, null, 2)}`);
console.log('java-compile-smoke: PASS -- the project still compiles (real ./gradlew compileJava) after the splice.');

const postSpliceHash = sh('git', ['hash-object', widgetServiceImplPath], scratch, { quiet: true }).trim();
r = bskel(['preflight', '--allow-dirty'], scratch);
if (r.code !== 0) fail(`preflight (re-assert before rollback): ${r.stderr || r.stdout}`);
r = bskel(['patch', 'rollback', '--feature', FEATURE_ID, '--transaction', txnA.transaction_id, '--reason', 'java-compile-smoke T5'], scratch);
if (r.code !== 0) fail(`patch rollback (splice A): ${r.stderr || r.stdout}`);
const postRollbackSource = fs.readFileSync(widgetServiceImplPath, 'utf8');
// The preimage blob was captured at PROPOSE time (line ~818), which is BEFORE the T3 drift edit
// (line ~824-828) -- so rollback correctly restores to `beforeApproveSource` (decoy injected,
// T3 drift NOT yet applied), not to a state that also carries the T3 comment. Rollback also
// correctly reverts the T3 drift itself, since that edit happened to the same file AFTER propose
// -- the same "rollback restores the WHOLE file, including reverting unrelated edits made after
// apply" behavior this kind deliberately inherits from config-apply (see JS7 in DECISIONS.md).
if (postRollbackSource !== beforeApproveSource) {
	fail(`patch rollback (splice A) did not restore the file byte-exactly to its pre-splice (propose-time) content.\n--- expected ---\n${beforeApproveSource}\n--- actual ---\n${postRollbackSource}`);
}
if (postSpliceHash === sh('git', ['hash-object', widgetServiceImplPath], scratch, { quiet: true }).trim()) fail('patch rollback (splice A) did not actually change the file');
console.log('java-compile-smoke: PASS (T5) -- rollback restored the file byte-exactly to its pre-splice content.');

// --- Sequence B: a body that PARSES (passes the propose-time syntax gate) but does not COMPILE
// (an undefined method call) -- proves the apply-time compile postcondition is real, and that a
// compile failure auto-restores the original bytes rather than leaving a broken file in place.
const preBrokenSource = fs.readFileSync(widgetServiceImplPath, 'utf8');
const spliceDocB = {
	schema: 'sbf.java-source-splice/1',
	file: 'src/main/java/com/example/demo/domain/widget/application/WidgetServiceImpl.java',
	edits: [
		{
			op: 'replace-method-body',
			locator: {
				type_fqn: 'com.example.demo.domain.widget.application.WidgetServiceImpl',
				member_kind: 'method',
				member_name: 'findWidget',
				erased_param_types: ['java.util.UUID'],
			},
			replacement: `{
		return thisMethodDoesNotExistAnywhere(widgetId);
	}`,
		},
	],
};
const spliceFileB = path.join(scratch, 'splice-b.json');
fs.writeFileSync(spliceFileB, JSON.stringify(spliceDocB, null, 2));

r = bskel(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'java-source-splice', '--splice-file', spliceFileB, '--json'], scratch);
if (r.code !== 0) fail(`patch propose (splice B, T8): expected the propose-time syntax gate to ACCEPT this (it parses, it just doesn't compile): ${r.stderr || r.stdout}`);
const txnB = JSON.parse(r.stdout);
r = bskel(['patch', 'approve', '--feature', FEATURE_ID, '--transaction', txnB.transaction_id, '--reason', 'java-compile-smoke T8'], scratch);
if (r.code !== 0) fail(`patch approve (splice B, T8): ${r.stderr || r.stdout}`);
r = bskel(['preflight', '--allow-dirty'], scratch);
if (r.code !== 0) fail(`preflight (re-assert before T8 apply): ${r.stderr || r.stdout}`);
r = bskel(['patch', 'apply', '--feature', FEATURE_ID, '--transaction', txnB.transaction_id, '--confirm', 'WidgetServiceImpl#findWidget'], scratch);
if (r.code === 0) fail('patch apply (splice B, T8) unexpectedly SUCCEEDED against a body that calls an undefined method -- the compile postcondition is not being enforced');
const postFailedApplySource = fs.readFileSync(widgetServiceImplPath, 'utf8');
if (postFailedApplySource !== preBrokenSource) {
	fail('patch apply (splice B, T8) failed to compile but did NOT restore the original file content -- auto-restore-on-failure is broken');
}
console.log('java-compile-smoke: PASS (T8) -- a body that parses but does not compile was correctly rejected, and the original file was auto-restored byte-exactly.');

r = bskel(['verify', '--feature', FEATURE_ID, '--build', '--json'], scratch);
report = JSON.parse(r.stdout);
if (report.build?.ok !== true) fail(`bskel verify --build's compile check failed after the T8 auto-restore -- the restored file should still compile: ${JSON.stringify(report.build, null, 2)}`);
console.log('java-compile-smoke: PASS -- the project still compiles after the T8 auto-restore.');

console.log('java-compile-smoke: PASS -- java-source-splice: decoy-overload correctness, benign-drift tolerance, in-region staleness detection, compile-failure auto-restore, and byte-exact rollback all verified against a real JVM.');

fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(bareOrigin, { recursive: true, force: true });
