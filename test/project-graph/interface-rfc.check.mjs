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

// Applies one rejection edit to a copy of a real graph and returns what is wrong with the edit ([] when it
// works): the unedited graph must pass first, and the edit must give an error of the keyword it names and,
// where it names a schema node (`node`, written `$defs/httpFacet/properties/selected_adapter`), an error of that
// node, because two nodes can report one keyword for one value. Ajv writes the `schemaPath` of an error in a
// definition that it did not inline relative to that definition (`#/properties/selected_adapter/minLength`), and in
// full for one that it inlined (`#/$defs/candidate/properties/adapter_id/minLength`), so both spellings count.
export function mutationProblems(validate, graph, { keyword, node, mutate }) {
  const copy = JSON.parse(JSON.stringify(graph));
  if (validate(copy).length) return ['the unedited graph must pass first'];
  mutate(copy);
  const errors = validate(copy);
  const paths = node === undefined ? null : [`#/${node}/${keyword}`, `#/${node.replace(/^\$defs\/[^/]+\//, '')}/${keyword}`];
  if (errors.some((error) => error.keyword === keyword && (!paths || paths.includes(error.schemaPath)))) return [];
  return [`expected a "${keyword}" error${paths ? ` at ${paths[0]}` : ''}, got ${JSON.stringify(errors.map((error) => `${error.keyword} at ${error.schemaPath}`))}`];
}

// ---- Strings that may be empty and strings that may not (RFC section 2.6) -----------------------------
// The schema keywords the walk below reads or can pass over. Any other keyword stops the walk with an error,
// so a constraint that it cannot read is not skipped by mistake.
const WALKED_KEYWORDS = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description', 'examples', 'type', 'const', 'enum', 'pattern', 'minLength',
  'properties', 'required', 'additionalProperties', 'items', 'uniqueItems', 'minItems', 'maxItems', 'allOf', 'oneOf', 'if', 'then',
]);

// The data paths at which the schema takes a string (`projects[].facets.http.selected_adapter`, `[]` is an
// array element) and whether the empty string passes there: 'rejected', 'accepted', or 'mixed' where the
// nodes that describe one path disagree. A branch of `allOf`, `oneOf` or `then` describes the same path as
// its parent, and `if` only chooses the branch. `open` lists the objects that have no `properties`: their
// strings are free-form.
export function schemaStringPositions(doc) {
  const verdicts = new Map();
  const open = new Set();
  const walk = (node, at, via) => {
    for (const key of Object.keys(node)) {
      if (!WALKED_KEYWORDS.has(key)) throw new Error(`the walk does not read the schema keyword "${key}" (at ${at || 'the root'})`);
    }
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) throw new Error(`the walk does not read additionalProperties at ${at}`);
    if (node.$ref) {
      if (via.includes(node.$ref)) throw new Error(`${node.$ref} refers to itself`);
      walk(node.$ref.slice(2).split('/').reduce((target, key) => target[key], doc), at, [...via, node.$ref]);
    }
    const takesString = node.const !== undefined ? typeof node.const === 'string'
      : node.enum ? node.enum.some((value) => typeof value === 'string')
        : [].concat(node.type ?? []).includes('string');
    if (takesString) {
      const refuses = node.const !== undefined ? node.const !== ''
        : node.enum ? !node.enum.includes('')
          : (node.minLength ?? 0) > 0 || (node.pattern !== undefined && !new RegExp(node.pattern, 'u').test(''));
      verdicts.set(at, [...(verdicts.get(at) ?? []), refuses]);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, at ? `${at}.${key}` : key, via);
    if (node.items) walk(node.items, `${at}[]`, via);
    for (const child of [...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.then ? [node.then] : [])]) walk(child, at, via);
    if (node.type === 'object' && !node.properties) open.add(at);
  };
  walk(doc, '', []);
  const state = (list) => (list.every(Boolean) ? 'rejected' : list.some(Boolean) ? 'mixed' : 'accepted');
  return {
    positions: Object.fromEntries([...verdicts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([at, list]) => [at, state(list)])),
    open: [...open].sort(),
  };
}

// Section 2.6 names the data paths of a row in its second cell, in backticks, and starts the third cell with
// `rejected` or `accepted`. The table must list the positions of the walk, each once, in the state it finds.
export function stringPositionProblems(positions, rows) {
  const stated = new Map();
  const problems = [];
  for (const [value, paths, empty] of rows) {
    const state = empty.match(/^(rejected|accepted)\b/)?.[1];
    if (!state) problems.push(`${value}: the cell for the empty string does not start with rejected or accepted`);
    for (const [, at] of paths.matchAll(/`([^`]+)`/g)) {
      if (stated.has(at)) problems.push(`${at} is listed twice`);
      stated.set(at, state);
    }
  }
  return [
    ...problems,
    ...Object.keys(positions).filter((at) => !stated.has(at)).map((at) => `${at} takes a string in the schema and is not in the table`),
    ...[...stated.keys()].filter((at) => !(at in positions)).map((at) => `${at} is in the table and takes no string in the schema`),
    ...Object.entries(positions).filter(([at, state]) => stated.has(at) && stated.get(at) !== state)
      .map(([at, state]) => `${at}: the schema says ${state} and the table says ${stated.get(at)}`),
  ];
}

// The strings of a graph, each with its data path, the free-form `open` objects left out.
export function stringLeaves(value, open, at = '', found = []) {
  for (const [key, child] of Object.entries(value)) {
    const here = Array.isArray(value) ? `${at}[]` : at ? `${at}.${key}` : key;
    if (open.some((free) => here === free || here.startsWith(`${free}.`) || here.startsWith(`${free}[`))) continue;
    if (typeof child === 'string') found.push({ at: here, holder: value, key });
    else if (child && typeof child === 'object') stringLeaves(child, open, here, found);
  }
  return found;
}

// Puts the empty string in place of each string of each real graph in turn and compares the verdict of the
// validator with the walk: a position the walk calls 'rejected' must fail, an 'accepted' one must pass. Every
// position of the walk has to be met in some graph, so a string that no case produces is reported, not assumed.
export function emptyStringProblems(validate, graphs, { positions, open }) {
  const problems = new Set();
  const met = new Set();
  for (const [name, original] of Object.entries(graphs)) {
    const graph = JSON.parse(JSON.stringify(original));
    if (validate(graph).length) {
      problems.add(`${name}: the graph is not valid before an empty string is put in`);
      continue;
    }
    for (const { at, holder, key } of stringLeaves(graph, open)) {
      const kept = holder[key];
      holder[key] = '';
      const passes = validate(graph).length === 0;
      holder[key] = kept;
      met.add(at);
      const state = positions[at];
      if (state === undefined) problems.add(`${at} holds a string in ${name} and the schema walk lists no such position`);
      else if (state === 'mixed' || passes !== (state === 'accepted')) problems.add(`${at}: an empty string ${passes ? 'passes' : 'fails'} in ${name} and the schema walk says ${state}`);
    }
  }
  for (const at of Object.keys(positions)) if (!met.has(at)) problems.add(`no real graph holds a string at ${at}`);
  return [...problems];
}
