import crypto from 'node:crypto';
import path from 'node:path';

export const MODEL_FACTS_CONTRACT = 'sbf.model-facts/1';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertRelativeFile(file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file)) throw new TypeError('file must be repository-relative');
  const parts = file.replaceAll('\\', '/').split('/');
  if (parts.some((part) => !part || part === '..')) throw new TypeError('file must not escape the repository root');
  return parts.join('/');
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function factId(framework, file, start, className) {
  return `modf_${sha256([MODEL_FACTS_CONTRACT, framework, file, start, className].join('\0')).slice(0, 20)}`;
}

function sourceRef(source, file, start, end) {
  return { file, start, end, line: lineAt(source, start), sha256: sha256(source.slice(start, end)) };
}

function envelope(source, file, framework, language, models, unknowns = []) {
  return {
    contract: MODEL_FACTS_CONTRACT,
    framework,
    language,
    source: { file, sha256: sha256(source), bytes: Buffer.byteLength(source) },
    models,
    unknowns,
  };
}

function linesWithOffsets(source) {
  const lines = source.split(/(?<=\n)/);
  let cursor = 0;
  return lines.map((raw) => {
    const start = cursor;
    cursor += raw.length;
    return { raw: raw.replace(/\r?\n$/, ''), start, end: cursor };
  });
}

function rubyClassSlices(source) {
  const lines = linesWithOffsets(source);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].raw.match(/^(\s*)class\s+([A-Z]\w*(?:::[A-Z]\w*)*)\s*<\s*(ApplicationRecord|ActiveRecord::Base)\b/);
    if (!m || m[2] === 'ApplicationRecord') continue;
    const indent = m[1].length;
    let end = source.length;
    for (let j = i + 1; j < lines.length; j++) {
      const endMatch = lines[j].raw.match(/^(\s*)end\s*(?:#.*)?$/);
      if (endMatch && endMatch[1].length === indent) { end = lines[j].end; break; }
    }
    out.push({ className: m[2], start: lines[i].start + m[1].length, end, bodyStartLine: i + 1, indent });
  }
  return out;
}

export function extractActiveRecordModelFacts(source, { file = 'app/models/model.rb' } = {}) {
  file = assertRelativeFile(file);
  const models = [];
  const unknowns = [];
  const lines = linesWithOffsets(source);

  for (const slice of rubyClassSlices(source)) {
    const bodyLines = lines.filter((line) => line.start >= slice.start && line.start < slice.end);
    let table = null;
    let primaryKey = null;
    const relations = [];
    const flags = { inheritanceColumnExplicit: false };

    const declarationIndent = bodyLines
      .slice(1)
      .map((line) => ({ text: line.raw.trim(), indent: line.raw.length - line.raw.trimStart().length }))
      .filter((line) => line.text && line.text !== 'end' && line.indent > slice.indent)
      .reduce((min, line) => Math.min(min, line.indent), Number.POSITIVE_INFINITY);

    for (const line of bodyLines.slice(1)) {
      const trimmed = line.raw.trim();
      const indent = line.raw.length - line.raw.trimStart().length;
      if (!trimmed || trimmed === 'end' || indent !== declarationIndent) continue;

      const tableMatch = trimmed.match(/^self\.table_name\s*=\s*["']([^"']+)["']\s*$/);
      if (tableMatch) { table = { value: tableMatch[1], explicit: true, source: sourceRef(source, file, line.start + line.raw.indexOf('self'), line.end) }; continue; }
      const pkMatch = trimmed.match(/^self\.primary_key\s*=\s*["']([^"']+)["']\s*$/);
      if (pkMatch) { primaryKey = { value: pkMatch[1], explicit: true, source: sourceRef(source, file, line.start + line.raw.indexOf('self'), line.end) }; continue; }
      if (/^self\.inheritance_column\s*=/.test(trimmed)) flags.inheritanceColumnExplicit = true;

      const relation = trimmed.match(/^(belongs_to|has_one|has_many|has_and_belongs_to_many)\s+(?::([A-Za-z_]\w*)|["']([^"']+)["'])(.*)$/);
      if (relation) {
        const tail = relation[4] ?? '';
        const className = tail.match(/\bclass_name\s*:\s*["']([^"']+)["']/)?.[1] ?? null;
        const foreignKey = tail.match(/\bforeign_key\s*:\s*(?::([A-Za-z_]\w*)|["']([^"']+)["'])/);
        const polymorphic = /\bpolymorphic\s*:\s*true\b/.test(tail);
        relations.push({
          kind: relation[1], name: relation[2] ?? relation[3], className,
          foreignKey: foreignKey ? (foreignKey[1] ?? foreignKey[2]) : null,
          polymorphic,
          source: sourceRef(source, file, line.start + line.raw.indexOf(relation[1]), line.end),
        });
        if (polymorphic) unknowns.push({ code: 'MODEL_POLYMORPHIC_RELATION', model: slice.className, relation: relation[2] ?? relation[3], reason: 'polymorphic target type is runtime/data dependent' });
      }
    }

    if (!table) unknowns.push({ code: 'MODEL_TABLE_IMPLICIT', model: slice.className, reason: 'ActiveRecord table name is implicit; static fact layer does not apply Rails inflection' });
    if (!primaryKey) unknowns.push({ code: 'MODEL_PRIMARY_KEY_IMPLICIT', model: slice.className, reason: 'ActiveRecord primary key is implicit; static fact layer does not assume id' });

    models.push({
      id: factId('rails', file, slice.start, slice.className),
      className: slice.className,
      baseClass: source.slice(slice.start, slice.end).match(/^class\s+[^<]+<\s*(ApplicationRecord|ActiveRecord::Base)/)?.[1] ?? null,
      table,
      primaryKey,
      relations,
      flags,
      source: sourceRef(source, file, slice.start, slice.end),
    });
  }
  return envelope(source, file, 'rails', 'ruby', models, unknowns);
}

function phpClassSlices(source) {
  const classRe = /(?:^|\n)\s*(?:final\s+|abstract\s+)?class\s+([A-Za-z_]\w*)\s+extends\s+(?:\\?Illuminate\\Database\\Eloquent\\Model|Model)\b/g;
  const out = [];
  for (const m of source.matchAll(classRe)) {
    const classStart = m.index + m[0].indexOf('class');
    const brace = source.indexOf('{', classStart);
    if (brace === -1) continue;
    let depth = 0, quote = null, escaped = false, end = source.length;
    for (let i = brace; i < source.length; i++) {
      const ch = source[i];
      if (escaped) { escaped = false; continue; }
      if (quote && ch === '\\') { escaped = true; continue; }
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    out.push({ className: m[1], start: classStart, bodyStart: brace + 1, end });
  }
  return out;
}

function phpStringProperty(body, name) {
  const m = body.match(new RegExp(`(?:protected|public|private)\\s+\\$${name}\\s*=\\s*["']([^"']+)["']\\s*;`));
  return m?.[1] ?? null;
}

function phpBoolProperty(body, name) {
  const m = body.match(new RegExp(`(?:protected|public|private)\\s+\\$${name}\\s*=\\s*(true|false)\\s*;`, 'i'));
  return m ? m[1].toLowerCase() === 'true' : null;
}

function phpStringArrayProperty(body, name) {
  const m = body.match(new RegExp(`(?:protected|public|private)\\s+\\$${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`));
  if (!m) return null;
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
}

export function extractEloquentModelFacts(source, { file = 'app/Models/Model.php' } = {}) {
  file = assertRelativeFile(file);
  const models = [];
  const unknowns = [];
  for (const slice of phpClassSlices(source)) {
    const body = source.slice(slice.bodyStart, slice.end - 1);
    const tableValue = phpStringProperty(body, 'table');
    const pkValue = phpStringProperty(body, 'primaryKey');
    const keyType = phpStringProperty(body, 'keyType');
    const incrementing = phpBoolProperty(body, 'incrementing');
    const fillable = phpStringArrayProperty(body, 'fillable');
    const guarded = phpStringArrayProperty(body, 'guarded');
    const table = tableValue ? { value: tableValue, explicit: true } : null;
    const primaryKey = pkValue ? { value: pkValue, explicit: true } : null;
    if (!table) unknowns.push({ code: 'MODEL_TABLE_IMPLICIT', model: slice.className, reason: 'Eloquent table name is implicit; static fact layer does not apply Laravel naming conventions' });
    if (!primaryKey) unknowns.push({ code: 'MODEL_PRIMARY_KEY_IMPLICIT', model: slice.className, reason: 'Eloquent primary key is implicit; static fact layer does not assume id' });

    const relations = [];
    const relationRe = /function\s+([A-Za-z_]\w*)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\s*\}/g;
    for (const m of body.matchAll(relationRe)) {
      const morphTo = m[2].match(/\$this->morphTo\s*\(/);
      const typed = m[2].match(/\$this->(belongsTo|hasOne|hasMany|belongsToMany|morphOne|morphMany|morphToMany|morphedByMany|hasOneThrough|hasManyThrough)\s*\(\s*([A-Za-z_\\][A-Za-z0-9_\\]*)::class(?:\s*,\s*["']([^"']+)["'])?/);
      if (!morphTo && !typed) continue;
      const kind = morphTo ? 'morphTo' : typed[1];
      const targetClass = morphTo ? null : typed[2];
      const foreignKey = morphTo ? null : (typed[3] ?? null);
      const polymorphic = kind.startsWith('morph') || kind === 'morphedByMany';
      relations.push({ kind, name: m[1], targetClass, foreignKey, polymorphic });
      if (polymorphic) unknowns.push({ code: 'MODEL_POLYMORPHIC_RELATION', model: slice.className, relation: m[1], reason: 'polymorphic target type is runtime/data dependent' });
    }

    models.push({
      id: factId('laravel', file, slice.start, slice.className),
      className: slice.className,
      baseClass: 'Model',
      table,
      primaryKey,
      keyType,
      incrementing,
      fillable,
      guarded,
      relations,
      source: sourceRef(source, file, slice.start, slice.end),
    });
  }
  return envelope(source, file, 'laravel', 'php', models, unknowns);
}

export function assertModelFactsEnvelope(value) {
  if (!value || value.contract !== MODEL_FACTS_CONTRACT) throw new TypeError(`expected ${MODEL_FACTS_CONTRACT}`);
  if (!Array.isArray(value.models) || !Array.isArray(value.unknowns)) throw new TypeError('models/unknowns arrays are required');
  const ids = new Set();
  for (const model of value.models) {
    if (!model.id || ids.has(model.id)) throw new TypeError('model ids must be unique');
    ids.add(model.id);
    if (!model.className || !model.source?.file) throw new TypeError('model identity/source required');
    if (model.table && model.table.explicit !== true) throw new TypeError('table facts must be explicitly sourced');
    if (model.primaryKey && model.primaryKey.explicit !== true) throw new TypeError('primary key facts must be explicitly sourced');
  }
  return true;
}
