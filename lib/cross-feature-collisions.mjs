// D-cross-feature-collision: detects NAME-identity collisions between features -- two DIFFERENT
// features whose scan reports declare the same resourceType/DTO className, the same DB table name,
// or the same contract operationId. Originally NOT a dependency-direction or FK claim (see
// lib/field-dependencies.mjs's own declared-dependency system for that, a separate, complementary
// concern) -- it existed because the runtime handle-resolver dispatch system (java-spring/python-
// fastapi/typescript-express, all three) already implicitly assumes resourceType is unique across
// a whole target repo, and nothing detected or protected against that assumption being silently
// violated before this. See DECISIONS.md for the full design and the real collision this was found
// against.
//
// D-cross-feature-fk-inference: closed this entry's own named EXIT item -- a 4th signal,
// `db_foreign_key`, correlates a REAL live Postgres foreign-key edge (Plane C,
// scanners/db/introspect.mjs) against which feature declares each side's table, reusing this same
// per-other-feature loop (ownClasses/otherClasses) rather than a new subsystem or a persisted
// "table -> feature" index. See resolveLiveTables()/findCollisions() below and DECISIONS.md.
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

// D-cross-feature-fk-inference (Plane A FK extraction): Plane A is strictly LOWER priority than
// any Plane C (live/persisted) source -- a migration FILE existing is not proof it was ever
// actually applied (D-migration-scope's own standing caveat), so Plane C is always more
// trustworthy when available. Migration files are repo-wide, not feature-scoped, so any ONE
// feature's persisted db_schema.migrations carries the same content as any other's -- "first one
// found" is sufficient, matching the persisted-live tier's own "first found" logic exactly.
function migrationsTables(dbSchema) {
	return dbSchema?.migrations?.tool && dbSchema.migrations.tool !== 'none' ? dbSchema.migrations.tables : null;
}

// D-cross-feature-fk-inference: resolves ONE usable live-table snapshot to correlate FK edges
// against, in four tiers (live > this feature's own persisted live > another feature's persisted
// live > migration-file-derived, Plane A). `liveDbSchema` is whatever the CLI boundary already
// resolved (the SAME resolveDbSchemaOrExit() result `cmdScan` itself uses -- this function never
// opens a connection itself). Plane C is already schema-wide (every table in `--schema`, not
// filtered to any one feature), so there is nothing to MERGE across features' own snapshots --
// locating one usable snapshot is enough; it already contains every table in that schema.
function resolveLiveTables(root, featureId, liveDbSchema) {
	if (liveDbSchema?.live) {
		return { tables: liveDbSchema.live.tables, fk_check: { mode: 'live', schema: liveDbSchema.live.schema, source_feature: null } };
	}
	const ownReport = readJsonIfExists(specPath(root, featureId, 'brownfield-scan.json'));
	if (ownReport?.db_schema?.live) {
		return { tables: ownReport.db_schema.live.tables, fk_check: { mode: 'persisted', schema: ownReport.db_schema.live.schema, source_feature: featureId } };
	}
	// Deterministic by feature_id sort order -- listFeatures() itself already returns records
	// sorted by directory name, so "first other feature with a persisted live snapshot" is a
	// stable, repeatable choice, not an arbitrary one. Reused below for the migrations tier too.
	const otherFeatures = listFeatures(root).filter((record) => record.feature_id !== featureId);
	for (const record of otherFeatures) {
		const otherReport = readJsonIfExists(specPath(root, record.feature_id, 'brownfield-scan.json'));
		if (otherReport?.db_schema?.live) {
			return { tables: otherReport.db_schema.live.tables, fk_check: { mode: 'persisted', schema: otherReport.db_schema.live.schema, source_feature: record.feature_id } };
		}
	}

	const liveDbSchemaMigrationsTables = migrationsTables(liveDbSchema);
	if (liveDbSchemaMigrationsTables) {
		return { tables: liveDbSchemaMigrationsTables, fk_check: { mode: 'migrations', schema: null, source_feature: null } };
	}
	const ownMigrationsTables = migrationsTables(ownReport?.db_schema);
	if (ownMigrationsTables) {
		return { tables: ownMigrationsTables, fk_check: { mode: 'migrations', schema: null, source_feature: featureId } };
	}
	for (const record of otherFeatures) {
		const otherReport = readJsonIfExists(specPath(root, record.feature_id, 'brownfield-scan.json'));
		const otherMigrationsTables = migrationsTables(otherReport?.db_schema);
		if (otherMigrationsTables) {
			return { tables: otherMigrationsTables, fk_check: { mode: 'migrations', schema: null, source_feature: record.feature_id } };
		}
	}

	return { tables: null, fk_check: { mode: 'unavailable', schema: null, source_feature: null } };
}

// Flattens Plane C's PER-TABLE foreign_keys[] (scanners/db/introspect.mjs) into one flat edge list
// -- {table, column, references_table, references_column}, `table` being the CONSTRAINED
// (child/referencing) side.
function flattenLiveForeignKeys(liveTables) {
	const edges = [];
	for (const t of liveTables) {
		for (const fk of t.foreign_keys ?? []) {
			edges.push({ table: t.name, column: fk.column, references_table: fk.references_table, references_column: fk.references_column });
		}
	}
	return edges;
}

// D-cross-feature-collision: the core comparison -- for the GIVEN feature's own disposed module,
// checks every OTHER active feature (listFeatures() excludes archived by default, same reasoning
// D-dependency-propagation-notice's own listDownstreamDependents() already established: an archived
// feature's naming collision isn't worth blocking a human over) for a resourceType/table/operationId
// match. One level only, symmetric-but-independent per feature -- feature B finding a collision
// against feature A does not automatically waive feature A's own, separate check against B (each
// feature's own cross-feature-resolution.json is its own record, matching contract waive's own
// per-feature-file precedent).
//
// D-cross-feature-fk-inference: `liveDbSchema` (optional, `null` by default -- callers that never
// pass it get the exact prior behavior for the first 3 signals, plus a `fk_check: {mode:
// 'unavailable', ...}` and possibly one `unknowns` entry) is the ALREADY-RESOLVED
// resolveDbSchemaOrExit() result. Returns {findings, fk_check, unknowns} -- a superset of the old
// bare array, not a rename; findings for the existing 3 signals are byte-identical to before.
export function findCollisions(root, featureId, { liveDbSchema = null } = {}) {
	const ownModule = ownDisposedModule(root, featureId);
	const ownClasses = ownModule ? [...(ownModule.entities ?? []), ...(ownModule.dtos ?? [])] : [];
	const ownOperationIdSet = new Set(ownOperationIds(root, featureId));

	const { tables: liveTables, fk_check } = resolveLiveTables(root, featureId, liveDbSchema);
	const liveEdges = liveTables ? flattenLiveForeignKeys(liveTables) : [];
	// This feature's own table -> entity map (case-folded), matching computeDbDrift()'s own
	// established case-folding convention (scanners/index.mjs).
	const ownTablesByName = new Map(ownClasses.filter((c) => c.table).map((c) => [c.table.toLowerCase(), c]));
	// Every table name (own + every OTHER feature seen) that matched SOME feature, accumulated
	// across the whole loop below -- used only to report FK edges touching an UNattributed table
	// (see the unknowns pass after the loop). In-memory, local to this one call -- not a new
	// persisted "table -> feature" index.
	const matchedTableNames = new Set(ownTablesByName.keys());

	const findings = [];
	for (const record of listFeatures(root)) {
		if (record.feature_id === featureId) continue;
		const otherModule = ownDisposedModule(root, record.feature_id);
		const otherClasses = otherModule ? [...(otherModule.entities ?? []), ...(otherModule.dtos ?? [])] : [];
		const otherTablesByName = new Map(otherClasses.filter((c) => c.table).map((c) => [c.table.toLowerCase(), c]));
		for (const name of otherTablesByName.keys()) matchedTableNames.add(name);

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

		// D-cross-feature-fk-inference: a real, live FK edge where ONE side is a table THIS
		// feature declares and the OTHER side is a table `record` declares. Confidence reuses the
		// exact `table` signal's own tableSource rule -- the FK itself is never in doubt (a live,
		// Postgres-enforced constraint), what's uncertain is whether the source-derived table name
		// on each side was a real annotation or an adapter's guessed fallback, the SAME risk the
		// `table` signal already scores this way. Self-referencing/same-feature edges never reach
		// here at all -- this only ever compares ownClasses against a DIFFERENT feature's classes.
		for (const edge of liveEdges) {
			const childName = edge.table.toLowerCase();
			const parentName = edge.references_table.toLowerCase();
			const identifier = `${edge.table}.${edge.column} -> ${edge.references_table}.${edge.references_column}`;

			if (ownTablesByName.has(childName) && otherTablesByName.has(parentName)) {
				const ownEntity = ownTablesByName.get(childName);
				const otherEntity = otherTablesByName.get(parentName);
				const confidence = ownEntity.tableSource === 'explicit' && otherEntity.tableSource === 'explicit' ? 'high' : 'medium';
				findings.push({ signal: 'db_foreign_key', identifier, other_feature: record.feature_id, confidence, direction: 'references' });
			}
			if (ownTablesByName.has(parentName) && otherTablesByName.has(childName)) {
				const ownEntity = ownTablesByName.get(parentName);
				const otherEntity = otherTablesByName.get(childName);
				const confidence = ownEntity.tableSource === 'explicit' && otherEntity.tableSource === 'explicit' ? 'high' : 'medium';
				findings.push({ signal: 'db_foreign_key', identifier, other_feature: record.feature_id, confidence, direction: 'referenced_by' });
			}
		}
	}

	// D-cross-feature-fk-inference: honest, explicit reporting for the two "no useful FK signal"
	// cases -- never a silent gap, matching this project's own repeated "no silent caps" discipline
	// (see D-db-schema-plane's own unknowns precedent for the same reasoning on a different check).
	const unknowns = [];
	if (liveTables) {
		for (const edge of liveEdges) {
			const childName = edge.table.toLowerCase();
			const parentName = edge.references_table.toLowerCase();
			const identifier = `${edge.table}.${edge.column} -> ${edge.references_table}.${edge.references_column}`;
			if (ownTablesByName.has(childName) && !matchedTableNames.has(parentName)) {
				unknowns.push(`FK ${identifier}: referenced table "${edge.references_table}" is not declared by any active feature (untracked/external table)`);
			} else if (ownTablesByName.has(parentName) && !matchedTableNames.has(childName)) {
				unknowns.push(`FK ${identifier}: referencing table "${edge.table}" is not declared by any active feature (untracked/external table)`);
			}
		}
	} else {
		unknowns.push('no live DB foreign-key data available to check -- pass --db --database-url-env <NAME> to `bskel scan cross-feature-check`, or run `bskel scan --feature <id> --db --database-url-env <NAME>` at least once to persist a snapshot this check can reuse');
	}

	return { findings, fk_check, unknowns };
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
