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
// no source stated one, the key is still omitted, meaning "unspecified". Per-status responses,
// non-JSON media types, and operation `description` remain Phase 2 -- still always omitted, still
// disclosed as structural. Every omission is disclosed in prose (`info.description`) and
// machine-readably (`info.x-bskel-omitted`) rather than papered over -- see D-openapi-export and
// D-openapi-passthrough in DECISIONS.md.
import { createHash } from 'node:crypto';
import { BSKEL_GENERATED_EXTENSION, BSKEL_PASSTHROUGH_EXTENSION, PATH_PREFIX_RE } from './openapi.mjs';

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
// DERIVED (ANY-based) set collectOmissions() builds below. `descriptions` (field-level AND, still
// unbuilt, operation-level), `non-json-media-types`, and `per-status-responses` stay here -- all
// three are Phase 2, untouched by this item. Two new always-on entries: `path-parameter-schemas`
// (path-param schemas come from this contract's own name heuristic, never from a source document,
// even when --openapi-file was given -- see the real `batchRequestId` finding in
// D-openapi-passthrough) and `vendor-extensions` (x-* keys on an operation are never copied --
// excluded in principle, not by cap or failure, since their semantics are tool-specific).
const STRUCTURAL_OMISSIONS = Object.freeze([
	'descriptions',
	'non-json-media-types',
	'path-parameter-schemas',
	'per-status-responses',
	'vendor-extensions',
]);

const OMISSION_PROSE = Object.freeze({
	'cookie-parameters': 'cookie parameters, for at least one operation that does not carry a fully-copied set (never emitted at all when --openapi-file was not given, or the source document declared none)',
	descriptions: 'field-level descriptions/titles/examples (contracts/openapi.mjs drops them as DROPPED_KEYWORDS while inlining a schema), and operation-level `description` (not yet built -- Phase 2)',
	'error-schemas': 'a JSON error-body schema for at least one operation',
	'header-parameters': 'header parameters, for at least one operation that does not carry a fully-copied set (never emitted at all when --openapi-file was not given, or the source document declared none)',
	'non-json-media-types': 'request/response bodies in any media type other than application/json (multipart uploads in particular are invisible to the contract)',
	'path-parameter-schemas': 'path parameter schemas -- always derived from this contract\'s own name heuristic (a trailing "Id" is assumed to be a UUID), never from a source document even when --openapi-file was given; a real, small false-negative of this heuristic is known and disclosed, not fixed, by this projection',
	'per-status-responses': 'per-status responses -- the contract collapses every 2xx body into one union and every 4xx/5xx body into another, and records no status codes at all',
	'query-parameters': 'query parameters, for at least one operation that does not carry a fully-copied set (never emitted at all when --openapi-file was not given, or the source document declared none)',
	'request-body-schemas': 'a JSON request-body schema for at least one operation that takes a body',
	'response-schemas': 'a JSON success-body schema for at least one operation',
	security: 'security requirements and/or security schemes, for at least one operation -- `security` is emitted ONLY when a real source document (--openapi-file) stated one for that EXACT operation, byte-for-byte, including a literal `[]` (a genuine claim that no authentication is required); where no source document was given, or the source stated nothing for that operation, the key is omitted, meaning "unspecified", never invented',
	summaries: 'operation summaries, for at least one operation -- copied from a real source document when present, never synthesized from operationId or module names',
	tags: 'operation tags, for at least one operation -- copied verbatim from a real source document when present',
	'vendor-extensions': 'vendor extensions (`x-*` keys) on any operation -- copyable in principle, excluded because their semantics are tool-specific',
});

function hasSourceParamIn(op, loc) {
	return Array.isArray(op.sourceParameters) && op.sourceParameters.some((p) => p.in === loc);
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
	}
	return [...omissions].sort();
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
		statusCodes === 'literal'
			? 'Status codes: `200` is a bskel-chosen stand-in for "the documented success body". The source contract records no status codes whatsoever, so `200` here is NOT a claim that this operation returns 200. Re-export with `--status-codes range` for the spec-legal `2XX` range key, which invents nothing.'
			: 'Status codes: `2XX` and `default` are OpenAPI 3.1 range keys. They are used because the source contract records no status codes whatsoever, so any concrete code would be invented.',
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
function buildRequestBody(op) {
	if (op.requestBodySchema) {
		return {
			required: op.requestBodyRequired === true,
			content: { [JSON_MEDIA_TYPE]: { schema: op.requestBodySchema } },
		};
	}
	if (op.body === true) return { required: true, content: { [JSON_MEDIA_TYPE]: {} } };
	if (op.body === 'unknown') return { content: { [JSON_MEDIA_TYPE]: {} } };
	// op.body === false: the scan positively determined this operation takes no @RequestBody.
	return null;
}

// `range` (default) uses `2XX`/`default`, both legal per the official 3.1 meta-schema's own
// `responses` patternProperties (`^[1-5](?:[0-9]{2}|XX)$` plus an explicit `default` property) --
// verified by executing that schema, not assumed. `literal` uses `200`/`default` for tooling that
// cannot handle range keys, at the cost of a stand-in the contract cannot back up. An operation
// with neither a response nor an error schema gets NO `responses` key at all: 3.1 does not require
// one (`$defs.operation` has no `required` array -- also verified by execution), and `responses: {}`
// is illegal anyway (`minProperties: 1`). Omitting is both legal and honest; guessing a status
// would be neither.
function buildResponses(op, statusCodes) {
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
		// treated as present. `op.sourceSecurity` is never emitted when absent; `description` (the
		// operation-level field, not the response-object one) remains deliberately unset -- Phase 2.
		if (Array.isArray(op.sourceSecurity)) operation.security = op.sourceSecurity;
		if (op.sourceSummary) operation.summary = op.sourceSummary;
		if (Array.isArray(op.sourceTags) && op.sourceTags.length > 0) operation.tags = op.sourceTags;

		const hasPassthrough = Boolean(
			(Array.isArray(op.sourceParameters) && op.sourceParameters.length > 0)
			|| Array.isArray(op.sourceSecurity)
			|| op.sourceSummary
			|| (Array.isArray(op.sourceTags) && op.sourceTags.length > 0),
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
		// operation or unconditionally.
		literalStatusStandIn: statusCodes === 'literal' && Object.values(contract.operations).some((op) => Boolean(op.responseSchema)),
		// A7: lets cmdContractExport print its ONE mixed-coverage stderr note only when genuinely
		// warranted -- see D-openapi-passthrough.
		mixedPassthrough: passthroughMixed,
		passthroughWithoutCount,
	};
}
