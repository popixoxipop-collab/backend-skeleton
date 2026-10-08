// Pure helpers for interface-rfc.test.mjs. Not a test file.
import fs from 'node:fs';
import path from 'node:path';

const NAME = '[a-z][a-z0-9-]*';
const matches = (re, text) => [...text.matchAll(re)].map((m) => m[1]);
const unique = (list) => [...new Set(list)].sort();

// Vocabulary as the T02 source spells it. A restructured source line makes a list empty, which the
// comparison against the record reports as a difference rather than hiding it.
export function extractSourceLiterals(repoRoot) {
  const read = (name) => fs.readFileSync(path.join(repoRoot, 'scanners', 'project-graph', name), 'utf8');
  const index = read('index.mjs');
  const shadow = read('shadow.mjs');
  const markerKinds = matches(new RegExp(`\\{\\s*kind:\\s*'(${NAME})',\\s*test:`, 'g'), index);
  const edgeKinds = matches(new RegExp(`kind:\\s*'(${NAME})',\\s*from_project_id`, 'g'), index);
  const everyKind = matches(new RegExp(`\\bkind:\\s*'(${NAME})'`, 'g'), index);
  const classified = new Set([...markerKinds, ...edgeKinds]);
  const projectKindLine = index.match(/const kind = (selected \?[^;\n]+);/)?.[1] ?? '';
  const reasonLine = index.match(/selection_reason:\s*([^\n]+)/)?.[1] ?? '';
  return {
    graph_schema: index.match(/PROJECT_GRAPH_DRAFT = '([^']+)'/)?.[1] ?? null,
    shadow_schema: shadow.match(/schema: '(sbf\.project-scan-shadow\/[a-z0-9-]+)'/)?.[1] ?? null,
    project_kinds: unique(matches(/'([a-z]+)'/g, projectKindLine)),
    selection_reasons: unique(matches(new RegExp(`'(${NAME})'`, 'g'), reasonLine)),
    marker_kinds: unique(markerKinds),
    edge_kinds: unique(edgeKinds),
    unresolved_kinds: unique(everyKind.filter((kind) => !classified.has(kind))),
    error_codes: unique([
      ...matches(/\.code = '(PROJECT_[A-Z_]+)'/g, index),
      ...matches(/\.code = '(PROJECT_[A-Z_]+)'/g, shadow),
    ]),
  };
}

export function diffLists(label, actual, recorded) {
  const have = new Set(actual);
  const want = new Set(recorded);
  return [
    ...[...have].filter((item) => !want.has(item)).map((item) => `${label}: "${item}" is not in the record`),
    ...[...want].filter((item) => !have.has(item)).map((item) => `${label}: "${item}" is recorded but not found`),
  ];
}

// `recorded` may carry more keys than the source side extracts (source_roles, facets); only keys
// present in `actual` are compared.
export function checkLiterals(actual, recorded, label = 'source') {
  const problems = [];
  for (const [key, value] of Object.entries(actual)) {
    if (Array.isArray(value)) problems.push(...diffLists(`${label} ${key}`, value, recorded[key] ?? []));
    else if (value !== recorded[key]) problems.push(`${label} ${key}: "${value}" differs from the record "${recorded[key]}"`);
  }
  return problems;
}

export function schemaVocabulary(doc) {
  const defs = doc.$defs;
  const kinds = (variant) => variant.properties.kind.enum ?? [variant.properties.kind.const];
  return {
    graph_schema: doc.properties.schema.const,
    project_kinds: unique(defs.project.properties.kind.enum),
    source_roles: unique(defs.role.enum),
    selection_reasons: unique(defs.httpFacet.properties.selection_reason.enum),
    marker_kinds: unique(defs.marker.properties.kind.enum),
    edge_kinds: unique(defs.edge.oneOf.flatMap(kinds)),
    unresolved_kinds: unique(defs.unresolved.oneOf.flatMap(kinds)),
    facets: unique(defs.project.properties.facets.required),
  };
}

// unresolved kind -> the fields beside `kind` and `message` that the schema requires for it.
export function schemaUnresolvedFields(doc) {
  const out = {};
  for (const variant of doc.$defs.unresolved.oneOf) {
    const { kind } = variant.properties;
    const fields = variant.required.filter((name) => name !== 'kind' && name !== 'message').sort();
    for (const name of kind.enum ?? [kind.const]) out[name] = fields;
  }
  return out;
}

// Names the text must mention. `quoted` demands the exact `name` in backticks, for vocabulary that
// would otherwise match ordinary prose; exports are matched as whole words instead.
export function missingFromText(text, names, { quoted = false } = {}) {
  return names.filter((name) => (quoted
    ? !text.includes('`' + name + '`')
    : !new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text)));
}

export function sectionProblems(text, required) {
  const lines = text.split('\n');
  const problems = [];
  let cursor = -1;
  for (const title of required) {
    const at = lines.indexOf(`## ${title}`, cursor + 1);
    if (at < 0) problems.push(`missing or out-of-order section "## ${title}"`);
    else cursor = at;
  }
  return problems;
}

export function sectionLines(text, headingPrefix) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,3} /.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

// Markdown table rows as arrays of trimmed cells, header and separator rows dropped.
export function tableRows(lines) {
  return lines
    .filter((line) => line.startsWith('|'))
    .map((line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()))
    .slice(2);
}

export function schemaLiteralHits(dir) {
  const hits = [];
  const pattern = /schemas\/[a-zA-Z0-9_-]+\.schema\.json/;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (pattern.test(fs.readFileSync(abs, 'utf8'))) hits.push(abs);
    }
  };
  walk(dir);
  return hits;
}
