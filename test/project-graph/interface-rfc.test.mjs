// T02-02: the interface RFC, the draft graph schema and the recorded evidence must agree with the T02
// code (RFC section 7.4). Synthetic repositories come from interface-rfc.cases.mjs; the commands the
// RFC quotes are re-run here as child processes and compared with interface-rfc.record.json.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import * as indexModule from '../../scanners/project-graph/index.mjs';
import * as registeredModule from '../../scanners/project-graph/registered.mjs';
import * as shadowModule from '../../scanners/project-graph/shadow.mjs';
import * as sourceRoleModule from '../../scanners/project-graph/source-role.mjs';
import { ADAPTERS, LOAD_ERRORS } from '../../scanners/registry.mjs';
import { malformedCalls, negativeCases, normalCase, optionCases, registeredCase } from './interface-rfc.cases.mjs';
import {
  acceptanceProblems, checkLiterals, defaultMarkerProblems, extractSourceLiterals, kindTagProblems,
  markerArgumentProblems, missingFragments, missingFromText, optionCaseListProblems, optionTagProblems,
  rejectionProblems, schemaLiteralHits, schemaUnresolvedFields, schemaVocabulary, sectionLines,
  sectionProblems, tableRows,
} from './interface-rfc.check.mjs';
import { canon, cleanup, fixture } from './interface-rfc.fixtures.mjs';
import { REJECTED_MUTATIONS } from './interface-rfc.mutations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sorted = (list) => [...list].sort();
const clone = (value) => JSON.parse(JSON.stringify(value));
const ticks = (cell) => cell.replace(/`/g, '');

const record = JSON.parse(read('test/project-graph/interface-rfc.record.json'));
const rfc = read(record.rfc);
const readme = read(record.readme);
const schema = JSON.parse(read(record.schema_file));
const MODULES = {
  'index.mjs': indexModule,
  'source-role.mjs': sourceRoleModule,
  'registered.mjs': registeredModule,
  'shadow.mjs': shadowModule,
};
const PROBE_COMMANDS = record.commands.filter((c) => c.id.startsWith('probe-'));
const probeName = (c) => c.command.split(' ').pop();

const probeRuns = new Map();
function probe(name) {
  if (!probeRuns.has(name)) {
    const run = spawnSync(process.execPath, [path.join(ROOT, 'test/project-graph/interface-rfc.probe.mjs'), name], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26,
    });
    probeRuns.set(name, { status: run.status, stdout: run.stdout, stderr: run.stderr, hash: sha256(run.stdout) });
  }
  return probeRuns.get(name);
}
const probeJson = (name) => JSON.parse(probe(name).stdout);

let realGraphs = null;
function graphs() {
  realGraphs ??= { normal: normalCase().graph, ...negativeCases(), registered: registeredCase().graph };
  return realGraphs;
}
// The option cases (RFC section 2.5) built live in this process: full graphs, messages included, for the
// schema checks and for the marker-rule arguments. The probe prints their structure for the other checks.
let realOptions = null;
const options = () => (realOptions ??= optionCases());
after(() => cleanup());

describe('recorded evidence', () => {
  it('names this task and only files that exist', () => {
    assert.equal(record.record, 'sbf.project-graph.interface-rfc-record/1');
    assert.equal(record.task, 'T02-02');
    for (const rel of [record.rfc, record.readme, record.schema_file, ...record.owned_files]) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} does not exist`);
    }
  });

  it('records each command with exit 0, and a hash only where the command can be re-run here', () => {
    assert.deepEqual(record.commands.map((c) => c.id),
      ['probe-normal', 'probe-negative', 'probe-shadow', 'probe-options', 'probe-registered', 'node-test', 'nested-t02']);
    for (const c of record.commands) {
      assert.equal(c.exit, 0, `${c.id} exit code`);
      if (c.id.startsWith('probe-')) {
        assert.match(c.stdout_sha256, /^[a-f0-9]{64}$/, c.id);
        if (!c.pinned) assert.ok(c.unpinned_reason, `${c.id} is unpinned without a reason`);
      } else {
        assert.equal(c.rechecked_by_test, false, c.id);
        assert.equal(c.stdout_sha256, undefined, c.id);
      }
    }
    assert.deepEqual(PROBE_COMMANDS.filter((c) => !c.pinned).map((c) => c.id), ['probe-registered']);
  });
});

describe('vocabulary against the code', () => {
  it('exports exactly the recorded names', () => {
    assert.deepEqual(Object.keys(record.exports), Object.keys(MODULES));
    for (const [file, mod] of Object.entries(MODULES)) {
      assert.deepEqual(sorted(Object.keys(mod)), sorted(record.exports[file]), file);
    }
  });

  it('literals in the T02 source match the record', () => {
    const found = extractSourceLiterals(ROOT);
    for (const [key, value] of Object.entries(found)) {
      assert.ok(Array.isArray(value) ? value.length > 0 : value, `nothing was extracted for ${key}`);
    }
    assert.deepEqual(checkLiterals(found, record.literals), []);
  });

  it('runtime constants match the record', () => {
    assert.equal(indexModule.PROJECT_GRAPH_DRAFT, record.literals.graph_schema);
    assert.deepEqual(sorted(sourceRoleModule.PROJECT_SOURCE_ROLES), record.literals.source_roles);
  });

  it('the draft schema spells the same vocabulary', () => {
    assert.deepEqual(checkLiterals(schemaVocabulary(schema), record.literals, 'schema'), []);
  });
});

describe('RFC text', () => {
  it('has every required section, in order', () => {
    assert.deepEqual(sectionProblems(rfc, record.required_sections), []);
  });

  it('says it is a draft, and so does the schema', () => {
    assert.ok(rfc.split('\n').slice(0, 6).includes('Status: draft / provisional, not a stable SBF contract'));
    assert.match(schema.$id, /^urn:sbf:project-graph:draft-\d+$/);
    assert.match(schema.title, /\/draft-\d+$/);
    assert.match(schema.description, /Not a stable SBF contract/);
  });

  it('names every export', () => {
    assert.deepEqual(missingFromText(rfc, Object.values(record.exports).flat()), []);
  });

  it('quotes every recorded vocabulary item', () => {
    const { graph_schema: graph, shadow_schema: shadow, ...lists } = record.literals;
    assert.deepEqual(missingFromText(rfc, [graph, shadow, ...Object.values(lists).flat()], { quoted: true }), []);
  });

  it('contains every recorded command and hash', () => {
    for (const c of record.commands) {
      assert.ok(rfc.includes('`' + c.command + '`'), `${c.id}: command is not in the RFC`);
      if (c.stdout_sha256) assert.ok(rfc.includes(c.stdout_sha256), `${c.id}: hash is not in the RFC`);
    }
    assert.ok(rfc.includes(record.schema_canonical_sha256), 'schema hash is not in the RFC');
  });

  it('repeats the record in its section 7.1 table', () => {
    const rows = tableRows(sectionLines(rfc, '### 7.1'));
    assert.equal(rows.length, record.commands.length);
    rows.forEach((row, i) => {
      const c = record.commands[i];
      assert.deepEqual([ticks(row[0]), row[1], ticks(row[2])], [c.command, String(c.exit), c.stdout_sha256 ?? 'not hashed']);
    });
  });

  it('keeps a list of remaining limits', () => {
    assert.ok(sectionLines(rfc, '## 8.').filter((line) => /^\d+\. /.test(line)).length >= 10);
  });
});

describe('reproducible commands', () => {
  for (const c of PROBE_COMMANDS) {
    it(`${c.id}: exit ${c.exit}, empty stderr, canonical JSON`, () => {
      const run = probe(probeName(c));
      assert.equal(run.status, c.exit, run.stderr);
      assert.equal(run.stderr, '');
      assert.equal(run.stdout, JSON.stringify(canon(JSON.parse(run.stdout)), null, 2) + '\n');
    });
    if (c.pinned) {
      it(`${c.id}: stdout hash is the recorded one`, () => {
        assert.equal(probe(probeName(c)).hash, c.stdout_sha256);
      });
    }
  }
});

describe('RFC claims against the probes', () => {
  const items = (plan) => plan.map((i) => `${i.project_id}:${i.adapter_id}:${i.mode}`);
  const one = (graph, id) => graph.projects.find((p) => p.project_id === id);

  it('normal: kinds, selection, children, read sets and edges', () => {
    const { graph } = probeJson('normal');
    assert.equal(graph.schema, record.literals.graph_schema);
    assert.equal(graph.repo_root, '.');
    assert.deepEqual(missingFragments(rfc, ['| `notes` | five fixed prose strings. Not machine-stable; do not parse |']), []);
    assert.equal(graph.notes_count, 5);
    const by = Object.fromEntries(graph.projects.map((p) => [p.root, p]));
    assert.deepEqual(Object.keys(by), ['.', 'backend-java', 'examples/demo', 'packages/shared', 'services/api']);
    const summary = (p) => [p.kind, p.project_role, p.facets.http.selected_adapter, p.facets.http.selection_reason, p.fallback_adapter];
    assert.deepEqual(summary(by['.']), ['aggregate', 'active', null, 'no-first-class-adapter', 'generic-grep']);
    assert.deepEqual(summary(by['backend-java']), ['application', 'active', 'java-spring', 'unique-highest-specificity', null]);
    assert.deepEqual(summary(by['examples/demo']), ['application', 'reference', 'javascript-express', 'unique-highest-specificity', null]);
    assert.deepEqual(summary(by['packages/shared']), ['unrecognized', 'active', null, 'no-first-class-adapter', 'generic-grep']);
    assert.deepEqual(summary(by['services/api']), ['application', 'active', 'javascript-express', 'unique-highest-specificity', null]);
    assert.deepEqual(by['.'].child_project_roots, ['backend-java', 'examples/demo', 'packages/shared', 'services/api']);
    assert.deepEqual(by['.'].nested_detections, [
      { adapter_id: 'java-spring', detected_root: 'backend-java' },
      { adapter_id: 'javascript-express', detected_root: 'examples/demo' },
    ]);
    assert.equal(by['backend-java'].selected_adapter_read_set, null);
    assert.deepEqual(by['services/api'].selected_adapter_read_set.files.map((f) => [f.path, f.role]),
      [['services/api/src/server.js', 'active'], ['services/api/tests/helper.js', 'reference']]);
    const demo = by['examples/demo'];
    assert.deepEqual([demo.project_role, demo.selected_adapter_read_set.files[0].role], ['reference', 'active']);
    assert.deepEqual(graph.files_read, sorted([...new Set(graph.files_read)]));
    assert.deepEqual(graph.project_edges.filter((e) => e.kind === 'contains').map((e) => [e.from_project_id, e.to_project_id]),
      ['backend-java', 'examples/demo', 'packages/shared', 'services/api'].map((r) => ['project:.', `project:${r}`]));
    assert.deepEqual(graph.project_edges.filter((e) => e.kind === 'local-package-dependency')
      .map((e) => [e.from_project_id, e.to_project_id, e.dependency_name, e.evidence.length]),
    [['project:services/api', 'project:packages/shared', '@demo/shared', 1]]);
  });

  it('normal: plans follow section 2.3 and roles follow section 4', () => {
    const n = probeJson('normal');
    assert.deepEqual(items(n.plan_default), ['project:backend-java:java-spring:first-class', 'project:services/api:javascript-express:first-class']);
    assert.deepEqual(items(n.plan_with_fallback), [
      'project:backend-java:java-spring:first-class',
      'project:packages/shared:generic-grep:fallback',
      'project:services/api:javascript-express:first-class',
    ]);
    assert.deepEqual(items(n.plan_with_non_active), [
      'project:backend-java:java-spring:first-class',
      'project:examples/demo:javascript-express:first-class',
      'project:services/api:javascript-express:first-class',
    ]);
    assert.deepEqual(sorted(n.source_roles.vocabulary), record.literals.source_roles);
    const { samples } = n.source_roles;
    assert.deepEqual([samples['vendor/examples/x.js'], samples['generated/tests/x.js'], samples['dist/bundle.js'], samples['src/app.js']],
      ['vendor', 'reference', 'generated', 'active']);
  });

  it('negative: every recorded case is present and keeps the meaning section 5 gives it', () => {
    const x = probeJson('negative');
    assert.deepEqual(sorted(Object.keys(x).filter((k) => k !== 'case')), record.negative_cases);

    const [tied] = x.specificity_tie.graph.projects;
    assert.deepEqual([tied.kind, tied.selected, tied.reason, tied.ambiguous, tied.fallback],
      ['ambiguous', null, 'specificity-tie', ['a-http', 'b-http'], null]);
    assert.deepEqual([x.specificity_tie.plan, x.specificity_tie.plan_with_fallback], [[], []]);

    const dup = x.duplicate_local_package;
    assert.deepEqual(sorted(dup.graph.unresolved.map((u) => u.kind)), ['ambiguous-local-package-dependency', 'ambiguous-local-package-name']);
    assert.deepEqual(dup.graph.edges.filter((e) => e[0] !== 'contains'), []);
    assert.deepEqual(dup.plan, []);
    assert.deepEqual(dup.plan_with_fallback.map((i) => i.project_id), ['project:consumer', 'project:shared-a', 'project:shared-b']);

    for (const [name, id] of [['unlocated_detection', 'project:.'], ['out_of_scope_detection', 'project:service']]) {
      assert.equal(one(x[name].graph, id).kind, 'unrecognized', name);
      assert.deepEqual(x[name].plan, [], name);
      assert.deepEqual(x[name].plan_with_fallback.map((i) => i.mode), ['fallback'], name);
    }

    const service = one(x.detect_error.graph, 'project:service');
    assert.deepEqual([service.kind, service.selected, service.reason], ['application', 'javascript-express', 'unique-highest-specificity']);
    assert.deepEqual(x.detect_error.graph.unresolved.filter((u) => u.project_root === 'service').map((u) => [u.kind, u.adapter_id]),
      [['adapter-detect-error', 'broken-http']]);
    assert.deepEqual(one(x.detect_error.graph, 'project:.').nested, [{ adapter_id: 'javascript-express', detected_root: 'service' }]);

    const meta = x.malformed_metadata.graph;
    assert.deepEqual(meta.unresolved.map((u) => [u.kind, u.path]), [['package-metadata-read', 'broken/package.json']]);
    assert.deepEqual([one(meta, 'project:broken').local_package, one(meta, 'project:good').local_package], [null, '@demo/good']);

    const escaped = x.read_set_escape;
    const app = one(escaped.graph, 'project:app');
    assert.deepEqual([app.kind, app.selected, app.read_set_files], ['application', 'escaping-http', null]);
    assert.deepEqual(escaped.graph.unresolved.map((u) => [u.kind, u.project_root, u.adapter_id]), [['adapter-read-set-error', 'app', 'escaping-http']]);
    assert.deepEqual(escaped.plan.map((i) => i.mode), ['first-class']);
  });

  it('shadow: success, then fail-closed with the recorded code for each failure', () => {
    const s = probeJson('shadow');
    assert.equal(s.ok.schema, record.literals.shadow_schema);
    assert.equal(s.ok.graph_schema, record.literals.graph_schema);
    assert.deepEqual(missingFragments(rfc, ['`notes` holds three fixed prose strings.']), []);
    assert.equal(s.ok.notes, 3);
    assert.deepEqual(s.ok.scans.map((x) => [x.project_id, x.adapter_id, x.mode, x.report.schema, x.report.verdict]),
      [['project:api', 'javascript-express', 'first-class', 'sbf.scan-report/2', 'inventory']]);
    assert.equal(s.serialized_graph_ok.same_as_ok, true);
    assert.equal(s.graph_without_markers_ok.same_as_ok, true);
    assert.deepEqual(sorted(Object.keys(s.failures)), sorted(Object.keys(record.shadow_failures)));
    for (const [key, code] of Object.entries(record.shadow_failures)) {
      assert.equal(s.failures[key].ok, false, key);
      assert.equal(s.failures[key].code, code, key);
      assert.ok(record.literals.error_codes.includes(code), `${code} is not a recorded error code`);
    }
  });

  // RFC section 5.3, column "Extra fields": each failure holds exactly the fields the table names and nothing else.
  it('shadow: each failure carries the fields section 5.3 lists, and no other', () => {
    const { failures: f, unattested_graph: unattested } = probeJson('shadow');
    const error = (code, fields = {}) => ({
      ok: false, code, stale_kind: null, project_id: null, marker_path: null, adapter_id: null, cause: null,
      digest_changed: null, fingerprint_changed: null, actual_fingerprint_null: null, files: null, ...fields,
    });
    const stale = (fields) => error('PROJECT_GRAPH_STALE', { project_id: 'project:api', ...fields });
    const readSet = (fields) => stale({ stale_kind: 'adapter-read-set', adapter_id: 'javascript-express', ...fields });
    const same = { added: [], removed: [] };
    assert.deepEqual(f.root_mismatch, error('PROJECT_GRAPH_ROOT_MISMATCH'));
    assert.deepEqual(f.project_root_escape, error('PROJECT_ROOT_ESCAPE'));
    assert.deepEqual(f.marker_escape, error('PROJECT_MARKER_ESCAPE'));
    assert.deepEqual(f.adapter_unavailable, error('PROJECT_ADAPTER_UNAVAILABLE'));
    // A marker that changed holds both digests; a marker that is gone holds the path only.
    assert.deepEqual(f.marker_drift, stale({ marker_path: 'api/package.json', digest_changed: true }));
    assert.deepEqual(f.marker_missing, stale({ marker_path: 'api/package.json' }));
    assert.deepEqual(f.marker_unreadable, f.marker_missing);
    // A read set that differs holds both fingerprints and both file lists; a listing that throws holds the cause only.
    const changed = (files) => readSet({ fingerprint_changed: true, actual_fingerprint_null: false, files });
    assert.deepEqual(f.source_drift, changed(same));
    assert.deepEqual(f.source_file_added, changed({ added: ['api/src/extra.js'], removed: [] }));
    assert.deepEqual(f.source_file_removed, changed({ added: [], removed: ['api/src/server.js'] }));
    // An adapter that no longer lists a read set: the actual fingerprint is `null` and the actual file list is empty.
    assert.deepEqual(f.read_set_not_recaptured, readSet({ fingerprint_changed: true, actual_fingerprint_null: true, files: { added: [], removed: ['api/src/server.js'] } }));
    assert.deepEqual(f.read_set_adapter_changed, readSet({ fingerprint_changed: false, actual_fingerprint_null: false, files: same }));
    assert.deepEqual(f.read_set_capture_error, readSet({ cause: { class: 'Error', code: 'E_LISTING' } }));
    assert.deepEqual(f.read_set_capture_escape, readSet({ cause: { class: 'Error', code: 'PROJECT_READ_SET_ESCAPE' } }));
    assert.deepEqual(f.plan_stale, error('PROJECT_PLAN_STALE', { project_id: 'project:svc', adapter_id: 'gated-http', cause: { class: 'Error', code: null } }));
    // Section 5.2: a graph with no read set re-hashes the markers and skips the source check.
    assert.deepEqual(unattested, {
      read_set: null, source_change: { ok: true }, marker_change: stale({ marker_path: 'api/package.json', digest_changed: true }),
    });
  });

  // RFC section 2.4: `adapters` defaults to the registry's list. The registry belongs to other tracks, so the
  // test compares the default with that list passed explicitly, and proves the comparison is not vacuous.
  it('shadow: adapters default to the registry list', () => {
    assert.deepEqual(missingFragments(rfc, ['`adapters` (default the registry\'s `ADAPTERS`) is looked up by `id`']), []);
    const { root, graph, plan } = registeredCase();
    assert.ok(plan.length > 0, 'the registered fixture plans nothing');
    const byDefault = shadowModule.executeProjectScanPlan({ repoRoot: root, graph });
    assert.equal(byDefault.scans.length, plan.length);
    assert.deepEqual(canon(byDefault), canon(shadowModule.executeProjectScanPlan({ repoRoot: root, graph, adapters: ADAPTERS })));
    assert.throws(() => shadowModule.executeProjectScanPlan({ repoRoot: root, graph, adapters: [] }), { code: 'PROJECT_ADAPTER_UNAVAILABLE' });
  });
});

let compiled = null;
function validate(doc) {
  compiled ??= new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  return compiled(doc) ? [] : [...compiled.errors];
}
const BASES = { normal: 'normal', tie: 'specificity_tie', duplicate: 'duplicate_local_package' };

describe('draft graph schema', () => {
  it('compiles in strict mode and has the recorded canonical hash', () => {
    assert.doesNotThrow(() => validate({}));
    assert.equal(sha256(JSON.stringify(canon(schema))), record.schema_canonical_sha256);
  });

  it('accepts every real graph, live and after a JSON round trip', () => {
    const all = graphs();
    assert.deepEqual(sorted(Object.keys(all)), sorted(['normal', 'registered', ...record.negative_cases]));
    for (const [name, graph] of Object.entries(all)) {
      assert.deepEqual(validate(graph), [], `${name}, live`);
      assert.deepEqual(validate(clone(graph)), [], `${name}, serialized`);
    }
  });

  it('has enough rejection edits, each aimed at a real graph and a schema keyword', () => {
    assert.ok(REJECTED_MUTATIONS.length >= 15);
    assert.equal(new Set(REJECTED_MUTATIONS.map((m) => m.name)).size, REJECTED_MUTATIONS.length);
    for (const m of REJECTED_MUTATIONS) {
      assert.ok(m.base in BASES, `${m.name}: unknown base ${m.base}`);
      assert.match(m.keyword, /^[a-zA-Z]+$/, m.name);
    }
  });

  for (const m of REJECTED_MUTATIONS) {
    it(`rejects: ${m.name}`, () => {
      const graph = clone(graphs()[BASES[m.base]]);
      assert.deepEqual(validate(graph), [], 'the unedited graph must pass first');
      m.mutate(graph);
      const keywords = validate(graph).map((e) => e.keyword);
      assert.ok(keywords.includes(m.keyword), `expected a "${m.keyword}" error, got ${JSON.stringify(keywords)}`);
    });
  }
});

// ---- RFC section 2.5: options and values the caller supplies -------------------------------------------
// The probe prints the structure of every option case (`detail` in the probe module) and what the case
// measured besides its graph (`extra`). ACCEPTED pairs each accepted case with the RFC statements it
// supports (`says`: text that must still be in the RFC, whitespace folded) and the assertions that those
// statements are true of the code. The schema checks over the same cases come after the tables.
const project = (graph, root) => graph.projects.find((p) => p.root === root);
const rootsOf = (graph) => graph.projects.map((p) => p.root);
const kindsOf = (graph) => graph.unresolved.map((u) => u.kind);
const markersOf = (graph) => Object.fromEntries(graph.projects.map((p) => [p.root, p.markers.map((m) => m[0])]));
const rolesOf = (graph) => Object.fromEntries(graph.projects.map((p) => [p.root, p.role]));
const fallbackOf = (graph) => Object.fromEntries(graph.projects.map((p) => [p.root, p.fallback]));
const selectedOf = (graph) => Object.fromEntries(graph.projects.map((p) => [p.root, p.http.selected]));
const edgesOf = (graph, kind) => graph.edges.filter((e) => e[0] === kind);

// The kind each default rule gives a base name (RFC section 4), written out from the rules in index.mjs.
const DEFAULT_MARKER_KINDS = {
  'package.json': 'node-package', 'pyproject.toml': 'python-project', 'requirements.txt': 'python-project',
  'requirements-dev.txt': 'python-project', 'requirements.dev.txt': 'python-project', 'REQUIREMENTS.TXT': 'python-project',
  'requirements_dev.txt': null, 'requirements.txt.bak': null, 'prerequirements.txt': null,
  'pom.xml': 'jvm-build', 'build.gradle': 'jvm-build', 'build.gradle.kts': 'jvm-build',
  'settings.gradle': 'jvm-workspace', 'settings.gradle.kts': 'jvm-workspace',
  Gemfile: 'ruby-bundle', gemfile: null, 'go.mod': 'go-module', 'Cargo.toml': 'rust-package', 'cargo.toml': null,
  'composer.json': 'php-package', 'App.csproj': 'dotnet-project', 'app.fsproj': 'dotnet-project',
  'APP.VBPROJ': 'dotnet-project', '.csproj': 'dotnet-project', 'App.csproj.user': null, Appcsproj: null, 'app.sln': null, 'Package.json': null, 'POM.XML': null,
  'Pyproject.toml': null, 'README.md': null,
};

const ACCEPTED = {
  custom_marker_kinds: {
    says: [
      'Any truthy value, copied unchanged to `markers[].kind`.',
      'a custom kind validates, including one that is only digits, only a space, or has non-ASCII letters.',
      "A falsy `kind` (`''`, `0`, `null`, `undefined`, `false`) makes the file not a marker, and no later rule is tried for it.",
      'whatever its file name, and parsed as JSON. A later `node-package` marker is ignored even when the first one is invalid',
      'It replaces the nine defaults; nothing is merged.',
    ],
    check({ graph }) {
      assert.deepEqual(markersOf(graph), {
        '.': [], both: ['first-rule-wins'], 'broken-pair': ['node-package', 'node-package'], 'deno-app': ['deno-project'],
        meta: ['node-package'], numeric: ['1'], 'odd-kind': ['Odd Kind 日本'], pair: ['node-package', 'node-package'],
        spaces: [' '], truthy: ['truthy-result'],
      });
      // Not projects: package.json (the defaults are replaced), a falsy kind, symbolic links, a directory named like a marker, node_modules.
      for (const absent of ['plain', 'blank', 'linked-dir', 'named-like-a-marker', 'node_modules']) assert.equal(project(graph, absent), undefined, absent);
      assert.deepEqual(project(graph, 'pair').local_package.name, 'first-by-path');
      assert.equal(project(graph, 'pair').local_package.evidence, 'pair/first.json');
      assert.deepEqual(project(graph, 'meta').local_package,
        { dependency_names: [], evidence: 'meta/meta.json', name: '@odd/meta', private: true, workspace_patterns: [] });
      assert.equal(project(graph, 'broken-pair').local_package, null);
      assert.deepEqual(graph.unresolved.map((u) => [u.kind, u.path]), [['package-metadata-read', 'broken-pair/first.json']]);
    },
  },
  empty_marker_rules: {
    says: [
      '`[]` leaves the repository root as the only project.',
      'Omitted or `undefined` means the defaults.',
      '`markerRules` is passed on only when truthy, so `[]` is passed and `null` or omitted means the defaults',
      'each is a Node `TypeError` as soon as the walk visits a regular file, and none fails in a repository that has no regular file.',
    ],
    check({ graph, extra }) {
      assert.deepEqual(rootsOf(graph), ['.']);
      assert.deepEqual(graph.files_read, []);
      assert.deepEqual(extra.registered_roots, { empty_array: ['.'], null: ['.', 'a'], omitted: ['.', 'a'] });
      assert.deepEqual(extra.rules_never_called, { null: ['.'], object: ['.'], null_rule: ['.'], rule_without_test: ['.'] });
    },
  },
  default_markers: {
    says: [
      'The probe feeds 31 base names to the nine rules, one file each.',
      'Every name is matched exactly, except the `requirements` pattern and the three `.*proj` suffixes, which ignore letter case.',
    ],
    check({ graph, extra }) {
      assert.deepEqual(extra.marker_kind_by_file_name, DEFAULT_MARKER_KINDS);
      assert.equal(graph.projects.length, 1 + Object.values(DEFAULT_MARKER_KINDS).filter(Boolean).length);
      assert.deepEqual([project(graph, '.').kind, project(graph, '.').fallback], ['aggregate', 'generic-grep']);
    },
  },
  async_marker_rule: {
    says: ['any truthy value counts, a Promise included, so an `async` test matches every regular file'],
    check({ graph }) {
      assert.deepEqual(rootsOf(graph), ['.', 'a', 'b']);
      assert.deepEqual(project(graph, '.').markers, [['async-kind', 'z.txt']]);
      assert.deepEqual(graph.files_read, ['a/x.txt', 'b/y.md', 'z.txt']);
    },
  },
  role_names: {
    says: [
      'A backslash counts as a separator, so a project below a directory literally named `x\\vendor` is judged `vendor`.',
      'Only the last segment is tested for the template extensions: `docs/Page.TMPL` is template, `docs/page.tmpl.bak` is active.',
      'The extension needs its dot and ignores letter case: `.mustache` and `page.HBS` are template, `pagehbs` is active.',
      '`Vendor/lib` is vendor and `my-vendor/lib` is active.',
      'The names match exactly, in lower case: `Vendor` and `Dist` are walked, and their projects get the roles `vendor` and `generated`.',
      'a read-set file\'s `role` is judged from its path relative to the project',
    ],
    check({ graph, extra }) {
      assert.deepEqual(rolesOf(graph), {
        '.': 'active', 'Dist/web': 'generated', 'Examples/demo': 'reference', 'Templates/site': 'template',
        'Vendor/Examples/demo': 'vendor', 'Vendor/lib': 'vendor', app: 'active', 'docs/Page.TMPL': 'template',
        'docs/page.tmpl.bak': 'active', 'docs/page.template': 'template', 'docs/page.mustache': 'template', 'docs/page.HBS': 'template',
        'docs/other.hbs': 'template', 'docs/pagehbs': 'active', 'docs/page.hbs.bak': 'active', 'docs.hbs/web': 'active',
        'examples-extra/demo': 'active', 'latest/web': 'active', 'my-vendor/lib': 'active',
        'vendored/lib': 'active', 'x\\vendor/svc': 'vendor',
      });
      assert.deepEqual(extra.read_set_roles, {
        'app/Tests/c.js': 'reference', 'app/Vendor/a.js': 'vendor', 'app/my-vendor/b.js': 'active',
        'app/page.TMPL': 'template', 'app/src/d.js': 'active',
      });
      assert.deepEqual(graph.unresolved, []);
    },
  },
  ignored_directories: {
    says: [
      '`vendor`, `third_party`, `third-party`, at any depth, and never follows symlinks.',
      'A name that only resembles one of them (`Node_Modules`, `vendors`, `third_party_x`, `.github`) is walked as well',
      'and so is a repository whose own name is on the list: the check is made on the entries below the root.',
    ],
    check({ graph, extra }) {
      // Sixteen names, each at the root and below `ignored/`, none of them a project; nineteen look-alikes, all of them walked.
      assert.deepEqual(extra.never_entered, record.literals.hard_ignored_directories);
      assert.deepEqual(rootsOf(graph), [
        '.', 'ignored', 'walked', 'walked/.Git', 'walked/.cache2', 'walked/.github', 'walked/.nextjs', 'walked/Build', 'walked/DIST',
        'walked/Node_Modules', 'walked/Out', 'walked/bskel', 'walked/builds', 'walked/cache', 'walked/coverage-report',
        'walked/dist-x', 'walked/node_modules2', 'walked/outer', 'walked/svelte-kit', 'walked/third-party-x',
        'walked/third_party_x', 'walked/vendors',
      ]);
      assert.equal(graph.files_read.length, 21);
      assert.deepEqual(extra.roots_when_the_repository_is_named, { dist: ['.', 'sub'], node_modules: ['.', 'sub'] });
      assert.deepEqual(graph.unresolved, []);
    },
  },
  walk_order: {
    says: [
      'The walk is depth first. In one directory it visits the files in descending name order, then the subdirectories in ascending name order, each with everything below it before the next.',
      'Names compare by code unit, so `B` comes before `a` and a surrogate pair (U+1F600) before U+FF61.',
      '`directory-read` and `marker-read` entries therefore come in that order, which is not the sorted order of their paths: `a/b` is listed before `a-x`.',
      'The `test` calls of the marker rules come in the same order.',
    ],
    check({ graph, extra }) {
      const wide = `${String.fromCharCode(0xff61)}-wide.cfg`;
      const astral = `${String.fromCodePoint(0x1f600)}-astral.cfg`;
      assert.deepEqual(extra.test_calls, [
        wide, astral, 'vanish-top.cfg', 'top-z.cfg', 'top-plain.txt', 'top-m.cfg', 'top-a.cfg', 'B-upper.cfg',
        'trigger.cfg', 'a0.cfg', 'c1.cfg', 'vanish-b.cfg', 'b2.cfg', 'a1.cfg', 'c1x.cfg', 'z0.cfg',
      ]);
      assert.deepEqual(graph.unresolved.map((u) => [u.kind, u.path]), [
        ['marker-read', 'vanish-top.cfg'], ['directory-read', 'a/b'], ['directory-read', 'a-x'], ['marker-read', 'b/vanish-b.cfg'],
      ]);
      assert.deepEqual(rootsOf(graph), ['.', 'a', 'a/c', 'b', 'b/a', 'b/c', 'z']);
      assert.deepEqual(graph.files_read, [
        'B-upper.cfg', 'a/a0.cfg', 'a/c/c1.cfg', 'a/trigger.cfg', 'b/a/a1.cfg', 'b/b2.cfg', 'b/c/c1x.cfg',
        'top-a.cfg', 'top-m.cfg', 'top-z.cfg', 'z/z0.cfg', astral, wide,
      ]);
    },
  },
  adapter_defaults: {
    says: [
      'an omitted or `null` field takes its default (`title` the adapter\'s `id`, `confidence` and `verification_basis` `unknown`, `capabilities` `{}`, `specificity` `0`)',
      'An omitted (`undefined` or `null`) `title` is recorded as the id, an omitted `confidence` or `verificationBasis` as the string `unknown`, and omitted `capabilities` as `{}`',
      'An adapter whose specificity is omitted, `NaN` or `Infinity` is therefore first-class although it records `0`',
    ],
    check({ graph }) {
      assert.deepEqual(project(graph, 'app').http.candidates, [{
        adapter_id: 'bare-http', capabilities: {}, confidence: 'unknown', specificity: 0, title: 'bare-http', verification_basis: 'unknown',
      }]);
      // No `specificity` records 0 but is not the number 0, so the adapter is a candidate and not a fallback.
      assert.deepEqual([project(graph, 'app').kind, project(graph, 'app').http.selected, project(graph, 'app').fallback], ['application', 'bare-http', null]);
    },
  },
  adapter_values: {
    says: [
      'and an empty string is kept, `specificity` is kept when it is a finite number (negative and fractional included) and is `0` otherwise',
      'so an array or a string becomes an object keyed by index and a number becomes `{}`',
      'Equal recorded specificities tie, so `NaN` and `Infinity` can tie at `0`',
      'so `NaN`, `Infinity`, a numeric string and an omitted value all record `0`',
      'any non-empty string is a valid id, spaces and non-ASCII letters included',
    ],
    check({ graph }) {
      const candidate = (root) => project(graph, root).http.candidates[0];
      const specificity = Object.fromEntries(graph.projects.filter((p) => p.root !== '.').map((p) => [p.root, p.http.candidates[0].specificity]));
      assert.deepEqual(specificity, {
        'blank-fields': 5, described: 5, fraction: 1.5, infinity: 0, 'list-capabilities': 5, nan: 0, negative: -5,
        'null-fields': 0, 'number-capabilities': 5, 'odd-id': 5, text: 0, 'text-capabilities': 5, tied: 0,
      });
      assert.deepEqual(project(graph, 'tied').http, {
        ambiguous: ['tied-infinity-http', 'tied-nan-http'], candidates: project(graph, 'tied').http.candidates,
        reason: 'specificity-tie', selected: null,
      });
      assert.equal(project(graph, 'tied').kind, 'ambiguous');
      // `NaN`, `Infinity` and a numeric string record 0 without being the number 0: candidates, not fallbacks.
      assert.deepEqual(['nan', 'infinity', 'text'].map((root) => [project(graph, root).http.selected, project(graph, root).fallback]),
        [['nan-http', null], ['infinity-http', null], ['text-http', null]]);
      assert.deepEqual(candidate('described'), {
        adapter_id: 'described-http', capabilities: { http: true, nested: { depth: 1 } }, confidence: 'medium', specificity: 5,
        title: 'Described', verification_basis: 'custom-basis',
      });
      assert.deepEqual(candidate('null-fields'), {
        adapter_id: 'null-http', capabilities: {}, confidence: 'unknown', specificity: 0, title: 'null-http', verification_basis: 'unknown',
      });
      assert.deepEqual([candidate('blank-fields').title, candidate('blank-fields').confidence, candidate('blank-fields').verification_basis], ['', '', '']);
      assert.deepEqual(candidate('list-capabilities').capabilities, { 0: 'http' });
      assert.deepEqual(candidate('text-capabilities').capabilities, { 0: 'a', 1: 'b' });
      assert.deepEqual(candidate('number-capabilities').capabilities, {});
      assert.equal(project(graph, 'odd-id').http.selected, 'Odd Id 日本');
      assert.deepEqual(graph.unresolved, []);
    },
  },
  fallback_adapters: {
    says: [
      'Fallback means id `generic-grep` or a raw `specificity` that is exactly the number `0`.',
      'when several do, the one asked last is recorded (the asking order is below).',
      'A fallback is an adapter whose id is `generic-grep` or whose raw `specificity` is exactly `0`, so an adapter with no `specificity` is first-class (section 4).',
    ],
    check({ graph }) {
      // generic-grep (7), inventory (0) and zeta-inventory (0) all detect `app`; the one asked last (specificity desc, id asc) wins.
      assert.deepEqual(fallbackOf(graph), { '.': null, app: 'zeta-inventory' });
      assert.equal(project(graph, 'app').http.reason, 'no-first-class-adapter');
      assert.equal(project(graph, 'app').kind, 'unrecognized');
    },
  },
  detect_failures: {
    says: [
      'A throw is recorded as `adapter-detect-error` with a portable message, and the adapter is not a candidate for that root.',
      'The thrown value may be a string. An async `detect` returns a Promise, an unrecognized shape: `unlocated-detection`',
      'An element without a `detect` function records `adapter-detect-error` for every project root.',
    ],
    check({ graph }) {
      // Adapters are visited by descending specificity, then id: async-http (50), then the two without a specificity.
      assert.deepEqual(graph.unresolved.map((u) => [u.project_root, u.adapter_id, u.kind]), ['.', 'a'].flatMap((root) => [
        [root, 'async-http', 'unlocated-detection'], [root, 'no-detect-http', 'adapter-detect-error'], [root, 'throws-text-http', 'adapter-detect-error'],
      ]));
      assert.deepEqual(graph.projects.flatMap((p) => p.http.candidates), []);
      assert.deepEqual(graph.unresolved.filter((u) => u.repo_path_in_message), []);
    },
  },
  detect_values: {
    says: [
      '`null`, `undefined` and `false` mean not detected, and nothing is recorded. Every other value is a detection, `true`, `0`, `\'\'` and `NaN` included.',
      'A fallback adapter (section 4) that detects is recorded as the fallback whatever it returned.',
      '`projectRoot` wins over `srcRoot`, and an empty `projectRoot` falls through to `srcRoot`.',
      'A root equal to the candidate makes a candidate, a root below it is a `nested_detections` entry, any other root is `out-of-scope-detection`',
      'Every other shape is `unlocated-detection`, for a first-class adapter only.',
      'A relative string is resolved against the process working directory, not the repository, so it usually reads as out of scope.',
      'The parent directory is out of scope too (`detected_root` `.`)',
    ],
    check({ graph }) {
      const named = (map) => Object.entries(map).filter(([, id]) => id).map(([root]) => root).sort();
      assert.deepEqual(named(selectedOf(graph)), [
        'absolute-string', 'cwd-relative-string', 'empty-project-root', 'java-source-string', 'project-root-first',
        'project-root-object', 'source-root-object',
      ]);
      assert.deepEqual(named(fallbackOf(graph)), ['fallback-empty-string', 'fallback-true', 'fallback-zero']);
      assert.deepEqual(graph.unresolved.map((u) => [u.project_root, u.kind, u.detected_root ?? null]), [
        ['array-of-roots', 'unlocated-detection', null], ['empty-object', 'unlocated-detection', null],
        ['empty-string', 'unlocated-detection', null], ['not-a-number', 'unlocated-detection', null],
        ['parent-directory', 'out-of-scope-detection', '.'], ['repo-relative-string', 'out-of-scope-detection', '<outside the repository>'],
        ['true', 'unlocated-detection', null], ['zero', 'unlocated-detection', null],
      ]);
      // Not detected: nothing is recorded, not even a fallback.
      for (const root of ['false', 'null', 'undefined', 'fallback-false', 'fallback-null']) {
        assert.deepEqual([project(graph, root).http.selected, project(graph, root).fallback], [null, null], root);
        assert.equal(graph.unresolved.some((u) => u.project_root === root), false, root);
      }
    },
  },
  unresolved_order: {
    says: [
      '`unresolved` is not sorted: entries come in the order the builder found them. First the discovery diagnostics (`directory-read` and `marker-read`, in walk order); then, for each project root in `root` order, the adapter diagnostics (adapters in the asking order of section 4: their own `specificity` descending, then id) followed by that root\'s read-set diagnostic; then `package-metadata-read` per project; then the edge diagnostics.',
    ],
    check({ graph }) {
      const where = (u) => u.project_root ?? u.path ?? u.project_id ?? u.package_name;
      assert.deepEqual(graph.unresolved.map((u) => [u.kind, where(u)]), [
        ['marker-read', 'a-vanish/gone.cfg'],
        ['adapter-detect-error', 'b-broken'],
        ['adapter-detect-error', 'f-app'],
        ['adapter-read-set-error', 'f-app'],
        ['package-metadata-read', 'b-broken/package.json'],
        ['ambiguous-local-package-name', '@dup/x'],
        ['ambiguous-local-package-dependency', 'project:e-user'],
      ]);
      assert.deepEqual(graph.unresolved.filter((u) => u.repo_path_in_message).map((u) => u.kind), ['marker-read']);
    },
  },
  adapter_removed_during_build: {
    says: [
      'An adapter removed from the array while the build runs gives `selected-adapter-missing`',
      'the project stays `application` with no read set',
    ],
    check({ graph }) {
      assert.deepEqual(graph.unresolved.map((u) => [u.kind, u.project_root, u.adapter_id]), [['selected-adapter-missing', 'app', 'vanishing-http']]);
      assert.deepEqual([project(graph, 'app').kind, project(graph, 'app').http.selected, project(graph, 'app').read_set], ['application', 'vanishing-http', null]);
    },
  },
  read_set_shapes: {
    says: [
      'An array of non-empty strings. They resolve against the project root (an absolute path inside the project is accepted) and duplicates collapse by repo-relative path. A marker file may be listed too, and `files_read` then holds it once. An empty array gives an empty read set, not `null`. A path inside a hard-ignored directory such as `node_modules` is accepted.',
      'One bad entry fails the whole read set: a result that is not an array, an entry that is empty or not a string, a directory, a missing file, a path that leaves the project, or a throw inside the listing.',
      'The graph records one `adapter-read-set-error` and a `null` read set',
    ],
    check({ graph }) {
      const readSet = (root) => project(graph, root).read_set;
      assert.deepEqual(readSet('duplicates-collapse'), ['duplicates-collapse/a.js']);
      assert.deepEqual(readSet('empty-list'), []);
      assert.deepEqual(readSet('lists-a-marker'), ['lists-a-marker/a.js', 'lists-a-marker/package.json']);
      assert.equal(graph.files_read.filter((file) => file === 'lists-a-marker/package.json').length, 1);
      assert.deepEqual(graph.files_read, [...new Set(graph.files_read)].sort());
      assert.deepEqual(readSet('inside-ignored-directory'), ['inside-ignored-directory/node_modules/m.js']);
      const failing = ['directory-entry', 'empty-entry', 'listing-throws', 'missing-file', 'non-string-entry', 'not-an-array', 'outside-project'];
      assert.deepEqual(graph.unresolved.map((u) => [u.kind, u.project_root, u.adapter_id]), failing.map((root) => ['adapter-read-set-error', root, 'shape-http']));
      for (const root of failing) {
        assert.deepEqual([readSet(root), project(graph, root).kind, project(graph, root).http.selected], [null, 'application', 'shape-http'], root);
      }
    },
  },
  package_metadata: {
    says: [
      '`name` is kept when it is a non-empty string, and `private` is `true` only for the JSON value `true`.',
      '`dependency_names` holds the keys of `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`, whatever their values are (an empty key included), sorted by code unit and de-duplicated.',
      'A field counts only when it is a plain object: a string, a number, `null` or an array adds nothing, and no other field is read (`bundledDependencies`, `peerDependenciesMeta`, `overrides`).',
      '`workspace_patterns` holds the string entries of a `workspaces` array, or of `workspaces.packages` when `workspaces` is not an array and `packages` is one, sorted by code unit and not de-duplicated.',
      'JSON of another shape (`null`, `[]`, a number) gives a readable `local_package` with those defaults',
      'An empty file, a file that starts with a byte-order mark, and invalid JSON record `package-metadata-read` and leave `local_package` `null`. The name format is not checked',
      'Dependency names are the union of `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`',
      'A self-match is skipped: a project that lists its own name keeps it in `dependency_names` and gets no edge,',
      'The package facts are read after every adapter has run: a `package.json` that has been removed by then records `package-metadata-read` with a portable message, and one that has been rewritten gives the facts of the new content under the digest taken when the file was found',
    ],
    check({ graph, extra }) {
      const pkg = (root) => project(graph, root).local_package;
      const defaults = (root) => ({ dependency_names: [], evidence: `${root}/package.json`, name: null, private: false, workspace_patterns: [] });
      for (const root of ['json-null', 'json-array', 'json-number', 'wrong-types', 'empty-name']) assert.deepEqual(pkg(root), defaults(root), root);
      assert.deepEqual(['byte-order-mark', 'empty-file', 'vanished-package'].map(pkg), [null, null, null]);
      assert.deepEqual(graph.unresolved.map((u) => [u.kind, u.path]), [
        ['package-metadata-read', 'byte-order-mark/package.json'], ['package-metadata-read', 'empty-file/package.json'],
        ['package-metadata-read', 'vanished-package/package.json'],
      ]);
      assert.deepEqual(graph.unresolved.map((u) => u.repo_path_in_message), [false, false, false]);
      assert.equal(pkg('rewritten-package').name, 'after');
      assert.deepEqual(extra.rewritten_digest, { of_the_first_content: true, of_the_new_content: false, same_as_the_marker: true });
      assert.deepEqual(pkg('workspaces-object'), { ...defaults('workspaces-object'), name: 'ws', private: true, workspace_patterns: ['a', 'b'] });
      assert.equal(pkg('name-format').name, 'Not A Valid Name!');
      assert.deepEqual(pkg('self-dependency').dependency_names, ['self']);
      assert.deepEqual(pkg('dependency-fields').dependency_names, ['dep-a', 'dep-b', 'dep-c', 'dep-d']);
      for (const root of ['dependency-types', 'dependency-other-fields']) assert.deepEqual(pkg(root).dependency_names, [], root);
      assert.deepEqual(pkg('dependency-values').dependency_names,
        ['', '10', '9', 'Zed', 'a-lower', 'val-array', 'val-null', 'val-number', 'val-object']);
      assert.deepEqual(pkg('workspaces-array').workspace_patterns, ['pkg/a', 'pkg/a', 'pkg/b']);
      assert.deepEqual(['workspaces-packages-text', 'workspaces-nohoist'].map((root) => pkg(root).workspace_patterns), [[], ['q']]);
      assert.deepEqual(edgesOf(graph, 'local-package-dependency').map((e) => [e[1], e[2], e[3]]),
        ['dep-a', 'dep-b', 'dep-c', 'dep-d'].map((dep) => ['project:dependency-fields', `project:${dep}`, dep]));
    },
  },
  prototype_names: {
    says: [
      'Names that every object has as properties, `__proto__`, `constructor`, `toString` and `hasOwnProperty`, are ordinary too, as a directory, a package name, a dependency name or an adapter `id`: the builder keeps its tables in `Map` and `Set` objects',
    ],
    check({ graph }) {
      // Written as pairs: an object literal with a `__proto__` key would not make a key.
      assert.deepEqual(graph.projects.map((p) => [p.root, p.http.selected, p.local_package.name, p.local_package.dependency_names]), [
        ['.', '__proto__', 'top', ['__proto__', 'constructor', 'hasOwnProperty', 'toString']],
        ['__proto__', '__proto__', '__proto__', []],
        ['constructor', '__proto__', 'constructor', ['__proto__', 'toString']],
        ['hasOwnProperty', '__proto__', 'hasOwnProperty', []],
        ['toString', '__proto__', 'toString', ['constructor']],
      ]);
      assert.deepEqual(project(graph, 'hasOwnProperty').local_package.workspace_patterns, ['__proto__']);
      assert.deepEqual(edgesOf(graph, 'local-package-dependency').map((e) => [e[1], e[2], e[3]]), [
        ['project:.', 'project:__proto__', '__proto__'], ['project:.', 'project:constructor', 'constructor'],
        ['project:.', 'project:hasOwnProperty', 'hasOwnProperty'], ['project:.', 'project:toString', 'toString'],
        ['project:constructor', 'project:__proto__', '__proto__'], ['project:constructor', 'project:toString', 'toString'],
        ['project:toString', 'project:constructor', 'constructor'],
      ]);
      assert.deepEqual(graph.unresolved, []);
    },
  },
  odd_names: {
    says: [
      'Names that are legal on POSIX: spaces, `c:`, `a:b`, a backslash, a newline, a tab, a quote, non-ASCII letters, a leading dash or dot.',
      'Graph paths are relative strings in which a backslash is an ordinary character, and the schema accepts any relative path without a `..` segment',
    ],
    check({ graph }) {
      assert.deepEqual(rootsOf(graph), [
        '%20', '-dash', '.', '.hidden', 'a:b', 'back\\slash', 'c:', 'new\nline', 'quote"s', 'tab\tname', 'with space', 'x..', '日本',
      ]);
      // The two names an adapter recognizes keep their read-set paths as written.
      assert.deepEqual(graph.projects.filter((p) => p.http.selected).map((p) => [p.root, p.read_set]),
        [['back\\slash', ['back\\slash/index.js']], ['c:', ['c:/src/server.js']]]);
      assert.deepEqual(project(graph, '.').nested, [{ adapter_id: 'javascript-express', detected_root: 'back\\slash' }]);
      assert.deepEqual(edgesOf(graph, 'local-package-dependency').map((e) => [e[1], e[2], e[3]]), [
        ['project:c:', 'project:a:b', '@odd/colon'], ['project:new\nline', 'project:back\\slash', '@odd/backslash'],
      ]);
      assert.deepEqual(graph.unresolved, []);
    },
  },
  dotdot_names: {
    says: ['A first path segment that starts with two dots (`..dots`, `..lib`) is read as an escape by five checks in the builder (section 8, limit 16)'],
    check({ graph, extra }) {
      assert.deepEqual(rootsOf(graph), ['.', '..dots', 'svc']);
      assert.deepEqual(graph.unresolved.map((u) => [u.kind, u.project_root, u.detected_root ?? null]), [
        ['out-of-scope-detection', '.', '..dots'], ['adapter-read-set-error', '..dots', null], ['adapter-read-set-error', 'svc', null],
      ]);
      assert.equal(extra.shadow_error_code, 'PROJECT_MARKER_ESCAPE');
    },
  },
  repo_root_forms: {
    says: ['Only `path.resolve` is applied, so a relative path, a trailing separator and a symbolic link give the same graph.'],
    check({ graph, extra }) {
      assert.deepEqual(extra.same_as_absolute, { relative: true, symbolic_link: true, trailing_separator: true });
      assert.deepEqual(rootsOf(graph), ['.', 'svc']);
    },
  },
  missing_repo_root: {
    says: ['A path that does not exist, or that is a file, records one `directory-read` entry (path `.`) and a graph that holds only the root project `.`'],
    check({ graph }) {
      assert.deepEqual(rootsOf(graph), ['.']);
      assert.deepEqual(graph.unresolved.map((u) => [u.kind, u.path]), [['directory-read', '.']]);
      assert.deepEqual(graph.files_read, []);
    },
  },
  file_as_repo_root: {
    says: ['a directory could not be listed during discovery (for example a missing or non-directory `repoRoot`, path `.`); its subtree is unobserved'],
    check({ graph }) {
      assert.deepEqual(rootsOf(graph), ['.']);
      assert.deepEqual(graph.unresolved.map((u) => [u.kind, u.path]), [['directory-read', '.']]);
    },
  },
  vanished_marker: {
    says: [
      'A marker file that cannot be read after its rule matched is recorded as `marker-read` and is not a marker, so its directory may be missing from the graph',
      'The `marker-read` message is the raw system text and holds the absolute path (section 8, limit 4). Every other message is portable',
    ],
    check({ graph }) {
      assert.deepEqual(rootsOf(graph), ['.']);
      assert.deepEqual(graph.unresolved, [{ kind: 'marker-read', path: 'a/package.json', repo_path_in_message: true }]);
    },
  },
  no_adapters: {
    says: ['With none, the markers still make projects, each is `aggregate` or `unrecognized`, and none has a fallback.'],
    check({ graph }) {
      assert.deepEqual(rootsOf(graph), ['.', 'svc']);
      assert.deepEqual(graph.projects.map((p) => [p.kind, p.fallback, p.markers.length]), [['aggregate', null, 1], ['unrecognized', null, 1]]);
    },
  },
  empty_repository: {
    says: ['A repository with no marker and no file gives the root project only'],
    check({ graph }) {
      assert.deepEqual(rootsOf(graph), ['.']);
      assert.deepEqual([graph.projects[0].kind, graph.projects[0].markers, graph.unresolved, graph.files_read], ['unrecognized', [], [], []]);
    },
  },
  unknown_options: {
    says: ['It reads three keys of the options object and ignores every other one, so a plan option such as `includeFallback` does nothing there'],
    check({ graph, extra }) {
      // The case passes includeFallback, includeNonActive, terms, rgAvailable and one key nobody defined.
      assert.equal(extra.same_as_without_them, true);
      assert.deepEqual(rootsOf(graph), ['.', 'svc']);
    },
  },
  plan_options: {
    says: [
      '`includeFallback` and `includeNonActive` are plain truthiness tests: `\'yes\'` and `1` count as set, `0` and `\'\'` do not.',
      'They combine, so a non-active project gets a fallback item only when both are set, and an `aggregate` project gets none either way.',
      'The plan variant forwards `includeFallback` to the plan but not `includeNonActive`, so it never plans a non-active project',
    ],
    check({ graph, extra }) {
      const only = ['app:plan-http:first-class'];
      const lib = 'lib:generic-grep:fallback';
      const demo = 'examples/demo:plan-http:first-class';
      const both = [only[0], demo, 'examples/lib:generic-grep:fallback', lib];
      assert.deepEqual(extra.plans, {
        default: only, include_fallback: [only[0], lib], include_non_active: [only[0], demo], both,
        truthy_values: both, falsy_values: only,
      });
      assert.deepEqual(extra.registered_plans, {
        default: only, include_fallback: [only[0], lib], include_non_active: only, both: [only[0], lib],
      });
      assert.deepEqual(extra.registered_result_keys, ['graph', 'plan']);
      // The root `.` is an aggregate with a fallback adapter and never gets an item; the examples roots are not active.
      assert.deepEqual([fallbackOf(graph)['.'], project(graph, '.').kind], ['generic-grep', 'aggregate']);
      assert.deepEqual(rolesOf(graph), { '.': 'active', app: 'active', 'examples/demo': 'reference', 'examples/lib': 'reference', lib: 'active' });
    },
  },
  discover_roots: {
    says: [
      'It checks no `repoRoot`: an empty string is the process working directory, and `undefined`, `null` or a number is a Node `TypeError`, as is `null` in place of the options object',
      '`repo_root` and each `roots[].absolute_root` are absolute, so this object is not portable',
      '`discoverProjectRoots`, the walk the builder starts with, reads `markerRules` the same way but checks no `repoRoot` (section 2.1).',
    ],
    check({ extra }) {
      assert.deepEqual(extra, {
        failures: { no_argument: 'TypeError', null_options: 'TypeError', null_path: 'TypeError', number_path: 'TypeError' },
        paths_are_absolute: true,
        result_keys: ['files_read', 'repo_root', 'roots', 'unresolved'],
        roots: ['.', 'a'], roots_of_empty_string: ['.', 'a'], roots_without_marker_rules: ['.'],
      });
    },
  },
  shadow_options: {
    says: [
      'The nested scan runs on the project\'s own directory: for each planned project the planned adapter\'s `detect` and `scan` are called once with the absolute project root (the repository itself for `.`), no other adapter of `adapters` is called, `introspectRoutes` is never called, and the report has an `unknowns` entry that starts with `DB not scanned` and neither a `db_schema` nor a `runtime_introspection` key.',
      'A falsy `repoRoot` is `TypeError: repoRoot is required`, and a graph that is not draft-1 is `TypeError: expected sbf.project-graph/draft-1`; `null` in place of the options object is a Node `TypeError`.',
      'A truthy `repoRoot` that is not a string (`5`) is a Node `TypeError` too. A missing graph, `null`, and a graph with another `schema` are the draft-1 error as well, even when they have no `projects` list.',
      '`terms` (default `[]`) is returned as a copy and handed to every nested scan. It has to be an array: `null`, a string or a `Set` makes the nested scan throw, and that comes back as `PROJECT_PLAN_STALE` (section 5.3) although nothing is stale.',
      'With no planned project there is no nested scan, and `terms` is only spread into the returned list: a string gives a list of its characters, a `Set` a list of its members, and `null` or a number is a Node `TypeError`.',
      '`rgAvailable` (default `true`) is handed to it too and comes back as the report\'s `rg_available` as given, not turned into a boolean; a falsy value (`false`, `0`, `null`) adds the `ripgrep` entry to the report\'s `unknowns`.',
      'two entries with one id throw a plain `Error` with no `code` before any project is verified, whether or not the plan uses them. It need not be an array, any iterable of adapters works (a `Set`), and `null` is a Node `TypeError`.',
      '`includeFallback` (default off) adds the `fallback` items of section 2.3, so a project that only the fallback recognizes is then scanned in `fallback` mode.',
      'It takes no `includeNonActive`: that key, like any other key that is not listed, is ignored, so non-active roots are never scanned in shadow mode.',
      'The root a live graph captured and `repoRoot` are compared as text after `path.resolve`: a trailing separator, a `..` segment or a relative path to the same directory matches, and a symbolic link to it does not (`PROJECT_GRAPH_ROOT_MISMATCH`).',
      'A draft-1 graph whose `projects` is missing or is not an array is a Node `TypeError`, raised after the duplicate-id check and before any project is verified, and one with an empty `projects` array returns an empty `scans`.',
      're-captures the selected adapter\'s read set and compares the adapter id and the fingerprint. A changed, added or removed file fails, and so do an adapter that no longer lists a read set, a read set recorded under another adapter id and a listing that throws.',
      'A project with no read set (`selected_adapter_read_set` `null`) skips that check and keeps the marker check, and a project entry with no `markers` key has nothing to re-hash.',
      'The projects are verified one after the other, each just before its own scan, so a project that has gone stale late in the plan fails after the earlier projects have been scanned.',
    ],
    check({ graph, extra }) {
      const app = 'app:javascript-express:first-class';
      const api = 'services/api:javascript-express:first-class';
      const express = (dir) => [`detect javascript-express ${dir}`, `scan javascript-express ${dir}`];
      assert.deepEqual(extra.scanned, { default: [app, api], include_fallback: [app, 'lib:generic-grep:fallback', api], include_non_active: [app, api] });
      // The nested scan asks only the planned adapter, once per planned project, with that project's directory
      // (two levels down for `services/api`); `introspectRoutes` is never called, and no `lib`, `examples` or repository root call.
      assert.deepEqual(extra.nested_scan.calls, [...express('app'), ...express('services/api')]);
      assert.deepEqual(extra.nested_scan.calls_with_fallback,
        [...express('app'), 'detect generic-grep lib', 'scan generic-grep lib', ...express('services/api')]);
      // The module the stub scan reports is named after the directory it was given.
      const nested = (project_root, module) => ({ project_root, modules: [module], db_not_scanned: true, has_db_schema: false, has_runtime_introspection: false });
      assert.deepEqual(extra.nested_scan.reports, [nested('app', 'app'), nested('services/api', 'api')]);
      const planStale = { error: 'Error', code: 'PROJECT_PLAN_STALE', message: null, project_id: 'project:app', cause: 'TypeError' };
      assert.deepEqual(extra.terms, {
        default: [], echoed: ['alpha', 'beta'], copied: true, in_nested_reports: [['alpha', 'beta'], ['alpha', 'beta']],
        not_an_array: { null: planStale, string: planStale, set: planStale },
        empty_plan: { string: ['a', 'b'], set: ['x', 'y'], null: { error: 'TypeError', code: null, message: null }, number: { error: 'TypeError', code: null, message: null } },
      });
      assert.deepEqual(extra.rg_available, {
        default: true, false: false, zero: 0, text: 'no',
        ripgrep_entry: { default: false, false: true, zero: true, null: true, text: false },
      });
      assert.deepEqual(extra.adapters_iterable, [app, api]);
      assert.deepEqual(extra.repo_root_forms, {
        trailing_separator: [app, api], relative: [app, api], dot_segments: [app, api],
        symbolic_link: { error: 'Error', code: 'PROJECT_GRAPH_ROOT_MISMATCH', message: null },
      });
      const duplicate = { code: null, error: 'Error', message: 'duplicate adapter id' };
      const node = { code: null, error: 'TypeError', message: null };
      assert.deepEqual(extra.graph_shapes, { empty_projects: [], no_projects: node, projects_not_an_array: node, duplicate_ids_first: duplicate });
      // `app` was scanned before the stale `services/api` was found, and the call still fails as a whole.
      assert.deepEqual(extra.later_project_stale, {
        error: 'Error', code: 'PROJECT_GRAPH_STALE', message: null, project_id: 'project:services/api', calls: express('app'),
      });
      assert.deepEqual(extra.failures, {
        duplicate_adapter_ids: duplicate,
        no_repo_root: { code: null, error: 'TypeError', message: 'repoRoot is required' },
        repo_root_number: node,
        not_a_graph: { code: null, error: 'TypeError', message: 'expected sbf.project-graph/draft-1' },
        graph_missing: { code: null, error: 'TypeError', message: 'expected sbf.project-graph/draft-1' },
        graph_null: { code: null, error: 'TypeError', message: 'expected sbf.project-graph/draft-1' },
        other_schema: { code: null, error: 'TypeError', message: 'expected sbf.project-graph/draft-1' },
        no_arguments: { code: null, error: 'TypeError', message: 'repoRoot is required' },
        null_options: node,
        null_adapters: node,
      });
      // `examples/demo` has a selected adapter but a `reference` role, so only the option decides whether it is planned.
      assert.deepEqual([selectedOf(graph)['examples/demo'], rolesOf(graph)['examples/demo']], ['javascript-express', 'reference']);
    },
  },
  adapter_order: {
    says: [
      'sorted by descending recorded specificity then id, not only the tied ones, and `ambiguous_adapter_ids` follows that order.',
      'The builder asks the adapters in another order: by the `specificity` the adapter has, as given, descending, then by `id`. There an omitted value counts as `0`, a numeric string as its number, and `Infinity` comes first, so an adapter that is listed among the `0`s can be asked before all the others.',
      'The caller\'s `adapters` array is sorted as a copy and is never reordered.',
      'The asking order decides the order of the adapter diagnostics of one project root in `unresolved` (section 5.1) and which of several fallbacks is recorded; it does not change the candidates, `nested_detections` or the selection.',
      'When two adapters share an `id`, the read set is captured from the first element of the array that has that `id`, which need not be the adapter that detected.',
      'two adapters with one id can tie (the read set comes from the first of them in the array, section 4)',
      '`[{adapter_id, detected_root}]`, sorted by `adapter_id`, then `detected_root`',
    ],
    check({ graph, extra }) {
      const http = (root) => project(graph, root).http;
      const listed = (root) => http(root).candidates.map((c) => [c.adapter_id, c.specificity]);
      // `rank`: the candidates come by recorded specificity, then id; the unique highest is selected.
      assert.deepEqual(listed('rank'), [['z-http', 80], ['a-http', 50], ['m-http', 50], ['b-http', 20]]);
      assert.deepEqual([http('rank').selected, http('rank').reason, http('rank').ambiguous], ['z-http', 'unique-highest-specificity', []]);
      // `tie`: the tied ids follow the candidate order; the lower candidate is listed but not tied.
      assert.deepEqual(listed('tie'), [['tie-a-http', 70], ['tie-z-http', 70], ['tie-low-http', 10]]);
      assert.deepEqual([http('tie').ambiguous, http('tie').selected, http('tie').reason], [['tie-a-http', 'tie-z-http'], null, 'specificity-tie']);
      // `infinite`: `Infinity` and the numeric string record `0`, so they sort among the zeros by id, and the real 5 wins
      // although the builder asked `z-inf-http` first.
      assert.deepEqual(listed('infinite'), [['five-http', 5], ['a-str-http', 0], ['z-inf-http', 0]]);
      assert.equal(http('infinite').selected, 'five-http');
      // `visit`: the entries of one project root come in the order the adapters were asked: `Infinity`, the two 7s by id,
      // the numeric string as 5, the omitted value as 0, then -3. The array lists them in another order.
      assert.deepEqual(graph.unresolved.map((u) => [u.project_root, u.adapter_id, u.kind]),
        ['z-inf-ask', 'b-seven-ask', 'm-seven-ask', 'a-str-ask', 'q-omitted-ask', 'r-negative-ask'].map((id) => ['visit', id, 'unlocated-detection']));
      // `agg`: one entry per adapter object, so the adapter that is listed twice appears twice.
      assert.deepEqual(project(graph, 'agg').nested, [
        { adapter_id: 'nest-a-http', detected_root: 'agg/svc2' }, { adapter_id: 'nest-twin-http', detected_root: 'agg/svc1' },
        { adapter_id: 'nest-twin-http', detected_root: 'agg/svc2' }, { adapter_id: 'nest-z-http', detected_root: 'agg/svc1' },
      ]);
      // `twin`: the adapter with 50 is selected, the read set is the one listed by the first element with that id (specificity 10).
      assert.deepEqual([http('twin').selected, listed('twin'), project(graph, 'twin').read_set], ['dup-http', [['dup-http', 50], ['dup-http', 10]], ['twin/b.js']]);
      assert.equal(extra.array_unchanged, true);
    },
  },
  adapter_calls: {
    says: [
      'The builder calls both as methods of the adapter, so `this` is the adapter, and passes one argument, the absolute path of the project root: `path.resolve(repoRoot)` for `.`, and that path followed by the recorded root for any other project.',
      'A symbolic link in `repoRoot` is not resolved.',
      '`detect` is called once for each element of `adapters` for each discovered project root, in the order of `projects` and, within a root, in the asking order of section 4, whatever an earlier adapter returned.',
      '`listReadSet` is called once, for the adapter that was selected, right after the detections of that project root and before the next root is visited. It is not called for a candidate that lost, for a tie, or for a fallback',
      'No `repoRoot`, no options and no second argument are passed.',
      'and only for a project that has no candidate (a tie counts as having candidates);',
    ],
    check({ graph, extra }) {
      // Every adapter is asked in every root, in the asking order (specificity descending, then id), although `high-http`
      // answered first. Roots come in the order of `projects`. The read set is asked for once per selection, after the
      // detections of the same root: not in `lib` (a tie), and never from `low-http` or `generic-grep`.
      const asked = (root) => ['high-http', 'tie-a-http', 'tie-b-http', 'low-http', 'generic-grep'].map((id) => `detect ${id} ${root}`);
      assert.deepEqual(rootsOf(graph), ['.', 'lib', 'svc']);
      assert.deepEqual(extra.calls, [...asked('.'), 'listReadSet high-http .', ...asked('lib'), ...asked('svc'), 'listReadSet high-http svc']);
      // One argument, a string and absolute; `this` is the adapter; the link is not resolved (`calls` is relative to the link).
      assert.deepEqual([extra.one_absolute_argument, extra.this_is_the_adapter], [true, true]);
      assert.deepEqual(selectedOf(graph), { '.': 'high-http', lib: null, svc: 'high-http' });
      // `generic-grep` detected every root, and is recorded in none: each has candidates, `lib` as a tie.
      assert.deepEqual(fallbackOf(graph), { '.': null, lib: null, svc: null });
      assert.deepEqual(Object.fromEntries(graph.projects.map((p) => [p.root, p.http.candidates.map((c) => c.adapter_id)])), {
        '.': ['high-http', 'low-http'], lib: ['tie-a-http', 'tie-b-http'], svc: ['high-http', 'low-http'],
      });
    },
  },
  nested_projects: {
    says: [
      'the nearest descendant project roots only: a descendant with another project between it and this root is left out, and a directory with no marker between two projects does not count.',
      '`contains` runs from the nearest enclosing project to its child with `evidence: []`.',
      '`application` when an adapter was selected; else `ambiguous` when first-class adapters tie for the highest specificity; else `aggregate` when the project has child project roots; else `unrecognized`',
    ],
    check({ graph }) {
      assert.deepEqual(rootsOf(graph), ['.', 'app', 'app-extra', 'app/api', 'app/api/core', 'tools/ci/lint']);
      // `app-extra` only starts like `app`; `tools` and `tools/ci` have no marker, so they are not projects.
      assert.deepEqual(Object.fromEntries(graph.projects.map((p) => [p.root, p.children])), {
        '.': ['app', 'app-extra', 'tools/ci/lint'], app: ['app/api'], 'app-extra': [], 'app/api': ['app/api/core'], 'app/api/core': [], 'tools/ci/lint': [],
      });
      // One project for each row of the rule: an adapter selected, a tie, children only, nothing.
      assert.deepEqual(Object.fromEntries(graph.projects.map((p) => [p.root, p.kind])), {
        '.': 'aggregate', app: 'ambiguous', 'app-extra': 'unrecognized', 'app/api': 'application', 'app/api/core': 'unrecognized', 'tools/ci/lint': 'unrecognized',
      });
      assert.deepEqual(edgesOf(graph, 'contains').map((e) => [e[1], e[2]]), [
        ['project:.', 'project:app'], ['project:.', 'project:app-extra'], ['project:.', 'project:tools/ci/lint'],
        ['project:app', 'project:app/api'], ['project:app/api', 'project:app/api/core'],
      ]);
      assert.deepEqual([edgesOf(graph, 'local-package-dependency'), graph.unresolved], [[], []]);
    },
  },
  short_root_names: {
    says: [
      'The repository root `.` is one character long, so for a project below a top-level project whose root is also one character long (`a`), the two enclosing roots tie, and the tie goes to the root that sorts first by code unit.',
      '`a/b` therefore gets its `contains` edge from `.` and not from `a`, while `-/z` gets it from `-` (`-` sorts before `.`), and `child_project_roots` of `a` still lists `a/b`.',
      'Only the direct children of such a project are affected: every other enclosing root is a longer prefix of the child.',
    ],
    check({ graph }) {
      assert.deepEqual(rootsOf(graph), ['-', '-/z', '.', 'a', 'a/b', 'a/b/c', 'bb', 'bb/c']);
      // `a/b` hangs under `.` (a tie in length, and `.` sorts before `a`), `-/z` under `-` (it sorts before `.`),
      // `a/b/c` and `bb/c` under their longer parents.
      assert.deepEqual(edgesOf(graph, 'contains').map((e) => [e[1], e[2]]), [
        ['project:-', 'project:-/z'], ['project:.', 'project:-'], ['project:.', 'project:a'], ['project:.', 'project:a/b'],
        ['project:.', 'project:bb'], ['project:a/b', 'project:a/b/c'], ['project:bb', 'project:bb/c'],
      ]);
      assert.deepEqual(Object.fromEntries(graph.projects.map((p) => [p.root, p.children])), {
        '-': ['-/z'], '-/z': [], '.': ['-', 'a', 'bb'], a: ['a/b'], 'a/b': ['a/b/c'], 'a/b/c': [], bb: ['bb/c'], 'bb/c': [],
      });
    },
  },
  package_owners: {
    says: [
      'A self-match is skipped: a project that lists its own name keeps it in `dependency_names` and gets no edge, unless another project declares that name too: then the dependency is ambiguous like any other and the project itself is one of the candidates.',
      'The edges are built from the package name alone. A name that no project declares (an external package) makes no edge and no entry.',
      'A name that two or more projects declare is an `ambiguous-local-package-name` entry, listed in package-name order with the `project_ids` sorted by root, and every dependency on it is an `ambiguous-local-package-dependency` entry (`candidate_project_ids` sorted by root) and no edge.',
      'A project that lists a local name in two dependency fields gets one edge. A project may depend on the repository root project when that declares a name.',
      'with `dependency_name` and `evidence: [the declaring project\'s local_package.evidence]`',
    ],
    check({ graph, extra }) {
      // `app` lists `a-lib` in two fields (one edge), `top-pkg` (declared by the repository root) and `not-local` (declared nowhere).
      assert.deepEqual(project(graph, 'app').local_package.dependency_names, ['a-lib', 'not-local', 'top-pkg', 'z-lib']);
      assert.deepEqual(edgesOf(graph, 'local-package-dependency').map((e) => [e[1], e[2], e[3]]), [
        ['project:app', 'project:.', 'top-pkg'], ['project:app', 'project:packages/a-dir', 'z-lib'], ['project:app', 'project:packages/z-dir', 'a-lib'],
      ]);
      assert.deepEqual(extra.dependency_evidence, [
        ['project:app', 'project:.', ['app/package.json']], ['project:app', 'project:packages/a-dir', ['app/package.json']],
        ['project:app', 'project:packages/z-dir', ['app/package.json']],
      ]);
      assert.equal(extra.contains_evidence_is_empty, true);
      // The names with several owners come first, in package-name order; then each dependency on them, in root and name order.
      // `twin/one` lists its own name, which `twin/two` declares as well, so it is one of its own candidates.
      assert.deepEqual(graph.unresolved.map((u) => [u.kind, u.package_name, u.project_id ?? null, u.project_ids ?? u.candidate_project_ids]), [
        ['ambiguous-local-package-name', '@dup/a', null, ['project:dup/3', 'project:dup/4']],
        ['ambiguous-local-package-name', '@dup/z', null, ['project:dup/1', 'project:dup/2']],
        ['ambiguous-local-package-name', 'twin', null, ['project:twin/one', 'project:twin/two']],
        ['ambiguous-local-package-dependency', 'twin', 'project:twin/one', ['project:twin/one', 'project:twin/two']],
        ['ambiguous-local-package-dependency', '@dup/a', 'project:user', ['project:dup/3', 'project:dup/4']],
        ['ambiguous-local-package-dependency', '@dup/z', 'project:user', ['project:dup/1', 'project:dup/2']],
      ]);
    },
  },
};

// Values the builder copies without checking and the schema then rejects. The keyword each case must fail
// for is in the record (`option_cases.unchecked`); these entries hold what the RFC says about the value.
const UNCHECKED = {
  non_string_marker_kinds: {
    says: ["A truthy non-string (`42`, `{}`, `true`, `['x']`) is copied and the graph then fails the schema (`type`)."],
    check({ graph }) {
      assert.deepEqual(markersOf(graph), { '.': [], a: [42], b: [{}], c: [true], d: [['x']] });
      assert.deepEqual(graph.unresolved, []);
    },
  },
  non_string_adapter_fields: {
    says: ['A non-string `title`, `confidence` or `verificationBasis` is copied and the schema rejects the graph (`type`)'],
    check({ graph }) {
      assert.deepEqual(project(graph, 'app').http.candidates,
        [{ adapter_id: 'typed-http', capabilities: {}, confidence: 3, specificity: 0, title: 5, verification_basis: {} }]);
    },
  },
  empty_adapter_id: {
    says: ["an empty id is selected as `''` while `selection_reason` says `no-first-class-adapter` (its read set is never captured)"],
    check({ graph }) {
      const { http, kind, read_set: readSet } = project(graph, 'app');
      assert.deepEqual([http.selected, http.reason, http.candidates.map((c) => c.adapter_id), kind], ['', 'no-first-class-adapter', [''], 'unrecognized']);
      // The adapter lists a file that exists, and still no read set is captured (and nothing is reported).
      assert.deepEqual([readSet, graph.unresolved], [null, []]);
    },
  },
  numeric_adapter_id: {
    says: ['a number is copied'],
    check({ graph }) {
      const { http, kind } = project(graph, 'app');
      assert.deepEqual([http.selected, http.reason, http.candidates.map((c) => [c.adapter_id, c.title]), kind], [7, 'unique-highest-specificity', [[7, 7]], 'application']);
    },
  },
  missing_adapter_id: {
    says: ['an adapter with no `id` becomes a candidate without `adapter_id` that is never selected, although `selection_reason` says `no-first-class-adapter`'],
    check({ graph }) {
      const { http, kind } = project(graph, 'app');
      // The key is absent from the serialized graph; in memory it is present and `undefined`.
      assert.deepEqual(http.candidates, [{ capabilities: {}, confidence: 'unknown', specificity: 5, verification_basis: 'unknown' }]);
      assert.deepEqual([http.reason, 'selected' in http, kind], ['no-first-class-adapter', false, 'unrecognized']);
    },
  },
  duplicate_adapter_ids: {
    says: ['two adapters with one id can tie'],
    check({ graph }) {
      const { http, kind } = project(graph, 'app');
      assert.deepEqual([http.ambiguous, http.reason, http.selected, http.candidates.length, kind], [['twin-http', 'twin-http'], 'specificity-tie', null, 2, 'ambiguous']);
    },
  },
};

// Calls that throw. The class is always recorded; the message only where the builder wrote it, because the
// rest is Node's own text (RFC section 2.5). `null` means "not recorded".
const MALFORMED = {
  adapters_missing: ['TypeError', 'adapters must be an array'],
  adapters_not_an_array: ['TypeError', 'adapters must be an array'],
  adapters_with_null: ['TypeError', null],
  detect_throws_null: ['TypeError', null],
  detect_throws_undefined: ['TypeError', null],
  empty_repo_root: ['TypeError', 'repoRoot is required'],
  marker_rule_null: ['TypeError', null],
  marker_rule_throws: ['RangeError', 'rule failed'],
  marker_rule_without_test: ['TypeError', null],
  marker_rules_not_an_array: ['TypeError', null],
  marker_rules_null: ['TypeError', null],
  no_arguments: ['TypeError', 'repoRoot is required'],
  options_null: ['TypeError', null],
  plan_not_a_graph: ['TypeError', 'expected sbf.project-graph/draft-1'],
  plan_options_null: ['TypeError', null],
  registered_adapters_false: ['TypeError', 'adapters must be an array'],
  registered_options_null: ['TypeError', null],
  registered_plan_options_null: ['TypeError', null],
  repo_root_not_a_string: ['TypeError', null],
};
const MALFORMED_SAYS = [
  '`null` in place of the options object is a Node `TypeError` [probe: options `options_null`]',
  'so `false` fails with `adapters must be an array` [probe: options `registered_adapters_false`]',
  'A `null` in place of the options object is a Node `TypeError` for both functions [probe: options `registered_options_null`, `registered_plan_options_null`]',
  'a `null` rule and a rule without `test`: each is a Node `TypeError` as soon as the walk visits a regular file',
  'An error thrown by `test` passes through unchanged.',
  'That it is a string (`5` is a Node `TypeError`) or that it exists. An empty string, or no argument, is `repoRoot is required`.',
  '| The elements. `null` is a Node `TypeError`. An element without a `detect` function records `adapter-detect-error`',
  'A `detect` that throws `null` or `undefined` fails with a Node `TypeError`, because the builder reads `.message`',
  'Passing `null` instead of the options object fails with a Node `TypeError` (text not stable), and a first argument that is not a draft-1 graph fails with `TypeError: expected sbf.project-graph/draft-1`.',
  'Two failure messages of `buildProjectGraph` belong to the builder and are stable: `repoRoot is required` and `adapters must be an array` (`buildProjectScanPlan` adds a third, section 2.3).',
  'An error thrown by a function the caller supplied passes through unchanged.',
  'Every other failure in the table is a `TypeError` produced by Node, whose text is not stable and which the probe therefore records as a class only.',
];

describe('option cases (RFC section 2.5)', () => {
  const recorded = record.option_cases;
  const everyName = () => [...recorded.accepted, ...Object.keys(recorded.unchecked), ...recorded.malformed];
  const graphsOf = (group) => Object.fromEntries(Object.entries(options()[group]).map(([name, built]) => [name, built.graph]));

  it('the record, the cases module, the probe and the tables here list the same cases', () => {
    const printed = probeJson('options');
    const live = {
      accepted: sorted(Object.keys(options().accepted)),
      unchecked: sorted(Object.keys(options().unchecked)),
      malformed: sorted(Object.keys(malformedCalls())),
    };
    assert.deepEqual(optionCaseListProblems(recorded, live), []);
    assert.deepEqual(sorted(Object.keys(printed.accepted)), recorded.accepted);
    assert.deepEqual(sorted(Object.keys(printed.unchecked)), Object.keys(recorded.unchecked));
    assert.deepEqual(sorted(Object.keys(printed.malformed)), recorded.malformed);
    assert.deepEqual(sorted(Object.keys(ACCEPTED)), recorded.accepted);
    assert.deepEqual(sorted(Object.keys(UNCHECKED)), Object.keys(recorded.unchecked));
    assert.deepEqual(sorted(Object.keys(MALFORMED)), recorded.malformed);
  });

  it('every recorded case is tagged in the RFC, and every tag names a recorded case', () => {
    assert.deepEqual(optionTagProblems(rfc, everyName()), []);
  });

  for (const [name, entry] of Object.entries(ACCEPTED)) {
    it(`accepted: ${name}`, () => {
      assert.deepEqual(missingFragments(rfc, entry.says), [], 'statements the RFC no longer makes');
      const printed = probeJson('options').accepted[name];
      entry.check({ graph: printed.graph, extra: printed.extra });
    });
  }

  for (const [name, entry] of Object.entries(UNCHECKED)) {
    it(`unchecked: ${name} is copied and the schema rejects it`, () => {
      assert.deepEqual(missingFragments(rfc, entry.says), [], 'statements the RFC no longer makes');
      entry.check({ graph: probeJson('options').unchecked[name].graph });
      assert.ok(rfc.includes(`\`${recorded.unchecked[name]}\``), `the RFC does not name the keyword ${recorded.unchecked[name]}`);
    });
  }

  it('the RFC names the keyword of each adapter id case, in the order it names the cases', () => {
    const order = ['empty_adapter_id', 'numeric_adapter_id', 'duplicate_adapter_ids', 'missing_adapter_id'];
    const keywords = order.map((name) => `\`${recorded.unchecked[name]}\``).join(', ');
    assert.deepEqual(missingFragments(rfc, [`The schema rejects those four (${keywords})`]), []);
  });

  it('the schema accepts every accepted graph, live and after a JSON round trip', () => {
    const live = graphsOf('accepted');
    assert.deepEqual(acceptanceProblems(validate, live), []);
    assert.deepEqual(acceptanceProblems(validate, clone(live)), []);
  });

  it('the schema rejects every unchecked graph for the recorded keyword, live and after a JSON round trip', () => {
    const live = graphsOf('unchecked');
    assert.deepEqual(rejectionProblems(validate, live, recorded.unchecked), []);
    assert.deepEqual(rejectionProblems(validate, clone(live), recorded.unchecked), []);
  });

  it('malformed calls throw the recorded class, and the recorded message where the builder wrote it', () => {
    const printed = probeJson('options').malformed;
    for (const [name, [errorClass, message]] of Object.entries(MALFORMED)) {
      assert.deepEqual([printed[name].threw, printed[name].error, printed[name].message], [true, errorClass, message], name);
    }
    assert.deepEqual(missingFragments(rfc, MALFORMED_SAYS), [], 'statements the RFC no longer makes');
  });

  it('a marker rule gets one argument, the base name of each regular file the walk visits', () => {
    const { extra } = options().accepted.custom_marker_kinds;
    assert.deepEqual(markerArgumentProblems(extra.regular_files, extra.test_arguments), []);
    // The last rule matches nothing, so it is asked about the two files that no rule above it matches.
    assert.deepEqual(extra.last_rule_arguments, [['inner.txt'], ['package.json']]);
    assert.deepEqual(missingFragments(rfc, [
      'Each rule\'s `test(name)` gets one argument, the file\'s base name, once per regular file visited, unless an earlier rule has already matched that file (not for a symbolic link, not below a hard-ignored directory of section 5.2)',
    ]), []);
  });

  it('section 4 lists the base names the nine default rules match and do not match', () => {
    const { marker_kind_by_file_name: byName } = probeJson('options').accepted.default_markers.extra;
    assert.deepEqual(defaultMarkerProblems(rfc, byName), []);
  });
});

// The helper exports of RFC section 2.1, called directly with the values the RFC names.
describe('helper functions (RFC section 2.1)', () => {
  const { captureAdapterReadSetSnapshot, inferDetectionProjectRoot, portableProjectDiagnosticMessage, projectGraphExecutionRoot } = indexModule;
  const { portableRegistryLoadErrors } = registeredModule;
  const { PROJECT_SOURCE_ROLES, classifyProjectSourceRole, groupProjectSourcesByRole } = sourceRoleModule;
  const outcome = (fn) => {
    try {
      fn();
    } catch (err) {
      return [err.constructor.name, err.code ?? null];
    }
    return ['returned', null];
  };

  it('inferDetectionProjectRoot takes the shapes the RFC lists and gives null for the rest', () => {
    assert.deepEqual(missingFragments(rfc, [
      'a non-empty string (resolved; a trailing `src/main/java` is stripped, so `/src/main/java` gives `/`)',
      'an object whose `projectRoot` is a non-empty string (resolved only, never stripped)',
      'else an object whose `srcRoot` is a non-empty string (resolved and stripped like a string)',
      'A relative string resolves against the process working directory, not the repository.',
      "Anything else (`true`, `''`, `0`, `NaN`, `{}`, an array, a Promise, a function, an object with neither key as a non-empty string) gives `null`.",
    ]), []);
    const app = path.resolve('/srv/app');
    const java = path.join(app, 'src', 'main', 'java');
    assert.equal(inferDetectionProjectRoot(app), app);
    assert.equal(inferDetectionProjectRoot(java), app);
    assert.equal(inferDetectionProjectRoot({ projectRoot: java }), java);
    assert.equal(inferDetectionProjectRoot({ srcRoot: java }), app);
    assert.equal(inferDetectionProjectRoot({ projectRoot: '', srcRoot: java }), app);
    assert.equal(inferDetectionProjectRoot({ projectRoot: app, srcRoot: path.resolve('/srv/other') }), app);
    assert.equal(inferDetectionProjectRoot('relative/dir'), path.resolve('relative/dir'));
    assert.equal(inferDetectionProjectRoot({ projectRoot: 'relative/dir' }), path.resolve('relative/dir'));
    assert.equal(inferDetectionProjectRoot({ srcRoot: 'relative/src/main/java' }), path.resolve('relative'));
    // A `srcRoot` that is not a Java source root is resolved too, and stays when it is absolute already.
    assert.equal(inferDetectionProjectRoot({ srcRoot: 'relative/dir' }), path.resolve('relative/dir'));
    assert.equal(inferDetectionProjectRoot({ srcRoot: app }), app);
    assert.equal(inferDetectionProjectRoot({ projectRoot: 5, srcRoot: java }), app);
    // Only the last three segments, spelled exactly, are stripped; the path is resolved first.
    assert.equal(inferDetectionProjectRoot(`${java}/`), app);
    assert.equal(inferDetectionProjectRoot(`${app}/x/../src/main/java`), app);
    for (const kept of ['src/main/javax', 'SRC/main/java', 'src/main', 'src/main/java/com', 'main/java']) {
      assert.equal(inferDetectionProjectRoot(path.join(app, kept)), path.join(app, kept), kept);
    }
    // Stripping all of the path leaves the file-system root, not an empty string.
    assert.equal(inferDetectionProjectRoot(path.resolve('/src/main/java')), path.parse(path.resolve('/')).root);
    const withRoot = Object.assign(() => app, { projectRoot: app, srcRoot: app });
    const nothing = [true, false, '', 0, NaN, 5, {}, [], ['/srv/app'], Promise.resolve(), { projectRoot: 5 }, { srcRoot: '' }, null, undefined, () => app, withRoot];
    assert.deepEqual(nothing.map((value) => inferDetectionProjectRoot(value)), nothing.map(() => null));
  });

  it('captureAdapterReadSetSnapshot returns what the RFC says and throws what it lists', () => {
    assert.deepEqual(missingFragments(rfc, [
      '`null` when the adapter has no `listReadSet`; else `{adapter_id, files[{path, digest, role}], fingerprint}`.',
      'Throws `TypeError` (a falsy `repoRoot`, `projectRoot` or `adapter`, a result that is not an array, or an invalid entry), `PROJECT_READ_SET_ESCAPE` (an entry leaves the project, or the project leaves the repository) or the file-system error of an unreadable file',
    ]), []);
    const repo = fixture({ 'app/src/a.js': 'A', 'app/src/b.js': 'B', 'app/vendor/v.js': 'V', 'app/Tests/t.js': 'T', 'other/x.js': 'X' });
    const project = path.join(repo, 'app');
    const capture = (listReadSet, more = {}) => captureAdapterReadSetSnapshot({
      repoRoot: repo, projectRoot: project, adapter: { id: 'snap-http', ...(listReadSet ? { listReadSet } : {}) }, ...more,
    });
    assert.equal(capture(null), null);
    assert.equal(captureAdapterReadSetSnapshot({ repoRoot: repo, projectRoot: project, adapter: { id: 'x', listReadSet: 'not a function' } }), null);

    // Sorted by repo-relative path, each file once, the role judged from the path below the project.
    const snapshot = capture(() => ['src/b.js', 'src/a.js', './src/a.js', 'src/../src/a.js', 'vendor/v.js', 'Tests/t.js']);
    const digest = (text) => `sha256:${sha256(text)}`;
    const files = [
      { path: 'app/Tests/t.js', digest: digest('T'), role: 'reference' },
      { path: 'app/src/a.js', digest: digest('A'), role: 'active' },
      { path: 'app/src/b.js', digest: digest('B'), role: 'active' },
      { path: 'app/vendor/v.js', digest: digest('V'), role: 'vendor' },
    ];
    const fingerprint = `sha256:${sha256(files.map((f) => `${f.path}\0${f.digest}\0${f.role}\0`).join(''))}`;
    assert.deepEqual(snapshot, { adapter_id: 'snap-http', files, fingerprint });
    assert.deepEqual(capture(() => []), { adapter_id: 'snap-http', files: [], fingerprint: `sha256:${sha256('')}` });

    // Each of the three is required and tested for truthiness only: every falsy value is the same TypeError.
    for (const key of ['repoRoot', 'projectRoot', 'adapter']) {
      for (const falsy of ['', 0, null, undefined, false]) {
        assert.deepEqual(outcome(() => capture(() => [], { [key]: falsy })), ['TypeError', null], `${key}: ${String(falsy)}`);
      }
    }
    assert.deepEqual(outcome(() => capture(() => 'src/a.js')), ['TypeError', null]);
    assert.deepEqual(outcome(() => capture(() => [''])), ['TypeError', null]);
    assert.deepEqual(outcome(() => capture(() => [5])), ['TypeError', null]);
    assert.deepEqual(outcome(() => capture(() => ['../other/x.js'])), ['Error', 'PROJECT_READ_SET_ESCAPE']);
    const wider = { repoRoot: project, projectRoot: repo, adapter: { id: 'x', listReadSet: () => ['other/x.js'] } };
    assert.deepEqual(outcome(() => captureAdapterReadSetSnapshot(wider)), ['Error', 'PROJECT_READ_SET_ESCAPE']);
    assert.deepEqual(outcome(() => capture(() => ['src/missing.js'])), ['Error', 'ENOENT']);
    assert.deepEqual(outcome(() => capture(() => ['src'])), ['Error', 'EISDIR']);
  });

  it('buildProjectScanPlan reads six fields of each project and makes three checks on the graph', () => {
    assert.deepEqual(missingFragments(rfc, [
      'The plan reads six fields of each project: `project_id`, `root`, `project_role`, `kind`, `fallback_adapter` and `facets.http.selected_adapter`. It does not depend on the order of `projects`. A project without `facets` has no selected adapter, and a project without `project_role` is not `active`.',
      'The only checks on the graph are that it is truthy, that its `schema` is `sbf.project-graph/draft-1` and that `projects` is an array: a graph with no `projects`, or with `projects` that is not an array, fails with the same `TypeError`, and the entries are not checked (`{}` is a project that is skipped, `null` is a Node `TypeError`).',
      'Items are not de-duplicated, so two projects with the same `root` give two items, ordered by `adapter_id`.',
      'Rule 4 holds for the graphs the builder produces, where an `ambiguous` project has no `fallback_adapter`, and not for every graph the plan accepts: a hand-built `ambiguous` project that carries a `fallback_adapter` gets a `fallback` item.',
    ]), []);
    const { buildProjectScanPlan } = indexModule;
    const schemaName = record.literals.graph_schema;
    const item = (project_id, project_root, adapter_id, mode) => ({ project_id, project_root, adapter_id, mode });
    const http = (selected_adapter) => ({ http: { selected_adapter } });
    const projects = [
      { project_id: 'z', root: 'z', project_role: 'active', kind: 'application', facets: http('z-http'), fallback_adapter: 'grep' },
      { project_id: 'a', root: 'a', project_role: 'active', kind: 'unrecognized', facets: http(null), fallback_adapter: 'grep' },
      { project_id: 'm', root: 'm', project_role: 'active', kind: 'unrecognized', fallback_adapter: 'grep' },
      { project_id: 'n', root: 'n', kind: 'application', facets: http('n-http'), fallback_adapter: 'grep' },
      { project_id: 'x', root: 'x', project_role: 'active', kind: 'aggregate', facets: http(null), fallback_adapter: 'grep' },
      { project_id: 'dup', root: 'd', project_role: 'active', kind: 'application', facets: http('b-http') },
      { project_id: 'dup2', root: 'd', project_role: 'active', kind: 'application', facets: http('a-http') },
    ];
    const first = {
      dup2: item('dup2', 'd', 'a-http', 'first-class'), dup: item('dup', 'd', 'b-http', 'first-class'),
      z: item('z', 'z', 'z-http', 'first-class'), n: item('n', 'n', 'n-http', 'first-class'),
    };
    const fallbackItem = (id) => item(id, id, 'grep', 'fallback');
    const expected = [
      [{}, [first.dup2, first.dup, first.z]],
      [{ includeFallback: true }, [fallbackItem('a'), first.dup2, first.dup, fallbackItem('m'), first.z]],
      [{ includeNonActive: true }, [first.dup2, first.dup, first.n, first.z]],
      [{ includeFallback: true, includeNonActive: true }, [fallbackItem('a'), first.dup2, first.dup, fallbackItem('m'), first.n, first.z]],
    ];
    for (const [flags, items] of expected) {
      assert.deepEqual(buildProjectScanPlan({ schema: schemaName, projects }, flags), items, JSON.stringify(flags));
      assert.deepEqual(buildProjectScanPlan({ schema: schemaName, projects: [...projects].reverse() }, flags), items, `reversed ${JSON.stringify(flags)}`);
    }
    // The graph is not read for anything else, and not changed.
    const copy = clone(projects);
    buildProjectScanPlan({ schema: schemaName, projects, extra: 1 }, { includeFallback: true, includeNonActive: true });
    assert.deepEqual(projects, copy);

    const refused = [undefined, null, '', 0, false, 'x', [], {}, { schema: schemaName }, { projects: [] }, { schema: 'sbf.project-graph/draft-2', projects: [] },
      { schema: schemaName, projects: null }, { schema: schemaName, projects: {} }, { schema: schemaName, projects: 'x' }];
    for (const bad of refused) {
      assert.throws(() => buildProjectScanPlan(bad), { name: 'TypeError', message: 'expected sbf.project-graph/draft-1' }, JSON.stringify(bad));
    }
    assert.deepEqual(buildProjectScanPlan({ schema: schemaName, projects: [] }), []);
    for (const flags of [{}, { includeFallback: true }, { includeNonActive: true }, { includeFallback: true, includeNonActive: true }]) {
      assert.deepEqual(buildProjectScanPlan({ schema: schemaName, projects: [{}] }, flags), [], JSON.stringify(flags));
    }
    assert.deepEqual(outcome(() => buildProjectScanPlan({ schema: schemaName, projects: [null] })), ['TypeError', null]);

    // Rule 4 comes from the builder: its ambiguous project has no fallback adapter, a hand-built one may have.
    const ambiguous = graphs().specificity_tie.projects.find((p) => p.kind === 'ambiguous');
    assert.equal(ambiguous.fallback_adapter ?? null, null);
    assert.deepEqual(buildProjectScanPlan({ schema: schemaName, projects: [ambiguous] }, { includeFallback: true }), []);
    assert.deepEqual(
      buildProjectScanPlan({ schema: schemaName, projects: [{ ...ambiguous, fallback_adapter: 'grep' }] }, { includeFallback: true }),
      [item(ambiguous.project_id, ambiguous.root, 'grep', 'fallback')],
    );
  });

  it('the registered builders default to the registry, and any other adapters value goes to the builder', () => {
    assert.deepEqual(missingFragments(rfc, [
      "`adapters` defaults to the registry's `ADAPTERS` when it is omitted, `undefined` or `null`, and any other value goes to the builder, so `false` fails with `adapters must be an array`",
      'the same graph plus `registry_load_errors`; the plan variant returns `{graph, plan}`',
    ]), []);
    const { buildRegisteredProjectGraph, buildRegisteredProjectScanPlan } = registeredModule;
    const repo = fixture({ 'a/package.json': '{}', 'b/pom.xml': '' });
    const byDefault = canon(buildRegisteredProjectGraph(repo));
    for (const given of [{}, { adapters: undefined }, { adapters: null }, { adapters: ADAPTERS }]) {
      assert.deepEqual(canon(buildRegisteredProjectGraph(repo, given)), byDefault, JSON.stringify(given));
    }
    assert.deepEqual(byDefault.registry_load_errors, portableRegistryLoadErrors(LOAD_ERRORS));
    // An empty list is a list: nobody is asked, so no project has a selected adapter or a fallback.
    const none = buildRegisteredProjectGraph(repo, { adapters: [] });
    assert.deepEqual(none.projects.map((p) => [p.facets.http.selected_adapter, p.fallback_adapter ?? null]), none.projects.map(() => [null, null]));
    const { registry_load_errors: loadErrors, ...withoutErrors } = none;
    assert.deepEqual(loadErrors, portableRegistryLoadErrors(LOAD_ERRORS));
    assert.deepEqual(canon(withoutErrors), canon(indexModule.buildProjectGraph({ repoRoot: repo, adapters: [] })));
    for (const bad of [false, 0, '', 'x', {}]) {
      assert.throws(() => buildRegisteredProjectGraph(repo, { adapters: bad }), { name: 'TypeError', message: 'adapters must be an array' }, String(bad));
    }
    const planned = buildRegisteredProjectScanPlan(repo);
    assert.deepEqual(Object.keys(planned), ['graph', 'plan']);
    assert.deepEqual(canon(planned.graph), byDefault);
    assert.deepEqual(planned.plan, indexModule.buildProjectScanPlan(planned.graph));
  });

  it('the registry load errors reach the registered graph and plan in their portable form', () => {
    assert.deepEqual(missingFragments(rfc, [
      "registered builder only: `{file, message}` with the adapter file's base name and `<adapter-dir>` in messages",
    ]), []);
    const { buildRegisteredProjectGraph, buildRegisteredProjectScanPlan } = registeredModule;
    const repo = fixture({ 'a/package.json': '{}' });
    const dir = path.resolve('/srv/adapters');
    // The registry in this checkout loads cleanly, so two failures are added for the length of the test.
    const before = LOAD_ERRORS.length;
    LOAD_ERRORS.push(
      { file: path.join(dir, 'zeta.mjs'), message: `failed to load: ${dir}/zeta.mjs (in ${dir})` },
      { file: path.join(dir, 'alpha.mjs'), message: 'must export an adapter' },
    );
    try {
      const expected = portableRegistryLoadErrors(LOAD_ERRORS);
      const own = (errors) => errors.filter((e) => e.file === 'alpha.mjs' || e.file === 'zeta.mjs');
      const ownExpected = [
        { file: 'alpha.mjs', message: 'must export an adapter' },
        { file: 'zeta.mjs', message: 'failed to load: <adapter-dir>/zeta.mjs (in <adapter-dir>)' },
      ];
      const graph = buildRegisteredProjectGraph(repo, { adapters: [] });
      const planned = buildRegisteredProjectScanPlan(repo, { adapters: [] }).graph;
      for (const built of [graph, planned]) {
        assert.deepEqual(built.registry_load_errors, expected);
        assert.deepEqual(own(built.registry_load_errors), ownExpected);
        assert.equal(JSON.stringify(built.registry_load_errors).includes(dir), false);
      }
      // The graph holds its own list, not the registry's.
      assert.notEqual(graph.registry_load_errors, LOAD_ERRORS);
    } finally {
      LOAD_ERRORS.length = before;
    }
  });

  it('portableProjectDiagnosticMessage and portableRegistryLoadErrors make messages repository independent', () => {
    assert.deepEqual(missingFragments(rfc, [
      'text with every occurrence of the absolute repo (or adapter) directory replaced by `<repo>` (or `<adapter-dir>`) and backslashes turned into `/`.',
      "A `null` or `undefined` message gives `''`, and without a `repoRoot` only the backslashes change.",
      'A directory in a Windows-style `file` (`C:\\x\\y.mjs`) is replaced whether `message` spells it with backslashes or with `/`.',
      "`portableRegistryLoadErrors` throws a `TypeError` for a non-array, and returns `{file, message}` sorted by `file`, then `message`, with the base name of `file` (`(unknown)` when it is missing, empty or not a string, and `''` when it ends in a separator; a leading separator is cut as well, so `/x.mjs` gives `x.mjs`), and the text of `message` (`''` for a missing one, `5` for the number 5)",
    ]), []);
    const repo = path.resolve('/srv/repo');
    const portable = portableProjectDiagnosticMessage;
    assert.equal(portable(`cannot read ${repo}/a/b.json and ${repo}`, repo), 'cannot read <repo>/a/b.json and <repo>');
    assert.equal(portable(`cannot read ${repo}/a`, `${repo}/`), 'cannot read <repo>/a');
    assert.equal(portable('C:\\x\\y', repo), 'C:/x/y');
    assert.equal(portable(`C:\\x\\y ${repo}/z`), `C:/x/y ${repo}/z`);
    assert.deepEqual([portable(null, repo), portable(undefined, repo), portable(null), portable(undefined)], ['', '', '', '']);
    assert.deepEqual([portable(5, repo), portable(5)], ['5', '5']);
    // A relative repository path is resolved against the working directory first.
    assert.equal(portable(`at ${path.resolve('some/repo')}/x`, 'some/repo'), 'at <repo>/x');

    // Not an array means not an array, whatever else the value offers (a `map` method, typed-array elements).
    for (const notAnArray of ['not an array', 5, null, undefined, {}, new Set(), { map: () => [] }, new Uint8Array(2)]) {
      assert.deepEqual(outcome(() => portableRegistryLoadErrors(notAnArray)), ['TypeError', null], String(notAnArray));
    }
    // A Windows-style file: the directory goes in both spellings, every time it occurs.
    assert.deepEqual(portableRegistryLoadErrors([
      { file: 'C:\\x\\y.mjs', message: 'C:\\x and C:\\x\\y.mjs, then C:/x/y.mjs and C:/x' },
    ]), [
      { file: 'y.mjs', message: '<adapter-dir> and <adapter-dir>/y.mjs, then <adapter-dir>/y.mjs and <adapter-dir>' },
    ]);
    assert.deepEqual(portableRegistryLoadErrors([
      { file: '/a/b/zeta.mjs', message: 'bad /a/b/zeta.mjs here' },
      { file: '/a/b/alpha.mjs', message: 'z /a/b' },
      { file: '/a/b/alpha.mjs', message: 'a /a/b' },
      { message: 'no file' },
      { file: '', message: 'empty' },
      { file: 'C:\\x\\y.mjs', message: 'C:\\x\\y.mjs failed' },
      { file: '/a/b/', message: 'dir /a/b/' },
      null,
    ]), [
      { file: '', message: 'dir <adapter-dir>/' },
      { file: '(unknown)', message: '' },
      { file: '(unknown)', message: 'empty' },
      { file: '(unknown)', message: 'no file' },
      { file: 'alpha.mjs', message: 'a <adapter-dir>' },
      { file: 'alpha.mjs', message: 'z <adapter-dir>' },
      { file: 'y.mjs', message: '<adapter-dir>/y.mjs failed' },
      { file: 'zeta.mjs', message: 'bad <adapter-dir>/zeta.mjs here' },
    ]);
    // Every occurrence of the directory goes; a file that is not a string is unknown, a number is text.
    assert.deepEqual(portableRegistryLoadErrors([
      { file: 5, message: 'num file' },
      { file: {}, message: 'object file' },
      { file: '/top.mjs', message: 'at top' },
      { file: '/a/b/x.mjs', message: 'dir /a/b and /a/b again /a/b/x.mjs' },
      { file: '\\win\\q.mjs', message: 5 },
      { file: '/a/b/y.mjs' },
      { file: 'noslash.mjs', message: 'plain' },
    ]), [
      { file: '(unknown)', message: 'num file' },
      { file: '(unknown)', message: 'object file' },
      { file: 'noslash.mjs', message: 'plain' },
      { file: 'q.mjs', message: '5' },
      { file: 'top.mjs', message: 'at top' },
      { file: 'x.mjs', message: 'dir <adapter-dir> and <adapter-dir> again <adapter-dir>/x.mjs' },
      { file: 'y.mjs', message: '' },
    ]);
    assert.deepEqual(portableRegistryLoadErrors([]), []);
  });

  it('classifyProjectSourceRole and groupProjectSourcesByRole give a role name or a map over all five roles', () => {
    assert.deepEqual(missingFragments(rfc, [
      'a role name, or a `{role: paths[]}` map covering all five roles, each list sorted (duplicates are kept), and the array that is given is left as it was.',
      'A path that is not a non-empty string (a `String` object is not one), or a non-array given to the grouping, is a `TypeError`.',
      'A non-empty path that holds no name (`/`, `./`) is `active`. Doubled and trailing separators are skipped, so `docs/page.tmpl/` is judged by its name `page.tmpl` and is template',
    ]), []);
    assert.deepEqual(sorted(PROJECT_SOURCE_ROLES), record.literals.source_roles);
    const given = ['b/vendor/x', 'a/src/y', 'a/Src/z', 'docs/a.hbs', 'tests/t', 'dist/d', 'a/src/y'];
    const grouped = groupProjectSourcesByRole(given);
    assert.deepEqual(given, ['b/vendor/x', 'a/src/y', 'a/Src/z', 'docs/a.hbs', 'tests/t', 'dist/d', 'a/src/y']);
    assert.deepEqual(Object.keys(grouped), [...PROJECT_SOURCE_ROLES]);
    assert.deepEqual(grouped, {
      active: ['a/Src/z', 'a/src/y', 'a/src/y'], reference: ['tests/t'], generated: ['dist/d'], vendor: ['b/vendor/x'], template: ['docs/a.hbs'],
    });
    assert.deepEqual(groupProjectSourcesByRole([]), { active: [], reference: [], generated: [], vendor: [], template: [] });
    for (const bad of ['', 5, null, undefined, [], {}, ['vendor/x'], new String('vendor/x')]) {
      assert.deepEqual(outcome(() => classifyProjectSourceRole(bad)), ['TypeError', null], String(bad));
    }
    for (const bad of ['x', null, undefined, {}]) assert.deepEqual(outcome(() => groupProjectSourcesByRole(bad)), ['TypeError', null], String(bad));
    assert.deepEqual(outcome(() => groupProjectSourcesByRole(['a', ''])), ['TypeError', null]);
    // A path with no name in it is active.
    assert.deepEqual(['/', './', '//', 'a//b', 'a/./b'].map((p) => classifyProjectSourceRole(p)), ['active', 'active', 'active', 'active', 'active']);
    // Doubled and trailing separators are skipped: the name is the last segment that holds something.
    assert.deepEqual(['docs/page.tmpl/', 'docs//page.hbs', 'docs\\page.mustache\\', 'x/vendor//y', 'docs/page.template//'].map((p) => classifyProjectSourceRole(p)),
      ['template', 'template', 'template', 'vendor', 'template']);
  });

  it('every recorded segment name gives its role, in any letter case and at any place in the path', () => {
    const sets = {
      vendor: record.literals.vendor_segments, reference: record.literals.reference_segments,
      generated: record.literals.generated_segments, template: record.literals.template_segments,
    };
    // The RFC lists the names of each role, in the order of the record.
    assert.deepEqual(missingFragments(rfc, [
      ...Object.entries(sets).map(([role, names]) => `${role} ${names.map((name) => `\`${name}\``).join(', ')}`),
      'Any other segment gives `active`, and the file name counts as a segment, so `src/tests` is reference.',
      'Role precedence is vendor, then reference, then generated, then template, then active, matched on whole path segments (case-insensitive), never on substrings; a `.tmpl`, `.template`, `.mustache` or `.hbs` file name also means template.',
      'The extension needs its dot and ignores letter case: `.mustache` and `page.HBS` are template, `pagehbs` is active.',
    ]), []);
    for (const [role, names] of Object.entries(sets)) {
      for (const name of names) {
        for (const shape of [`${name}/x.js`, `src/${name}/x.js`, `src/${name}`, `src/${name.toUpperCase()}/x.js`, `src\\${name}\\x.js`, `./${name}/x.js`]) {
          assert.equal(classifyProjectSourceRole(shape), role, shape);
        }
        // A name inside a longer segment is not the name: only whole segments count.
        for (const shape of [`${name}-x/y.js`, `x-${name}/y.js`, `src/${name}.js`]) {
          assert.equal(classifyProjectSourceRole(shape), 'active', shape);
        }
      }
    }
    // The precedence is vendor, reference, generated, template, whichever segment comes first in the path.
    const order = ['vendor', 'reference', 'generated', 'template'];
    for (const [i, high] of order.entries()) {
      for (const low of order.slice(i + 1)) {
        assert.equal(classifyProjectSourceRole(`${sets[high][0]}/${sets[low][0]}/x.js`), high, `${high} over ${low}`);
        assert.equal(classifyProjectSourceRole(`${sets[low][0]}/${sets[high][0]}/x.js`), high, `${high} over ${low}, reversed`);
      }
      assert.equal(classifyProjectSourceRole(`${sets[high][0]}/src/x.js`), high);
    }
    assert.equal(classifyProjectSourceRole('src/app.js'), 'active');
    // The four template extensions, in any letter case, on the last segment only, and only with their dot.
    for (const extension of ['tmpl', 'template', 'mustache', 'hbs']) {
      for (const spelled of [extension, extension.toUpperCase(), extension[0].toUpperCase() + extension.slice(1)]) {
        assert.equal(classifyProjectSourceRole(`src/page.${spelled}`), 'template', spelled);
        assert.equal(classifyProjectSourceRole(`page.${spelled}`), 'template', spelled);
        assert.equal(classifyProjectSourceRole(`.${spelled}`), 'template', spelled);
        assert.equal(classifyProjectSourceRole(`src/page${spelled}`), 'active', spelled);
        assert.equal(classifyProjectSourceRole(`src/page.${spelled}.bak`), 'active', spelled);
        assert.equal(classifyProjectSourceRole(`src/page.${spelled}/x.js`), 'active', spelled);
      }
    }
    assert.equal(classifyProjectSourceRole('vendor/page.hbs'), 'vendor');
    assert.equal(classifyProjectSourceRole('dist/page.hbs'), 'generated');
    assert.equal(classifyProjectSourceRole('tests/page.hbs'), 'reference');
  });

  it('the execution root is a non-enumerable Symbol key that JSON serialization drops', () => {
    assert.deepEqual(missingFragments(rfc, [
      'The absolute root lives under the non-enumerable `PROJECT_GRAPH_EXECUTION_ROOT` symbol and disappears on JSON serialization',
      'The property is read-only and not configurable (`writable` and `configurable` are `false`)',
    ]), []);
    const { root, graph } = options().accepted.empty_repository;
    assert.equal(typeof indexModule.PROJECT_GRAPH_EXECUTION_ROOT, 'symbol');
    assert.equal(indexModule.PROJECT_GRAPH_DRAFT, record.literals.graph_schema);
    assert.equal(projectGraphExecutionRoot(graph), path.resolve(root));
    const descriptor = Object.getOwnPropertyDescriptor(graph, indexModule.PROJECT_GRAPH_EXECUTION_ROOT);
    assert.deepEqual([descriptor.enumerable, descriptor.writable, descriptor.configurable], [false, false, false]);
    assert.equal(descriptor.value, path.resolve(root));
    assert.equal(projectGraphExecutionRoot(clone(graph)), null);
    assert.equal(graph.repo_root, '.');
  });

  it('capabilities are copied one level deep, so nested objects stay the adapter\'s own', () => {
    assert.deepEqual(missingFragments(rfc, ['`capabilities` is copied one level deep with an object spread']), []);
    const nested = { depth: 1 };
    const capabilities = { http: true, nested };
    const repo = fixture({ 'app/package.json': '{}' });
    const detect = (dir) => (path.basename(dir) === 'app' ? dir : null);
    const graph = indexModule.buildProjectGraph({ repoRoot: repo, adapters: [{ id: 'cap-http', specificity: 5, capabilities, detect }] });
    const copy = graph.projects.find((p) => p.root === 'app').facets.http.candidates[0].capabilities;
    assert.notEqual(copy, capabilities);
    assert.equal(copy.nested, nested);
  });
});

describe('RFC tables against the schema, the record and the probes', () => {
  const unresolvedRows = () => tableRows(sectionLines(rfc, '### 5.1'));

  it('5.1 lists exactly the unresolved kinds, with the fields the schema requires', () => {
    const rows = unresolvedRows();
    assert.deepEqual(sorted(rows.map((row) => ticks(row[0]))), record.literals.unresolved_kinds);
    const fields = schemaUnresolvedFields(schema);
    for (const row of rows) {
      const named = [...row[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
      assert.deepEqual(named, fields[ticks(row[0])], ticks(row[0]));
    }
  });

  it('5.1 tags: a probe-tagged kind comes from every named case, a source-tagged kind from no probe case', () => {
    const kindsOfCases = (cases) => Object.fromEntries(Object.entries(cases).filter(([, v]) => v.graph)
      .map(([name, v]) => [name, v.graph.unresolved.map((u) => u.kind)]));
    const printed = probeJson('options');
    const produced = {
      negative: kindsOfCases(probeJson('negative')),
      options: kindsOfCases({ ...printed.accepted, ...printed.unchecked }),
    };
    assert.deepEqual(sorted(Object.keys(produced.negative)), record.negative_cases);
    const rows = unresolvedRows().map((row) => ({ kind: ticks(row[0]), tag: row[row.length - 1].replace(/\s+/g, ' ') }));
    assert.deepEqual(kindTagProblems(rows, produced), []);
  });

  it('5.3 maps each probe key to the recorded code and lists every error code', () => {
    const rows = tableRows(sectionLines(rfc, '### 5.3'));
    const codeOf = (row) => ticks(row[0]).match(/^PROJECT_[A-Z_]+/)?.[0];
    const mapping = {};
    for (const row of rows) {
      assert.ok(codeOf(row), `row does not start with an error code: ${row[0]}`);
      for (const m of row[row.length - 1].matchAll(/`([a-z_]+)`/g)) mapping[m[1]] = codeOf(row);
    }
    assert.deepEqual(mapping, record.shadow_failures);
    assert.deepEqual(sorted([...new Set(rows.map(codeOf)), 'PROJECT_READ_SET_ESCAPE']), record.literals.error_codes);
  });

  it('5.3 lists the fields each failure carries, and says which rows are read-set rows', () => {
    const { failures } = probeJson('shadow');
    const carried = (f) => [
      ...(f.project_id !== null ? ['project_id'] : []),
      ...(f.marker_path !== null ? ['marker_path'] : []),
      ...(f.adapter_id !== null ? ['adapter_id'] : []),
      ...(f.cause !== null ? ['cause'] : []),
      ...(f.digest_changed !== null ? ['expected_digest', 'actual_digest'] : []),
      ...(f.fingerprint_changed !== null ? ['expected_fingerprint', 'actual_fingerprint'] : []),
      ...(f.files !== null ? ['expected_files', 'actual_files'] : []),
    ].sort();
    let checked = 0;
    for (const row of tableRows(sectionLines(rfc, '### 5.3'))) {
      const listed = row[2] === 'none' ? [] : [...row[2].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
      const staleKind = row[0].includes('`stale_kind: adapter-read-set`') ? 'adapter-read-set' : null;
      for (const m of row[row.length - 1].matchAll(/`([a-z_]+)`/g)) {
        assert.deepEqual(carried(failures[m[1]]), listed, m[1]);
        assert.equal(failures[m[1]].stale_kind, staleKind, m[1]);
        checked += 1;
      }
    }
    assert.equal(checked, Object.keys(record.shadow_failures).length);
  });

  it('7.3 names only probe fields that exist, and lists every shadow failure key', () => {
    let fields = 0;
    let failureRows = 0;
    for (const row of tableRows(sectionLines(rfc, '### 7.3'))) {
      const named = row[1].match(/^probe `(\w+)` field (.+)$/);
      if (!named) continue;
      const names = [...named[2].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
      for (const name of names) {
        assert.ok(name in probeJson(named[1]), `probe ${named[1]} prints no field ${name}`);
        fields += 1;
      }
      if (names.includes('failures')) {
        failureRows += 1;
        assert.deepEqual([...row[2].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort(), sorted(Object.keys(record.shadow_failures)));
      }
    }
    assert.deepEqual([fields, failureRows], [5, 1]);
  });
});

describe('file ownership', () => {
  it('section 6 gives T02 edit rights over its own two directories and nothing else', () => {
    const editing = tableRows(sectionLines(rfc, '## 6.')).filter((row) => /^edits\b/.test(row[2]));
    assert.equal(editing.length, 1);
    assert.deepEqual([ticks(editing[0][0]), editing[0][1]], ['scanners/project-graph/**, test/project-graph/**', 'T02']);
  });

  it('every file the record lists is inside those two directories', () => {
    for (const rel of record.owned_files) {
      assert.ok(rel.startsWith('scanners/project-graph/') || rel.startsWith('test/project-graph/'), rel);
    }
  });

  it('the schema directory holds the draft schema and nothing else', () => {
    assert.deepEqual(fs.readdirSync(path.join(ROOT, 'scanners/project-graph/schemas')), ['project-graph.draft-1.schema.json']);
  });

  it('the nested runner maps T02 to the same two directories', () => {
    const row = read('scripts/run-next-nested-tests.mjs').match(/id:\s*'T02'[^}]*\}/)?.[0] ?? '';
    assert.ok(row.includes("'scanners/project-graph'") && row.includes("'test/project-graph'"), `T02 row: ${row}`);
  });

  it('nothing under scanners/project-graph spells a root schema path the pack-list test would demand', () => {
    assert.deepEqual(schemaLiteralHits(path.join(ROOT, 'scanners/project-graph')), []);
  });

  it('the README points at the files it describes, and they exist', () => {
    const named = ['INTERFACE_RFC.md', 'schemas/project-graph.draft-1.schema.json', 'interface-rfc.record.json',
      'interface-rfc.test.mjs', 'interface-rfc.probe.mjs'];
    for (const name of named) assert.ok(readme.includes(name), `README does not mention ${name}`);
    for (const rel of [record.rfc, record.schema_file, 'test/project-graph/interface-rfc.probe.mjs']) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
    }
  });
});

describe('the drift checks can fail', () => {
  // A copy of the three source files that `extractSourceLiterals` reads; `edits` maps a file name to a text change.
  const withSource = (edits = {}) => fixture(Object.fromEntries(['index.mjs', 'shadow.mjs', 'source-role.mjs'].map((name) => {
    const file = `scanners/project-graph/${name}`;
    return [file, (edits[name] ?? ((text) => text))(read(file))];
  })));
  const sourceCopy = (appendIndex = '', appendShadow = '') => withSource({
    'index.mjs': (text) => text + appendIndex,
    'shadow.mjs': (text) => text + appendShadow,
  });
  const swap = (from, to) => (text) => {
    assert.ok(text.includes(from), `the source no longer contains ${from}`);
    return text.replace(from, to);
  };

  it('a new unresolved kind or error code in the source is reported', () => {
    const kind = sourceCopy("\nunresolved.push({ kind: 'brand-new-kind', message: 'm' });\n");
    assert.deepEqual(checkLiterals(extractSourceLiterals(kind), record.literals), ['source unresolved_kinds: "brand-new-kind" is not in the record']);
    const code = sourceCopy('', "\nerr.code = 'PROJECT_NEW_THING';\n");
    assert.deepEqual(checkLiterals(extractSourceLiterals(code), record.literals), ['source error_codes: "PROJECT_NEW_THING" is not in the record']);
  });

  it('a name added to, or dropped from, the ignored directories or a role set is reported', () => {
    const added = withSource({
      'index.mjs': swap("'third-party',\n]);", "'third-party', 'brand-new-directory',\n]);"),
      'source-role.mjs': swap("'scaffolds']", "'scaffolds', 'brand-new-segment']"),
    });
    assert.deepEqual(checkLiterals(extractSourceLiterals(added), record.literals), [
      'source hard_ignored_directories: "brand-new-directory" is not in the record',
      'source template_segments: "brand-new-segment" is not in the record',
    ]);
    const dropped = withSource({
      'index.mjs': swap("'.git', ", ''),
      'source-role.mjs': swap("'upstream',", ''),
    });
    assert.deepEqual(checkLiterals(extractSourceLiterals(dropped), record.literals), [
      'source hard_ignored_directories: ".git" is recorded but not found',
      'source reference_segments: "upstream" is recorded but not found',
    ]);
  });

  it('a record that drops or invents an item is reported', () => {
    const found = extractSourceLiterals(ROOT);
    const dropped = { ...record.literals, marker_kinds: record.literals.marker_kinds.filter((k) => k !== 'go-module') };
    assert.deepEqual(checkLiterals(found, dropped), ['source marker_kinds: "go-module" is not in the record']);
    const invented = { ...record.literals, edge_kinds: [...record.literals.edge_kinds, 'owns'] };
    assert.deepEqual(checkLiterals(found, invented), ['source edge_kinds: "owns" is recorded but not found']);
    assert.equal(checkLiterals(found, { ...record.literals, graph_schema: 'sbf.project-graph/draft-2' }).length, 1);
  });

  it('a schema that gains a value is reported', () => {
    const widened = clone(schema);
    widened.$defs.project.properties.kind.enum.push('service');
    assert.deepEqual(checkLiterals(schemaVocabulary(widened), record.literals, 'schema'), ['schema project_kinds: "service" is not in the record']);
  });

  it('an RFC that loses a section, a quoted name or an export is reported', () => {
    assert.equal(sectionProblems(rfc.replace('## 6. File ownership', '## 6. Ownership'), record.required_sections).length, 1);
    assert.deepEqual(missingFromText(rfc.replaceAll('`directory-read`', 'directory-read'), ['directory-read'], { quoted: true }), ['directory-read']);
    assert.deepEqual(missingFromText(rfc.replaceAll('executeProjectScanPlan', 'run'), ['executeProjectScanPlan']), ['executeProjectScanPlan']);
  });

  it('the pack-list literal detector fires on a root schema path and not on the draft path', () => {
    assert.equal(schemaLiteralHits(fixture({ 'a/x.md': 'see schemas/some-contract.schema.json' })).length, 1);
    assert.deepEqual(schemaLiteralHits(fixture({ 'a/x.md': 'see schemas/project-graph.draft-1.schema.json' })), []);
  });
});

// ---- The checks of RFC section 2.5 must be able to fail -------------------------------------------------
// Each edit damages one side (the schema, the RFC, a record list or a tag) and names the cases the checks
// must then report. An edit that no check notices would mean a check that cannot fail.
describe('the option checks can fail', () => {
  const recorded = record.option_cases;
  const everyName = () => [...recorded.accepted, ...Object.keys(recorded.unchecked), ...recorded.malformed];
  const graphsOf = (group) => clone(Object.fromEntries(Object.entries(options()[group]).map(([name, built]) => [name, built.graph])));
  const checker = (edit) => {
    const doc = clone(schema);
    edit(doc);
    const check = new Ajv2020({ allErrors: true, strict: true }).compile(doc);
    return (graph) => (check(graph) ? [] : [...check.errors]);
  };
  const reported = (problems) => problems.map((problem) => problem.split(':')[0]);
  const dropEverywhere = (node, keyword) => {
    if (Array.isArray(node)) node.forEach((item) => dropEverywhere(item, keyword));
    else if (node && typeof node === 'object') {
      delete node[keyword];
      Object.values(node).forEach((child) => dropEverywhere(child, keyword));
    }
  };
  const unresolvedVariant = (doc, kind) => doc.$defs.unresolved.oneOf.find((v) => v.properties.kind.const === kind);

  it('the unedited schema passes both schema checks, so a report below comes from the edit', () => {
    const same = checker(() => {});
    assert.deepEqual(acceptanceProblems(same, graphsOf('accepted')), []);
    assert.deepEqual(rejectionProblems(same, graphsOf('unchecked'), recorded.unchecked), []);
  });

  const TIGHTER = [
    ['marker kind back to an enum of the nine defaults', ['custom_marker_kinds'],
      (d) => { d.$defs.marker.properties.kind = { enum: [...d.$defs.marker.properties.kind.examples] }; }],
    ['adapter ids as lower-case words', ['adapter_values'], (d) => { d.$defs.candidate.properties.adapter_id.pattern = '^[a-z][a-z0-9-]*$'; }],
    ['whole-number specificity', ['adapter_values'], (d) => { d.$defs.candidate.properties.specificity = { type: 'integer' }; }],
    ['non-negative specificity', ['adapter_values'], (d) => { d.$defs.candidate.properties.specificity.minimum = 0; }],
    ['a title that is not empty', ['adapter_values'], (d) => { d.$defs.candidate.properties.title.minLength = 1; }],
    ['a confidence enum', ['adapter_values'], (d) => { d.$defs.candidate.properties.confidence = { enum: ['high', 'medium', 'low', 'unknown'] }; }],
    ['capabilities with a key', ['adapter_defaults'], (d) => { d.$defs.candidate.properties.capabilities.minProperties = 1; }],
    ['boolean capabilities', ['adapter_values'], (d) => { d.$defs.candidate.properties.capabilities.additionalProperties = { type: 'boolean' }; }],
    ['paths of portable characters', ['odd_names'], (d) => { d.$defs.relPath.pattern = '^[A-Za-z0-9_./-]+$'; }],
    ['no first segment that starts with two dots', ['dotdot_names'], (d) => { d.$defs.relPath.pattern = '^(?!/)(?!\\.\\.)(?!(?:[\\s\\S]*/)?\\.\\.(?:/|$))[\\s\\S]+$'; }],
    ['a detected root that is a repo-relative path without .. segments', ['detect_values'],
      (d) => { unresolvedVariant(d, 'out-of-scope-detection').properties.detected_root = { $ref: '#/$defs/relPath' }; }],
    ['at least two projects', ['empty_repository'], (d) => { d.properties.projects.minItems = 2; }],
    ['at least one file read', ['empty_repository'], (d) => { d.properties.files_read.minItems = 1; }],
    ['another schema id', recorded.accepted, (d) => { d.properties.schema.const = 'sbf.project-graph/draft-2'; }],
  ];
  for (const [name, targets, edit] of TIGHTER) {
    it(`a schema that rejects an accepted graph is reported: ${name}`, () => {
      const problems = acceptanceProblems(checker(edit), graphsOf('accepted'));
      for (const target of targets) assert.ok(reported(problems).includes(target), `${target} not reported: ${JSON.stringify(reported(problems))}`);
      if (targets !== recorded.accepted) assert.ok(reported(problems).length < recorded.accepted.length, 'the edit must not reject everything');
    });
  }

  const LOOSER = [
    ['a marker kind of any type', ['non_string_marker_kinds'], (d) => { d.$defs.marker.properties.kind = {}; }],
    ['adapter text fields of any type', ['non_string_adapter_fields'], (d) => {
      const props = d.$defs.candidate.properties;
      props.title = {};
      props.confidence = {};
      props.verification_basis = {};
    }],
    ['no minLength anywhere', ['empty_adapter_id'], (d) => dropEverywhere(d, 'minLength')],
    // Without its minLength the empty id also fails for other keywords only, so that case is reported too.
    ['an adapter id of any type', ['empty_adapter_id', 'numeric_adapter_id'], (d) => {
      const facet = d.$defs.httpFacet;
      d.$defs.candidate.properties.adapter_id = {};
      d.$defs.candidate.properties.title = {};
      facet.properties.selected_adapter = {};
      facet.allOf[0].then.properties.selected_adapter = {};
    }],
    ['no required anywhere', ['missing_adapter_id'], (d) => dropEverywhere(d, 'required')],
    ['no uniqueItems anywhere', ['duplicate_adapter_ids'], (d) => dropEverywhere(d, 'uniqueItems')],
  ];
  for (const [name, targets, edit] of LOOSER) {
    it(`a schema that accepts an unchecked value is reported: ${name}`, () => {
      const problems = rejectionProblems(checker(edit), graphsOf('unchecked'), recorded.unchecked);
      assert.deepEqual(sorted(reported(problems)), sorted(targets), JSON.stringify(problems));
    });
  }

  it('a schema that accepts everything is reported for every unchecked case', () => {
    const everything = checker((d) => { for (const key of Object.keys(d)) delete d[key]; });
    assert.deepEqual(sorted(reported(rejectionProblems(everything, graphsOf('unchecked'), recorded.unchecked))), Object.keys(recorded.unchecked));
    assert.deepEqual(acceptanceProblems(everything, graphsOf('accepted')), []);
  });

  it('a marker kind that loses its examples or gains one the code does not emit is reported', () => {
    const lost = clone(schema);
    lost.$defs.marker.properties.kind.examples = lost.$defs.marker.properties.kind.examples.filter((kind) => kind !== 'go-module');
    assert.deepEqual(checkLiterals(schemaVocabulary(lost), record.literals, 'schema'), ['schema marker_kinds: "go-module" is recorded but not found']);
    const gained = clone(schema);
    gained.$defs.marker.properties.kind.examples.push('swift-package');
    assert.deepEqual(checkLiterals(schemaVocabulary(gained), record.literals, 'schema'), ['schema marker_kinds: "swift-package" is not in the record']);
    const enumAgain = clone(schema);
    enumAgain.$defs.marker.properties.kind = { enum: [...record.literals.marker_kinds] };
    assert.equal(checkLiterals(schemaVocabulary(enumAgain), record.literals, 'schema').length, 9);
  });

  it('an RFC that renames the tag of a recorded case, or a record that lacks a tagged case, is reported', () => {
    for (const name of everyName()) {
      const renamed = rfc.replaceAll(`\`${name}\``, `\`${name}_renamed\``);
      assert.deepEqual(sorted(optionTagProblems(renamed, everyName())), sorted([
        `the RFC tags probe: options \`${name}_renamed\`, which is not a recorded case`,
        `recorded option case \`${name}\` is not tagged anywhere in the RFC`,
      ]), name);
      assert.deepEqual(optionTagProblems(rfc, everyName().filter((other) => other !== name)),
        [`the RFC tags probe: options \`${name}\`, which is not a recorded case`], name);
    }
  });

  it('an RFC statement that is reworded or removed is reported, for every statement the tables assert', () => {
    const fragments = [
      ...Object.values(ACCEPTED).flatMap((entry) => entry.says),
      ...Object.values(UNCHECKED).flatMap((entry) => entry.says),
      ...MALFORMED_SAYS,
    ];
    assert.ok(fragments.length >= 60, `only ${fragments.length} statements`);
    const flat = rfc.replace(/\s+/g, ' ');
    for (const fragment of fragments) {
      const folded = fragment.replace(/\s+/g, ' ');
      assert.ok(folded.length >= 15, `"${fragment}" is too short to pin a statement`);
      assert.deepEqual(missingFragments(flat, [fragment]), []);
      assert.deepEqual(missingFragments(flat.replace(folded, ''), [fragment]), [fragment]);
      assert.deepEqual(missingFragments(flat.replace(folded, `${folded.slice(0, -1)}!${folded.slice(-1)}`), [fragment]), [fragment]);
    }
  });

  it('a default-marker list that loses a name, changes a kind or loses its heading is reported', () => {
    const { marker_kind_by_file_name: table } = probeJson('options').accepted.default_markers.extra;
    const flat = rfc.replace(/\s+/g, ' ');
    assert.deepEqual(defaultMarkerProblems(flat, table), []);
    const list = flat.indexOf(' Match: ');
    const edited = (from, to) => {
      assert.ok(list >= 0 && flat.indexOf(from, list) >= 0, `the RFC list does not contain "${from}"`);
      return flat.slice(0, list) + flat.slice(list).replace(from, to);
    };
    assert.deepEqual(defaultMarkerProblems(edited('`Gemfile` (`ruby-bundle`), ', ''), table),
      ['default marker names that match: "Gemfile" is recorded but not found']);
    assert.deepEqual(defaultMarkerProblems(edited('`Appcsproj`. [probe', '`Appcsproj`, `extra.txt`. [probe'), table),
      ['default marker names that do not match: "extra.txt" is not in the record']);
    assert.deepEqual(defaultMarkerProblems(edited('`go.mod` (`go-module`)', '`go.mod` (`go-modules`)'), table),
      ['default marker "go.mod" is listed as go-modules and the probe says go-module']);
    assert.equal(defaultMarkerProblems(edited(' No match: ', ' No matches: '), table).length, 1);
    assert.equal(defaultMarkerProblems(edited(' Match: ', ' Matches: '), table).length, 1);
    assert.equal(defaultMarkerProblems(edited('[probe: options `default_markers`]', ''), table).length, 1);
    // The code side: a rule that stopped matching a name, or started to match another, is reported too.
    assert.deepEqual(defaultMarkerProblems(flat, { ...table, Gemfile: null }),
      ['default marker names that match: "Gemfile" is not in the record', 'default marker names that do not match: "Gemfile" is recorded but not found']);
    assert.deepEqual(defaultMarkerProblems(flat, { ...table, 'README.md': 'node-package' }),
      ['default marker names that match: "README.md" is recorded but not found', 'default marker names that do not match: "README.md" is not in the record']);
  });

  it('a record list that lost, gained or mis-sorted a case is reported', () => {
    const live = { accepted: recorded.accepted, unchecked: Object.keys(recorded.unchecked), malformed: recorded.malformed };
    assert.deepEqual(optionCaseListProblems(recorded, live), []);
    assert.deepEqual(optionCaseListProblems({ ...recorded, accepted: recorded.accepted.slice(1) }, live),
      [`option_cases.accepted: "${recorded.accepted[0]}" is not in the record`]);
    assert.deepEqual(optionCaseListProblems({ ...recorded, malformed: [...recorded.malformed, 'zz_invented'] }, live),
      ['option_cases.malformed: "zz_invented" is recorded but not found']);
    assert.deepEqual(optionCaseListProblems({ ...recorded, unchecked: { ...recorded.unchecked, zz_invented: 'type' } }, live),
      ['option_cases.unchecked: "zz_invented" is recorded but not found']);
    const [first, second, ...rest] = recorded.accepted;
    assert.deepEqual(optionCaseListProblems({ ...recorded, accepted: [second, first, ...rest] }, live), ['record option_cases.accepted is not sorted and unique']);
    assert.deepEqual(optionCaseListProblems({ ...recorded, accepted: [first, first, second, ...rest] }, live), ['record option_cases.accepted is not sorted and unique']);
    assert.deepEqual(optionCaseListProblems(recorded, { ...live, accepted: [...live.accepted, 'zz_new_case'] }),
      ['option_cases.accepted: "zz_new_case" is not in the record']);
  });

  it('a wrong or unreadable kind tag is reported', () => {
    const produced = { negative: { n_one: ['directory-read'] }, options: { o_one: ['marker-read', 'directory-read'] } };
    const rows = (...tags) => tags.map(([kind, tag]) => ({ kind, tag }));
    assert.deepEqual(kindTagProblems(rows(['marker-read', 'probe: options `o_one`'], ['directory-read', 'probe: negative `n_one`; probe: options `o_one`'], ['other', 'source']), produced), []);
    assert.deepEqual(kindTagProblems(rows(['marker-read', 'probe: negative `n_one`']), produced), ['marker-read: probe negative case n_one does not produce it']);
    assert.deepEqual(kindTagProblems(rows(['marker-read', 'probe: options `gone`']), produced), ['marker-read: the tag names probe options case gone, which is not recorded']);
    assert.deepEqual(kindTagProblems(rows(['marker-read', 'source']), produced), ['marker-read is tagged source but probe options case o_one produces it']);
    assert.deepEqual(kindTagProblems(rows(['marker-read', 'somewhere']), produced), ['marker-read: cannot read the tag "somewhere"']);
  });

  it('a marker rule that is called with another argument list, or not for a regular file, is reported', () => {
    const files = ['a/package.json', 'b/Cargo.toml', 'node_modules/x/package.json'];
    assert.deepEqual(markerArgumentProblems(files, [['package.json'], ['Cargo.toml']]), []);
    assert.equal(markerArgumentProblems(files, [['package.json']]).length, 1);
    assert.equal(markerArgumentProblems(files, [['package.json'], ['Cargo.toml'], ['package.json']]).length, 1);
    assert.equal(markerArgumentProblems(files, [['package.json', 'a/package.json'], ['Cargo.toml']]).length, 1);
    assert.equal(markerArgumentProblems(files, [['a/package.json'], ['b/Cargo.toml']]).length, 1);
    assert.equal(markerArgumentProblems(files, [[], ['Cargo.toml']]).length, 1);
  });
});
