// P3 (D-fixture-corpus): planHandles() against REAL on-disk Java for the first time -- every
// existing test in test/handles-plan.test.mjs passes `file: null` in its hand-built scanReport,
// so findRequiredAuthority()'s @PreAuthorize search (which reads controller.file from disk) and
// countServiceMethodParams()'s service-file arity check have never been exercised against real
// files anywhere in this suite before this. Same fixture as test/scan-fixture.test.mjs/
// test/contract-fixture.test.mjs (test/fixtures/java-spring/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planHandles } from '../handles/providers/java-spring/plan.mjs';
import { runScan } from '../scanners/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'java-spring');
const JAVA_SRC_ROOT = path.join(FIXTURE_ROOT, 'src', 'main', 'java', 'com', 'example', 'app');

function planModule(terms, moduleName) {
	const scanReport = runScan({ repoRoot: FIXTURE_ROOT, terms });
	return planHandles({ javaSrcRoot: JAVA_SRC_ROOT, scanReport, module: moduleName });
}

test('organization: resolver generated, requiredAuthority defaults to TODO_ROLE (no @PreAuthorize anywhere on this controller)', () => {
	const plan = planModule(['organization'], 'organization');
	const org = plan.resources.find((r) => r.type === 'Organization');
	assert.ok(org.fetchOperation, 'expected a fetch operation to be found (name-affinity: OrganizationController contains "Organization", OperatorController does not)');
	assert.equal(org.fetchOperation.controllerClassName, 'OrganizationController');
	assert.equal(org.requiredAuthority, 'TODO_ROLE');
	assert.equal(org.willGenerateResolver, true, 'OrganizationService.findOrganization(UUID) is a 1-arg match');
});

// D-security-8 regression, against a real on-disk service file for the first time.
test('curriculum: resolver NOT generated -- CurriculumService.findCurriculum takes 2 arguments, not the single resource UUID a resolver always passes', () => {
	const plan = planModule(['curriculum'], 'curriculum');
	const cur = plan.resources.find((r) => r.type === 'Curriculum');
	assert.ok(cur.fetchOperation);
	assert.equal(cur.willGenerateResolver, false);
	assert.ok(plan.notes.some((n) => n.includes('takes 2 argument(s)')));
});

// D-security-7 regression, against real on-disk controller files for the first time: the class-
// level / method-level / unsupported-shape @PreAuthorize branches, all three in one module.
test('security: all three @PreAuthorize branches resolve correctly against real files', () => {
	const plan = planModule(['security'], 'security');
	const byType = Object.fromEntries(plan.resources.map((r) => [r.type, r]));

	// Class-level fallback: no method-level @PreAuthorize anywhere in AlphaController, so the
	// search falls back to the class-level annotation. hasRole('X') bakes in Spring Security's own
	// implicit ROLE_ prefix at plan time (O5 hasAuthority follow-up) -- 'ALPHA_ADMIN' in source
	// becomes the granted-authority string 'ROLE_ALPHA_ADMIN'.
	assert.equal(byType.Alpha.requiredAuthority, 'ROLE_ALPHA_ADMIN');
	assert.equal(byType.Alpha.willGenerateResolver, true);

	// Method-level, and specifically NOT the first method's role -- BetaController.findBetas has
	// "BETA_VIEWER", findBeta (the actual fetch operation) has its own "BETA_ADMIN". Getting this
	// wrong (falling back to the file's first @PreAuthorize match) was the exact bug the Codex
	// security review found and D-security-7 fixed.
	assert.equal(byType.Beta.requiredAuthority, 'ROLE_BETA_ADMIN');
	assert.equal(byType.Beta.willGenerateResolver, true);

	// Unsupported shape (hasAnyRole, not hasRole) -- fails closed to TODO_ROLE, resolver is still
	// structurally generated (the arity/fetch-op preconditions are otherwise satisfied), but the
	// note explicitly flags the unsupported annotation shape rather than silently treating it as
	// "no authority found".
	assert.equal(byType.Gamma.requiredAuthority, 'TODO_ROLE');
	assert.equal(byType.Gamma.willGenerateResolver, true);
	assert.ok(plan.notes.some((n) => n.includes('Gamma') && n.includes('not in the simple hasRole')));

	// The third arity case (alongside Beta's 1-arg-success and Curriculum's 2-arg-mismatch,
	// tested separately above): no matching *Service.java file on disk AT ALL. A real fetch
	// operation exists (DeltaController.findDelta), but findServiceFile() finds no
	// DeltaService.java -- no resolver, with an explicit note naming the gap, never a guess or a
	// thrown exception.
	assert.ok(byType.Delta.fetchOperation, 'DeltaController.findDelta should still be found');
	assert.equal(byType.Delta.service, null);
	assert.equal(byType.Delta.willGenerateResolver, false);
	assert.ok(plan.notes.some((n) => n.includes('Delta') && n.includes('no DeltaService found')));

	// O5 (D-resolver-authorization-action-aware, hasAuthority follow-up): method-level
	// @PreAuthorize(hasAuthority('X')) -- the real proof point of this item. Unlike hasRole, Spring
	// Security checks hasAuthority('X') against the granted authority 'X' VERBATIM, no implicit
	// ROLE_ prefix -- so requiredAuthority must come back unprefixed here, unlike Alpha/Beta above.
	assert.equal(byType.Epsilon.requiredAuthority, 'EPSILON_ADMIN');
	assert.equal(byType.Epsilon.willGenerateResolver, true);
});

test('a module with no matching entities for the given --resource filter plans nothing, with an explicit note', () => {
	const scanReport = runScan({ repoRoot: FIXTURE_ROOT, terms: ['security'] });
	const plan = planHandles({ javaSrcRoot: JAVA_SRC_ROOT, scanReport, module: 'security', resourceFilter: ['NoSuchEntity'] });
	assert.equal(plan.resources.length, 0);
	assert.ok(plan.notes.some((n) => n.includes('nothing to plan')));
});

// D-write-safety-phase1 (item 4a/4b): standalone temp fixtures, not the shared one above, so they
// don't risk affecting any other test that enumerates the shared fixture's own real modules/entities.
function buildTempJavaFixture(entityJava, controllerJava, moduleName, entityClassName) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-plan-item4-'));
	fs.writeFileSync(path.join(root, 'build.gradle'), "plugins { id 'org.springframework.boot' version '3.3.0' }\n");
	const domainDir = path.join(root, 'src/main/java/com/example/app/domain', moduleName, 'domain');
	const presentationDir = path.join(root, 'src/main/java/com/example/app/domain', moduleName, 'presentation');
	fs.mkdirSync(domainDir, { recursive: true });
	fs.mkdirSync(presentationDir, { recursive: true });
	fs.writeFileSync(path.join(domainDir, `${entityClassName}.java`), entityJava);
	fs.writeFileSync(path.join(presentationDir, `${entityClassName}Controller.java`), controllerJava);
	return root;
}

test('D-write-safety-phase1 (item 4a): a non-UUID primary key blocks resolver generation with a specific note, before even looking for a service file', () => {
	const root = buildTempJavaFixture(
		`package com.example.app.domain.owner.domain;
import jakarta.persistence.*;
@Entity
public class Owner {
	@Id
	private Integer id;
}
`,
		`package com.example.app.domain.owner.presentation;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/owners")
public class OwnerController {
	@GetMapping("/{ownerId}")
	public Object findOwner(@PathVariable Integer ownerId) { return null; }
}
`,
		'owner', 'Owner',
	);
	const javaSrcRoot = path.join(root, 'src/main/java/com/example/app');
	const scanReport = runScan({ repoRoot: root, terms: ['owner'] });
	const plan = planHandles({ javaSrcRoot, scanReport, module: 'owner' });
	const owner = plan.resources.find((r) => r.type === 'Owner');
	assert.equal(owner.idFieldType, 'Integer');
	assert.equal(owner.idFieldIsUuid, false);
	assert.equal(owner.service, null, 'no service lookup should even happen once the PK is confirmed non-UUID');
	assert.equal(owner.willGenerateResolver, false);
	assert.ok(plan.notes.some((n) => n.includes('Owner') && n.includes('primary key is declared `Integer`, not UUID')));
	assert.ok(!plan.notes.some((n) => n.includes('no OwnerService found')), 'the generic "no service found" note must not ALSO fire -- the PK-type note already explains the real reason');
});

test('D-write-safety-phase1 (item 4b): a Service class at the flat <module>/<Entity>Service.java path (no domain/application segments) is now found', () => {
	const root = buildTempJavaFixture(
		`package com.example.app.domain.owner.domain;
import jakarta.persistence.*;
@Entity
public class Owner {
	@Id
	private java.util.UUID id;
}
`,
		`package com.example.app.domain.owner.presentation;
import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.Operation;
@RestController
@RequestMapping("/owners")
public class OwnerController {
	@Operation(operationId = "findOwner")
	@GetMapping("/{ownerId}")
	public Object findOwner(@PathVariable java.util.UUID ownerId) { return this.ownerService.findOwner(ownerId); }
}
`,
		'owner', 'Owner',
	);
	// The flat shape this item's own fallback targets: <basePackage>/<module>/<Entity>Service.java,
	// no domain/application segments -- written directly, since buildTempJavaFixture() only builds
	// the conventional domain/<module>/{domain,presentation}/ layout above.
	const flatDir = path.join(root, 'src/main/java/com/example/app/owner');
	fs.mkdirSync(flatDir, { recursive: true });
	fs.writeFileSync(path.join(flatDir, 'OwnerService.java'), `package com.example.app.owner;
public interface OwnerService {
	Object findOwner(java.util.UUID ownerId);
}
`);
	const javaSrcRoot = path.join(root, 'src/main/java/com/example/app');
	const scanReport = runScan({ repoRoot: root, terms: ['owner'] });
	const plan = planHandles({ javaSrcRoot, scanReport, module: 'owner' });
	const owner = plan.resources.find((r) => r.type === 'Owner');
	assert.ok(owner.service, 'the flat-path fallback should have found OwnerService.java');
	assert.equal(owner.service.file, path.join(flatDir, 'OwnerService.java'));
	assert.equal(owner.willGenerateResolver, true);
});
