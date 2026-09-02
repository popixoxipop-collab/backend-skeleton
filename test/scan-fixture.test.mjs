// P3 (D-fixture-corpus): a frozen, committed, portable replacement for the 3 tests that used to
// live only in test/scan.test.mjs gated behind `~/Desktop/Team-IZ-Backend` being present on this
// machine. Runs in CI (test/fixtures/java-spring/ needs no git, no build -- runScan() only needs
// build.gradle + src/main/java, scanned in place). Also covers a defect class the real oracle
// repo never happened to exercise (see AnnotationStyleController's file comment): P3 pinned the
// then-current regex-scanner's known-limitation baseline against CATALOG.md's A2 ("a staged Java
// analyzer") -- A2 Phase 1 (D-java-analyzer) is that future work, now landed; the "FIXED (A2 Phase
// 1)" tests below are the same fixture files, same assertions inverted, proving the fix against
// the exact corpus that documented the original bugs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan } from '../scanners/index.mjs';
import { scanJavaSpring } from '../scanners/adapters/java-spring.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'java-spring');

// S2 (D-gate-precision, continued): the field lib/gate-definitions.mjs's `scan` gate hashes for
// a precise staleness token -- must be present, sorted (matches listJavaFiles()'s own O6
// determinism guarantee), repo-relative, and cover every real .java file in the fixture, not a
// filtered/matched-only subset (a file that matched zero terms is still part of the read-set).
test('scanJavaSpring reports its own real read-set: sorted, repo-relative, every fixture .java file present', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	assert.ok(Array.isArray(result.filesRead) && result.filesRead.length > 0);
	assert.deepEqual(result.filesRead, [...result.filesRead].sort(), 'must already be sorted');
	assert.ok(result.filesRead.every((f) => !path.isAbsolute(f)), 'must be repo-relative, not absolute');
	assert.ok(result.filesRead.some((f) => f.endsWith('OrganizationController.java')));
	assert.ok(result.filesRead.some((f) => f.endsWith('AnnotationStyleController.java')), 'covers a file outside the organization module too -- not filtered to any one term/module');
});

test('scanning the fixture for "organization" finds OrganizationController (10 ops) + OperatorController (5 ops)', () => {
	const report = runScan({ repoRoot: FIXTURE_ROOT, terms: ['organization'] });

	assert.equal(report.adapter, 'java-spring');
	assert.equal(report.verdict, 'collision');

	const orgModule = report.related_modules.find((m) => m.module === 'organization');
	assert.ok(orgModule, 'expected an "organization" related module');

	const controller = orgModule.controllers.find((c) => c.className === 'OrganizationController');
	assert.ok(controller, 'expected OrganizationController to be found');

	const expectedOperationIds = [
		'findOrganizations', 'findPlatformSummary', 'checkNameAvailability', 'createOrganization',
		'findOrganization', 'findOrganizationCohorts', 'updateOrganization', 'deleteOrganization',
		'restoreOrganization', 'purgeOrganization',
	];
	assert.deepEqual(controller.operationIds, expectedOperationIds);
	assert.equal(controller.endpoints.length, 10);
	assert.ok(controller.endpoints.every((ep) => ep.operationId), 'every endpoint should have a correlated operationId');
	assert.equal(controller.basePath, '/organizations');

	// The second controller in the same module -- basePath is a SUPERSET of OrganizationController's
	// ("/organizations/{organizationId}/operators" starts with "/organizations"), but its className
	// does not contain "Organization" -- the exact multi-controller shape that motivated
	// handles/providers/java-spring/plan.mjs's findFetchOperation() name-affinity fix.
	const operatorController = orgModule.controllers.find((c) => c.className === 'OperatorController');
	assert.ok(operatorController, 'expected OperatorController to be found');
	assert.equal(operatorController.endpoints.length, 5);
	assert.ok(operatorController.endpoints.every((ep) => ep.operationId));

	const statusEnum = orgModule.enums.find((e) => e.name === 'OrganizationStatus');
	assert.ok(statusEnum, 'expected OrganizationStatus enum to be found');
	assert.deepEqual(statusEnum.constants, ['ACTIVE', 'SUSPENDED', 'DELETION_PENDING', 'DELETED']);
});

// D-gate-precision (Continued, part 3): dtos are now {className, file} objects (previously bare
// filename strings with no `.file`, which is why lib/gate-definitions.mjs's contract.recompute()
// used to exclude them from its tracked file set entirely).
test('dtos are {className, file} objects, not bare strings -- OrganizationDto is found under the organization module', () => {
	const report = runScan({ repoRoot: FIXTURE_ROOT, terms: ['organization'] });
	const orgModule = report.related_modules.find((m) => m.module === 'organization');
	assert.ok(orgModule, 'expected an "organization" related module');

	const dto = orgModule.dtos.find((d) => d.className === 'OrganizationDto');
	assert.ok(dto, 'expected OrganizationDto to be found');
	assert.equal(typeof dto.file, 'string', 'dto must carry a .file path (unlike the old bare-string shape)');
	assert.ok(dto.file.endsWith(path.join('presentation', 'dto', 'OrganizationDto.java')));
});

// D-module-attribution-base-package: found live against a real corpus check (spring-projects/
// spring-petclinic), not anticipated -- moduleOf() used to key purely on a literal "domain" path
// segment (Team-IZ-Backend's OWN convention), so a real Spring Boot app that puts feature modules
// directly under its base package (petclinic's own `org.springframework.samples.petclinic.owner`/
// `...vet`/`...system`, no "domain" segment anywhere) collapsed every entity into "_unknown".
function petclinicStyleFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-spring-base-package-'));
	fs.writeFileSync(path.join(root, 'build.gradle'), "plugins { id 'org.springframework.boot' version '3.3.0' }\n");
	const base = path.join(root, 'src/main/java/org/example/petlike');
	fs.mkdirSync(base, { recursive: true });
	fs.writeFileSync(path.join(base, 'PetLikeApplication.java'), `
package org.example.petlike;

import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class PetLikeApplication {}
`);
	fs.mkdirSync(path.join(base, 'owner'), { recursive: true });
	fs.writeFileSync(path.join(base, 'owner', 'Owner.java'), `
package org.example.petlike.owner;

import jakarta.persistence.Entity;

@Entity
public class Owner {}
`);
	fs.mkdirSync(path.join(base, 'vet'), { recursive: true });
	fs.writeFileSync(path.join(base, 'vet', 'Vet.java'), `
package org.example.petlike.vet;

import jakarta.persistence.Entity;

@Entity
public class Vet {}
`);
	return root;
}

test('moduleOf() base-package fallback: entities under <basePackage>/<module>/... (no "domain" segment) are still correctly attributed, not collapsed into _unknown', () => {
	const result = scanJavaSpring(petclinicStyleFixture());
	const ownerModule = result.modules.find((m) => m.module === 'owner');
	const vetModule = result.modules.find((m) => m.module === 'vet');
	assert.ok(ownerModule, 'expected a real "owner" module, not everything landing in _unknown');
	assert.ok(ownerModule.entities.some((e) => e.className === 'Owner'));
	assert.ok(vetModule, 'expected a real "vet" module');
	assert.ok(vetModule.entities.some((e) => e.className === 'Vet'));
	assert.ok(!result.modules.some((m) => m.module === '_unknown'), 'nothing should fall back to _unknown once the base package is known');
});

test('moduleOf() base-package fallback: a file living directly in the base package (the @SpringBootApplication class itself) is never attributed a spurious module', () => {
	const root = petclinicStyleFixture();
	// PetLikeApplication.java has no @Entity/@RestController, so it never reaches moduleEntry() at
	// all -- confirm this indirectly: only "owner"/"vet" modules exist, nothing named after the
	// application class or an empty string.
	const result = scanJavaSpring(root);
	assert.deepEqual(result.modules.map((m) => m.module).sort(), ['owner', 'vet']);
});

test('moduleOf() base-package fallback: a repo with no @SpringBootApplication class anywhere falls back to the pre-existing _unknown behavior, unchanged', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-spring-no-app-class-'));
	fs.writeFileSync(path.join(root, 'build.gradle'), "plugins { id 'org.springframework.boot' version '3.3.0' }\n");
	const dir = path.join(root, 'src/main/java/org/example/nomain/owner');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'Owner.java'), `
package org.example.nomain.owner;

import jakarta.persistence.Entity;

@Entity
public class Owner {}
`);
	const result = scanJavaSpring(root);
	const unknownModule = result.modules.find((m) => m.module === '_unknown');
	assert.ok(unknownModule, 'no @SpringBootApplication class anywhere -- findBasePackage() must return null, preserving the old _unknown fallback');
	assert.ok(unknownModule.entities.some((e) => e.className === 'Owner'));
});

// D-entity-id-field-inheritance: found live against a real corpus check (spring-projects/
// spring-petclinic) -- `Owner extends Person extends BaseEntity`, `@Id` lives on `BaseEntity` (a
// `@MappedSuperclass`), the standard JPA pattern for sharing an id/audit-field base across
// entities. A single-file-only `@Id` search never saw it. Mirrors the real 2-level inheritance
// depth petclinic actually uses -- a 1-level fixture would not have caught the recursion needing
// to walk more than one hop.
function inheritedIdFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-spring-inherited-id-'));
	fs.writeFileSync(path.join(root, 'build.gradle'), "plugins { id 'org.springframework.boot' version '3.3.0' }\n");
	const base = path.join(root, 'src/main/java/org/example/petlike');
	fs.mkdirSync(base, { recursive: true });
	fs.writeFileSync(path.join(base, 'PetLikeApplication.java'), `
package org.example.petlike;

import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class PetLikeApplication {}
`);
	fs.mkdirSync(path.join(base, 'model'), { recursive: true });
	fs.writeFileSync(path.join(base, 'model', 'BaseEntity.java'), `
package org.example.petlike.model;

import jakarta.persistence.Id;
import jakarta.persistence.MappedSuperclass;

@MappedSuperclass
public class BaseEntity {
	@Id
	private Integer id;
}
`);
	fs.writeFileSync(path.join(base, 'model', 'Person.java'), `
package org.example.petlike.model;

import jakarta.persistence.MappedSuperclass;

@MappedSuperclass
public class Person extends BaseEntity {
	private String lastName;
}
`);
	fs.mkdirSync(path.join(base, 'owner'), { recursive: true });
	fs.writeFileSync(path.join(base, 'owner', 'Owner.java'), `
package org.example.petlike.owner;

import jakarta.persistence.Entity;
import org.example.petlike.model.Person;

@Entity
public class Owner extends Person {
	private String address;
}
`);
	return root;
}

test('extractEntity(): idField resolves through a 2-level @MappedSuperclass chain across files (Owner extends Person extends BaseEntity, @Id on BaseEntity)', () => {
	const result = scanJavaSpring(inheritedIdFixture());
	const ownerModule = result.modules.find((m) => m.module === 'owner');
	const owner = ownerModule.entities.find((e) => e.className === 'Owner');
	assert.equal(owner.idField, 'id');
});

test('extractEntity(): idField declared directly on the entity itself (the common, already-working case) is unaffected', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-spring-direct-id-'));
	fs.writeFileSync(path.join(root, 'build.gradle'), "plugins { id 'org.springframework.boot' version '3.3.0' }\n");
	const dir = path.join(root, 'src/main/java/org/example/app/widget');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'Widget.java'), `
package org.example.app.widget;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class Widget {
	@Id
	private java.util.UUID id;
}
`);
	const result = scanJavaSpring(root);
	const widget = result.modules[0].entities.find((e) => e.className === 'Widget');
	assert.equal(widget.idField, 'id');
});

test('extractEntity(): a class extending something outside this source tree (an external library base class) resolves idField to null, not a crash', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-spring-external-base-'));
	fs.writeFileSync(path.join(root, 'build.gradle'), "plugins { id 'org.springframework.boot' version '3.3.0' }\n");
	const dir = path.join(root, 'src/main/java/org/example/app/widget');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'Widget.java'), `
package org.example.app.widget;

import jakarta.persistence.Entity;
import some.external.library.PanacheEntityBase;

@Entity
public class Widget extends PanacheEntityBase {
	private String name;
}
`);
	const result = scanJavaSpring(root);
	const widget = result.modules[0].entities.find((e) => e.className === 'Widget');
	assert.equal(widget.idField, null, 'PanacheEntityBase is not part of this source tree -- must fail closed, never guess');
});

test('the fixture\'s own global-path-prefix signals: configurePathMatch + springdoc.paths-to-match, no context-path', () => {
	const report = runScan({ repoRoot: FIXTURE_ROOT, terms: ['organization'] });
	const byKind = Object.fromEntries(report.path_prefix_signals.map((s) => [s.kind, s]));

	assert.ok(byKind.configurePathMatch, 'expected a configurePathMatch signal');
	assert.equal(byKind.configurePathMatch.prefix, '/api/v0');
	assert.match(byKind.configurePathMatch.file, /ApiPathConfig\.java$/);

	assert.ok(byKind['paths-to-match'], 'expected a springdoc.paths-to-match signal');
	assert.equal(byKind['paths-to-match'].pattern, '/api/v0/**');

	assert.equal(byKind['context-path'], undefined, 'this fixture does not set server.servlet.context-path');

	assert.ok(
		report.unknowns.some((u) => u.includes('global path prefix') && u.includes('/api/v0')),
		'expected a human-readable warning in unknowns naming the detected prefix',
	);
});

test('individual endpoint verb+path+operationId correlation is correct, including the DELETE-with-body and nested-resource shapes', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const orgModule = result.modules.find((m) => m.module === 'organization');
	const controller = orgModule.controllers.find((c) => c.className === 'OrganizationController');

	const byOpId = Object.fromEntries(controller.endpoints.map((e) => [e.operationId, e]));
	assert.equal(byOpId.createOrganization.verb, 'POST');
	assert.equal(byOpId.createOrganization.path, '/organizations');
	assert.equal(byOpId.findOrganization.verb, 'GET');
	assert.equal(byOpId.findOrganization.path, '/organizations/{organizationId}');
	assert.equal(byOpId.restoreOrganization.verb, 'POST');
	assert.equal(byOpId.restoreOrganization.path, '/organizations/{organizationId}/restore');
	assert.equal(byOpId.deleteOrganization.verb, 'DELETE');
	assert.equal(byOpId.checkNameAvailability.path, '/organizations/name-availability');

	const operatorController = orgModule.controllers.find((c) => c.className === 'OperatorController');
	const byOperatorOpId = Object.fromEntries(operatorController.endpoints.map((e) => [e.operationId, e]));
	assert.equal(byOperatorOpId.findOperator.path, '/organizations/{organizationId}/operators/{operatorId}');
});

// ===== FIXED (A2 Phase 1, D-java-analyzer): every case below used to be a documented, pinned
// scanner limitation -- the masking/balanced-delimiter analyzer in scanners/adapters/
// _java-spring-analyzer.mjs fixes all of them. Kept in this file, not deleted, since the
// fixture files themselves are still the exact regression corpus this item's own before/after
// baseline was built from. =====

test('FIXED (A2 Phase 1): a comment mentioning operationId = "..." as prose no longer pollutes controller.operationIds', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const mod = result.modules.find((m) => m.module === 'annotationstyles');
	const controller = mod.controllers.find((c) => c.className === 'AnnotationStyleController');

	assert.ok(!controller.operationIds.includes('notARealOperationId'), 'masking blanks a comment\'s content entirely -- the phantom string can no longer appear here');
	assert.deepEqual(controller.operationIds, ['normalEndpoint']);
	assert.equal(controller.endpoints.length, 1);
	assert.equal(controller.endpoints[0].operationId, 'normalEndpoint');
});

test('FIXED (A2 Phase 1): an annotation between the mapping annotation and "public" no longer hides the endpoint', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const mod = result.modules.find((m) => m.module === 'annotationstyles');
	const controller = mod.controllers.find((c) => c.className === 'InterveningAnnotationController');
	assert.equal(controller.endpoints.length, 1);
	assert.equal(controller.endpoints[0].operationId, 'interveningAnnotation');
	assert.equal(controller.endpoints[0].verb, 'GET');
});

test('FIXED (A2 Phase 1): a comment between the mapping annotation and "public" no longer hides the endpoint', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const mod = result.modules.find((m) => m.module === 'annotationstyles');
	const controller = mod.controllers.find((c) => c.className === 'CommentBeforeMethodController');
	assert.equal(controller.endpoints.length, 1);
	assert.equal(controller.endpoints[0].operationId, 'commentBeforeMethod');
});

test('FIXED (A2 Phase 1): a space inside a generic return type (Map<String, Object>) no longer hides the endpoint', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const mod = result.modules.find((m) => m.module === 'annotationstyles');
	const controller = mod.controllers.find((c) => c.className === 'GenericWithSpaceController');
	assert.equal(controller.endpoints.length, 1);
	assert.equal(controller.endpoints[0].operationId, 'genericWithSpace');
});

test('FIXED (A2 Phase 1): the mapping annotation and "public" on the same line no longer hides the endpoint', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const mod = result.modules.find((m) => m.module === 'annotationstyles');
	const controller = mod.controllers.find((c) => c.className === 'SameLineMappingController');
	assert.equal(controller.endpoints.length, 1);
	assert.equal(controller.endpoints[0].operationId, 'sameLineMapping');
});

test('FIXED (A2 Phase 1): @RequestMapping(method = RequestMethod.GET) is now supported (single-verb form)', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const mod = result.modules.find((m) => m.module === 'annotationstyles');
	const controller = mod.controllers.find((c) => c.className === 'RequestMappingStyleController');
	assert.equal(controller.endpoints.length, 1);
	assert.equal(controller.endpoints[0].verb, 'GET');
	assert.equal(controller.endpoints[0].operationId, 'requestMappingStyle');
});

// ===== NEW in A2 Phase 1: previously unsupported anywhere, genuinely undiscussed before this
// item (confirmed by searching the fixture corpus and DECISIONS.md). =====

test('NEW (A2 Phase 1): a method with no access modifier at all (package-private) is now detected', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const mod = result.modules.find((m) => m.module === 'annotationstyles');
	const controller = mod.controllers.find((c) => c.className === 'PackagePrivateMethodController');
	assert.ok(controller, 'expected PackagePrivateMethodController to be found');
	assert.equal(controller.endpoints.length, 1);
	assert.equal(controller.endpoints[0].operationId, 'packagePrivateMethod');
});

test('NEW (A2 Phase 1): a `record`-declared controller (not `class`) is now detected', () => {
	const result = scanJavaSpring(FIXTURE_ROOT);
	const mod = result.modules.find((m) => m.module === 'annotationstyles');
	const controller = mod.controllers.find((c) => c.className === 'RecordController');
	assert.ok(controller, 'expected RecordController to be found even though it is a record, not a class');
	assert.equal(controller.basePath, '/record-style');
	assert.equal(controller.endpoints.length, 1);
	assert.equal(controller.endpoints[0].operationId, 'recordStyle');
});
