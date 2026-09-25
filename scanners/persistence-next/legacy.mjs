import {
	createPersistenceIr,
	makeSourceRef,
	normalizeRelation,
	sourcePath,
} from './ir.mjs';

const LEGACY_PROVIDERS = new Set(['java-spring', 'python-fastapi', 'typescript-express', 'ruby-rails']);

function primaryKeyType(provider, entity) {
	if (!entity.idField) return 'unknown';
	if (provider === 'java-spring' && entity.idFieldType) return entity.idFieldType;
	if (entity.idFieldIsUuid === true) return 'uuid';
	if (entity.idFieldIsUuid === false) return 'non-uuid';
	return 'unknown';
}

function flattenScanEntities(scan) {
	const rows = [];
	for (const module of scan?.modules ?? []) {
		for (const entity of module?.entities ?? []) rows.push({ module: module.module ?? null, entity });
	}
	return rows;
}

export function fromLegacyAdapterScan({ adapterId, scan, repoRoot = null }) {
	if (!LEGACY_PROVIDERS.has(adapterId)) throw new TypeError(`unsupported legacy persistence provider: ${adapterId}`);
	const diagnostics = [];
	const entities = flattenScanEntities(scan).map(({ module, entity }) => {
		const file = sourcePath(entity.file ?? null, repoRoot);
		const tableSource = entity.tableSource === 'explicit' ? 'explicit'
			: entity.tableSource === 'inferred' ? 'inferred' : 'unknown';
		const tableName = entity.table ?? null;
		if (!tableName) diagnostics.push({
			code: 'table-name-unknown',
			level: 'info',
			entity: entity.className,
			message: `${entity.className} has no trustworthy physical table name in the legacy scan`,
		});
		const pkColumns = entity.idField ? [entity.idField] : [];
		if (pkColumns.length === 0) diagnostics.push({
			code: 'primary-key-unknown', level: 'info', entity: entity.className,
			message: `${entity.className} has no primary-key field in the legacy scan`,
		});
		return {
			provider: adapterId,
			name: entity.className,
			module,
			file,
			table: { name: tableName, schema: null, source: tableSource },
			primary_key: { columns: pkColumns, type: primaryKeyType(adapterId, entity), source: pkColumns.length ? 'source' : 'unknown' },
			fields: pkColumns.map((name) => ({ name, type: entity.idFieldType ?? null, nullable: null, source: 'source' })),
			relations: [],
			source_refs: [makeSourceRef({ kind: 'source', provider: adapterId, file, line: entity.line ?? null, detail: 'legacy adapter entity' })],
		};
	});
	return createPersistenceIr({
		provider: adapterId,
		source_kind: 'source',
		entities,
		diagnostics,
		metadata: { bridge: 'legacy-adapter-scan', files_read: scan?.filesRead ?? [] },
	});
}

function mergeMigrationTables(migrations) {
	const merged = new Map();
	for (const table of migrations?.tables ?? []) {
		if (!merged.has(table.name)) merged.set(table.name, {
			name: table.name,
			columns: new Set(),
			relations: [],
			sourceFiles: new Set(),
		});
		const out = merged.get(table.name);
		for (const column of table.columns ?? []) out.columns.add(column);
		for (const fk of table.foreign_keys ?? []) {
			out.relations.push(normalizeRelation({
				columns: [fk.column],
				references_table: fk.references_table,
				references_columns: fk.references_column ? [fk.references_column] : [],
				pairing: fk.references_column ? 'resolved' : 'unknown',
				source: 'migration',
			}));
		}
		if (table.source_file) out.sourceFiles.add(table.source_file);
	}
	return [...merged.values()];
}

export function fromMigrationScan(migrations) {
	const provider = migrations?.tool && migrations.tool !== 'none' ? `migration:${migrations.tool}` : 'migration:none';
	const entities = mergeMigrationTables(migrations).map((table) => ({
		provider,
		name: table.name,
		module: null,
		file: null,
		table: { name: table.name, schema: null, source: 'observed' },
		primary_key: { columns: [], type: 'unknown', source: 'unknown' },
		fields: [...table.columns].sort().map((name) => ({ name, type: null, nullable: null, source: 'migration' })),
		relations: table.relations,
		source_refs: [...table.sourceFiles].sort().map((file) => makeSourceRef({ kind: 'migration', provider, file, detail: 'migration table declaration' })),
	}));
	return createPersistenceIr({
		provider,
		source_kind: 'migration',
		entities,
		diagnostics: migrations?.tool === 'liquibase' && entities.length === 0 ? [{
			code: 'migration-content-not-deep-parsed', level: 'info', message: 'Liquibase changelog presence is known, but no table facts were extracted from non-SQL changelogs',
		}] : [],
		metadata: { tool: migrations?.tool ?? 'none', generated_at: migrations?.generated_at ?? null, files: migrations?.files ?? [] },
	});
}

function liveRelationGroups(table) {
	const groups = new Map();
	for (const fk of table.foreign_keys ?? []) {
		const key = fk.references_table;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(fk);
	}
	const relations = [];
	for (const [parent, rows] of groups) {
		const sourceColumns = [...new Set(rows.map((r) => r.column))];
		const targetColumns = [...new Set(rows.map((r) => r.references_column).filter(Boolean))];
		const unambiguous = rows.length === 1;
		relations.push(normalizeRelation({
			columns: sourceColumns,
			references_table: parent,
			references_columns: targetColumns,
			pairing: unambiguous ? (targetColumns.length === 1 ? 'resolved' : 'unknown') : 'ambiguous-flat-introspection',
			source: 'live',
		}));
	}
	return relations;
}

export function fromLivePostgres(live) {
	const provider = 'postgres-introspection';
	const schema = live?.schema ?? 'public';
	const entities = (live?.tables ?? []).map((table) => ({
		provider,
		name: table.name,
		module: null,
		file: null,
		table: { name: table.name, schema, source: 'observed' },
		primary_key: { columns: table.primary_key ?? [], type: 'unknown', source: 'live' },
		fields: (table.columns ?? []).map((column) => ({ name: column.name, type: column.type ?? null, nullable: column.nullable, source: 'live' })),
		relations: liveRelationGroups(table),
		source_refs: [makeSourceRef({ kind: 'live', provider, detail: `schema=${schema}; captured=${live.generated_at ?? 'unknown'}` })],
	}));
	return createPersistenceIr({
		provider,
		source_kind: 'live',
		entities,
		diagnostics: [],
		metadata: { schema, schema_hash: live?.schema_hash ?? null, generated_at: live?.generated_at ?? null },
	});
}
