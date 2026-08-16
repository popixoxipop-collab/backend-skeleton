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
const SUCCESS_STATUS_RE = /^2[0-9]{2}$/;
const ERROR_STATUS_RE = /^[45][0-9]{2}$/;

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

// inlineSchema()'s keyword policy: RECURSED keywords are walked into; ASSERTION keywords are
// copied verbatim (their values are scalars/arrays of scalars, not schema nodes -- nothing to
// recurse); DROPPED keywords carry no validation meaning and are silently discarded (their
// absence changes nothing about what a schema accepts); anything else fails that schema closed.
// The FORMAT set is checked separately (see inlineSchema's format handling) since `uuid` gets
// rewritten rather than either copied or dropped. A missing-and-therefore-fail-closed keyword is
// deliberate: silently dropping an assertion (e.g. an unrecognized `pattern`-like keyword) would
// emit a schema WEAKER than the real one, which is worse than emitting no schema at all -- see
// D-openapi-request-schema in DECISIONS.md.
const RECURSED_KEYWORDS = Object.freeze(new Set(['properties', 'items', 'additionalProperties', 'oneOf', 'anyOf', 'allOf']));
const COPIED_KEYWORDS = Object.freeze(new Set([
	'type', 'enum', 'const', 'required',
	'minLength', 'maxLength',
	'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
	'minItems', 'maxItems', 'uniqueItems',
	'minProperties', 'maxProperties',
]));
const DROPPED_KEYWORDS = Object.freeze(new Set(['description', 'title', 'example', 'examples', 'externalDocs', 'xml', 'deprecated']));
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
	const stats = {
		path_count: 0, operation_count: 0, skipped_path_refs: 0, rejected_operation_ids: 0,
		component_schema_count: 0, rejected_component_schemas: 0,
	};

	const openapiVersion = typeof doc.openapi === 'string' ? doc.openapi : null;
	const schemaDialectSupported = typeof openapiVersion === 'string' && /^3\.1(?:\.|$)/.test(openapiVersion);

	const rawComponentSchemas = doc.components && typeof doc.components === 'object' && !Array.isArray(doc.components)
		? doc.components.schemas
		: null;
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

	const paths = doc.paths;
	if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) {
		return { ok: true, byOperationId, byRoute, componentSchemas, stats, servers: [], openapiVersion, schemaDialectSupported };
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
			const entry = { verb, path: routeKey, operationId, requestBody, responses };

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

	return { ok: true, byOperationId, byRoute, componentSchemas, stats, servers, openapiVersion, schemaDialectSupported };
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
		// module doesn't attempt to MERGE $ref with a sibling assertion -- a DROPPED_KEYWORDS
		// sibling (e.g. a documentation-only `description`) is harmless and ignored; anything else
		// would need merge semantics this vertical slice doesn't implement, so it fails closed.
		const siblingKeys = Object.keys(node).filter((k) => k !== '$ref');
		if (siblingKeys.some((k) => !DROPPED_KEYWORDS.has(k))) fail('ref-with-siblings');
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
		try {
			return walkSchemaNode(target, componentSchemas, depth + 1, visiting, state, limits);
		} finally {
			// Delete-on-exit: a diamond (two sibling properties referencing the SAME component) stays
			// legal and is inlined independently for each -- only a true ancestor-chain cycle fails.
			visiting.delete(name);
		}
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
function applyRequestBodySchema(result, docEntry, componentSchemas, stats) {
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
	const resolved = inlineSchema(schemaNode, componentSchemas);
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
function projectResponseSchemas(responses, statusRe, componentSchemas) {
	if (!responses) return { outcome: 'none' };
	const statusKeys = Object.keys(responses);
	if (statusKeys.length > MAX_RESPONSES_PER_OPERATION) {
		return { outcome: 'unresolved', reason: 'too-many-responses' };
	}

	const rawNodesByKey = new Map();
	let sawContentWithoutJson = false;
	for (const status of statusKeys) {
		if (!statusRe.test(status)) continue;
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

	const resolvedByCanonical = new Map();
	for (const node of rawNodesByKey.values()) {
		const resolved = inlineSchema(node, componentSchemas);
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
function applyResponseSchemas(result, docEntry, componentSchemas, stats) {
	applyProjectionOutcome(result, projectResponseSchemas(docEntry.responses, SUCCESS_STATUS_RE, componentSchemas), stats, 'response');
	applyProjectionOutcome(result, projectResponseSchemas(docEntry.responses, ERROR_STATUS_RE, componentSchemas), stats, 'error');
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

// The core reconciliation, pure (no I/O). `module` is a scanReport related_modules entry (as
// selected by contracts/emit.mjs's selectModule -- caller's responsibility to pass the SAME
// selection buildContract() will use, so endpointKey(ci,ei) lines up). `pathPrefix`, if given
// (from --path-prefix), overrides inference entirely but the anchor pass still runs so its
// deltas are recorded for audit in the snapshot.
export function reconcileModule({ index, module, pathPrefix = null }) {
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
	};
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
							applyRequestBodySchema(result, docEntry, index.componentSchemas, stats);
							applyResponseSchemas(result, docEntry, index.componentSchemas, stats);
						}
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
						applyRequestBodySchema(result, hits[0], index.componentSchemas, stats);
						applyResponseSchemas(result, hits[0], index.componentSchemas, stats);
					}
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

	return { byEndpoint, prefix, stats, schemaProjection };
}

// Convenience entry point: load + index + reconcile in one call, propagating the first failure.
// This is what bin/bskel.mjs's cmdContractEmit calls.
export function buildReconciliation({ filePath, module, pathPrefix = null }) {
	if (pathPrefix != null && !PATH_PREFIX_RE.test(pathPrefix)) {
		return { ok: false, error: `--path-prefix "${pathPrefix}" is not a valid path prefix (expected e.g. "/api/v0")` };
	}
	const loaded = loadOpenApiDocument(filePath);
	if (!loaded.ok) return loaded;
	const indexed = indexOpenApiDocument(loaded.doc);
	if (!indexed.ok) return indexed;
	const recon = reconcileModule({ index: indexed, module, pathPrefix });
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
			openapi_version: indexed.openapiVersion,
			servers: indexed.servers,
		},
		byEndpoint: recon.byEndpoint,
		prefix: recon.prefix,
		stats: recon.stats,
		schemaProjection: recon.schemaProjection,
	};
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
