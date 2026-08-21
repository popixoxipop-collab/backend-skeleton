// A3 (D-patch-strategy): classifies each field of an update-request DTO record into one of the
// four partial-update conventions D-resolver-scope already found in the real oracle repo, from
// static analysis alone -- no guessing beyond what the DTO's own type/annotations declare.
//
// Reuses _java-spring-analyzer.mjs's maskNonCode()/matchBalanced()/skipAnnotationsAndWhitespace()
// (A2 Phase 1's proven infra) rather than duplicating regex-based Java parsing -- classification
// operates entirely on MASKED text; no original-text value (e.g. a @Schema description string) is
// ever needed to decide a field's bucket, only its type/annotation structure, which masking
// preserves 1:1 outside comments/string interiors.
import { maskNonCode, matchBalanced, findClassOrRecordDeclaration, skipAnnotationsAndWhitespace } from '../../../scanners/adapters/_java-spring-analyzer.mjs';

export const PATCH_STRATEGY = Object.freeze({
	PATCH_WRAPPER: 'patch-wrapper',
	NULL_MEANS_UNCHANGED: 'null-means-unchanged',
	FETCH_MERGE_SUBMIT: 'fetch-merge-submit',
	UNSUPPORTED: 'unsupported',
});

// Only the two buckets where reconstructing "everything else stays absent" carries no risk of
// silently carrying a stale sibling field -- see D-patch-strategy in DECISIONS.md for why
// fetch-merge-submit is deliberately excluded even though it's classified just as precisely.
export const CODEGEN_ELIGIBLE = Object.freeze([PATCH_STRATEGY.PATCH_WRAPPER, PATCH_STRATEGY.NULL_MEANS_UNCHANGED]);

// Primitive Java types can never be null -- a field declared as one of these cannot represent
// "omitted", so it can only ever mean "must always be resubmitted" (fetch-merge-submit), the same
// bucket a boxed-but-@NotNull type gets. No real DTO in the oracle repo's grounding used a
// primitive for a genuinely-optional field (Bean Validation on a partial-update DTO always uses
// the boxed type precisely so absence is representable) -- this matches that convention exactly
// rather than special-casing it.
const PRIMITIVE_TYPES = new Set(['int', 'long', 'short', 'byte', 'char', 'boolean', 'float', 'double']);

// Splits a record's parameter-list text (already masked) into its top-level components, treating
// BOTH `<...>` (generics) and `(...)` (annotation argument lists, e.g. `@Schema(description = "",
// nullable = true)`) as non-splitting depth. Deliberately NOT a reuse of plan.mjs's
// countTopLevelCommas() (D-security-8, only tracks `<`/`>`, locked/untouched by this item) --
// record components routinely carry parenthesized annotation args before the type, which that
// narrower helper was never built to handle, so this is a fresh, purpose-built splitter rather
// than stretching security-critical code to a new job.
export function splitTopLevelParams(maskedParamsText) {
	const params = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < maskedParamsText.length; i++) {
		const ch = maskedParamsText[i];
		if (ch === '<' || ch === '(') depth++;
		else if (ch === '>' || ch === ')') depth = Math.max(0, depth - 1);
		else if (ch === ',' && depth === 0) {
			params.push(maskedParamsText.slice(start, i));
			start = i + 1;
		}
	}
	const last = maskedParamsText.slice(start);
	if (last.trim() !== '') params.push(last);
	return params.map((p) => p.trim()).filter(Boolean);
}

// From one masked parameter segment (e.g. `PatchField<Long> monthlyTokenLimit` or `@NotNull
// OrganizationStatus status`), extracts { fieldName, baseType, generic, isArray } -- generic is
// the raw text inside `<...>` when present (e.g. "Long"), null otherwise. Returns null if the
// segment isn't shaped like `[annotations] Type[<...>][[]] name` at all (defensive -- should
// never happen against a real record component, but a malformed/unrecognized shape must fail
// closed to `unsupported`, never be silently misclassified).
export function extractTypeAndName(maskedSegment) {
	const afterAnnotations = skipAnnotationsAndWhitespace(maskedSegment, 0);
	const rest = maskedSegment.slice(afterAnnotations);
	const idMatch = rest.match(/^[\w.]+/);
	if (!idMatch) return null;
	let i = idMatch[0].length;
	let generic = null;
	if (rest[i] === '<') {
		const close = matchBalanced(rest, i, '<', '>');
		if (close === -1) return null;
		generic = rest.slice(i + 1, close).trim();
		i = close + 1;
	}
	let isArray = false;
	while (rest.slice(i, i + 2) === '[]') {
		isArray = true;
		i += 2;
	}
	const nameMatch = rest.slice(i).trim().match(/^(\w+)/);
	if (!nameMatch) return null;
	return { fieldName: nameMatch[1], baseType: idMatch[0], generic, isArray };
}

// The classification rule itself -- see D-patch-strategy in DECISIONS.md for the real DTOs each
// branch was confirmed against (UpdateOperationSettingRequest.monthlyTokenLimit for patch-wrapper,
// UpdateOrganizationRequest.status for fetch-merge-submit, UpdateClassroomManagersRequest.
// managerIds for unsupported, and the majority-case plain-nullable fields for null-means-unchanged).
function classifyParam(maskedSegment) {
	const hasNotNull = /@NotNull\b/.test(maskedSegment);
	const hasValid = /@Valid\b/.test(maskedSegment);
	const parsed = extractTypeAndName(maskedSegment);
	if (!parsed) return null;
	const { fieldName, baseType, generic, isArray } = parsed;

	let bucket;
	let convertType = baseType;
	if (baseType === 'PatchField') {
		// PatchField<T> already IS the "presence-optional, null-has-meaning" convention -- takes
		// priority over any co-occurring @NotNull, which would be a contradictory/unused combination
		// never seen in the oracle repo's grounding.
		bucket = PATCH_STRATEGY.PATCH_WRAPPER;
		convertType = generic ?? 'Object';
	} else if (isArray || hasValid || ['List', 'Set', 'Map'].includes(baseType)) {
		bucket = PATCH_STRATEGY.UNSUPPORTED;
	} else if (hasNotNull || PRIMITIVE_TYPES.has(baseType)) {
		bucket = PATCH_STRATEGY.FETCH_MERGE_SUBMIT;
	} else {
		bucket = PATCH_STRATEGY.NULL_MEANS_UNCHANGED;
	}

	return { field: fieldName, javaType: baseType, generic, bucket, convertType };
}

// The blanket stub -- byte-identical to the pre-A3 template text, used whenever a resource has no
// classified patchable fields at all (no update endpoint found, no DTO resolved, or a non-record
// DTO). Keeping this exact wording means a resource that never gets an update endpoint stays
// completely unaffected by this item, not just functionally but textually.
function blanketStub(resourceType) {
	return [
		'\t\t// TODO: route through the real update method, matching whichever partial-update',
		"\t\t// convention the target field's DTO actually uses. Do not write directly to the",
		'\t\t// repository/entity -- that bypasses this codebase\'s existing validation and business',
		'\t\t// rules, which is the entire reason handles route through the service layer instead of raw SQL.',
		'\t\tthrow new UnsupportedOperationException(',
		`\t\t\t\t"patchField not yet implemented for ${resourceType}" + pointer + " -- see this class's javadoc");`,
	].join('\n');
}

// One `case "/field" -> throw ...` explaining EXACTLY why this specific field isn't generated --
// D-patch-strategy's whole point is replacing "read three paragraphs and guess" with a precise
// per-field reason, so even the non-codegen branches stay field-specific, never lumped into one
// generic message.
function caseThrow(field, resourceType, reasonText) {
	return `\t\t\tcase "/${field.field}" -> throw new UnsupportedOperationException(\n\t\t\t\t\t"patchField not auto-generated for ${resourceType}/${field.field} -- ${reasonText}");`;
}

function caseCodegen(field, { resourceType, dtoTypeName, updateOperation, serviceField, patchable }) {
	const args = patchable.map((f) => {
		if (f.field !== field.field) return 'null';
		return f.bucket === PATCH_STRATEGY.PATCH_WRAPPER ? 'PatchField.of(convertedValue)' : 'convertedValue';
	}).join(', ');
	return [
		`\t\t\tcase "/${field.field}" -> {`,
		`\t\t\t\t${field.convertType} convertedValue = objectMapper.convertValue(value, ${field.convertType}.class);`,
		`\t\t\t\t${dtoTypeName} patch = new ${dtoTypeName}(${args});`,
		`\t\t\t\tSet<ConstraintViolation<${dtoTypeName}>> violations = validator.validate(patch);`,
		'\t\t\t\tif (!violations.isEmpty()) {',
		'\t\t\t\t\tthrow new ConstraintViolationException(violations);',
		'\t\t\t\t}',
		`\t\t\t\t${serviceField}.${updateOperation.method}(resourceUid, patch);`,
		'\t\t\t}',
	].join('\n');
}

// Whether this resource's generated resolver needs the validation/conversion machinery at all
// (Validator + ObjectMapper fields, their imports, Set/ConstraintViolation/
// ConstraintViolationException imports, the DTO type's own import) and separately whether it
// needs PatchField's import specifically -- both are ONLY true when at least one field actually
// gets real codegen (an approved, currently-matching, codegen-eligible field), never merely
// because a field is classified. A resource with fields classified but none approved yet renders
// zero extra imports/fields, keeping it identical to a resource with no update endpoint at all
// until a human actually approves something.
export function computeCodegenNeeds(patchable, approvedFields) {
	const codegenFields = patchable.filter((f) => CODEGEN_ELIGIBLE.includes(f.bucket) && approvedFields.has(f.field));
	return {
		needsValidation: codegenFields.length > 0,
		needsPatchFieldImport: codegenFields.some((f) => f.bucket === PATCH_STRATEGY.PATCH_WRAPPER),
	};
}

// Renders the FULL body of patchField() (everything between its `{`/`}`) -- one `case` per
// classified field (real codegen for an approved eligible field, an explanatory throw for
// everything else), or the untouched blanket stub when there's nothing classified at all.
// `approvedFields` is a Set of field names whose CURRENT classification the caller has already
// confirmed matches an existing approval (see lib/patch-approvals.mjs's approvedStrategyFor) --
// this function trusts that check rather than re-deriving it, keeping the "is this approval still
// valid" decision in exactly one place.
export function renderPatchFieldBody({ resourceType, dtoTypeName, patchable, updateOperation, serviceField, approvedFields, blockedReason = null }) {
	if (patchable.length === 0) return blanketStub(resourceType);
	const cases = patchable.map((field) => {
		// The classification is real and still worth showing per-field, but if the update SERVICE
		// method itself isn't safely callable with the (id, dto) shape every codegen path assumes,
		// no field of this resource can be generated regardless of its own bucket -- one shared
		// reason, not a per-bucket one, since the blocker isn't about any single field.
		if (blockedReason) return caseThrow(field, resourceType, blockedReason);
		if (!CODEGEN_ELIGIBLE.includes(field.bucket)) {
			const reasonText = field.bucket === PATCH_STRATEGY.FETCH_MERGE_SUBMIT
				? 'classified as fetch-merge-submit -- this field is required (or the DTO is otherwise not partial), so patching it safely means fetching the current resource and resubmitting the full request with only this field changed. Not auto-generated (see D-patch-strategy in DECISIONS.md) -- route through the real update path by hand.'
				: 'classified as unsupported (a collection, nested @Valid object, or array field) -- not safely expressible as a single scalar patch. Route through the real update path by hand.';
			return caseThrow(field, resourceType, reasonText);
		}
		if (!approvedFields.has(field.field)) {
			return caseThrow(field, resourceType, `classified as ${field.bucket} but not yet approved -- run \`bskel handles patch approve --feature <id> --resource ${resourceType} --field ${field.field} --strategy ${field.bucket} --reason "..."\` to enable codegen for this field.`);
		}
		return caseCodegen(field, { resourceType, dtoTypeName, updateOperation, serviceField, patchable });
	}).join('\n');
	return `\t\tswitch (pointer) {\n${cases}\n\t\t\tdefault -> throw new UnsupportedOperationException(\n\t\t\t\t\t"patchField not implemented for ${resourceType}" + pointer + " -- see this class's javadoc");\n\t\t}`;
}

// Entry point: classifies every component of a DTO record found in `dtoSourceText`. Returns
// `{ resourceType, fields }`, or null if no top-level `record` declaration is found (this item
// only supports record-shaped update DTOs -- the only shape found across all 17 real update DTOs
// in the oracle repo; a class-shaped update DTO is a documented gap, not silently guessed at).
export function classifyDtoFields(dtoSourceText) {
	const masked = maskNonCode(dtoSourceText);
	const decl = findClassOrRecordDeclaration(masked);
	if (!decl || decl.keyword !== 'record') return null;

	const nameEnd = masked.indexOf(decl.name, decl.index) + decl.name.length;
	let i = nameEnd;
	while (/\s/.test(masked[i])) i++;
	if (masked[i] !== '(') return null;
	const close = matchBalanced(masked, i, '(', ')');
	if (close === -1) return null;

	const maskedParamsText = masked.slice(i + 1, close);
	const fields = splitTopLevelParams(maskedParamsText).map(classifyParam).filter(Boolean);
	return { resourceType: decl.name, fields };
}
