// D-cross-feature-collision: detects NAME-identity collisions between features -- two DIFFERENT
// features whose scan reports declare the same resourceType/DTO className, the same DB table name,
// or the same contract operationId. This is NOT a dependency-direction or FK claim (see
// lib/field-dependencies.mjs's own declared-dependency system for that, a separate, complementary
// concern) -- it exists because the runtime handle-resolver dispatch system (java-spring/python-
// fastapi/typescript-express, all three) already implicitly assumes resourceType is unique across
// a whole target repo, and nothing detected or protected against that assumption being silently
// violated before this. See DECISIONS.md for the full design and the real collision this was found
// against.
import { readJsonIfExists, writeFileAtomic } from './fsutil.mjs';
import { specPath } from './paths.mjs';
import { validateAgainstSchema, formatSchemaErrors } from './schema-validate.mjs';
import { listFeatures } from './featurelifecycle.mjs';

const REPORT_SCHEMA = 'sbf.cross-feature-report/1';
const RESOLUTION_SCHEMA = 'sbf.cross-feature-resolution/1';

export function crossFeatureReportPath(root, featureId) {
	return specPath(root, featureId, 'cross-feature-report.json');
}

export function crossFeatureResolutionPath(root, featureId) {
	return specPath(root, featureId, 'cross-feature-resolution.json');
}

// Reads the PERSISTED report from the last `bskel scan cross-feature-check` run -- `bskel scan
// cross-feature-waive` validates against this snapshot, never a live re-computation, matching
// `contract waive`'s own established precedent (contracts/completeness.mjs's loadContract): a
// waiver targets what was actually reported, and if reality has moved since, the gate's own
// staleness token (which already covers every OTHER feature named in this same report) is what
// surfaces that, not a silent re-check inside the waive command itself.
export function loadCrossFeatureReport(root, featureId) {
	return readJsonIfExists(crossFeatureReportPath(root, featureId));
}

export function loadCrossFeatureResolution(root, featureId) {
	const path = crossFeatureResolutionPath(root, featureId);
	const parsed = readJsonIfExists(path);
	if (parsed === null) return { schema: RESOLUTION_SCHEMA, feature_id: featureId, waivers: [] };
	const { ok, errors } = validateAgainstSchema('cross-feature-resolution.schema.json', parsed);
	if (!ok) {
		throw new Error(`${path}: does not match schemas/cross-feature-resolution.schema.json:\n${formatSchemaErrors(errors).join('\n')}`);
	}
	return parsed;
}

export function saveCrossFeatureResolution(root, featureId, resolution) {
	const { ok, errors } = validateAgainstSchema('cross-feature-resolution.schema.json', resolution);
	if (!ok) {
		throw new Error(`refusing to write an invalid cross-feature resolution for "${featureId}":\n${formatSchemaErrors(errors).join('\n')}`);
	}
	writeFileAtomic(crossFeatureResolutionPath(root, featureId), `${JSON.stringify(resolution, null, 2)}\n`);
	return resolution;
}

// The waiver key -- deliberately signal+identifier+other_feature only, never a message/reason, so
// rephrasing a --reason later never silently stops a waiver from matching (same discipline
// contracts/completeness.mjs's own warningKey() already established).
export function waiverKey(w) {
	return `${w.signal}::${w.identifier}::${w.other_feature}`;
}

// Own-module accessors -- reads THIS feature's own disposed module (className list + table names),
// mirroring resolveClassFile()'s own lookup shape (lib/field-dependencies.mjs) but returning every
// candidate at once instead of resolving one resourceType.
function ownDisposedModule(root, featureId) {
	const report = readJsonIfExists(specPath(root, featureId, 'brownfield-scan.json'));
	if (!report) return null;
	const moduleName = report.disposition?.module ?? report.related_modules?.[0]?.module;
	if (!moduleName) return null;
	return report.related_modules?.find((m) => m.module === moduleName) ?? null;
}

function ownOperationIds(root, featureId) {
	const contract = readJsonIfExists(specPath(root, featureId, 'contracts', `${featureId}.schema.json`));
	return contract ? Object.keys(contract.operations ?? {}) : [];
}

// D-cross-feature-collision: the core comparison -- for the GIVEN feature's own disposed module,
// checks every OTHER active feature (listFeatures() excludes archived by default, same reasoning
// D-dependency-propagation-notice's own listDownstreamDependents() already established: an archived
// feature's naming collision isn't worth blocking a human over) for a resourceType/table/operationId
// match. One level only, symmetric-but-independent per feature -- feature B finding a collision
// against feature A does not automatically waive feature A's own, separate check against B (each
// feature's own cross-feature-resolution.json is its own record, matching contract waive's own
// per-feature-file precedent).
export function findCollisions(root, featureId) {
	const ownModule = ownDisposedModule(root, featureId);
	const ownClasses = ownModule ? [...(ownModule.entities ?? []), ...(ownModule.dtos ?? [])] : [];
	const ownOperationIdSet = new Set(ownOperationIds(root, featureId));

	const findings = [];
	for (const record of listFeatures(root)) {
		if (record.feature_id === featureId) continue;
		const otherModule = ownDisposedModule(root, record.feature_id);
		const otherClasses = otherModule ? [...(otherModule.entities ?? []), ...(otherModule.dtos ?? [])] : [];

		for (const ownClass of ownClasses) {
			const match = otherClasses.find((c) => c.className === ownClass.className);
			if (match) {
				findings.push({ signal: 'resource_type', identifier: ownClass.className, other_feature: record.feature_id, confidence: 'high' });
			}
		}

		// Table names: only compared when BOTH sides actually have one (a class with no table --
		// e.g. a DTO, or an entity with no @Table and no fallback -- has nothing to collide on).
		// Case-folded for comparison, matching computeDbDrift()'s own established convention
		// (scanners/index.mjs) -- the ONE place in this codebase that already case-folds a `.table`
		// value before comparing it.
		for (const ownEntity of ownClasses.filter((c) => c.table)) {
			const match = otherClasses.find((c) => c.table && c.table.toLowerCase() === ownEntity.table.toLowerCase());
			if (match) {
				const confidence = ownEntity.tableSource === 'explicit' && match.tableSource === 'explicit' ? 'high' : 'medium';
				findings.push({ signal: 'table', identifier: ownEntity.table.toLowerCase(), other_feature: record.feature_id, confidence });
			}
		}

		const otherOperationIds = ownOperationIds(root, record.feature_id);
		for (const opId of ownOperationIdSet) {
			if (otherOperationIds.includes(opId)) {
				findings.push({ signal: 'operation_id', identifier: opId, other_feature: record.feature_id, confidence: 'high' });
			}
		}
	}
	return findings;
}

// Mirrors contracts/completeness.mjs's own evaluateResolution() exactly, for a different axis:
// there, the split is by warning SEVERITY (error vs warn); here, it's by finding CONFIDENCE (high
// vs medium) -- only a `high`-confidence, unwaived finding blocks. A `medium`-confidence finding
// (an inferred/guessed table name on at least one side) is always reported, never blocking on its
// own -- the named mitigation for python-fastapi/typescript-express's own table-name-guessing false-
// match risk (see DECISIONS.md), not a silently dropped signal.
export function evaluateCrossFeatureFindings(findings, resolution) {
	const waivers = resolution.waivers ?? [];
	const waivedKeys = new Set(waivers.map(waiverKey));

	const highConfidence = findings.filter((f) => f.confidence === 'high');
	const unwaived = highConfidence.filter((f) => !waivedKeys.has(waiverKey(f)));
	const waived = highConfidence.filter((f) => waivedKeys.has(waiverKey(f)));

	const currentKeys = new Set(findings.map(waiverKey));
	const staleWaivers = waivers.filter((w) => !currentKeys.has(waiverKey(w)));

	return { blocking: unwaived.length > 0, unwaived, waived, staleWaivers };
}
