// Edits that the draft graph schema must reject. Not a test file: interface-rfc.test.mjs applies each
// edit to a clone of a real graph, checks that the unedited clone passes, then expects a validation
// error whose `keyword` is the one named here, so an edit cannot fail for an unrelated reason.
// `base` is the real graph the edit applies to: normal, tie (specificity_tie), duplicate
// (duplicate_local_package) or scope (out_of_scope_detection).
// An entry can also name the node whose keyword must give the error (`node`, the place of the node in the
// schema file), because two nodes can give one keyword for one value and the edit would still fail with the
// keyword of the other node. The test then drops that one keyword and expects the entry to fail.
const project = (graph, root) => graph.projects.find((p) => p.root === root);
const edit = (name, base, keyword, mutate, pin = {}) => ({ name, base, keyword, mutate, ...pin });
const sha = (char, count) => `sha256:${char.repeat(count)}`;

export const REJECTED_MUTATIONS = [
  edit('extra top-level property', 'normal', 'additionalProperties', (g) => { g.extra = 1; }),
  edit('missing notes', 'normal', 'required', (g) => { delete g.notes; }),
  edit('wrong schema constant', 'normal', 'const', (g) => { g.schema = 'sbf.project-graph/draft-2'; }),
  edit('absolute repo_root', 'normal', 'const', (g) => { g.repo_root = '/abs/repo'; }),
  edit('unknown facet', 'normal', 'additionalProperties', (g) => { project(g, 'services/api').facets.queue = {}; }),
  edit('missing http facet', 'normal', 'required', (g) => { project(g, 'services/api').facets = {}; }),
  edit('extra project property', 'normal', 'additionalProperties', (g) => { project(g, '.').score = 1; }),
  edit('unknown project kind', 'normal', 'enum', (g) => { project(g, '.').kind = 'service'; }),
  edit('unknown project role', 'normal', 'enum', (g) => { project(g, 'examples/demo').project_role = 'production'; }),
  edit('project id without prefix', 'normal', 'pattern', (g) => { project(g, 'services/api').project_id = 'services/api'; }),
  edit('ambiguous project with a selected adapter', 'tie', 'type', (g) => { g.projects[0].facets.http.selected_adapter = 'a-http'; }),
  edit('tie reported as unique', 'tie', 'const', (g) => { g.projects[0].facets.http.selection_reason = 'unique-highest-specificity'; }),
  edit('tie with one tied id', 'tie', 'minItems', (g) => { g.projects[0].facets.http.ambiguous_adapter_ids = ['a-http']; }),
  edit('application without a unique selection reason', 'normal', 'const', (g) => {
    project(g, 'services/api').facets.http.selection_reason = 'no-first-class-adapter';
  }),
  edit('application that also names a fallback', 'normal', 'type', (g) => { project(g, 'services/api').fallback_adapter = 'generic-grep'; }),
  edit('aggregate with a read set', 'normal', 'type', (g) => {
    project(g, '.').selected_adapter_read_set = structuredClone(project(g, 'services/api').selected_adapter_read_set);
  }),
  edit('candidate missing confidence', 'normal', 'required', (g) => { delete project(g, 'services/api').facets.http.candidates[0].confidence; }),
  edit('nested detection with an absolute root', 'normal', 'pattern', (g) => { project(g, '.').nested_detections[0].detected_root = '/abs/service'; }),
  edit('absolute path in files_read', 'normal', 'pattern', (g) => { g.files_read.push('/etc/passwd'); }),
  edit('empty path in files_read', 'normal', 'pattern', (g) => { g.files_read.push(''); }),
  edit('duplicate files_read entry', 'normal', 'uniqueItems', (g) => { g.files_read.push(g.files_read[0]); }),
  edit('dot-dot marker path', 'normal', 'pattern', (g) => { project(g, 'services/api').markers[0].path = '../outside/package.json'; }),
  edit('dot-dot segment inside a path', 'normal', 'pattern', (g) => { g.files_read.push('services/../etc/x.js'); }),
  edit('trailing dot-dot segment', 'normal', 'pattern', (g) => { g.files_read.push('services/..'); }),
  // Marker kinds come from the caller's markerRules too (RFC section 2.5): any non-empty string passes,
  // an empty or non-string value does not.
  edit('marker kind that is empty', 'normal', 'minLength', (g) => { project(g, 'services/api').markers[0].kind = ''; }),
  edit('marker kind that is not a string', 'normal', 'type', (g) => { project(g, 'services/api').markers[0].kind = 42; }),
  // The id of a fallback adapter is copied into `fallback_adapter` of the project, where only the project rules see it.
  edit('fallback adapter that is empty', 'normal', 'minLength', (g) => { project(g, '.').fallback_adapter = ''; }),
  edit('fallback adapter that is not a string', 'normal', 'type', (g) => { project(g, '.').fallback_adapter = 7; }),
  edit('digest with another algorithm', 'normal', 'pattern', (g) => { project(g, 'services/api').markers[0].digest = `sha1:${'a'.repeat(40)}`; }),
  edit('uppercase digest', 'normal', 'pattern', (g) => { project(g, 'services/api').markers[0].digest = sha('A', 64); }),
  edit('unknown edge kind', 'normal', 'const', (g) => { g.project_edges[0].kind = 'depends-on'; }),
  edit('contains edge carrying evidence', 'normal', 'maxItems', (g) => { g.project_edges[0].evidence = [{ path: 'package.json', digest: sha('0', 64) }]; }),
  edit('dependency edge without a name', 'normal', 'required', (g) => {
    delete g.project_edges.find((e) => e.kind === 'local-package-dependency').dependency_name;
  }),
  edit('unknown unresolved kind', 'normal', 'oneOf', (g) => { g.unresolved.push({ kind: 'mystery', path: 'x', message: 'm' }); }),
  edit('unresolved entry missing project_root', 'normal', 'required', (g) => {
    g.unresolved.push({ kind: 'adapter-detect-error', adapter_id: 'a', message: 'm' });
  }),
  edit('duplicate package name with one project', 'duplicate', 'minItems', (g) => {
    const entry = g.unresolved.find((e) => e.kind === 'ambiguous-local-package-name');
    entry.project_ids = [entry.project_ids[0]];
  }),
  edit('registry load error without a message', 'normal', 'required', (g) => { g.registry_load_errors = [{ file: 'x.mjs' }]; }),
  // Ids and names that must not be empty (RFC section 2.6). The plan code tests the selected and the fallback adapter
  // for truthiness, so an empty id there would drop the project from the plan without a trace.
  edit('application with an empty selected adapter', 'normal', 'minLength', (g) => { project(g, 'services/api').facets.http.selected_adapter = ''; },
    { node: '$defs/httpFacet/allOf/0/then/properties/selected_adapter' }),
  edit('aggregate with an empty selected adapter', 'normal', 'minLength', (g) => { project(g, '.').facets.http.selected_adapter = ''; },
    { node: '$defs/httpFacet/properties/selected_adapter' }),
  edit('tie with an empty adapter id', 'tie', 'minLength', (g) => { g.projects[0].facets.http.ambiguous_adapter_ids[0] = ''; },
    { node: '$defs/httpFacet/properties/ambiguous_adapter_ids/items' }),
  edit('candidate with an empty adapter id', 'normal', 'minLength', (g) => { project(g, 'services/api').facets.http.candidates[0].adapter_id = ''; },
    { node: '$defs/candidate/properties/adapter_id' }),
  edit('package name that is empty', 'normal', 'minLength', (g) => { project(g, 'services/api').local_package.name = ''; },
    { node: '$defs/localPackage/properties/name' }),
  edit('out-of-scope detection with an empty root', 'scope', 'minLength', (g) => {
    g.unresolved.find((u) => u.kind === 'out-of-scope-detection').detected_root = '';
  }, { node: '$defs/unresolved/oneOf/5/properties/detected_root' }),
  edit('registry load error with an empty file name', 'normal', 'minLength', (g) => { g.registry_load_errors = [{ file: '', message: 'm' }]; },
    { node: 'properties/registry_load_errors/items/properties/file' }),
];

// The edits above that name a node, each with the values that are allowed there. `of` is the name of the edit it
// belongs to. The unedited graph passes, and so does the edited one: a non-empty value, and `null` where null is
// allowed today.
const accept = (name, of, base, mutate) => ({ name, of, base, mutate });
export const ACCEPTED_EDITS = [
  accept('application with a one-character selected adapter', 'application with an empty selected adapter', 'normal',
    (g) => { project(g, 'services/api').facets.http.selected_adapter = 'x'; }),
  accept('aggregate with no selected adapter', 'aggregate with an empty selected adapter', 'normal',
    (g) => { project(g, '.').facets.http.selected_adapter = null; }),
  accept('tie with a one-character adapter id', 'tie with an empty adapter id', 'tie',
    (g) => { g.projects[0].facets.http.ambiguous_adapter_ids[0] = 'x'; }),
  accept('candidate with a one-character adapter id', 'candidate with an empty adapter id', 'normal',
    (g) => { project(g, 'services/api').facets.http.candidates[0].adapter_id = 'x'; }),
  accept('one-character package name', 'package name that is empty', 'normal',
    (g) => { project(g, 'services/api').local_package.name = 'x'; }),
  accept('package without a name', 'package name that is empty', 'normal',
    (g) => { project(g, 'services/api').local_package.name = null; }),
  accept('out-of-scope detection at the repository root', 'out-of-scope detection with an empty root', 'scope',
    (g) => { g.unresolved.find((u) => u.kind === 'out-of-scope-detection').detected_root = '.'; }),
  accept('out-of-scope detection above the repository', 'out-of-scope detection with an empty root', 'scope',
    (g) => { g.unresolved.find((u) => u.kind === 'out-of-scope-detection').detected_root = '../x'; }),
  // The message is free text and stays allowed to be empty.
  accept('registry load error with a file name and an empty message', 'registry load error with an empty file name', 'normal',
    (g) => { g.registry_load_errors = [{ file: 'x.mjs', message: '' }]; }),
];
