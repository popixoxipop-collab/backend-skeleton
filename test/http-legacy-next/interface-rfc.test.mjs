import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runScan } from '../../scanners/index.mjs';
import { ADAPTERS } from '../../scanners/registry.mjs';
import * as lib from './baseline-record-lib.mjs';

// T11-02: vocabulary vs code and RFC vs vocabulary are both recomputed, so drift on either side fails; the negatives edit copies of both.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); const DIR = 'adapters/http-legacy-next';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const [rfc, vocab] = [read(`${DIR}/INTERFACE_RFC.md`), JSON.parse(read('test/http-legacy-next/interface-rfc.vocabulary.json'))];
const mods = Object.fromEntries(await Promise.all(Object.keys(vocab.exports).map(async (m) => [m, await import(pathToFileURL(path.join(ROOT, DIR, `${m}.mjs`)).href)])));
const { LEGACY_HTTP_ADAPTER_IDS: IDS, LEGACY_HTTP_BASELINES: BASELINES, legacyHttpBaseline } = mods.baselines;
const { bridgeLegacyHttpScan, snapshotLegacyHttpAdapter, summarizeLegacyHttpReport } = mods.bridge;
const { legacyHttpSemanticSnapshot: snapshotOf, legacyHttpSemanticDigest: digestOf, compareLegacyHttpSemanticSnapshots: compare } = mods.parity;
const evaluate = mods['cutover-readiness'].evaluateLegacyHttpCutoverReadiness;
const adapterOf = (id) => ADAPTERS.find((a) => a.id === id);
const rootOf = (id) => path.join(ROOT, legacyHttpBaseline(id).fixture);
const sorted = (xs) => [...xs].sort();
const pick = (d = {}) => ({ specificity: d.specificity, confidence: d.confidence, verificationBasis: d.verificationBasis, capabilities: d.capabilities });
const projector = ({ legacy_semantic_snapshot: s }) => ({ projector_contract: 'rfc-test/0', semantic_snapshot: structuredClone(s) });
const ten = (v, value, except) => evaluate({ adapterId: 'ruby-rails', checks: Object.fromEntries(v.cutover_gates.map((g) => [g.gate, g.gate === except ? !value : value])) });
const emitted = Object.fromEntries(IDS.map((id) => {
  const [adapter, root] = [adapterOf(id), rootOf(id)];
  const report = runScan({ repoRoot: root, terms: [] });
  const shadow = mods['shadow-projection'].runLegacyHttpShadowProjection({ adapter, report, projector, projectorId: 'rfc-test', projectorContract: 'rfc-test/0', root });
  return [id, { adapter, report, root, shadow, snapshot: snapshotOf(report, { root }), bridge: bridgeLegacyHttpScan({ adapter, report }), summary: summarizeLegacyHttpReport(report) }];
}));
const PY = { 'pyproject.toml': '[project]\ndependencies=["fastapi"]\n', 'app/main.py': 'x = 1\n', 'tests/test_a.py': 'y = 1\n', 'tests/test_b.py': 'z = 1\n' };
const sample = (adapter, input) => lib.checkoutOutcome({ checkout: mods['checkout-completeness'] }, { adapter, ...input }).inspect;
const checkouts = { full: sample('python-fastapi', { files: PY }), verified: sample('python-fastapi', { files: PY, sparse: ['app', 'tests'] }), partial: sample('python-fastapi', { files: PY, sparse: ['app'] }), truncated: sample('python-fastapi', { files: PY, sparse: ['app'], max_missing: 1 }), unsupported: sample('javascript-express', { files: { 'src/app.js': 'x\n' }, sparse: ['src'] }) };
const cmp = compare({ a: 1, b: [1], c: 1, e: [1] }, { a: 2, b: [1, 2], d: 1, e: { x: 1 } });

function sourceProblems(v, extraSources = []) {
  const out = []; const all = Object.values(emitted); const first = all[0]; const srcs = [...Object.keys(mods).map((m) => read(`${DIR}/${m}.mjs`)), ...extraSources]; const cs = read(`${DIR}/checkout-completeness.mjs`);
  const eq = (what, expected, actual) => { if (!isDeepStrictEqual(expected, actual)) out.push(`${what}: vocabulary ${JSON.stringify(expected)} but code ${JSON.stringify(actual)}`); };
  const shape = (name, objects) => objects.forEach((o) => eq(`output_keys.${name}`, v.output_keys[name], Object.keys(o)));
  eq('adapter ids', Object.keys(v.adapters), IDS);
  for (const k of Object.keys(v)) if (/enum|values|verdicts/.test(k)) out.push(`open fields are never listed as closed sets: ${k}`);
  for (const id of IDS) { eq(`${id} registry descriptor`, v.adapters[id], pick(adapterOf(id))); eq(`${id} baseline descriptor`, v.adapters[id], pick(BASELINES[id].descriptor)); eq(`${id} contract`, v.schemas.descriptor, adapterOf(id).contract); }
  for (const [m, names] of Object.entries(v.exports)) eq(`${m}.mjs exports`, sorted(names), sorted(Object.keys(mods[m])));
  eq('schemas', v.schemas, { descriptor: first.adapter.contract, scan_report: first.report.schema, bridge: mods.bridge.LEGACY_HTTP_BRIDGE_SCHEMA, semantic_snapshot: mods.parity.LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA, shadow_projection: mods['shadow-projection'].T11_SHADOW_PROJECTION_SCHEMA, cutover_readiness: mods['cutover-readiness'].T11_CUTOVER_READINESS_SCHEMA });
  const modules = all.flatMap((e) => e.snapshot.modules); const controllers = modules.flatMap((m) => m.controllers);
  shape('baseline_entry', IDS.map(legacyHttpBaseline)); shape('bridge', all.map((e) => e.bridge)); shape('report_summary', all.map((e) => e.summary)); shape('semantic_snapshot', all.map((e) => e.snapshot));
  shape('snapshot_module', modules); shape('snapshot_controller', controllers); shape('endpoint', controllers.flatMap((c) => c.endpoints)); shape('shadow_projection', all.map((e) => e.shadow)); shape('compare', [first.shadow.parity, cmp]); shape('diff', cmp.diffs);
  for (const e of all) for (const f of v.open_fields) if (e.snapshot[f] !== null && typeof e.snapshot[f] !== 'string') out.push(`open field ${f} is neither a string nor null`);
  eq('bridge mode', v.modes.bridge, first.bridge.mode); eq('shadow mode', v.modes.shadow, first.shadow.mode); eq('diff kinds', sorted(v.diff_kinds), sorted(new Set(cmp.diffs.map((d) => d.kind))));
  eq('checkout modes', sorted(v.modes.checkout), sorted(new Set([...cs.matchAll(/mode: '([a-z-]+)'/g)].map((m) => m[1])))); eq('checkout error code', [v.checkout_error_code], [...cs.matchAll(/err\.code = '(\w+)'/g)].map((m) => m[1]));
  eq('sparse adapters', sorted(v.sparse_supported_adapters), sorted([...cs.match(/SUPPORTED_SPARSE = new Set\(\[([^\]]*)\]\)/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1])));
  try {
    eq('gate order', v.cutover_gates.map((g) => g.gate), Object.keys(ten(v, false).checks)); eq('blockers in gate order', v.cutover_gates.map((g) => g.blocker), ten(v, false).blockers); eq('cutover keys', v.output_keys.cutover_readiness, Object.keys(ten(v, true)));
    for (const g of v.cutover_gates) eq(`blocker of ${g.gate}`, [g.blocker], ten(v, true, g.gate).blockers);
  } catch (e) { out.push(`cutover call failed: ${e.message}`); }
  const loads = srcs.map(lib.importsOf); eq('imports', sorted(v.imports), sorted(new Set(loads.flatMap((l) => l.specs)))); eq('computed import() or require that cannot be listed', [], loads.flatMap((l) => l.opaque)); eq('owned files', sorted(v.owned_files), sorted(fs.readdirSync(path.join(ROOT, DIR))));
  for (const f of v.foreign_schemas) if (all.some((e) => JSON.stringify([e.bridge, e.snapshot, e.shadow]).includes(f))) out.push(`${f} must not appear in any T11 output`);
  for (const p of v.ownership.flatMap((o) => o.paths)) if (!fs.existsSync(path.join(ROOT, p))) out.push(`ownership path ${p} does not exist`);
  const { full, verified, partial, truncated, unsupported } = checkouts; const more = (mode) => v.checkout_conditional_keys[mode] ?? [];
  eq('modes of the sampled checkouts', ['full-working-tree', 'sparse-readset-verified', 'sparse-readset-verified', 'sparse-readset-verified', 'sparse-unsupported-adapter'], [full, verified, partial, truncated, unsupported].map((c) => c.mode));
  shape('checkout', [full, verified, partial]); eq('truncated sample', [2, 1, true], [truncated.missing_count, truncated.missing_paths.length, truncated.missing_paths_truncated]);
  eq('keys of a truncated sparse-readset-verified result', [...v.output_keys.checkout, ...more('sparse-readset-verified')], Object.keys(truncated));
  eq('keys of a sparse-unsupported-adapter result', [...v.output_keys.checkout, ...more('sparse-unsupported-adapter')], Object.keys(unsupported));
  eq('modes with conditional keys', sorted(Object.keys(v.checkout_conditional_keys)), sorted(v.modes.checkout.filter((m) => m.startsWith('sparse'))));
  return [...new Set(out)];
}

function rfcProblems(text, v) {
  const out = []; const words = new Set(text.split(/[\s`|(),;{}[\]]+/).map((w) => w.replace(/[.:]+$/, '')));
  const caps = Object.keys(v.adapters[IDS[0]].capabilities); const yn = (b) => (b ? 'yes' : 'no');
  const tables = {
    'adapter table': [`| adapter | specificity | confidence | verificationBasis | ${caps.join(' | ')} |`, `| ${['---', '---', '---', '---', ...caps.map(() => '---')].join(' | ')} |`, ...Object.entries(v.adapters).map(([id, a]) => `| ${id} | ${a.specificity} | ${a.confidence} | ${a.verificationBasis} | ${caps.map((c) => yn(a.capabilities[c])).join(' | ')} |`)],
    'gate table': ['| # | gate | blocker |', '| --- | --- | --- |', ...v.cutover_gates.map((g, i) => `| ${i + 1} | ${g.gate} | ${g.blocker} |`)],
    'ownership table': ['| paths | owner | T11 may |', '| --- | --- | --- |', ...v.ownership.map((o) => `| ${o.paths.map((p) => `\`${p}\``).join(', ')} | ${o.owner} | ${o.t11} |`)]
  };
  for (const [name, lines] of Object.entries(tables)) if (!text.includes(lines.join('\n'))) out.push(`${name} differs from the vocabulary`);
  for (const [name, keys] of Object.entries(v.output_keys)) if (!text.includes(`{${keys.join(', ')}}`)) out.push(`key list ${name} differs from the vocabulary`);
  const ids = [...Object.keys(v.adapters), ...Object.values(v.schemas), ...v.foreign_schemas, ...Object.entries(v.exports).flatMap(([m, ns]) => [`${m}.mjs`, ...ns]), ...Object.values(v.modes).flat(), ...Object.values(v.checkout_conditional_keys).flat(), v.checkout_error_code, ...v.diff_kinds, ...v.open_fields, ...v.owned_files, ...v.ownership.flatMap((o) => o.paths)];
  for (const id of ids) if (!words.has(id)) out.push(`RFC does not name ${id}`);
  const schemas = new Set([...Object.values(v.schemas), ...v.foreign_schemas]); const blockers = new Set(v.cutover_gates.map((g) => g.blocker));
  for (const w of words) {
    if (/^(?:sbf|bskel|beval)\.[a-z0-9.-]+\/\d+$/.test(w) && !schemas.has(w)) out.push(`RFC cites an unlisted schema ${w}`);
    if (/^[a-z]+(?:-[a-z]+)*-not-[a-z-]+$/.test(w) && !blockers.has(w)) out.push(`RFC cites an unlisted blocker ${w}`);
    if (/^[\w./-]+\.mjs$/.test(w) && !fs.existsSync(path.join(ROOT, w.includes('/') ? w : `${DIR}/${w}`))) out.push(`RFC cites a missing file ${w}`);
    if (/^(?:adapters|scanners|contracts|schemas|release|scripts|test|\.github)\//.test(w) && !fs.existsSync(path.join(ROOT, w))) out.push(`RFC cites a missing path ${w}`);
  }
  if (text.split('\n').length > 120) out.push('RFC exceeds 120 lines');
  return out;
}

test('T11-02 the vocabulary equals what the modules, registry, imports, directory and real scans of the five fixtures emit', () => assert.deepEqual(sourceProblems(vocab), []));

test('T11-02 the RFC names every vocabulary identifier, key list and table row, cites nothing unlisted, and stays within 120 lines', () => assert.deepEqual(rfcProblems(rfc, vocab), []));

test('T11-02 the identity, unknown and partial rules stated in the RFC hold on real calls', () => {
  const { report, snapshot, shadow, root } = emitted['java-spring'];
  assert.equal(legacyHttpBaseline('generic-grep'), null);
  assert.throws(() => snapshotLegacyHttpAdapter(adapterOf('generic-grep')), /not one of T11's five legacy HTTP adapters/);
  assert.throws(() => bridgeLegacyHttpScan({ adapter: adapterOf('ruby-rails'), report }), /does not match descriptor "ruby-rails"/);
  assert.deepEqual(Object.values(summarizeLegacyHttpReport({ schema: report.schema })), [[], 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(snapshotOf({ schema: report.schema }, { root }), { schema: vocab.schemas.semantic_snapshot, adapter: null, confidence: null, api_surface_source: null, verdict: null, path_prefix_signals: [], modules: [], files_read: [] });
  assert.equal(digestOf(report, { root }), digestOf(snapshot));
  assert.throws(() => snapshotOf(report, { root: 'relative' }), /root must be an absolute path/);
  for (const e of Object.values(emitted)) assert.deepEqual(e.snapshot.modules.flatMap((m) => m.controllers.flatMap((c) => c.endpoints.map((x) => x.operationId))), e.report.related_modules.flatMap((m) => m.controllers.flatMap((c) => c.endpoints.map((x) => x.operationId ?? null))));
  assert.deepEqual([[{ a: 1 }, { a: 2 }, 2], [{ a: 1 }, { a: 2 }, 1], [{ a: 1, b: 1 }, { a: 2, b: 2 }, 1]].map(([x, y, maxDiffs]) => ((c) => [c.equal, c.truncated, c.diffs.length])(compare(x, y, { maxDiffs }))), [[false, false, 1], [false, true, 1], [false, true, 1]], 'truncated means the cap was reached, also at exactly maxDiffs');
  assert.deepEqual(compare(snapshot, structuredClone(snapshot)), { equal: true, diffs: [], truncated: false });
  for (const bad of [0, 1001, 1.5]) assert.throws(() => compare({}, {}, { maxDiffs: bad }), RangeError);
  assert.deepEqual([shadow.promotion_allowed, shadow.authoritative_source, Object.isFrozen(shadow)], [false, vocab.schemas.scan_report, true]);
  assert.deepEqual([ten(vocab, true).ready_for_t00_integration, ten(vocab, true).apply_allowed, ten(vocab, false).ready_for_t00_integration], [true, false, false]);
  assert.throws(() => evaluate({ adapterId: 'ruby-rails', checks: {} }), /must be boolean/);
  assert.throws(() => evaluate({ adapterId: 'ruby-rails', checks: { ...ten(vocab, true).checks, invented_gate: true } }), /unknown T11 cutover checks: invented_gate/);
  assert.throws(() => evaluate({ adapterId: 'generic-grep', checks: ten(vocab, true).checks }), /adapterId must be one of T11 legacy adapters/);
  assert.throws(() => mods['checkout-completeness'].inspectLegacyCorpusCheckout({ repoRoot: ROOT, adapterId: 'ruby-rails', maxMissing: 0 }), RangeError);
});

test('T11-02 negative: edited copies of the RFC and the vocabulary make the same checks fail', () => {
  for (const id of ['ownership-scope-not-clean', 'sparse-unsupported-adapter', 'array-length', 'sbf.http-legacy-bridge/1', 'compareLegacyHttpReports', 'T11_CORPUS_CHECKOUT_INCOMPLETE']) assert.match(rfcProblems(rfc.replaceAll(id, 'REDACTED'), vocab).join('\n'), /RFC does not name|differs from the vocabulary/, id);
  assert.equal(rfcProblems(`${rfc}\n\`sbf.invented/1\` \`made-up-not-clean\` \`ghost.mjs\` \`adapters/ghost\``, vocab).length, 4);
  for (const [from, to, pattern] of [['| 2 |', '| 3 |', /gate table/], ['{equal, diffs, truncated}', '{equal, diffs}', /key list compare/]]) assert.match(rfcProblems(rfc.replace(from, to), vocab).join('\n'), pattern);
  assert.ok(rfcProblems(`${rfc}\n${'x\n'.repeat(120)}`, vocab).includes('RFC exceeds 120 lines'));
  const bad = (edit) => { const v = structuredClone(vocab); edit(v); return sourceProblems(v).join('\n'); };
  assert.match(bad((v) => { v.adapters['java-spring'].capabilities['api.operations'] = false; }), /java-spring registry descriptor/);
  assert.match(bad((v) => { v.cutover_gates.reverse(); }), /blockers in gate order/);
  assert.match(bad((v) => { v.exports.bridge.push('bridgeEverything'); }), /bridge\.mjs exports/);
  assert.match(bad((v) => { v.imports.push('../../contracts/next/identity.mjs'); }), /imports/);
  assert.match(bad((v) => { v.output_keys.bridge.pop(); }), /output_keys\.bridge/);
  assert.match(bad((v) => { v.checkout_conditional_keys['sparse-unsupported-adapter'] = []; }), /sparse-unsupported-adapter result/);
  assert.match(bad((v) => { delete v.checkout_conditional_keys['sparse-readset-verified']; }), /truncated sparse-readset-verified/);
  assert.match(rfcProblems(rfc.replaceAll('missing_paths_truncated', 'REDACTED'), vocab).join('\n'), /RFC does not name missing_paths_truncated/);
  const ONE = { specs: ['../x.mjs'], opaque: [] };
  for (const src of ["import a from '../x.mjs';", 'import a from "../x.mjs";', "import {\n a,\n b\n} from '../x.mjs';", "import '../x.mjs';", 'import "../x.mjs";', "export { a } from '../x.mjs';", "export * from '../x.mjs';", "const m = await import('../x.mjs');", 'await import("../x.mjs");']) assert.deepEqual(lib.importsOf(src), ONE, src);
  for (const src of ['await import(name);', 'await import(`../${n}.mjs`);', "require('x');", 'createRequire(import.meta.url);']) assert.equal(lib.importsOf(src).opaque.length, 1, src);
  assert.deepEqual(lib.importsOf("// import 'a';\n/* import 'b' */ const s = 1; // import 'c'").specs, [], 'comments are ignored');
  assert.match(sourceProblems(vocab, ["import '../../contracts/next/identity.mjs';"]).join('\n'), /imports/);
  assert.match(sourceProblems(vocab, ['await import(name);']).join('\n'), /cannot be listed/);
});
