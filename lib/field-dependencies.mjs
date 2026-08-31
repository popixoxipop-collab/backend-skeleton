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
import { readJsonIfExists, writeFileAtomic } from './fsutil.mjs';
import { specPath } from './paths.mjs';
import { validateAgainstSchema, formatSchemaErrors } from './schema-validate.mjs';

const DEPENDENCIES_SCHEMA = 'sbf.field-dependency/1';

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
