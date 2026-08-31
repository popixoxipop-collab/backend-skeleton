// The shared contract-flow test harness: a real git repo with a real Java controller, a synthetic
// OpenAPI document generator matching it, and the CLI runners every contract test drives them
// through. Extracted verbatim from test/contract-cli.test.mjs when A6 (`contract export`) needed
// the same fixture -- one harness, imported by both, rather than a second copy that could drift.
// Same `_`-prefixed shared-internal-module convention scanners/adapters/_express-shared.mjs and
// scanners/adapters/_java-spring-analyzer.mjs already use (and, being `_`-prefixed rather than
// `*.test.mjs`, it is not itself picked up by `npm test`'s own glob).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');

export function run(args, cwd) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

// Unlike run(), captures stderr even on a successful (exit 0) run -- execFileSync only exposes
// stderr via its thrown error on non-zero exit, so a passing command that still writes an
// informational note to stderr (e.g. the "snapshot left as-is" note) needs spawnSync instead,
// which always returns {stdout, stderr} regardless of exit code.
export function runCapturingStderr(args, cwd) {
	const result = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// `includeDeleteWidget`/`includePatchWidget`/`includePutWidget` add mappings with an
// `@Operation(summary = ...)` but no `operationId` -- each becomes a CONTRACT_UNMATCHED_ENDPOINT
// warning. Matches the real Team-IZ-Backend shape (curriculum's controllers: every method has
// its own `@Operation(...)`, only some set `operationId`) rather than omitting `@Operation`
// entirely -- scanners/adapters/java-spring.mjs's operationId correlator walks backward to the
// NEAREST preceding `@Operation(` occurrence in the whole file, so a method with no `@Operation`
// annotation of its own incorrectly inherits an earlier method's operationId instead of
// correlating to null. Giving each method its own `@Operation(summary=...)` (no operationId)
// keeps that backward search landing on itself, correctly producing null. Kept as a standalone
// source-generator (not string-splicing an existing file) so the "waiver invalidation" test can
// regenerate the whole file with one more endpoint added, rather than doing fragile surgery on
// already-written Java source.
export function widgetControllerSource({ includeDeleteWidget = false, includePatchWidget = false, includePutWidget = false } = {}) {
	const extra = [];
	if (includeDeleteWidget) extra.push(`
	@Operation(summary = "delete a widget")
	@DeleteMapping("/{widgetId}")
	public String deleteWidget(@PathVariable String widgetId) { return "ok"; }`);
	if (includePatchWidget) extra.push(`
	@Operation(summary = "patch a widget")
	@PatchMapping("/{widgetId}")
	public String patchWidget(@PathVariable String widgetId) { return "ok"; }`);
	if (includePutWidget) extra.push(`
	@Operation(summary = "replace a widget")
	@PutMapping("/{widgetId}")
	public String putWidget(@PathVariable String widgetId) { return "ok"; }`);
	return `
package com.example.domain.widget.presentation;

import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.Operation;

@RestController
@RequestMapping(value = "/widgets")
public class WidgetController {

	@Operation(operationId = "findWidgets")
	@GetMapping
	public String findWidgets() { return "ok"; }

	@Operation(operationId = "createWidget")
	@PostMapping
	public String createWidget(@RequestBody Object request) { return "ok"; }

	@Operation(operationId = "findWidget")
	@GetMapping("/{widgetId}")
	public String findWidget(@PathVariable String widgetId) { return "ok"; }
${extra.join('\n')}
}
`;
}

export function widgetControllerPath(root) {
	return path.join(root, 'src', 'main', 'java', 'com', 'example', 'domain', 'widget', 'presentation', 'WidgetController.java');
}

// D-gate-precision (Continued, part 3): DTO drift-detection fixture -- lives under
// `.../widget/presentation/dto/`, the same path-convention scannerJavaSpring() already keys DTO
// detection on. Content is irrelevant (detection is purely path-based, no parsing), so this is a
// minimal but real-looking Java source file, not an empty placeholder.
export function widgetDtoPath(root) {
	return path.join(root, 'src', 'main', 'java', 'com', 'example', 'domain', 'widget', 'presentation', 'dto', 'WidgetDto.java');
}

export function widgetDtoSource() {
	return `
package com.example.domain.widget.presentation.dto;

public record WidgetDto(String widgetId, String name) {
}
`;
}

// `coverage: 'complete'` (default) -- 3/3 endpoints annotated, matches the pre-A5 fixture
// exactly. `coverage: 'partial'` adds 2 unannotated endpoints (DELETE, PATCH), producing
// completeness: partial with exactly 2 CONTRACT_UNMATCHED_ENDPOINT warnings.
//
// A6: `contextPath` (default null) additionally writes a real `src/main/resources/application.yml`
// declaring `server.servlet.context-path`, one of the three global-path-prefix signals
// scanners/adapters/java-spring.mjs's detectGlobalPathPrefixSignals() looks for (A1 §7). This is
// the fixture shape where a contract emitted WITHOUT --openapi-file genuinely has wrong paths --
// exactly the case `contract export` refuses by default.
export function buildFixtureRepo({ coverage = 'complete', contextPath = null } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-contract-cli-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');

	fs.mkdirSync(path.dirname(widgetControllerPath(root)), { recursive: true });
	fs.writeFileSync(widgetControllerPath(root), widgetControllerSource({
		includeDeleteWidget: coverage === 'partial',
		includePatchWidget: coverage === 'partial',
	}));
	if (contextPath) {
		const configPath = path.join(root, 'src', 'main', 'resources', 'application.yml');
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, `server:\n  servlet:\n    context-path: ${contextPath}\n`);
	}
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	// preflight requires a real "origin" to cross-check the default branch against.
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-contract-cli-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

export function initThroughScanDisposition(root) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
}

export function contractSchemaPath(root) {
	return path.join(root, 'specs/001-widget-management/contracts/001-widget-management.schema.json');
}

export function contractResolutionPath(root) {
	return path.join(root, 'specs/001-widget-management/contracts/001-widget-management.resolution.json');
}

export function contractSnapshotPath(root) {
	return path.join(root, 'specs/001-widget-management/contracts/001-widget-management.openapi.snapshot.json');
}

// Matches widgetControllerSource()'s endpoints, all under the real deployed `/api/v0` prefix --
// the exact shape the real Team-IZ-Backend defect looks like (ApiPathConfig.java's global
// addPathPrefix, invisible to source-annotation scanning).
//
// A2: `withRequestBodies` (default false, preserving every existing assertion byte-for-byte)
// opt-in adds a real requestBody to POST /api/v0/widgets, `unsupportedSchema` (opt-in) swaps
// CreateWidgetRequest for one containing a keyword inlineSchema() doesn't support -- exercises
// the "schema found but can't be projected" path distinctly from "no schema at all".
//
// A3: `withResponses` (default false, same byte-for-byte preservation discipline) adds a 201
// WidgetResponse + 400 ErrorResponse to POST /api/v0/widgets; `unsupportedResponseSchema` swaps
// WidgetResponse for one inlineSchema() can't project, symmetric to `unsupportedSchema` above.
//
// A6: `driftFindWidget` moves findWidget's operationId onto POST instead of GET, so the scan's own
// GET disagrees with the document on VERB in a way no path prefix can explain -- a real `drift`
// (CONTRACT_OPENAPI_DRIFT, ERROR), which is the operation kind the self-import guard exists to keep
// an export from laundering back into `matched`. `rangeStatusKeys` writes the same responses under
// OpenAPI's `2XX`/`default` range keys instead of `201`/`400`.
// A7: `withParameters` adds real query/header/cookie parameters to findWidgets (GET
// /api/v0/widgets) -- all fully resolvable, so the round-trip invariant stays provable.
// `withSecurity` adds a real `[{bearerAuth: []}]` requirement + `components.securitySchemes` to
// createWidget/findWidget; `publicFindWidgets` (only meaningful alongside `withSecurity`)
// overrides findWidgets's own security to a literal `[]` (a genuinely public endpoint);
// `securityUnknownScheme` overrides createWidget's security to reference a scheme that is NOT in
// components.securitySchemes, exercising the unresolved/dropped path. `withSummaryTags` adds a
// `summary` + `tags` to every operation.
export function widgetOpenApiDoc({
	includeDeleteWidget = false, includePatchWidget = false,
	withRequestBodies = false, unsupportedSchema = false,
	withResponses = false, unsupportedResponseSchema = false,
	openapiVersion = '3.1.0',
	driftFindWidget = false,
	rangeStatusKeys = false,
	withParameters = false,
	withSecurity = false, publicFindWidgets = false, securityUnknownScheme = false,
	withSummaryTags = false,
} = {}) {
	const paths = {
		'/api/v0/widgets': {
			get: { operationId: 'findWidgets' },
			post: { operationId: 'createWidget' },
		},
		'/api/v0/widgets/{widgetId}': driftFindWidget
			? { post: { operationId: 'findWidget' } }
			: { get: { operationId: 'findWidget' } },
	};
	if (includeDeleteWidget) paths['/api/v0/widgets/{widgetId}'].delete = { operationId: 'deleteWidget' };
	if (includePatchWidget) paths['/api/v0/widgets/{widgetId}'].patch = { operationId: 'patchWidget' };
	const doc = { openapi: openapiVersion, info: { title: 'fixture', version: '1' }, paths };
	const schemas = {};
	const securitySchemes = {};
	if (withRequestBodies) {
		schemas.CreateWidgetRequest = unsupportedSchema
			? { type: 'object', discriminator: { propertyName: 'kind' } }
			: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 10 } } };
		paths['/api/v0/widgets'].post.requestBody = {
			required: true,
			content: { 'application/json': { schema: { '$ref': '#/components/schemas/CreateWidgetRequest' } } },
		};
	}
	if (withResponses) {
		schemas.WidgetResponse = unsupportedResponseSchema
			? { type: 'object', discriminator: { propertyName: 'kind' } }
			: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
		schemas.ErrorResponse = { type: 'object', required: ['code'], properties: { code: { type: 'string' } } };
		const successKey = rangeStatusKeys ? '2XX' : '201';
		const errorKey = rangeStatusKeys ? 'default' : '400';
		paths['/api/v0/widgets'].post.responses = {
			[successKey]: { content: { 'application/json': { schema: { '$ref': '#/components/schemas/WidgetResponse' } } } },
			[errorKey]: { content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } } },
		};
	}
	if (withParameters) {
		paths['/api/v0/widgets'].get.parameters = [
			{ name: 'q', in: 'query', description: 'search term', schema: { type: 'string', maxLength: 40 } },
			{ name: 'X-Trace-Id', in: 'header', schema: { type: 'string' } },
			{ name: 'session', in: 'cookie', schema: { type: 'string' } },
		];
	}
	if (withSecurity) {
		securitySchemes.bearerAuth = { type: 'http', scheme: 'bearer' };
		paths['/api/v0/widgets'].get.security = publicFindWidgets ? [] : [{ bearerAuth: [] }];
		paths['/api/v0/widgets'].post.security = securityUnknownScheme ? [{ apiKeyAuth: [] }] : [{ bearerAuth: [] }];
		const findWidgetItem = driftFindWidget ? paths['/api/v0/widgets/{widgetId}'].post : paths['/api/v0/widgets/{widgetId}'].get;
		findWidgetItem.security = [{ bearerAuth: [] }];
	}
	if (withSummaryTags) {
		paths['/api/v0/widgets'].get.summary = 'list widgets';
		paths['/api/v0/widgets'].get.tags = ['Widgets'];
		paths['/api/v0/widgets'].post.summary = 'create a widget';
		paths['/api/v0/widgets'].post.tags = ['Widgets'];
		const findWidgetItem = driftFindWidget ? paths['/api/v0/widgets/{widgetId}'].post : paths['/api/v0/widgets/{widgetId}'].get;
		findWidgetItem.summary = 'find a widget';
		findWidgetItem.tags = ['Widgets'];
	}
	if (Object.keys(schemas).length > 0 || Object.keys(securitySchemes).length > 0) {
		doc.components = {};
		if (Object.keys(schemas).length > 0) doc.components.schemas = schemas;
		if (Object.keys(securitySchemes).length > 0) doc.components.securitySchemes = securitySchemes;
	}
	return doc;
}

export function writeOpenApiFixture(root, doc) {
	const file = path.join(root, 'build', 'api-docs.json');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(doc));
	return file;
}

// D-field-dependency / D-dependency-propagation-notice: a second, independent Java module
// ("organization", DTO only -- no controller needed, since scoreModule() scores module_name against
// --terms alone, see scanners/index.mjs's collectEvidence()) plus a two-feature repo bootstrap, so a
// cross-feature dependency has two real resolvable resource types to point at. Originally lived only
// in test/dependency-cli.test.mjs; promoted here (same rationale as this file's own header comment)
// once test/dependency-propagation-cli.test.mjs needed the identical fixture -- one harness, imported
// by both, rather than a second copy that could drift.
export function organizationDtoPath(root) {
	return path.join(root, 'src/main/java/com/example/domain/organization/presentation/dto/OrganizationDto.java');
}

export function organizationDtoSource() {
	return `
package com.example.domain.organization.presentation.dto;

public record OrganizationDto(String organizationId, String taxRate) {
}
`;
}

export function buildTwoFeatureFixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-dependency-cli-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	fs.writeFileSync(path.join(root, 'build.gradle'), '// fixture\n');

	fs.mkdirSync(path.dirname(widgetControllerPath(root)), { recursive: true });
	fs.writeFileSync(widgetControllerPath(root), widgetControllerSource());
	fs.mkdirSync(path.dirname(widgetDtoPath(root)), { recursive: true });
	fs.writeFileSync(widgetDtoPath(root), widgetDtoSource());

	fs.mkdirSync(path.dirname(organizationDtoPath(root)), { recursive: true });
	fs.writeFileSync(organizationDtoPath(root), organizationDtoSource());

	// D-dependency-propagation-notice: needed for `handles plan`/`handles emit` to detect the base
	// package (detectBasePackage() looks for a *Application.java under src/main/java) -- unused by
	// the contract-only tests this fixture originally served, but required once
	// test/dependency-propagation-cli.test.mjs exercises `handles emit` through the same fixture.
	fs.mkdirSync(path.join(root, 'src/main/java/com/example'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src/main/java/com/example/ExampleApplication.java'), 'package com.example;\npublic class ExampleApplication {}\n');

	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: two-feature dependency fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-dependency-cli-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

// 001-widget-management (module "widget") and 002-organization-management (module
// "organization") -- both disposed, so every test using this fixture starts from a state where the
// target and source resource types are already resolvable.
export function initBothFeatures(root) {
	run(['preflight'], root);
	run(['feature', 'init', '--slug', 'widget-management'], root);
	run(['scan', '--feature', '001-widget-management', '--terms', 'widget'], root);
	run(['scan', 'disposition', '--feature', '001-widget-management', '--mode', 'reuse', '--note', 'x'], root);
	run(['feature', 'init', '--slug', 'organization-management'], root);
	run(['scan', '--feature', '002-organization-management', '--terms', 'organization'], root);
	run(['scan', 'disposition', '--feature', '002-organization-management', '--mode', 'reuse', '--note', 'x'], root);
}

export function declareArgs({
	feature = '001-widget-management', resource = 'WidgetDto', field = 'name',
	sourceFeature = '002-organization-management', sourceResource = 'OrganizationDto', sourceField = 'taxRate',
	reason = 'name is derived from the organization tax rate', memo = null, json = false,
} = {}) {
	const args = [
		'dependency', 'declare',
		'--feature', feature, '--resource', resource, '--field', field,
		'--source-feature', sourceFeature, '--source-resource', sourceResource, '--source-field', sourceField,
	];
	if (reason !== null) args.push('--reason', reason);
	if (memo !== null) args.push('--memo', memo);
	if (json) args.push('--json');
	return args;
}

export function removeArgs({
	feature = '001-widget-management', resource = 'WidgetDto', field = 'name',
	sourceFeature = '002-organization-management', sourceResource = 'OrganizationDto', sourceField = 'taxRate',
	reason = 'no longer needed', json = false,
} = {}) {
	const args = [
		'dependency', 'remove',
		'--feature', feature, '--resource', resource, '--field', field,
		'--source-feature', sourceFeature, '--source-resource', sourceResource, '--source-field', sourceField,
	];
	if (reason !== null) args.push('--reason', reason);
	if (json) args.push('--json');
	return args;
}

// D-dependency-propagation-notice / D-http-serving-layer: a THIRD, independent Java module
// ("product") added to an already-built buildTwoFeatureFixtureRepo() root -- lets a test declare a
// second, unrelated dependency onto a different source feature (003-product-management), so a
// dependent feature can be made stale for two independent, distinguishable reasons at once. Feature
// numbering assumes buildTwoFeatureFixtureRepo() + initBothFeatures() already ran (001/002 taken),
// so this becomes 003. Originally lived only in test/dependency-propagation-cli.test.mjs; promoted
// here once test/http-server.test.mjs needed the identical fixture shape.
export function buildThirdModuleFixture(root) {
	const productDtoPath = path.join(root, 'src/main/java/com/example/domain/product/presentation/dto/ProductDto.java');
	fs.mkdirSync(path.dirname(productDtoPath), { recursive: true });
	fs.writeFileSync(productDtoPath, 'package com.example.domain.product.presentation.dto;\n\npublic record ProductDto(String productId, String price) {}\n');
	assert.equal(run(['feature', 'init', '--slug', 'product-management'], root).code, 0);
	run(['scan', '--feature', '003-product-management', '--terms', 'product'], root); // exits 3 (awaiting_disposition) -- see initBothFeatures's own scan calls, same reason
	assert.equal(run(['scan', 'disposition', '--feature', '003-product-management', '--mode', 'reuse', '--note', 'x'], root).code, 0);
	return productDtoPath;
}
