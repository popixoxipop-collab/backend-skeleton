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
  const roles = read('source-role.mjs');
  // The members of `const NAME = new Set([...])`, as the source spells them.
  const setMembers = (source, name) =>
    unique(matches(/'([^']+)'/g, source.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`))?.[1] ?? ''));
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
    hard_ignored_directories: setMembers(index, 'HARD_IGNORES'),
    vendor_segments: setMembers(roles, 'VENDOR_SEGMENTS'),
    reference_segments: setMembers(roles, 'REFERENCE_SEGMENTS'),
    generated_segments: setMembers(roles, 'GENERATED_SEGMENTS'),
    template_segments: setMembers(roles, 'TEMPLATE_SEGMENTS'),
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
    // The marker `kind` is a non-empty string, not an enum (a caller's markerRules can emit any), so the
    // defaults are read from its `examples`.
    marker_kinds: unique(defs.marker.properties.kind.examples ?? []),
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

// Section 2.5 and the tables that cite it tag a statement with ``probe: options `case` `` (several names
// may follow one tag: ``probe: options `a`, `b` ``, and a tag may wrap onto the next line). Every tagged
// name must be a recorded option case and every recorded case must be tagged at least once, so a
// statement cannot outlive its evidence.
const OPTION_TAG = /probe: options ((?:`[a-z_]+`(?:,\s+and\s+|,\s*|\s+and\s+)?)+)/g;

export function optionTags(text) {
  return [...text.matchAll(OPTION_TAG)].flatMap((tag) => [...tag[1].matchAll(/`([a-z_]+)`/g)].map((name) => name[1]));
}

export function optionTagProblems(text, recordedNames) {
  const recorded = new Set(recordedNames);
  const tagged = new Set(optionTags(text));
  return [
    ...[...tagged].filter((name) => !recorded.has(name)).map((name) => `the RFC tags probe: options \`${name}\`, which is not a recorded case`),
    ...[...recorded].filter((name) => !tagged.has(name)).map((name) => `recorded option case \`${name}\` is not tagged anywhere in the RFC`),
  ];
}

// The record lists the option cases by group. `live` holds the names the cases module builds now.
export function optionCaseListProblems(recorded, live) {
  const problems = [];
  const groups = { accepted: recorded.accepted, unchecked: Object.keys(recorded.unchecked), malformed: recorded.malformed };
  for (const [group, names] of Object.entries(groups)) {
    if (names.some((name, i) => i > 0 && names[i - 1] >= name)) problems.push(`record option_cases.${group} is not sorted and unique`);
    problems.push(...diffLists(`option_cases.${group}`, live[group], names));
  }
  return problems;
}

// The last cell of a section 5.1 row is `source` or one or more probe tags joined by `;`:
// ``probe: negative `x` `` or ``probe: options `a`, `b` ``. A probe-tagged kind must come out of every
// named case; a source-tagged kind must come out of none. `produced` maps probe -> case -> kinds.
const PROBE_TAG = /^probe: (negative|options) ((?:`[a-z_]+`(?:,\s+and\s+|,\s*|\s+and\s+)?)+)$/;

export function kindTagProblems(rows, produced) {
  const problems = [];
  for (const { kind, tag } of rows) {
    if (tag === 'source') {
      for (const [probe, cases] of Object.entries(produced)) {
        for (const [name, kinds] of Object.entries(cases)) {
          if (kinds.includes(kind)) problems.push(`${kind} is tagged source but probe ${probe} case ${name} produces it`);
        }
      }
      continue;
    }
    for (const part of tag.split(';').map((piece) => piece.trim())) {
      const parsed = part.match(PROBE_TAG);
      if (!parsed) {
        problems.push(`${kind}: cannot read the tag "${part}"`);
        continue;
      }
      for (const name of [...parsed[2].matchAll(/`([a-z_]+)`/g)].map((m) => m[1])) {
        const kinds = produced[parsed[1]][name];
        if (!kinds) problems.push(`${kind}: the tag names probe ${parsed[1]} case ${name}, which is not recorded`);
        else if (!kinds.includes(kind)) problems.push(`${kind}: probe ${parsed[1]} case ${name} does not produce it`);
      }
    }
  }
  return problems;
}

// A marker rule's `test` gets the base name of every regular file the walk visits, as its only
// argument: none for a symbolic link or for anything below a hard-ignored directory (section 2.5).
export function markerArgumentProblems(regularFiles, calls) {
  const wanted = regularFiles.filter((rel) => !rel.split('/').includes('node_modules')).map((rel) => rel.split('/').pop()).sort();
  const got = calls.map((args) => (args.length === 1 && typeof args[0] === 'string' ? args[0] : `<${args.length} arguments>`)).sort();
  return JSON.stringify(got) === JSON.stringify(wanted)
    ? []
    : [`marker rule arguments ${JSON.stringify(got)} differ from the regular files outside node_modules ${JSON.stringify(wanted)}`];
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

// Statements of the RFC that a check asserts against the code. The RFC wraps its lines, so whitespace
// is compared as one space; a reworded statement is reported until the check is read again.
export function missingFragments(text, fragments) {
  const flat = text.replace(/\s+/g, ' ');
  return fragments.filter((fragment) => !flat.includes(fragment.replace(/\s+/g, ' ')));
}

// Section 4 lists the base names the probe `default_markers` feeds to the nine default rules, after
// "Match:" with the kind each gets and after "No match:" without one. `table` maps every probed name
// to its kind, or to null when no default rule takes it.
export function defaultMarkerProblems(text, table) {
  const found = text.replace(/\s+/g, ' ').match(/ Match: (.+?) No match: (.+?) \[probe: options `default_markers`\]/);
  if (!found) return ['section 4 has no "Match: ... No match: ..." list tagged probe: options `default_markers`'];
  const matched = Object.fromEntries([...found[1].matchAll(/`([^`]+)` \(`([a-z-]+)`\)/g)].map((m) => [m[1], m[2]]));
  const unmatched = [...found[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const names = Object.keys(table);
  return [
    ...diffLists('default marker names that match', Object.keys(matched), names.filter((name) => table[name])),
    ...diffLists('default marker names that do not match', unmatched, names.filter((name) => !table[name])),
    ...Object.entries(matched).filter(([name, kind]) => table[name] && table[name] !== kind)
      .map(([name, kind]) => `default marker "${name}" is listed as ${kind} and the probe says ${table[name]}`),
  ];
}

const keywordsOf = (errors) => [...new Set(errors.map((error) => error.keyword))].sort();

// `graphs` maps a case name to a graph and `validate` returns the schema errors ([] when valid). An
// accepted case must pass.
export function acceptanceProblems(validate, graphs) {
  return Object.entries(graphs).flatMap(([name, graph]) => {
    const errors = validate(graph);
    return errors.length ? [`${name}: the schema rejects an accepted case (${keywordsOf(errors).join(', ')})`] : [];
  });
}

// An unchecked case must fail the schema, and for the keyword the record names (`keywords`: name -> keyword).
export function rejectionProblems(validate, graphs, keywords) {
  return Object.entries(graphs).flatMap(([name, graph]) => {
    const got = keywordsOf(validate(graph));
    if (got.length === 0) return [`${name}: the schema accepts an unchecked case`];
    return got.includes(keywords[name]) ? [] : [`${name}: the schema rejects it for ${got.join(', ')} and not for ${keywords[name]}`];
  });
}
