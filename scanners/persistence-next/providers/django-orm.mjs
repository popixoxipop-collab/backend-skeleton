import fs from 'node:fs';
import path from 'node:path';
import { createPersistenceIr, makeSourceRef, sourcePath } from '../ir.mjs';

const SKIP_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', 'site-packages', 'migrations']);
const SCALAR_FIELDS = new Set([
	'AutoField', 'BigAutoField', 'BigIntegerField', 'BinaryField', 'BooleanField', 'CharField',
	'DateField', 'DateTimeField', 'DecimalField', 'DurationField', 'EmailField', 'FileField',
	'FilePathField', 'FloatField', 'GenericIPAddressField', 'IntegerField', 'JSONField',
	'PositiveBigIntegerField', 'PositiveIntegerField', 'PositiveSmallIntegerField', 'SlugField',
	'SmallIntegerField', 'TextField', 'TimeField', 'URLField', 'UUIDField',
]);
const RELATION_FIELDS = new Set(['ForeignKey', 'OneToOneField']);

function walkModelFiles(root) {
	const out = [];
	const visit = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (SKIP_DIRS.has(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(full);
			else if (entry.isFile() && entry.name.endsWith('.py')) {
				const normalized = full.replaceAll('\\', '/');
				if (normalized.endsWith('/models.py') || /\/models\/[^/]+\.py$/.test(normalized)) out.push(full);
			}
		}
	};
	if (fs.existsSync(root)) visit(root);
	return out.sort();
}

function maskPythonNonCode(text) {
	let out = '';
	let quote = null;
	let triple = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\' && !triple && i + 1 < text.length) { out += '  '; i++; continue; }
			if (triple) {
				if (text.startsWith(quote.repeat(3), i)) { out += '   '; i += 2; quote = null; triple = false; }
				else out += ch === '\n' ? '\n' : ' ';
			} else if (ch === quote) { out += ' '; quote = null; }
			else out += ch === '\n' ? '\n' : ' ';
			continue;
		}
		if ((ch === '"' || ch === "'") && text.substr(i, 3) === ch.repeat(3)) {
			quote = ch; triple = true; out += '   '; i += 2; continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; out += ' '; continue; }
		if (ch === '#') {
			while (i < text.length && text[i] !== '\n') { out += ' '; i++; }
			if (i < text.length) out += '\n';
			continue;
		}
		out += ch;
	}
	return out;
}

function indentOf(line) {
	return line.match(/^\s*/)[0].replaceAll('\t', '    ').length;
}

function literalKwarg(text, name) {
	const re = new RegExp(`\\b${name}\\s*=\\s*(?:["']([^"']+)["']|([A-Za-z_][A-Za-z0-9_.]*))`);
	const match = text.match(re);
	return match ? (match[1] ?? match[2]) : null;
}

function boolKwarg(text, name) {
	const re = new RegExp('\\b' + name + '\\s*=\\s*(True|False)\\b');
	const match = text.match(re);
	return match ? match[1] === 'True' : null;
}

function firstTargetArg(text) {
	const inner = text.slice(text.indexOf('(') + 1);
	const match = inner.match(/^\s*(?:["']([^"']+)["']|([A-Za-z_][A-Za-z0-9_]*))/);
	if (!match) return null;
	const raw = match[1] ?? match[2];
	if (raw === 'self') return 'self';
	return raw.split('.').at(-1);
}

function collectCall(lines, start, minIndent) {
	let text = lines[start].trim();
	let depth = 0;
	let quote = null;
	const scan = (fragment) => {
		for (let i = 0; i < fragment.length; i++) {
			const ch = fragment[i];
			if (quote) {
				if (ch === '\\') { i++; continue; }
				if (ch === quote) quote = null;
				continue;
			}
			if (ch === '"' || ch === "'") { quote = ch; continue; }
			if (ch === '(') depth++;
			else if (ch === ')') depth--;
		}
	};
	scan(lines[start]);
	let end = start;
	while (depth > 0 && end + 1 < lines.length) {
		const next = lines[end + 1];
		if (next.trim() && indentOf(next) < minIndent) break;
		end++;
		text += ' ' + next.trim();
		scan(next);
	}
	return { text, end, complete: depth === 0 };
}

function parseModelsFromText(text, file) {
	const masked = maskPythonNonCode(text);
	const lines = text.split('\n');
	const maskedLines = masked.split('\n');
	const models = [];
	const diagnostics = [];
	for (let i = 0; i < maskedLines.length; i++) {
		const classMatch = maskedLines[i].match(/^(\s*)class\s+([A-Za-z_]\w*)\s*\(\s*models\.Model\s*\)\s*:/);
		if (!classMatch) continue;
		const classIndent = indentOf(maskedLines[i]);
		const bodyStart = i + 1;
		let bodyEnd = lines.length;
		for (let j = bodyStart; j < maskedLines.length; j++) {
			if (!maskedLines[j].trim()) continue;
			if (indentOf(maskedLines[j]) <= classIndent) { bodyEnd = j; break; }
		}
		const directIndents = maskedLines.slice(bodyStart, bodyEnd)
			.filter((line)=>line.trim() && indentOf(line) > classIndent)
			.map((line)=>indentOf(line));
		const declarationIndent = directIndents.length > 0 ? Math.min(...directIndents) : null;
		let table = null;
		let abstract = false;
		const fields = [];
		for (let j = bodyStart; j < bodyEnd; j++) {
			if (!maskedLines[j].trim()) continue;
			const indent = indentOf(maskedLines[j]);
			if (indent <= classIndent) break;
			if (declarationIndent == null || indent !== declarationIndent) continue;
			const metaMatch = maskedLines[j].match(/^\s*class\s+Meta\s*:/);
			if (metaMatch) {
				const metaIndent = indent;
				for (let k = j + 1; k < bodyEnd; k++) {
					if (!maskedLines[k].trim()) continue;
					const currentIndent = indentOf(maskedLines[k]);
					if (currentIndent <= metaIndent) break;
					const raw = lines[k].trim();
					const db = raw.match(/^db_table\s*=\s*["']([^"']+)["']/);
					if (db) table = db[1];
					if (/^abstract\s*=\s*True\b/.test(raw)) abstract = true;
				}
				continue;
			}
			const fieldMatch = maskedLines[j].match(/^\s*([A-Za-z_]\w*)\s*=\s*models\.([A-Za-z_]\w*)\s*\(/);
			if (!fieldMatch) continue;
			const fieldLine = j + 1;
			const call = collectCall(lines, j, declarationIndent);
			j = call.end;
			if (!call.complete) {
				diagnostics.push({ code:'django-field-call-incomplete', level:'info', file, line:fieldLine, model:classMatch[2], field:fieldMatch[1] });
				continue;
			}
			fields.push({
				name: fieldMatch[1],
				kind: fieldMatch[2],
				call: call.text,
				line: fieldLine,
			});
		}
		if (abstract) {
			diagnostics.push({ code:'django-abstract-model', level:'info', file, model:classMatch[2], message:'Meta.abstract=True model is not a physical entity' });
			i = bodyEnd - 1;
			continue;
		}
		models.push({ name:classMatch[2], file, line:i + 1, table, fields });
		i = bodyEnd - 1;
	}
	return { models, diagnostics };
}

export function parseDjangoModels(files, { repoRoot = null } = {}) {
	const parsed = [];
	const diagnostics = [];
	for (const input of files) {
		const file = typeof input === 'string' ? input : input.file;
		const text = typeof input === 'string' ? fs.readFileSync(input, 'utf8') : input.text;
		const normalizedFile = sourcePath(file, repoRoot);
		const masked = maskPythonNonCode(text);
		if (!/^\s*from\s+django\.db\s+import\s+models\b/m.test(masked)) {
			diagnostics.push({ code:'django-models-import-missing', level:'info', file:normalizedFile, message:'Slice 1 only parses direct django.db models imports' });
			continue;
		}
		const result = parseModelsFromText(text, normalizedFile);
		parsed.push(...result.models);
		diagnostics.push(...result.diagnostics);
	}
	const byName = new Map();
	for (const model of parsed) {
		if (!byName.has(model.name)) byName.set(model.name, []);
		byName.get(model.name).push(model);
	}
	const entities = [];
	for (const model of parsed) {
		const physicalFields = [];
		const relations = [];
		const pkFields = [];
		for (const field of model.fields) {
			const dbColumn = literalKwarg(field.call, 'db_column');
			const primaryKey = boolKwarg(field.call, 'primary_key') === true;
			const nullable = boolKwarg(field.call, 'null');
			if (SCALAR_FIELDS.has(field.kind)) {
				const physicalName = dbColumn ?? field.name;
				physicalFields.push({ name:physicalName, type:field.kind, nullable, source:dbColumn ? 'source' : 'source-default' });
				if (primaryKey) pkFields.push({ logical:field.name, physical:physicalName, kind:field.kind });
				continue;
			}
			if (RELATION_FIELDS.has(field.kind)) {
				const targetName = firstTargetArg(field.call);
				const physicalName = dbColumn ?? (field.name + '_id');
				physicalFields.push({ name:physicalName, type:field.kind, nullable, source:dbColumn ? 'source' : 'source-default' });
				if (primaryKey) pkFields.push({ logical:field.name, physical:physicalName, kind:field.kind });
				let targets = targetName === 'self' ? [model] : (byName.get(targetName) ?? []);
				if (targets.length !== 1) {
					diagnostics.push({ code:'django-relation-target-ambiguous', level:'info', file:model.file, line:field.line, model:model.name, field:field.name, target:targetName });
					continue;
				}
				const target = targets[0];
				if (!target.table) {
					diagnostics.push({ code:'django-relation-target-table-unknown', level:'info', file:model.file, line:field.line, model:model.name, field:field.name, target:target.name });
					continue;
				}
				const toField = literalKwarg(field.call, 'to_field');
				const targetPk = target.fields.find((candidate) => boolKwarg(candidate.call, 'primary_key') === true);
				const explicitTargetField = toField ? target.fields.find((candidate) => candidate.name === toField) : null;
				const targetColumn = toField
					? explicitTargetField ? (literalKwarg(explicitTargetField.call, 'db_column') ?? explicitTargetField.name) : null
					: targetPk ? (literalKwarg(targetPk.call, 'db_column') ?? targetPk.name) : null;
				relations.push({
					columns:[physicalName],
					references_table:target.table,
					references_schema:null,
					references_columns:targetColumn ? [targetColumn] : [],
					pairing:targetColumn ? 'resolved' : 'unknown',
					source:'source',
				});
				if (!targetColumn) diagnostics.push({ code:'django-relation-target-key-unknown', level:'info', file:model.file, line:field.line, model:model.name, field:field.name, target:target.name });
				continue;
			}
			diagnostics.push({ code:'django-field-type-unsupported', level:'info', file:model.file, line:field.line, model:model.name, field:field.name, type:field.kind });
		}
		if (!model.table) diagnostics.push({ code:'django-table-unknown', level:'info', file:model.file, model:model.name, message:'Meta.db_table is not explicit; app-label table naming is not guessed in Slice 1' });
		if (pkFields.length === 0) diagnostics.push({ code:'django-primary-key-unknown', level:'info', file:model.file, model:model.name, message:'no explicit primary_key=True field; implicit id is not assumed' });
		if (pkFields.length > 1) diagnostics.push({ code:'django-multiple-primary-key-declarations', level:'warning', file:model.file, model:model.name, message:'multiple primary_key=True fields were declared; Slice 1 preserves the declaration order but does not certify runtime validity' });
		entities.push({
			provider:'django-orm',
			name:model.name,
			module:null,
			file:model.file,
			table:{name:model.table,schema:null,source:model.table ? 'explicit' : 'unknown'},
			primary_key:{columns:pkFields.map((field)=>field.physical),type:pkFields.length === 1 ? pkFields[0].kind : pkFields.length > 1 ? 'composite-declared' : 'unknown',source:pkFields.length ? 'source' : 'unknown'},
			fields:physicalFields,
			relations,
			source_refs:[makeSourceRef({kind:'source',provider:'django-orm',file:model.file,line:model.line,detail:'Django model '+model.name})],
		});
	}
	return createPersistenceIr({
		provider:'django-orm',
		source_kind:'source',
		entities,
		diagnostics,
		metadata:{model_files:[...new Set(parsed.map((model)=>model.file))].sort()},
	});
}

export function detectDjangoOrmPersistence(projectRoot) {
	return walkModelFiles(projectRoot).some((file) => {
		const masked = maskPythonNonCode(fs.readFileSync(file,'utf8'));
		return /^\s*from\s+django\.db\s+import\s+models\b/m.test(masked)
			&& /^\s*class\s+[A-Za-z_]\w*\s*\(\s*models\.Model\s*\)\s*:/m.test(masked);
	});
}

export function scanDjangoOrmPersistence(projectRoot) {
	const files = walkModelFiles(projectRoot);
	return parseDjangoModels(files,{repoRoot:projectRoot});
}

export const djangoOrmPersistenceProvider = {
	id:'django-orm',
	contract:'sbf.persistence-provider/1',
	detect:detectDjangoOrmPersistence,
	scan:scanDjangoOrmPersistence,
};
