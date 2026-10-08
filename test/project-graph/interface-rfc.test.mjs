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
import { negativeCases, normalCase, registeredCase } from './interface-rfc.cases.mjs';
import {
  checkLiterals, extractSourceLiterals, missingFromText, schemaLiteralHits, schemaUnresolvedFields,
  schemaVocabulary, sectionLines, sectionProblems, tableRows,
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
      ['probe-normal', 'probe-negative', 'probe-shadow', 'probe-registered', 'node-test', 'nested-t02']);
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
    assert.deepEqual(s.ok.scans.map((x) => [x.project_id, x.adapter_id, x.mode, x.report.schema, x.report.verdict]),
      [['project:api', 'javascript-express', 'first-class', 'sbf.scan-report/2', 'inventory']]);
    assert.equal(s.serialized_graph_ok.same_as_ok, true);
    assert.deepEqual(sorted(Object.keys(s.failures)), sorted(Object.keys(record.shadow_failures)));
    for (const [key, code] of Object.entries(record.shadow_failures)) {
      assert.equal(s.failures[key].ok, false, key);
      assert.equal(s.failures[key].code, code, key);
      assert.ok(record.literals.error_codes.includes(code), `${code} is not a recorded error code`);
    }
    for (const key of ['source_drift', 'source_file_added']) {
      assert.deepEqual([s.failures[key].stale_kind, s.failures[key].fingerprint_changed], ['adapter-read-set', true], key);
    }
    assert.deepEqual([s.failures.marker_drift.stale_kind, s.failures.marker_drift.digest_changed], [null, true]);
    assert.equal(s.failures.plan_stale.adapter_id, 'gated-http');
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

  it('5.1 tags: a probe-tagged kind comes from the named case, a source-tagged kind from no probe', () => {
    const negative = probeJson('negative');
    const produced = new Set(Object.values(negative).filter((v) => v.graph).flatMap((v) => v.graph.unresolved.map((u) => u.kind)));
    for (const row of unresolvedRows()) {
      const kind = ticks(row[0]);
      const tag = row[row.length - 1];
      if (tag === 'source') {
        assert.ok(!produced.has(kind), `${kind} is tagged source but a probe produces it`);
        continue;
      }
      const name = tag.match(/^probe: negative `([a-z_]+)`$/)?.[1];
      assert.ok(record.negative_cases.includes(name), `${kind}: tag "${tag}" does not name a recorded case`);
      assert.ok(negative[name].graph.unresolved.some((u) => u.kind === kind), `${kind} is not produced by ${name}`);
    }
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
  const sourceCopy = (appendIndex = '', appendShadow = '') => fixture({
    'scanners/project-graph/index.mjs': read('scanners/project-graph/index.mjs') + appendIndex,
    'scanners/project-graph/shadow.mjs': read('scanners/project-graph/shadow.mjs') + appendShadow,
  });

  it('a new unresolved kind or error code in the source is reported', () => {
    const kind = sourceCopy("\nunresolved.push({ kind: 'brand-new-kind', message: 'm' });\n");
    assert.deepEqual(checkLiterals(extractSourceLiterals(kind), record.literals), ['source unresolved_kinds: "brand-new-kind" is not in the record']);
    const code = sourceCopy('', "\nerr.code = 'PROJECT_NEW_THING';\n");
    assert.deepEqual(checkLiterals(extractSourceLiterals(code), record.literals), ['source error_codes: "PROJECT_NEW_THING" is not in the record']);
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
