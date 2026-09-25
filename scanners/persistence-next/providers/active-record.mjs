import fs from 'node:fs';
import path from 'node:path';
import { createPersistenceIr, makeSourceRef, sourcePath } from '../ir.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'tmp', 'log']);

function walkRubyModels(root) {
	const base = path.join(root, 'app', 'models');
	if (!fs.existsSync(base)) return [];
	const out = [];
	const visit = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (SKIP_DIRS.has(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(full);
			else if (entry.isFile() && entry.name.endsWith('.rb')) out.push(full);
		}
	};
	visit(base);
	return out.sort();
}

function lineNumberAt(text, index) {
	return text.slice(0, index).split('\n').length;
}

function stripRubyComments(text) {
	let out = '';
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			out += ch;
			if (ch === '\\' && i + 1 < text.length) { out += text[++i]; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
		if (ch === '#') {
			while (i < text.length && text[i] !== '\n') { out += ' '; i++; }
			if (i < text.length) out += '\n';
			continue;
		}
		out += ch;
	}
	return out;
}

function literalOption(text, name) {
	const re = new RegExp(`\\b${name}\\s*:\\s*(?:["']([^"']+)["']|:([A-Za-z_][A-Za-z0-9_]*))`);
	const match = text.match(re);
	return match ? (match[1] ?? match[2]) : null;
}

function assignedLiteral(text, receiver, property) {
	const re = new RegExp(`\\b${receiver}\\.${property}\\s*=\\s*(?:["']([^"']+)["']|:([A-Za-z_][A-Za-z0-9_]*))`);
	const match = text.match(re);
	return match ? (match[1] ?? match[2]) : null;
}

function parseOneModelFile(text, file) {
	const masked = stripRubyComments(text);
	const classMatches = [...masked.matchAll(/^\s*class\s+([A-Z]\w*(?:::[A-Z]\w*)*)\s*<\s*(ApplicationRecord|ActiveRecord::Base)\b/gm)];
	if (classMatches.length === 0) return { model: null, diagnostics: [] };
	if (classMatches.length > 1) {
		return {
			model: null,
			diagnostics: [{ code: 'active-record-multiple-models-per-file', level: 'info', file, message: 'Slice 1 refuses to attribute DSL declarations when more than one ActiveRecord model class is present in one file' }],
		};
	}
	const match = classMatches[0];
	const body = masked.slice(match.index + match[0].length);
	if (/\bself\.abstract_class\s*=\s*true\b/.test(body)) {
		return {
			model: null,
			diagnostics: [{ code: 'active-record-abstract-model', level: 'info', file, model: match[1], message: 'abstract ActiveRecord model is not a physical entity' }],
		};
	}
	const table = assignedLiteral(body, 'self', 'table_name');
	const primaryKey = assignedLiteral(body, 'self', 'primary_key');
	const belongsTo = [];
	for (const rel of body.matchAll(/^\s*belongs_to\s+(?::([A-Za-z_]\w*)|["']([^"']+)["'])([^\n]*)/gm)) {
		const association = rel[1] ?? rel[2];
		const options = rel[3] ?? '';
		const foreignKey = literalOption(options, 'foreign_key');
		const className = literalOption(options, 'class_name');
		const targetPrimaryKey = literalOption(options, 'primary_key');
		belongsTo.push({
			association,
			foreignKey,
			className,
			targetPrimaryKey,
			line: lineNumberAt(masked, rel.index),
		});
	}
	return {
		model: {
			name: match[1],
			file,
			line: lineNumberAt(masked, match.index),
			table,
			primaryKey,
			belongsTo,
		},
		diagnostics: [],
	};
}

export function parseActiveRecordModels(files, { repoRoot = null } = {}) {
	const parsed = [];
	const diagnostics = [];
	for (const input of files) {
		const file = typeof input === 'string' ? input : input.file;
		const text = typeof input === 'string' ? fs.readFileSync(input, 'utf8') : input.text;
		const normalizedFile = sourcePath(file, repoRoot);
		const result = parseOneModelFile(text, normalizedFile);
		if (result.model) parsed.push(result.model);
		diagnostics.push(...result.diagnostics);
	}
	const byName = new Map(parsed.map((model) => [model.name, model]));
	const entities = [];
	for (const model of parsed) {
		const fields = [];
		const fieldNames = new Set();
		const addField = (name) => {
			if (!name || fieldNames.has(name)) return;
			fieldNames.add(name);
			fields.push({ name, type: null, nullable: null, source: 'source' });
		};
		addField(model.primaryKey);
		const relations = [];
		for (const relation of model.belongsTo) {
			if (!relation.foreignKey || !relation.className) {
				diagnostics.push({
					code: 'active-record-relation-unresolved', level: 'info', file: model.file, line: relation.line,
					model: model.name, association: relation.association,
					message: 'belongs_to requires literal class_name and foreign_key in Slice 1; convention-based inference is not used',
				});
				continue;
			}
			addField(relation.foreignKey);
			const target = byName.get(relation.className);
			if (!target?.table) {
				diagnostics.push({
					code: 'active-record-relation-target-table-unknown', level: 'info', file: model.file, line: relation.line,
					model: model.name, association: relation.association, target: relation.className,
					message: 'target model table_name is not explicit; physical relation is not emitted',
				});
				continue;
			}
			const targetKey = relation.targetPrimaryKey ?? target.primaryKey;
			relations.push({
				columns: [relation.foreignKey],
				references_table: target.table,
				references_schema: null,
				references_columns: targetKey ? [targetKey] : [],
				pairing: targetKey ? 'resolved' : 'unknown',
				source: 'source',
			});
			if (!targetKey) diagnostics.push({
				code: 'active-record-relation-target-key-unknown', level: 'info', file: model.file, line: relation.line,
				model: model.name, association: relation.association, target: relation.className,
				message: 'target primary key is not explicit; relation target column remains unknown',
			});
		}
		if (!model.table) diagnostics.push({
			code: 'active-record-table-unknown', level: 'info', file: model.file, model: model.name,
			message: 'self.table_name is not explicit; Rails inflection is deliberately not reimplemented in Slice 1',
		});
		if (!model.primaryKey) diagnostics.push({
			code: 'active-record-primary-key-unknown', level: 'info', file: model.file, model: model.name,
			message: 'self.primary_key is not explicit; the conventional id column is not assumed',
		});
		entities.push({
			provider: 'active-record',
			name: model.name,
			module: null,
			file: model.file,
			table: { name: model.table, schema: null, source: model.table ? 'explicit' : 'unknown' },
			primary_key: { columns: model.primaryKey ? [model.primaryKey] : [], type: 'unknown', source: model.primaryKey ? 'source' : 'unknown' },
			fields,
			relations,
			source_refs: [makeSourceRef({ kind: 'source', provider: 'active-record', file: model.file, line: model.line, detail: 'ActiveRecord model ' + model.name })],
		});
	}
	return createPersistenceIr({
		provider: 'active-record',
		source_kind: 'source',
		entities,
		diagnostics,
		metadata: { model_files: parsed.map((model) => model.file) },
	});
}

export function detectActiveRecordPersistence(projectRoot) {
	return walkRubyModels(projectRoot).some((file) => /<\s*(?:ApplicationRecord|ActiveRecord::Base)\b/.test(stripRubyComments(fs.readFileSync(file, 'utf8'))));
}

export function scanActiveRecordPersistence(projectRoot) {
	const files = walkRubyModels(projectRoot);
	return parseActiveRecordModels(files, { repoRoot: projectRoot });
}

export const activeRecordPersistenceProvider = {
	id: 'active-record',
	contract: 'sbf.persistence-provider/1',
	detect: detectActiveRecordPersistence,
	scan: scanActiveRecordPersistence,
};
