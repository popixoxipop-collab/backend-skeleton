// Regression test for a real bug found while testing against Team-IZ-Backend: the "organization"
// module has TWO controllers (OrganizationController AND OperatorController, the latter's base
// path also starting with /organizations/{organizationId}/...). The first version of
// findFetchOperation used controllers[0]'s basePath for every entity, which for a module where
// the unrelated controller happens to come first in scan order would either find nothing or
// (in a differently-shaped module) match the wrong controller's endpoint entirely. Fixed by
// requiring the controller's own basePath AND a class-name affinity check with the entity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planHandles } from '../handles/providers/java-spring/plan.mjs';

function fixtureScanReport() {
	return {
		related_modules: [
			{
				module: 'organization',
				controllers: [
					// Deliberately listed FIRST, and its own basePath is a superset of
					// OrganizationController's -- reproduces the exact shape that broke the
					// original (single shared basePath) implementation.
					{
						className: 'OperatorController',
						basePath: '/organizations/{organizationId}/operators',
						file: null,
						endpoints: [
							{ verb: 'GET', path: '/organizations/{organizationId}/operators', operationId: 'findOperators', method: 'findOperators' },
						],
					},
					{
						className: 'OrganizationController',
						basePath: '/organizations',
						file: null,
						endpoints: [
							{ verb: 'GET', path: '/organizations', operationId: 'findOrganizations', method: 'findOrganizations' },
							{ verb: 'GET', path: '/organizations/{organizationId}', operationId: 'findOrganization', method: 'findOrganization' },
							{ verb: 'POST', path: '/organizations', operationId: 'createOrganization', method: 'createOrganization' },
						],
					},
				],
				entities: [
					{ className: 'Organization', table: 'organization', idField: 'orgId', file: null },
					{ className: 'OrganizationPolicy', table: 'organization_policy', idField: 'policyId', file: null },
				],
				enums: [],
				dtos: [],
			},
		],
	};
}

test('picks the correct controller\'s fetch endpoint when the module has multiple controllers', () => {
	const scanReport = fixtureScanReport();
	const plan = planHandles({ javaSrcRoot: '/nonexistent', scanReport, module: 'organization', resourceFilter: null });

	const org = plan.resources.find((r) => r.type === 'Organization');
	assert.ok(org.fetchOperation, 'Organization should find a fetch operation');
	assert.equal(org.fetchOperation.operationId, 'findOrganization');
	assert.equal(org.fetchOperation.path, '/organizations/{organizationId}');
	assert.equal(org.fetchOperation.controllerClassName, 'OrganizationController');

	const policy = plan.resources.find((r) => r.type === 'OrganizationPolicy');
	assert.equal(policy.fetchOperation, null, 'OrganizationPolicy has no matching controller -- must not fall back to an unrelated one');
});

test('does not mistake OperatorController\'s list endpoint for a single-resource fetch', () => {
	const scanReport = fixtureScanReport();
	// If the bug regressed, Organization's fetchOperation could resolve to something under
	// OperatorController's basePath instead of OrganizationController's.
	const plan = planHandles({ javaSrcRoot: '/nonexistent', scanReport, module: 'organization', resourceFilter: ['Organization'] });
	const org = plan.resources[0];
	assert.notEqual(org.fetchOperation.controllerClassName, 'OperatorController');
});

test('resolver is only planned to generate when both a fetch operation AND a matching service file exist', () => {
	const scanReport = fixtureScanReport();
	const javaSrcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-plan-'));
	fs.mkdirSync(path.join(javaSrcRoot, 'domain', 'organization', 'application'), { recursive: true });
	// Matches fixtureScanReport()'s findOrganization endpoint: a single-arg method by the same
	// name, the convention D-security-8's countServiceMethodParams check requires.
	fs.writeFileSync(
		path.join(javaSrcRoot, 'domain', 'organization', 'application', 'OrganizationService.java'),
		'public interface OrganizationService {\n\tOrganization findOrganization(java.util.UUID organizationId);\n}\n',
	);
	// deliberately do NOT create OrganizationPolicyService.java

	const plan = planHandles({ javaSrcRoot, scanReport, module: 'organization', resourceFilter: null });
	const org = plan.resources.find((r) => r.type === 'Organization');
	const policy = plan.resources.find((r) => r.type === 'OrganizationPolicy');

	assert.equal(org.willGenerateResolver, true);
	assert.equal(policy.willGenerateResolver, false);
	assert.ok(plan.notes.some((n) => n.includes('OrganizationPolicyService')));
});

// D-security-7 regression: a controller whose FIRST-declared method has a weaker role than the
// method actually being planned must not have that weaker role leak onto the planned resource.
// Reproduces the exact shape the Codex security review used: findWidgets() (list, PUBLIC) is
// declared before findWidget() (single-resource fetch, SUPER_ADMIN) -- the pre-fix
// findRequiredAuthority took the file's first @PreAuthorize match unconditionally and would have
// wired the resolver to enforce PUBLIC instead of SUPER_ADMIN.
test('method-level @PreAuthorize is scoped to the actual fetch method, not the first one in the file', () => {
	const javaSrcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-plan-'));
	const controllerDir = path.join(javaSrcRoot, 'domain', 'widget', 'presentation');
	fs.mkdirSync(controllerDir, { recursive: true });
	const controllerFile = path.join(controllerDir, 'WidgetController.java');
	fs.writeFileSync(controllerFile, `
package com.example.domain.widget.presentation;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;

@RestController
@RequestMapping(value = "/widgets")
public class WidgetController {

	@PreAuthorize("hasRole('PUBLIC')")
	@GetMapping
	public String findWidgets() { return "ok"; }

	@PreAuthorize("hasRole('SUPER_ADMIN')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
}
`);
	fs.mkdirSync(path.join(javaSrcRoot, 'domain', 'widget', 'application'), { recursive: true });
	fs.writeFileSync(path.join(javaSrcRoot, 'domain', 'widget', 'application', 'WidgetService.java'), '// fixture\n');

	const scanReport = {
		related_modules: [{
			module: 'widget',
			controllers: [{
				className: 'WidgetController',
				basePath: '/widgets',
				file: controllerFile,
				endpoints: [
					{ verb: 'GET', path: '/widgets', operationId: 'findWidgets', method: 'findWidgets' },
					{ verb: 'GET', path: '/widgets/{widgetId}', operationId: 'findWidget', method: 'findWidget' },
				],
			}],
			entities: [{ className: 'Widget', table: 'widget', idField: 'widgetId', file: null }],
			enums: [],
			dtos: [],
		}],
	};

	const plan = planHandles({ javaSrcRoot, scanReport, module: 'widget', resourceFilter: null });
	const widget = plan.resources.find((r) => r.type === 'Widget');
	assert.equal(widget.fetchOperation.operationId, 'findWidget');
	assert.equal(widget.requiredAuthority, 'SUPER_ADMIN', 'must use the fetch method\'s own role, not the first method in the file');
});

// D-security-7 regression: an @PreAuthorize present but not in the simple hasRole('X') shape
// (e.g. hasAnyRole) must fail closed to TODO_ROLE with a note, not silently fall back to a
// (possibly weaker or absent) class-level authority.
test('an unsupported @PreAuthorize expression fails closed to TODO_ROLE with a note, not a silent fallback', () => {
	const javaSrcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-plan-'));
	const controllerDir = path.join(javaSrcRoot, 'domain', 'widget', 'presentation');
	fs.mkdirSync(controllerDir, { recursive: true });
	const controllerFile = path.join(controllerDir, 'WidgetController.java');
	fs.writeFileSync(controllerFile, `
package com.example.domain.widget.presentation;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;

@PreAuthorize("hasRole('CLASS_LEVEL_FALLBACK')")
@RestController
@RequestMapping(value = "/widgets")
public class WidgetController {

	@PreAuthorize("hasAnyRole('ADMIN', 'SUPER_ADMIN')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
}
`);

	const scanReport = {
		related_modules: [{
			module: 'widget',
			controllers: [{
				className: 'WidgetController',
				basePath: '/widgets',
				file: controllerFile,
				endpoints: [{ verb: 'GET', path: '/widgets/{widgetId}', operationId: 'findWidget', method: 'findWidget' }],
			}],
			entities: [{ className: 'Widget', table: 'widget', idField: 'widgetId', file: null }],
			enums: [],
			dtos: [],
		}],
	};

	const plan = planHandles({ javaSrcRoot, scanReport, module: 'widget', resourceFilter: null });
	const widget = plan.resources.find((r) => r.type === 'Widget');
	assert.equal(widget.requiredAuthority, 'TODO_ROLE', 'must fail closed, not fall back to the weaker class-level role');
	assert.ok(plan.notes.some((n) => n.includes('hasAnyRole/SpEL')), 'must explain why it fell back to TODO_ROLE');
});

// D-security-8 regression: ResourceResolverStub.java.tmpl's fetch() always calls
// `service.method(resourceUid)` with exactly ONE argument. Reproduces the exact shape the Codex
// security review flagged: a Cohort scoped under an organization, whose real service method is
// `find(UUID organizationId, UUID cohortId)` -- generating a resolver for it would either fail to
// compile, or (worse, if a same-named single-arg overload happened to exist) silently drop the
// organization scoping argument.
test('a service method requiring more than one argument blocks resolver generation with a note', () => {
	const javaSrcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-plan-'));
	fs.mkdirSync(path.join(javaSrcRoot, 'domain', 'cohort', 'application'), { recursive: true });
	fs.writeFileSync(
		path.join(javaSrcRoot, 'domain', 'cohort', 'application', 'CohortService.java'),
		'public interface CohortService {\n\tCohort findCohort(java.util.UUID organizationId, java.util.UUID cohortId);\n}\n',
	);

	const scanReport = {
		related_modules: [{
			module: 'cohort',
			controllers: [{
				className: 'CohortController',
				basePath: '/organizations/{organizationId}/cohorts',
				file: null,
				endpoints: [{ verb: 'GET', path: '/organizations/{organizationId}/cohorts/{cohortId}', operationId: 'findCohort', method: 'findCohort' }],
			}],
			entities: [{ className: 'Cohort', table: 'cohort', idField: 'cohortId', file: null }],
			enums: [],
			dtos: [],
		}],
	};

	const plan = planHandles({ javaSrcRoot, scanReport, module: 'cohort', resourceFilter: null });
	const cohort = plan.resources.find((r) => r.type === 'Cohort');
	assert.equal(cohort.willGenerateResolver, false, 'must not generate a resolver that drops the organizationId scoping argument');
	assert.ok(plan.notes.some((n) => n.includes('takes 2 argument(s)')), 'must explain the argument-count mismatch');
});

// D-security-8 regression: a service method the scanner can't find at all (name doesn't match,
// or resolves to something the regex can't read) must fail closed the same way as a confirmed
// mismatch -- never default to "assume 1 argument, generate anyway".
test('a service method that cannot be found at all also blocks resolver generation', () => {
	const javaSrcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-plan-'));
	fs.mkdirSync(path.join(javaSrcRoot, 'domain', 'widget', 'application'), { recursive: true });
	fs.writeFileSync(
		path.join(javaSrcRoot, 'domain', 'widget', 'application', 'WidgetService.java'),
		'public interface WidgetService {\n\tWidget someUnrelatedMethod(java.util.UUID id);\n}\n',
	);

	const scanReport = {
		related_modules: [{
			module: 'widget',
			controllers: [{
				className: 'WidgetController',
				basePath: '/widgets',
				file: null,
				endpoints: [{ verb: 'GET', path: '/widgets/{widgetId}', operationId: 'findWidget', method: 'findWidget' }],
			}],
			entities: [{ className: 'Widget', table: 'widget', idField: 'widgetId', file: null }],
			enums: [],
			dtos: [],
		}],
	};

	const plan = planHandles({ javaSrcRoot, scanReport, module: 'widget', resourceFilter: null });
	const widget = plan.resources.find((r) => r.type === 'Widget');
	assert.equal(widget.willGenerateResolver, false);
	assert.ok(plan.notes.some((n) => n.includes('could not find a findWidget(...) method')));
});

test('--resource filter narrows to the named entities only', () => {
	const scanReport = fixtureScanReport();
	const plan = planHandles({ javaSrcRoot: '/nonexistent', scanReport, module: 'organization', resourceFilter: ['Organization'] });
	assert.equal(plan.resources.length, 1);
	assert.equal(plan.resources[0].type, 'Organization');
});

// A3 (D-patch-strategy): findUpdateOperation()/findRequestBodyTypeName()/planPatchable()
// integration -- same real-file-on-disk fixture pattern as the tests above, since the DTO must
// actually exist on disk for classifyDtoFields() to read it.
function widgetFixture({ withUpdateEndpoint = true, serviceUpdateSignature = 'Widget updateWidget(java.util.UUID widgetId, UpdateWidgetRequest request)' } = {}) {
	const javaSrcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-handles-plan-a3-'));
	const controllerDir = path.join(javaSrcRoot, 'domain', 'widget', 'presentation');
	const dtoDir = path.join(controllerDir, 'dto');
	const appDir = path.join(javaSrcRoot, 'domain', 'widget', 'application');
	fs.mkdirSync(dtoDir, { recursive: true });
	fs.mkdirSync(appDir, { recursive: true });

	fs.writeFileSync(path.join(dtoDir, 'UpdateWidgetRequest.java'), `
package com.example.domain.widget.presentation.dto;
public record UpdateWidgetRequest(
		PatchField<String> label,
		Integer capacity,
		@NotNull String ownerName,
		List<String> tags
) {}
`);

	const patchEndpoint = withUpdateEndpoint
		? '\n\t@PatchMapping("/{widgetId}")\n\tpublic String updateWidget(@PathVariable String widgetId, @Valid @RequestBody UpdateWidgetRequest request) { return "ok"; }\n'
		: '';
	fs.writeFileSync(path.join(controllerDir, 'WidgetController.java'), `
package com.example.domain.widget.presentation;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(value = "/widgets")
public class WidgetController {
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
${patchEndpoint}}
`);

	fs.writeFileSync(path.join(appDir, 'WidgetService.java'), `
public interface WidgetService {
	Widget findWidget(java.util.UUID widgetId);
	${serviceUpdateSignature};
}
`);

	const scanReport = {
		related_modules: [{
			module: 'widget',
			controllers: [{
				className: 'WidgetController',
				basePath: '/widgets',
				file: path.join(controllerDir, 'WidgetController.java'),
				endpoints: [
					{ verb: 'GET', path: '/widgets/{widgetId}', operationId: 'findWidget', method: 'findWidget' },
					...(withUpdateEndpoint ? [{ verb: 'PATCH', path: '/widgets/{widgetId}', operationId: null, method: 'updateWidget' }] : []),
				],
			}],
			entities: [{ className: 'Widget', table: 'widget', idField: 'widgetId', file: null }],
			enums: [],
			dtos: [],
		}],
	};
	return { javaSrcRoot, scanReport };
}

test('A3: a resource with a real 2-arg (id, dto) update service method gets full patchable classification and no blocked reason', () => {
	const { javaSrcRoot, scanReport } = widgetFixture();
	const plan = planHandles({ javaSrcRoot, scanReport, module: 'widget', resourceFilter: null });
	const widget = plan.resources.find((r) => r.type === 'Widget');

	assert.equal(widget.willGenerateResolver, true);
	assert.equal(widget.updateServiceBlockedReason, null);
	assert.equal(widget.dtoTypeName, 'UpdateWidgetRequest');
	assert.equal(widget.updateOperation.method, 'updateWidget');
	assert.deepEqual(widget.patchable.map((f) => [f.field, f.bucket]), [
		['label', 'patch-wrapper'],
		['capacity', 'null-means-unchanged'],
		['ownerName', 'fetch-merge-submit'],
		['tags', 'unsupported'],
	]);
});

test('A3: a service update method with the wrong argument count blocks codegen but KEEPS the classification (regression: an earlier draft blanked patchable to [] here)', () => {
	const { javaSrcRoot, scanReport } = widgetFixture({ serviceUpdateSignature: 'Widget updateWidget(java.util.UUID widgetId, UpdateWidgetRequest request, java.util.UUID requesterId)' });
	const plan = planHandles({ javaSrcRoot, scanReport, module: 'widget', resourceFilter: null });
	const widget = plan.resources.find((r) => r.type === 'Widget');

	assert.ok(widget.updateServiceBlockedReason, 'a 3-arg update method must block codegen');
	assert.match(widget.updateServiceBlockedReason, /takes 3 argument\(s\)/);
	assert.equal(widget.patchable.length, 4, 'classification must survive even when codegen is blocked');
	assert.ok(plan.notes.some((n) => n.includes('patchField() fields are classified but none are auto-generated')));
});

test('A3: no PATCH/PUT endpoint at all leaves patchable empty with an explanatory note, fetch() unaffected', () => {
	const { javaSrcRoot, scanReport } = widgetFixture({ withUpdateEndpoint: false });
	const plan = planHandles({ javaSrcRoot, scanReport, module: 'widget', resourceFilter: null });
	const widget = plan.resources.find((r) => r.type === 'Widget');

	assert.equal(widget.willGenerateResolver, true, 'fetch() must still work independent of patch support');
	assert.equal(widget.updateOperation, null);
	assert.deepEqual(widget.patchable, []);
	assert.ok(plan.notes.some((n) => n.includes('no PATCH/PUT single-resource endpoint found')));
});
