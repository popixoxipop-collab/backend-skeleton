// Shared helpers for the ORM scope records under adapters/persistence/<orm>/SCOPE.json.
// Turns oracle output (PostgreSQL DDL text, TypeORM metadata JSON, Sequelize JSON) and Persistence IR
// into comparable fact sets. Not a test file: the nested runner collects only *.test.mjs.
import crypto from 'node:crypto';

export const FACETS = ['tables', 'columns', 'primary_keys', 'foreign_keys'];

export function sha256(value) {
	return crypto.createHash('sha256').update(value).digest('hex');
}

export function lf(text) {
	return text.replace(/\r\n/g, '\n');
}

export function sha256Lf(text) {
	return sha256(lf(text));
}

export function sortedUnique(values) {
	return [...new Set(values)].sort();
}

export function stripSqlComments(sql) {
	let out = '';
	let quote = null;
	let i = 0;
	while (i < sql.length) {
		const c = sql[i];
		if (quote) {
			out += c;
			if (c === quote) {
				if (sql[i + 1] === quote) {
					out += sql[i + 1];
					i += 2;
					continue;
				}
				quote = null;
			}
			i++;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			out += c;
			i++;
			continue;
		}
		if (c === '-' && sql[i + 1] === '-') {
			while (i < sql.length && sql[i] !== '\n') i++;
			continue;
		}
		if (c === '/' && sql[i + 1] === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end < 0 ? sql.length : end + 2;
			out += ' ';
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

export function splitTop(text, separator) {
	const parts = [];
	let current = '';
	let depth = 0;
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			current += c;
			if (c === quote) {
				if (text[i + 1] === quote) current += text[++i];
				else quote = null;
			}
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			current += c;
			continue;
		}
		if (c === '(') depth++;
		else if (c === ')') depth--;
		if (c === separator && depth === 0) {
			parts.push(current);
			current = '';
			continue;
		}
		current += c;
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter((part) => part !== '');
}

const IDENT = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';
const QNAME = new RegExp(`^\\s*(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?`);
const LEADING_IDENT = new RegExp(`^(${IDENT})`);
const CONSTRAINT_LEAD = /^(?:CONSTRAINT\b|PRIMARY\b|FOREIGN\b|UNIQUE\b|CHECK\b|EXCLUDE\b|LIKE\b)/i;

function unquote(id) {
	return id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id;
}

function qualified(text, defaultSchema) {
	const m = QNAME.exec(text);
	if (!m) return null;
	const schema = m[2] ? unquote(m[1]) : null;
	return { schema: schema === defaultSchema ? null : schema, name: unquote(m[2] ?? m[1]), end: m[0].length };
}

const tableKey = (t) => (t.schema ? `${t.schema}.${t.name}` : t.name);

function identList(text) {
	return splitTop(text, ',').map((item) => unquote(item.trim()));
}

function referencesOf(text, defaultSchema) {
	const target = qualified(text, defaultSchema);
	if (!target) return null;
	const rest = /^\s*\(([^)]*)\)/.exec(text.slice(target.end));
	return { table: tableKey(target), columns: rest ? identList(rest[1]) : [] };
}

const PK_ITEM = new RegExp(`^(?:CONSTRAINT\\s+${IDENT}\\s+)?PRIMARY\\s+KEY\\s*\\(([^)]*)\\)`, 'i');
const FK_ITEM = new RegExp(`^(?:CONSTRAINT\\s+${IDENT}\\s+)?FOREIGN\\s+KEY\\s*\\(([^)]*)\\)\\s*REFERENCES\\s+(.+)$`, 'is');
const INLINE_REF = /\bREFERENCES\s+([\s\S]+)$/i;

function normalizeSpace(statement) {
	return statement.replace(/\s+/g, ' ').trim();
}

function statementsOf(sql) {
	return splitTop(stripSqlComments(sql), ';');
}

function tablePrefix(text, defaultSchema, pattern) {
	const m = pattern.exec(text);
	if (!m) return null;
	const table = qualified(text.slice(m[0].length), defaultSchema);
	return table ? { table, rest: text.slice(m[0].length + table.end) } : null;
}

const CREATE_TABLE = /^CREATE (?:UNLOGGED |TEMP(?:ORARY)? )?TABLE (?:IF NOT EXISTS )?/i;
const ALTER_TABLE = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?/i;

function fkString(table, columns, ref) {
	return `${table}(${columns.join(',')})->${ref.table}(${ref.columns.join(',')})`;
}

function unmodeledKind(text) {
	if (/^CREATE SCHEMA\b/i.test(text)) return 'create-schema';
	if (/^CREATE UNIQUE INDEX\b/i.test(text)) return 'create-unique-index';
	if (/^CREATE INDEX\b/i.test(text)) return 'create-index';
	if (/^CREATE POLICY\b/i.test(text)) return 'create-policy';
	return `other:${text.split(' ').slice(0, 2).join('-').toLowerCase()}`;
}

function alterActionKind(action) {
	if (/^ENABLE ROW LEVEL SECURITY\b/i.test(action)) return 'alter-table-enable-row-level-security';
	if (/^ADD CONSTRAINT\b.*\bUNIQUE\b/i.test(action)) return 'alter-table-add-unique';
	return `alter-table:${action.split(' ').slice(0, 2).join('-').toLowerCase()}`;
}

export function parseSqlSchema(sql, { defaultSchema = 'public' } = {}) {
	const tables = new Set();
	const columns = new Set();
	const pks = new Map();
	const fks = new Set();
	const unmodeled = new Set();
	for (const raw of statementsOf(sql)) {
		const text = normalizeSpace(raw);
		const create = tablePrefix(text, defaultSchema, CREATE_TABLE);
		if (create) {
			const key = tableKey(create.table);
			tables.add(key);
			const open = create.rest.indexOf('(');
			const close = create.rest.lastIndexOf(')');
			const items = open >= 0 && close > open ? splitTop(create.rest.slice(open + 1, close), ',') : [];
			for (const item of items) {
				let m;
				if ((m = PK_ITEM.exec(item))) pks.set(key, identList(m[1]));
				else if ((m = FK_ITEM.exec(item))) {
					const ref = referencesOf(m[2], defaultSchema);
					if (ref) fks.add(fkString(key, identList(m[1]), ref));
				} else if (CONSTRAINT_LEAD.test(item)) unmodeled.add(`table-constraint:${/\b(UNIQUE|CHECK|EXCLUDE)\b/i.exec(item)?.[1].toLowerCase() ?? 'other'}`);
				else {
					const id = LEADING_IDENT.exec(item);
					if (!id) continue;
					const column = unquote(id[1]);
					columns.add(`${key}.${column}`);
					if (/\bPRIMARY\s+KEY\b/i.test(item)) pks.set(key, [column]);
					const inline = INLINE_REF.exec(item);
					if (inline) {
						const ref = referencesOf(inline[1], defaultSchema);
						if (ref) fks.add(fkString(key, [column], ref));
					}
				}
			}
			continue;
		}
		const alter = tablePrefix(text, defaultSchema, ALTER_TABLE);
		if (alter) {
			const key = tableKey(alter.table);
			for (const action of splitTop(alter.rest, ',')) {
				let m;
				if ((m = new RegExp(`^ADD CONSTRAINT ${IDENT} FOREIGN KEY \\(([^)]*)\\) REFERENCES (.+)$`, 'i').exec(action))) {
					const ref = referencesOf(m[2], defaultSchema);
					if (ref) fks.add(fkString(key, identList(m[1]), ref));
				} else if ((m = new RegExp(`^ADD CONSTRAINT ${IDENT} PRIMARY KEY \\(([^)]*)\\)`, 'i').exec(action))) pks.set(key, identList(m[1]));
				else unmodeled.add(alterActionKind(action));
			}
			continue;
		}
		unmodeled.add(unmodeledKind(text));
	}
	return {
		tables: sortedUnique(tables),
		columns: sortedUnique(columns),
		primary_keys: sortedUnique([...pks].map(([table, cols]) => `${table}(${cols.join(',')})`)),
		foreign_keys: sortedUnique(fks),
		unmodeled: sortedUnique(unmodeled),
	};
}

export function parseSqlChanges(sql, { defaultSchema = 'public' } = {}) {
	const changes = new Set();
	for (const raw of statementsOf(sql)) {
		const text = normalizeSpace(raw);
		const create = tablePrefix(text, defaultSchema, CREATE_TABLE);
		if (create) {
			changes.add(`create-table ${tableKey(create.table)}`);
			continue;
		}
		const drop = tablePrefix(text, defaultSchema, /^DROP TABLE (?:IF EXISTS )?/i);
		if (drop) {
			changes.add(`drop-table ${tableKey(drop.table)}`);
			continue;
		}
		const alter = tablePrefix(text, defaultSchema, ALTER_TABLE);
		if (!alter) {
			changes.add(`other:${text.split(' ').slice(0, 2).join('-').toLowerCase()}`);
			continue;
		}
		const key = tableKey(alter.table);
		for (const action of splitTop(alter.rest, ',')) {
			let m;
			if ((m = new RegExp(`^ADD COLUMN (?:IF NOT EXISTS )?(${IDENT})`, 'i').exec(action))) changes.add(`add-column ${key}.${unquote(m[1])}`);
			else if ((m = new RegExp(`^DROP COLUMN (?:IF EXISTS )?(${IDENT})`, 'i').exec(action))) changes.add(`drop-column ${key}.${unquote(m[1])}`);
			else changes.add(`other:alter-table-${action.split(' ').slice(0, 2).join('-').toLowerCase()}`);
		}
	}
	return sortedUnique(changes);
}

export function splitCaptureParts(content) {
	const parts = {};
	const pattern = /^### (\S+)(?: (.+))?\n/gm;
	const marks = [...content.matchAll(pattern)];
	marks.forEach((mark, index) => {
		const end = index + 1 < marks.length ? marks[index + 1].index : content.length;
		parts[mark[2] ? `${mark[1]} ${mark[2]}` : mark[1]] = content.slice(mark.index + mark[0].length, end);
	});
	return parts;
}

function entityFacts(entities, ddl = []) {
	const facts = { tables: [], columns: [], primary_keys: [], foreign_keys: [] };
	for (const entity of entities) {
		facts.tables.push(entity.tableName);
		for (const column of entity.columns) facts.columns.push(`${entity.tableName}.${column.db}`);
		if (entity.primary.length > 0) facts.primary_keys.push(`${entity.tableName}(${entity.primary.join(',')})`);
		for (const fk of entity.foreignKeys ?? []) {
			facts.foreign_keys.push(fkString(entity.tableName, fk.columns, { table: fk.refTable, columns: fk.refColumns }));
		}
	}
	return {
		tables: sortedUnique(facts.tables),
		columns: sortedUnique(facts.columns),
		primary_keys: sortedUnique(facts.primary_keys),
		foreign_keys: sortedUnique(facts.foreign_keys),
		unmodeled: ddl.length > 0 ? parseSqlSchema(ddl.join(';\n')).unmodeled.filter((kind) => !/^(other:|alter-table:rename-to$)/.test(kind)) : [],
	};
}

export function diffColumnFacts(fromColumns, toColumns, fromTables, toTables) {
	const changes = [];
	for (const table of toTables) if (!fromTables.includes(table)) changes.push(`create-table ${table}`);
	for (const table of fromTables) if (!toTables.includes(table)) changes.push(`drop-table ${table}`);
	const common = new Set(fromTables.filter((table) => toTables.includes(table)));
	for (const column of toColumns) if (!fromColumns.includes(column) && common.has(column.slice(0, column.lastIndexOf('.')))) changes.push(`add-column ${column}`);
	for (const column of fromColumns) if (!toColumns.includes(column) && common.has(column.slice(0, column.lastIndexOf('.')))) changes.push(`drop-column ${column}`);
	return sortedUnique(changes);
}

// Oracle step output -> comparable facts. `role` comes from the step record.
export function oracleStepFacts(orm, step, content) {
	if (step.role === 'blocked-probe') {
		const parts = splitCaptureParts(content);
		const stderrLine = (parts.stderr ?? '').split('\n')[0];
		const listingKey = Object.keys(parts).find((key) => key.startsWith('listing '));
		const listing = (parts[listingKey] ?? '').split('\n').filter(Boolean);
		return {
			blocked: true,
			reason: stderrLine.split(' (')[0],
			new_migration_files: listing.filter((name) => /^\d{4}_.*\.sql$/.test(name) && !name.startsWith('0000_')).length,
		};
	}
	if (orm === 'prisma' || orm === 'drizzle') {
		return step.role === 'migration-diff' ? { changes: parseSqlChanges(content) } : parseSqlSchema(content);
	}
	if (orm === 'sequelize') return parseSqlSchema(JSON.parse(content).sql.join('\n'));
	if (orm === 'typeorm') {
		const json = JSON.parse(content);
		if (step.role === 'migration-diff') {
			const from = entityFacts(json.from);
			const to = entityFacts(json.to);
			return { changes: diffColumnFacts(from.columns, to.columns, from.tables, to.tables), upgrade_statements: json.upgrade.length };
		}
		return entityFacts(json.entities, json.ddl);
	}
	throw new Error(`unknown orm ${orm}`);
}

export function irFacts(ir, { defaultSchema = 'public' } = {}) {
	const tables = [];
	const columns = [];
	const pks = [];
	const fks = [];
	const unknowns = [];
	const inferred = [];
	for (const entity of ir.entities) {
		if (!entity.table?.name) {
			unknowns.push(`${entity.name}: table unknown`);
			continue;
		}
		const schema = entity.table.schema && entity.table.schema !== defaultSchema ? entity.table.schema : null;
		const key = tableKey({ schema, name: entity.table.name });
		tables.push(key);
		if (entity.table.source !== 'explicit') inferred.push(`${key}:${entity.table.source}`);
		for (const field of entity.fields) columns.push(`${key}.${field.name}`);
		if (entity.primary_key.columns.length > 0) pks.push(`${key}(${entity.primary_key.columns.join(',')})`);
		else unknowns.push(`${key}: primary key unknown`);
		for (const relation of entity.relations) {
			if (!relation.references_table || relation.columns.length === 0) continue;
			const refSchema = relation.references_schema && relation.references_schema !== defaultSchema ? relation.references_schema : null;
			fks.push(fkString(key, relation.columns, { table: tableKey({ schema: refSchema, name: relation.references_table }), columns: relation.references_columns }));
		}
	}
	return {
		facts: { tables: sortedUnique(tables), columns: sortedUnique(columns), primary_keys: sortedUnique(pks), foreign_keys: sortedUnique(fks) },
		unknowns: sortedUnique(unknowns),
		inferred_tables: sortedUnique(inferred),
		diagnostics: sortedUnique((ir.diagnostics ?? []).map((d) => d.code)),
	};
}

export function compareSet(oracleList, providerList) {
	const oracle = new Set(oracleList);
	const provider = new Set(providerList);
	const oracleOnly = [...oracle].filter((item) => !provider.has(item)).sort();
	const providerOnly = [...provider].filter((item) => !oracle.has(item)).sort();
	let result;
	if (oracle.size === 0 && provider.size === 0) result = 'empty';
	else if (oracleOnly.length === 0 && providerOnly.length === 0) result = 'match';
	else if (providerOnly.length === 0) result = 'provider-omits';
	else if (oracleOnly.length === 0) result = 'provider-extra';
	else result = 'mismatch';
	return { result, matched: oracle.size - oracleOnly.length, oracle_only: oracleOnly, provider_only: providerOnly };
}

export function compareFacts(oracleFacts, providerFacts) {
	const out = {};
	for (const facet of FACETS) out[facet] = compareSet(oracleFacts[facet] ?? [], providerFacts[facet] ?? []);
	return out;
}
