// A6: renders an already-emitted feature contract as a standalone OpenAPI 3.1 document -- the
// EXIT direction A1 never built. A1/A2/A3 made `--openapi-file` load-bearing (python-fastapi,
// typescript-express and javascript-express all declare `api.operations: false` and depend on a
// real document for any contract at all), but nothing could get back OUT: a feature-scoped,
// single-module, fully `$ref`-inlined contract is more useful than the source repo's own whole-repo
// document for a Swagger UI page scoped to one feature, a client generator that chokes on `$ref`,
// or a mock server for one feature's operations.
//
// This module is PURE -- no I/O, no gate awareness (that is bin/bskel.mjs's cmdContractExport's
// job), mirroring how contracts/emit.mjs's buildContract() and contracts/openapi.mjs's
// reconcileModule() stay pure while the CLI layer owns files and gates.
//
// THE CENTRAL CONSTRAINT: this is a LOSSY, NARROW projection, and it must never synthesize what
// the contract does not know. A7 (D-openapi-passthrough) narrowed that lossiness for four fields --
// query/header/cookie parameters, security (+securitySchemes), summary, and tags are now emitted,
// but ONLY when a real source document (--openapi-file) licensed it for that EXACT operation; where
// no source stated one, the key is still omitted, meaning "unspecified". A8 (D-openapi-per-status)
// extends the same discipline to per-status responses (additive to, never replacing, the
// responseSchema/errorSchema union) and non-JSON request media types. A9 (D-openapi-path-params) is
// different in kind from A7/A8 -- not additive, a REPLACEMENT in place: a path parameter's own
// `pathParams` schema is corrected from the source document per-segment when it resolves one,
// falling back to the pre-existing name heuristic only where the source doesn't answer. A10
// (D-openapi-description) finally builds operation-level `description` -- the one field this whole
// effort measured too expensive to default-on (2,442.7 bytes/operation average, larger than every
// other field this projection copies combined) -- as the one source-backed field that is opt-in
// (`contract emit --descriptions`) rather than default-on. A11 (D-openapi-field-docs) extends the
// SAME `--descriptions` flag one level deeper: schema FIELD-level `description`/`example` (a
// property's own annotation, not the operation's), reusing the flag rather than adding a second
// one. Every omission is disclosed in prose (`info.description`) and machine-readably
// (`info.x-bskel-omitted`) rather than papered over -- see D-openapi-export, D-openapi-passthrough,
// D-openapi-per-status, D-openapi-path-params, D-openapi-description, and D-openapi-field-docs in
// DECISIONS.md.
import { createHash } from 'node:crypto';
import { BSKEL_GENERATED_EXTENSION, BSKEL_PASSTHROUGH_EXTENSION, PATH_PREFIX_RE, RESPONSE_STATUS_KEY_RE, MEDIA_TYPE_RE, PER_STATUS_NO_DESCRIPTION_STANDIN, SUCCESS_STATUS_RE, ERROR_STATUS_RE, DEFAULT_STATUS_KEY } from './openapi.mjs';

// 3.1 ONLY, and deliberately no 3.0 mode even as a flag -- this is a cited exclusion, not
// laziness. Verified by executing the official meta-schemas, not by reading prose: 3.0's
// `Operation` has `required: ["responses"]`, which would force synthesizing a response object for
// an operation the contract knows nothing about; 3.0's Schema Object types `exclusiveMinimum`/
// `exclusiveMaximum` as BOOLEANS while contracts/openapi.mjs's COPIED_KEYWORDS copies them as the
// NUMBERS a 3.1 source document used, so emitting one into a 3.0 document silently inverts its
// meaning; and 3.0's Schema Object has no `const` at all and restricts `type` to a string enum
// with no `"null"` member, both of which a projected contract schema can legitimately contain.
// See D-openapi-export's EXCLUDED section in DECISIONS.md.
export const OPENAPI_TARGET_VERSION = '3.1.0';

export const STATUS_CODE_MODES = Object.freeze(['range', 'literal']);

const JSON_MEDIA_TYPE = 'application/json';
const HTTP_VERBS = Object.freeze(new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']));

// OpenAPI 3.1 REQUIRES `description` on a Response Object (`$defs.response.required:
// ["description"]`, confirmed by executing the official 2022-10-07 meta-schema). These two strings
// therefore exist because the FORMAT demands a description, not because the contract has one --
// so they describe the projection itself and make no claim about the API. Same "describe the
// method, not an unchecked fact about the repo" discipline D-openapi-reconciliation applied when
// it rewrote `api_surface_source`.
const SUCCESS_RESPONSE_DESCRIPTION = 'Success. The source contract records the union of every documented 2xx JSON body for this operation, with no per-status detail -- see info.x-bskel-omitted.';
const ERROR_RESPONSE_DESCRIPTION = 'Error. The source contract records the union of every documented 4xx/5xx JSON body for this operation, with no per-status detail -- see info.x-bskel-omitted.';

// Structural omissions: the contract format carries none of these for ANY contract, so they are
// always disclosed. Phrased as "this projection cannot represent X", never as "the real API has X
// that we dropped" -- this tool has no way to know the latter, and asserting an unverified fact
// about the target repo is exactly the dishonesty D-openapi-reconciliation's §7 addendum fixed.
//
// A7: query/header/cookie parameters, security, summaries, and tags moved OUT of this list -- they
// are now real emitted content when a source document licensed them, so they only belong in the
// DERIVED (ANY-based) set collectOmissions() builds below. A8 moves `per-status-responses` and
// `non-json-request-media-types` (renamed from `non-json-media-types`) out the same way. A9 moves
// `path-parameter-schemas` out the same way too -- path-param schemas now come from a real source
// document whenever it declares a resolvable one (see D-openapi-path-params, the real fix for the
// `batchRequestId` finding this omission entry used to describe unconditionally), falling back to
// the contract's own name heuristic only per-segment, so its presence is now content-conditional
// like every other A7/A8 field, not a permanent structural fact. A10 splits the old single
// `descriptions` entry in two: `operation-descriptions` moves out (opt-in via `--descriptions`, so
// its presence is now content-AND-flag-conditional, same ANY-based doctrine), while
// `field-descriptions` (schema-field-level `description`/`title`/`example`, dropped as
// DROPPED_KEYWORDS while inlining ANY schema) stays structural at that point. A11
// (D-openapi-field-docs) splits `field-descriptions` again the same way: `description`/`example`
// move OUT to the ANY-based set below (`--descriptions` now doubles as the field-level flag too,
// keeping the `field-descriptions` NAME since that is still exactly what it describes -- only its
// meaning moves from "never built" to "content-AND-flag-conditional"), while `title`/`examples`
// (plural)/`externalDocs`/`xml`/`deprecated` move to a new, narrower structural entry
// (`field-metadata`) -- measured 0 real occurrences each against the Team-IZ-Backend oracle, so
// they stay permanently unbuilt on the same "don't build for zero real cases" grounds as the two
// A8 entries below, not this item's scope. What else stays structural: `vendor-extensions` (x-*
// keys on an operation are never copied -- excluded in principle, not by cap or failure, since
// their semantics are tool-specific), and two A8 additions: `non-json-response-schemas` (a non-JSON
// response media type's NAME is copied via a per-status entry's `mediaTypes`, but its SHAPE is never
// projected -- 0/674 real occurrences, so building that machinery would violate this project's own
// "don't build for zero real cases" discipline) and `response-headers` (response `headers`/`links`
// -- 0/694 real occurrences, a genuinely visible gap only now that per-status responses look
// complete).
const STRUCTURAL_OMISSIONS = Object.freeze([
	'field-metadata',
	'non-json-response-schemas',
	'response-headers',
	'vendor-extensions',
]);

const OMISSION_PROSE = Object.freeze({
	'cookie-parameters': 'cookie parameters, for at least one operation that does not carry a fully-copied set (never emitted at all when --openapi-file was not given, or the source document declared none)',
	'error-schemas': 'a JSON error-body schema for at least one operation',
	'field-descriptions': 'a schema field\'s own `description`/`example` (a property\'s own annotation, distinct from the operation-level `description` field -- see `operation-descriptions` below), for at least one field in the request-body/response/error schema of at least one operation -- copied only when `contract emit --descriptions` was used (the same flag as operation-level description) AND the source declared one for that exact field AND it did not exceed the length/size cap; otherwise the field carries no `description`/`example` key, never synthesized. Not tracked separately for per-status responses, non-JSON request media types, or path-parameter schemas -- those may carry field docs when the flag is on, but their presence is not reflected in this specific omission entry',
	'field-metadata': 'a schema field\'s `title`, plural `examples`, `externalDocs`, `xml`, or `deprecated` keyword -- dropped unconditionally while inlining a schema (contracts/openapi.mjs\'s DROPPED_KEYWORDS), regardless of `--descriptions`. Permanently unbuilt: 0 real occurrences of any of these five measured against the Team-IZ-Backend oracle',
	'header-parameters': 'header parameters, for at least one operation that does not carry a fully-copied set (never emitted at all when --openapi-file was not given, or the source document declared none)',
	'non-json-request-media-types': 'the media type of the request body, for at least one operation that takes one -- a non-application/json request media type is emitted only when a real source document declared one for that exact operation, copied byte-for-byte; otherwise this document shows a JSON media-type entry because that is all the contract knows, never because the real body is known to be JSON',
	'non-json-response-schemas': 'a JSON Schema for any response body in a media type other than application/json -- the media type is named where a source document declared one for that status, but its shape is never projected',
	'operation-descriptions': 'the operation-level `description`, for at least one operation -- copied only when `contract emit --descriptions` was used (opt-in: measured real average 2,442.7 bytes/operation, larger than every other field this projection copies combined) AND the source document declared one for that exact operation AND it did not exceed the length cap; otherwise this key is absent for that operation, never synthesized',
	'path-parameter-schemas': 'a path parameter\'s schema, for at least one path segment on at least one operation -- derived from this contract\'s own name heuristic (a trailing "Id" is assumed to be a UUID) rather than a real source document, because no source document was given, the source declared no schema for that segment, or the schema failed to resolve; a segment not covered by this note was resolved from the source document\'s own real schema',
	'per-status-responses': 'per-status responses, for at least one operation -- that operation\'s entry collapses every documented 2xx body into one `2XX` union and every 4xx/5xx body into one `default` union, and records no real status codes. Where a real source document (--openapi-file) documented statuses for an operation, its own status codes and descriptions are emitted verbatim instead; nothing is invented for an operation the source said nothing about',
	'query-parameters': 'query parameters, for at least one operation that does not carry a fully-copied set (never emitted at all when --openapi-file was not given, or the source document declared none)',
	'request-body-schemas': 'a JSON request-body schema for at least one operation that takes a body',
	'response-headers': 'response headers and links on any documented status -- copyable in principle, not built; a per-status response here describes its body and nothing else',
	'response-schemas': 'a JSON success-body schema for at least one operation',
	security: 'security requirements and/or security schemes, for at least one operation -- `security` is emitted ONLY when a real source document (--openapi-file) stated one for that EXACT operation, byte-for-byte, including a literal `[]` (a genuine claim that no authentication is required); where no source document was given, or the source stated nothing for that operation, the key is omitted, meaning "unspecified", never invented',
	summaries: 'operation summaries, for at least one operation -- copied from a real source document when present, never synthesized from operationId or module names',
	tags: 'operation tags, for at least one operation -- copied verbatim from a real source document when present',
	'vendor-extensions': 'vendor extensions (`x-*` keys) on any operation -- copyable in principle, excluded because their semantics are tool-specific',
});

function hasSourceParamIn(op, loc) {
	return Array.isArray(op.sourceParameters) && op.sourceParameters.some((p) => p.in === loc);
}

// A11: whether AT LEAST ONE node anywhere in this schema carries a copied `description`/`example`
// -- deliberately the same coarse "presence, not completeness" doctrine `operation-descriptions`
// already uses for `op.sourceDescription` (this cannot know, from the exported contract alone,
// whether a field WITHOUT one had none in the source or was simply never reached with the flag
// off; it only discloses whether ANY field-level annotation survived at all). `seen` guards the
// same delete-on-exit-shaped cycle risk inlineSchema() itself defends against -- belt-and-braces,
// since a contract's own schemas are already acyclic by construction, but this walk is generic over
// whatever JSON shape ends up in a contract field.
function schemaHasFieldDocs(node, seen = new Set()) {
	if (node === null || typeof node !== 'object' || Array.isArray(node) || seen.has(node)) return false;
	seen.add(node);
	if (typeof node.description === 'string' || Object.hasOwn(node, 'example')) return true;
	if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
		for (const propSchema of Object.values(node.properties)) {
			if (schemaHasFieldDocs(propSchema, seen)) return true;
		}
	}
	if (node.items && typeof node.items === 'object' && schemaHasFieldDocs(node.items, seen)) return true;
	if (node.additionalProperties && typeof node.additionalProperties === 'object' && schemaHasFieldDocs(node.additionalProperties, seen)) return true;
	return false;
}

// Derived from the contract's ACTUAL content, not hardcoded -- an operation that takes a body but
// has no projected schema, or has no response/error schema, each add their own entry, so the list
// says what is missing from THIS document rather than reciting a fixed disclaimer.
//
// A7: query/header/cookie parameters, security, summaries, and tags follow the SAME "ANY, not ALL"
// doctrine unreflectedPathPrefixes() already established -- present whenever at least one exported
// operation lacks that field's passthrough, whether because no source document was given at all, the
// source document genuinely declared none for that operation, or copying it failed and produced a
// CONTRACT_OPENAPI_*_UNRESOLVED warning. In every one of those cases a consumer cannot trust that
// EVERY operation carries it, which is exactly what this disclosure exists to say.
export function collectOmissions(contract) {
	const omissions = new Set(STRUCTURAL_OMISSIONS);
	for (const op of Object.values(contract.operations)) {
		if (!op.requestBodySchema && (op.body === true || op.body === 'unknown')) omissions.add('request-body-schemas');
		if (!op.responseSchema) omissions.add('response-schemas');
		if (!op.errorSchema) omissions.add('error-schemas');
		if (!hasSourceParamIn(op, 'query')) omissions.add('query-parameters');
		if (!hasSourceParamIn(op, 'header')) omissions.add('header-parameters');
		if (!hasSourceParamIn(op, 'cookie')) omissions.add('cookie-parameters');
		if (!op.sourceSecurity) omissions.add('security');
		if (!op.sourceSummary) omissions.add('summaries');
		if (!op.sourceTags) omissions.add('tags');
		// A8: per-status responses -- ANY-based, same doctrine as every check above.
		if (!(op.sourceResponses && typeof op.sourceResponses === 'object' && Object.keys(op.sourceResponses).length > 0)) {
			omissions.add('per-status-responses');
		}
		// A8: non-JSON request media type -- only meaningful for an operation that takes a body at
		// all (same gate request-body-schemas above already uses); an operation with body===false
		// genuinely has no request media type to disclose.
		if ((op.body === true || op.body === 'unknown') && !op.requestBodySchema && !op.sourceRequestBody) {
			omissions.add('non-json-request-media-types');
		}
		// A9: path-parameter schemas -- ANY-based, same doctrine as every check above. An operation
		// with zero path params, or every one source-resolved, has no pathParamsHeuristic at all
		// (contracts/emit.mjs never persists an empty array), so it naturally never trips this check.
		if (Array.isArray(op.pathParamsHeuristic) && op.pathParamsHeuristic.length > 0) {
			omissions.add('path-parameter-schemas');
		}
		// A10: operation-level description -- ANY-based, same doctrine. Absent whenever
		// --descriptions was not used at all (every operation then lacks sourceDescription, so this
		// always trips until the flag is used), the source had none for this operation, or it
		// exceeded the length cap.
		if (!op.sourceDescription) omissions.add('operation-descriptions');
		// A11: schema field-level description/example -- ANY-based, same doctrine as
		// response-schemas/error-schemas just above: added whenever NONE of this operation's
		// projected schemas carry a field-level annotation, including the (common) case where the
		// operation has no projected schema at all to carry one -- same "absence of the whole class
		// is itself disclosed" posture response-schemas/error-schemas already take unconditionally,
		// not gated on whether a schema exists first.
		const fieldSchemas = [op.requestBodySchema, op.responseSchema, op.errorSchema].filter(Boolean);
		if (!fieldSchemas.some((s) => schemaHasFieldDocs(s))) omissions.add('field-descriptions');
	}
	return [...omissions].sort();
}

// A8: which of the three status-codes variants applies -- none of this contract's response/error-
// bearing operations carry per-status source data (the pre-A8 union-only story, unchanged wording),
// all of them do (every real status code in this export is a copied fact, not an invented one), or
// a mix (some real, some union stand-ins) -- computed from the contract's own content, never
// guessed.
function statusCodesLine(contract, statusCodes) {
	const opsWithSchema = Object.values(contract.operations).filter((op) => op.responseSchema || op.errorSchema);
	const perStatusCount = opsWithSchema.filter((op) => op.sourceResponses && typeof op.sourceResponses === 'object' && Object.keys(op.sourceResponses).length > 0).length;
	if (opsWithSchema.length > 0 && perStatusCount === opsWithSchema.length) {
		return 'Status codes: every response/error-bearing operation in this export carries the source document\'s own real status codes, copied verbatim (--openapi-file) -- nothing here is invented.';
	}
	if (perStatusCount > 0) {
		return statusCodes === 'literal'
			? `Status codes: ${perStatusCount} of ${opsWithSchema.length} response/error-bearing operation(s) carry the source document's own real status codes, copied verbatim; the rest have no per-status source data, so \`200\` is a bskel-chosen stand-in for those -- see info.x-bskel-generated.passthrough for exactly which is which.`
			: `Status codes: ${perStatusCount} of ${opsWithSchema.length} response/error-bearing operation(s) carry the source document's own real status codes, copied verbatim; the rest have no per-status source data, so \`2XX\`/\`default\` range keys are used for those, inventing nothing but recording no real code -- see info.x-bskel-generated.passthrough for exactly which is which.`;
	}
	return statusCodes === 'literal'
		? 'Status codes: `200` is a bskel-chosen stand-in for "the documented success body". The source contract records no status codes whatsoever, so `200` here is NOT a claim that this operation returns 200. Re-export with `--status-codes range` for the spec-legal `2XX` range key, which invents nothing.'
		: 'Status codes: `2XX` and `default` are OpenAPI 3.1 range keys. They are used because the source contract records no status codes whatsoever, so any concrete code would be invented.';
}

function renderDescription(contract, omissions, statusCodes) {
	const lines = [
		`Generated by \`bskel contract export\` from feature ${contract.feature_id}'s own machine-readable contract (\`sbf_contract: "${contract.sbf_contract}"\`, completeness: ${contract.completeness.status}).`,
		'',
		'THIS IS A NARROW, LOSSY PROJECTION OF ONE FEATURE, NOT A DESCRIPTION OF THE WHOLE API.',
		'It describes exactly what the source contract knows and nothing else. The following are either',
		'never represented here, or not represented for at least one operation in this document -- their',
		'absence is a limit of this projection, never evidence that the real API lacks them:',
		'',
		...omissions.map((key) => `  - ${key}: ${OMISSION_PROSE[key] ?? key}`),
		'',
		statusCodesLine(contract, statusCodes),
		'',
		'The same information, machine-readable, is in `info.x-bskel-omitted`.',
	];
	return lines.join('\n');
}

// Every `{name}` in the path template, in order, deduplicated (OpenAPI forbids two parameters
// sharing name+location). The schema comes from the contract's own `pathParams.properties`; the
// `{}` fallback for a name the contract has no property for is "unconstrained", which is both
// honest and the minimum the 3.1 meta-schema accepts (`$defs.parameter`'s
// `oneOf: [{required:["schema"]}, {required:["content"]}]` means a parameter MUST carry one or the
// other -- confirmed by executing the real schema).
function buildPathParameters(op) {
	const props = op.pathParams && typeof op.pathParams === 'object' && !Array.isArray(op.pathParams)
		? (op.pathParams.properties ?? {})
		: {};
	const seen = new Set();
	const params = [];
	for (const match of String(op.path).matchAll(/\{([^{}/]+)\}/g)) {
		const name = match[1];
		if (seen.has(name)) continue;
		seen.add(name);
		params.push({
			name,
			in: 'path',
			// 3.1's `styles-for-path` subschema makes this `{const: true}` AND required -- a path
			// parameter that omits it, or sets it false, fails the real meta-schema. Also simply true.
			required: true,
			schema: Object.hasOwn(props, name) ? props[name] : {},
		});
	}
	return params;
}

// A7: appends the operation's copied `sourceParameters` (query/header/cookie) to the path-derived
// list above, deduplicated on (name,in) with the PATH-derived ones winning -- the exporter enforces
// uniqueness itself, since the meta-schema demonstrably does not (confirmed by executing it: two
// parameters sharing name+in both validate `true`). A copied parameter whose own `schema` failed to
// resolve (kept in sourceParameters without a `schema` key, see contracts/openapi.mjs's
// copyParameter) is emitted with `schema: {}` here -- not dropped -- the same honest-minimum
// fallback buildPathParameters() already uses for a path parameter with no known schema.
function buildOperationParameters(op) {
	const params = buildPathParameters(op);
	const seen = new Set(params.map((p) => `${p.in} ${p.name}`));
	if (Array.isArray(op.sourceParameters)) {
		for (const p of op.sourceParameters) {
			const key = `${p.in} ${p.name}`;
			if (seen.has(key)) continue;
			seen.add(key);
			params.push(Object.hasOwn(p, 'schema') ? p : { ...p, schema: {} });
		}
	}
	return params;
}

// The `content: {'application/json': {}}` shape (a media-type entry with NO schema) is load-bearing
// and deliberate, not an oversight: it is the only way to say "this operation takes a JSON body,
// whose shape this contract does not know" without inventing one. Emitting `{type: 'object'}` there
// would be a fabricated schema, AND would break the round-trip invariant (re-importing would
// produce a `requestBodySchema` the original contract never had).
//
// A8: non-JSON media types (op.sourceRequestBody) merge in regardless of the JSON branch above -- a
// real operation can legally accept BOTH application/json and multipart/form-data. This is also
// where the real, pre-existing `body:false`-but-a-real-body-exists disagreement (see
// D-openapi-per-status -- multipart handlers use @RequestPart, not @RequestBody, so the scan
// misses them) becomes visible for multipart the same way it already was for JSON: `body:false` +
// a source document that documented a body wins, extending a shipped behavior rather than
// inventing one. Revalidated through MEDIA_TYPE_RE the same defensive way buildPerStatusResponses
// revalidates status keys below (the contract file is hand-editable JSON on disk -- S5);
// JSON_MEDIA_TYPE itself is excluded explicitly, so this loop cannot introduce a second
// "application/json" entry even from a hand-edited file.
//
// A real bug found by executing this against a multipart-only fixture, not by inspection: the
// `op.body === true/'unknown'` bare-JSON fallback below is a SCAN-driven guess for "we don't know
// this body's shape at all" -- but when `op.sourceRequestBody` is present, reconciliation already
// positively determined this operation's ONLY media type(s) from a real document, and none of them
// was `application/json`. Applying the guess on top of that positive fact would emit a second,
// contradicting "maybe it's also unconstrained JSON" entry the source document never declared --
// worse than the pre-A8 gap it extends, not a continuation of it. So the fallback is suppressed
// whenever real per-operation media-type information already exists, JSON or not.
function buildRequestBody(op) {
	const hasSourceMediaTypeInfo = op.sourceRequestBody && typeof op.sourceRequestBody === 'object' && !Array.isArray(op.sourceRequestBody);
	let body = null;
	if (op.requestBodySchema) {
		body = { required: op.requestBodyRequired === true, content: { [JSON_MEDIA_TYPE]: { schema: op.requestBodySchema } } };
	} else if (op.body === true && !hasSourceMediaTypeInfo) {
		body = { required: true, content: { [JSON_MEDIA_TYPE]: {} } };
	} else if (op.body === 'unknown' && !hasSourceMediaTypeInfo) {
		body = { content: { [JSON_MEDIA_TYPE]: {} } };
	}
	// op.body === false, or op.body true/'unknown' with real sourceRequestBody info taking
	// precedence over the scan-driven guess: body stays null here, filled in below if
	// sourceRequestBody has real content.

	const srcContent = hasSourceMediaTypeInfo ? op.sourceRequestBody.content : null;
	if (srcContent && typeof srcContent === 'object' && !Array.isArray(srcContent)) {
		for (const mt of Object.keys(srcContent)) {
			if (mt === JSON_MEDIA_TYPE || !MEDIA_TYPE_RE.test(mt)) continue;
			const entry = srcContent[mt];
			const mediaTypeObject = {};
			if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.schema && typeof entry.schema === 'object' && !Array.isArray(entry.schema)) {
				mediaTypeObject.schema = entry.schema;
			}
			if (!body) body = { content: {} };
			body.content[mt] = mediaTypeObject;
		}
		if (body && op.sourceRequestBody.required === true) body.required = true;
	}
	return body;
}

// A8: the per-status path -- returns null (never {}) when op.sourceResponses is absent OR,
// defensively, when nothing in it survives revalidation (reconciliation itself never produces an
// empty sourceResponses, see contracts/openapi.mjs's applyPerStatusResponses' anyEntry check; this
// branch only matters for a hand-edited contract file -- S5/persistence-integrity). Revalidated
// through RESPONSE_STATUS_KEY_RE/MEDIA_TYPE_RE the same defensive way buildRequestBody() revalidates
// media-type keys above -- this is the one place a status/media-type key becomes a real object key
// in the exported document, so it cannot simply trust what is already on disk. Presence of a
// non-null return here IS the seam buildResponses() below acts on: no other logic decides between
// the two paths.
function buildPerStatusResponses(op) {
	if (!op.sourceResponses || typeof op.sourceResponses !== 'object' || Array.isArray(op.sourceResponses)) return null;
	const responses = new Map();
	for (const key of Object.keys(op.sourceResponses)) {
		if (!RESPONSE_STATUS_KEY_RE.test(key)) continue;
		const entry = op.sourceResponses[key];
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
		// OpenAPI 3.1 requires `description` on every Response Object -- same rule the union path
		// below already follows, source-conditioned here: a real copied description if the source had
		// one, else a stand-in that describes the projection, never the API (same discipline
		// SUCCESS_RESPONSE_DESCRIPTION/ERROR_RESPONSE_DESCRIPTION already established).
		const responseObject = {
			description: typeof entry.description === 'string' && entry.description.length > 0
				? entry.description
				: PER_STATUS_NO_DESCRIPTION_STANDIN,
		};
		// Codex review (A8 follow-up): `schemaFrom` is re-checked against the ACTUAL status key it sits
		// under, not just trusted as a string -- the feature-contract schema's `enum` only constrains
		// schemaFrom to one of two values, never that the value agrees with its own status key. Real
		// reconciliation output can never disagree (contracts/openapi.mjs's applyPerStatusResponses only
		// ever sets 'response' under a SUCCESS_STATUS_RE key and 'error' under an ERROR_STATUS_RE/default
		// key), so this only matters for a hand-edited contract file -- S5/persistence-integrity, same
		// posture as the RESPONSE_STATUS_KEY_RE/MEDIA_TYPE_RE re-checks already in this function. A
		// mismatched claim (e.g. "response" under a 4xx key) falls through to the entry's own inline
		// `schema`/`mediaTypes` instead of exporting the wrong union under the wrong status.
		if (entry.schemaFrom === 'response' && SUCCESS_STATUS_RE.test(key) && op.responseSchema) {
			responseObject.content = { [JSON_MEDIA_TYPE]: { schema: op.responseSchema } };
		} else if (entry.schemaFrom === 'error' && (ERROR_STATUS_RE.test(key) || key === DEFAULT_STATUS_KEY) && op.errorSchema) {
			responseObject.content = { [JSON_MEDIA_TYPE]: { schema: op.errorSchema } };
		} else if (entry.schema && typeof entry.schema === 'object' && !Array.isArray(entry.schema)) {
			responseObject.content = { [JSON_MEDIA_TYPE]: { schema: entry.schema } };
		} else if (Array.isArray(entry.mediaTypes) && entry.mediaTypes.length > 0) {
			const content = {};
			for (const mt of entry.mediaTypes) {
				if (MEDIA_TYPE_RE.test(mt)) content[mt] = {};
			}
			if (Object.keys(content).length > 0) responseObject.content = content;
		}
		responses.set(key, responseObject);
	}
	return responses.size > 0 ? Object.fromEntries(responses) : null;
}

// `range` (default) uses `2XX`/`default`, both legal per the official 3.1 meta-schema's own
// `responses` patternProperties (`^[1-5](?:[0-9]{2}|XX)$` plus an explicit `default` property) --
// verified by executing that schema, not assumed. `literal` uses `200`/`default` for tooling that
// cannot handle range keys, at the cost of a stand-in the contract cannot back up. An operation
// with neither a response nor an error schema gets NO `responses` key at all: 3.1 does not require
// one (`$defs.operation` has no `required` array -- also verified by execution), and `responses: {}`
// is illegal anyway (`minProperties: 1`). Omitting is both legal and honest; guessing a status
// would be neither.
//
// A8: buildPerStatusResponses() above is tried FIRST -- when the contract carries the source
// document's own real per-status data for this operation, that is emitted verbatim instead of
// collapsing everything into the 2XX/default union below. The union path is otherwise completely
// unchanged.
function buildResponses(op, statusCodes) {
	const perStatus = buildPerStatusResponses(op);
	if (perStatus) return perStatus;

	const responses = new Map();
	if (op.responseSchema) {
		responses.set(statusCodes === 'literal' ? '200' : '2XX', {
			description: SUCCESS_RESPONSE_DESCRIPTION,
			content: { [JSON_MEDIA_TYPE]: { schema: op.responseSchema } },
		});
	}
	if (op.errorSchema) {
		responses.set('default', {
			description: ERROR_RESPONSE_DESCRIPTION,
			content: { [JSON_MEDIA_TYPE]: { schema: op.errorSchema } },
		});
	}
	return responses.size > 0 ? Object.fromEntries(responses) : null;
}

// The self-import guard's own key material. Byte-identical to what cmdContractEmit writes to disk
// (`JSON.stringify(contract, null, 2) + '\n'`), so this is the same value lib/gate-definitions.mjs's
// `contract.recompute()` computes as `contract_hash` via sha256File -- one number identifying
// exactly which contract state produced this document, not a second, parallel notion of identity.
// test/contract-export.test.mjs asserts that equality against a real emitted file rather than
// leaving it as a claim.
export function contractSha256(contract) {
	return createHash('sha256').update(`${JSON.stringify(contract, null, 2)}\n`).digest('hex');
}

// Candidate global path prefixes implied by a scan report's `path_prefix_signals` (A1 §7 --
// `configurePathMatch`/`context-path` carry a literal `prefix`, `paths-to-match` carries a
// `pattern` like `/api/v0/**`). A pattern of `/**` yields nothing (it is not narrower than the
// whole API and implies no prefix). PATH_PREFIX_RE is reused rather than re-derived so a signal
// value that isn't a clean segment path is skipped instead of guessed at.
export function pathPrefixCandidates(signals) {
	const out = new Set();
	for (const signal of signals ?? []) {
		if (typeof signal !== 'object' || signal === null) continue;
		let value = null;
		if (typeof signal.prefix === 'string') value = signal.prefix;
		else if (typeof signal.pattern === 'string') value = signal.pattern.replace(/\/\*+$/, '');
		if (typeof value !== 'string') continue;
		value = value.replace(/\/+$/, '');
		if (!PATH_PREFIX_RE.test(value)) continue;
		out.add(value);
	}
	return [...out].sort();
}

// A candidate is "unreflected" if ANY of the contract's own operation paths does not sit under it.
// Deliberately ANY, not ALL: a partially-reconciled contract (matched operations path-corrected,
// a `drift`/`missing` one left at its uncorrected scan path) is exactly the dangerous mixed case,
// and handing half-right paths to a client generator is no safer than handing wholly-wrong ones.
// Segment-boundary safe -- `/api/v0` never counts `/api/v0abc` as prefixed.
export function unreflectedPathPrefixes(contract, candidates) {
	const paths = Object.values(contract.operations).map((op) => String(op.path));
	return candidates.filter((prefix) => paths.some((p) => p !== prefix && !p.startsWith(`${prefix}/`)));
}

export function buildOpenApiDocument({ contract, snapshot = null, options = {} }) {
	const statusCodes = options.statusCodes ?? 'range';
	if (!STATUS_CODE_MODES.includes(statusCodes)) {
		return { ok: false, error: `unknown status-codes mode "${statusCodes}" -- expected one of: ${STATUS_CODE_MODES.join(', ')}` };
	}

	const operationIds = Object.keys(contract.operations);
	if (operationIds.length === 0) {
		return { ok: false, error: 'this contract has zero operations -- there is nothing to export' };
	}

	// A Map, never a plain object, for the same structural reason contracts/openapi.mjs indexes a
	// parsed document with Maps: these keys come from a JSON file that is hand-editable on disk.
	// (Every real path also starts with "/", which already rules out `__proto__`, but the Map makes
	// that a property of the data structure rather than of an assumption about the input.)
	const pathItems = new Map();
	const claimedRoutes = new Map();

	// A7: computed BEFORE the per-operation loop (unlike A6's original placement, after it) -- the
	// passthrough marker embedded on each operation below needs the contract's own content hash,
	// same key material contractSha256() has always produced.
	const sha256 = contractSha256(contract);
	// A7: tracks, per operationId, whether this export emitted AT LEAST ONE passthrough field for
	// it -- becomes generated.passthrough (machine-readable, always present) and the ONE stderr
	// note bin/bskel.mjs's cmdContractExport prints when coverage is genuinely mixed (see
	// D-openapi-passthrough: mixed coverage can only arise in an explicitly waived `partial`
	// contract -- a `complete` one has 100% coverage by construction).
	const passthroughByOperation = {};

	for (const operationId of operationIds) {
		const op = contract.operations[operationId];
		const route = String(op.path);
		if (!route.startsWith('/')) {
			return { ok: false, error: `operation "${operationId}" has path "${route}", which does not start with "/" -- an OpenAPI Paths Object key must (verified against the official 3.1 meta-schema)` };
		}
		const verb = String(op.verb).toLowerCase();
		if (!HTTP_VERBS.has(verb)) {
			return { ok: false, error: `operation "${operationId}" has verb "${op.verb}", which is not an HTTP method OpenAPI recognizes` };
		}

		const routeKey = `${verb} ${route}`;
		if (claimedRoutes.has(routeKey)) {
			return { ok: false, error: `operations "${claimedRoutes.get(routeKey)}" and "${operationId}" both map to ${op.verb} ${route} -- an OpenAPI path item holds at most one operation per verb, so this contract cannot be exported until the collision is resolved (it usually means one of the two kept an uncorrected scan path; re-run \`bskel contract emit --openapi-file ...\`)` };
		}
		claimedRoutes.set(routeKey, operationId);

		const operation = { operationId };
		const parameters = buildOperationParameters(op);
		if (parameters.length > 0) operation.parameters = parameters;
		const requestBody = buildRequestBody(op);
		if (requestBody) operation.requestBody = requestBody;
		const responses = buildResponses(op, statusCodes);
		if (responses) operation.responses = responses;
		// A7: `security`/`summary`/`tags` are emitted ONLY when the contract carries a copied
		// source* value for THIS operation -- i.e. a real source document (--openapi-file) stated one
		// for this exact operation. `security: []` is spec-legal (confirmed by executing the
		// meta-schema) AND, when copied, a genuine positive claim FROM THE SOURCE that no
		// authentication is required -- Array.isArray, not a truthy check, so `[]` is correctly
		// treated as present. `op.sourceSecurity` is never emitted when absent.
		if (Array.isArray(op.sourceSecurity)) operation.security = op.sourceSecurity;
		if (op.sourceSummary) operation.summary = op.sourceSummary;
		if (Array.isArray(op.sourceTags) && op.sourceTags.length > 0) operation.tags = op.sourceTags;
		// A10: same "only when the contract carries a copied value" discipline -- `sourceDescription`
		// is present only when `contract emit --descriptions` was used AND the source had one for this
		// exact operation, so this is never a synthesized or inferred string.
		if (op.sourceDescription) operation.description = op.sourceDescription;

		// A8: two more clauses -- an operation whose ONLY passthrough is per-status responses or a
		// copied multipart body (no source parameters/security/summary/tags at all) previously got NO
		// marker, reopening the exact self-import hole A7 closed for that one operation. Never arises
		// on the real oracle (148/148 already carry summary+tags+security) but is structurally
		// reachable from a minimal hand-written document declaring only `responses` -- see
		// D-openapi-per-status. A10 adds a third clause for the same reason: an operation whose ONLY
		// passthrough is a copied description (structurally reachable even though never arises on the
		// real oracle, which already carries summary/tags/security everywhere).
		const hasPassthrough = Boolean(
			(Array.isArray(op.sourceParameters) && op.sourceParameters.length > 0)
			|| Array.isArray(op.sourceSecurity)
			|| op.sourceSummary
			|| (Array.isArray(op.sourceTags) && op.sourceTags.length > 0)
			|| (op.sourceResponses && typeof op.sourceResponses === 'object' && Object.keys(op.sourceResponses).length > 0)
			|| (op.sourceRequestBody && typeof op.sourceRequestBody === 'object')
			|| op.sourceDescription,
		);
		passthroughByOperation[operationId] = hasPassthrough;
		if (hasPassthrough) {
			// A7: the self-import guard's SECOND key material -- see contracts/openapi.mjs's
			// hasBskelExportMarker(). Proportionate to how real a passthrough-heavy export now looks:
			// stripping only info.x-bskel-generated is no longer sufficient to disarm the guard for
			// any operation carrying this marker.
			operation[BSKEL_PASSTHROUGH_EXTENSION] = { source_sha256: sha256.slice(0, 12) };
		}

		if (!pathItems.has(route)) pathItems.set(route, new Map());
		pathItems.get(route).set(verb, operation);
	}

	const omissions = collectOmissions(contract);
	// A7: only schemes actually referenced by at least one copied sourceSecurity requirement --
	// contracts/openapi.mjs's applySecurity already guarantees this set is internally consistent
	// (every scheme name any emitted op.sourceSecurity references IS a key here), so no re-
	// verification is needed at export time -- never a dangling reference by construction.
	const securitySchemes = contract.sourceSecuritySchemes && typeof contract.sourceSecuritySchemes === 'object'
		? contract.sourceSecuritySchemes
		: null;
	const passthroughValues = Object.values(passthroughByOperation);
	const passthroughMixed = passthroughValues.some(Boolean) && passthroughValues.some((v) => !v);
	const passthroughWithoutCount = passthroughValues.filter((v) => !v).length;

	const generated = {
		feature_id: contract.feature_id,
		feature_uid: contract.feature_uid,
		sbf_contract: contract.sbf_contract,
		completeness: contract.completeness.status,
		contract_sha256: sha256,
		status_codes: statusCodes,
		exported_by: options.exportedBy ?? 'bskel',
		// A7: machine-readable per-operation coverage map -- disclosure, not a new refusal. A
		// `complete` contract has every value `true` by construction (see D-openapi-passthrough);
		// mixed values can only arise in an explicitly waived `partial` contract.
		passthrough: passthroughByOperation,
	};
	// Provenance only, and only when this feature actually reconciled against a real document --
	// says WHICH oracle the paths in here were corrected against, which is the first thing anyone
	// auditing an exported path wants to know.
	if (snapshot && snapshot.source && typeof snapshot.source === 'object') {
		generated.reconciled_against = {
			file: snapshot.source.file ?? null,
			sha256: snapshot.source.sha256 ?? null,
			outside_repo: snapshot.source.outside_repo === true,
		};
	}

	const document = {
		openapi: OPENAPI_TARGET_VERSION,
		info: {
			title: `${contract.feature_id} (bskel contract export)`,
			// OpenAPI requires `info.version` to be a string, and the contract carries no API
			// version. A 12-char prefix of the contract hash is a real content identifier (stable
			// across re-exports of the same contract, different the moment the contract changes)
			// rather than an invented semver that would read as a claim about the API's own
			// versioning. Explained in `description` so nobody mistakes it for one.
			version: sha256.slice(0, 12),
			description: renderDescription(contract, omissions, statusCodes),
			[BSKEL_GENERATED_EXTENSION]: generated,
			'x-bskel-omitted': omissions,
		},
		paths: Object.fromEntries([...pathItems].map(([route, verbs]) => [route, Object.fromEntries(verbs)])),
	};
	// A7: emitted in the document's own `components` section, restricted to schemes actually
	// referenced by at least one emitted operation's `security` -- never the document's full
	// catalog, and never a dangling reference (see the comment on `securitySchemes` above).
	if (securitySchemes && Object.keys(securitySchemes).length > 0) {
		document.components = { securitySchemes };
	}

	return {
		ok: true,
		document,
		omissions,
		contractSha256: sha256,
		statusCodes,
		// True when `literal` actually produced at least one stand-in `200` -- lets the CLI print
		// the stand-in warning ONCE, and only when it is actually relevant, rather than per
		// operation or unconditionally. A8: excludes an operation that took the per-status path --
		// its `200` (if any) is a copied real status key, never a bskel-chosen stand-in.
		literalStatusStandIn: statusCodes === 'literal' && Object.values(contract.operations).some((op) => {
			const hasPerStatus = op.sourceResponses && typeof op.sourceResponses === 'object' && Object.keys(op.sourceResponses).length > 0;
			return Boolean(op.responseSchema) && !hasPerStatus;
		}),
		// A7: lets cmdContractExport print its ONE mixed-coverage stderr note only when genuinely
		// warranted -- see D-openapi-passthrough.
		mixedPassthrough: passthroughMixed,
		passthroughWithoutCount,
	};
}
