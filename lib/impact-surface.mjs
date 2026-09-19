// D-cross-feature-impact-graph (D3): a feature's own public-surface projection + field-level change
// detection, entirely git-independent (specs/ is commonly gitignored -- see D-contract-history's
// own finding, which is why `bskel contract history`'s git-diff approach cannot be reused here).
// *_shape_hash reuses lib/attest.mjs's canonicalization (K1) verbatim -- one implementation of
// "what does it mean for two JSON values to be the same", not a second one that could disagree.
import { readJsonIfExists, sha256File, sha256String, writeFileAtomic } from './fsutil.mjs';
import { specPath } from './paths.mjs';
import { validateAgainstSchema, formatSchemaErrors } from './schema-validate.mjs';
import { canonicalize, assertCanonicalizable } from './attest.mjs';
import { hydrateScanReportFilePaths } from './scan-report-paths.mjs';
import { loadFieldDependencies, listDownstreamDependents } from './field-dependencies.mjs';

const BASELINE_SCHEMA = 'sbf.impact-baseline/1';

function shapeHash(schema) {
	if (schema === undefined || schema === null || schema === false) return null;
	assertCanonicalizable(schema);
	return sha256String(canonicalize(schema));
}

function ownDisposedModule(root, featureId) {
	const report = hydrateScanReportFilePaths(readJsonIfExists(specPath(root, featureId, 'brownfield-scan.json')), root);
	if (!report) return null;
	const moduleName = report.disposition?.module ?? report.related_modules?.[0]?.module;
	if (!moduleName) return null;
	return report.related_modules?.find((m) => m.module === moduleName) ?? null;
}

// D-cross-feature-impact-graph (D3): the current-moment surface for one feature, built entirely
// from the already-emitted contract + already-persisted scan report + already-declared
// dependencies.json -- zero new source scanning, zero live DB, zero LLM.
export function computeSurface(root, featureId) {
	const contract = readJsonIfExists(specPath(root, featureId, 'contracts', `${featureId}.schema.json`));
	const operations = {};
	for (const [opId, op] of Object.entries(contract?.operations ?? {})) {
		operations[opId] = {
			verb: op.verb ?? null,
			path: op.path ?? null,
			request_shape_hash: shapeHash(op.requestBodySchema),
			response_shape_hash: shapeHash(op.responseSchema),
			error_shape_hash: shapeHash(op.errorSchema),
		};
	}

	const mod = ownDisposedModule(root, featureId);
	const classes = mod ? [...(mod.entities ?? []), ...(mod.dtos ?? [])] : [];
	const resources = {};
	for (const cls of classes) {
		resources[cls.className] = {
			file_sha256: cls.file ? sha256File(cls.file) : null,
			table: cls.table ?? null,
			table_source: cls.tableSource ?? null,
		};
	}

	// Deliberately sparse (D3's own stated limitation, mirroring D-field-dependency's EXIT): only
	// fields SOMETHING has already named -- there is no per-adapter field enumerator to draw the
	// full set from. Two directions, both needed: (a) fields THIS feature's own dependencies.json
	// names as a TARGET (so removing/moving the file it depends on shows up on ITS OWN surface, for
	// symmetry/debugging) and (b) fields OTHER features' dependencies.json name as THIS feature's
	// SOURCE (via listDownstreamDependents() -- the exact reverse lookup describeDownstreamImpact()
	// already uses) -- (b) is the one that actually matters for impact detection: it is what lets a
	// change on the UPSTREAM/source feature's own `impact check` see "a field of mine that a
	// downstream feature depends on just moved", not just the downstream feature seeing its own
	// dependency go stale. Missing (b) would mean `field_source_moved` could only ever appear on the
	// declaring (downstream) feature's own surface -- structurally unable to catch the upstream
	// change this whole item exists to gate on. Found and fixed while writing this module's own
	// headline test.
	const deps = loadFieldDependencies(root, featureId);
	const fields = {};
	for (const dep of deps.dependencies) {
		const resolved = classes.find((c) => c.className === dep.target.resourceType);
		fields[`${dep.target.resourceType}.${dep.target.fieldName}`] = {
			source_file_sha256: resolved?.file ? sha256File(resolved.file) : null,
		};
	}
	for (const { dep } of listDownstreamDependents(root, featureId)) {
		const key = `${dep.source.resourceType}.${dep.source.fieldName}`;
		if (key in fields) continue;
		const resolved = classes.find((c) => c.className === dep.source.resourceType);
		fields[key] = { source_file_sha256: resolved?.file ? sha256File(resolved.file) : null };
	}

	return { operations, resources, fields };
}

export function impactBaselinePath(root, featureId) {
	return specPath(root, featureId, 'impact-baseline.json');
}

export function loadBaseline(root, featureId) {
	const p = impactBaselinePath(root, featureId);
	const parsed = readJsonIfExists(p);
	if (parsed === null) return null;
	const { ok, errors } = validateAgainstSchema('impact-baseline.schema.json', parsed);
	if (!ok) throw new Error(`${p}: does not match schemas/impact-baseline.schema.json:\n${formatSchemaErrors(errors).join('\n')}`);
	return parsed;
}

export function saveBaseline(root, featureId, surface, { capturedAt = new Date().toISOString() } = {}) {
	const doc = { schema: BASELINE_SCHEMA, feature_id: featureId, captured_at: capturedAt, surface };
	const { ok, errors } = validateAgainstSchema('impact-baseline.schema.json', doc);
	if (!ok) throw new Error(`refusing to write an invalid impact baseline for "${featureId}":\n${formatSchemaErrors(errors).join('\n')}`);
	writeFileAtomic(impactBaselinePath(root, featureId), `${JSON.stringify(doc, null, 2)}\n`);
	return doc;
}

// D-cross-feature-impact-graph (D3): field-level change KINDS, not a full structural diff --
// naming what changed inside a subtree would need a real schema differ this project doesn't have
// (see D3's own EXIT, framing a future structural differ as an additive refinement). Deliberately
// no field_added/field_removed for the SAME reason computeSurface()'s `fields` is sparse: this
// project cannot honestly enumerate a resource's full field set, so it cannot honestly claim one
// was added or removed -- only that the file backing an ALREADY-DECLARED field moved
// (`field_source_moved`).
export function diffSurface(before, after) {
	const b = before ?? { operations: {}, resources: {}, fields: {} };
	const changes = [];

	const opIds = new Set([...Object.keys(b.operations ?? {}), ...Object.keys(after.operations ?? {})]);
	for (const opId of opIds) {
		const prev = b.operations?.[opId];
		const next = after.operations?.[opId];
		if (!next) { changes.push({ kind: 'operation_removed', subject: opId, from: prev, to: null }); continue; }
		if (!prev) { changes.push({ kind: 'operation_added', subject: opId, from: null, to: next }); continue; }
		if (prev.verb !== next.verb) changes.push({ kind: 'operation_verb_changed', subject: opId, from: prev.verb, to: next.verb });
		if (prev.path !== next.path) changes.push({ kind: 'operation_path_changed', subject: opId, from: prev.path, to: next.path });
		if (prev.request_shape_hash !== next.request_shape_hash) changes.push({ kind: 'operation_request_shape_changed', subject: opId, from: prev.request_shape_hash, to: next.request_shape_hash });
		if (prev.response_shape_hash !== next.response_shape_hash) changes.push({ kind: 'operation_response_shape_changed', subject: opId, from: prev.response_shape_hash, to: next.response_shape_hash });
		if (prev.error_shape_hash !== next.error_shape_hash) changes.push({ kind: 'operation_error_shape_changed', subject: opId, from: prev.error_shape_hash, to: next.error_shape_hash });
	}

	const resourceTypes = new Set([...Object.keys(b.resources ?? {}), ...Object.keys(after.resources ?? {})]);
	for (const type of resourceTypes) {
		const prev = b.resources?.[type];
		const next = after.resources?.[type];
		if (!next) { changes.push({ kind: 'resource_removed', subject: type, from: prev, to: null }); continue; }
		if (!prev) continue; // a brand-new resource has no downstream yet (nothing could depend on it before it existed)
		if (prev.table !== next.table) changes.push({ kind: 'resource_table_changed', subject: type, from: prev.table, to: next.table });
	}

	const fieldKeys = new Set([...Object.keys(b.fields ?? {}), ...Object.keys(after.fields ?? {})]);
	for (const key of fieldKeys) {
		const prev = b.fields?.[key];
		const next = after.fields?.[key];
		if (!prev || !next) continue; // add/remove of a declared-dependency field is covered by the dependency's own gate, not this one
		if (prev.source_file_sha256 !== next.source_file_sha256) changes.push({ kind: 'field_source_moved', subject: key, from: prev.source_file_sha256, to: next.source_file_sha256 });
	}

	return changes.map((c) => ({ ...c, change_key: changeKey(c) }));
}

// The anti-rubber-stamp key: embeds the NEW hash, so a disposition recorded for one shape can
// never cover a LATER, different change to the same subject -- there is no wildcard by
// construction, matching cross-feature-resolution.schema.json's own stated discipline.
export function changeKey(change) {
	const digest = sha256String(canonicalize({ kind: change.kind, subject: change.subject, to: change.to }));
	return `${change.kind}:${change.subject}:${digest.slice(0, 12)}`;
}
