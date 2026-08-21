// A3 (D-patch-strategy): direct unit tests of the classifier + codegen helpers, independent of
// any real repo access -- classifyFile()/java-spring-analyzer precedent for testing pure
// functions directly rather than only through the CLI. See DECISIONS.md D-patch-strategy for the
// real-DTO grounding these fixtures reproduce (all 4 buckets, confirmed live against the oracle
// repo before this file was written).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	classifyDtoFields, splitTopLevelParams, extractTypeAndName,
	computeCodegenNeeds, renderPatchFieldBody, PATCH_STRATEGY,
} from '../handles/providers/java-spring/patch-strategy.mjs';
import { detectJacksonPackage } from '../handles/providers/java-spring/emit.mjs';

test('classifyDtoFields: patch-wrapper for a PatchField<T> component (real shape: UpdateOperationSettingRequest.monthlyTokenLimit)', () => {
	const src = `
public record UpdateSettingsRequest(
		PatchField<Long> monthlyTokenLimit
) {}`;
	const result = classifyDtoFields(src);
	assert.equal(result.resourceType, 'UpdateSettingsRequest');
	assert.deepEqual(result.fields, [{ field: 'monthlyTokenLimit', javaType: 'PatchField', generic: 'Long', bucket: PATCH_STRATEGY.PATCH_WRAPPER, convertType: 'Long' }]);
});

test('classifyDtoFields: null-means-unchanged for a plain nullable field (real shape: UpdateOrganizationRequest.name)', () => {
	const src = `
public record UpdateOrganizationRequest(
		@Schema(description = "new name, comma, inside") String name
) {}`;
	const result = classifyDtoFields(src);
	assert.equal(result.fields[0].bucket, PATCH_STRATEGY.NULL_MEANS_UNCHANGED);
	assert.equal(result.fields[0].field, 'name');
});

test('classifyDtoFields: fetch-merge-submit for an @NotNull field in an otherwise-partial DTO (real shape: UpdateOrganizationRequest.status)', () => {
	const src = `
public record UpdateOrganizationRequest(
		String name,
		@NotNull OrganizationStatus status
) {}`;
	const result = classifyDtoFields(src);
	const status = result.fields.find((f) => f.field === 'status');
	assert.equal(status.bucket, PATCH_STRATEGY.FETCH_MERGE_SUBMIT);
});

test('classifyDtoFields: fetch-merge-submit for a primitive field (real shape: UpdateAssessmentValidityRequest.rowVersion) -- a primitive can never represent "absent"', () => {
	const src = 'public record R(int rowVersion) {}';
	const result = classifyDtoFields(src);
	assert.equal(result.fields[0].bucket, PATCH_STRATEGY.FETCH_MERGE_SUBMIT);
});

test('classifyDtoFields: unsupported for a List<T> field (real shape: UpdateClassroomManagersRequest.managerIds), regardless of @NotNull', () => {
	const src = 'public record R(@NotNull List<UUID> managerIds) {}';
	const result = classifyDtoFields(src);
	assert.equal(result.fields[0].bucket, PATCH_STRATEGY.UNSUPPORTED);
});

test('classifyDtoFields: unsupported for an @Valid-annotated nested object field', () => {
	const src = 'public record R(@Valid AddressDto address) {}';
	const result = classifyDtoFields(src);
	assert.equal(result.fields[0].bucket, PATCH_STRATEGY.UNSUPPORTED);
});

test('classifyDtoFields: annotation argument commas (e.g. @Schema(description = "...", nullable = true)) never split a param', () => {
	const src = 'public record R(@Schema(description = "a, b, c", nullable = true) String name, @Min(1) Integer capacity) {}';
	const result = classifyDtoFields(src);
	assert.equal(result.fields.length, 2, 'the comma inside @Schema(...) must not be treated as a param separator');
	assert.deepEqual(result.fields.map((f) => f.field), ['name', 'capacity']);
});

test('classifyDtoFields: a comment or string literal mentioning fake annotations never affects classification (masking)', () => {
	const src = `
public record R(
		// @NotNull is not actually here, just mentioned in a comment
		String name
) {}`;
	const result = classifyDtoFields(src);
	assert.equal(result.fields[0].bucket, PATCH_STRATEGY.NULL_MEANS_UNCHANGED);
});

test('classifyDtoFields: returns null for a class (not a record) -- only record-shaped update DTOs are supported', () => {
	const src = 'public class NotARecord { private String name; }';
	assert.equal(classifyDtoFields(src), null);
});

test('splitTopLevelParams: treats both <...> and (...) as non-splitting depth', () => {
	const parts = splitTopLevelParams('Map<String, List<Foo>> m, @Schema(a = 1, b = 2) String s');
	assert.equal(parts.length, 2);
});

test('extractTypeAndName: parses a generic + name correctly', () => {
	const parsed = extractTypeAndName('PatchField<Long> monthlyTokenLimit');
	assert.deepEqual(parsed, { fieldName: 'monthlyTokenLimit', baseType: 'PatchField', generic: 'Long', isArray: false });
});

// ---- codegen ----------------------------------------------------------------

const PATCHABLE = [
	{ field: 'label', javaType: 'PatchField', generic: 'String', bucket: PATCH_STRATEGY.PATCH_WRAPPER, convertType: 'String' },
	{ field: 'capacity', javaType: 'Integer', generic: null, bucket: PATCH_STRATEGY.NULL_MEANS_UNCHANGED, convertType: 'Integer' },
	{ field: 'ownerName', javaType: 'String', generic: null, bucket: PATCH_STRATEGY.FETCH_MERGE_SUBMIT, convertType: 'String' },
	{ field: 'tags', javaType: 'List', generic: 'String', bucket: PATCH_STRATEGY.UNSUPPORTED, convertType: 'List' },
];
const UPDATE_OP = { method: 'updateWidget', path: '/widgets/{widgetId}', controllerFile: null, controllerClassName: 'WidgetController' };

test('computeCodegenNeeds: false/false when nothing is approved yet, even for codegen-eligible fields', () => {
	const needs = computeCodegenNeeds(PATCHABLE, new Set());
	assert.deepEqual(needs, { needsValidation: false, needsPatchFieldImport: false });
});

test('computeCodegenNeeds: needsValidation true, needsPatchFieldImport false when only the null-means-unchanged field is approved', () => {
	const needs = computeCodegenNeeds(PATCHABLE, new Set(['capacity']));
	assert.deepEqual(needs, { needsValidation: true, needsPatchFieldImport: false });
});

test('computeCodegenNeeds: needsPatchFieldImport true when the patch-wrapper field is approved', () => {
	const needs = computeCodegenNeeds(PATCHABLE, new Set(['label']));
	assert.deepEqual(needs, { needsValidation: true, needsPatchFieldImport: true });
});

test('renderPatchFieldBody: no patchable fields at all renders the exact pre-A3 blanket stub text', () => {
	const body = renderPatchFieldBody({ resourceType: 'Widget', dtoTypeName: null, patchable: [], updateOperation: null, serviceField: 'widgetService', approvedFields: new Set() });
	assert.match(body, /throw new UnsupportedOperationException\(/);
	assert.match(body, /patchField not yet implemented for Widget/);
	assert.doesNotMatch(body, /switch \(pointer\)/);
});

test('renderPatchFieldBody: an eligible-but-unapproved field explains it is classified but not yet approved, not a generic stub', () => {
	const body = renderPatchFieldBody({ resourceType: 'Widget', dtoTypeName: 'UpdateWidgetRequest', patchable: PATCHABLE, updateOperation: UPDATE_OP, serviceField: 'widgetService', approvedFields: new Set() });
	assert.match(body, /case "\/label" -> throw new UnsupportedOperationException\(/);
	assert.match(body, /not yet approved/);
	assert.match(body, /bskel handles patch approve --feature <id> --resource Widget --field label --strategy patch-wrapper/);
});

test('renderPatchFieldBody: an approved patch-wrapper field gets real codegen (PatchField.of, validator, service call)', () => {
	const body = renderPatchFieldBody({ resourceType: 'Widget', dtoTypeName: 'UpdateWidgetRequest', patchable: PATCHABLE, updateOperation: UPDATE_OP, serviceField: 'widgetService', approvedFields: new Set(['label']) });
	assert.match(body, /case "\/label" -> \{/);
	assert.match(body, /String convertedValue = objectMapper\.convertValue\(value, String\.class\);/);
	assert.match(body, /new UpdateWidgetRequest\(PatchField\.of\(convertedValue\), null, null, null\)/);
	assert.match(body, /validator\.validate\(patch\)/);
	assert.match(body, /throw new ConstraintViolationException\(violations\)/);
	assert.match(body, /widgetService\.updateWidget\(resourceUid, patch\)/);
});

test('renderPatchFieldBody: an approved null-means-unchanged field passes the converted value directly, not wrapped', () => {
	const body = renderPatchFieldBody({ resourceType: 'Widget', dtoTypeName: 'UpdateWidgetRequest', patchable: PATCHABLE, updateOperation: UPDATE_OP, serviceField: 'widgetService', approvedFields: new Set(['capacity']) });
	assert.match(body, /new UpdateWidgetRequest\(null, convertedValue, null, null\)/);
});

test('renderPatchFieldBody: fetch-merge-submit and unsupported fields are never generated even when "approved" (approvedFields cannot make them eligible)', () => {
	const body = renderPatchFieldBody({ resourceType: 'Widget', dtoTypeName: 'UpdateWidgetRequest', patchable: PATCHABLE, updateOperation: UPDATE_OP, serviceField: 'widgetService', approvedFields: new Set(['label', 'capacity', 'ownerName', 'tags']) });
	assert.match(body, /case "\/ownerName" -> throw new UnsupportedOperationException\(\s*"patchField not auto-generated for Widget\/ownerName -- classified as fetch-merge-submit/);
	assert.match(body, /case "\/tags" -> throw new UnsupportedOperationException\(\s*"patchField not auto-generated for Widget\/tags -- classified as unsupported/);
});

test('renderPatchFieldBody: a blockedReason overrides EVERY field\'s case with the same shared reason, regardless of bucket or approval', () => {
	const body = renderPatchFieldBody({
		resourceType: 'Organization', dtoTypeName: 'UpdateOrganizationRequest', patchable: PATCHABLE, updateOperation: UPDATE_OP,
		serviceField: 'organizationService', approvedFields: new Set(['label', 'capacity']), blockedReason: 'OrganizationService.updateOrganization takes 3 argument(s)',
	});
	assert.doesNotMatch(body, /objectMapper\.convertValue/, 'no real codegen must be emitted when blocked, even for approved fields');
	for (const field of ['label', 'capacity', 'ownerName', 'tags']) {
		assert.match(body, new RegExp(`case "/${field}" -> throw new UnsupportedOperationException\\(\\s*"patchField not auto-generated for Organization/${field} -- OrganizationService\\.updateOrganization takes 3 argument\\(s\\)"\\);`));
	}
});

// ---- detectJacksonPackage ------------------------------------------------------

function writeBuildGradle(dir, pluginVersionLine) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'build.gradle'), `plugins {\n\tid 'java'\n\t${pluginVersionLine}\n}\n`);
}

test('detectJacksonPackage: Spring Boot 4+ (real oracle repo: 4.1.0) resolves to Jackson 3\'s package', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-jackson-pkg-'));
	writeBuildGradle(root, "id 'org.springframework.boot' version '4.1.0'");
	assert.equal(detectJacksonPackage(root), 'tools.jackson.databind');
});

test('detectJacksonPackage: Spring Boot 3.x (this project\'s own CI fixture: 3.3.0) resolves to the classic package', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-jackson-pkg-'));
	writeBuildGradle(root, "id 'org.springframework.boot' version '3.3.0'");
	assert.equal(detectJacksonPackage(root), 'com.fasterxml.jackson.databind');
});

test('detectJacksonPackage: defaults to the classic package (not Jackson 3) when build.gradle is missing entirely', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-jackson-pkg-'));
	assert.equal(detectJacksonPackage(root), 'com.fasterxml.jackson.databind');
});

test('detectJacksonPackage: defaults to the classic package when the Spring Boot plugin version can\'t be found in build.gradle', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-jackson-pkg-'));
	writeBuildGradle(root, "// no spring boot plugin line here");
	assert.equal(detectJacksonPackage(root), 'com.fasterxml.jackson.databind');
});
