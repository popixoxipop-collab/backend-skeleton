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
import { endpointKey } from './emit.mjs';

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_PATHS = 5000;
const MAX_OPERATIONS = 10000;
const HTTP_METHODS = Object.freeze(new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']));

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
export function indexOpenApiDocument(doc) {
	const byOperationId = new Map();
	const byRoute = new Map();
	const stats = { path_count: 0, operation_count: 0, skipped_path_refs: 0, rejected_operation_ids: 0 };

	const paths = doc.paths;
	if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) {
		return { ok: true, byOperationId, byRoute, stats, servers: [] };
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

			const entry = { verb, path: routeKey, operationId };

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

	return { ok: true, byOperationId, byRoute, stats, servers };
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
	const stats = { matched: 0, adopted: 0, drift: 0, missing: 0, ambiguous: 0, unresolved: 0 };

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

	return { byEndpoint, prefix, stats };
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
			servers: indexed.servers,
		},
		byEndpoint: recon.byEndpoint,
		prefix: recon.prefix,
		stats: recon.stats,
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
			};
		}
	}
	return {
		schema: 'sbf.openapi-snapshot/1',
		feature_id: featureId,
		generated_at: new Date().toISOString(),
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
			servers: reconciliation.document.servers,
		},
		path_prefix: reconciliation.prefix,
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
