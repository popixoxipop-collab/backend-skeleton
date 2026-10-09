// Synthetic repositories shared by the RFC probe and the RFC test. Not a test file.
// Every graph here is built with adapters defined in interface-rfc.fixtures.mjs, except the
// registered case, which uses the registry on purpose and is therefore not hash-pinned.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildProjectGraph, buildProjectScanPlan, discoverProjectRoots } from '../../scanners/project-graph/index.mjs';
import { buildRegisteredProjectGraph, buildRegisteredProjectScanPlan } from '../../scanners/project-graph/registered.mjs';
import { executeProjectScanPlan } from '../../scanners/project-graph/shadow.mjs';
import {
  adapter, canon, express, fallback, fixture, hasFile, listJs, markerAdapter, scanStub, spring,
} from './interface-rfc.fixtures.mjs';

export const pkg = (value) => JSON.stringify(value);
export const withReadSet = { listReadSet: (projectRoot) => listJs(projectRoot), scan: scanStub };

export const NORMAL_FILES = {
  'services/api/package.json': pkg({ name: '@demo/api', dependencies: { '@demo/shared': 'workspace:*', express: '^5.0.0' } }),
  'services/api/src/server.js': 'app.get("/health", () => {});\n',
  'services/api/tests/helper.js': 'module.exports = {};\n',
  'packages/shared/package.json': pkg({ name: '@demo/shared' }),
  'packages/shared/index.js': 'module.exports = {};\n',
  'examples/demo/package.json': pkg({ name: '@demo/example', dependencies: { express: '^5.0.0' } }),
  'examples/demo/server.js': 'app.get("/demo", () => {});\n',
  'backend-java/pom.xml': '<project/>\n',
  'backend-java/src/main/java/App.java': 'class App {}\n',
};

export function normalCase() {
  const root = fixture(NORMAL_FILES);
  const graph = buildProjectGraph({ repoRoot: root, adapters: [fallback, spring(), express(withReadSet)] });
  return { root, graph };
}

export function negativeCases() {
  const build = (files, adapters) => buildProjectGraph({ repoRoot: fixture(files), adapters });
  const named = (name) => pkg({ name });
  return {
    specificity_tie: build({ 'package.json': '{}' }, [
      markerAdapter('b-http', 90, hasFile('package.json')), markerAdapter('a-http', 90, hasFile('package.json')), fallback]),
    duplicate_local_package: build({
      'consumer/package.json': pkg({ name: '@demo/consumer', dependencies: { '@demo/shared': 'workspace:*' } }),
      'shared-a/package.json': named('@demo/shared'), 'shared-b/package.json': named('@demo/shared'),
    }, [fallback]),
    unlocated_detection: build({ 'package.json': '{}' }, [adapter('weird-http', 70, () => true), fallback]),
    out_of_scope_detection: build({ 'service/package.json': '{}' }, [
      adapter('escape-http', 70, (dir) => (path.basename(dir) === 'service' ? path.dirname(dir) : null)), fallback]),
    detect_error: build({ 'service/package.json': '{"x":"express"}' }, [
      adapter('broken-http', 99, () => { throw new Error('boom'); }), express(), fallback]),
    malformed_metadata: build({ 'broken/package.json': '{ nope', 'good/package.json': named('@demo/good') }, [fallback]),
    read_set_escape: build({ 'app/package.json': '{}' }, [
      markerAdapter('escaping-http', 90, hasFile('package.json'), 'root', { listReadSet: () => ['../outside.js'] }), fallback]),
  };
}

export function registeredCase() {
  const root = fixture({
    'package.json': '{"private":true}',
    'spring/pom.xml': '<project/>',
    'spring/src/main/java/com/example/App.java': [
      'package com.example;', 'import org.springframework.web.bind.annotation.*;', '@RestController',
      'class App { @GetMapping("/health") String health() { return "ok"; } }',
    ].join('\n'),
    'fastapi/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.100"]\n',
    'fastapi/app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  });
  return { root, ...buildRegisteredProjectScanPlan(root) };
}

// ---- Options and caller-supplied input (RFC section 2.5) -----------------------------------------
// `accepted` cases are inputs the builder takes; each graph must validate against the draft schema.
// `unchecked` cases are inputs the builder takes without checking and the schema rejects; the record
// names the schema keyword. Messages carry paths and Node prose, so the probe prints structure only.
const named = (name, more = {}) => pkg({ name, ...more });
const kindRule = (kind, file) => ({ kind, test: (name) => name === file });
// Recognises only the directories whose base name is listed, so one project can be shaped per option.
const inDirs = (...dirs) => (dir) => (dirs.includes(path.basename(dir)) ? dir : null);
const bare = (id, extra = {}) => ({ id, ...extra });
const build = (files, options) => {
  const root = fixture(files);
  return { root, graph: buildProjectGraph({ repoRoot: root, ...options }) };
};

function customMarkerKinds() {
  const files = {
    'plain/package.json': named('plain'),
    'deno-app/deno.json': '{}',
    'odd-kind/odd.cfg': '',
    'numeric/one.cfg': '',
    'spaces/space.cfg': '',
    'truthy/truthy.cfg': '',
    'blank/blank.cfg': '',
    'both/both.cfg': '',
    'meta/meta.json': named('@odd/meta', { private: true }),
    // Two markers of kind node-package in one project: the package facts come from the first by path.
    'pair/first.json': named('first-by-path'),
    'pair/second.json': named('second-by-path'),
    'broken-pair/first.json': 'not json',
    'broken-pair/second.json': named('valid-but-second'),
    'named-like-a-marker/deno.json/inner.txt': '',
    'node_modules/dep/deno.json': '{}',
  };
  const root = fixture(files);
  // Neither link is followed: the file link would put a marker on the root, the directory link would
  // add a second project.
  fs.symlinkSync(path.join(root, 'deno-app', 'deno.json'), path.join(root, 'deno.json'));
  fs.symlinkSync(path.join(root, 'deno-app'), path.join(root, 'linked-dir'));
  const calls = [];
  const laterCalls = [];
  const first = kindRule('deno-project', 'deno.json');
  const markerRules = [
    { kind: first.kind, test: (...args) => { calls.push(args); return first.test(...args); } },
    kindRule('Odd Kind 日本', 'odd.cfg'),
    kindRule('1', 'one.cfg'),
    kindRule(' ', 'space.cfg'),
    { kind: 'truthy-result', test: (name) => (name === 'truthy.cfg' ? 'yes' : 0) },
    kindRule('', 'blank.cfg'),
    kindRule('never-reached', 'blank.cfg'),
    kindRule('first-rule-wins', 'both.cfg'),
    kindRule('second-rule-loses', 'both.cfg'),
    { kind: 'node-package', test: (name) => ['meta.json', 'first.json', 'second.json'].includes(name) },
    // Last, and never matching: it is asked only about the files that no rule above has matched.
    { kind: 'last-rule', test: (...args) => { laterCalls.push(args); return false; } },
  ];
  const graph = buildProjectGraph({ repoRoot: root, adapters: [fallback], markerRules });
  const byText = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  return {
    root,
    graph,
    extra: { regular_files: Object.keys(files).sort(), test_arguments: calls.sort(byText), last_rule_arguments: laterCalls.sort(byText) },
  };
}

function emptyMarkerRules() {
  const { root, graph } = build({ 'package.json': named('top'), 'a/package.json': named('a') },
    { adapters: [fallback], markerRules: [] });
  const roots = (markerRules) => buildRegisteredProjectGraph(root, { adapters: [fallback], markerRules }).projects.map((p) => p.root);
  // Rules that fail on the first regular file (see `marker_rules_null` and the cases after it) are never
  // called in a repository that has none.
  const empty = fixture({});
  const unusedRules = Object.fromEntries(Object.entries({ null: null, object: {}, null_rule: [null], rule_without_test: [{ kind: 'x' }] })
    .map(([label, markerRules]) => [label, buildProjectGraph({ repoRoot: empty, adapters: [], markerRules }).projects.map((p) => p.root)]));
  return {
    root,
    graph,
    extra: { registered_roots: { empty_array: roots([]), null: roots(null), omitted: roots(undefined) }, rules_never_called: unusedRules },
  };
}

// An adapter with nothing but `id` and `detect`: every optional field takes its default.
const adapterDefaults = () => build({ 'app/package.json': '{}' }, { adapters: [bare('bare-http', { detect: inDirs('app') })] });

// One adapter per directory, so no result depends on how the builder orders mixed specificity values.
function adapterValues() {
  const only = (id, dir, specificity, extra) => adapter(id, specificity, inDirs(dir), extra);
  const dirs = ['nan', 'text', 'infinity', 'negative', 'fraction', 'tied', 'described', 'odd-id',
    'null-fields', 'blank-fields', 'list-capabilities', 'text-capabilities', 'number-capabilities',
    'zero-text', 'empty-text', 'false-value'];
  const files = Object.fromEntries(dirs.map((dir) => [`${dir}/package.json`, '{}']));
  return build(files, {
    adapters: [
      only('nan-http', 'nan', Number.NaN),
      only('text-http', 'text', '5'),
      // Equal to 0 once converted, but not the number 0: candidates that record 0, never fallbacks.
      only('zero-text-http', 'zero-text', '0'),
      only('empty-text-http', 'empty-text', ''),
      only('false-http', 'false-value', false),
      only('infinity-http', 'infinity', Number.POSITIVE_INFINITY),
      only('negative-http', 'negative', -5),
      only('fraction-http', 'fraction', 1.5),
      only('tied-nan-http', 'tied', Number.NaN),
      only('tied-infinity-http', 'tied', Number.POSITIVE_INFINITY),
      only('Odd Id 日本', 'odd-id', 5),
      only('described-http', 'described', 5, {
        title: 'Described', confidence: 'medium', verificationBasis: 'custom-basis',
        capabilities: { http: true, nested: { depth: 1 } },
      }),
      // null takes the default like an omitted field; an empty string does not.
      only('null-http', 'null-fields', null, {
        title: null, confidence: null, verificationBasis: null, capabilities: null,
      }),
      only('blank-http', 'blank-fields', 5, { title: '', confidence: '', verificationBasis: '' }),
      // capabilities is spread into a new object whatever it is.
      only('list-http', 'list-capabilities', 5, { capabilities: ['http'] }),
      only('text-http-caps', 'text-capabilities', 5, { capabilities: 'ab' }),
      only('number-http', 'number-capabilities', 5, { capabilities: 5 }),
    ],
  });
}

// generic-grep is a fallback at any specificity; the last fallback in (specificity desc, id asc) order is kept.
function fallbackAdapters() {
  const every = (id, specificity) => adapter(id, specificity, inDirs('app'));
  return build({ 'app/package.json': '{}' }, {
    adapters: [every('zeta-inventory', 0), every('generic-grep', 7), every('inventory', 0)],
  });
}

function detectFailures() {
  return build({ 'a/package.json': '{}' }, {
    adapters: [
      bare('no-detect-http'),
      bare('throws-text-http', { detect: () => { throw 'boom'; } }),
      adapter('async-http', 50, async (dir) => dir),
    ],
  });
}

// What `detect` may return, one value per project directory (the directory name picks the value). A
// first-class adapter must return a shape that names the candidate; a fallback only has to return
// something other than null, undefined or false.
const nest = (dir) => path.join(dir, 'src', 'main', 'java');
const DETECT_VALUES = {
  'absolute-string': (dir) => dir,
  'java-source-string': (dir) => nest(dir),
  'project-root-object': (dir) => ({ projectRoot: dir }),
  'source-root-object': (dir) => ({ srcRoot: nest(dir) }),
  'project-root-first': (dir) => ({ projectRoot: dir, srcRoot: path.join(dir, 'other', 'src', 'main', 'java') }),
  'empty-project-root': (dir) => ({ projectRoot: '', srcRoot: nest(dir) }),
  'cwd-relative-string': (dir) => path.relative(process.cwd(), dir),
  'repo-relative-string': (dir) => path.basename(dir),
  'parent-directory': (dir) => path.dirname(dir),
  true: () => true,
  'empty-string': () => '',
  zero: () => 0,
  'not-a-number': () => Number.NaN,
  'empty-object': () => ({}),
  'array-of-roots': (dir) => [dir],
  null: () => null,
  undefined: () => undefined,
  false: () => false,
};
const FALLBACK_VALUES = {
  'fallback-true': () => true,
  'fallback-zero': () => 0,
  'fallback-empty-string': () => '',
  'fallback-false': () => false,
  'fallback-null': () => null,
};

function detectValues() {
  const pick = (table) => (dir) => table[path.basename(dir)]?.(dir);
  const files = Object.fromEntries([...Object.keys(DETECT_VALUES), ...Object.keys(FALLBACK_VALUES)]
    .map((dir) => [`${dir}/package.json`, '{}']));
  return build(files, {
    adapters: [
      adapter('value-http', 50, pick(DETECT_VALUES)),
      adapter('generic-grep', 0, pick(FALLBACK_VALUES), { confidence: 'low' }),
    ],
  });
}

// The selected adapter is looked up again in the caller's own array before its read set is captured, so a
// `detect` that removes its adapter from that array during the build gets `selected-adapter-missing`. This
// is the only way the entry is reachable (RFC section 5.1).
function adapterRemovedDuringBuild() {
  const adapters = [];
  const vanishing = adapter('vanishing-http', 50, (dir) => {
    if (path.basename(dir) !== 'app') return null;
    adapters.splice(adapters.indexOf(vanishing), 1);
    return dir;
  });
  adapters.push(vanishing);
  return build({ 'app/package.json': '{}' }, { adapters });
}

// One repository with a diagnostic from every stage of the build, to pin the order of `unresolved`
// (RFC section 5.1): discovery, then for each project root the adapter diagnostics followed by that
// root's read-set diagnostic (`f-app` has both), then package metadata, then the edges. Sorted by kind
// the same entries would come out in another order. The marker rule deletes the file it matches, as in
// vanishedMarker.
function unresolvedOrder() {
  const files = {
    'a-vanish/gone.cfg': '',
    'b-broken/package.json': '{ nope',
    'c-one/package.json': named('@dup/x'),
    'd-two/package.json': named('@dup/x'),
    'e-user/package.json': named('@dup/user', { dependencies: { '@dup/x': '1' } }),
    'f-app/package.json': named('@dup/app'),
  };
  const root = fixture(files);
  const victim = path.join(root, 'a-vanish', 'gone.cfg');
  const markerRules = [
    { kind: 'node-package', test: (name) => name === 'package.json' },
    { kind: 'vanishing', test: (name) => { if (name === 'gone.cfg') fs.rmSync(victim, { force: true }); return name === 'gone.cfg'; } },
  ];
  const adapters = [
    adapter('throwing-http', 70, (dir) => {
      if (['b-broken', 'f-app'].includes(path.basename(dir))) throw new Error('detect failed');
      return null;
    }),
    adapter('listing-http', 60, inDirs('f-app'), { listReadSet: () => ['missing.js'] }),
    fallback,
  ];
  return { root, graph: buildProjectGraph({ repoRoot: root, adapters, markerRules }) };
}

// What `listReadSet` may return, one shape per project directory (the directory name picks the shape).
const READ_SET_SHAPES = {
  'duplicates-collapse': (abs) => ['a.js', './a.js', 'sub/../a.js', path.join(abs, 'a.js')],
  'lists-a-marker': () => ['package.json', 'a.js'],
  'empty-list': () => [],
  'inside-ignored-directory': () => ['node_modules/m.js'],
  'directory-entry': () => ['.'],
  'missing-file': () => ['gone.js'],
  'not-an-array': () => 'a.js',
  'empty-entry': () => [''],
  'non-string-entry': () => [5],
  'outside-project': () => ['../other.js'],
  'listing-throws': () => { throw new Error('listing failed'); },
};

function readSetShapes() {
  const files = {};
  for (const dir of Object.keys(READ_SET_SHAPES)) {
    files[`${dir}/package.json`] = '{}';
    files[`${dir}/a.js`] = 'module.exports = {};\n';
  }
  files['inside-ignored-directory/node_modules/m.js'] = 'module.exports = {};\n';
  const listing = adapter('shape-http', 50, inDirs(...Object.keys(READ_SET_SHAPES)), {
    listReadSet: (abs) => READ_SET_SHAPES[path.basename(abs)](abs),
  });
  return build(files, { adapters: [listing] });
}

// package.json bodies, one project each (the directory name is the case), plus four packages that
// one project depends on through the four dependency fields.
function packageMetadata() {
  const depends = (field, name) => ({ [field]: { [name]: '1' } });
  const files = {
    'json-null/package.json': 'null',
    'json-array/package.json': '[]',
    'json-number/package.json': '42',
    'wrong-types/package.json': '{"name":5,"private":"true","dependencies":["x"],"workspaces":"apps/*"}',
    'empty-name/package.json': '{"name":""}',
    'name-format/package.json': named('Not A Valid Name!'),
    'workspaces-object/package.json': '{"name":"ws","private":true,"workspaces":{"packages":["b","a",1,null]}}',
    'self-dependency/package.json': named('self', depends('dependencies', 'self')),
    'dependency-fields/package.json': named('fields', {
      ...depends('dependencies', 'dep-a'), ...depends('devDependencies', 'dep-b'),
      ...depends('peerDependencies', 'dep-c'), ...depends('optionalDependencies', 'dep-d'),
    }),
    'dep-a/package.json': named('dep-a'),
    'dep-b/package.json': named('dep-b'),
    'dep-c/package.json': named('dep-c'),
    'dep-d/package.json': named('dep-d'),
    'empty-file/package.json': '',
    'byte-order-mark/package.json': String.fromCharCode(0xfeff) + '{"name":"bom"}',
    // A dependency field of another type is skipped. A field that is not one of the four is never read,
    // although it names the local packages above, so a miscount would also add an edge.
    'dependency-types/package.json': named('types', {
      dependencies: 'dep-a', devDependencies: null, peerDependencies: 5, optionalDependencies: true,
    }),
    'dependency-other-fields/package.json': named('others', {
      bundledDependencies: { 'dep-a': '1' }, bundleDependencies: { 'dep-b': '1' },
      peerDependenciesMeta: { 'dep-c': { optional: true } }, dependenciesMeta: { 'dep-b': {} },
      overrides: { 'dep-d': '1' }, resolutions: { 'dep-a': '1' },
    }),
    // A name counts whatever its value is, an empty name included. The names sort by code unit and a
    // name that two fields share is kept once.
    'dependency-values/package.json': named('values', {
      dependencies: { 'val-null': null, 'val-number': 1, 'val-object': { nested: 'x' }, 'val-array': [], '': '1', Zed: '1', 'a-lower': '1', 10: '1', 9: '1' },
      devDependencies: { Zed: '2' },
    }),
    // Workspace patterns are not de-duplicated. Only strings are kept, and `packages` of an object is
    // read only when it is an array.
    'workspaces-array/package.json': named('wsa', { workspaces: ['pkg/b', 'pkg/a', 'pkg/a', 7, null, { x: 1 }, ['y']] }),
    'workspaces-packages-text/package.json': named('wsp', { workspaces: { packages: 'apps/*' } }),
    'workspaces-nohoist/package.json': named('wsn', { workspaces: { nohoist: ['z'], packages: ['q'] } }),
    'rewritten-package/package.json': named('before'),
    'vanished-package/package.json': named('vanished'),
  };
  // An adapter whose `detect` changes package.json files while the build runs. The package facts are
  // read after every adapter has run: a removed file is a `package-metadata-read` entry with a portable
  // message, and a rewritten one gives the new content under the digest taken at discovery.
  const editor = bare('editor-http', {
    specificity: 50,
    detect(dir) {
      const file = path.join(dir, 'package.json');
      if (path.basename(dir) === 'vanished-package') fs.rmSync(file);
      if (path.basename(dir) === 'rewritten-package') fs.writeFileSync(file, named('after'));
      return null;
    },
  });
  const built = build(files, { adapters: [fallback, editor] });
  const digestOf = (text) => 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
  const rewritten = built.graph.projects.find((p) => p.root === 'rewritten-package');
  const evidence = rewritten.local_package.evidence.digest;
  return {
    ...built,
    extra: {
      rewritten_digest: {
        of_the_first_content: evidence === digestOf(named('before')),
        of_the_new_content: evidence === digestOf(named('after')),
        same_as_the_marker: evidence === rewritten.markers[0].digest,
      },
    },
  };
}

// Directory names that are legal on POSIX and that the builder emits as found: a space, a drive-like
// first segment, a backslash, a newline, a quote, a tab, non-ASCII text, a leading dash or dot, a
// trailing `..`. The fixture needs a POSIX file system (RFC section 8, limit 13).
function oddNames() {
  const files = {
    'with space/package.json': named('@odd/space'),
    'c:/package.json': named('@odd/drive', { dependencies: { express: '^5.0.0', '@odd/colon': '1' } }),
    'c:/src/server.js': 'app.get("/c", () => {});\n',
    'a:b/package.json': named('@odd/colon'),
    'back\\slash/package.json': named('@odd/backslash', { dependencies: { express: '^5.0.0' } }),
    'back\\slash/index.js': 'app.get("/b", () => {});\n',
    'new\nline/package.json': named('@odd/newline', { dependencies: { '@odd/backslash': '1' } }),
    '日本/package.json': named('@odd/japan'),
    '%20/package.json': named('@odd/percent'),
    '-dash/package.json': named('@odd/dash'),
    'x../package.json': named('@odd/trailing-dots'),
    '.hidden/package.json': named('@odd/hidden'),
    'quote"s/package.json': named('@odd/quote'),
    'tab\tname/package.json': named('@odd/tab'),
  };
  return build(files, { adapters: [fallback, express(withReadSet)] });
}

// Names that start with two dots are legal, but five checks in the builder read them as an escape
// (RFC section 8, limit 16). The graph lists the projects; detection, read sets and shadow mode misjudge them.
function dotDotNames() {
  const files = {
    '..dots/package.json': named('dotdot', { dependencies: { express: '^5.0.0' } }),
    '..dots/src/a.js': 'app.get("/a", () => {});\n',
    'svc/package.json': named('svc', { dependencies: { express: '^5.0.0' } }),
    'svc/..lib/b.js': 'app.get("/b", () => {});\n',
    'svc/src/c.js': 'app.get("/c", () => {});\n',
  };
  const adapters = [fallback, express(withReadSet)];
  const { root, graph } = build(files, { adapters });
  let shadowCode = null;
  try {
    executeProjectScanPlan({ repoRoot: root, graph, adapters });
  } catch (err) {
    shadowCode = err.code ?? null;
  }
  return { root, graph, extra: { shadow_error_code: shadowCode } };
}

// The same repository named four ways: the absolute path (the reference), relative to the working
// directory, with a trailing separator, and through a symbolic link that lives in another directory.
function repoRootForms() {
  const root = fixture({ 'package.json': named('top'), 'svc/package.json': named('svc') });
  const holder = fixture({});
  const link = path.join(holder, 'link');
  fs.symlinkSync(root, link);
  const graphOf = (repoRoot) => buildProjectGraph({ repoRoot, adapters: [fallback] });
  const graph = graphOf(root);
  const same = (repoRoot) => JSON.stringify(canon(graphOf(repoRoot))) === JSON.stringify(canon(graph));
  return {
    root,
    graph,
    extra: {
      same_as_absolute: {
        relative: same(path.relative(process.cwd(), root)),
        trailing_separator: same(root + path.sep),
        symbolic_link: same(link),
      },
    },
  };
}

// Neither a missing path nor a file is rejected; the builder records the failed read and goes on.
function missingRepoRoot() {
  const root = path.join(fixture({}), 'does-not-exist');
  return { root, graph: buildProjectGraph({ repoRoot: root, adapters: [fallback] }) };
}

function fileAsRepoRoot() {
  const root = path.join(fixture({ 'plain.txt': 'not a directory\n' }), 'plain.txt');
  return { root, graph: buildProjectGraph({ repoRoot: root, adapters: [fallback] }) };
}

// The marker rule deletes the file it matches, so the digest read that follows fails. `walk_order` pins
// the order of several such entries.
function vanishedMarker() {
  const root = fixture({ 'a/package.json': named('a') });
  const victim = path.join(root, 'a', 'package.json');
  const markerRules = [{
    kind: 'node-package',
    test: (name) => {
      if (name === 'package.json') fs.rmSync(victim, { force: true });
      return name === 'package.json';
    },
  }];
  return { root, graph: buildProjectGraph({ repoRoot: root, adapters: [fallback], markerRules }) };
}

// The two plan options are plain truthiness tests and combine (RFC section 2.3). An adapter recognizes
// one active and one reference project; only the fallback recognizes the other two. The registered
// variant takes `includeFallback` but not `includeNonActive`, and returns the graph beside the plan.
function planOptions() {
  const files = Object.fromEntries(['app', 'examples/demo', 'lib', 'examples/lib'].map((dir) => [`${dir}/package.json`, '{}']));
  const adapters = [adapter('plan-http', 50, inDirs('app', 'demo')), fallback];
  const { root, graph } = build(files, { adapters });
  const items = (plan) => plan.map((i) => `${i.project_root}:${i.adapter_id}:${i.mode}`);
  const plan = (options) => items(buildProjectScanPlan(graph, options));
  const registered = (options) => buildRegisteredProjectScanPlan(root, { adapters, ...options });
  return {
    root,
    graph,
    extra: {
      plans: {
        default: plan(),
        include_fallback: plan({ includeFallback: true }),
        include_non_active: plan({ includeNonActive: true }),
        both: plan({ includeFallback: true, includeNonActive: true }),
        truthy_values: plan({ includeFallback: 'yes', includeNonActive: 1 }),
        falsy_values: plan({ includeFallback: 0, includeNonActive: '' }),
      },
      registered_plans: {
        default: items(registered().plan),
        include_fallback: items(registered({ includeFallback: true }).plan),
        include_non_active: items(registered({ includeNonActive: true }).plan),
        both: items(registered({ includeFallback: true, includeNonActive: true }).plan),
      },
      registered_result_keys: Object.keys(registered()).sort(),
    },
  };
}

// `discoverProjectRoots` is the walk the builder starts with. It reads `markerRules` the same way, but it
// checks no `repoRoot`: an empty string is the process working directory and a non-string is a Node
// TypeError (RFC section 2.5). The working directory is switched to the fixture and put back.
function discoverRoots() {
  const { root, graph } = build({ 'package.json': named('top'), 'a/package.json': named('a') }, { adapters: [fallback] });
  const rootsOf = (...args) => discoverProjectRoots(...args).roots.map((r) => r.root);
  const failure = (fn) => {
    try {
      fn();
      return null;
    } catch (err) {
      return err?.constructor?.name ?? typeof err;
    }
  };
  const before = process.cwd();
  let fromWorkingDirectory;
  try {
    process.chdir(root);
    fromWorkingDirectory = rootsOf('');
  } finally {
    process.chdir(before);
  }
  const found = discoverProjectRoots(root);
  return {
    root,
    graph,
    extra: {
      roots: rootsOf(root),
      roots_of_empty_string: fromWorkingDirectory,
      roots_without_marker_rules: rootsOf(root, { markerRules: [] }),
      paths_are_absolute: path.isAbsolute(found.repo_root) && found.roots.every((r) => path.isAbsolute(r.absolute_root)),
      result_keys: Object.keys(found).sort(),
      failures: {
        no_argument: failure(() => discoverProjectRoots()),
        null_path: failure(() => discoverProjectRoots(null)),
        number_path: failure(() => discoverProjectRoots(5)),
        null_options: failure(() => discoverProjectRoots(root, null)),
      },
    },
  };
}

// The options of `executeProjectScanPlan` (RFC section 2.4). Only structure is kept: which projects were
// scanned and how, what the wrapper handed on to the legacy scan, and what the nested scans asked of the
// adapters. Two applications (one two directories down), one project that only the fallback recognizes,
// and one reference-role application that is never scanned.
function shadowOptions() {
  const files = {
    'app/package.json': named('app', { dependencies: { express: '^5.0.0' } }),
    'app/src/a.js': 'app.get("/a", () => {});\n',
    'lib/package.json': named('lib'),
    'examples/demo/package.json': named('demo', { dependencies: { express: '^5.0.0' } }),
    'examples/demo/b.js': 'app.get("/b", () => {});\n',
    'services/api/package.json': named('api', { dependencies: { express: '^5.0.0' } }),
    'services/api/c.js': 'app.get("/c", () => {});\n',
  };
  const adapters = [{ ...fallback, scan: scanStub }, express(withReadSet)];
  const { root, graph } = build(files, { adapters });
  const calls = [];
  // The same adapters, logging every call the nested scan makes (the builds used the plain ones). Directories are
  // logged relative to the repository they belong to.
  const spyOn = (base) => adapters.map((a) => ({
    ...a,
    detect: (dir) => { calls.push(`detect ${a.id} ${path.relative(base, dir) || '.'}`); return a.detect(dir); },
    scan: (dir, ...rest) => { calls.push(`scan ${a.id} ${path.relative(base, dir) || '.'}`); return a.scan(dir, ...rest); },
    introspectRoutes: () => { calls.push(`routes ${a.id}`); return null; },
  }));
  const run = (options = {}) => executeProjectScanPlan({ repoRoot: root, graph, adapters, ...options });
  const observe = (options = {}) => {
    calls.length = 0;
    const out = run({ adapters: spyOn(root), ...options });
    return { out, calls: [...calls] };
  };
  const scanned = (out) => out.scans.map((s) => `${s.project_root}:${s.adapter_id}:${s.mode}`);
  const reports = (out) => out.scans.map((s) => ({
    project_root: s.project_root,
    modules: s.report.related_modules.map((m) => m.module),
    db_not_scanned: s.report.unknowns.some((u) => u.startsWith('DB not scanned')),
    has_db_schema: 'db_schema' in s.report,
    has_runtime_introspection: 'runtime_introspection' in s.report,
  }));
  // The text before the first `: ` is the fixed part of the builder's own messages; Node's own text is not stable.
  const STABLE = new Set(['duplicate adapter id', 'repoRoot is required', 'expected sbf.project-graph/draft-1']);
  const failure = (fn) => {
    try {
      fn();
      return null;
    } catch (err) {
      const head = err.message.split(': ')[0];
      // Node's own error codes (`ERR_INVALID_ARG_TYPE`) belong to Node, not to the builder, and are not recorded.
      return {
        error: err.constructor.name, code: /^PROJECT_/.test(err.code ?? '') ? err.code : null, message: STABLE.has(head) ? head : null,
        ...(err.project_id ? { project_id: err.project_id } : {}),
        ...(err.cause ? { cause: err.cause.constructor.name } : {}),
      };
    }
  };
  const terms = ['alpha', 'beta'];
  const withTerms = run({ terms });
  const ripgrepEntry = (value) => run({ rgAvailable: value }).scans[0].report.unknowns.some((u) => u.startsWith('ripgrep'));
  // A project that is stale only after an earlier one has been scanned.
  const later = build(files, { adapters });
  fs.appendFileSync(path.join(later.root, 'services/api/package.json'), '\n');
  calls.length = 0;
  const laterFailure = failure(() => executeProjectScanPlan({ repoRoot: later.root, graph: later.graph, adapters: spyOn(later.root) }));
  const laterCalls = [...calls];
  // A symbolic link to the repository is another path for the same directory.
  const holder = fixture({ keep: '' });
  fs.symlinkSync(root, path.join(holder, 'alias'));
  const draft = graph.schema;
  // With no planned project there is no nested scan, and `terms` is only spread into the returned list.
  const nothing = { schema: draft, projects: [] };
  const observed = observe();
  return {
    root,
    graph,
    extra: {
      scanned: {
        default: scanned(run()),
        include_fallback: scanned(run({ includeFallback: true })),
        include_non_active: scanned(run({ includeNonActive: true })),
      },
      nested_scan: {
        calls: observed.calls,
        calls_with_fallback: observe({ includeFallback: true }).calls,
        reports: reports(observed.out),
      },
      terms: {
        default: run().terms,
        echoed: withTerms.terms,
        copied: withTerms.terms !== terms,
        in_nested_reports: withTerms.scans.map((s) => s.report.terms),
        not_an_array: {
          null: failure(() => run({ terms: null })),
          string: failure(() => run({ terms: 'alpha' })),
          set: failure(() => run({ terms: new Set(terms) })),
        },
        empty_plan: {
          string: run({ graph: nothing, terms: 'ab' }).terms,
          set: run({ graph: nothing, terms: new Set(['x', 'y']) }).terms,
          null: failure(() => run({ graph: nothing, terms: null })),
          number: failure(() => run({ graph: nothing, terms: 5 })),
        },
      },
      rg_available: {
        default: run().scans[0].report.rg_available,
        false: run({ rgAvailable: false }).scans[0].report.rg_available,
        zero: run({ rgAvailable: 0 }).scans[0].report.rg_available,
        text: run({ rgAvailable: 'no' }).scans[0].report.rg_available,
        ripgrep_entry: { default: ripgrepEntry(undefined), false: ripgrepEntry(false), zero: ripgrepEntry(0), null: ripgrepEntry(null), text: ripgrepEntry('no') },
      },
      adapters_iterable: scanned(run({ adapters: new Set(adapters) })),
      repo_root_forms: {
        trailing_separator: scanned(run({ repoRoot: root + path.sep })),
        relative: scanned(run({ repoRoot: path.relative(process.cwd(), root) })),
        dot_segments: scanned(run({ repoRoot: path.join(root, 'app', '..') })),
        symbolic_link: failure(() => run({ repoRoot: path.join(holder, 'alias') })),
      },
      graph_shapes: {
        empty_projects: run({ graph: nothing }).scans,
        no_projects: failure(() => run({ graph: { schema: draft } })),
        projects_not_an_array: failure(() => run({ graph: { schema: draft, projects: {} } })),
        duplicate_ids_first: failure(() => run({ graph: { schema: draft }, adapters: [...adapters, ...adapters] })),
      },
      later_project_stale: { ...laterFailure, calls: laterCalls },
      failures: {
        duplicate_adapter_ids: failure(() => run({ adapters: [...adapters, ...adapters] })),
        no_repo_root: failure(() => run({ repoRoot: '' })),
        repo_root_number: failure(() => run({ repoRoot: 5 })),
        not_a_graph: failure(() => run({ graph: { projects: [] } })),
        graph_missing: failure(() => run({ graph: undefined })),
        graph_null: failure(() => run({ graph: null })),
        other_schema: failure(() => run({ graph: { schema: 'sbf.project-graph/draft-0' } })),
        no_arguments: failure(() => executeProjectScanPlan()),
        null_options: failure(() => executeProjectScanPlan(null)),
        null_adapters: failure(() => run({ adapters: null })),
      },
    },
  };
}

const noAdapters = () => build({ 'package.json': named('top'), 'svc/package.json': named('svc') }, { adapters: [] });
const emptyRepository = () => build({}, { adapters: [] });

// The builder reads three keys of its options object. Plan and shadow options, and keys nobody defined,
// change nothing.
function unknownOptions() {
  const root = fixture({ 'package.json': named('top'), 'svc/package.json': named('svc') });
  const plain = buildProjectGraph({ repoRoot: root, adapters: [fallback] });
  const graph = buildProjectGraph({
    repoRoot: root, adapters: [fallback], includeFallback: true, includeNonActive: true, terms: ['x'], rgAvailable: false, other: { nested: 1 },
  });
  return { root, graph, extra: { same_as_without_them: JSON.stringify(canon(graph)) === JSON.stringify(canon(plain)) } };
}

// The default rules, one numbered directory per file name (names that differ only in letter case must not
// share a directory on a case-insensitive file system). `marker_kind_by_file_name` is the kind of the marker
// that the name made, or null when the name made none.
function defaultMarkers() {
  const names = [
    'package.json', 'pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'requirements.dev.txt',
    'REQUIREMENTS.TXT', 'requirements_dev.txt', 'requirements.txt.bak', 'prerequirements.txt',
    'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
    'Gemfile', 'gemfile', 'go.mod', 'Cargo.toml', 'cargo.toml', 'composer.json',
    'App.csproj', 'app.fsproj', 'APP.VBPROJ', '.csproj', 'App.csproj.user', 'Appcsproj', 'app.sln', 'Package.json', 'POM.XML', 'Pyproject.toml', 'README.md',
  ];
  const dir = (name) => `name-${String(names.indexOf(name)).padStart(2, '0')}`;
  const { root, graph } = build(Object.fromEntries(names.map((name) => [`${dir(name)}/${name}`, '{}'])), { adapters: [fallback] });
  const kinds = graph.projects.flatMap((p) => p.markers.map((m) => [m.path, m.kind]));
  const marker_kind_by_file_name = Object.fromEntries(names.map((name) => [name, new Map(kinds).get(`${dir(name)}/${name}`) ?? null]));
  return { root, graph, extra: { marker_kind_by_file_name } };
}

// A Promise is truthy, so a rule whose test is async matches every regular file.
const asyncMarkerRule = () => build({ 'a/x.txt': '', 'b/y.md': '', 'z.txt': '' }, {
  adapters: [], markerRules: [{ kind: 'async-kind', test: async () => false }],
});

// The role comes from the names alone: whole path segments, any letter case, a backslash as a separator.
// A project root is judged from its path in the repository, a read-set file from its path in the project.
function roleNames() {
  const roots = ['Vendor/lib', 'my-vendor/lib', 'vendored/lib', 'Vendor/Examples/demo', 'Examples/demo',
    'examples-extra/demo', 'latest/web', 'Dist/web', 'Templates/site', 'docs/Page.TMPL', 'docs/page.tmpl.bak',
    'docs/page.template', 'docs/page.mustache', 'docs/page.HBS', 'docs/other.hbs', 'docs/pagehbs', 'docs/page.hbs.bak',
    'docs.hbs/web', 'x\\vendor/svc'];
  const readSet = ['Vendor/a.js', 'my-vendor/b.js', 'Tests/c.js', 'src/d.js', 'page.TMPL'];
  const files = Object.fromEntries([...roots, 'app'].map((dir) => [`${dir}/package.json`, '{}']));
  for (const rel of readSet) files[`app/${rel}`] = '';
  const { root, graph } = build(files, {
    adapters: [adapter('roles-http', 50, inDirs('app'), { listReadSet: () => readSet, scan: scanStub })],
  });
  const app = graph.projects.find((p) => p.root === 'app');
  return { root, graph, extra: { read_set_roles: Object.fromEntries(app.selected_adapter_read_set.files.map((f) => [f.path, f.role])) } };
}

// ---- The walk and the projects it finds (RFC sections 5.1, 5.2) ---------------------------------------
// The directories the walk never enters, each at the repository root and two levels down, next to names that
// only resemble them. The check is made on the entries below the root, so a root that has such a name is
// walked. No two names in one parent differ only in letter case (case-insensitive file systems).
const HARD_IGNORED = ['.git', '.hg', '.svn', '.bskel', 'node_modules', 'coverage', '.cache', '.turbo', 'dist', 'build',
  'out', '.next', '.svelte-kit', 'vendor', 'third_party', 'third-party'];
const NEAR_MISSES = ['Node_Modules', 'DIST', 'Build', 'Out', '.Git', '.github', 'node_modules2', 'vendors', 'third_party_x',
  'third-party-x', 'outer', 'coverage-report', 'cache', '.cache2', 'dist-x', 'builds', '.nextjs', 'svelte-kit', 'bskel'];

function ignoredDirectories() {
  const files = { 'ignored/package.json': named('ignored'), 'walked/package.json': named('walked') };
  for (const name of HARD_IGNORED) {
    files[`${name}/package.json`] = named(`at-root-${name}`);
    files[`ignored/${name}/package.json`] = named(`below-${name}`);
  }
  for (const name of NEAR_MISSES) files[`walked/${name}/package.json`] = named(`near-${name}`);
  const { root, graph } = build(files, { adapters: [fallback] });
  const rootsWhenNamed = {};
  for (const name of ['dist', 'node_modules']) {
    const holder = fixture({ [`${name}/package.json`]: named('top'), [`${name}/sub/package.json`]: named('sub') });
    rootsWhenNamed[name] = buildProjectGraph({ repoRoot: path.join(holder, name), adapters: [fallback] }).projects.map((p) => p.root);
  }
  return { root, graph, extra: { never_entered: [...HARD_IGNORED].sort(), walked_look_alikes: [...NEAR_MISSES].sort(), roots_when_the_repository_is_named: rootsWhenNamed } };
}

// The order of the walk (RFC section 5.1). `calls` is the order in which the marker rule saw the regular files;
// every file name here is unique, so a name stands for its place. The rule deletes things as the walk goes by:
// at `a/trigger.cfg` the directories `a/b` and `a-x` (both already queued, so their listing fails when they come
// up), and `vanish-top.cfg` and `b/vanish-b.cfg` when it is their turn (the digest read that follows fails).
// `B-upper.cfg` sorts before `a` by code unit; the two last names differ between code-unit, code-point and
// UTF-8 byte order (a surrogate pair against U+FF61).
function walkOrder() {
  const high = String.fromCodePoint(0x1f600);
  const wide = String.fromCharCode(0xff61);
  const files = {
    'top-z.cfg': '', 'top-m.cfg': '', 'top-a.cfg': '', 'top-plain.txt': '', 'B-upper.cfg': '', 'vanish-top.cfg': '',
    [`${wide}-wide.cfg`]: '', [`${high}-astral.cfg`]: '',
    'a/a0.cfg': '', 'a/trigger.cfg': '', 'a/b/never-read.cfg': '', 'a/c/c1.cfg': '',
    'a-x/ax1.cfg': '',
    'b/b2.cfg': '', 'b/vanish-b.cfg': '', 'b/c/c1x.cfg': '', 'b/a/a1.cfg': '',
    'z/z0.cfg': '',
  };
  const root = fixture(files);
  const calls = [];
  const markerRules = [{
    kind: 'walk-order',
    test: (name) => {
      calls.push(name);
      if (name === 'trigger.cfg') {
        fs.rmSync(path.join(root, 'a', 'b'), { recursive: true, force: true });
        fs.rmSync(path.join(root, 'a-x'), { recursive: true, force: true });
      }
      if (name === 'vanish-top.cfg') fs.rmSync(path.join(root, name), { force: true });
      if (name === 'vanish-b.cfg') fs.rmSync(path.join(root, 'b', name), { force: true });
      return name.endsWith('.cfg');
    },
  }];
  const graph = buildProjectGraph({ repoRoot: root, adapters: [fallback], markerRules });
  return { root, graph, extra: { test_calls: calls } };
}

// ---- Projects inside projects (RFC section 2.2) ------------------------------------------------------
// A chain `app` > `app/api` > `app/api/core`, `tools/ci/lint` with no project between it and the repository, and
// `app-extra`, a name that only starts like `app`. The repository root has no marker. The adapters make
// `app/api` an application and `app` an ambiguous project, both with children, so every row of the `kind` rule
// is met.
function nestedProjects() {
  const files = Object.fromEntries(['app', 'app/api', 'app/api/core', 'app-extra', 'tools/ci/lint']
    .map((dir) => [`${dir}/package.json`, named(dir)]));
  const adapters = [
    adapter('api-http', 50, inDirs('api')),
    adapter('twin-one-http', 40, inDirs('app')),
    adapter('twin-two-http', 40, inDirs('app')),
    fallback,
  ];
  return build(files, { adapters });
}

// The builder picks the nearest enclosing project for a `contains` edge as the longest root text, and the
// repository root `.` is one character long: below a top-level project that is also one character long, the tie
// is broken by code-unit order, so `a/b` hangs under `.` and not under `a`, while `-/z` (`-` sorts before `.`)
// and `bb/c` are right (RFC section 8, limit 18). `child_project_roots` is not affected, and neither is `a/b/c`,
// whose nearest enclosing root `a/b` is longer than `.`.
const shortRootNames = () => build(
  Object.fromEntries(['a', 'a/b', 'a/b/c', '-', '-/z', 'bb', 'bb/c'].map((dir) => [`${dir}/package.json`, named(dir)])),
  { adapters: [fallback] },
);

// Local package names and the edges they make (RFC section 2.2). The names that `app` depends on sort in another
// order than the roots that own them, `@dup/z` is declared before `@dup/a` by root order, and `twin/one` lists a
// name that it shares with `twin/two`. The extras are the evidence paths of the dependency edges and whether every
// `contains` edge has an empty evidence list.
function packageOwners() {
  const files = {
    'package.json': named('top-pkg'),
    'app/package.json': named('app', {
      dependencies: { 'a-lib': '1', 'z-lib': '1', 'top-pkg': '1' },
      devDependencies: { 'a-lib': '1', 'not-local': '1' },
    }),
    'packages/z-dir/package.json': named('a-lib'),
    'packages/a-dir/package.json': named('z-lib'),
    'dup/1/package.json': named('@dup/z'),
    'dup/2/package.json': named('@dup/z'),
    'dup/3/package.json': named('@dup/a'),
    'dup/4/package.json': named('@dup/a'),
    'user/package.json': named('user', { dependencies: { '@dup/z': '1', '@dup/a': '1' } }),
    'twin/one/package.json': named('twin', { dependencies: { twin: '1' } }),
    'twin/two/package.json': named('twin'),
  };
  const { root, graph } = build(files, { adapters: [fallback] });
  const edges = (kind) => graph.project_edges.filter((e) => e.kind === kind);
  return {
    root,
    graph,
    extra: {
      dependency_evidence: edges('local-package-dependency').map((e) => [e.from_project_id, e.to_project_id, e.evidence.map((ev) => ev.path)]),
      contains_evidence_is_empty: edges('contains').every((e) => e.evidence.length === 0),
    },
  };
}

// The order in which the builder asks the adapters (RFC sections 4, 5.1), one directory per question. The array
// is in no useful order, and the case records that the builder leaves it as it was. The visiting order uses the
// adapter's own `specificity` (a numeric string counts as its number, `Infinity` is the highest); the candidates
// are sorted again by the specificity they record. `agg` is only recognized by adapters that find a child
// below it, two of which share an id. In `twin` two adapters share an id too: the one that wins is the one
// with the higher specificity, but the read set comes from the first one in the array. In `visit` three
// adapters answer `true`, which names no root, so the `unlocated-detection` entries list the asking order.
function adapterOrder() {
  const dirs = ['rank', 'tie', 'infinite', 'agg', 'twin', 'visit'];
  const files = Object.fromEntries(dirs.map((dir) => [`${dir}/package.json`, '{}']));
  files['twin/b.js'] = 'module.exports = {};\n';
  const at = (dir, id, specificity, extra) => adapter(id, specificity, inDirs(dir), extra);
  const nesting = (id, specificity, child) =>
    adapter(id, specificity, (dir) => (path.basename(dir) === 'agg' ? path.join(dir, child) : null));
  const asking = (id, specificity) => adapter(id, specificity, (dir) => (path.basename(dir) === 'visit' ? true : null));
  const adapters = [
    asking('a-str-ask', '5'), asking('m-seven-ask', 7), asking('b-seven-ask', 7), asking('z-inf-ask', Number.POSITIVE_INFINITY),
    asking('r-negative-ask', -3), asking('q-omitted-ask', undefined),
    at('rank', 'm-http', 50), at('rank', 'z-http', 80), at('rank', 'a-http', 50), at('rank', 'b-http', 20),
    at('tie', 'tie-z-http', 70), at('tie', 'tie-low-http', 10), at('tie', 'tie-a-http', 70),
    at('infinite', 'z-inf-http', Number.POSITIVE_INFINITY), at('infinite', 'five-http', 5), at('infinite', 'a-str-http', '5'),
    nesting('nest-z-http', 90, 'svc1'), nesting('nest-a-http', 40, 'svc2'),
    nesting('nest-twin-http', 30, 'svc2'), nesting('nest-twin-http', 30, 'svc1'),
    at('twin', 'dup-http', 10, { listReadSet: () => ['b.js'] }), at('twin', 'dup-http', 50),
  ];
  const before = [...adapters];
  const { root, graph } = build(files, { adapters });
  return { root, graph, extra: { array_unchanged: adapters.length === before.length && adapters.every((a, i) => a === before[i]) } };
}

// The calls the builder makes on the adapters it is given (RFC section 2.5): which function, with what, and when.
// `repoRoot` is a symbolic link, so the path of each call shows whether the builder resolved it. `high-http` wins in
// the repository root and in `svc`, where `low-http` detects too and must not be asked for a read set; the two
// `tie-` adapters tie in `lib`, where nothing is selected; `generic-grep` is a fallback, has a `listReadSet` of its
// own, and detects every root. The array is in no useful order.
function adapterCalls() {
  const root = fixture({ 'package.json': named('top'), 'lib/package.json': named('lib'), 'svc/package.json': named('svc') });
  const holder = fixture({});
  const link = path.join(holder, 'link');
  fs.symlinkSync(root, link);
  const relative = (abs) => path.relative(link, abs) || '.';
  const events = [];
  const spy = (id, specificity, ...roots) => {
    const self = {
      ...adapter(id, specificity, function detect(...args) {
        events.push({ call: 'detect', id, args, self: this === self });
        return roots.length === 0 || roots.includes(relative(args[0])) ? args[0] : null;
      }),
      listReadSet(...args) {
        events.push({ call: 'listReadSet', id, args, self: this === self });
        return ['package.json'];
      },
    };
    return self;
  };
  const adapters = [
    spy('low-http', 10, '.', 'svc'), spy('tie-b-http', 30, 'lib'), spy('generic-grep', 0), spy('high-http', 50, '.', 'svc'),
    spy('tie-a-http', 30, 'lib'),
  ];
  const graph = buildProjectGraph({ repoRoot: link, adapters });
  return {
    root,
    graph,
    extra: {
      calls: events.map((e) => `${e.call} ${e.id} ${relative(e.args[0])}`),
      one_absolute_argument: events.every((e) => e.args.length === 1 && typeof e.args[0] === 'string' && path.isAbsolute(e.args[0])),
      this_is_the_adapter: events.every((e) => e.self),
    },
  };
}

// Names that every object already has as properties. The builder keeps its tables in `Map` and `Set`, so none of them
// is special as a directory, a package name, a dependency name or an adapter id. The package files are written as
// text: in an object literal, `__proto__` would set the prototype instead of making a key.
function prototypeNames() {
  const files = {
    'package.json': '{"name":"top","dependencies":{"__proto__":"1","constructor":"1","hasOwnProperty":"1","toString":"1"}}',
    '__proto__/package.json': '{"name":"__proto__"}',
    'constructor/package.json': '{"name":"constructor","dependencies":{"__proto__":"1","toString":"1"}}',
    'hasOwnProperty/package.json': '{"name":"hasOwnProperty","workspaces":{"packages":["__proto__"]}}',
    'toString/package.json': '{"name":"toString","dependencies":{"constructor":"1"}}',
  };
  return build(files, { adapters: [adapter('__proto__', 5, (dir) => dir, { listReadSet: () => ['package.json'] })] });
}

// ---- Input the builder takes and the schema rejects ------------------------------------------------
function nonStringMarkerKinds() {
  const files = { 'a/a.k': '', 'b/b.k': '', 'c/c.k': '', 'd/d.k': '' };
  const markerRules = [42, {}, true, ['x']].map((kind, i) => kindRule(kind, `${'abcd'[i]}.k`));
  return build(files, { adapters: [fallback], markerRules });
}

const nonStringAdapterFields = () => build({ 'app/package.json': '{}' }, {
  adapters: [bare('typed-http', { detect: inDirs('app'), title: 5, confidence: 3, verificationBasis: {} })],
});

// The empty id is selected as `''`, which is falsy, so the read set is never captured although `listReadSet` is valid.
const emptyAdapterId = () => build({ 'app/package.json': '{}' }, {
  adapters: [bare('', { detect: inDirs('app'), listReadSet: () => ['package.json'] })],
});
const missingAdapterId = () => build({ 'app/package.json': '{}' }, { adapters: [{ detect: inDirs('app'), specificity: 5 }] });
const numericAdapterId = () => build({ 'app/package.json': '{}' }, { adapters: [bare(7, { detect: inDirs('app') })] });

const duplicateAdapterIds = () => build({ 'app/package.json': '{}' }, {
  adapters: [adapter('twin-http', 50, inDirs('app')), adapter('twin-http', 50, inDirs('app'))],
});

// The same ids on the fallback path. A fallback adapter adds only its id to the graph, as `fallback_adapter` of each
// project it recognizes, and no candidate holds it, so the candidate rules of the schema never see it.
// An empty id is falsy: the plan never gives the project a `fallback` item, although the build reported no problem.
const emptyFallbackAdapterId = () => {
  const built = build({ 'app/package.json': '{}' }, { adapters: [bare('', { detect: inDirs('app'), specificity: 0 })] });
  return { ...built, extra: { fallback_plan: buildProjectScanPlan(built.graph, { includeFallback: true }) } };
};

// `NaN` and `Infinity` are numbers too. JSON writes both as `null`, which is the value of no fallback, so the only
// trace of them is the in-memory graph: `extra` keeps their text because the probe prints JSON.
const numericFallbackAdapterId = () => {
  const built = build({ 'app/package.json': '{}', 'inf/package.json': '{}', 'nan/package.json': '{}' }, {
    adapters: [
      bare(7, { detect: inDirs('app'), specificity: 0 }),
      bare(Infinity, { detect: inDirs('inf'), specificity: 0 }),
      bare(NaN, { detect: inDirs('nan'), specificity: 0 }),
    ],
  });
  const inMemory = Object.fromEntries(built.graph.projects.map((p) => [p.root, String(p.fallback_adapter)]));
  return { ...built, extra: { in_memory_fallback_ids: inMemory } };
};

// No `id` (or a `null` one) on a fallback adapter leaves `null`, which is what no fallback looks like: the graph is valid
// and nothing in it shows the adapter. A first-class adapter with no `id` is the case above that the schema rejects.
const missingFallbackAdapterId = () => build({ 'no-id/package.json': '{}', 'null-id/package.json': '{}' }, {
  adapters: [{ detect: inDirs('no-id'), specificity: 0 }, bare(null, { detect: inDirs('null-id'), specificity: 0 })],
});

export function optionCases() {
  return {
    accepted: {
      custom_marker_kinds: customMarkerKinds(),
      empty_marker_rules: emptyMarkerRules(),
      default_markers: defaultMarkers(),
      async_marker_rule: asyncMarkerRule(),
      role_names: roleNames(),
      ignored_directories: ignoredDirectories(),
      walk_order: walkOrder(),
      adapter_defaults: adapterDefaults(),
      adapter_values: adapterValues(),
      fallback_adapters: fallbackAdapters(),
      detect_failures: detectFailures(),
      detect_values: detectValues(),
      unresolved_order: unresolvedOrder(),
      adapter_removed_during_build: adapterRemovedDuringBuild(),
      adapter_order: adapterOrder(),
      adapter_calls: adapterCalls(),
      missing_fallback_adapter_id: missingFallbackAdapterId(),
      nested_projects: nestedProjects(),
      short_root_names: shortRootNames(),
      package_owners: packageOwners(),
      read_set_shapes: readSetShapes(),
      package_metadata: packageMetadata(),
      odd_names: oddNames(),
      dotdot_names: dotDotNames(),
      prototype_names: prototypeNames(),
      repo_root_forms: repoRootForms(),
      missing_repo_root: missingRepoRoot(),
      file_as_repo_root: fileAsRepoRoot(),
      vanished_marker: vanishedMarker(),
      no_adapters: noAdapters(),
      empty_repository: emptyRepository(),
      unknown_options: unknownOptions(),
      plan_options: planOptions(),
      discover_roots: discoverRoots(),
      shadow_options: shadowOptions(),
    },
    unchecked: {
      non_string_marker_kinds: nonStringMarkerKinds(),
      non_string_adapter_fields: nonStringAdapterFields(),
      empty_adapter_id: emptyAdapterId(),
      numeric_adapter_id: numericAdapterId(),
      missing_adapter_id: missingAdapterId(),
      duplicate_adapter_ids: duplicateAdapterIds(),
      empty_fallback_adapter_id: emptyFallbackAdapterId(),
      numeric_fallback_adapter_id: numericFallbackAdapterId(),
    },
  };
}

// Calls the builder rejects, or fails inside. Each entry is a function; the probe records the class of
// what it throws. The messages come from Node for everything except the first two checks, so they are
// not recorded (RFC section 8).
export function malformedCalls() {
  const repoRoot = fixture({ 'a/package.json': '{}' });
  const call = (options) => () => buildProjectGraph({ repoRoot, adapters: [], ...options });
  const detecting = (detect) => () => buildProjectGraph({ repoRoot, adapters: [{ id: 'x', detect }] });
  return {
    no_arguments: () => buildProjectGraph(),
    options_null: () => buildProjectGraph(null),
    empty_repo_root: call({ repoRoot: '' }),
    repo_root_not_a_string: call({ repoRoot: 5 }),
    adapters_missing: () => buildProjectGraph({ repoRoot }),
    adapters_not_an_array: call({ adapters: 'generic-grep' }),
    adapters_with_null: call({ adapters: [null] }),
    marker_rules_null: call({ markerRules: null }),
    marker_rules_not_an_array: call({ markerRules: {} }),
    marker_rule_null: call({ markerRules: [null] }),
    marker_rule_without_test: call({ markerRules: [{ kind: 'x' }] }),
    marker_rule_throws: call({ markerRules: [{ kind: 'x', test: () => { throw new RangeError('rule failed'); } }] }),
    detect_throws_null: detecting(() => { throw null; }),
    detect_throws_undefined: detecting(() => { throw undefined; }),
    plan_options_null: () => buildProjectScanPlan(buildProjectGraph({ repoRoot, adapters: [] }), null),
    plan_not_a_graph: () => buildProjectScanPlan({ projects: [] }),
    registered_adapters_false: () => buildRegisteredProjectGraph(repoRoot, { adapters: false }),
    registered_options_null: () => buildRegisteredProjectGraph(repoRoot, null),
    registered_plan_options_null: () => buildRegisteredProjectScanPlan(repoRoot, null),
  };
}
