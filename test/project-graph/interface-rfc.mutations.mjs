// Edits that the draft graph schema must reject. Not a test file: interface-rfc.test.mjs applies each
// edit to a clone of a real graph, checks that the unedited clone passes, then expects a validation
// error whose `keyword` is the one named here, so an edit cannot fail for an unrelated reason.
// `base` is the real graph the edit applies to: normal, tie (specificity_tie) or duplicate
// (duplicate_local_package).
const project = (graph, root) => graph.projects.find((p) => p.root === root);
const edit = (name, base, keyword, mutate) => ({ name, base, keyword, mutate });
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
  edit('windows drive path', 'normal', 'pattern', (g) => { g.files_read.push('C:/repo/x.js'); }),
  edit('backslash path', 'normal', 'pattern', (g) => { g.files_read.push('services\\api\\x.js'); }),
  edit('duplicate files_read entry', 'normal', 'uniqueItems', (g) => { g.files_read.push(g.files_read[0]); }),
  edit('dot-dot marker path', 'normal', 'pattern', (g) => { project(g, 'services/api').markers[0].path = '../outside/package.json'; }),
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
];
