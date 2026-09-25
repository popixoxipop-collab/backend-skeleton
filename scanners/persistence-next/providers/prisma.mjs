import fs from 'node:fs';
import path from 'node:path';
import { createPersistenceIr, makeSourceRef, sourcePath } from '../ir.mjs';

const BUILTIN_SCALARS = new Set(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes']);
const DEFAULT_CANDIDATES = ['prisma/schema.prisma', 'schema.prisma'];

function lineNumberAt(text, index) {
	return text.slice(0, index).split('\n').length;
}

function maskComments(text) {
	let out = '';
	let mode = 'code';
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (mode === 'line') {
			if (ch === '\n') { mode = 'code'; out += '\n'; } else out += ' ';
			continue;
		}
		if (mode === 'block') {
			if (ch === '*' && next === '/') { out += '  '; i++; mode = 'code'; }
			else out += ch === '\n' ? '\n' : ' ';
			continue;
		}
		if (quote) {
			out += ch;
			if (ch === '\\' && i + 1 < text.length) { out += text[++i]; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
		if (ch === '/' && next === '/') { out += '  '; i++; mode = 'line'; continue; }
		if (ch === '/' && next === '*') { out += '  '; i++; mode = 'block'; continue; }
		out += ch;
	}
	return out;
}

function maskStringsForStructure(text) {
	let out = '';
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\' && i + 1 < text.length) { out += '  '; i++; continue; }
			if (ch === quote) { out += ' '; quote = null; }
			else out += ch === '\n' ? '\n' : ' ';
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; out += ' '; }
		else out += ch;
	}
	return out;
}

function matchingBrace(text, open) {
	let depth = 0;
	let quote = null;
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\') { i++; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; continue; }
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function findBlocks(masked, keyword) {
	const blocks = [];
	const re = new RegExp(`\\b${keyword}\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\{`, 'g');
	let match;
	while ((match = re.exec(masked))) {
		const open = masked.indexOf('{', match.index + match[0].length - 1);
		const close = matchingBrace(masked, open);
		if (close < 0) continue;
		blocks.push({ name: match[1], start: match.index, bodyStart: open + 1, bodyEnd: close });
		re.lastIndex = close + 1;
	}
	return blocks;
}

function delimiterDelta(text) {
	let paren = 0;
	let bracket = 0;
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\') { i++; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; continue; }
		if (ch === '(') paren++;
		else if (ch === ')') paren--;
		else if (ch === '[') bracket++;
		else if (ch === ']') bracket--;
	}
	return { paren, bracket };
}

function statements(body, bodyLine) {
	const lines = body.split('\n');
	const out = [];
	let current = '';
	let startLine = bodyLine;
	let paren = 0;
	let bracket = 0;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].trim();
		if (!current && !raw) continue;
		if (!current) startLine = bodyLine + i;
		current += (current ? ' ' : '') + raw;
		const delta = delimiterDelta(raw);
		paren += delta.paren;
		bracket += delta.bracket;
		if (paren <= 0 && bracket <= 0) {
			if (current) out.push({ text: current.trim(), line: startLine });
			current = '';
			paren = 0;
			bracket = 0;
		}
	}
	if (current) out.push({ text: current.trim(), line: startLine, incomplete: true });
	return out;
}

function quotedArg(text, attr) {
	const escaped = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = text.match(new RegExp(`${escaped}\\s*\\(\\s*"([^"\\n]+)"\\s*\\)`));
	return match ? match[1] : null;
}

function listArg(text, name) {
	const match = text.match(new RegExp(`\\b${name}\\s*:\\s*\\[([^\\]]*)\\]`));
	if (!match) return [];
	return match[1].split(',').map((value) => value.trim()).filter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value));
}

function parseField(stmt) {
	if (!stmt.text || stmt.text.startsWith('@@')) return null;
	const match = stmt.text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_.]*)(\?|\[\])?\s*(.*)$/);
	if (!match) return { unsupported: true, text: stmt.text, line: stmt.line };
	const [, logicalName, baseType, modifier = '', attrs = ''] = match;
	return {
		logicalName,
		physicalName: quotedArg(attrs, '@map') ?? logicalName,
		baseType,
		modifier,
		nullable: modifier === '?',
		attrs,
		line: stmt.line,
		isId: /(?:^|\s)@id(?:\s|\(|$)/.test(attrs),
		relationFields: listArg(attrs, 'fields'),
		relationReferences: listArg(attrs, 'references'),
	};
}

function parseModels(text, file) {
	const masked = maskComments(text);
	const structure = maskStringsForStructure(masked);
	const enumNames = new Set(findBlocks(structure, 'enum').map((block) => block.name));
	const modelBlocks = findBlocks(structure, 'model');
	const models = [];
	const diagnostics = [];
	for (const block of modelBlocks) {
		const body = masked.slice(block.bodyStart, block.bodyEnd);
		const bodyLine = lineNumberAt(masked, block.bodyStart);
		const stmts = statements(body, bodyLine);
		const fields = [];
		let table = null;
		let schema = null;
		let compositeId = [];
		for (const stmt of stmts) {
			if (stmt.incomplete) diagnostics.push({ code: 'prisma-incomplete-statement', level: 'info', file, line: stmt.line, model: block.name, statement: stmt.text });
			if (stmt.text.startsWith('@@map')) { table = quotedArg(stmt.text, '@@map'); continue; }
			if (stmt.text.startsWith('@@schema')) { schema = quotedArg(stmt.text, '@@schema'); continue; }
			if (stmt.text.startsWith('@@id')) {
				const m = stmt.text.match(/@@id\s*\(\s*\[([^\]]*)\]/);
				compositeId = m ? m[1].split(',').map((value) => value.trim()).filter(Boolean) : [];
				continue;
			}
			if (stmt.text.startsWith('@@')) continue;
			const field = parseField(stmt);
			if (field?.unsupported) diagnostics.push({ code: 'prisma-field-unsupported', level: 'info', file, line: field.line, model: block.name, statement: field.text });
			else if (field) fields.push(field);
		}
		models.push({
			name: block.name,
			file,
			line: lineNumberAt(masked, block.start),
			table: table ?? block.name,
			tableSource: table ? 'explicit' : 'inferred',
			schema,
			fields,
			compositeId,
			enumNames,
		});
	}
	return { models, diagnostics };
}

function fieldMap(model) {
	return new Map(model.fields.map((field) => [field.logicalName, field]));
}

function isPhysicalField(field, modelNames, enumNames) {
	if (/(?:^|\s)@relation(?:\s|\(|$)/.test(field.attrs)) return false;
	if (modelNames.has(field.baseType)) return false;
	return BUILTIN_SCALARS.has(field.baseType) || enumNames.has(field.baseType);
}

export function parsePrismaSchema(text, { file = 'schema.prisma', repoRoot = null } = {}) {
	const normalizedFile = sourcePath(file, repoRoot);
	const { models, diagnostics } = parseModels(text, normalizedFile);
	const modelByName = new Map(models.map((model) => [model.name, model]));
	const modelNames = new Set(modelByName.keys());
	const entities = [];
	for (const model of models) {
		const ownFields = fieldMap(model);
		const scalarFields = model.fields.filter((field) => isPhysicalField(field, modelNames, model.enumNames));
		const scalarFieldNames = new Set(scalarFields.map((field) => field.logicalName));
		for (const field of model.fields) {
			const isRelation = /(?:^|\s)@relation(?:\s|\(|$)/.test(field.attrs) || modelNames.has(field.baseType);
			if (!isRelation && !isPhysicalField(field, modelNames, model.enumNames)) diagnostics.push({
				code: 'prisma-field-type-unresolved', level: 'info', file: normalizedFile, line: field.line, model: model.name, field: field.logicalName, type: field.baseType,
			});
		}
		let pkLogical = model.compositeId;
		if (pkLogical.length === 0) pkLogical = model.fields.filter((field) => field.isId).map((field) => field.logicalName);
		const pkPhysical = pkLogical.map((name) => scalarFieldNames.has(name) ? ownFields.get(name)?.physicalName : null).filter(Boolean);
		if (pkLogical.length !== pkPhysical.length) diagnostics.push({
			code: 'prisma-primary-key-unresolved', level: 'info', file: normalizedFile, model: model.name,
			message: 'one or more @@id/@id fields could not be resolved to physical columns',
		});
		const relations = [];
		for (const field of model.fields) {
			if (field.relationFields.length === 0) continue;
			const target = modelByName.get(field.baseType);
			if (!target) {
				diagnostics.push({ code: 'prisma-relation-target-unknown', level: 'info', file: normalizedFile, line: field.line, model: model.name, field: field.logicalName, target: field.baseType });
				continue;
			}
			const targetFields = fieldMap(target);
			const targetPhysical = new Set(target.fields.filter((targetField) => isPhysicalField(targetField, modelNames, target.enumNames)).map((targetField) => targetField.logicalName));
			const localColumns = field.relationFields.map((name) => scalarFieldNames.has(name) ? ownFields.get(name)?.physicalName : null).filter(Boolean);
			const remoteColumns = field.relationReferences.map((name) => targetPhysical.has(name) ? targetFields.get(name)?.physicalName : null).filter(Boolean);
			const resolved = localColumns.length === field.relationFields.length
				&& remoteColumns.length === field.relationReferences.length
				&& localColumns.length === remoteColumns.length
				&& localColumns.length > 0;
			relations.push({
				columns: localColumns,
				references_table: target.table,
				references_schema: target.schema,
				references_columns: remoteColumns,
				pairing: resolved ? 'resolved' : 'unknown',
				source: 'source',
			});
			if (!resolved) diagnostics.push({ code: 'prisma-relation-unresolved', level: 'info', file: normalizedFile, line: field.line, model: model.name, field: field.logicalName });
		}
		const singlePk = pkLogical.length === 1 ? ownFields.get(pkLogical[0]) : null;
		entities.push({
			provider: 'prisma',
			name: model.name,
			module: null,
			file: normalizedFile,
			table: { name: model.table, schema: model.schema, source: model.tableSource },
			primary_key: {
				columns: pkPhysical,
				type: pkPhysical.length === 0 ? 'unknown' : pkPhysical.length > 1 ? 'composite' : singlePk?.baseType ?? 'unknown',
				source: pkPhysical.length === pkLogical.length && pkPhysical.length > 0 ? 'source' : 'unknown',
			},
			fields: scalarFields.map((field) => ({
				name: field.physicalName,
				type: field.baseType + field.modifier,
				nullable: field.nullable,
				source: 'source',
			})),
			relations,
			source_refs: [makeSourceRef({ kind: 'source', provider: 'prisma', file: normalizedFile, line: model.line, detail: 'model ' + model.name })],
		});
	}
	return createPersistenceIr({
		provider: 'prisma',
		source_kind: 'source',
		entities,
		diagnostics,
		metadata: { schema_files: [normalizedFile] },
	});
}

function candidateFiles(projectRoot) {
	const found = [];
	for (const rel of DEFAULT_CANDIDATES) {
		const abs = path.join(projectRoot, rel);
		if (fs.existsSync(abs) && fs.statSync(abs).isFile()) found.push(abs);
	}
	return [...new Set(found)];
}

export function detectPrismaPersistence(projectRoot) {
	return candidateFiles(projectRoot).length > 0;
}

export function scanPrismaPersistence(projectRoot) {
	const files = candidateFiles(projectRoot);
	if (files.length > 1) return createPersistenceIr({
		provider: 'prisma', source_kind: 'source', entities: [],
		diagnostics: [{ code: 'prisma-schema-root-ambiguous', level: 'warning', message: 'multiple default Prisma schema candidates exist; Slice 1 refuses to merge them implicitly' }],
		metadata: { schema_files: files.map((file) => sourcePath(file, projectRoot)) },
	});
	const all = [];
	const diagnostics = [];
	for (const file of files) {
		const ir = parsePrismaSchema(fs.readFileSync(file, 'utf8'), { file, repoRoot: projectRoot });
		all.push(...ir.entities);
		diagnostics.push(...ir.diagnostics);
	}
	return createPersistenceIr({
		provider: 'prisma', source_kind: 'source', entities: all, diagnostics,
		metadata: { schema_files: files.map((file) => sourcePath(file, projectRoot)) },
	});
}

export const prismaPersistenceProvider = {
	id: 'prisma',
	contract: 'sbf.persistence-provider/1',
	detect: detectPrismaPersistence,
	scan: scanPrismaPersistence,
};
