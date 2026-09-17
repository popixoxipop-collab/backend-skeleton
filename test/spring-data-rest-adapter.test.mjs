// D-spring-data-rest-adapter: real scanJavaSpring()/runScan() coverage for
// @RepositoryRestResource -- happy path and every refusal-ladder case, each against a standalone
// temp fixture (mirrors test/handles-plan-fixture.test.mjs's own buildTempJavaFixture() pattern)
// so nothing here risks affecting the shared test/fixtures/java-spring/ corpus's own pinned
// exact-count assertions. Also covers contracts/emit.mjs's `expansion` field and
// handles/providers/java-spring/plan.mjs's declaration-aware note firing from REAL scanner
// output, not the hand-built forward-compatible fixtures test/contract.test.mjs:929/
// test/handles-plan.test.mjs:598 already pin on the consumer side alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { runScan } from '../scanners/index.mjs';
import { scanJavaSpring } from '../scanners/adapters/java-spring.mjs';
import { buildContract } from '../contracts/emit.mjs';
import { planHandles } from '../handles/providers/java-spring/plan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WIDGET_ENTITY = `package com.example.app.domain.widget.domain;
import jakarta.persistence.*;
import java.util.UUID;

@Entity
@Table(name = "widgets")
public class Widget {
	@Id
	private UUID id;
	private String name;
}
`;

function repositoryJava(annotationArgs, extendsClause, body = '') {
	return `package com.example.app.domain.widget.infrastructure;
import com.example.app.domain.widget.domain.Widget;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.rest.core.annotation.RepositoryRestResource;
import org.springframework.data.rest.core.annotation.RestResource;
import java.util.UUID;

@RepositoryRestResource${annotationArgs}
public interface WidgetRepository ${extendsClause} {
${body}}
`;
}

// D-write-safety-phase1 (item 4a/4b)'s own reasoning, reused here: standalone temp fixtures, not
// the shared one, so nothing here risks affecting any other test that enumerates the shared
// fixture's own real modules/entities/counts.
function buildTempFixture({ hasDependency = true, repositoryContent } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-spring-data-rest-'));
	const deps = ['implementation \'org.springframework.boot:spring-boot-starter-web\'', 'implementation \'org.springframework.boot:spring-boot-starter-data-jpa\''];
	if (hasDependency) deps.push('implementation \'org.springframework.boot:spring-boot-starter-data-rest\'');
	fs.writeFileSync(path.join(root, 'build.gradle'), `plugins { id 'org.springframework.boot' version '3.3.0' }\ndependencies {\n\t${deps.join('\n\t')}\n}\n`);
	const domainDir = path.join(root, 'src/main/java/com/example/app/domain/widget/domain');
	const infraDir = path.join(root, 'src/main/java/com/example/app/domain/widget/infrastructure');
	fs.mkdirSync(domainDir, { recursive: true });
	fs.mkdirSync(infraDir, { recursive: true });
	fs.writeFileSync(path.join(domainDir, 'Widget.java'), WIDGET_ENTITY);
	fs.writeFileSync(path.join(infraDir, 'WidgetRepository.java'), repositoryContent);
	return root;
}

test('happy path: synthesizes the 6 CRUD routes with declarations[]/declarationIndex, correct operationIds', () => {
	const root = buildTempFixture({
		repositoryContent: repositoryJava('(path = "widgets")', 'extends JpaRepository<Widget, UUID>'),
	});
	const result = scanJavaSpring(root);
	const mod = result.modules.find((m) => m.module === 'widget');
	const controller = mod.controllers.find((c) => c.className === 'WidgetRepository');
	assert.ok(controller, 'expected a synthesized WidgetRepository controller');
	assert.equal(controller.basePath, '/widgets');
	assert.equal(controller.declarations.length, 1);
	assert.equal(controller.declarations[0].rule, 'java-spring:repository-rest-resource-crud');
	assert.equal(controller.declarations[0].label, '@RepositoryRestResource(path="widgets") on WidgetRepository');
	assert.equal(controller.endpoints.length, 6);
	assert.ok(controller.endpoints.every((ep) => ep.declarationIndex === 0));
	assert.ok(controller.endpoints.every((ep) => ep.method === null));
	const byOpId = Object.fromEntries(controller.endpoints.map((ep) => [ep.operationId, ep]));
	assert.deepEqual(byOpId.getWidgetCollectionResource, { verb: 'GET', path: '/widgets', operationId: 'getWidgetCollectionResource', method: null, line: byOpId.getWidgetCollectionResource.line, declarationIndex: 0 });
	assert.equal(byOpId.postWidgetCollectionResource.verb, 'POST');
	assert.equal(byOpId.postWidgetCollectionResource.path, '/widgets');
	assert.equal(byOpId.getWidgetItemResource.path, '/widgets/{id}');
	assert.equal(byOpId.putWidgetItemResource.verb, 'PUT');
	assert.equal(byOpId.patchWidgetItemResource.verb, 'PATCH');
	assert.equal(byOpId.deleteWidgetItemResource.verb, 'DELETE');
	assert.equal(result.repositoryResourceNotes.length, 0);
});

test('happy path via runScan(): the note-free case, and repositoryResourceNotes threads through to unknowns[]', () => {
	const root = buildTempFixture({
		repositoryContent: repositoryJava('(path = "widgets")', 'extends JpaRepository<Widget, UUID>'),
	});
	const report = runScan({ repoRoot: root, terms: ['widget'] });
	assert.equal(report.adapter, 'java-spring');
	const mod = report.related_modules.find((m) => m.module === 'widget');
	assert.equal(mod.controllers.find((c) => c.className === 'WidgetRepository').endpoints.length, 6);
	assert.equal(report.unknowns.filter((n) => n.includes('WidgetRepository')).length, 0);
});

test('refusal: missing spring-boot-starter-data-rest dependency -- no controller, a named diagnostic', () => {
	const root = buildTempFixture({
		hasDependency: false,
		repositoryContent: repositoryJava('(path = "widgets")', 'extends JpaRepository<Widget, UUID>'),
	});
	const result = scanJavaSpring(root);
	const mod = result.modules.find((m) => m.module === 'widget');
	assert.ok(!mod.controllers.some((c) => c.className === 'WidgetRepository'));
	assert.equal(result.repositoryResourceNotes.length, 1);
	assert.match(result.repositoryResourceNotes[0], /no spring-boot-starter-data-rest dependency was found/);
	assert.match(result.repositoryResourceNotes[0], /WidgetRepository/);
});

test('refusal: no explicit path="..." attribute -- no controller, never guesses the pluralized default', () => {
	const root = buildTempFixture({
		repositoryContent: repositoryJava('', 'extends JpaRepository<Widget, UUID>'),
	});
	const result = scanJavaSpring(root);
	const mod = result.modules.find((m) => m.module === 'widget');
	assert.ok(!mod.controllers.some((c) => c.className === 'WidgetRepository'));
	assert.equal(result.repositoryResourceNotes.length, 1);
	assert.match(result.repositoryResourceNotes[0], /has no explicit path="\.\.\." attribute/);
});

test('refusal: a @RestResource override anywhere in the interface body refuses the whole repository', () => {
	const root = buildTempFixture({
		repositoryContent: repositoryJava(
			'(path = "widgets")',
			'extends JpaRepository<Widget, UUID>',
			'\t@Override\n\t@RestResource(exported = false)\n\tvoid deleteById(UUID id);\n',
		),
	});
	const result = scanJavaSpring(root);
	const mod = result.modules.find((m) => m.module === 'widget');
	assert.ok(!mod.controllers.some((c) => c.className === 'WidgetRepository'));
	assert.equal(result.repositoryResourceNotes.length, 1);
	assert.match(result.repositoryResourceNotes[0], /overrides at least one CRUD method with @RestResource/);
});

test('silent skip: @RepositoryRestResource on an interface that does not extend a known Spring Data supertype -- no controller, no diagnostic', () => {
	const root = buildTempFixture({
		repositoryContent: `package com.example.app.domain.widget.infrastructure;
import org.springframework.data.rest.core.annotation.RepositoryRestResource;

@RepositoryRestResource(path = "widgets")
public interface WidgetRepository extends java.io.Serializable {
}
`,
	});
	const result = scanJavaSpring(root);
	const mod = result.modules.find((m) => m.module === 'widget');
	assert.ok(!mod.controllers.some((c) => c.className === 'WidgetRepository'));
	assert.equal(result.repositoryResourceNotes.length, 0, 'an unrecognized supertype is as uninteresting as no @Entity match -- silent, not a refusal diagnostic');
});

test('contracts/emit.mjs: the 6 synthesized operations carry the correct expansion field and validate against the schema', () => {
	const root = buildTempFixture({
		repositoryContent: repositoryJava('(path = "widgets")', 'extends JpaRepository<Widget, UUID>'),
	});
	const scanReport = runScan({ repoRoot: root, terms: ['widget'] });
	const contract = buildContract({ featureId: '001-widget-management', featureUid: '4c8de69b-2a4a-40c0-9749-491bc3c41ae2', scanReport, module: 'widget' });
	assert.equal(Object.keys(contract.operations).length, 6);
	for (const op of Object.values(contract.operations)) {
		assert.deepEqual(op.expansion, {
			rule: 'java-spring:repository-rest-resource-crud',
			declarationLine: op.expansion.declarationLine,
			label: '@RepositoryRestResource(path="widgets") on WidgetRepository',
		});
	}
	assert.ok(!contract.warnings.some((w) => w.code === 'CONTRACT_UNMATCHED_ENDPOINT'), 'synthesized operationIds are truthy -- every endpoint must reconcile, not fall through as unmatched');

	const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'feature-contract.schema.json'), 'utf8'));
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	assert.equal(validate(contract), true, JSON.stringify(validate.errors));
});

test('handles plan: willGenerateResolver is false, and the declaration-aware note fires from real scanner output (not a hand-built fixture)', () => {
	const root = buildTempFixture({
		repositoryContent: repositoryJava('(path = "widgets")', 'extends JpaRepository<Widget, UUID>'),
	});
	const javaSrcRoot = path.join(root, 'src/main/java/com/example/app');
	const scanReport = runScan({ repoRoot: root, terms: ['widget'] });
	const plan = planHandles({ javaSrcRoot, scanReport, module: 'widget', resourceFilter: null });
	const widget = plan.resources.find((r) => r.type === 'Widget');
	assert.equal(widget.willGenerateResolver, false);
	assert.equal(widget.fetchOperation.declaration.rule, 'java-spring:repository-rest-resource-crud');
	assert.ok(plan.notes.some((n) => n.includes('expanded from @RepositoryRestResource(path="widgets") on WidgetRepository')));
	assert.ok(plan.notes.some((n) => n.includes('Resolver NOT generated -- this is a structural boundary')));
	assert.equal(plan.notes.some((n) => n.includes('could not find a null(...)')), false);
});
