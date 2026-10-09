import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runScan } from '../../scanners/index.mjs';
import { ADAPTERS } from '../../scanners/registry.mjs';
import * as lib from './baseline-record-lib.mjs';

// T11-02: vocabulary vs code and RFC vs vocabulary are both recomputed, so drift on either side fails; the negatives edit copies of both.
// Lists are compared as exact sets and every key list with every emitted object of that kind; an empty sample fails instead of passing.
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
const record = lib.readRecord(); const seen = [];
const answer = (s) => ({ projector_contract: 'rfc-test/0', semantic_snapshot: s });
const projector = (input) => { seen.push(input); return answer(structuredClone(input.legacy_semantic_snapshot)); };
const deepFrozen = (x) => x === null || typeof x !== 'object' || (Object.isFrozen(x) && Object.values(x).every(deepFrozen));
const relative = (root, file) => (file == null ? null : path.relative(root, file).split(path.sep).join('/'));
const SPLIT = /[\s`|(),;{}[\]]+/;
const ten = (v, value, except) => evaluate({ adapterId: 'ruby-rails', checks: Object.fromEntries(v.cutover_gates.map((g) => [g.gate, g.gate === except ? !value : value])) });
const emitted = Object.fromEntries(IDS.map((id) => {
  const [adapter, root] = [adapterOf(id), rootOf(id)];
  const report = runScan({ repoRoot: root, terms: [] });
  const shadow = mods['shadow-projection'].runLegacyHttpShadowProjection({ adapter, report, projector, projectorId: 'rfc-test', projectorContract: 'rfc-test/0', root });
  return [id, { adapter, report, root, shadow, snapshot: snapshotOf(report, { root }), bridge: bridgeLegacyHttpScan({ adapter, report }), summary: summarizeLegacyHttpReport(report) }];
}));
const PY = { 'pyproject.toml': '[project]\ndependencies=["fastapi"]\n', 'app/main.py': 'x = 1\n', 'tests/test_a.py': 'y = 1\n', 'tests/test_b.py': 'z = 1\n' };
const outcome = (adapter, input) => lib.checkoutOutcome({ checkout: mods['checkout-completeness'] }, { adapter, ...input });
const outcomes = { full: outcome('python-fastapi', { files: PY }), verified: outcome('python-fastapi', { files: PY, sparse: ['app', 'tests'] }), partial: outcome('python-fastapi', { files: PY, sparse: ['app'] }), truncated: outcome('python-fastapi', { files: PY, sparse: ['app'], max_missing: 1 }),
  unsupported: outcome('javascript-express', { files: { 'src/app.js': 'x\n' }, sparse: ['src'] }), widest: outcome('python-fastapi', { files: PY, sparse: ['app'], max_missing: 1000 }) };
const checkouts = Object.fromEntries(Object.entries(outcomes).map(([k, o]) => [k, o.inspect]));
const shadowOf = (id, result) => mods['shadow-projection'].runLegacyHttpShadowProjection({ adapter: adapterOf(id), report: emitted[id].report, projector: () => result, projectorId: 'rfc-test', projectorContract: 'rfc-test/0', root: rootOf(id) });
const cmp = compare({ a: 1, b: [1], c: 1, e: [1] }, { a: 2, b: [1, 2], d: 1, e: { x: 1 } });

function sourceProblems(v, extraSources = [], from = emitted) {
  const out = []; const all = Object.values(from); const first = all[0]; const id0 = Object.keys(from)[0]; const srcs = [...Object.keys(mods).map((m) => read(`${DIR}/${m}.mjs`)), ...extraSources]; const cs = read(`${DIR}/checkout-completeness.mjs`);
  const eq = (what, expected, actual) => { if (!isDeepStrictEqual(expected, actual)) out.push(`${what}: vocabulary ${JSON.stringify(expected)} but code ${JSON.stringify(actual)}`); };
  const shaped = new Set(); const under = (p, q) => p === q || p.startsWith(`${q}/`);
  const shape = (name, objects) => { shaped.add(name); if (!objects.length) out.push(`output_keys.${name}: no emitted sample, so nothing was compared`); objects.forEach((o) => eq(`output_keys.${name}`, v.output_keys[name], Object.keys(o))); };
  eq('adapter ids', Object.keys(v.adapters), IDS);
  eq('vocabulary keys (each is compared with the code below; open fields are never listed as closed sets)', sorted(['schema', 'adapters', 'schemas', 'foreign_schemas', 'foreign_keys', 'exports', 'imports', 'modes', 'checkout_error_code', 'checkout_conditional_keys', 'sparse_supported_adapters', 'diff_kinds', 'open_fields', 'cutover_gates', 'output_keys', 'input_keys', 'projector', 'registry_only_keys', 'owned_files', 'ownership']), sorted(Object.keys(v)));
  eq('vocabulary schema and nested groups', ['bskel.t11-interface-vocabulary/1', ['bridge', 'shadow', 'checkout'], ['input', 'output']], [v.schema, Object.keys(v.modes), Object.keys(v.projector)]);
  for (const id of IDS) { eq(`${id} registry descriptor`, v.adapters[id], pick(adapterOf(id))); eq(`${id} baseline descriptor`, v.adapters[id], pick(BASELINES[id].descriptor)); eq(`${id} contract`, v.schemas.descriptor, adapterOf(id).contract); }
  for (const [m, names] of Object.entries(v.exports)) eq(`${m}.mjs exports`, sorted(names), sorted(Object.keys(mods[m])));
  eq('schemas', v.schemas, { descriptor: first.adapter.contract, scan_report: first.report.schema, bridge: mods.bridge.LEGACY_HTTP_BRIDGE_SCHEMA, semantic_snapshot: mods.parity.LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA, shadow_projection: mods['shadow-projection'].T11_SHADOW_PROJECTION_SCHEMA, cutover_readiness: mods['cutover-readiness'].T11_CUTOVER_READINESS_SCHEMA });
  const modules = all.flatMap((e) => e.snapshot.modules); const controllers = modules.flatMap((m) => m.controllers); const nested = (k) => modules.flatMap((m) => m[k]);
  shape('baseline_entry', IDS.map(legacyHttpBaseline)); shape('baseline_descriptor', IDS.map((id) => legacyHttpBaseline(id).descriptor)); shape('bridge', all.map((e) => e.bridge)); shape('adapter_snapshot', all.map((e) => e.bridge.source_adapter));
  all.forEach((e) => eq(`${e.adapter.id} source_adapter`, snapshotLegacyHttpAdapter(e.adapter), e.bridge.source_adapter));
  shape('report_summary', [...all.map((e) => e.summary), ...IDS.map((id) => legacyHttpBaseline(id).inventory)]); shape('semantic_snapshot', all.map((e) => e.snapshot));
  shape('snapshot_module', modules); shape('snapshot_controller', controllers); shape('endpoint', controllers.flatMap((c) => c.endpoints));
  shape('snapshot_entity', nested('entities')); shape('snapshot_enum', nested('enums')); shape('snapshot_dto', nested('dtos'));
  shape('shadow_projection', all.map((e) => e.shadow)); shape('compare', [first.shadow.parity, cmp]); shape('diff', cmp.diffs);
  // Every emitted entity, enum and DTO equals the projection of the raw scan object by the RFC rule: a listed key is copied, unknown is null (constants []), file is relative.
  for (const e of all) e.report.related_modules.forEach((m, i) => [['entities', 'snapshot_entity'], ['enums', 'snapshot_enum'], ['dtos', 'snapshot_dto']].forEach(([kind, group]) => (m[kind] ?? []).forEach((item, j) => {
    const raw = typeof item === 'string' ? { className: item } : item;
    eq(`${group} value in ${e.adapter.id}`, Object.fromEntries((v.output_keys[group] ?? []).map((k) => [k, k === 'file' ? relative(e.root, raw.file) : raw[k] ?? (k === 'constants' ? [] : null)])), e.snapshot.modules[i][kind][j]);
  })));
  for (const e of all) for (const f of v.open_fields) if (e.snapshot[f] !== null && typeof e.snapshot[f] !== 'string') out.push(`open field ${f} is neither a string nor null`);
  eq('open fields', sorted(v.open_fields), sorted(Object.entries(first.snapshot).filter(([k, x]) => !['schema', 'adapter'].includes(k) && !Array.isArray(x)).map(([k]) => k)));
  eq('bridge mode', v.modes.bridge, first.bridge.mode); eq('shadow mode', v.modes.shadow, first.shadow.mode); eq('diff kinds', sorted(v.diff_kinds), sorted(new Set(cmp.diffs.map((d) => d.kind))));
  eq('diff kinds in parity.mjs', sorted(v.diff_kinds), sorted(new Set([...read(`${DIR}/parity.mjs`).matchAll(/kind: '([a-z-]+)'/g)].map((m) => m[1]))));
  eq('input_keys (the options object of every exported function that takes one)', v.input_keys, Object.fromEntries(srcs.flatMap((t) => [...t.matchAll(/export function (\w+)\(\{([^}]*)\}/g)].map((m) => [m[1], m[2].split(',').map((k) => k.replace(/=.*/s, '').trim()).filter(Boolean)]))));
  eq('projector input keys', v.projector.input, Object.keys(seen[0])); if (!seen.every(deepFrozen)) out.push('the projector input is not deep frozen');
  const reads = [...read(`${DIR}/shadow-projection.mjs`).matchAll(/projected\.(\w+)/g)].map((m) => m[1]).filter((k) => k !== 'then');
  eq('keys a projector result must carry', sorted(v.projector.output), sorted([...new Set([...reads, ...Object.keys(answer(1))])].filter((k) => { try { shadowOf(id0, { ...answer(first.snapshot), [k]: undefined }); return false; } catch { return true; } })));
  eq('registry keys that T11 does not copy', sorted(v.registry_only_keys), sorted(new Set(IDS.flatMap((id) => Object.keys(adapterOf(id))).filter((k) => !v.output_keys.adapter_snapshot.includes(k)))));
  eq('modules with exports', sorted(Object.keys(v.exports).map((m) => `${m}.mjs`)), sorted(v.owned_files.filter((f) => f.endsWith('.mjs'))));
  const [claimed, pins] = [v.ownership.filter((o) => /pinned by BASELINE\.json/.test(o.t11)).flatMap((o) => o.paths), [...record.scanner_files, ...record.inputs.flatMap((i) => i.files)].map((f) => f.path)];
  eq('paths pinned by BASELINE.json (claimed paths holding no pin, pins outside the claimed paths)', [[], []], [claimed.filter((q) => !pins.some((p) => under(p, q))), pins.filter((p) => !claimed.some((q) => under(p, q)))]);
  eq('checkout modes', sorted(v.modes.checkout), sorted(new Set([...cs.matchAll(/mode: '([a-z-]+)'/g)].map((m) => m[1])))); eq('checkout error code', [v.checkout_error_code], [...cs.matchAll(/err\.code = '(\w+)'/g)].map((m) => m[1]));
  eq('sparse adapters', sorted(v.sparse_supported_adapters), sorted([...cs.match(/SUPPORTED_SPARSE = new Set\(\[([^\]]*)\]\)/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1])));
  try {
    eq('gate order', v.cutover_gates.map((g) => g.gate), Object.keys(ten(v, false).checks)); eq('blockers in gate order', v.cutover_gates.map((g) => g.blocker), ten(v, false).blockers); shape('cutover_readiness', [ten(v, true), ten(v, false)]);
    for (const g of v.cutover_gates) eq(`blocker of ${g.gate}`, [[g.blocker], false], ((r) => [r.blockers, r.ready_for_t00_integration])(ten(v, true, g.gate)));
  } catch (e) { out.push(`cutover call failed: ${e.message}`); }
  const loads = srcs.map(lib.importsOf); eq('imports', sorted(v.imports), sorted(new Set(loads.flatMap((l) => l.specs)))); eq('computed import() or require that cannot be listed', [], loads.flatMap((l) => l.opaque)); eq('owned files', sorted(v.owned_files), sorted(fs.readdirSync(path.join(ROOT, DIR))));
  for (const f of [...v.foreign_schemas, ...v.foreign_keys]) if (all.some((e) => JSON.stringify([e.bridge, e.snapshot, e.shadow]).includes(f))) out.push(`${f} must not appear in any T11 output`);
  for (const p of v.ownership.flatMap((o) => o.paths)) if (!fs.existsSync(path.join(ROOT, p))) out.push(`ownership path ${p} does not exist`);
  const { full, verified, partial, truncated, unsupported } = checkouts; const more = (mode) => v.checkout_conditional_keys[mode] ?? [];
  eq('modes of the sampled checkouts', ['full-working-tree', 'sparse-readset-verified', 'sparse-readset-verified', 'sparse-readset-verified', 'sparse-unsupported-adapter'], [full, verified, partial, truncated, unsupported].map((c) => c.mode));
  shape('checkout', [full, verified, partial]); eq('truncated sample', [2, 1, true], [truncated.missing_count, truncated.missing_paths.length, truncated.missing_paths_truncated]);
  eq('keys of a truncated sparse-readset-verified result', [...v.output_keys.checkout, ...more('sparse-readset-verified')], Object.keys(truncated));
  eq('keys of a sparse-unsupported-adapter result', [...v.output_keys.checkout, ...more('sparse-unsupported-adapter')], Object.keys(unsupported));
  eq('modes with conditional keys', sorted(Object.keys(v.checkout_conditional_keys)), sorted(v.modes.checkout.filter((m) => m.startsWith('sparse'))));
  eq('output_keys groups compared with emitted objects', sorted(Object.keys(v.output_keys)), sorted(shaped));
  return [...new Set(out)];
}

function rfcProblems(text, v) {
  const out = []; const words = new Set(text.split(SPLIT).map((w) => w.replace(/[.:]+$/, '')));
  const caps = Object.keys(v.adapters[IDS[0]].capabilities); const yn = (b) => (b ? 'yes' : 'no');
  for (const id of IDS) if (!isDeepStrictEqual(Object.keys(v.adapters[id].capabilities), caps)) out.push(`capability columns of ${id} differ from the first adapter's, so the table cannot show them`);
  const tables = {
    'adapter table': [`| adapter | specificity | confidence | verificationBasis | ${caps.join(' | ')} |`, `| ${['---', '---', '---', '---', ...caps.map(() => '---')].join(' | ')} |`, ...Object.entries(v.adapters).map(([id, a]) => `| ${id} | ${a.specificity} | ${a.confidence} | ${a.verificationBasis} | ${caps.map((c) => yn(a.capabilities[c])).join(' | ')} |`)],
    'gate table': ['| # | gate | blocker |', '| --- | --- | --- |', ...v.cutover_gates.map((g, i) => `| ${i + 1} | ${g.gate} | ${g.blocker} |`)],
    'ownership table': ['| paths | owner | T11 may |', '| --- | --- | --- |', ...v.ownership.map((o) => `| ${o.paths.map((p) => `\`${p}\``).join(', ')} | ${o.owner} | ${o.t11} |`)]
  };
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()); // a table is one whole block, so an extra row below it fails too
  for (const [name, lines] of Object.entries(tables)) if (!blocks.includes(lines.join('\n'))) out.push(`${name} differs from the vocabulary`);
  const lists = [...Object.entries(v.output_keys), ...Object.entries(v.input_keys), ['projector input', v.projector.input], ['projector output', v.projector.output]];
  for (const [name, keys] of lists) if (!text.includes(`{${keys.join(', ')}}`)) out.push(`key list ${name} differs from the vocabulary`);
  for (const [, list] of text.matchAll(/\{(\w+(?:, \w+)+)\}/g)) if (!lists.some(([, keys]) => keys.join(', ') === list)) out.push(`RFC cites a key list that the vocabulary does not have: {${list}}`);
  const fns = {}; // the functions of each module row of the section 3 table
  for (const [, mod, cell] of text.split('\n').filter((l) => /^\| `[\w-]+\.mjs` \|/.test(l)).map((l) => l.split('|').map((c) => c.trim()))) (fns[mod.replace(/`|\.mjs/g, '')] ??= []).push(...cell.match(/\w+/g));
  if (!isDeepStrictEqual(sorted(Object.keys(fns)), sorted(Object.keys(v.exports)))) out.push('the modules of the function table differ from the vocabulary');
  for (const [m, names] of Object.entries(v.exports)) if (!isDeepStrictEqual(sorted(names.filter((n) => /^[a-z]/.test(n))), sorted(fns[m] ?? []))) out.push(`function table of ${m}.mjs differs from the vocabulary`);
  const ids = [...Object.keys(v.adapters), ...Object.values(v.schemas), ...v.foreign_schemas, ...Object.entries(v.exports).flatMap(([m, ns]) => [`${m}.mjs`, ...ns]), ...Object.values(v.modes).flat(), ...Object.values(v.checkout_conditional_keys).flat(), v.checkout_error_code, ...v.diff_kinds, ...v.open_fields, ...v.owned_files, ...v.ownership.flatMap((o) => o.paths)];
  for (const id of ids) if (!words.has(id)) out.push(`RFC does not name ${id}`);
  const strings = (x) => (typeof x === 'string' ? [x] : x && typeof x === 'object' ? Object.values(x).flatMap(strings) : []);
  const ident = (w) => /^(?:[a-z]+[A-Z]\w*|[a-z]+_\w+|[A-Z][A-Z0-9]*_\w+)$/.test(w); // camelCase, snake_case or CONSTANT_CASE
  const listed = new Set(strings(v).flatMap((t) => t.split(SPLIT)).filter(ident));
  for (const w of listed) if (!words.has(w)) out.push(`RFC does not name ${w}`);
  for (const w of words) if (ident(w) && !listed.has(w)) out.push(`RFC cites an unlisted identifier ${w}`);
  const schemas = new Set([...Object.values(v.schemas), ...v.foreign_schemas]); const blockers = new Set(v.cutover_gates.map((g) => g.blocker));
  for (const w of words) {
    if (/^(?:sbf|bskel|beval)\.[a-z0-9.-]+\/\d+$/.test(w) && !schemas.has(w)) out.push(`RFC cites an unlisted schema ${w}`);
    if (/^[a-z]+(?:-[a-z]+)*-not-[a-z-]+$/.test(w) && !blockers.has(w)) out.push(`RFC cites an unlisted blocker ${w}`);
    if (/^[\w./-]+\.mjs$/.test(w) && !fs.existsSync(path.join(ROOT, w.includes('/') ? w : `${DIR}/${w}`))) out.push(`RFC cites a missing file ${w}`);
    if (/^(?:adapters|scanners|contracts|schemas|release|scripts|test|\.github)\//.test(w) && !fs.existsSync(path.join(ROOT, w))) out.push(`RFC cites a missing path ${w}`);
  }
  if (text.trimEnd().split('\n').length > 120) out.push('RFC exceeds 120 lines');
  return [...new Set(out)];
}

test('T11-02 the vocabulary equals what the modules, registry, imports, directory and real scans of the five fixtures emit', () => assert.deepEqual(sourceProblems(vocab), []));

test('T11-02 the RFC names every vocabulary identifier, key list and table row, cites nothing unlisted, and stays within 120 lines', () => assert.deepEqual(rfcProblems(rfc, vocab), []));

test('T11-02 the identity, unknown and partial rules stated in the RFC hold on real calls', () => {
  const { report, snapshot, shadow, root } = emitted['java-spring']; const all = Object.values(emitted); const code = vocab.checkout_error_code;
  const bridgeOf = (r, id = 'java-spring') => () => bridgeLegacyHttpScan({ adapter: adapterOf(id), report: r });
  const sortKeys = (x) => (Array.isArray(x) ? x.map(sortKeys) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])])) : x);
  // Identity
  assert.equal(legacyHttpBaseline('generic-grep'), null);
  assert.throws(() => snapshotLegacyHttpAdapter(adapterOf('generic-grep')), /not one of T11's five legacy HTTP adapters/);
  assert.throws(bridgeOf(report, 'generic-grep'), /not one of T11's five legacy HTTP adapters/);
  assert.throws(bridgeOf(report, 'ruby-rails'), /does not match descriptor "ruby-rails"/);
  assert.throws(bridgeOf({ schema: report.schema }), /scan report adapter "\(missing\)" does not match/);
  assert.throws(bridgeOf({ ...report, schema: 'sbf.scan-report/1' }), /only accepts sbf\.scan-report\/2/);
  assert.deepEqual(all.map((e) => [e.bridge.source_scan_schema, e.snapshot.adapter, e.shadow.adapter_id]), all.map((e) => [vocab.schemas.scan_report, e.adapter.id, e.adapter.id]));
  assert.deepEqual(all.map((e) => e.snapshot.modules.flatMap((m) => m.controllers.flatMap((c) => c.endpoints.map((x) => x.operationId)))), all.map((e) => e.report.related_modules.flatMap((m) => m.controllers.flatMap((c) => c.endpoints.map((x) => x.operationId ?? null)))));
  assert.equal(digestOf(snapshot), createHash('sha256').update(JSON.stringify(sortKeys(snapshot))).digest('hex'));
  assert.equal(digestOf(report, { root }), digestOf(snapshot));
  assert.throws(() => snapshotOf(report, { root: 'relative' }), /root must be an absolute path/);
  assert.throws(() => snapshotOf(report, { root: '/elsewhere' }), /is not under root/);
  // Unknown: absent is null or [] or 0; open fields and the two copied lists come through as emitted.
  assert.deepEqual(Object.values(summarizeLegacyHttpReport({ schema: report.schema })), [[], 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(snapshotOf({ schema: report.schema }, { root }), { schema: vocab.schemas.semantic_snapshot, adapter: null, confidence: null, api_surface_source: null, verdict: null, path_prefix_signals: [], modules: [], files_read: [] });
  for (const e of all) assert.deepEqual([...vocab.open_fields.map((f) => e.snapshot[f]), e.snapshot.path_prefix_signals, e.snapshot.files_read], [...vocab.open_fields.map((f) => e.report[f] ?? null), e.report.path_prefix_signals ?? [], e.report.files_read ?? []], e.adapter.id);
  assert.ok(snapshot.path_prefix_signals.length > 0 && snapshot.files_read.length > 0 && snapshot.path_prefix_signals !== report.path_prefix_signals, 'a non-empty sample, and a copy');
  // Nested shapes by hand, for the forms the five fixtures lack: dropped keys, nulls, a bare DTO name, the name fallback.
  const raw = { schema: vocab.schemas.scan_report, related_modules: [{ module: 'm', entities: [{ className: 'E', table: 't', tableSource: 'explicit', line: 3, file: '/r/E.java' }, {}], enums: [{ name: 'S', constants: ['A'], line: 1 }, {}], dtos: ['D', { name: 'N', file: '/r/N.java' }, { className: 'C', name: 'x', file: '/r/C.java' }, {}] }] };
  const nulls = (group) => Object.fromEntries(vocab.output_keys[group].map((k) => [k, k === 'constants' ? [] : null]));
  assert.deepEqual(snapshotOf(raw, { root: '/r' }).modules[0], { module: 'm', controllers: [], enums: [{ ...nulls('snapshot_enum'), name: 'S', constants: ['A'] }, nulls('snapshot_enum')],
    entities: [{ ...nulls('snapshot_entity'), className: 'E', table: 't', file: 'E.java' }, nulls('snapshot_entity')], dtos: [{ className: 'D', file: null }, { className: 'N', file: 'N.java' }, { className: 'C', file: 'C.java' }, nulls('snapshot_dto')] });
  // Partial: the cap is reached, not exceeded; the default cap is 100 and 1000 is accepted; unknown completeness counts as incomplete.
  assert.deepEqual([[{ a: 1 }, { a: 2 }, 2], [{ a: 1 }, { a: 2 }, 1], [{ a: 1, b: 1 }, { a: 2, b: 2 }, 1]].map(([x, y, maxDiffs]) => ((c) => [c.equal, c.truncated, c.diffs.length])(compare(x, y, { maxDiffs }))), [[false, false, 1], [false, true, 1], [false, true, 1]], 'truncated means the cap was reached, also at exactly maxDiffs');
  assert.deepEqual(compare(snapshot, structuredClone(snapshot)), { equal: true, diffs: [], truncated: false });
  const wide = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, 1]));
  assert.deepEqual([undefined, 1000].map((maxDiffs) => compare(wide, {}, { maxDiffs }).diffs.length), [100, 150]);
  for (const bad of [0, 1001, 1.5]) for (const call of [() => compare({}, {}, { maxDiffs: bad }), () => mods['checkout-completeness'].inspectLegacyCorpusCheckout({ repoRoot: ROOT, adapterId: 'ruby-rails', maxMissing: bad })]) assert.throws(call, RangeError);
  const { unsupported, widest } = checkouts;
  assert.deepEqual([unsupported.complete, unsupported.missing_count, widest.missing_count, 'missing_paths_truncated' in widest], [false, null, 2, false]);
  assert.deepEqual(Object.values(outcomes).map((o) => o.assert_threw?.code ?? null), [null, null, code, code, code, code], 'the assert throws for every incomplete checkout');
  // Modes and cutover readiness
  assert.deepEqual(all.map((e) => [e.bridge.mode, e.shadow.mode, e.shadow.promotion_allowed, e.shadow.authoritative_source, Object.isFrozen(e.shadow)]), all.map(() => [vocab.modes.bridge, vocab.modes.shadow, false, vocab.schemas.scan_report, true]));
  assert.deepEqual([ten(vocab, true).ready_for_t00_integration, ten(vocab, true).apply_allowed, ten(vocab, false).ready_for_t00_integration], [true, false, false]);
  const checks = ten(vocab, true).checks; const refused = (args, message) => assert.throws(() => evaluate(args), { name: 'TypeError', message });
  refused({ adapterId: 'ruby-rails', checks: {} }, /must be boolean/); refused({ adapterId: 'ruby-rails', checks: { ...checks, exact_head_ci_green: 'yes' } }, /exact_head_ci_green must be boolean/);
  refused({ adapterId: 'ruby-rails', checks: { ...checks, invented_gate: true } }, /unknown T11 cutover checks: invented_gate/); refused({ adapterId: 'generic-grep', checks }, /adapterId must be one of T11 legacy adapters/);
  // A projector is synchronous and answers with its own contract.
  assert.throws(() => shadowOf('java-spring', Promise.resolve(answer(snapshot))), /async projector results are not accepted/);
  assert.throws(() => shadowOf('java-spring', { ...answer(snapshot), projector_contract: 'other/0' }), /projector contract mismatch/);
});

test('T11-02 negative: edited copies of the RFC and the vocabulary make the same checks fail', () => {
  const rfcBad = (edit, v = vocab) => rfcProblems(edit(rfc), v).join('\n');
  const srcBad = (edit, ...rest) => { const v = structuredClone(vocab); edit(v); return sourceProblems(v, ...rest).join('\n'); };
  const cases = (bad, rows) => rows.forEach(([edit, pattern]) => assert.match(bad(edit), pattern, String(edit)));
  for (const id of ['ownership-scope-not-clean', 'sparse-unsupported-adapter', 'array-length', 'sbf.http-legacy-bridge/1', 'compareLegacyHttpReports', 'T11_CORPUS_CHECKOUT_INCOMPLETE', 'missing_paths_truncated', 'contract_hash']) assert.match(rfcBad((t) => t.replaceAll(id, 'REDACTED')), /RFC does not name|differs from the vocabulary/, id);
  assert.equal(rfcProblems(`${rfc.trimEnd()} \`sbf.invented/1\` \`made-up-not-clean\` \`ghost.mjs\` \`adapters/ghost\``, vocab).length, 4);
  const n = rfc.trimEnd().split('\n').length;
  assert.deepEqual([120, 121].map((total) => rfcProblems(rfc.trimEnd() + '\nx'.repeat(total - n), vocab).includes('RFC exceeds 120 lines')), [false, true], 'the cap counts lines, not the final newline');
  // Each key list of the RFC: a key dropped, a key added.
  for (const [name, keys] of Object.entries({ ...vocab.output_keys, ...vocab.input_keys, projector_input: vocab.projector.input, projector_output: vocab.projector.output })) {
    assert.match(rfcBad((t) => t.replaceAll(`{${keys.join(', ')}}`, `{${keys.slice(1).join(', ')}}`)), /key list/, `${name} dropped`);
    assert.match(rfcBad((t) => t.replaceAll(`{${keys.join(', ')}}`, `{${[...keys, 'extra'].join(', ')}}`)), /does not have: \{[^}]*extra\}/, `${name} added`);
  }
  cases(rfcBad, [
    [(t) => t.replace('| 2 |', '| 3 |'), /gate table/],
    [(t) => t.replace(/(\| 10 \|.*)/, '$1\n| 11 | ghost_gate | ghost-not-clean |'), /gate table/],
    [(t) => t.replace(/(\| javascript-express \|.*)/, '$1\n| ghost | 1 | low | none | no | no | no | no |'), /adapter table/],
    [(t) => t.replace(/(\| \`release\/next\` \|.*)/, '$1\n| \`ghost\` | T99 | edit |'), /ownership table/],
    [(t) => t.replace('| \`bridge.mjs\` | \`summarizeLegacyHttpReport\` |', '| \`parity.mjs\` | \`summarizeLegacyHttpReport\` |'), /function table of (bridge|parity)\.mjs/],
    [(t) => `${t.trimEnd()} bridgeEverything`, /unlisted identifier bridgeEverything/]
  ]);
  const vocabBad = (edit) => { const v = structuredClone(vocab); edit(v); return rfcProblems(rfc, v).join('\n'); };
  cases(vocabBad, [[(v) => v.foreign_keys.push('ghost_key'), /RFC does not name ghost_key/], [(v) => v.input_keys.bridgeLegacyHttpScan.push('x'), /key list bridgeLegacyHttpScan/], [(v) => { v.ownership[0].t11 = 'read'; }, /ownership table/], [(v) => v.projector.input.reverse(), /key list projector input/],
    [(v) => { delete v.adapters['ruby-rails'].capabilities['codegen.handles']; }, /capability columns of ruby-rails/]]);
  cases(srcBad, [
    [(v) => { v.adapters['java-spring'].capabilities['api.operations'] = false; }, /java-spring registry descriptor/],
    [(v) => v.cutover_gates.reverse(), /blockers in gate order/],
    [(v) => v.exports.bridge.push('bridgeEverything'), /bridge\.mjs exports/],
    [(v) => v.imports.push('../../contracts/next/identity.mjs'), /imports/],
    [(v) => { v.checkout_conditional_keys['sparse-unsupported-adapter'] = []; }, /sparse-unsupported-adapter result/],
    [(v) => { delete v.checkout_conditional_keys['sparse-readset-verified']; }, /truncated sparse-readset-verified/],
    [(v) => { v.output_keys.invented = ['a']; }, /output_keys groups compared/],
    [(v) => { v.invented = []; }, /vocabulary keys/],
    [(v) => { v.modes.invented = 'x'; }, /vocabulary schema and nested groups/],
    [(v) => { v.cutover_gates[3].blocker = 'ghost-not-clean'; }, /blockers in gate order/],
    [(v) => v.ownership[0].paths.push('adapters/ghost'), /ownership path adapters\/ghost does not exist/],
    [(v) => { v.output_keys.snapshot_entity[1] = 'tableSource'; }, /snapshot_entity value in/],
    [(v) => { delete v.input_keys.bridgeLegacyHttpScan; }, /input_keys/],
    [(v) => v.projector.input.pop(), /projector input keys/],
    [(v) => v.projector.output.push('notes'), /keys a projector result must carry/],
    [(v) => v.registry_only_keys.pop(), /registry keys/],
    [(v) => v.open_fields.pop(), /open fields/],
    [(v) => v.diff_kinds.pop(), /diff kinds/],
    [(v) => v.owned_files.push('ghost.mjs'), /modules with exports/],
    [(v) => v.foreign_keys.push('verdict'), /verdict must not appear/],
    [(v) => v.ownership.find((o) => /pinned by/.test(o.t11)).paths.push('contracts/next'), /paths pinned by BASELINE\.json/],
    [(v) => v.ownership.find((o) => /pinned by/.test(o.t11)).paths.pop(), /paths pinned by BASELINE\.json/]
  ]);
  const drop = [(l) => l.pop(), (l) => l.push('extra')]; // a key lost, a key invented
  for (const g of Object.keys(vocab.output_keys)) for (const edit of drop) assert.match(srcBad((v) => edit(v.output_keys[g])), new RegExp(`output_keys\\.${g}: `), g);
  for (const fn of Object.keys(vocab.input_keys)) for (const edit of drop) assert.match(srcBad((v) => edit(v.input_keys[fn])), /input_keys/, fn);
  assert.match(sourceProblems(vocab, [], { 'javascript-express': emitted['javascript-express'] }).join('\n'), /snapshot_entity: no emitted sample/, 'a fixture set without entities compares nothing, so it fails');
  assert.match(sourceProblems(vocab, ['export function invented({ a, b } = {}) {}']).join('\n'), /input_keys/);
  const ONE = { specs: ['../x.mjs'], opaque: [] };
  for (const src of ["import a from '../x.mjs';", 'import a from "../x.mjs";', "import {\n a,\n b\n} from '../x.mjs';", "import '../x.mjs';", 'import "../x.mjs";', "export { a } from '../x.mjs';", "export * from '../x.mjs';", "const m = await import('../x.mjs');", 'await import("../x.mjs");']) assert.deepEqual(lib.importsOf(src), ONE, src);
  for (const src of ['await import(name);', 'await import(`../${n}.mjs`);', "require('x');", 'createRequire(import.meta.url);']) assert.equal(lib.importsOf(src).opaque.length, 1, src);
  assert.deepEqual(lib.importsOf("// import 'a';\n/* import 'b' */ const s = 1; // import 'c'").specs, [], 'comments are ignored');
  assert.match(sourceProblems(vocab, ["import '../../contracts/next/identity.mjs';"]).join('\n'), /imports/);
  assert.match(sourceProblems(vocab, ['await import(name);']).join('\n'), /cannot be listed/);
});
