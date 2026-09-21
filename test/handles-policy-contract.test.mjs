// D-resolver-policy-contract: the refusal ladder derivePolicy() implements (see plan.mjs). Found
// live, grounding this item: a @PreAuthorize("hasRole('USER')") sitting next to a
// @PostAuthorize("returnObject.ownerId == authentication.name") ownership check used to
// auto-materialize ROLE_USER and silently ignore the ownership check entirely -- a real IDOR bskel
// itself would introduce (see DECISIONS.md D-resolver-policy-contract). Section B below (test 8
// specifically) is the direct regression guard for that exact case.
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { planHandles } from '../handles/providers/java-spring/plan.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Self-contained temp-dir fixtures (this file's own convention, matching test/handles-plan.test.mjs
// rather than the shared on-disk test/fixtures/java-spring/ corpus) -- keeps this item's 22 cases
// independent of that corpus's own pinned resource counts/completeness assertions.
function setupWidget(controllerBody, { withService = true, updateEndpoint = null } = {}) {
	const javaSrcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-policy-contract-'));
	const controllerDir = path.join(javaSrcRoot, 'domain', 'widget', 'presentation');
	fs.mkdirSync(controllerDir, { recursive: true });
	const controllerFile = path.join(controllerDir, 'WidgetController.java');
	fs.writeFileSync(controllerFile, `
package com.example.domain.widget.presentation;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.access.prepost.PostAuthorize;
import org.springframework.security.access.annotation.Secured;
import jakarta.annotation.security.RolesAllowed;

@RestController
@RequestMapping(value = "/widgets")
public class WidgetController {
${controllerBody}
}
`);
	if (withService) {
		const serviceDir = path.join(javaSrcRoot, 'domain', 'widget', 'application');
		fs.mkdirSync(serviceDir, { recursive: true });
		fs.writeFileSync(path.join(serviceDir, 'WidgetService.java'), `
package com.example.domain.widget.application;
public interface WidgetService {
	Object findWidget(java.util.UUID id);
	Object updateWidget(java.util.UUID id, Object dto);
}
`);
	}

	const endpoints = [{ verb: 'GET', path: '/widgets/{widgetId}', operationId: 'findWidget', method: 'findWidget' }];
	if (updateEndpoint) endpoints.push(updateEndpoint);

	const scanReport = {
		related_modules: [{
			module: 'widget',
			controllers: [{
				className: 'WidgetController',
				basePath: '/widgets',
				file: controllerFile,
				endpoints,
			}],
			entities: [{ className: 'Widget', table: 'widget', idField: 'widgetId', file: null }],
			enums: [],
			dtos: [],
		}],
	};
	const plan = planHandles({ javaSrcRoot, scanReport, module: 'widget', resourceFilter: null });
	return { plan, widget: plan.resources.find((r) => r.type === 'Widget'), controllerFile };
}

function fetchPolicy(widget) {
	return widget.policies.find((p) => p.action === 'fetch');
}

// -- A: regression -- the provably-safe cases still materialize (must not break) --------------

test('A1: hasRole method-level materializes with ROLE_ prefix', () => {
	const { widget } = setupWidget(`
	@PreAuthorize("hasRole('ADMIN')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	const p = fetchPolicy(widget);
	assert.equal(p.status, 'materialized');
	assert.equal(p.mode, 'role');
	assert.equal(p.authority, 'ROLE_ADMIN');
	assert.equal(p.evidence.kind, 'pre-authorize-has-role');
	assert.equal(p.evidence.scope, 'method');
	assert.equal(typeof p.evidence.line, 'number');
	assert.equal(widget.requiredAuthority, 'ROLE_ADMIN');
	assert.equal(widget.authorizationMode, 'role');
});

test('A2: hasAuthority materializes verbatim, no ROLE_ prefix', () => {
	const { widget } = setupWidget(`
	@PreAuthorize("hasAuthority('WIDGET_READ')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	const p = fetchPolicy(widget);
	assert.equal(p.status, 'materialized');
	assert.equal(p.authority, 'WIDGET_READ');
	assert.equal(p.evidence.kind, 'pre-authorize-has-authority');
});

test('A3: class-level hasRole fallback when method has none', () => {
	const javaSrcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-policy-contract-'));
	const controllerDir = path.join(javaSrcRoot, 'domain', 'widget', 'presentation');
	fs.mkdirSync(controllerDir, { recursive: true });
	const controllerFile = path.join(controllerDir, 'WidgetController.java');
	fs.writeFileSync(controllerFile, `
package com.example.domain.widget.presentation;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;

@PreAuthorize("hasRole('CLASS_ADMIN')")
@RestController
@RequestMapping(value = "/widgets")
public class WidgetController {
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
}
`);
	const scanReport = {
		related_modules: [{
			module: 'widget',
			controllers: [{ className: 'WidgetController', basePath: '/widgets', file: controllerFile, endpoints: [{ verb: 'GET', path: '/widgets/{widgetId}', operationId: 'findWidget', method: 'findWidget' }] }],
			entities: [{ className: 'Widget', table: 'widget', idField: 'widgetId', file: null }],
			enums: [], dtos: [],
		}],
	};
	const plan = planHandles({ javaSrcRoot, scanReport, module: 'widget', resourceFilter: null });
	const widget = plan.resources.find((r) => r.type === 'Widget');
	const p = fetchPolicy(widget);
	assert.equal(p.status, 'materialized');
	assert.equal(p.authority, 'ROLE_CLASS_ADMIN');
	assert.equal(p.evidence.scope, 'class');
});

test('A4: GET hasRole + PATCH hasAuthority both materialize independently', () => {
	const { widget } = setupWidget(`
	@PreAuthorize("hasRole('WIDGET_READER')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }

	@PreAuthorize("hasAuthority('WIDGET_WRITE')")
	@PatchMapping("/{widgetId}")
	public String updateWidget(@PathVariable String widgetId, @RequestBody Object body) { return "ok"; }
`, { updateEndpoint: { verb: 'PATCH', path: '/widgets/{widgetId}', method: 'updateWidget' } });
	const fp = fetchPolicy(widget);
	const pp = widget.policies.find((p) => p.action === 'patch');
	assert.equal(fp.authority, 'ROLE_WIDGET_READER');
	assert.equal(pp.authority, 'WIDGET_WRITE');
});

// -- B: refusal cases -- exact kind/mode/status/authority:null/reason -------------------------

test('B1: hasAnyRole refuses as pre-authorize-unrecognized', () => {
	const { widget } = setupWidget(`
	@PreAuthorize("hasAnyRole('A', 'B')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	const p = fetchPolicy(widget);
	assert.equal(p.status, 'unresolved');
	assert.equal(p.mode, 'delegated');
	assert.equal(p.authority, null);
	assert.equal(p.evidence.kind, 'pre-authorize-unrecognized');
	assert.match(p.reason, /does not evaluate SpEL/);
});

test('B2: hasAnyAuthority refuses as pre-authorize-unrecognized', () => {
	const { widget } = setupWidget(`
	@PreAuthorize("hasAnyAuthority('A', 'B')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	assert.equal(fetchPolicy(widget).evidence.kind, 'pre-authorize-unrecognized');
});

// The headline case (DECISIONS.md's WHY): a companion ownership check must refuse materialization
// even though a perfectly-shaped hasRole('USER') sits right next to it -- this is the exact IDOR
// this item exists to close. Explicitly asserts authority !== 'ROLE_USER'.
test('B3 (headline): @PostAuthorize ownership check alongside a valid hasRole refuses -- NOT materialized as ROLE_USER', () => {
	const { widget } = setupWidget(`
	@PreAuthorize("hasRole('USER')")
	@PostAuthorize("returnObject.ownerId == authentication.name")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	const p = fetchPolicy(widget);
	assert.equal(p.status, 'unresolved');
	assert.equal(p.mode, 'delegated');
	assert.notEqual(p.authority, 'ROLE_USER');
	assert.equal(p.authority, null);
	assert.equal(p.evidence.kind, 'companion-annotation-present');
	assert.match(p.evidence.text, /PostAuthorize/);
	assert.equal(widget.requiredAuthority, 'TODO_ROLE');
	assert.equal(widget.authorizationMode, 'delegated');
});

test('B4: @Secured alone refuses as companion-annotation-present', () => {
	const { widget } = setupWidget(`
	@Secured({"ROLE_ADMIN"})
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	assert.equal(fetchPolicy(widget).evidence.kind, 'companion-annotation-present');
});

test('B5: @RolesAllowed alone refuses as companion-annotation-present', () => {
	const { widget } = setupWidget(`
	@RolesAllowed("ADMIN")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	assert.equal(fetchPolicy(widget).evidence.kind, 'companion-annotation-present');
});

test('B6: no annotation anywhere (service-layer auth only) refuses as authorization-annotation-absent', () => {
	const { widget } = setupWidget(`
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	const p = fetchPolicy(widget);
	assert.equal(p.evidence.kind, 'authorization-annotation-absent');
	assert.equal(p.evidence.text, null);
	assert.equal(p.evidence.line, null);
});

test('B7: two @PreAuthorize in one region refuses as pre-authorize-ambiguous', () => {
	const { widget } = setupWidget(`
	@PreAuthorize("hasRole('A')")
	@PreAuthorize("hasRole('B')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	const p = fetchPolicy(widget);
	assert.equal(p.evidence.kind, 'pre-authorize-ambiguous');
	assert.match(p.evidence.text, / \| /);
});

test('B8: compound SpEL refuses as pre-authorize-unrecognized', () => {
	const { widget } = setupWidget(`
	@PreAuthorize("hasRole('A') and #id == principal.id")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	assert.equal(fetchPolicy(widget).evidence.kind, 'pre-authorize-unrecognized');
});

test('B9: escaped double quotes refuses as pre-authorize-unrecognized', () => {
	const { widget } = setupWidget(`
	@PreAuthorize("hasRole(\\"ADMIN\\")")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	assert.equal(fetchPolicy(widget).evidence.kind, 'pre-authorize-unrecognized');
});

// -- C: ordering / masking (the two secondary defects found while grounding) ------------------

test('C1: mapping-annotation-then-@PreAuthorize order does not leak into the PREVIOUS method', () => {
	const { widget } = setupWidget(`
	@GetMapping("/other")
	public String findOther() { return "ok"; }

	@GetMapping("/{widgetId}") @PreAuthorize("hasRole('ADMIN')")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	const p = fetchPolicy(widget);
	assert.equal(p.status, 'materialized');
	assert.equal(p.authority, 'ROLE_ADMIN');
});

test('C2: a commented-out @PreAuthorize is not matched (masked scan)', () => {
	const { widget } = setupWidget(`
	// @PreAuthorize("hasRole('ADMIN')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	const p = fetchPolicy(widget);
	assert.equal(p.evidence.kind, 'authorization-annotation-absent');
	assert.notEqual(p.authority, 'ROLE_ADMIN');
});

// -- D: invariants, across every case above ----------------------------------------------------

test('D1: status/mode/authority invariants hold for every case in this file', () => {
	const cases = [
		setupWidget(`\n\t@PreAuthorize("hasRole('ADMIN')")\n\t@GetMapping("/{widgetId}")\n\tpublic String findWidget(@PathVariable String widgetId) { return "ok"; }\n`),
		setupWidget(`\n\t@PreAuthorize("hasAnyRole('A','B')")\n\t@GetMapping("/{widgetId}")\n\tpublic String findWidget(@PathVariable String widgetId) { return "ok"; }\n`),
		setupWidget(`\n\t@GetMapping("/{widgetId}")\n\tpublic String findWidget(@PathVariable String widgetId) { return "ok"; }\n`),
	];
	for (const { widget } of cases) {
		for (const p of widget.policies) {
			assert.equal(p.status === 'materialized', p.mode === 'role', `mode/status invariant for ${JSON.stringify(p)}`);
			assert.equal(p.authority !== null, p.status === 'materialized', `authority/status invariant for ${JSON.stringify(p)}`);
		}
	}
});

test('D2: policies has exactly 2 records, fetch then patch, never a "recover" record', () => {
	const { widget } = setupWidget(`
	@PreAuthorize("hasRole('ADMIN')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	assert.equal(widget.policies.length, 2);
	assert.equal(widget.policies[0].action, 'fetch');
	assert.equal(widget.policies[1].action, 'patch');
	assert.ok(!widget.policies.some((p) => p.action === 'recover'));
});

test('D3: requiredAuthority/requiredAuthorityForPatch are exactly the policies[] projection', () => {
	const { widget } = setupWidget(`
	@PreAuthorize("hasRole('READER')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }

	@PreAuthorize("hasAuthority('WRITER')")
	@PatchMapping("/{widgetId}")
	public String updateWidget(@PathVariable String widgetId, @RequestBody Object body) { return "ok"; }
`, { updateEndpoint: { verb: 'PATCH', path: '/widgets/{widgetId}', method: 'updateWidget' } });
	assert.equal(widget.requiredAuthority, widget.policies[0].authority ?? 'TODO_ROLE');
	assert.equal(widget.requiredAuthorityForPatch, widget.policies[1].authority ?? 'TODO_ROLE');
});

test('D4: authorizationMode is "delegated" whenever either record is unresolved', () => {
	const { widget } = setupWidget(`
	@PreAuthorize("hasRole('READER')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }

	@PreAuthorize("hasAnyRole('A','B')")
	@PatchMapping("/{widgetId}")
	public String updateWidget(@PathVariable String widgetId, @RequestBody Object body) { return "ok"; }
`, { updateEndpoint: { verb: 'PATCH', path: '/widgets/{widgetId}', method: 'updateWidget' } });
	assert.equal(widget.policies[0].status, 'materialized');
	assert.equal(widget.policies[1].status, 'unresolved');
	assert.equal(widget.authorizationMode, 'delegated');
});

test('D5: a resource with NO update endpoint at all is "role"-mode, not blocked (endpoint-absent is benign)', () => {
	// Found live while implementing: a read-only resource (no PATCH/PUT endpoint) used to
	// incorrectly flip authorizationMode to 'delegated' and block `handles emit`, even though
	// there is nothing to protect -- the patch endpoint structurally does not exist. See
	// plan.mjs's policyRequiresResolution().
	const { widget } = setupWidget(`
	@PreAuthorize("hasRole('READER')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	assert.equal(widget.policies[1].action, 'patch');
	assert.equal(widget.policies[1].status, 'unresolved');
	assert.equal(widget.policies[1].evidence.kind, 'endpoint-absent');
	assert.equal(widget.authorizationMode, 'role', 'a structurally-absent PATCH endpoint must not force delegation');
});

test('D6: evidence.file is always repo-relative, never absolute', () => {
	const { widget } = setupWidget(`
	@PreAuthorize("hasRole('ADMIN')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	assert.ok(!path.isAbsolute(fetchPolicy(widget).evidence.file));
});

test('D7: every plan in this file validates against schemas/handles-plan.schema.json', () => {
	const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schemas', 'handles-plan.schema.json'), 'utf8'));
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	const { widget } = setupWidget(`
	@PreAuthorize("hasRole('ADMIN')")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
`);
	const fakePlanDoc = { schema: 'sbf.handles-plan/1', provider: 'java-spring', module: 'widget', resources: [{ ...widget, readPath: null }], notes: [] };
	const ok = validate(fakePlanDoc);
	assert.ok(ok, JSON.stringify(validate.errors));
});
