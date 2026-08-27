// A1: reconciles a scan-derived module against a real OpenAPI document -- recovers operationIds
// the scanner's regex heuristics missed, and (its main purpose) corrects `path` for operations
// the scanner already matched, since a global path-prefix Spring config (e.g. `addPathPrefix` /
// `springdoc.paths-to-match`) is invisible to source-annotation scanning. See
// D-openapi-reconciliation in DECISIONS.md for the real Team-IZ-Backend defect this closes
// (every emitted contract's `path` was missing `/api/v0` -- verified by generating the real
// document and diffing).
//
// This module never looks at waivers (same discipline as contracts/emit.mjs) and never writes
// anything -- `loadOpenApiDocument` is the only place a file is read, and `reconcileModule` is
// pure. contracts/emit.mjs imports `selectModule`/`endpointKey` FROM here -- wait, the reverse:
// THIS module imports them FROM contracts/emit.mjs (never the other way), so "which module" and
// "which endpoint is which" are defined in exactly one place.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { endpointKey, BARE_UUID_PATTERN } from './emit.mjs';

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_PATHS = 5000;
const MAX_OPERATIONS = 10000;
const HTTP_METHODS = Object.freeze(new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']));

// A2: request-body JSON Schema projection. Real-data-measured against Team-IZ-Backend's actual
// OpenAPI document (308 components.schemas, 0 cycles, max $ref-chain depth 5, max structural
// depth reachable from a requestBody 8, max single-operation node count 23, longest real
// `pattern` 77 chars) -- every cap below carries multiple times that headroom, see
// D-openapi-request-schema in DECISIONS.md for the full measurement.
const MAX_COMPONENT_SCHEMAS = 5000;
const MAX_SCHEMA_DEPTH = 32; // every recursion level (structural AND $ref), not just $ref-chain depth
const MAX_SCHEMA_NODES = 2000; // shared counter per top-level inlineSchema() call, enum entries count
const MAX_PATTERN_LENGTH = 300; // real max observed: 77
const JSON_MEDIA_TYPE = 'application/json';
const SCHEMA_REF_PREFIX = '#/components/schemas/';

// A3: response/error JSON Schema projection. Reuses every inlineSchema() defense above
// unchanged (keyword/format whitelist, MAX_SCHEMA_DEPTH/NODES/PATTERN_LENGTH) -- measured by
// running inlineSchema() itself over all 634 real response/error schema roots in Team-IZ-
// Backend's document at the current caps: 634/634 resolved, zero failures, max depth 14 (2.3x
// headroom), max single-schema node count 231 (8.7x headroom). The one genuinely new risk A3
// introduces is fan-out: A2 resolved at most 1 schema per operation (a request body), but a
// response/error side can have many documented statuses -- MAX_RESPONSES_PER_OPERATION bounds
// that (real max observed: 9). See D-openapi-response-schema in DECISIONS.md.
const MAX_RESPONSES_PER_OPERATION = 64;
// A7: source-backed passthrough caps, same "generous multiple of the real observed max" style as
// every cap above. Measured against the real Team-IZ-Backend oracle: max 9 parameters on one
// operation, max 1 security requirement per operation, exactly 1 security scheme document-wide.
const MAX_PARAMETERS_PER_OPERATION = 64;
const MAX_SECURITY_REQUIREMENTS_PER_OPERATION = 32;
const MAX_SECURITY_SCHEMES = 64;
// A8: per-status responses / non-JSON request media types. No new cap for per-status responses --
// MAX_RESPONSES_PER_OPERATION above already bounds the same `responses` map (real max observed:
// 9). MAX_REQUEST_MEDIA_TYPES is new: real max observed on one operation's requestBody.content is
// 1 (always either application/json alone or multipart/form-data alone in the oracle).
const MAX_REQUEST_MEDIA_TYPES = 16;
// A10: operation-level `description`, same "generous multiple of the real observed max" style as
// every cap above -- real max observed on the Team-IZ-Backend oracle (148 operations, 146 carry a
// non-empty description) is 9,083 (`.length`, UTF-16 code units, same measure MAX_PATTERN_LENGTH
// already uses -- NOT a UTF-8 byte count, which runs higher for this oracle's real multi-byte
// Korean text: 13,758 bytes for the same longest description).
const MAX_DESCRIPTION_LENGTH = 40000;
// A11: a FIELD-level `example` value, inside a schema this whole file resolves -- unlike
// MAX_DESCRIPTION_LENGTH's single operation-level string, `example` is an arbitrary JSON value
// (string/number/array/object all occur for real, see D-openapi-field-docs), so the cap applies to
// its serialized (`JSON.stringify(value).length`) size, not `.length` directly. Real max observed
// on the oracle: 70. A generously round bound, not a tight multiple, since a legitimately useful
// example (e.g. a full sample response object) could reasonably run longer than any single real
// value happened to here.
const MAX_EXAMPLE_LENGTH = 2000;
// A6 (D-openapi-export): widened from `/^2[0-9]{2}$/` and `/^[45][0-9]{2}$/` to also accept
// OpenAPI's own RANGE keys. These are ordinary in real hand-written documents and legal per the
// official 3.1 meta-schema, whose `responses` object accepts exactly `^[1-5](?:[0-9]{2}|XX)$` plus
// `default` -- confirmed by executing the real 2022-10-07 schema, not by reading prose about it.
// Before this widening a document written with `2XX`/`4XX` silently lost every response and error
// schema: `projectResponseSchemas` simply never matched the status key, and "no matching status"
// is (correctly) not a failure, so the loss produced no warning anywhere. This is a general
// importer capability gain, not round-trip plumbing -- it is what makes such a document readable
// by `contract emit --openapi-file` at all.
// Exported (not just module-local) so contracts/export.mjs can re-check a hand-edited contract's
// `schemaFrom` claim against the ACTUAL status key it sits under, instead of trusting the string --
// same S5/persistence-integrity "never trust the on-disk contract file" posture RESPONSE_STATUS_KEY_RE/
// MEDIA_TYPE_RE already follow (Codex review finding, A8 follow-up: a hand-edited
// `sourceResponses["400"].schemaFrom:"response"` passed schema validation and exported `responseSchema`
// under HTTP 400 -- the schema's `enum` on schemaFrom checks the value is one of two strings, never that
// it agrees with the status key it's attached to).
export const SUCCESS_STATUS_RE = /^2(?:[0-9]{2}|XX)$/;
export const ERROR_STATUS_RE = /^[45](?:[0-9]{2}|XX)$/;
export const DEFAULT_STATUS_KEY = 'default';

// Same shape convention as the rest of contracts/ -- operationId becomes an object key
// downstream (contracts/emit.mjs's `operations[operationId]`), so it's whitelisted before it's
// trusted anywhere. Deliberately excludes a leading `_` (so `__proto__` fails on the first
// character alone); `constructor`/`toString` DO match this shape, but every index in this module
// is a `Map` (never a plain object), so there is no lookup path where that resolves to an
// inherited property -- see D-security-1 in DECISIONS.md for the equivalent concern this
// mirrors, and bin/bskel.mjs's cmdContractToolSchema fix (Object.hasOwn) for the one place a
// contract's operations DO become plain-object keys downstream of this module.
export const OPERATION_ID_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,199}$/;

// A path-prefix candidate must look like one or more clean path segments -- rules out `{}`
// (template params leaking into a "prefix"), empty segments (`//`), and anything that isn't a
// plain path string. Used both for prefix inference (a delta must match this to be trusted) and
// to validate an explicit `--path-prefix` value.
export const PATH_PREFIX_RE = /^(?:\/[A-Za-z0-9._~%-]+)+$/;

// A2: same whitelist-not-denylist reasoning as OPERATION_ID_RE above, applied to two new classes
// of externally-influenceable string this module now handles: OpenAPI component-schema names
// (`components.schemas.<name>`, e.g. "CreateOrganizationRequest") and, inside a resolved schema,
// its `properties` keys / `required[]` entries (e.g. "dataRetentionDays"). Both become object
// keys downstream -- inlineSchema()'s output `properties` is a plain object built with
// `out.properties[k] = ...`, so a `k` of "__proto__" from JSON.parse'd input would hit
// Object.prototype's `__proto__` setter instead of adding a property. The leading-letter
// requirement kills `__proto__` on the first character alone, same as OPERATION_ID_RE; measured
// against all 308 real Team-IZ-Backend component-schema names with zero rejections.
export const COMPONENT_SCHEMA_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,199}$/;
export const SCHEMA_PROPERTY_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

// A8: an OpenAPI response-object status key becomes an object key downstream, in both this
// contract's sourceResponses and the exported document's responses -- same prototype-pollution
// class OPERATION_ID_RE/COMPONENT_SCHEMA_NAME_RE guard against. A real status key is a literal
// 3-digit code (100-599), a range key (1XX-5XX), or the literal "default" -- nothing else is a
// legal OpenAPI response status, so anything else is DROPPED (not a failure), mirroring
// indexOpenApiDocument()'s own "malformed entry, safe to skip" posture.
export const RESPONSE_STATUS_KEY_RE = /^(?:[1-5](?:[0-9]{2}|XX)|default)$/;
// A8: a media-type key becomes an object key downstream too (sourceRequestBody, a per-status
// entry's mediaTypes disclosure, and the exported document itself). A real media type always
// contains a '/' (type/subtype per RFC 6838) -- that requirement alone structurally excludes
// '__proto__'/'constructor'/'toString', the same defense COMPONENT_SCHEMA_NAME_RE's leading-letter
// requirement provides one layer down.
export const MEDIA_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

// A8: the exact stand-in text contracts/export.mjs writes into a per-status Response Object when
// the source had no description of its own (OpenAPI 3.1 requires one on every Response Object).
// Declared here, the READING side, for the identical "writer and reader cannot drift apart" reason
// BSKEL_GENERATED_EXTENSION/BSKEL_PASSTHROUGH_EXTENSION are -- applyPerStatusResponses() below must
// recognize and skip this exact string on import, or round-tripping an export whose source had no
// real description would silently launder synthetic filler text into a real contract field,
// breaking the "export -> re-import reproduces operations exactly" invariant A6/A7 already
// established. (The pre-A8 union path's own two stand-in descriptions never needed this defense --
// nothing on the import side ever reads a response object's `description`, only its `content`
// schema; this field is the first to read description back in, which is what introduces the
// hazard.)
export const PER_STATUS_NO_DESCRIPTION_STANDIN = 'The source document documents this status for this operation but gives no description.';

// inlineSchema()'s keyword policy: RECURSED keywords are walked into; ASSERTION keywords are
// copied verbatim (their values are scalars/arrays of scalars, not schema nodes -- nothing to
// recurse); DOCUMENTATION keywords (A11) are copied verbatim ONLY when opted in
// (`includeFieldDocs`), dropped otherwise -- unlike an ASSERTION keyword, dropping one never
// changes what a schema VALIDATES, only how well-documented it is, so there is no fail-closed
// concern either way; DROPPED keywords carry no validation meaning AND have zero real occurrences
// on the oracle (measured, not assumed -- see D-openapi-field-docs), so they are unconditionally
// discarded regardless of any flag; anything else fails that schema closed. The FORMAT set is
// checked separately (see inlineSchema's format handling) since `uuid` gets rewritten rather than
// either copied or dropped. A missing-and-therefore-fail-closed keyword is deliberate: silently
// dropping an assertion (e.g. an unrecognized `pattern`-like keyword) would emit a schema WEAKER
// than the real one, which is worse than emitting no schema at all -- see
// D-openapi-request-schema in DECISIONS.md.
const RECURSED_KEYWORDS = Object.freeze(new Set(['properties', 'items', 'additionalProperties', 'oneOf', 'anyOf', 'allOf']));
// A7: `default` added -- annotation-only per 2020-12 (Ajv runs with useDefaults off here, so it's
// inert for validation either way), but a real, human-authored fact from the source document worth
// carrying through regardless. Measured across every real request-body and response schema in the
// oracle: 0 contain `default` anywhere, so this addition provably changes zero bytes of A2/A3
// output on real data -- the only place it actually fires is parameter schemas (22/253 real
// parameters use it directly, another 9 via a `$ref`-sibling, see the $ref handling below).
const COPIED_KEYWORDS = Object.freeze(new Set([
	'type', 'enum', 'const', 'required', 'default',
	'minLength', 'maxLength',
	'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
	'minItems', 'maxItems', 'uniqueItems',
	'minProperties', 'maxProperties',
]));
// A11 (D-openapi-field-docs): `description`/`example` measured real and heavily used at the FIELD
// level (3,982 / 2,077 occurrences across the oracle's request/response/parameter schemas,
// 520,527 / 32,708 real bytes) -- moved out of DROPPED_KEYWORDS into their own conditionally-
// copied set. `title`/`examples`(plural)/`externalDocs`/`xml`/`deprecated` stay unconditionally
// dropped: 0 real occurrences for every one of them (measured, not assumed), so building any
// copy path for them would violate this project's own "don't build for zero real cases"
// discipline -- named here, not built, a permanent gap like A8's `non-json-response-schemas`/
// `response-headers`.
const DOCUMENTATION_KEYWORDS = Object.freeze(new Set(['description', 'example']));
const DROPPED_KEYWORDS = Object.freeze(new Set(['title', 'examples', 'externalDocs', 'xml', 'deprecated']));

// D-unsupported-annotation-warning: 0 real occurrences on the ONE oracle this whole module's
// caps/keyword sets were measured against does not mean 0 occurrences everywhere -- a genuinely
// different real-world document could use any of DROPPED_KEYWORDS, and silently dropping them
// with no signal at all is a real honesty gap (see D-contract-history/D-gate-export's own backlog
// for the broader "self-identified weaknesses" context this closes one instance of).
//
// Deliberately walks ONLY genuine Schema Object structure (via RECURSED_KEYWORDS, the exact same
// `properties`/`items`/`additionalProperties`/`oneOf`/`anyOf`/`allOf` set inlineSchema() itself
// recurses through) -- NOT a blanket "every key anywhere in the document" scan. That distinction
// is load-bearing, not cosmetic: several of DROPPED_KEYWORDS' names collide with REAL, unrelated
// OpenAPI concepts that live outside a Schema Object entirely -- an Operation Object's own
// `deprecated` (marks a whole ENDPOINT deprecated) and a Parameter Object's own `deprecated`, both
// legitimate 3.1 fields with nothing to do with inlineSchema()'s keyword handling. A blanket walk
// would misreport those as "an unsupported schema keyword found," which is false. This function
// only descends from confirmed schema roots (a `$ref`-or-inline `schema` under `content.<media>`
// or `parameters[].schema`, or a named entry in `components.schemas`), the same roots
// inlineSchema() itself is ever called on.
//
// NOT routed through walkSchemaNode()'s fail-closed machinery -- it must never throw on a shape
// inlineSchema() itself would reject, since its only job is presence detection, not validation.
// Bounded for free by loadOpenApiDocument()'s own MAX_DOCUMENT_BYTES check upstream.
function collectUnsupportedAnnotationKeys(node, found, seen) {
	if (node === null || typeof node !== 'object' || Array.isArray(node) || seen.has(node)) return;
	seen.add(node);
	for (const key of Object.keys(node)) {
		if (DROPPED_KEYWORDS.has(key)) found.add(key);
		if (RECURSED_KEYWORDS.has(key)) {
			const value = node[key];
			// `properties` is a field-NAME -> schema map (its VALUES are schemas, its keys are not
			// schema keywords at all) -- a real bug caught live before merge: recursing into the
			// map object itself, instead of `Object.values(value)`, silently walked past every
			// property's actual schema and found nothing beneath `properties` ever. `items`/
			// `additionalProperties` ARE schemas directly; `oneOf`/`anyOf`/`allOf` are arrays of
			// schemas, already handled by the branch below.
			if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
				for (const propSchema of Object.values(value)) collectUnsupportedAnnotationKeys(propSchema, found, seen);
			} else if (Array.isArray(value)) {
				for (const item of value) collectUnsupportedAnnotationKeys(item, found, seen);
			} else {
				collectUnsupportedAnnotationKeys(value, found, seen);
			}
		}
	}
}

function collectSchemaRootsFromMediaTypes(content, roots) {
	if (!content || typeof content !== 'object' || Array.isArray(content)) return;
	for (const mediaEntry of Object.values(content)) {
		const schema = mediaEntry && typeof mediaEntry === 'object' && !Array.isArray(mediaEntry) ? mediaEntry.schema : null;
		if (schema && typeof schema === 'object' && !Array.isArray(schema)) roots.push(schema);
	}
}

// Every real schema root a document can offer `inlineSchema()`: named `components.schemas`
// entries, every operation's requestBody/response content schemas, and every operation's
// parameter schemas -- deliberately NOT `info`/`servers`/`tags`/security schemes, none of which
// are ever schema-shaped.
export function findUnsupportedAnnotations(doc) {
	const roots = [];
	const schemas = doc.components?.schemas;
	if (schemas && typeof schemas === 'object' && !Array.isArray(schemas)) roots.push(...Object.values(schemas));

	const paths = doc.paths;
	if (paths && typeof paths === 'object' && !Array.isArray(paths)) {
		for (const item of Object.values(paths)) {
			if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
			for (const [verbOrKey, operation] of Object.entries(item)) {
				if (!HTTP_METHODS.has(verbOrKey) || !operation || typeof operation !== 'object' || Array.isArray(operation)) continue;
				collectSchemaRootsFromMediaTypes(operation.requestBody?.content, roots);
				if (operation.responses && typeof operation.responses === 'object' && !Array.isArray(operation.responses)) {
					for (const resp of Object.values(operation.responses)) {
						collectSchemaRootsFromMediaTypes(resp?.content, roots);
					}
				}
				if (Array.isArray(operation.parameters)) {
					for (const p of operation.parameters) {
						if (p && typeof p === 'object' && !Array.isArray(p) && p.schema && typeof p.schema === 'object' && !Array.isArray(p.schema)) {
							roots.push(p.schema);
						}
					}
				}
			}
		}
	}

	const found = new Set();
	const seen = new Set();
	for (const root of roots) collectUnsupportedAnnotationKeys(root, found, seen);
	return [...found].sort();
}
// Real Team-IZ-Backend format-value histogram (request-body-reachable schemas only): uuid(20),
// int32(10), email(7), date(10), date-time(3), int64(2). `uuid` is handled separately (rewritten
// to BARE_UUID_PATTERN, see inlineSchema) -- not in this set, since it never survives as `format`.
const SAFE_FORMATS = Object.freeze(new Set(['int32', 'int64', 'email', 'date', 'date-time', 'double', 'float', 'binary', 'uri']));

// Thrown internally by inlineSchema()'s recursive walk and caught exactly once at the exported
// boundary -- with 12+ distinct failure points, threading {ok:false} through every return would
// bury the actual walking logic. The "never throws across the module boundary" invariant
// (loadOpenApiDocument's own comment) is about the EXPORTED function, which this preserves.
class InlineFailure extends Error {
	constructor(reason) {
		super(reason);
		this.reason = reason;
	}
}

// A6 (D-openapi-export): the `info` extension `bskel contract export` stamps on every document it
// writes. Declared HERE, on the reading side, because the guard below is the load-bearing consumer
// -- contracts/export.mjs imports this constant rather than spelling the key a second time, so the
// writer and the reader cannot drift apart and silently disarm the guard.
export const BSKEL_GENERATED_EXTENSION = 'x-bskel-generated';

// A7: a SECOND, per-operation marker. A passthrough-heavy export (real query/header parameters, a
// real bearer-auth requirement, real summaries/tags) reads much closer to the source oracle
// document than A6's original thin projection did, so the documented escape hatch (stripping
// `info.x-bskel-generated`) needs to get harder to trigger by accident, proportionate to how real
// the export now looks. Declared here, alongside BSKEL_GENERATED_EXTENSION, for the identical
// "writer and reader cannot drift apart" reason -- contracts/export.mjs imports both.
export const BSKEL_PASSTHROUGH_EXTENSION = 'x-bskel-passthrough';

export function hasBskelExportMarker(doc) {
	const info = doc?.info;
	if (typeof info === 'object' && info !== null && !Array.isArray(info) && Object.hasOwn(info, BSKEL_GENERATED_EXTENSION)) {
		return true;
	}
	// A7: OR any operation carries the passthrough marker -- closes the exact gap a passthrough-
	// heavy export would otherwise leave: stripping only `info.x-bskel-generated` used to be
	// sufficient to disarm the guard for ANY export; now it is only sufficient for one that carries
	// no copied parameters/security/summary/tags at all.
	const paths = doc?.paths;
	if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) return false;
	for (const pathItem of Object.values(paths)) {
		if (typeof pathItem !== 'object' || pathItem === null || Array.isArray(pathItem)) continue;
		for (const [methodKey, operation] of Object.entries(pathItem)) {
			if (!HTTP_METHODS.has(methodKey.toLowerCase())) continue; // skip 'parameters'/'summary'/etc path-item-level keys
			if (operation && typeof operation === 'object' && !Array.isArray(operation) && Object.hasOwn(operation, BSKEL_PASSTHROUGH_EXTENSION)) {
				return true;
			}
		}
	}
	return false;
}

export function normalizeRoute(routePath) {
	let normalized = routePath.replace(/\/{2,}/g, '/');
	if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
	return normalized;
}

// Reads and parses exactly once. Every failure mode returns {ok:false, error}, never throws --
// this is the one function in the module that touches the filesystem, so it's the one place that
// has to be defensive about a file that's huge, unreadable, not JSON, or JSON-but-not-an-object.
export function loadOpenApiDocument(filePath) {
	let stat;
	try {
		stat = fs.statSync(filePath);
	} catch (err) {
		return { ok: false, error: `could not read "${filePath}": ${err.message}` };
	}
	if (!stat.isFile()) {
		return { ok: false, error: `"${filePath}" is not a regular file` };
	}
	if (stat.size > MAX_DOCUMENT_BYTES) {
		return { ok: false, error: `"${filePath}" is ${stat.size} bytes, exceeds the ${MAX_DOCUMENT_BYTES}-byte limit for an OpenAPI document` };
	}
	let raw;
	try {
		raw = fs.readFileSync(filePath, 'utf8');
	} catch (err) {
		return { ok: false, error: `could not read "${filePath}": ${err.message}` };
	}
	let doc;
	try {
		doc = JSON.parse(raw);
	} catch (err) {
		return { ok: false, error: `could not parse "${filePath}" as JSON: ${err.message}` };
	}
	if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
		return { ok: false, error: `"${filePath}" does not contain a JSON object at its root` };
	}
	const hash = createHash('sha256').update(raw).digest('hex');
	return { ok: true, doc, hash, bytes: stat.size };
}

// Builds two Maps (never plain objects -- see OPERATION_ID_RE's comment) from `doc.paths`:
// byOperationId (one entry per distinct valid operationId, first occurrence wins) and byRoute
// (keyed "VERB normalizedPath", value is an array -- more than one entry means the normalized
// route is ambiguous even within the document itself). `$ref` path items are skipped, not
// resolved (out of scope for this vertical slice -- see DECISIONS.md).
//
// A2: also builds `componentSchemas` (Map<name, schemaNode>, from `doc.components.schemas`) and
// retains each operation's raw `requestBody` node on its `entry` -- both were previously
// discarded entirely (A1 only needed {verb, path, operationId}). Indexing stays O(top-level
// count) here; deep walking into a schema's own `properties`/`$ref` chain happens lazily, only
// for the operations reconcileModule() actually needs a request-body schema for (see
// inlineSchema below) -- resolution cost doesn't scale with the size of the whole document.
export function indexOpenApiDocument(doc) {
	const byOperationId = new Map();
	const byRoute = new Map();
	const componentSchemas = new Map();
	// A7: Map<name, schemeNode> from doc.components.securitySchemes -- same "Map, never a plain
	// object" reasoning as componentSchemas above, same COMPONENT_SCHEMA_NAME_RE whitelist (a
	// security scheme name becomes an object key downstream, in the contract's own root-level
	// sourceSecuritySchemes).
	const securitySchemes = new Map();
	const stats = {
		path_count: 0, operation_count: 0, skipped_path_refs: 0, rejected_operation_ids: 0,
		component_schema_count: 0, rejected_component_schemas: 0,
		security_scheme_count: 0, rejected_security_schemes: 0,
	};

	const openapiVersion = typeof doc.openapi === 'string' ? doc.openapi : null;
	const schemaDialectSupported = typeof openapiVersion === 'string' && /^3\.1(?:\.|$)/.test(openapiVersion);

	const rawComponents = doc.components && typeof doc.components === 'object' && !Array.isArray(doc.components)
		? doc.components
		: null;
	const rawComponentSchemas = rawComponents ? rawComponents.schemas : null;
	if (rawComponentSchemas && typeof rawComponentSchemas === 'object' && !Array.isArray(rawComponentSchemas)) {
		const schemaNames = Object.keys(rawComponentSchemas);
		if (schemaNames.length > MAX_COMPONENT_SCHEMAS) {
			return { ok: false, error: `OpenAPI document has ${schemaNames.length} component schemas, exceeds the ${MAX_COMPONENT_SCHEMAS}-schema limit` };
		}
		for (const name of schemaNames) {
			const value = rawComponentSchemas[name];
			if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
			if (!COMPONENT_SCHEMA_NAME_RE.test(name)) { stats.rejected_component_schemas++; continue; }
			componentSchemas.set(name, value);
		}
		stats.component_schema_count = componentSchemas.size;
	}

	const rawSecuritySchemes = rawComponents ? rawComponents.securitySchemes : null;
	if (rawSecuritySchemes && typeof rawSecuritySchemes === 'object' && !Array.isArray(rawSecuritySchemes)) {
		const schemeNames = Object.keys(rawSecuritySchemes);
		if (schemeNames.length > MAX_SECURITY_SCHEMES) {
			return { ok: false, error: `OpenAPI document has ${schemeNames.length} security schemes, exceeds the ${MAX_SECURITY_SCHEMES}-scheme limit` };
		}
		for (const name of schemeNames) {
			const value = rawSecuritySchemes[name];
			if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
			if (!COMPONENT_SCHEMA_NAME_RE.test(name)) { stats.rejected_security_schemes++; continue; }
			securitySchemes.set(name, value);
		}
		stats.security_scheme_count = securitySchemes.size;
	}

	const paths = doc.paths;
	if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) {
		return { ok: true, byOperationId, byRoute, componentSchemas, securitySchemes, stats, servers: [], openapiVersion, schemaDialectSupported };
	}

	const pathKeys = Object.keys(paths);
	if (pathKeys.length > MAX_PATHS) {
		return { ok: false, error: `OpenAPI document has ${pathKeys.length} paths, exceeds the ${MAX_PATHS}-path limit` };
	}

	for (const routeKey of pathKeys) {
		if (typeof routeKey !== 'string' || !routeKey.startsWith('/')) continue;
		const pathItem = paths[routeKey];
		if (typeof pathItem !== 'object' || pathItem === null || Array.isArray(pathItem)) continue;
		if (Object.hasOwn(pathItem, '$ref')) {
			stats.skipped_path_refs++;
			continue;
		}
		stats.path_count++;
		const normalizedRoute = normalizeRoute(routeKey);

		for (const methodKey of Object.keys(pathItem)) {
			const verbLower = methodKey.toLowerCase();
			if (!HTTP_METHODS.has(verbLower)) continue;
			const operation = pathItem[methodKey];
			if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) continue;

			if (stats.operation_count >= MAX_OPERATIONS) {
				return { ok: false, error: `OpenAPI document has more than ${MAX_OPERATIONS} operations` };
			}
			stats.operation_count++;

			const verb = verbLower.toUpperCase();
			const rawOperationId = operation.operationId;
			let operationId = null;
			if (typeof rawOperationId === 'string') {
				if (OPERATION_ID_RE.test(rawOperationId)) {
					operationId = rawOperationId;
				} else {
					stats.rejected_operation_ids++;
				}
			}

			// A2: raw requestBody node retained verbatim (bounded by the document's own
			// MAX_DOCUMENT_BYTES cap -- no new read, no new size limit needed). A `$ref` requestBody
			// (`#/components/requestBodies/*`) is out of scope -- reconcileModule treats it as "no
			// body to project" rather than resolving it, same as a genuinely bodyless operation.
			const requestBody = typeof operation.requestBody === 'object' && operation.requestBody !== null && !Array.isArray(operation.requestBody)
				? operation.requestBody
				: null;
			// A3: raw responses map retained verbatim, same "no new read, no new size cap" reasoning
			// as requestBody above -- bounded by MAX_DOCUMENT_BYTES already.
			const responses = typeof operation.responses === 'object' && operation.responses !== null && !Array.isArray(operation.responses)
				? operation.responses
				: null;
			// A7: raw parameters/security/summary/tags retained verbatim, same "no new read, no new
			// size cap" reasoning as requestBody/responses above. `security` is deliberately
			// Array.isArray-checked rather than truthy-checked -- a real, explicit `[]` (11/148 real
			// operations) must be preserved as-is, not collapsed into "absent" the way a falsy check
			// would (an empty array is truthy in JS, so this already works, but the explicit
			// Array.isArray guard is what actually decides "present" vs "absent/malformed").
			const parameters = Array.isArray(operation.parameters) ? operation.parameters : null;
			const security = Array.isArray(operation.security) ? operation.security : null;
			const summary = typeof operation.summary === 'string' ? operation.summary : null;
			const tags = Array.isArray(operation.tags) ? operation.tags : null;
			// A10: same "raw, no size cap at index time" reasoning as summary above -- MAX_DESCRIPTION_
			// LENGTH is enforced only at applyDescription() (the point of actually copying it into the
			// contract), matching where every other length/count cap in this file is enforced.
			const description = typeof operation.description === 'string' ? operation.description : null;
			const entry = { verb, path: routeKey, operationId, requestBody, responses, parameters, security, summary, tags, description };

			const routeMatchKey = `${verb} ${normalizedRoute}`;
			const existingRoute = byRoute.get(routeMatchKey);
			if (existingRoute) existingRoute.push(entry); else byRoute.set(routeMatchKey, [entry]);

			// "First occurrence wins" -- same convention as contracts/emit.mjs's own
			// CONTRACT_DUPLICATE_OPERATION_ID handling for scan-side duplicates.
			if (operationId && !byOperationId.has(operationId)) {
				byOperationId.set(operationId, entry);
			}
		}
	}

	const servers = Array.isArray(doc.servers)
		? doc.servers.filter((s) => s && typeof s.url === 'string').map((s) => s.url)
		: [];

	return { ok: true, byOperationId, byRoute, componentSchemas, securitySchemes, stats, servers, openapiVersion, schemaDialectSupported };
}

// `S` (scan path) always starts with "/" (scanners/adapters/java-spring.mjs's joinPath guarantees
// this), so `O.endsWith(S)` alone would risk a false match at a non-segment boundary (e.g. "/api/
// v0/suborganizations".endsWith("/organizations")); requiring the remainder to itself look like a
// clean prefix (PATH_PREFIX_RE, which requires each segment to start with "/") makes that
// impossible -- a match can only occur at an actual "/" boundary between candidate segments.
function computeDelta(scanPath, docPath) {
	if (docPath === scanPath) return '';
	if (docPath.endsWith(scanPath)) {
		const candidate = docPath.slice(0, docPath.length - scanPath.length);
		if (PATH_PREFIX_RE.test(candidate)) return candidate;
	}
	return null;
}

// anchorDeltas: an array of delta strings, ONE PER ANCHOR (duplicates expected and meaningful --
// the tally becomes the snapshot's `path_prefix.deltas` for audit). A single distinct delta
// confirms the prefix; zero or conflicting deltas both leave path correction of ALREADY-matched
// operations unaffected (that never needed a prefix -- see reconcileModule) and only disable
// recovery of unmatched endpoints, which is the less valuable half of this feature.
export function inferPathPrefix(anchorDeltas) {
	const counts = new Map();
	for (const d of anchorDeltas) counts.set(d, (counts.get(d) ?? 0) + 1);
	const uniqueDeltas = [...counts.keys()];
	const deltas = Object.fromEntries(counts);
	if (uniqueDeltas.length === 0) return { value: null, origin: 'none', deltas, conflicting: [] };
	if (uniqueDeltas.length === 1) return { value: uniqueDeltas[0], origin: 'inferred', deltas, conflicting: [] };
	return { value: null, origin: 'none', deltas, conflicting: uniqueDeltas };
}

// A2: dereferences `node` (a schema fragment from a requestBody's application/json content) into
// a single self-contained JSON Schema tree with NO `$ref` anywhere in the output. Pure, and NEVER
// throws across this exported boundary (InlineFailure is caught here, anything else re-thrown --
// it would be a real programming bug, not an untrusted-input failure, and must not be swallowed).
// Full inlining (never registering a component with ajv by $id) for two independent reasons: ajv
// would otherwise need every one of a document's component schemas registered just to validate
// ONE operation's body, and bin/bskel.mjs's cmdContractToolSchema promises its `input_schema`
// output is a JSON Schema subset "directly usable as-is" for Anthropic tool-use -- no $ref/$defs
// is exactly what that promise requires; this function is what upholds it.
export function inlineSchema(node, componentSchemas, opts = {}) {
	const limits = {
		maxDepth: opts.maxDepth ?? MAX_SCHEMA_DEPTH,
		maxNodes: opts.maxNodes ?? MAX_SCHEMA_NODES,
		maxPatternLength: opts.maxPatternLength ?? MAX_PATTERN_LENGTH,
		// A11: opt-in only (default false, matching every prior call site's existing behavior
		// byte-for-byte when the caller doesn't pass it) -- see D-openapi-field-docs.
		includeFieldDocs: opts.includeFieldDocs ?? false,
	};
	const state = { nodes: 0 };
	try {
		const schema = walkSchemaNode(node, componentSchemas, 0, new Set(), state, limits);
		return { ok: true, schema, nodes: state.nodes };
	} catch (err) {
		if (err instanceof InlineFailure) return { ok: false, reason: err.reason };
		throw err;
	}
}

function fail(reason) {
	throw new InlineFailure(reason);
}

function walkSchemaNode(node, componentSchemas, depth, visiting, state, limits) {
	if (typeof node !== 'object' || node === null || Array.isArray(node)) fail('not-a-schema-object');
	if (depth > limits.maxDepth) fail('max-depth-exceeded');
	state.nodes++;
	if (state.nodes > limits.maxNodes) fail('too-many-nodes');

	if (Object.hasOwn(node, '$ref')) {
		// 2020-12 permits siblings alongside $ref (unlike OpenAPI 3.0's restriction), but this
		// module doesn't attempt to MERGE $ref with a sibling assertion, with ONE exception (A7):
		// `default` is a real, human-authored override worth carrying through (the exact real shape
		// `{"$ref": ".../ProjectListSort", "default": "READINESS"}` -- a $ref-typed parameter
		// schema with its own default value, 9 real occurrences). A DROPPED_KEYWORDS or
		// DOCUMENTATION_KEYWORDS sibling (e.g. a documentation-only `description`) is harmless and
		// ignored -- NOT merged onto the resolved schema even when includeFieldDocs is on (A11: 0
		// real occurrences of a $ref carrying a sibling description/example, measured directly, so
		// there is no real case to build merge semantics for, unlike `default`'s 9); anything else
		// would need merge semantics this vertical slice doesn't implement, so it fails closed.
		const siblingKeys = Object.keys(node).filter((k) => k !== '$ref');
		if (siblingKeys.some((k) => !DROPPED_KEYWORDS.has(k) && !DOCUMENTATION_KEYWORDS.has(k) && k !== 'default')) fail('ref-with-siblings');
		const ref = node['$ref'];
		if (typeof ref !== 'string' || !ref.startsWith(SCHEMA_REF_PREFIX)) fail('unsupported-ref');
		const name = ref.slice(SCHEMA_REF_PREFIX.length);
		// JSON-Pointer escapes (~0/~1) or percent-encoding in the name are never produced by
		// springdoc for a plain component name -- reject rather than decode-and-guess.
		if (name.includes('~') || name.includes('%') || !COMPONENT_SCHEMA_NAME_RE.test(name)) fail('unsupported-ref');
		if (visiting.has(name)) fail('cycle-detected');
		const target = componentSchemas.get(name);
		if (!target) fail('component-not-found');
		visiting.add(name);
		let resolved;
		try {
			resolved = walkSchemaNode(target, componentSchemas, depth + 1, visiting, state, limits);
		} finally {
			// Delete-on-exit: a diamond (two sibling properties referencing the SAME component) stays
			// legal and is inlined independently for each -- only a true ancestor-chain cycle fails.
			visiting.delete(name);
		}
		// A7: the sibling `default` (if any) is merged into the RESOLVED schema, not the $ref node
		// itself -- it describes what value applies when this particular use of the component is
		// absent, which is a fact about the reference site, carried onto the schema the reference
		// resolves to.
		if (Object.hasOwn(node, 'default')) resolved.default = node.default;
		return resolved;
	}

	const out = {};

	// `format` is handled before the general loop below because `uuid` is REWRITTEN (D-security-2,
	// reapplied one layer down -- see emit.mjs's BARE_UUID_PATTERN comment), not copied or dropped
	// like every other keyword; this must run before the loop reaches a `pattern` key so the
	// uuid+pattern conflict check below (inside the loop) sees `out.pattern` already set.
	if (Object.hasOwn(node, 'format')) {
		const format = node.format;
		if (format === 'uuid') {
			out.pattern = BARE_UUID_PATTERN;
		} else if (typeof format === 'string' && SAFE_FORMATS.has(format)) {
			out.format = format;
		} else {
			fail(`unsupported-format:${typeof format === 'string' ? format : typeof format}`);
		}
	}

	for (const key of Object.keys(node)) {
		if (key === '$ref' || key === 'format') continue; // format already handled above
		if (DROPPED_KEYWORDS.has(key)) continue;

		// A11: description/example are DROPPED (same as before this item) unless includeFieldDocs is
		// on -- when it is, copy verbatim IF the value passes a defensive length check, else drop
		// (silently, same as if the flag were off for this one field) rather than failing the whole
		// schema closed. Unlike an ASSERTION keyword's fail-closed policy, dropping an annotation
		// NEVER changes what the schema validates -- only how well-documented it is -- so there is no
		// correctness reason to fail the operation over one oversized documentation string, and a
		// per-FIELD warning here would be unusably noisy (a single schema can carry dozens of these,
		// unlike A10's one-per-operation description). Real data never exercises this path (measured
		// max: 3,148 for description, 70 for example -- both far under their caps), so this is a
		// defensive bound against a hostile/malformed --openapi-file, not an expected real branch.
		if (DOCUMENTATION_KEYWORDS.has(key)) {
			if (!limits.includeFieldDocs) continue;
			if (key === 'description') {
				if (typeof node.description === 'string' && node.description.length <= MAX_DESCRIPTION_LENGTH) {
					out.description = node.description;
				}
			} else if (key === 'example') {
				let serialized;
				try { serialized = JSON.stringify(node.example); } catch { serialized = null; }
				if (serialized !== undefined && serialized !== null && serialized.length <= MAX_EXAMPLE_LENGTH) {
					out.example = node.example;
				}
			}
			continue;
		}

		if (key === 'pattern') {
			// Two patterns can't be expressed without allOf, which this slice doesn't attempt to
			// synthesize -- a node with BOTH format:'uuid' and an explicit pattern fails closed
			// rather than guessing which one wins (out.pattern is already set if format:'uuid' ran).
			if (Object.hasOwn(out, 'pattern')) fail('uuid-format-with-pattern');
			const pattern = node.pattern;
			if (typeof pattern !== 'string' || pattern.length > limits.maxPatternLength) fail('pattern-too-long');
			// Partial ReDoS mitigation only -- bounds input SIZE, not regex STRUCTURE. A real,
			// already-deployed Team-IZ-Backend pattern (CreateOrganizationRequest.emailDomain) has a
			// nested quantifier well within this length cap. See D-openapi-request-schema.
			try { new RegExp(pattern); } catch { fail('invalid-pattern'); }
			out.pattern = pattern;
			continue;
		}

		if (key === 'required') {
			const req = node.required;
			if (!Array.isArray(req)) fail('unsupported-keyword:required');
			for (const r of req) {
				if (typeof r !== 'string' || !SCHEMA_PROPERTY_NAME_RE.test(r)) fail('unsupported-property-name');
			}
			out.required = [...req];
			continue;
		}

		if (COPIED_KEYWORDS.has(key)) {
			if (key === 'enum' && Array.isArray(node.enum)) {
				state.nodes += node.enum.length; // enum entries aren't separate schema nodes, but still cost budget
				if (state.nodes > limits.maxNodes) fail('too-many-nodes');
			}
			out[key] = node[key];
			continue;
		}

		if (key === 'properties') {
			const props = node.properties;
			if (typeof props !== 'object' || props === null || Array.isArray(props)) fail('unsupported-keyword:properties');
			const outProps = {};
			for (const propName of Object.keys(props)) {
				// Same prototype-pollution class as OPERATION_ID_RE/COMPONENT_SCHEMA_NAME_RE -- a
				// violating key fails the WHOLE schema closed (not a per-property drop, which would
				// silently emit a schema weaker than the real one).
				if (!SCHEMA_PROPERTY_NAME_RE.test(propName)) fail('unsupported-property-name');
				outProps[propName] = walkSchemaNode(props[propName], componentSchemas, depth + 1, visiting, state, limits);
			}
			out.properties = outProps;
			continue;
		}

		if (key === 'items') {
			out.items = walkSchemaNode(node.items, componentSchemas, depth + 1, visiting, state, limits);
			continue;
		}

		if (key === 'additionalProperties') {
			const ap = node.additionalProperties;
			out.additionalProperties = typeof ap === 'boolean'
				? ap
				: walkSchemaNode(ap, componentSchemas, depth + 1, visiting, state, limits);
			continue;
		}

		if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
			const arr = node[key];
			if (!Array.isArray(arr) || arr.length === 0) fail(`unsupported-keyword:${key}`);
			out[key] = arr.map((el) => walkSchemaNode(el, componentSchemas, depth + 1, visiting, state, limits));
			continue;
		}

		fail(`unsupported-keyword:${key}`);
	}

	return out;
}

// A2: attaches requestBodySchema/requestBodyRequired (or schemaUnresolvedReason) to a `matched`/
// `adopted` result, mutating it in place -- called only for those two kinds (see reconcileModule),
// since a `drift`/`missing`/`ambiguous`/`unresolved` operation hasn't earned trust on path/verb,
// let alone body shape. `docEntry` is the OpenAPI-side entry (from byOperationId or byRoute) whose
// `.requestBody` indexOpenApiDocument() retained. Never treats "nothing to project" as a failure --
// only an actual unresolvable schema increments schema_unresolved / sets schemaUnresolvedReason.
function applyRequestBodySchema(result, docEntry, componentSchemas, stats, includeFieldDocs) {
	const requestBody = docEntry.requestBody;
	if (!requestBody || Object.hasOwn(requestBody, '$ref')) {
		stats.schema_none++;
		return;
	}
	const content = requestBody.content;
	if (typeof content !== 'object' || content === null || Array.isArray(content) || !Object.hasOwn(content, JSON_MEDIA_TYPE)) {
		stats.schema_skipped_media_type++;
		return;
	}
	const mediaEntry = content[JSON_MEDIA_TYPE];
	const schemaNode = mediaEntry && typeof mediaEntry === 'object' && !Array.isArray(mediaEntry) ? mediaEntry.schema : null;
	if (!schemaNode || typeof schemaNode !== 'object' || Array.isArray(schemaNode)) {
		stats.schema_none++;
		return;
	}
	const resolved = inlineSchema(schemaNode, componentSchemas, { includeFieldDocs });
	if (resolved.ok) {
		result.requestBodySchema = resolved.schema;
		result.requestBodyRequired = requestBody.required === true;
		stats.schema_resolved++;
	} else {
		result.schemaUnresolvedReason = resolved.reason;
		stats.schema_unresolved++;
	}
}

// A3: recursive key-sorted serialization, used to compare two INLINE-RESOLVED schemas for
// structural equality (two different raw response-object nodes can resolve to the identical
// schema -- e.g. the real Team-IZ-Backend `findCurrentProject`, whose 200 and 204 responses are
// separate objects but both reference the same `ProjectResponse` component). Array order
// (`required`/`enum`) is significant, which makes this comparison CONSERVATIVE: two schemas that
// are semantically equal but differ in array order compare as distinct, which only ever produces
// an extra (still-correct) `anyOf` branch -- never a false "these are the same" collapse.
function canonicalJson(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

// A3: pure. Projects every documented response whose status matches `statusRe` (SUCCESS_STATUS_RE
// or ERROR_STATUS_RE) and has an `application/json` schema, deduplicating on the RAW schema node
// first (JSON.stringify -- cheap, and collapses the extremely common case of many statuses all
// pointing at the literal same node, e.g. every error status sharing one $ref to `ErrorResponse`)
// and then on the RESOLVED schema via canonicalJson (catches distinct $refs that happen to
// resolve identically). Returns exactly one discriminated outcome:
//   {outcome:'none'}                  no matching status, or none had a usable schema
//   {outcome:'skipped-media-type'}    a matching status had `content` but no application/json
//   {outcome:'unresolved', reason}    at least one matching schema failed inlineSchema()
//   {outcome:'resolved', schema, sources}  sources = how many distinct resolved shapes were unioned
// Fails closed on the FIRST unresolvable schema rather than unioning the rest -- a partial anyOf
// would describe a NARROWER set of shapes than the document actually allows, i.e. it would reject
// a real response the API produces. That is the same "never emit something that contradicts
// reality" rule A2 applied in the opposite direction (never emit a schema weaker than the real
// DTO) -- here the risk runs the other way, so the fix runs the other way too, but the underlying
// principle (don't guess, don't approximate) is identical.
//
// A6 (D-openapi-export): `includeDefault` folds OpenAPI's `default` response into this direction.
// It is passed ONLY for the error side, and that asymmetry is the whole point: `default` means
// "every status not otherwise listed", so its body may well be an error shape. Folding it into
// SUCCESS would let an error shape satisfy success validation -- a real false negative. Folding it
// into ERROR can only ever WIDEN the error union, which A3's `anyOf` design already tolerates by
// construction ("matches at least one documented shape"), and never narrows what a real response is
// permitted to be. A document whose `default` genuinely describes a success body therefore loses
// nothing it had before (nothing read `default` at all until now); one whose `default` describes an
// error -- the overwhelmingly common case, and the only case `bskel contract export` itself emits --
// gains a real error schema it previously dropped silently.
function projectResponseSchemas(responses, statusRe, componentSchemas, { includeDefault = false, includeFieldDocs = false } = {}) {
	if (!responses) return { outcome: 'none' };
	const statusKeys = Object.keys(responses);
	if (statusKeys.length > MAX_RESPONSES_PER_OPERATION) {
		return { outcome: 'unresolved', reason: 'too-many-responses' };
	}

	const rawNodesByKey = new Map();
	let sawContentWithoutJson = false;
	for (const status of statusKeys) {
		if (!statusRe.test(status) && !(includeDefault && status === DEFAULT_STATUS_KEY)) continue;
		const resp = responses[status];
		if (typeof resp !== 'object' || resp === null || Array.isArray(resp)) continue;
		const content = resp.content;
		if (typeof content !== 'object' || content === null || Array.isArray(content)) continue; // no content at all -- nothing to project for this status, not a failure
		if (!Object.hasOwn(content, JSON_MEDIA_TYPE)) { sawContentWithoutJson = true; continue; }
		const mediaEntry = content[JSON_MEDIA_TYPE];
		const schemaNode = mediaEntry && typeof mediaEntry === 'object' && !Array.isArray(mediaEntry) ? mediaEntry.schema : null;
		if (!schemaNode || typeof schemaNode !== 'object' || Array.isArray(schemaNode)) continue;
		const rawKey = JSON.stringify(schemaNode);
		if (!rawNodesByKey.has(rawKey)) rawNodesByKey.set(rawKey, schemaNode);
	}

	if (rawNodesByKey.size === 0) {
		return { outcome: sawContentWithoutJson ? 'skipped-media-type' : 'none' };
	}

	// A11: includeFieldDocs can make two previously-identical-looking resolved schemas turn out
	// distinct (different field-level description/example), which correctly increases `sources` --
	// see D-openapi-field-docs for why this is a self-consistent consequence of being more precise
	// about equality, not a bug, and the real measurement confirming it never actually happens on
	// the Team-IZ-Backend oracle.
	const resolvedByCanonical = new Map();
	for (const node of rawNodesByKey.values()) {
		const resolved = inlineSchema(node, componentSchemas, { includeFieldDocs });
		if (!resolved.ok) return { outcome: 'unresolved', reason: resolved.reason };
		const canonicalKey = canonicalJson(resolved.schema);
		if (!resolvedByCanonical.has(canonicalKey)) resolvedByCanonical.set(canonicalKey, resolved.schema);
	}

	const distinct = [...resolvedByCanonical.values()];
	if (distinct.length === 1) return { outcome: 'resolved', schema: distinct[0], sources: 1 };
	// A3: anyOf, NEVER oneOf. A2 established that projected schemas never carry
	// additionalProperties:false (Team-IZ-Backend has no Jackson customization -- see
	// D-openapi-request-schema), so two documented response shapes routinely overlap (a minimal
	// 202/204 body is often a strict subset of the 200 body's fields). oneOf requires EXACTLY one
	// branch to match and would reject a real, valid response matching more than one branch --
	// verified directly against the installed Ajv2020: a payload matching two overlapping
	// branches is rejected by oneOf and accepted by anyOf. anyOf states precisely what's true
	// given the envelope carries no status code: "matches at least one documented shape."
	return { outcome: 'resolved', schema: { anyOf: distinct }, sources: distinct.length };
}

// A3: applies both response (2xx) and error (4xx/5xx) projection to a `matched`/`adopted` result,
// mirroring applyRequestBodySchema's placement/gating exactly (same two call sites, same
// schemaProjection.enabled guard). Fields are set ONLY when resolved -- omitted, not null/false,
// so an operation with nothing to project stays byte-identical to pre-A3 output (same discipline
// as A2's requestBodySchema).
function applyResponseSchemas(result, docEntry, componentSchemas, stats, includeFieldDocs) {
	applyProjectionOutcome(result, projectResponseSchemas(docEntry.responses, SUCCESS_STATUS_RE, componentSchemas, { includeFieldDocs }), stats, 'response');
	// A6: `default` contributes to the ERROR side only -- see projectResponseSchemas' own comment.
	applyProjectionOutcome(result, projectResponseSchemas(docEntry.responses, ERROR_STATUS_RE, componentSchemas, { includeDefault: true, includeFieldDocs }), stats, 'error');
}

function applyProjectionOutcome(result, projected, stats, kind) {
	const fieldSchema = kind === 'response' ? 'responseSchema' : 'errorSchema';
	const fieldSources = kind === 'response' ? 'responseSchemaSources' : 'errorSchemaSources';
	const fieldReason = kind === 'response' ? 'responseSchemaUnresolvedReason' : 'errorSchemaUnresolvedReason';
	const counterPrefix = kind === 'response' ? 'response_schema_' : 'error_schema_';
	if (projected.outcome === 'resolved') {
		result[fieldSchema] = projected.schema;
		result[fieldSources] = projected.sources;
		stats[`${counterPrefix}resolved`]++;
	} else if (projected.outcome === 'unresolved') {
		result[fieldReason] = projected.reason;
		stats[`${counterPrefix}unresolved`]++;
	} else if (projected.outcome === 'skipped-media-type') {
		stats[`${counterPrefix}skipped_media_type`]++;
	} else {
		stats[`${counterPrefix}none`]++;
	}
}

// ===== A7: source-backed OpenAPI field passthrough =====
// D-openapi-passthrough: a field may be copied iff its value exists verbatim in the source
// document, on the operation object reconciliation already tied to this contract operation, and
// the only transformation applied is one this module already performs mechanically elsewhere
// (inlineSchema()'s $ref inlining + keyword whitelist + format:uuid rewrite). Anything requiring a
// decision about what the API probably does stays omitted. A7 (Phase 1): non-path parameters,
// security, summary, tags. A8 (D-openapi-per-status, below): per-status responses, non-JSON
// request media types. Operation-level `description` remains excluded (measured too expensive to
// default-on -- see D-openapi-per-status).

// A7: `in` locations this passthrough may copy. 'path' is deliberately excluded -- path parameters
// stay contract-derived from the route template + the contract's own name heuristic (see
// contracts/export.mjs's buildPathParameters), a genuinely separate kind of claim from a copied
// source parameter, disclosed as its own `path-parameter-schemas` omission entry rather than
// silently superseded here.
const PARAMETER_LOCATIONS = Object.freeze(new Set(['query', 'header', 'cookie']));

// A7: Parameter Object key policy -- mirrors inlineSchema()'s RECURSED/COPIED/DROPPED/fail-closed
// shape one level up (a Parameter Object, not a Schema Object). COPIED verbatim (every value here
// is a scalar, nothing to recurse into); `schema` is RESOLVED through inlineSchema() (handled
// separately in copyParameter, below); `example`/`examples` are DROPPED (annotation-only, same
// reasoning DROPPED_KEYWORDS already applies one layer down); a `$ref` parameter (needs
// components.parameters, which indexOpenApiDocument() does not index), a `content`-keyed parameter
// (a media-type-keyed alternative to `schema` -- Phase 2 machinery), or any other unrecognized key
// fails CLOSED for that ONE parameter only, never the whole operation.
const PARAMETER_COPIED_KEYS = Object.freeze(new Set([
	'required', 'deprecated', 'description', 'style', 'explode', 'allowReserved', 'allowEmptyValue',
]));
const PARAMETER_DROPPED_KEYS = Object.freeze(new Set(['example', 'examples']));

function safeParamName(raw) {
	return raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.name === 'string' ? raw.name : null;
}
function safeParamIn(raw) {
	return raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.in === 'string' ? raw.in : null;
}

// Non-path parameters only, source order, deduplicated on (name,in) -- first occurrence wins, same
// "first occurrence wins" convention indexOpenApiDocument()'s own byOperationId uses. A malformed
// entry (not an object, or missing name/in as strings) cannot participate in dedup meaningfully --
// it is still counted and still attempted (and will fail its own copy attempt on its own merits).
function collectNonPathParameters(rawParameters) {
	if (!Array.isArray(rawParameters)) return [];
	const seen = new Set();
	const out = [];
	for (const p of rawParameters) {
		if (p && typeof p === 'object' && !Array.isArray(p) && p.in === 'path') continue; // stays contract-derived
		const name = safeParamName(p);
		const loc = safeParamIn(p);
		if (name !== null && loc !== null) {
			const key = `${loc} ${name}`;
			if (seen.has(key)) continue;
			seen.add(key);
		}
		out.push(p);
	}
	return out;
}

// Copies one raw Parameter Object into the sourceParameters shape, or fails it closed.
// Returns one of:
//   {ok:false, reason}                                  -- dropped entirely, not copied at all
//   {ok:true, parameter}                                 -- copied cleanly, schema included if present
//   {ok:true, parameter, schemaUnresolvedReason}          -- copied, but `schema` could not resolve
// The middle+last cases both add the parameter to sourceParameters (every OTHER field it carries is
// real and safe); the last case additionally drives CONTRACT_OPENAPI_PARAMETERS_UNRESOLVED, exactly
// the "found but couldn't project" distinction applyRequestBodySchema already draws for a body.
function copyParameter(raw, componentSchemas, includeFieldDocs) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not-a-parameter-object' };
	if (Object.hasOwn(raw, '$ref')) return { ok: false, reason: 'ref-parameter' };
	if (Object.hasOwn(raw, 'content')) return { ok: false, reason: 'content-parameter' };
	const name = raw.name;
	if (typeof name !== 'string' || name.length === 0) return { ok: false, reason: 'missing-name' };
	const loc = raw.in;
	if (!PARAMETER_LOCATIONS.has(loc)) return { ok: false, reason: 'unsupported-location' };

	const parameter = { name, in: loc };
	for (const key of Object.keys(raw)) {
		if (key === 'name' || key === 'in' || key === 'schema') continue; // handled explicitly
		if (PARAMETER_DROPPED_KEYS.has(key)) continue;
		if (PARAMETER_COPIED_KEYS.has(key)) { parameter[key] = raw[key]; continue; }
		return { ok: false, reason: `unsupported-keyword:${key}` };
	}

	if (Object.hasOwn(raw, 'schema')) {
		const resolved = inlineSchema(raw.schema, componentSchemas, { includeFieldDocs });
		if (resolved.ok) {
			parameter.schema = resolved.schema;
		} else {
			return { ok: true, parameter, schemaUnresolvedReason: resolved.reason };
		}
	}
	return { ok: true, parameter };
}

// A7: parameters ride the schema-bearing gate (schemaProjectionEnabled) -- a `schema` inside a
// parameter goes through inlineSchema() exactly like a request/response body does, and a 3.0
// document's `exclusiveMinimum`/`nullable` mean something different under the 2020-12 dialect
// Ajv2020 speaks, the same reasoning that already disables A2/A3 for a whole document. Sets, on
// `result`: parametersTotal/parametersCleanCount (reconciliation-internal bookkeeping consumed only
// by snapshotFromReconciliation, never copied into the contract itself), parametersSkippedDialect,
// sourceParameters (omitted when empty), parametersUnresolved (omitted when empty).
function applyParameters(result, docEntry, index, stats, schemaProjectionEnabled, includeFieldDocs) {
	const candidates = collectNonPathParameters(docEntry.parameters);
	if (candidates.length === 0) {
		stats.parameters_none++;
		return;
	}
	if (!schemaProjectionEnabled) {
		result.parametersSkippedDialect = true;
		stats.parameters_skipped_dialect++;
		return;
	}

	const copied = [];
	const unresolved = [];
	let cleanCount = 0;

	if (candidates.length > MAX_PARAMETERS_PER_OPERATION) {
		// Exceeding the cap fails the WHOLE parameter set closed for this operation, never the whole
		// reconciliation -- same "fail this field, not the operation kind" posture every cap in this
		// module already takes.
		for (const p of candidates) {
			unresolved.push({ name: safeParamName(p), in: safeParamIn(p), reason: 'too-many-parameters' });
		}
	} else {
		for (const raw of candidates) {
			const outcome = copyParameter(raw, index.componentSchemas, includeFieldDocs);
			if (!outcome.ok) {
				unresolved.push({ name: safeParamName(raw), in: safeParamIn(raw), reason: outcome.reason });
				continue;
			}
			copied.push(outcome.parameter);
			if (outcome.schemaUnresolvedReason) {
				unresolved.push({ name: outcome.parameter.name, in: outcome.parameter.in, reason: outcome.schemaUnresolvedReason });
			} else {
				cleanCount++;
			}
		}
	}

	result.parametersTotal = candidates.length;
	result.parametersCleanCount = cleanCount;
	if (copied.length > 0) result.sourceParameters = copied;
	if (unresolved.length > 0) result.parametersUnresolved = unresolved;

	if (cleanCount === candidates.length) stats.parameters_copied++;
	else stats.parameters_unresolved++;
}

// A7: security is dialect-independent -- a Security Requirement Object means the same thing under
// 3.0 and 3.1, so this is copied regardless of schemaProjectionEnabled (a deliberate asymmetry with
// applyParameters above, not an oversight -- see D-openapi-passthrough). All-or-nothing per
// operation (unlike parameters' per-item fail-closed): a requirement naming a scheme that could not
// be resolved means the WHOLE security value is dropped for that operation, never a dangling
// reference -- verified by executing the real 3.1 meta-schema that it cannot itself catch this (a
// `security` requirement naming an undeclared scheme validates `true`). `referencedSchemeNames` is
// a Set shared across the whole reconciliation -- accumulates every scheme name any operation's
// COPIED security actually referenced, which becomes the contract-root `sourceSecuritySchemes`.
function applySecurity(result, docEntry, index, stats, referencedSchemeNames) {
	const security = docEntry.security;
	if (security === null) {
		stats.security_none++;
		return;
	}
	if (security.length > MAX_SECURITY_REQUIREMENTS_PER_OPERATION) {
		result.securityUnresolvedReason = 'too-many-requirements';
		stats.security_unresolved++;
		return;
	}
	const namesInThisOperation = [];
	for (const requirement of security) {
		if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
			result.securityUnresolvedReason = 'malformed-requirement';
			stats.security_unresolved++;
			return;
		}
		for (const schemeName of Object.keys(requirement)) {
			if (!Object.hasOwn(requirement, schemeName)) continue; // Object.keys is already own-only; defensive
			if (!index.securitySchemes.has(schemeName)) {
				result.securityUnresolvedReason = 'unknown-scheme';
				stats.security_unresolved++;
				return;
			}
			namesInThisOperation.push(schemeName);
		}
	}
	result.sourceSecurity = security;
	for (const name of namesInThisOperation) referencedSchemeNames.add(name);
	if (security.length === 0) stats.security_public++;
	else stats.security_copied++;
}

// A7: summary/tags are dialect-independent, same reasoning as applySecurity above -- copied
// verbatim, never synthesized from operationId or module names (same discipline A6's own omitted-
// summaries rule established, now source-conditioned instead of always-omitted).
function applySummaryAndTags(result, docEntry, stats) {
	if (typeof docEntry.summary === 'string' && docEntry.summary.length > 0) {
		result.sourceSummary = docEntry.summary;
		stats.summary_copied++;
	}
	if (Array.isArray(docEntry.tags) && docEntry.tags.length > 0) {
		const tags = docEntry.tags.filter((t) => typeof t === 'string');
		if (tags.length > 0) {
			result.sourceTags = tags;
			stats.tags_copied++;
		}
	}
}

// A10 (D-openapi-description): the one A7/A8/A9 sibling that is NOT default-on -- gated behind
// `includeDescriptions`, opt-in only, because the measured cost (2,442.7 bytes/operation average
// across the real oracle, re-confirmed exactly at this item's own implementation) is larger than
// every other field this whole passthrough effort copies COMBINED. Copied verbatim, no
// transformation (unlike a schema, there is no keyword whitelist to apply to a plain string) --
// fails closed only on length, via MAX_DESCRIPTION_LENGTH, the same defensive posture every other
// unbounded-size field in this file has (same defensive-cap class as D-security-1/D-security-2) --
// protecting the contract file/gate-token hashing cost from a malformed or hostile --openapi-file,
// not a normal document.
function applyDescription(result, docEntry, stats, includeDescriptions) {
	if (!includeDescriptions) {
		stats.description_skipped_flag++;
		return;
	}
	const raw = docEntry.description;
	if (typeof raw !== 'string' || raw.length === 0) {
		stats.description_none++;
		return;
	}
	if (raw.length > MAX_DESCRIPTION_LENGTH) {
		result.descriptionUnresolvedReason = 'too-long';
		stats.description_unresolved++;
		return;
	}
	result.sourceDescription = raw;
	stats.description_copied++;
}

// A8: per-status responses -- additive to (never replacing) the responseSchema/errorSchema union
// projection above; contracts/validate.mjs is untouched by this item, see D-openapi-per-status.
// Gated on schemaProjectionEnabled, same reasoning as applyParameters -- a JSON Schema resolved
// under a 3.0 document's dialect means something different under 2020-12, and per-status
// responses resolve schemas via the exact same inlineSchema() path parameters/bodies already do.
//
// Written only when BOTH projectResponseSchemas() outcomes for this operation are resolved-or-none
// (never unresolved) -- if either bucket failed to resolve, this silently and correctly skips,
// falling back to the existing union-only export path; the failure is already recorded via A3's
// own responseSchemaUnresolvedReason/errorSchemaUnresolvedReason, nothing here duplicates it.
//
// schemaFrom is provable, not guessed: projectResponseSchemas() already deduplicated every status
// in its bucket down to `sources` distinct resolved shapes -- if sources===1, EVERY status in that
// bucket with a JSON schema resolved to THAT one shape, by construction, so this function can point
// at it instead of re-resolving. When sources>1 (never observed on real data, but structurally
// possible) or the status sits outside both buckets (a 1xx/3xx key), the status's own schema is
// resolved individually into an inline `schema` instead.
function applyPerStatusResponses(result, docEntry, componentSchemas, stats, schemaProjectionEnabled, includeFieldDocs) {
	if (!schemaProjectionEnabled) {
		result.perStatusResponsesSkippedDialect = true;
		stats.per_status_skipped_dialect++;
		return;
	}
	const responses = docEntry.responses;
	if (!responses || typeof responses !== 'object' || Array.isArray(responses) || Object.keys(responses).length === 0) {
		stats.per_status_none++;
		return;
	}
	if (result.responseSchemaUnresolvedReason || result.errorSchemaUnresolvedReason) {
		result.perStatusResponsesSkippedUnresolved = true;
		stats.per_status_skipped_unresolved++;
		return;
	}

	const perStatus = {};
	let anyEntry = false;
	for (const key of Object.keys(responses)) {
		if (!RESPONSE_STATUS_KEY_RE.test(key)) continue; // not a legal status key -- dropped, not a failure
		const resp = responses[key];
		if (typeof resp !== 'object' || resp === null || Array.isArray(resp)) continue;
		// A8 follow-up (Codex review): a Response Object `$ref` (`components.responses.<Name>`, legal
		// per the official 3.1 meta-schema's `response-or-reference`) is not resolved here -- 0 real
		// occurrences against the Team-IZ-Backend oracle (694 response objects, 0 $ref), named rather
		// than built, same "don't build for zero real cases" discipline as non-json-response-schemas/
		// response-headers below. Skipping is the fail-closed choice: falling through with
		// resp.description/resp.content both undefined would produce a description-only entry carrying
		// the synthetic PER_STATUS_NO_DESCRIPTION_STANDIN as if the source truly documented this status
		// with no description -- false. A referenced response is simply omitted for this status.
		if (typeof resp.$ref === 'string') continue;

		const entry = {};
		if (typeof resp.description === 'string' && resp.description.length > 0 && resp.description !== PER_STATUS_NO_DESCRIPTION_STANDIN) {
			entry.description = resp.description;
		}

		const content = resp.content;
		if (content && typeof content === 'object' && !Array.isArray(content)) {
			if (Object.hasOwn(content, JSON_MEDIA_TYPE)) {
				const mediaEntry = content[JSON_MEDIA_TYPE];
				const schemaNode = mediaEntry && typeof mediaEntry === 'object' && !Array.isArray(mediaEntry) ? mediaEntry.schema : null;
				if (schemaNode && typeof schemaNode === 'object' && !Array.isArray(schemaNode)) {
					if (SUCCESS_STATUS_RE.test(key) && result.responseSchema && result.responseSchemaSources === 1) {
						entry.schemaFrom = 'response';
					} else if ((ERROR_STATUS_RE.test(key) || key === DEFAULT_STATUS_KEY) && result.errorSchema && result.errorSchemaSources === 1) {
						entry.schemaFrom = 'error';
					} else {
						const resolved = inlineSchema(schemaNode, componentSchemas, { includeFieldDocs });
						// unresolved here just leaves `schema` absent -- `description` alone (if any) stays
						// valid, same "copied without schema" posture copyParameter() already takes.
						if (resolved.ok) entry.schema = resolved.schema;
					}
				}
			} else {
				const mediaTypes = Object.keys(content).filter((mt) => MEDIA_TYPE_RE.test(mt));
				if (mediaTypes.length > 0) entry.mediaTypes = mediaTypes;
			}
		}

		perStatus[key] = entry;
		anyEntry = true;
	}

	if (!anyEntry) {
		stats.per_status_none++;
		return;
	}
	result.sourceResponses = perStatus;
	stats.per_status_copied++;
}

// A8: non-JSON request media types (multipart/form-data in the real oracle) -- additive to A2's
// requestBodySchema, never overlapping it: `content` here never contains application/json (that
// stays A2's field, the one representation of that one fact -- expressed as a schema invariant in
// schemas/feature-contract.schema.json too). Gated on schemaProjectionEnabled for the same reason
// as applyPerStatusResponses above -- a media-type schema resolves through the same inlineSchema()
// path.
function applyRequestMediaTypes(result, docEntry, componentSchemas, stats, schemaProjectionEnabled, includeFieldDocs) {
	if (!schemaProjectionEnabled) {
		result.requestMediaTypesSkippedDialect = true;
		stats.request_media_types_skipped_dialect++;
		return;
	}
	const requestBody = docEntry.requestBody;
	if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody) || Object.hasOwn(requestBody, '$ref')) {
		stats.request_media_types_none++;
		return;
	}
	const content = requestBody.content;
	if (typeof content !== 'object' || content === null || Array.isArray(content)) {
		stats.request_media_types_none++;
		return;
	}
	const mediaTypeKeys = Object.keys(content).filter((mt) => mt !== JSON_MEDIA_TYPE && MEDIA_TYPE_RE.test(mt));
	if (mediaTypeKeys.length === 0) {
		stats.request_media_types_none++;
		return;
	}
	if (mediaTypeKeys.length > MAX_REQUEST_MEDIA_TYPES) {
		// Exceeding the cap fails the WHOLE media-type set closed for this operation, same "fail this
		// field, not the operation kind" posture every cap in this module already takes.
		result.requestMediaTypesUnresolvedReason = 'too-many-media-types';
		stats.request_media_types_unresolved++;
		return;
	}

	const copiedContent = {};
	let cleanCount = 0;
	for (const mt of mediaTypeKeys) {
		const mediaEntry = content[mt];
		const entry = {};
		const schemaNode = mediaEntry && typeof mediaEntry === 'object' && !Array.isArray(mediaEntry) ? mediaEntry.schema : null;
		if (schemaNode && typeof schemaNode === 'object' && !Array.isArray(schemaNode)) {
			const resolved = inlineSchema(schemaNode, componentSchemas, { includeFieldDocs });
			if (resolved.ok) { entry.schema = resolved.schema; cleanCount++; }
		} else {
			cleanCount++; // no schema declared for this media type at all is not a failure -- same
			              // "nothing to project" posture applyRequestBodySchema already takes.
		}
		copiedContent[mt] = entry;
	}

	result.sourceRequestBody = { content: copiedContent };
	if (requestBody.required === true) result.sourceRequestBody.required = true;
	if (cleanCount === mediaTypeKeys.length) {
		stats.request_media_types_copied++;
	} else {
		result.requestMediaTypesUnresolvedReason = 'schema-unresolved';
		stats.request_media_types_unresolved++;
	}
}

// A9 (D-openapi-path-params): the real fix for A7's own disclosed `batchRequestId` finding --
// contracts/emit.mjs's pathParamsSchema() names a path segment by NAME ONLY (`/id$/i` ->
// BARE_UUID_PATTERN), a heuristic that is provably wrong for at least one real path parameter
// (`batchRequestId`, a plain string despite the "Id" suffix). Unlike A7's own parameters (query/
// header/cookie, which stay ADDITIVE alongside pathParams' own separate story), this one REPLACES
// the heuristic's guess in place for any segment the source document can answer -- the same
// "positive information overrides a guess" principle A8's `hasSourceMediaTypeInfo` already
// established, applied here to path-param TYPE instead of request media type.
//
// Returns a Map (never a plain object -- this is `--openapi-file`-sourced, untrusted data keyed by
// parameter NAME, the exact class RESPONSE_STATUS_KEY_RE/MEDIA_TYPE_RE exist to defend against
// elsewhere in this file; a Map sidesteps prototype pollution entirely rather than needing a third
// whitelist regex) from resolved path-parameter name to its inlined schema, stashed transiently on
// `result` for contracts/emit.mjs's pathParamsSchema() call to consult -- never itself persisted to
// the contract; only the corrected `pathParams` (and, when at least one segment still falls back to
// the heuristic, `pathParamsHeuristic`) are.
function applyPathParameterSchemas(result, docEntry, componentSchemas, stats, schemaProjectionEnabled, includeFieldDocs) {
	const rawParameters = Array.isArray(docEntry.parameters) ? docEntry.parameters : [];
	const pathParams = rawParameters.filter((p) => p && typeof p === 'object' && !Array.isArray(p) && p.in === 'path');
	if (pathParams.length === 0) {
		stats.path_params_none++;
		return;
	}
	if (!schemaProjectionEnabled) {
		result.pathParamsSkippedDialect = true;
		stats.path_params_skipped_dialect++;
		return;
	}
	const resolved = new Map();
	for (const p of pathParams) {
		const name = safeParamName(p);
		if (name === null || !Object.hasOwn(p, 'schema')) continue; // no name, or source declared no schema -- nothing to prefer over the heuristic for this one segment
		const schemaNode = p.schema;
		if (!schemaNode || typeof schemaNode !== 'object' || Array.isArray(schemaNode)) continue;
		const out = inlineSchema(schemaNode, componentSchemas, { includeFieldDocs });
		if (out.ok) resolved.set(name, out.schema);
	}
	if (resolved.size > 0) {
		result.pathParamSchemas = resolved;
		stats.path_params_copied++;
	} else {
		stats.path_params_unresolved++;
	}
}

// A7: the single entry point called from reconcileModule()'s two matched/adopted call sites --
// exactly the placement A2/A3's own helpers already occupy, which IS the refusal mechanism for
// every other resolution kind (drift/missing/ambiguous/unresolved never reach this function at
// all, see reconcileModule below).
function applyPassthrough(result, docEntry, index, stats, schemaProjectionEnabled, referencedSchemeNames, includeDescriptions) {
	// A11 (D-openapi-field-docs): includeDescriptions doubles as includeFieldDocs here -- reusing
	// the existing --descriptions flag rather than adding a second one, since it already governs
	// "copy source-authored documentation prose" at the operation level (A10); field-level
	// description/example is the same policy applied one level deeper into the same schemas.
	applyParameters(result, docEntry, index, stats, schemaProjectionEnabled, includeDescriptions);
	applySecurity(result, docEntry, index, stats, referencedSchemeNames);
	applySummaryAndTags(result, docEntry, stats);
	// A8: same matched/adopted-only placement as the three calls above -- this IS the refusal
	// mechanism for every other resolution kind, extended unchanged for the two new fields.
	applyPerStatusResponses(result, docEntry, index.componentSchemas, stats, schemaProjectionEnabled, includeDescriptions);
	applyRequestMediaTypes(result, docEntry, index.componentSchemas, stats, schemaProjectionEnabled, includeDescriptions);
	// A9: same placement again, for the path-parameter schema fix.
	applyPathParameterSchemas(result, docEntry, index.componentSchemas, stats, schemaProjectionEnabled, includeDescriptions);
	// A10: same placement again -- applyDescription() itself decides whether includeDescriptions
	// gates it off, matching how applyParameters decides its own schemaProjectionEnabled gate
	// internally rather than being skipped by the caller.
	applyDescription(result, docEntry, stats, includeDescriptions);
}

// The core reconciliation, pure (no I/O). `module` is a scanReport related_modules entry (as
// selected by contracts/emit.mjs's selectModule -- caller's responsibility to pass the SAME
// selection buildContract() will use, so endpointKey(ci,ei) lines up). `pathPrefix`, if given
// (from --path-prefix), overrides inference entirely but the anchor pass still runs so its
// deltas are recorded for audit in the snapshot.
export function reconcileModule({ index, module, pathPrefix = null, includeDescriptions = false }) {
	const anchorDeltas = [];
	for (const controller of module.controllers) {
		for (const ep of controller.endpoints) {
			if (!ep.operationId) continue;
			const docEntry = index.byOperationId.get(ep.operationId);
			if (!docEntry || docEntry.verb !== ep.verb) continue; // verb mismatch => not a safe anchor, surfaces as drift below
			const delta = computeDelta(ep.path, docEntry.path);
			if (delta !== null) anchorDeltas.push(delta);
		}
	}
	const inferred = inferPathPrefix(anchorDeltas);
	const prefix = pathPrefix != null
		? { value: pathPrefix, origin: 'flag', deltas: inferred.deltas, conflicting: [] }
		: inferred;

	const byEndpoint = new Map();
	const stats = {
		matched: 0, adopted: 0, drift: 0, missing: 0, ambiguous: 0, unresolved: 0,
		// A2: initialized here (not left implicit) so they're always present in evidence.openapi /
		// the snapshot, even for a document with no request bodies at all -- a stable shape for
		// downstream consumers that already spread ...stats (bin/bskel.mjs, snapshotFromReconciliation).
		// Bare `schema_*` means request-body specifically (A2) -- kept as-is, not renamed to
		// `request_schema_*`, for evidence-key stability (test/contract-cli.test.mjs and real gate
		// records already assert this exact name).
		schema_resolved: 0, schema_unresolved: 0, schema_none: 0, schema_skipped_media_type: 0,
		// A3: response (2xx) / error (4xx/5xx) counters, same stable-shape reasoning.
		response_schema_resolved: 0, response_schema_unresolved: 0, response_schema_none: 0, response_schema_skipped_media_type: 0,
		error_schema_resolved: 0, error_schema_unresolved: 0, error_schema_none: 0, error_schema_skipped_media_type: 0,
		// A7: source-backed passthrough counters -- parameters/security are per-OPERATION tallies
		// (an operation with a mix of resolved/unresolved parameters counts once, under
		// parameters_unresolved, matching the "partial:M-of-N" snapshot decision), summary/tags are
		// simple presence counts.
		parameters_copied: 0, parameters_unresolved: 0, parameters_none: 0, parameters_skipped_dialect: 0,
		security_copied: 0, security_public: 0, security_unresolved: 0, security_none: 0,
		summary_copied: 0, tags_copied: 0,
		// A8: per-status responses / request media types counters, same per-operation-tally shape as
		// the A7 counters above.
		per_status_copied: 0, per_status_skipped_unresolved: 0, per_status_none: 0, per_status_skipped_dialect: 0,
		request_media_types_copied: 0, request_media_types_unresolved: 0, request_media_types_none: 0, request_media_types_skipped_dialect: 0,
		// A9: source-backed path-parameter schema counters, same per-operation-tally shape.
		path_params_copied: 0, path_params_unresolved: 0, path_params_none: 0, path_params_skipped_dialect: 0,
		// A10: operation-level description counters. skipped_flag is the common case when
		// --descriptions was not passed -- distinct from `none` (flag WAS passed, source had nothing).
		description_copied: 0, description_unresolved: 0, description_none: 0, description_skipped_flag: 0,
	};
	// A7: accumulates every security-scheme name any operation's COPIED security requirement
	// actually referenced, across the WHOLE module -- becomes the contract-root sourceSecuritySchemes
	// (only schemes actually used, never the document's full componentSchemas-style catalog).
	const referencedSecuritySchemeNames = new Set();
	// A2: an OpenAPI 3.0 document's `exclusiveMinimum`/`nullable` mean something different under
	// JSON Schema 2020-12 (the dialect Ajv2020 speaks) -- rather than silently misinterpreting
	// those, schema projection is disabled for the WHOLE document, once, here -- not per-operation
	// (which would flood every contract with N warnings for one root cause). Path/verb
	// reconciliation above is dialect-independent and stays fully active either way.
	const schemaProjection = index.schemaDialectSupported
		? { enabled: true, reason: null }
		: { enabled: false, reason: 'unsupported-openapi-version' };

	for (const [ci, controller] of module.controllers.entries()) {
		for (const [ei, ep] of controller.endpoints.entries()) {
			const key = endpointKey(ci, ei);
			let result;

			if (ep.operationId) {
				const docEntry = index.byOperationId.get(ep.operationId);
				if (!docEntry) {
					result = { kind: 'missing', scanVerb: ep.verb, scanPath: ep.path };
					stats.missing++;
				} else if (docEntry.verb !== ep.verb) {
					result = {
						kind: 'drift', reason: 'verb',
						openapi: { verb: docEntry.verb, path: docEntry.path },
						scanVerb: ep.verb, scanPath: ep.path,
					};
					stats.drift++;
				} else {
					const delta = computeDelta(ep.path, docEntry.path);
					if (docEntry.path === ep.path || delta !== null) {
						result = {
							kind: 'matched', operationId: ep.operationId, verb: docEntry.verb, path: docEntry.path,
							scanVerb: ep.verb, scanPath: ep.path,
						};
						stats.matched++;
						// A2/A3: matched/adopted ONLY -- schema enrichment never applies to drift/missing/
						// ambiguous/unresolved, same "don't guess" rule A1 established for path/verb.
						if (schemaProjection.enabled) {
							applyRequestBodySchema(result, docEntry, index.componentSchemas, stats, includeDescriptions);
							applyResponseSchemas(result, docEntry, index.componentSchemas, stats, includeDescriptions);
						}
						// A7: same matched/adopted-only placement -- this IS the refusal mechanism for
						// every other resolution kind. Called unconditionally (not gated on
						// schemaProjection.enabled): parameters gate internally (schema-bearing);
						// security/summary/tags are dialect-independent and always attempted.
						applyPassthrough(result, docEntry, index, stats, schemaProjection.enabled, referencedSecuritySchemeNames, includeDescriptions);
					} else {
						result = {
							kind: 'drift', reason: 'path',
							openapi: { verb: docEntry.verb, path: docEntry.path },
							scanVerb: ep.verb, scanPath: ep.path,
						};
						stats.drift++;
					}
				}
			} else if (prefix.value == null) {
				result = { kind: 'unresolved', reason: 'prefix-inconclusive', scanVerb: ep.verb, scanPath: ep.path };
				stats.unresolved++;
			} else {
				const candidates = prefix.value === '' ? [ep.path] : [...new Set([prefix.value + ep.path, ep.path])];
				const hits = candidates.flatMap((c) => index.byRoute.get(`${ep.verb} ${normalizeRoute(c)}`) ?? []);
				if (hits.length === 0) {
					result = { kind: 'unresolved', reason: 'no-candidate', scanVerb: ep.verb, scanPath: ep.path };
					stats.unresolved++;
				} else if (hits.length === 1 && hits[0].operationId) {
					result = {
						kind: 'adopted', operationId: hits[0].operationId, verb: hits[0].verb, path: hits[0].path,
						scanVerb: ep.verb, scanPath: ep.path,
					};
					stats.adopted++;
					if (schemaProjection.enabled) {
						applyRequestBodySchema(result, hits[0], index.componentSchemas, stats, includeDescriptions);
						applyResponseSchemas(result, hits[0], index.componentSchemas, stats, includeDescriptions);
					}
					applyPassthrough(result, hits[0], index, stats, schemaProjection.enabled, referencedSecuritySchemeNames, includeDescriptions);
				} else if (hits.length === 1) {
					// A single route match, but the document itself never gave that operation an
					// operationId -- nothing to route by, so this can't become an addressable
					// operation regardless. Distinct reason from "no-candidate" for diagnosability.
					result = { kind: 'unresolved', reason: 'document-missing-operation-id', scanVerb: ep.verb, scanPath: ep.path };
					stats.unresolved++;
				} else {
					result = {
						kind: 'ambiguous',
						candidates: hits.map((h) => ({ verb: h.verb, path: h.path, operationId: h.operationId })),
						scanVerb: ep.verb, scanPath: ep.path,
					};
					stats.ambiguous++;
				}
			}

			byEndpoint.set(key, result);
		}
	}

	// A7: resolve the accumulated scheme names against index.securitySchemes -- only names that
	// actually made it into at least one operation's COPIED sourceSecurity end up here, so this Map
	// is exactly what buildContract() should attach as the contract-root sourceSecuritySchemes.
	const sourceSecuritySchemes = new Map();
	for (const name of referencedSecuritySchemeNames) {
		const scheme = index.securitySchemes.get(name);
		if (scheme) sourceSecuritySchemes.set(name, scheme);
	}

	return { byEndpoint, prefix, stats, schemaProjection, sourceSecuritySchemes };
}

// Convenience entry point: load + index + reconcile in one call, propagating the first failure.
// This is what bin/bskel.mjs's cmdContractEmit calls.
export function buildReconciliation({ filePath, module, pathPrefix = null, includeDescriptions = false }) {
	if (pathPrefix != null && !PATH_PREFIX_RE.test(pathPrefix)) {
		return { ok: false, error: `--path-prefix "${pathPrefix}" is not a valid path prefix (expected e.g. "/api/v0")` };
	}
	const loaded = loadOpenApiDocument(filePath);
	if (!loaded.ok) return loaded;
	// A6 (D-openapi-export): the structural half of the hazard `bskel contract export` creates.
	// Piping an export straight back into `contract emit --openapi-file` would make the contract
	// "confirm" itself -- stats.matched would read N/N and A1's entire point (an INDEPENDENT
	// oracle) would evaporate silently. Worse than a no-op: a `drift` operation still sits in
	// `contract.operations` at the scan's own uncorrected verb/path, so an export puts it in the
	// document at exactly that verb/path, computeDelta() then agrees, and a recorded
	// CONTRACT_OPENAPI_DRIFT (ERROR) reclassifies as `matched` and disappears. Same for `missing`;
	// an `ambiguous` endpoint is worse still, since it is never in the contract at all and would
	// come back as a plain CONTRACT_UNMATCHED_ENDPOINT -- a DIFFERENT code, which breaks any
	// waiver already recorded against it ({code, subject} is the waiver key, see
	// D-contract-completeness). Refused here rather than defended against downstream, and through
	// the existing BAD_ARGS/exit-14 path cmdContractEmit already uses for a malformed
	// --openapi-file -- no new exit code, no new machinery.
	if (hasBskelExportMarker(loaded.doc)) {
		return { ok: false, error: `"${filePath}" was generated by \`bskel contract export\` -- reconciling a contract against its own export defeats the point of an independent oracle (every operation would confirm itself, and an already-recorded drift/missing ERROR would silently reclassify as matched). Point --openapi-file at a document the application itself produces. If you genuinely mean to reconcile against a hand-edited copy, remove the "${BSKEL_GENERATED_EXTENSION}" extension from its \`info\` object first.` };
	}
	const indexed = indexOpenApiDocument(loaded.doc);
	if (!indexed.ok) return indexed;
	const recon = reconcileModule({ index: indexed, module, pathPrefix, includeDescriptions });
	return {
		ok: true,
		document: {
			hash: loaded.hash,
			bytes: loaded.bytes,
			path_count: indexed.stats.path_count,
			operation_count: indexed.stats.operation_count,
			skipped_path_refs: indexed.stats.skipped_path_refs,
			rejected_operation_ids: indexed.stats.rejected_operation_ids,
			component_schema_count: indexed.stats.component_schema_count,
			rejected_component_schemas: indexed.stats.rejected_component_schemas,
			security_scheme_count: indexed.stats.security_scheme_count,
			rejected_security_schemes: indexed.stats.rejected_security_schemes,
			openapi_version: indexed.openapiVersion,
			servers: indexed.servers,
		},
		byEndpoint: recon.byEndpoint,
		prefix: recon.prefix,
		stats: recon.stats,
		schemaProjection: recon.schemaProjection,
		// A7: only schemes actually referenced by at least one copied sourceSecurity requirement --
		// contracts/emit.mjs attaches this at the contract root when non-empty.
		sourceSecuritySchemes: recon.sourceSecuritySchemes,
		// D-unsupported-annotation-warning: computed once per document, not per-operation -- a
		// module-wide presence signal, not a per-operation fact, so contracts/emit.mjs pushes at
		// most one warning per keyword name for the whole module, not one per operation.
		unsupportedAnnotations: findUnsupportedAnnotations(loaded.doc),
	};
}

// A7: decision-only audit-trail strings for the four passthrough fields, exactly parallel to
// request_body_schema/response_schema/error_schema above -- the snapshot records the DECISION, not
// the payload (the payload lives in the contract file, already covered by contract_hash).
function parametersDecision(result) {
	if (result.parametersSkippedDialect) return 'skipped:dialect';
	if (!result.parametersTotal) return 'none';
	return result.parametersCleanCount === result.parametersTotal
		? `copied:${result.parametersTotal}`
		: `partial:${result.parametersCleanCount}-of-${result.parametersTotal}`;
}
function securityDecision(result) {
	if (result.sourceSecurity) return result.sourceSecurity.length === 0 ? 'copied:public' : `copied:${result.sourceSecurity.length}`;
	if (result.securityUnresolvedReason) return `unresolved:${result.securityUnresolvedReason}`;
	return 'none';
}
function summaryDecision(result) {
	return result.sourceSummary ? 'copied' : 'none';
}
function tagsDecision(result) {
	return result.sourceTags ? `copied:${result.sourceTags.length}` : 'none';
}
// A8: same decision-only audit-trail shape, for the two new passthrough fields.
function perStatusResponsesDecision(result) {
	if (result.perStatusResponsesSkippedDialect) return 'skipped:dialect';
	if (result.perStatusResponsesSkippedUnresolved) return 'skipped:unresolved';
	if (result.sourceResponses) return `copied:${Object.keys(result.sourceResponses).length}`;
	return 'none';
}
function requestMediaTypesDecision(result) {
	if (result.requestMediaTypesSkippedDialect) return 'skipped:dialect';
	if (result.sourceRequestBody) {
		const count = Object.keys(result.sourceRequestBody.content).length;
		return result.requestMediaTypesUnresolvedReason ? `partial:${count}` : `copied:${count}`;
	}
	if (result.requestMediaTypesUnresolvedReason) return `unresolved:${result.requestMediaTypesUnresolvedReason}`;
	return 'none';
}
// A9: same decision-only audit-trail shape, for the path-parameter schema fix.
function pathParamSchemasDecision(result) {
	if (result.pathParamsSkippedDialect) return 'skipped:dialect';
	if (result.pathParamSchemas) return `copied:${result.pathParamSchemas.size}`;
	return 'none';
}
// A10: same decision-only audit-trail shape as every field above.
function descriptionDecision(result) {
	if (result.sourceDescription) return 'copied';
	if (result.descriptionUnresolvedReason) return `unresolved:${result.descriptionUnresolvedReason}`;
	return 'none';
}

// `sourceFile`: {file, outsideRepo} precomputed by the caller (bin/bskel.mjs knows the repo
// root; this module deliberately doesn't) -- keeps machine-specific absolute paths out of a
// committed artifact when the OpenAPI file lives outside the repo.
export function snapshotFromReconciliation(reconciliation, { featureId, sourceFile }) {
	const operations = {};
	for (const result of reconciliation.byEndpoint.values()) {
		if (result.kind === 'matched' || result.kind === 'adopted') {
			operations[result.operationId] = {
				verb: result.verb,
				path: result.path,
				via: result.kind === 'adopted' ? 'openapi' : 'operationId',
				scan_path: result.scanPath,
				// A2: records the DECISION, not the schema itself -- the schema payload already lives
				// in the contract file, already covered by the contract gate's contract_hash. This is
				// an audit trail of what reconciliation concluded, not a second copy of the data.
				request_body_schema: result.requestBodySchema
					? 'resolved'
					: result.schemaUnresolvedReason
						? `unresolved:${result.schemaUnresolvedReason}`
						: 'none',
				// A3: same decision-only audit trail, for the response/error projections.
				response_schema: result.responseSchema
					? (result.responseSchemaSources > 1 ? `resolved:union:${result.responseSchemaSources}` : 'resolved')
					: result.responseSchemaUnresolvedReason
						? `unresolved:${result.responseSchemaUnresolvedReason}`
						: 'none',
				error_schema: result.errorSchema
					? (result.errorSchemaSources > 1 ? `resolved:union:${result.errorSchemaSources}` : 'resolved')
					: result.errorSchemaUnresolvedReason
						? `unresolved:${result.errorSchemaUnresolvedReason}`
						: 'none',
				// A7: same decision-only audit trail, for the four passthrough fields.
				parameters: parametersDecision(result),
				security: securityDecision(result),
				summary: summaryDecision(result),
				tags: tagsDecision(result),
				// A8: same decision-only audit trail, for the two new passthrough fields.
				per_status_responses: perStatusResponsesDecision(result),
				request_media_types: requestMediaTypesDecision(result),
				// A9: same decision-only audit trail, for the path-parameter schema fix.
				path_param_schemas: pathParamSchemasDecision(result),
				// A10: same decision-only audit trail, for the opt-in operation-level description.
				description: descriptionDecision(result),
			};
		}
	}
	return {
		schema: 'sbf.openapi-snapshot/1',
		feature_id: featureId,
		source: {
			file: sourceFile.file,
			outside_repo: sourceFile.outsideRepo,
			sha256: reconciliation.document.hash,
			bytes: reconciliation.document.bytes,
		},
		document: {
			path_count: reconciliation.document.path_count,
			operation_count: reconciliation.document.operation_count,
			skipped_path_refs: reconciliation.document.skipped_path_refs,
			component_schema_count: reconciliation.document.component_schema_count,
			rejected_component_schemas: reconciliation.document.rejected_component_schemas,
			security_scheme_count: reconciliation.document.security_scheme_count,
			rejected_security_schemes: reconciliation.document.rejected_security_schemes,
			openapi_version: reconciliation.document.openapi_version,
			servers: reconciliation.document.servers,
		},
		path_prefix: reconciliation.prefix,
		schema_projection: reconciliation.schemaProjection,
		operations,
		stats: reconciliation.stats,
	};
}

// Repo-relative-or-basename-only descriptor for snapshotFromReconciliation's sourceFile param --
// exported so bin/bskel.mjs doesn't need to duplicate the path.relative/outside-repo logic.
export function describeSourceFile(repoRoot, filePath) {
	const resolved = path.resolve(filePath);
	const rel = path.relative(repoRoot, resolved);
	const outsideRepo = rel.startsWith('..') || path.isAbsolute(rel);
	return { file: outsideRepo ? path.basename(resolved) : rel, outsideRepo };
}
