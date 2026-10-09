// Deterministic evidence probe for scanners/project-graph/INTERFACE_RFC.md (not a test file).
// Usage: node test/project-graph/interface-rfc.probe.mjs <normal|negative|shadow|options|registered>
// Prints canonical (sorted-key) JSON. No absolute paths, timings or error prose that varies by
// Node version: the harness in interface-rfc.test.mjs compares the sha256 of this stdout.
import fs from 'node:fs';
import path from 'node:path';
import {
  buildProjectGraph, buildProjectScanPlan, discoverProjectRoots,
} from '../../scanners/project-graph/index.mjs';
import { PROJECT_SOURCE_ROLES, classifyProjectSourceRole } from '../../scanners/project-graph/source-role.mjs';
import { executeProjectScanPlan } from '../../scanners/project-graph/shadow.mjs';
import {
  canon, cleanup, createdRoots, express, fallback, fixture, hasFile, markerAdapter, scanStub,
} from './interface-rfc.fixtures.mjs';
import {
  malformedCalls, negativeCases, normalCase, optionCases, pkg, registeredCase, withReadSet,
} from './interface-rfc.cases.mjs';

function normal() {
  const { root, graph } = normalCase();
  const discovery = discoverProjectRoots(root);
  const samples = ['src/app.js', 'tests/app.test.js', 'examples/demo/server.js', 'dist/bundle.js',
    'vendor/lib/a.js', 'vendor/examples/x.js', 'generated/tests/x.js', 'templates/page.hbs', 'docs/page.tmpl'];
  return {
    case: 'normal',
    discovery: {
      roots: discovery.roots.map(({ root: r, project_role, markers }) => ({ root: r, project_role, markers })),
      unresolved: discovery.unresolved,
      files_read: discovery.files_read,
    },
    graph: (({ notes, ...rest }) => ({ ...rest, notes_count: notes.length }))(graph),
    plan_default: buildProjectScanPlan(graph),
    plan_with_fallback: buildProjectScanPlan(graph, { includeFallback: true }),
    plan_with_non_active: buildProjectScanPlan(graph, { includeNonActive: true }),
    source_roles: {
      vocabulary: PROJECT_SOURCE_ROLES,
      samples: Object.fromEntries(samples.map((p) => [p, classifyProjectSourceRole(p)])),
    },
  };
}

// Messages are human prose and may vary by Node version, so only the structured fields are kept.
// readSet:false drops the adapter-internal file lists so another track's adapter change that keeps
// the selection result the same cannot move this probe's hash.
function brief(graph, { readSet = true } = {}) {
  return {
    projects: graph.projects.map((p) => ({
      project_id: p.project_id, kind: p.kind, role: p.project_role,
      selected: p.facets.http.selected_adapter, reason: p.facets.http.selection_reason,
      ambiguous: p.facets.http.ambiguous_adapter_ids, fallback: p.fallback_adapter ?? null,
      nested: p.nested_detections, local_package: p.local_package?.name ?? null,
      ...(readSet ? { read_set_files: p.selected_adapter_read_set?.files.map((f) => f.path) ?? null } : {}),
    })),
    edges: graph.project_edges.map((e) => [e.kind, e.from_project_id, e.to_project_id]),
    unresolved: graph.unresolved.map(({ message, ...rest }) => rest),
  };
}

function negative() {
  const out = { case: 'negative' };
  for (const [name, graph] of Object.entries(negativeCases())) {
    out[name] = {
      graph: brief(graph),
      plan: buildProjectScanPlan(graph),
      plan_with_fallback: buildProjectScanPlan(graph, { includeFallback: true }),
    };
  }
  return out;
}

// What a shadow failure carries beyond its code (RFC section 5.3): every field the error can hold, `null` when absent.
// `files` is the difference between the recorded and the recaptured read-set files.
const fileDelta = (expected, actual) => ({
  added: actual.filter((f) => !expected.includes(f)),
  removed: expected.filter((f) => !actual.includes(f)),
});
function failure(fn) {
  try {
    fn();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      code: err.code ?? null,
      stale_kind: err.stale_kind ?? null,
      project_id: err.project_id ?? null,
      marker_path: err.marker_path ?? null,
      adapter_id: err.adapter_id ?? null,
      cause: err.cause === undefined ? null : { class: err.cause?.constructor?.name ?? typeof err.cause, code: err.cause?.code ?? null },
      digest_changed: err.expected_digest === undefined ? null : err.expected_digest !== err.actual_digest,
      fingerprint_changed: err.expected_fingerprint === undefined ? null : err.expected_fingerprint !== err.actual_fingerprint,
      actual_fingerprint_null: err.expected_fingerprint === undefined ? null : err.actual_fingerprint === null,
      files: err.expected_files === undefined ? null : fileDelta(err.expected_files, err.actual_files),
    };
  }
}

const summarize = (out) => ({
  schema: out.schema, graph_schema: out.graph_schema, terms: out.terms, notes: out.notes.length,
  scans: out.scans.map((s) => ({
    project_id: s.project_id, project_root: s.project_root, adapter_id: s.adapter_id, mode: s.mode,
    report: { schema: s.report.schema, adapter: s.report.adapter, verdict: s.report.verdict },
  })),
});

function shadow() {
  const files = {
    'api/package.json': pkg({ name: '@demo/api', dependencies: { express: '^5.0.0' } }),
    'api/src/server.js': 'app.get("/health", () => {});\n',
  };
  const adapters = [fallback, express(withReadSet)];
  const prepare = (extra = {}, list = adapters) => {
    const repoRoot = fixture({ ...files, ...extra });
    return { repoRoot, graph: buildProjectGraph({ repoRoot, adapters: list }) };
  };
  const run = (c, o = {}) => () => executeProjectScanPlan({ repoRoot: c.repoRoot, graph: c.graph, adapters, ...o });
  const clone = (c) => JSON.parse(JSON.stringify(c.graph));
  const a = prepare();
  const okSummary = summarize(run(a)());
  const serialized = summarize(run(a, { graph: clone(a) })());
  const b = prepare();
  fs.appendFileSync(path.join(b.repoRoot, 'api/package.json'), '\n');
  const c = prepare();
  fs.appendFileSync(path.join(c.repoRoot, 'api/src/server.js'), '// drift\n');
  const d = prepare();
  fs.writeFileSync(path.join(d.repoRoot, 'api/src/extra.js'), 'module.exports = {};\n');
  const e = prepare();
  const escapedRoot = clone(e);
  escapedRoot.projects.find((p) => p.root === 'api').root = '../escape';
  const f = prepare();
  const escapedMarker = clone(f);
  escapedMarker.projects.find((p) => p.root === 'api').markers[0].path = '../outside/package.json';
  const gated = markerAdapter('gated-http', 70, hasFile('enabled.flag'));
  const g = prepare({ 'svc/package.json': '{}', 'svc/enabled.flag': '1' }, [gated, fallback]);
  fs.rmSync(path.join(g.repoRoot, 'svc/enabled.flag'));
  const h = prepare();
  fs.rmSync(path.join(h.repoRoot, 'api/package.json'));
  const i = prepare();
  fs.rmSync(path.join(i.repoRoot, 'api/src/server.js'));
  const j = prepare();
  const otherAdapterId = clone(j);
  otherAdapterId.projects.find((p) => p.root === 'api').selected_adapter_read_set.adapter_id = 'other-http';
  const k = prepare();
  const l = prepare();
  const unlistable = express({
    ...withReadSet,
    listReadSet: () => { throw Object.assign(new Error('listing failed'), { code: 'E_LISTING' }); },
  });
  const n = prepare();
  fs.rmSync(path.join(n.repoRoot, 'api/package.json'));
  fs.mkdirSync(path.join(n.repoRoot, 'api/package.json'));
  const o = prepare();
  const escaping = express({ ...withReadSet, listReadSet: () => ['../outside.js'] });
  const withoutMarkers = clone(a);
  for (const project of withoutMarkers.projects) delete project.markers;
  // A graph built with an adapter that has no `listReadSet` carries no read set, so only the markers are checked.
  const unattested = [fallback, express({ scan: scanStub })];
  const m = prepare({}, unattested);
  fs.appendFileSync(path.join(m.repoRoot, 'api/src/server.js'), '// changed after the build\n');
  const unattestedSource = failure(run(m, { adapters: unattested }));
  fs.appendFileSync(path.join(m.repoRoot, 'api/package.json'), '\n');
  const unattestedMarker = failure(run(m, { adapters: unattested }));
  return {
    case: 'shadow',
    ok: okSummary,
    serialized_graph_ok: { same_as_ok: JSON.stringify(canon(serialized)) === JSON.stringify(canon(okSummary)) },
    graph_without_markers_ok: { same_as_ok: JSON.stringify(canon(summarize(run(a, { graph: withoutMarkers })()))) === JSON.stringify(canon(okSummary)) },
    unattested_graph: {
      read_set: m.graph.projects.find((p) => p.root === 'api').selected_adapter_read_set,
      source_change: unattestedSource,
      marker_change: unattestedMarker,
    },
    failures: {
      marker_drift: failure(run(b)),
      source_drift: failure(run(c)),
      source_file_added: failure(run(d)),
      root_mismatch: failure(run(a, { repoRoot: fixture({ 'package.json': '{}' }) })),
      adapter_unavailable: failure(run(a, { adapters: [] })),
      project_root_escape: failure(run(e, { graph: escapedRoot })),
      marker_escape: failure(run(f, { graph: escapedMarker })),
      plan_stale: failure(run(g, { adapters: [gated, fallback] })),
      marker_missing: failure(run(h)),
      marker_unreadable: failure(run(n)),
      source_file_removed: failure(run(i)),
      read_set_adapter_changed: failure(run(j, { graph: otherAdapterId })),
      read_set_not_recaptured: failure(run(k, { adapters: [fallback, express()] })),
      read_set_capture_error: failure(run(l, { adapters: [fallback, unlistable] })),
      read_set_capture_escape: failure(run(o, { adapters: [fallback, escaping] })),
    },
  };
}

// Structure of a graph built from caller-supplied options: no prose (messages), no digests, no
// absolute paths. A detected root that leaves the repository depends on where the process runs, so it
// is printed as a marker instead of the path.
const leavesRepository = (rel) => rel === '..' || rel.startsWith('../');
function detail(graph, root) {
  return {
    projects: graph.projects.map((p) => ({
      root: p.root, kind: p.kind, role: p.project_role,
      markers: p.markers.map((m) => [m.kind, m.path]),
      children: p.child_project_roots,
      local_package: p.local_package ? { ...p.local_package, evidence: p.local_package.evidence.path } : null,
      http: {
        reason: p.facets.http.selection_reason, selected: p.facets.http.selected_adapter,
        ambiguous: p.facets.http.ambiguous_adapter_ids, candidates: p.facets.http.candidates,
      },
      fallback: p.fallback_adapter ?? null,
      nested: p.nested_detections,
      read_set: p.selected_adapter_read_set?.files.map((f) => f.path) ?? null,
    })),
    edges: graph.project_edges.map((e) => [e.kind, e.from_project_id, e.to_project_id, e.dependency_name ?? null]),
    // `repo_path_in_message` says whether the message still holds the absolute repository path, which
    // only a raw system error text does (RFC section 8, limit 4).
    unresolved: graph.unresolved.map(({ message, ...rest }) => ({
      ...rest,
      ...(typeof rest.detected_root === 'string' && leavesRepository(rest.detected_root)
        ? { detected_root: '<outside the repository>' }
        : {}),
      repo_path_in_message: message.includes(root),
    })),
    files_read: graph.files_read,
  };
}

// Only the messages the builder or the caller wrote are stable; the rest come from Node.
const STABLE_MESSAGES = new Set([
  'repoRoot is required', 'adapters must be an array', 'expected sbf.project-graph/draft-1', 'rule failed',
]);
function thrown(fn) {
  try {
    fn();
    return { threw: false };
  } catch (err) {
    return { threw: true, error: err?.constructor?.name ?? typeof err, message: STABLE_MESSAGES.has(err?.message) ? err.message : null };
  }
}

function options() {
  const { accepted, unchecked } = optionCases();
  const graphs = (group) => Object.fromEntries(Object.entries(group).map(([name, c]) => [
    name, { graph: detail(c.graph, c.root), ...(c.extra ? { extra: c.extra } : {}) },
  ]));
  return {
    case: 'options',
    accepted: graphs(accepted),
    unchecked: graphs(unchecked),
    malformed: Object.fromEntries(Object.entries(malformedCalls()).map(([name, fn]) => [name, thrown(fn)])),
  };
}

function registered() {
  const { graph, plan } = registeredCase();
  return { case: 'registered', graph: brief(graph, { readSet: false }), plan, registry_load_errors: graph.registry_load_errors };
}

const cases = { normal, negative, shadow, options, registered };
const name = process.argv[2];
if (!cases[name]) {
  process.stderr.write('usage: interface-rfc.probe.mjs <normal|negative|shadow|options|registered>\n');
  process.exit(2);
}
try {
  const text = JSON.stringify(canon(cases[name]()), null, 2) + '\n';
  for (const root of createdRoots()) {
    if (text.includes(root)) throw new Error('probe output leaked an absolute fixture path');
  }
  process.stdout.write(text);
} finally {
  cleanup();
}
