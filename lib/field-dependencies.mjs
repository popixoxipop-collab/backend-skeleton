// D-field-dependency: declares that a field on one feature's resource is derived from a field on
// some (possibly the same) feature's resource, tracked via the same disk-hash gate mechanism every
// other gate in this project uses. See DECISIONS.md for the full design.
//
// Zero new source-scanning logic: a resource "field" resolves to a FILE the same way
// lib/gate-definitions.mjs's `contract.recompute()` already resolves one -- via a feature's own
// persisted brownfield-scan.json `related_modules[].{entities,dtos}[]`, both already `{className,
// file}` on every adapter (D-gate-precision "Continued (part 3)", commit a8d647b). This module's
// resolveClassFile() is the ONE function both `bskel dependency declare`'s validation and the
// `dependencies` gate's recompute() call -- never two separately-maintained copies, so the token
// that gets passed and the token later required can never diverge.
import path from 'node:path';
import { readJsonIfExists, writeFileAtomic } from './fsutil.mjs';
import { specPath } from './paths.mjs';
import { validateAgainstSchema, formatSchemaErrors } from './schema-validate.mjs';
import { listFeatures, loadFeatureFile } from './featurelifecycle.mjs';
import { passNamedGate, requireNamedGate } from './gates.mjs';
import { withLockSync } from './lock.mjs';
import { requireValidFeatureId, slugWords } from './featureid.mjs';
import { EXIT_CODES } from './exit-codes.mjs';

const DEPENDENCIES_SCHEMA = 'sbf.field-dependency/1';

// D-http-serving-layer: thrown by declareDependency/removeDependency/buildDependencyListReport
// instead of calling bin/bskel.mjs's fail() (which calls process.exit() and can't be shared between
// a CLI caller and an HTTP caller). Carries both an HTTP status AND the existing CLI exit-code/reason
// vocabulary (lib/exit-codes.mjs) so a caller on either side derives its own response shape from the
// SAME thrown error, rather than the CLI/HTTP paths each re-deciding "what does this failure mean"
// independently and risking disagreement.
export class DependencyOperationError extends Error {
	constructor(message, { httpStatus = 400, exitCode = EXIT_CODES.BAD_ARGS, reasonCode = 'BAD_ARGS' } = {}) {
		super(message);
		this.name = 'DependencyOperationError';
		this.httpStatus = httpStatus;
		this.exitCode = exitCode;
		this.reasonCode = reasonCode;
	}
}

// D-http-serving-layer: requireValidFeatureId() throws a plain Error (it's a low-level primitive
// shared by many OTHER commands too, so its own throw shape is deliberately left unchanged) -- an
// uncaught plain Error reaching lib/http-server.mjs's handler would map to a misleading 500 instead
// of the 400 a malformed feature id actually deserves. This rewraps it as a DependencyOperationError
// right at the point of use, matching this module's own consistent error vocabulary end to end.
function requireValidFeatureIdOr400(id) {
	try {
		requireValidFeatureId(id);
	} catch (err) {
		throw new DependencyOperationError(err.message, { httpStatus: 400, exitCode: EXIT_CODES.BAD_ARGS, reasonCode: 'BAD_ARGS' });
	}
}

// A resolveClassFile() failure, translated into the (httpStatus, exitCode, reasonCode) triple --
// 'no_scan_report' is a real prerequisite-not-established state (409/NOT_PASSED, matching the exact
// ternary bin/bskel.mjs's cmdDependencyDeclare used before this was extracted); every other reason is
// a genuine bad argument (400/BAD_ARGS).
function resolutionFailureErrorOptions(resolution) {
	return resolution.reason === 'no_scan_report'
		? { httpStatus: 409, exitCode: EXIT_CODES.NOT_PASSED, reasonCode: 'MISSING_ARTIFACT' }
		: { httpStatus: 400, exitCode: EXIT_CODES.BAD_ARGS, reasonCode: 'BAD_ARGS' };
}

// D-field-dependency: shared error-message builder for resolveClassFile()'s own failure reasons --
// used by both declare (target and source resolution) so the two error paths never phrase the same
// underlying failure differently. Mirrors requireWarningCode's "known codes: ..." naming convention
// for the one case (class_not_found) where naming the real alternatives is actionable. Moved here
// (was bin/bskel.mjs) alongside declareDependency, its only caller.
export function describeResolutionFailure(featureId, resourceType, resolution) {
	switch (resolution.reason) {
		case 'no_scan_report':
			return `no brownfield-scan.json for feature "${featureId}" -- run \`bskel scan --feature ${featureId} --terms <a,b,c>\` first`;
		case 'no_disposition':
			return `feature "${featureId}" has no scan disposition yet -- run \`bskel scan disposition --feature ${featureId} --mode reuse|extend|replace|parallel --note "..."\` first`;
		case 'module_not_found':
			return `feature "${featureId}"'s disposed module no longer appears in its own scan report -- re-run \`bskel scan\`/\`bskel scan disposition\``;
		case 'class_not_found':
			return `no resource type "${resourceType}" found in feature "${featureId}"'s disposed module -- known classes: ${resolution.knownClasses?.join(', ') || '(none)'}`;
		default:
			return `could not resolve "${resourceType}" on feature "${featureId}"`;
	}
}

export function dependenciesPath(root, featureId) {
	return specPath(root, featureId, 'dependencies.json');
}

export function loadFieldDependencies(root, featureId) {
	const path = dependenciesPath(root, featureId);
	const parsed = readJsonIfExists(path);
	if (parsed === null) return { schema: DEPENDENCIES_SCHEMA, feature_id: featureId, dependencies: [] };
	const { ok, errors } = validateAgainstSchema('field-dependency.schema.json', parsed);
	if (!ok) {
		throw new Error(`${path}: does not match schemas/field-dependency.schema.json:\n${formatSchemaErrors(errors).join('\n')}`);
	}
	return parsed;
}

export function saveFieldDependencies(root, featureId, doc) {
	const { ok, errors } = validateAgainstSchema('field-dependency.schema.json', doc);
	if (!ok) {
		throw new Error(`refusing to write invalid field dependencies for "${featureId}":\n${formatSchemaErrors(errors).join('\n')}`);
	}
	writeFileAtomic(dependenciesPath(root, featureId), `${JSON.stringify(doc, null, 2)}\n`);
	return doc;
}

// The one, shared identity key -- edge-level, not target-level, since a target field CAN
// legitimately have more than one source (e.g. a computed/concatenated field) -- unlike
// patch-approvals' {resource,field} key, which is 1:1 by construction.
export function dependencyKey(dep) {
	return `${dep.target.resourceType}::${dep.target.fieldName}->${dep.source.feature}::${dep.source.resourceType}::${dep.source.fieldName}`;
}

// Resolves a {featureId, resourceType} pair to the real source file backing it, via that
// feature's own disposed module's entities/dtos -- exactly the lookup contract.recompute() already
// does for its own module_file: tokens, just reusable across features instead of within one.
// Deliberately excludes controllers/enums: a controller isn't "a resource with fields" in the
// relevant sense, and an enum's "fields" are its constants, a structurally different concept this
// slice doesn't address.
export function resolveClassFile(root, featureId, resourceType) {
	const reportPath = specPath(root, featureId, 'brownfield-scan.json');
	const report = readJsonIfExists(reportPath);
	if (!report) return { file: null, reason: 'no_scan_report' };
	const moduleName = report.disposition?.module ?? report.related_modules?.[0]?.module;
	if (!moduleName) return { file: null, reason: 'no_disposition' };
	const mod = report.related_modules?.find((m) => m.module === moduleName);
	if (!mod) return { file: null, reason: 'module_not_found' };
	const candidates = [...(mod.entities ?? []), ...(mod.dtos ?? [])];
	const match = candidates.find((item) => item.className === resourceType);
	if (!match?.file) return { file: null, reason: 'class_not_found', knownClasses: candidates.map((c) => c.className) };
	return { file: match.file, reason: null };
}

// D-dependency-propagation-notice: the reverse of resolveClassFile()'s own forward lookup -- "who
// else declared a dependency ON this feature" instead of "what does this feature's dependency point
// at". Used by `contract emit`/`handles emit` (bin/bskel.mjs's describeDownstreamImpact()) to warn
// the SOURCE side that other features are relying on what it's about to re-derive. One level only --
// no recursive graph walk, matching this whole feature's own explicit non-goal of full cycle
// detection (see D-field-dependency). listFeatures() is lib/featurelifecycle.mjs's schema-validated,
// archived-filtering version (not lib/workflow.mjs's bare directory scan) -- an archived feature's
// stale dependency isn't worth nagging a human about.
export function listDownstreamDependents(root, featureId) {
	const dependents = [];
	for (const record of listFeatures(root)) {
		if (record.feature_id === featureId) continue;
		const doc = loadFieldDependencies(root, record.feature_id);
		for (const dep of doc.dependencies) {
			if (dep.source.feature === featureId) dependents.push({ dependentFeature: record.feature_id, dep });
		}
	}
	return dependents;
}

// D-http-serving-layer: the mutation core of `bskel dependency declare`, extracted so `bin/bskel.mjs`'s
// cmdDependencyDeclare (CLI) and lib/http-server.mjs's POST handler call the IDENTICAL code -- never
// two separately-maintained copies of "what does declaring a dependency actually do" that could
// drift, the same principle resolveClassFile()'s own header comment already establishes for itself.
// Throws DependencyOperationError on any failure; the CLI wrapper maps that back to fail(), the HTTP
// handler maps it to a JSON error response -- both derive their own response shape from the SAME
// thrown error rather than re-deciding independently.
export function declareDependency(root, { feature, resource, field, sourceFeature, sourceResource, sourceField, reason, memo }) {
	requireValidFeatureIdOr400(feature);
	requireValidFeatureIdOr400(sourceFeature); // path-injection defense, same as every --feature flag (D-security-3)
	if (!reason || !reason.trim()) {
		throw new DependencyOperationError('bskel dependency declare requires --reason "..." -- every dependency must be auditable', { httpStatus: 400, exitCode: EXIT_CODES.BAD_ARGS, reasonCode: 'BAD_ARGS' });
	}
	if (feature === sourceFeature && resource === sourceResource && field === sourceField) {
		throw new DependencyOperationError(`"${resource}.${field}" cannot depend on itself`, { httpStatus: 400, exitCode: EXIT_CODES.BAD_ARGS, reasonCode: 'BAD_ARGS' });
	}

	const target = resolveClassFile(root, feature, resource);
	if (!target.file) {
		throw new DependencyOperationError(describeResolutionFailure(feature, resource, target), resolutionFailureErrorOptions(target));
	}
	const source = resolveClassFile(root, sourceFeature, sourceResource);
	if (!source.file) {
		throw new DependencyOperationError(describeResolutionFailure(sourceFeature, sourceResource, source), resolutionFailureErrorOptions(source));
	}

	const dep = {
		target: { resourceType: resource, fieldName: field },
		source: { feature: sourceFeature, resourceType: sourceResource, fieldName: sourceField },
		reason,
		...(memo ? { memo } : {}),
		at: new Date().toISOString(),
	};

	// S5 (D-persistence-integrity): same load-modify-save-under-one-lock shape cmdContractWaive
	// already uses, for the identical reason -- closes the lost-update race between this function's
	// own load and its save. Safe under concurrent HTTP requests too: withLockSync is fully
	// synchronous (fs.mkdirSync + a blocking retry loop, no `await` anywhere inside), and Node's
	// single-threaded event loop means a request handler runs to completion without ever yielding to
	// a second concurrently-arriving request -- verified directly against lib/lock.mjs, not assumed.
	const updated = withLockSync(root, 'state', () => {
		const current = loadFieldDependencies(root, feature);
		const key = dependencyKey(dep);
		const next = {
			schema: 'sbf.field-dependency/1',
			feature_id: feature,
			dependencies: [...current.dependencies.filter((d) => dependencyKey(d) !== key), dep],
		};
		saveFieldDependencies(root, feature, next);
		return next;
	});
	const gateState = passNamedGate(root, 'dependencies', feature, { dependency_count: updated.dependencies.length });
	return { dependency: dep, gate: gateState.gates.dependencies };
}

// D-http-serving-layer: the mutation core of `bskel dependency remove`, mirroring declareDependency's
// own shared-primitive rationale above.
export function removeDependency(root, { feature, resource, field, sourceFeature, sourceResource, sourceField, reason }) {
	requireValidFeatureIdOr400(feature);
	requireValidFeatureIdOr400(sourceFeature);
	if (!reason || !reason.trim()) {
		throw new DependencyOperationError('bskel dependency remove requires --reason "..." -- every removal must be auditable', { httpStatus: 400, exitCode: EXIT_CODES.BAD_ARGS, reasonCode: 'BAD_ARGS' });
	}

	const targetKey = dependencyKey({
		target: { resourceType: resource, fieldName: field },
		source: { feature: sourceFeature, resourceType: sourceResource, fieldName: sourceField },
	});

	const updated = withLockSync(root, 'state', () => {
		const current = loadFieldDependencies(root, feature);
		const match = current.dependencies.find((d) => dependencyKey(d) === targetKey);
		if (!match) {
			const known = current.dependencies.map((d) => `${d.target.resourceType}.${d.target.fieldName} <- ${d.source.feature}/${d.source.resourceType}.${d.source.fieldName}`);
			throw new DependencyOperationError(
				`no declared dependency matches "${resource}.${field} <- ${sourceFeature}/${sourceResource}.${sourceField}" -- currently declared: ${known.join('; ') || '(none)'}`,
				{ httpStatus: 400, exitCode: EXIT_CODES.BAD_ARGS, reasonCode: 'BAD_ARGS' },
			);
		}
		const next = {
			schema: 'sbf.field-dependency/1',
			feature_id: feature,
			dependencies: current.dependencies.filter((d) => dependencyKey(d) !== targetKey),
		};
		saveFieldDependencies(root, feature, next);
		return next;
	});
	const gateState = passNamedGate(root, 'dependencies', feature, { dependency_count: updated.dependencies.length });
	return { removed: true, gate: gateState.gates.dependencies };
}

// D-http-serving-layer: the read core of `bskel dependency list`, mirroring the two mutation
// functions' own shared-primitive rationale. Read-only, gate-independent like cmdHandlesAudit --
// always resolves current state (even past whatever token the gate itself last stored) so a diverged
// dependency is visible here immediately, not only after the next explicit `gate require`.
export function buildDependencyListReport(root, featureId) {
	requireValidFeatureIdOr400(featureId);
	const record = loadFeatureFile(root, featureId);
	if (!record) {
		throw new DependencyOperationError(
			`no feature.json at specs/${featureId}/ -- run \`bskel feature init --slug ${slugWords(featureId).join('-')}\` first (or hand-write specs/${featureId}/feature.json with a minted feature_uid)`,
			{ httpStatus: 404, exitCode: EXIT_CODES.NOT_PASSED, reasonCode: 'MISSING_ARTIFACT' },
		);
	}
	const doc = loadFieldDependencies(root, featureId);

	const rows = doc.dependencies.map((dep) => {
		const t = resolveClassFile(root, featureId, dep.target.resourceType);
		const s = resolveClassFile(root, dep.source.feature, dep.source.resourceType);
		return {
			...dep,
			target_resolved: Boolean(t.file),
			target_file: t.file ? path.relative(root, t.file) : null,
			target_unresolved_reason: t.reason,
			source_resolved: Boolean(s.file),
			source_file: s.file ? path.relative(root, s.file) : null,
			source_unresolved_reason: s.reason,
		};
	});
	const gateResult = requireNamedGate(root, 'dependencies', featureId);

	return {
		schema: 'sbf.dependency-list/1',
		feature_id: featureId,
		dependencies: rows,
		gate: { status: gateResult.status, code: gateResult.code, changed_inputs: gateResult.changed_inputs ?? null },
	};
}

// D-http-serving-layer: these two prefixes MUST stay byte-identical to lib/gate-definitions.mjs's own
// TARGET_FIELD_FILE_PREFIX/SOURCE_FIELD_FILE_PREFIX constants -- duplicated here (2 short string
// literals) rather than exported+imported, the same tradeoff lib/workflow.mjs's own
// awaitingDispositionCommand() already documents for itself ("duplicated here rather than
// exported+imported... for two lines of text"). If gate-definitions.mjs's own tokens ever change,
// this must change with them.
const TARGET_FIELD_FILE_PREFIX = 'target_field_file:';
const SOURCE_FIELD_FILE_PREFIX = 'source_field_file:';

// D-http-serving-layer: the repo-wide aggregate lib/http-server.mjs's `GET /api/graph` serves --
// every distinct {feature, resourceType} pair that participates in ANY declared dependency (a
// resource is only "on the graph" because it has a real wire, not an independent "list every scanned
// class" feature nothing else asks for), plus one wire per declared dependency with a HONEST 3-value
// `resolution` ('synced'/'stale'/'unresolved') grounded in what's actually computable -- this does
// NOT recreate the original Fieldwire UI mockup's 4-state vocabulary (its 'conflict' state meant a
// type-mismatch/propagation decision this backend has no data for). Per-edge attribution reuses the
// SAME changed_inputs-prefix-matching precision bin/bskel.mjs's describeDownstreamImpact() (Slice 2)
// already established, so a feature stale for one dependency's reason never marks an unrelated
// dependency 'stale' too.
export function buildDependencyGraph(root) {
	const nodes = new Map();
	const wires = [];

	const nodeFor = (featureId, resourceType) => {
		const key = `${featureId}::${resourceType}`;
		if (!nodes.has(key)) {
			const r = resolveClassFile(root, featureId, resourceType);
			nodes.set(key, { id: key, feature: featureId, resourceType, file: r.file ? path.relative(root, r.file) : null, resolved: Boolean(r.file) });
		}
		return key;
	};

	for (const record of listFeatures(root)) {
		const doc = loadFieldDependencies(root, record.feature_id);
		if (doc.dependencies.length === 0) continue;
		const gate = requireNamedGate(root, 'dependencies', record.feature_id);
		const changedInputs = new Set(gate.changed_inputs ?? []);

		for (const dep of doc.dependencies) {
			const targetNode = nodeFor(record.feature_id, dep.target.resourceType);
			const sourceNode = nodeFor(dep.source.feature, dep.source.resourceType);
			const t = resolveClassFile(root, record.feature_id, dep.target.resourceType);
			const s = resolveClassFile(root, dep.source.feature, dep.source.resourceType);

			let resolution = 'synced';
			let unresolvedSide = null;
			let unresolvedReason = null;
			if (!t.file) { resolution = 'unresolved'; unresolvedSide = 'target'; unresolvedReason = t.reason; }
			else if (!s.file) { resolution = 'unresolved'; unresolvedSide = 'source'; unresolvedReason = s.reason; }
			else if (gate.status === 'stale') {
				const targetKey = `${TARGET_FIELD_FILE_PREFIX}${dep.target.resourceType}`;
				const sourceKey = `${SOURCE_FIELD_FILE_PREFIX}${dep.source.feature}:${dep.source.resourceType}`;
				if (changedInputs.has(targetKey) || changedInputs.has(sourceKey)) resolution = 'stale';
			}

			wires.push({
				id: `${targetNode}->${sourceNode}::${dep.target.fieldName}->${dep.source.fieldName}`,
				feature: record.feature_id,
				target: dep.target,
				source: dep.source,
				reason: dep.reason,
				memo: dep.memo ?? null,
				hasMemo: Boolean(dep.memo),
				at: dep.at,
				resolution,
				unresolvedSide,
				unresolvedReason,
			});
		}
	}

	return { nodes: [...nodes.values()], wires };
}
