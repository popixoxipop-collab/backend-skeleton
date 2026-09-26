import path from 'node:path';

export const PERSISTENCE_IR_VERSION = 'sbf.persistence-ir/1';
export const TABLE_SOURCE = new Set(['explicit', 'inferred', 'observed', 'unknown']);
export const EVIDENCE_KIND = new Set(['source', 'migration', 'live']);

function nonEmptyString(value, label) {
	if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

function nullableString(value, label) {
	if (value == null) return null;
	return nonEmptyString(value, label);
}

function uniqueStrings(values, label) {
	if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
	const out = [];
	const seen = new Set();
	for (const value of values) {
		const s = nonEmptyString(value, `${label}[]`);
		if (!seen.has(s)) { seen.add(s); out.push(s); }
	}
	return out;
}

function stableIdPart(value) {
	return encodeURIComponent(String(value).replaceAll('\\', '/'));
}

function normalizeRepoRelativeFile(value, label) {
	if (value == null) return null;
	const raw = nonEmptyString(value, label);
	if (/[\u0000-\u001f\u007f]/.test(raw)) throw new TypeError(`${label} contains control characters`);
	const normalized = raw.replaceAll('\\', '/');
	if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
		throw new TypeError(`${label} must be repository-relative`);
	}
	const parts = normalized.split('/');
	if (parts.some((part) => part === '..')) throw new TypeError(`${label} must not escape the repository`);
	return parts.filter((part) => part !== '' && part !== '.').join('/');
}

export function sourcePath(file, repoRoot = null) {
	if (file == null) return null;
	const normalized = String(file).replaceAll('\\', '/');
	if (!repoRoot) return normalized;
	const rel = path.relative(repoRoot, file).replaceAll('\\', '/');
	if (rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return normalized;
	return rel || path.basename(file);
}

export function makeEntityId({ provider, className, file = null, table = null }) {
	nonEmptyString(provider, 'provider');
	nonEmptyString(className, 'className');
	const locator = file || table || className;
	return `entity:${stableIdPart(provider)}:${stableIdPart(className)}:${stableIdPart(locator)}`;
}

export function makeSourceRef({ kind, provider, file = null, line = null, detail = null }) {
	if (!EVIDENCE_KIND.has(kind)) throw new TypeError(`source ref kind must be one of ${[...EVIDENCE_KIND].join(', ')}`);
	const normalizedProvider = nonEmptyString(provider, 'source ref provider');
	if (line != null && (!Number.isInteger(line) || line < 1)) throw new TypeError('source ref line must be a positive integer or null');
	return {
		kind,
		provider: normalizedProvider,
		file: normalizeRepoRelativeFile(file, 'source ref file'),
		line: line ?? null,
		detail: detail == null ? null : String(detail),
	};
}

function normalizeSourceRef(ref, entityProvider) {
	if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new TypeError('source ref must be an object');
	const normalized = makeSourceRef(ref);
	if (normalized.provider !== entityProvider) throw new TypeError('source ref provider must match entity.provider');
	return normalized;
}

export function normalizeTable({ name = null, schema = null, source = 'unknown' } = {}) {
	if (!TABLE_SOURCE.has(source)) throw new TypeError(`table source must be one of ${[...TABLE_SOURCE].join(', ')}`);
	return {
		name: nullableString(name, 'table.name'),
		schema: nullableString(schema, 'table.schema'),
		source,
	};
}

export function normalizePrimaryKey({ columns = [], type = 'unknown', source = 'unknown' } = {}) {
	return {
		columns: uniqueStrings(columns, 'primary_key.columns'),
		type: nonEmptyString(type, 'primary_key.type'),
		source: nonEmptyString(source, 'primary_key.source'),
	};
}

export function normalizeRelation(relation) {
	if (!relation || typeof relation !== 'object') throw new TypeError('relation must be an object');
	const columns = uniqueStrings(relation.columns ?? [], 'relation.columns');
	const referencesColumns = uniqueStrings(relation.references_columns ?? [], 'relation.references_columns');
	return {
		kind: relation.kind ?? 'foreign-key',
		columns,
		references_table: nonEmptyString(relation.references_table, 'relation.references_table'),
		references_schema: nullableString(relation.references_schema, 'relation.references_schema'),
		references_columns: referencesColumns,
		pairing: relation.pairing ?? (columns.length === referencesColumns.length && columns.length <= 1 ? 'resolved' : 'unknown'),
		source: relation.source ?? 'unknown',
	};
}

export function normalizeEntity(entity) {
	if (!entity || typeof entity !== 'object') throw new TypeError('entity must be an object');
	const provider = nonEmptyString(entity.provider, 'entity.provider');
	const name = nonEmptyString(entity.name, 'entity.name');
	const table = normalizeTable(entity.table);
	const file = nullableString(entity.file, 'entity.file');
	const primaryKey = normalizePrimaryKey(entity.primary_key);
	const derivedId = makeEntityId({ provider, className: name, file, table: table.name });
	if (entity.id != null && entity.id !== derivedId) {
		throw new TypeError('entity.id must equal the deterministic persistence entity id');
	}
	return {
		id: derivedId,
		provider,
		name,
		module: nullableString(entity.module, 'entity.module'),
		file,
		table,
		primary_key: primaryKey,
		fields: Array.isArray(entity.fields) ? entity.fields.map((f) => ({
			name: nonEmptyString(f.name, 'field.name'),
			type: f.type == null ? null : String(f.type),
			nullable: typeof f.nullable === 'boolean' ? f.nullable : null,
			source: f.source ?? 'unknown',
		})) : [],
		relations: Array.isArray(entity.relations) ? entity.relations.map(normalizeRelation) : [],
		source_refs: entity.source_refs == null
			? []
			: Array.isArray(entity.source_refs)
				? entity.source_refs.map((ref) => normalizeSourceRef(ref, provider))
				: (() => { throw new TypeError('entity.source_refs must be an array'); })(),
	};
}

export function createPersistenceIr({ provider, source_kind, entities = [], diagnostics = [], metadata = {} }) {
	nonEmptyString(provider, 'provider');
	if (!EVIDENCE_KIND.has(source_kind)) throw new TypeError(`source_kind must be one of ${[...EVIDENCE_KIND].join(', ')}`);
	if (!Array.isArray(entities)) throw new TypeError('entities must be an array');
	const normalized = entities.map(normalizeEntity);
	for (const entity of normalized) {
		if (entity.provider !== provider) throw new TypeError('entity.provider must match persistence IR provider');
	}
	const ids = new Set();
	for (const entity of normalized) {
		if (ids.has(entity.id)) throw new Error(`duplicate persistence entity id: ${entity.id}`);
		ids.add(entity.id);
	}
	return {
		contract: PERSISTENCE_IR_VERSION,
		provider,
		source_kind,
		entities: normalized,
		diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
		metadata: metadata && typeof metadata === 'object' ? metadata : {},
	};
}

export function assertPersistenceIr(ir) {
	if (!ir || ir.contract !== PERSISTENCE_IR_VERSION) throw new TypeError(`expected ${PERSISTENCE_IR_VERSION}`);
	return createPersistenceIr({
		provider: ir.provider,
		source_kind: ir.source_kind,
		entities: ir.entities,
		diagnostics: ir.diagnostics,
		metadata: ir.metadata,
	});
}
