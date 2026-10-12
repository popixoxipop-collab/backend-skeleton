import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { pathToFileURL } from 'node:url';
import { BY_NUMBER, REPO_ROOT as ROOT, TRACK, codeText, readDocs, readRecord, tmpDir } from './baseline-record-lib.mjs';

// T17-02: INTERFACE_RFC.md against the code, and the names that README.md and INTEGRATION.md cite.
// Nothing the code decides is typed in this file. Each table, key list and sentence of the RFC that states such a fact is
// generated below from real calls (from the code text where a call cannot tell) and must appear in the document exactly as
// generated, so a change of the code or of the document fails. Every backticked name in the three documents must exist.
// The negative tests edit in-memory copies of the documents (or of the expected answers) and must fail with a named reason.

const FILES = {
  envelope: 'adapters/game-next/native-export-envelope.mjs',
  normalizer: 'adapters/game-next/native-structure-normalizer.mjs',
  exporters: 'adapters/game-next/native-text-source-exporters.mjs',
  scanner: 'scanners/webgame.mjs',
  contract: 'contracts/webgame.mjs'
};
const SHADOW = ['envelope', 'normalizer', 'exporters'];
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const isDir = (rel) => exists(rel) && fs.statSync(path.join(ROOT, rel)).isDirectory();
const NS = Object.fromEntries(await Promise.all(Object.entries(FILES).map(async ([key, file]) => [key, await import(pathToFileURL(path.join(ROOT, file)).href)])));
const SRC = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, read(file)]));
const CODE = Object.fromEntries(Object.entries(SRC).map(([key, text]) => [key, codeText(text)]));
const { envelope: E, normalizer: N, exporters: X, scanner: S, contract: C } = NS;
const RECORD = readRecord();
const DOCS = readDocs();
const PKG = JSON.parse(read('package.json'));
const LIMITS = new Set(RECORD.limits.map((limit) => limit.id));
const GEN_PROBLEMS = [];
const tick = (s) => `\`${s}\``;
const braces = (keys) => `{${keys.join(', ')}}`;
const sorted = (xs) => [...xs].sort();
const list = (xs) => (xs.length < 2 ? xs.map(tick).join('') : `${xs.slice(0, -1).map(tick).join(', ')} or ${tick(xs.at(-1))}`);
const flat = (text) => text.replace(/\s*\n\s*/g, ' ');
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const literalsOf = (text) => [...text.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)].map((m) => m[1] ?? m[2]);
const MIB = 1024 * 1024;

// ---- samples: small inputs of the three engines and of the legacy web path ----
const PRODUCER = { id: 't17-doc-test', version: '0-draft', implementation_sha256: 'a'.repeat(64) };
const COMMON = { engineVersion: '1.0', platform: 'test', producer: PRODUCER };
const UNITY_TEXT = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:', '--- !u!1 &6', 'GameObject:', '  m_Name: Hero', '  m_Component:', '  - component: {fileID: 8}', '--- !u!4 &8', 'Transform:', '  m_GameObject: {fileID: 6}', '  m_Father: {fileID: 0}', '--- !u!4 &9', 'Transform:', '  m_GameObject: {fileID: 6}', '  m_Father: {fileID: 8}', ''].join('\n');
const UNITY_PARTIAL = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:', '--- !u!1 &6', 'GameObject:', '  m_Name: Hero', '  m_Layer: 5', '  m_Foo: {x: 1}', ''].join('\n');
const GODOT_TEXT = ['[gd_scene load_steps=2 format=3]', '', '[ext_resource type="Script" path="res://player.gd" id="1"]', '', '[node name="Main" type="Node3D"]', '', '[node name="Player" type="CharacterBody3D" parent="."]', 'script = ExtResource("1")', '', '[connection signal="hit" from="Player" to="." method="_on_hit"]', ''].join('\n');
const GODOT_PARTIAL = ['[gd_scene load_steps=2 format=3]', '', '[node name="Main" type="Node3D"]', 'odd = 1 + 2', '', '[editable path="Main"]', ''].join('\n');
// The payload profile of an engine is read from the refusal that the normalizer gives for a payload of another profile.
const WORDS = (text) => [...new Set(text.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? [])];
const PROBE_REF = E.createNativeSourceRef('x', { path: 'a.txt' });
function profileOf(engine, evidenceClass) {
  const bytes = '{"schema":"probe"}';
  const envelope = E.createNativeExportEnvelope(bytes, { engine, evidenceClass, ...COMMON, sourceInputs: [PROBE_REF] });
  try {
    N.normalizeNativeStructureExport(bytes, envelope);
  } catch (error) {
    return /expected (\S+),/.exec(error.message)?.[1];
  }
  return undefined;
}
const UNREAL_PROFILE = profileOf('unreal', 'editor-export');
const unrealEnvelope = (text) => E.createNativeExportEnvelope(text, { engine: 'unreal', evidenceClass: 'editor-export', ...COMMON });
const unrealAccepts = (types) => {
  const text = JSON.stringify({ schema: UNREAL_PROFILE, types });
  try {
    N.normalizeNativeStructureExport(text, unrealEnvelope(text));
    return true;
  } catch {
    return false;
  }
};
// The type kinds are found by offering every lower-case word of the normalizer as a kind.
const UNREAL_KINDS = sorted(WORDS(SRC.normalizer).filter((w) => /^[a-z]+$/.test(w)).filter((kind) => unrealAccepts([{ id: 'T', kind, name: 'N' }])));
const UNREAL_HERO = { id: 'Hero', kind: 'class', name: 'AHero', base: 'AActor', properties: [{ name: 'Health', type: 'float', specifiers: ['Replicated'] }], functions: [{ name: 'Fire', specifiers: ['Server', 'Reliable'] }] };
const UNREAL_PAYLOAD = { schema: UNREAL_PROFILE, types: [UNREAL_HERO, ...UNREAL_KINDS.filter((kind) => kind !== 'class').map((kind) => ({ id: `T${kind}`, kind, name: `N${kind}` }))] };
const UNREAL_TEXT = JSON.stringify(UNREAL_PAYLOAD);

const SOURCE_REF = E.createNativeSourceRef(UNITY_TEXT, { path: 'Assets/Main.unity' });
const UNITY = X.buildUnityTextSceneExport(UNITY_TEXT, { path: 'Assets/Main.unity', ...COMMON });
const GODOT = X.buildGodotTextSceneExport(GODOT_TEXT, { path: 'scenes/main.tscn', ...COMMON });
const UNREAL_ENVELOPE = unrealEnvelope(UNREAL_TEXT);
const ENVELOPES = { unity: UNITY.envelope, godot: GODOT.envelope, unreal: UNREAL_ENVELOPE };
const STRUCT = {
  unity: N.normalizeNativeStructureExport(UNITY.payload_bytes, UNITY.envelope),
  godot: N.normalizeNativeStructureExport(GODOT.payload_bytes, GODOT.envelope),
  unreal: N.normalizeNativeStructureExport(UNREAL_TEXT, UNREAL_ENVELOPE)
};
const PARSED = { unity: X.parseUnityTextScene(UNITY_TEXT, { path: 'Assets/Main.unity' }), godot: X.parseGodotTextScene(GODOT_TEXT, { path: 'scenes/main.tscn' }) };
const PARTIAL = { unity: X.parseUnityTextScene(UNITY_PARTIAL, { path: 'Assets/Main.unity' }), godot: X.parseGodotTextScene(GODOT_PARTIAL, { path: 'scenes/main.tscn' }) };

const makeRepo = (dependencies, code) => {
  const dir = tmpDir('t17-doc-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'g', dependencies }));
  fs.writeFileSync(path.join(dir, 'a.js'), code);
  return dir;
};
const THREE = "import * as THREE from 'three';\nconst scene = new THREE.Scene();\n";
const REPOS = {
  blocked: makeRepo({}, 'const x = 1;\n'),
  sceneless: makeRepo({ three: '0.180.0' }, "import * as THREE from 'three';\nfunction update() {}\n"),
  idle: makeRepo({ three: '0.180.0' }, THREE),
  system: makeRepo({ three: '0.180.0' }, `${THREE}function update() {}\n`),
  loop: makeRepo({ three: '0.180.0' }, `${THREE}requestAnimationFrame(run);\n`),
  input: makeRepo({ three: '0.180.0' }, `${THREE}function animate() { requestAnimationFrame(animate); }\nwindow.addEventListener('keydown', onKey);\n`)
};
const SCANS = Object.fromEntries(Object.entries(REPOS).map(([name, dir]) => [name, S.scanWebgame(dir)]));
const IDENTITY = { featureId: 'feature-x', featureUid: 'uid-x' };
const CONTRACT = C.buildWebgameContract({ ...IDENTITY, scan: SCANS.system });
const SNAPSHOT = C.verifyWebgameContractSnapshot({ contract: CONTRACT, scan: SCANS.system, ...IDENTITY });
const CHANGED = C.verifyWebgameContractSnapshot({ contract: CONTRACT, scan: SCANS.system, featureId: 'feature-y', featureUid: 'uid-x' });
const CALLS = {
  createNativeSourceRef: SOURCE_REF,
  createNativeExportEnvelope: UNITY.envelope,
  verifyNativeExportEnvelope: E.verifyNativeExportEnvelope(UNITY.envelope),
  normalizeNativeStructureExport: STRUCT.unity,
  verifyNativeStructureInvariants: N.verifyNativeStructureInvariants(STRUCT.unity),
  parseUnityTextScene: PARSED.unity,
  parseGodotTextScene: PARSED.godot,
  buildUnityTextSceneExport: UNITY,
  buildGodotTextSceneExport: GODOT,
  detectWebgameProjects: S.detectWebgameProjects(REPOS.system),
  scanWebgame: SCANS.system,
  buildWebgameContract: CONTRACT,
  verifyWebgameContractSnapshot: SNAPSHOT
};

// ---- generators: signatures, shapes, tables and sentences ----
function closing(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((s) => s.trim()).filter(Boolean);
}
const RENAME = { sourceBytes: 'bytes', value: 'structure', repoRoot: 'repository root' };
function parametersOf(fn) {
  const text = fn.toString();
  const open = text.indexOf('(');
  return splitTop(text.slice(open + 1, closing(text, open))).map((p) => {
    if (!p.startsWith('{')) return { name: p.split('=')[0].trim() };
    const end = closing(p, 0);
    return { keys: splitTop(p.slice(1, end)).map((k) => k.split(/[:=]/)[0].trim()), optional: /^\s*=/.test(p.slice(end + 1)) };
  });
}
const inputOf = (fn) => parametersOf(fn).map((p) => (p.keys ? `${p.optional ? 'options ' : ''}${braces(p.keys)}` : (RENAME[p.name] ?? p.name))).join(', ');
const keyList = (o) => braces(Object.keys(o));
function shapeOf(value, label) {
  if (!Array.isArray(value)) return keyList(value);
  if (value.length === 0) GEN_PROBLEMS.push(`${label}: the sample returned an empty list, so its element shape is unknown`);
  if (new Set(value.map((x) => Object.keys(x).join(', '))).size > 1) GEN_PROBLEMS.push(`${label}: the elements of the list differ in their keys`);
  return `list of ${keyList(value[0] ?? {})}`;
}
const moduleLabel = (key) => (FILES[key].startsWith('adapters/game-next/') ? path.posix.basename(FILES[key]) : FILES[key]);
const functionsOf = (key) => sorted(Object.keys(NS[key]).filter((name) => typeof NS[key][name] === 'function'));
const constantsOf = (key) => sorted(Object.keys(NS[key]).filter((name) => typeof NS[key][name] !== 'function'));

function functionTable() {
  const rows = [];
  for (const key of Object.keys(FILES)) {
    for (const name of functionsOf(key)) {
      if (!Object.hasOwn(CALLS, name)) {
        GEN_PROBLEMS.push(`${name} is exported but this test has no sample call for it`);
        continue;
      }
      const cells = [moduleLabel(key), inputOf(NS[key][name]), shapeOf(CALLS[name], name)];
      const last = rows.at(-1);
      if (last && same(last.cells, cells)) last.names.push(name);
      else rows.push({ names: [name], cells });
    }
  }
  const exported = Object.keys(FILES).flatMap(functionsOf);
  for (const name of Object.keys(CALLS)) if (!exported.includes(name)) GEN_PROBLEMS.push(`the sample call ${name} names no exported function`);
  return ['| module | function | input | output |', '| --- | --- | --- | --- |', ...rows.map(({ names, cells: [mod, input, output] }) => `| ${tick(mod)} | ${names.map(tick).join(', ')} | ${input} | ${output} |`)];
}

// The engines, evidence classes and roles are what the code accepts, probed with the words of the module itself.
function acceptedPairs() {
  const words = WORDS(SRC.envelope);
  const classes = words.filter((w) => /^[a-z]+-[a-z]+$/.test(w));
  const accepts = (engine, evidenceClass) => {
    try {
      E.createNativeExportEnvelope('{"schema":"probe"}', { engine, evidenceClass, ...COMMON, sourceInputs: [PROBE_REF] });
      return true;
    } catch {
      return false;
    }
  };
  return Object.fromEntries(words.filter((w) => /^[a-z]+$/.test(w)).map((engine) => [engine, classes.filter((c) => accepts(engine, c))]).filter(([, accepted]) => accepted.length > 0));
}
const PAIRS = acceptedPairs();
function engineTable() {
  return ['| engine | evidence classes | payload profile |', '| --- | --- | --- |', ...sorted(Object.keys(PAIRS)).map((engine) => {
    const profiles = new Set(PAIRS[engine].map((c) => profileOf(engine, c)));
    if (profiles.size !== 1 || profiles.has(undefined)) GEN_PROBLEMS.push(`${engine}: the payload profile cannot be read from the normalizer (${[...profiles].join(', ')})`);
    return `| ${tick(engine)} | ${sorted(PAIRS[engine]).map(tick).join(', ')} | ${tick([...profiles][0])} |`;
  })];
}
function constantsTable() {
  const rows = Object.keys(FILES).flatMap((key) => constantsOf(key).map((name) => {
    const value = NS[key][name];
    return `| ${tick(name)} | ${typeof value === 'string' ? tick(value) : String(value)} | ${tick(moduleLabel(key))} |`;
  }));
  return ['| constant | value | module |', '| --- | --- | --- |', ...rows];
}
const ROLES = sorted(WORDS(SRC.envelope).filter((w) => /^[a-z]+$/.test(w)).filter((role) => {
  try {
    E.createNativeSourceRef('x', { path: 'a.txt', role });
    return true;
  } catch {
    return false;
  }
}));
const DEFAULT_ROLE = PROBE_REF.role;

// Verifier tokens are read from the errors.push calls of the verifier source; placeholders become <path> and <claim>.
function tokensOf(source, name) {
  const start = source.indexOf(`export function ${name}(`);
  const body = source.slice(start, source.indexOf('\n}\n', start));
  const tokens = [];
  for (const m of body.matchAll(/errors\.push\((['`])((?:(?!\1).)*)\1\)/g)) {
    let token = m[2].replace(/\$\{[^}]*path[^}]*\}/g, '<path>').replace(/\$\{key\}/g, '<claim>').replace(/^claims\.(?!<)\w+$/, 'claims.<claim>');
    if (token.includes('${')) GEN_PROBLEMS.push(`${name}: the placeholder in ${token} is not one this test knows`);
    if (tokens.at(-1) !== token) tokens.push(token);
  }
  return tokens;
}
const ENVELOPE_TOKENS = tokensOf(SRC.envelope, 'verifyNativeExportEnvelope');
const STRUCTURE_TOKENS = tokensOf(SRC.normalizer, 'verifyNativeStructureInvariants');
const DIAGNOSTIC_CODES = sorted(new Set([...CODE.exporters.matchAll(/'([A-Z]+(?:_[A-Z]+)+)'/g)].map((m) => m[1])));
const SEEN_CODES = sorted(new Set(Object.values(PARTIAL).flatMap((p) => p.diagnostics.map((d) => d.code))));
if (!same(DIAGNOSTIC_CODES, SEEN_CODES)) GEN_PROBLEMS.push(`the exporters carry the diagnostic codes ${DIAGNOSTIC_CODES.join(', ')} but the partial samples produce ${SEEN_CODES.join(', ')}`);
const WARNING_CODES = sorted(new Set([...CODE.scanner.matchAll(/'(WEBGAME_[A-Z_]+)'/g)].map((m) => m[1])));
const COMPLETENESS = sorted(new Set(Object.values(SCANS).map((scan) => scan.completeness.status)));

// The engines that the legacy scanner finds: every package-like word of its code is offered alone, with engines it is not known to find.
const OTHER_ENGINES = ['babylonjs', '@babylonjs/core', 'phaser', 'pixi.js', 'aframe', 'playcanvas'];
const PACKAGE_WORDS = [...new Set([...literalsOf(CODE.scanner).filter((s) => /^(@[a-z-]+\/)?[a-z][a-z.-]*$/.test(s) && s.length > 2), ...OTHER_ENGINES])];
const DETECTED = sorted(PACKAGE_WORDS.filter((name) => S.detectWebgameProjects(makeRepo({ [name]: '1.0.0' }, 'const x = 1;\n')).length > 0));
for (const name of OTHER_ENGINES) if (DETECTED.includes(name)) GEN_PROBLEMS.push(`the scanner detects ${name}, which this test assumed it does not`);

// The options without which a call throws: each documented option is taken out of a working call in turn.
const OPTION_CALLS = {
  createNativeSourceRef: [(o) => E.createNativeSourceRef('x', o), [{ path: 'a.txt', role: 'active', mediaType: 'text/plain' }]],
  createNativeExportEnvelope: [(o) => E.createNativeExportEnvelope('{}', o), (PAIRS.unity ?? []).map((evidenceClass) => ({ when: evidenceClass, engine: 'unity', evidenceClass, ...COMMON, sourceInputs: [PROBE_REF], maxBytes: 1000 }))],
  buildGodotTextSceneExport: [(o) => X.buildGodotTextSceneExport(GODOT_TEXT, o), [{ path: 'scenes/main.tscn', ...COMMON, maxBytes: 100000 }]],
  buildUnityTextSceneExport: [(o) => X.buildUnityTextSceneExport(UNITY_TEXT, o), [{ path: 'Assets/Main.unity', ...COMMON, maxBytes: 100000 }]],
  parseGodotTextScene: [(o) => X.parseGodotTextScene(GODOT_TEXT, o), [{ path: 'scenes/main.tscn', maxBytes: 100000 }]],
  parseUnityTextScene: [(o) => X.parseUnityTextScene(UNITY_TEXT, o), [{ path: 'Assets/Main.unity', maxBytes: 100000 }]]
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
function requiredOptions() {
  const groups = new Map();
  for (const [name, [call, bases]] of Object.entries(OPTION_CALLS)) {
    const owner = Object.keys(FILES).find((key) => typeof NS[key][name] === 'function');
    const declared = parametersOf(NS[owner][name]).find((p) => p.keys).keys;
    const needed = new Map();
    for (const { when, ...options } of bases) {
      if (!same(sorted(Object.keys(options)), sorted(declared))) GEN_PROBLEMS.push(`${name}: the working call does not give exactly the documented options`);
      if (throws(() => call(options))) GEN_PROBLEMS.push(`${name}: the working call used to probe the options throws`);
      for (const key of declared) {
        const { [key]: removed, ...rest } = options;
        if (throws(() => call(rest))) needed.set(key, [...(needed.get(key) ?? []), when ?? null]);
      }
    }
    const always = declared.filter((key) => needed.get(key)?.length === bases.length);
    const only = declared.filter((key) => needed.has(key) && !always.includes(key));
    const text = `${always.length > 0 ? andList(always.map(tick)) : 'no option'}${only.map((key) => `, plus ${tick(key)} for ${list(needed.get(key))}`).join('')}`;
    groups.set(text, [...(groups.get(text) ?? []), name]);
  }
  return `Required options: ${[...groups].map(([text, names]) => `${andList(names.map(tick))} ${names.length > 1 ? 'need' : 'needs'} ${text}`).join('; ')}.`;
}

// Every nested shape is a label plus the key list of every real object of that kind; the lists must agree and be present.
// Nodes and relations come in several shapes, so they are grouped by key list and name the kinds that have it.
const all = (get) => Object.values(STRUCT).flatMap(get);
const DIAGNOSTICS = Object.values(PARTIAL).flatMap((p) => p.diagnostics);
const SHAPES = [
  ['Source input and source reference', [...Object.values(ENVELOPES).flatMap((e) => e.source_inputs), ...all((s) => s.source_inputs), SOURCE_REF, PARSED.unity.source_ref, PARSED.godot.source_ref, ...UNITY.source_inputs]],
  ['artifact', [...Object.values(ENVELOPES).map((e) => e.artifact), SOURCE_REF.artifact, ...all((s) => [s.source_artifact])]],
  ['producer', [...Object.values(ENVELOPES).map((e) => e.producer), ...all((s) => [s.producer])]],
  ['payload descriptor', Object.values(ENVELOPES).map((e) => e.payload_descriptor)],
  ['source locator', all((s) => [...s.nodes, ...s.relations].map((n) => n.source))],
  ['Unity node', STRUCT.unity.nodes, true],
  ['Godot node', STRUCT.godot.nodes, true],
  ['Unreal node', STRUCT.unreal.nodes, true],
  ['relation', all((s) => s.relations), true],
  ['declarations', all((s) => [s.declarations])],
  ['Godot signal', STRUCT.godot.declarations.signals],
  ['Unreal replication', STRUCT.unreal.declarations.replication],
  ['Unreal rpc', STRUCT.unreal.declarations.rpc],
  ['diagnostic', DIAGNOSTICS.filter((d) => d.section === undefined)],
  ['section diagnostic', DIAGNOSTICS.filter((d) => d.section !== undefined)],
  ['envelope claims', Object.values(ENVELOPES).map((e) => e.claims)],
  ['structure claims', all((s) => [s.claims])],
  ['contract change', CHANGED.changes]
];
const SHAPE_PHRASES = SHAPES.flatMap(([label, objects, byKind]) => {
  if (objects.length === 0) GEN_PROBLEMS.push(`${label}: no sample object, so nothing was compared`);
  const groups = new Map();
  for (const object of objects) {
    const keys = keyList(object);
    if (!groups.has(keys)) groups.set(keys, new Set());
    if (byKind) groups.get(keys).add(object.kind);
  }
  if (!byKind && groups.size > 1) GEN_PROBLEMS.push(`${label}: the real objects disagree on their keys: ${[...groups.keys()].join(' / ')}`);
  return [...groups].map(([keys, kinds]) => (byKind ? `${label} ${keys} of kind ${list(sorted(kinds))}` : `${label} ${keys}`));
});
// Every kind that the normalizer names in its code must have been produced by a sample, or its shape would go unchecked.
const SAMPLED_KINDS = new Set(all((s) => [...s.nodes, ...s.relations]).map((o) => o.kind));
for (const m of CODE.normalizer.matchAll(/\bkind:\s*'([a-z-]+)'/g)) if (!SAMPLED_KINDS.has(m[1])) GEN_PROBLEMS.push(`the normalizer can emit the kind ${m[1]}, which no sample produced`);
if (!UNREAL_KINDS.includes('class') || UNREAL_KINDS.length < 2) GEN_PROBLEMS.push(`the Unreal type kinds could not be probed (${UNREAL_KINDS.join(', ')})`);
for (const kind of UNREAL_KINDS) if (!SAMPLED_KINDS.has(`unreal-${kind}`)) GEN_PROBLEMS.push(`the Unreal type kind ${kind} produced no node kind`);

// The byte budget (8 MiB by default). One byte over it is offered to every function that takes bytes, next to a control call that succeeds on a small input:
// a function that refuses with the budget error applies the budget; one that answers, or fails for another reason, does not.
const jsonOf = (size) => Buffer.from(`{"a":"${'x'.repeat(size - 8)}"}`);
const envelopeOf = (bytes, options = {}) => E.createNativeExportEnvelope(bytes, { engine: 'unreal', evidenceClass: 'editor-export', ...COMMON, ...options });
const OVER_BUDGET = jsonOf(8 * MIB + 1);
const BIG_ENVELOPE = envelopeOf(OVER_BUDGET, { maxBytes: 9 * MIB });
const verified = (envelope, bytes) => {
  const verdict = E.verifyNativeExportEnvelope(envelope, { sourceBytes: bytes });
  if (!verdict.valid) throw new Error(`the verifier answered ${JSON.stringify(verdict)}`);
  return verdict;
};
// A well-formed Unreal payload of exactly 8 MiB + 1 bytes (one long name), so that the normalizer is offered bytes that only the budget could refuse.
const OVER_STRUCTURE = (() => {
  const shell = (name) => JSON.stringify({ schema: UNREAL_PROFILE, types: [{ id: 'T', kind: 'class', name }] });
  return Buffer.from(shell('x'.repeat(8 * MIB + 1 - shell('').length)));
})();
const BUDGET_CALLS = {
  normalizeNativeStructureExport: [() => N.normalizeNativeStructureExport(UNREAL_TEXT, UNREAL_ENVELOPE), () => N.normalizeNativeStructureExport(OVER_STRUCTURE, envelopeOf(OVER_STRUCTURE, { maxBytes: 9 * MIB }))],
  buildGodotTextSceneExport: [() => X.buildGodotTextSceneExport(GODOT_TEXT, { path: 'scenes/main.tscn', ...COMMON }), () => X.buildGodotTextSceneExport(OVER_BUDGET, { path: 'scenes/main.tscn', ...COMMON })],
  buildUnityTextSceneExport: [() => X.buildUnityTextSceneExport(UNITY_TEXT, { path: 'Assets/Main.unity', ...COMMON }), () => X.buildUnityTextSceneExport(OVER_BUDGET, { path: 'Assets/Main.unity', ...COMMON })],
  createNativeExportEnvelope: [() => envelopeOf(jsonOf(100)), () => envelopeOf(OVER_BUDGET)],
  createNativeSourceRef: [() => E.createNativeSourceRef('x', { path: 'a.txt' }), () => E.createNativeSourceRef(OVER_BUDGET, { path: 'a.txt' })],
  parseGodotTextScene: [() => X.parseGodotTextScene(GODOT_TEXT, { path: 'scenes/main.tscn' }), () => X.parseGodotTextScene(OVER_BUDGET, { path: 'scenes/main.tscn' })],
  parseUnityTextScene: [() => X.parseUnityTextScene(UNITY_TEXT, { path: 'Assets/Main.unity' }), () => X.parseUnityTextScene(OVER_BUDGET, { path: 'Assets/Main.unity' })],
  verifyNativeExportEnvelope: [() => verified(envelopeOf(jsonOf(100)), jsonOf(100)), () => verified(BIG_ENVELOPE, OVER_BUDGET)]
};
const BUDGET = {};
for (const [name, [control, over]] of Object.entries(BUDGET_CALLS)) {
  try {
    control();
  } catch (error) {
    GEN_PROBLEMS.push(`${name}: the control call on a small input failed: ${error.message}`);
  }
  try {
    over();
    BUDGET[name] = false;
  } catch (error) {
    BUDGET[name] = error instanceof RangeError && /exceeds byte budget/.test(error.message);
    if (!BUDGET[name]) GEN_PROBLEMS.push(`${name}: the over-budget call failed for a reason other than the budget: ${error.message}`);
  }
}
const budgetPhrase = (answers) => {
  const names = (applied) => andList(sorted(Object.keys(answers).filter((name) => answers[name] === applied)).map(tick));
  return `The budget (option ${tick('maxBytes')}, 8 MiB by default) is applied before the bytes are parsed by ${names(true)}; ${names(false)} have no budget and take bytes of any size`;
};
// A source media type is not parsed: the pattern decides, and it is white space that it refuses.
const mediaVerdict = (mediaType) => {
  try {
    E.createNativeSourceRef('x', { path: 'a.txt', mediaType });
    return 'accepted';
  } catch {
    return 'refused';
  }
};
const MEDIA_PHRASES = ['text/plain;charset=utf-8', 'text/plain; charset=utf-8'].map((mediaType) => `${mediaType} is ${mediaVerdict(mediaType)}`);

const holds = (dir) => `${tick(dir)} holds exactly: ${sorted(fs.readdirSync(path.join(ROOT, dir)).filter((n) => !n.startsWith('.'))).map(tick).join(', ')}.`;
const artifactOf = ENVELOPES.unity.artifact;
if (artifactOf.version !== SOURCE_REF.artifact.version) GEN_PROBLEMS.push('the export and a source file have different artifact versions');
const EXPECT = {
  headings: ['1. Purpose and non-goals', '2. What is not here', '3. Vocabulary', '4. Inputs and outputs', '5. Identity', '6. Unknown, partial and unsupported', '7. Legacy web path', '8. File ownership'],
  tables: { engines: engineTable(), constants: constantsTable(), functions: functionTable() },
  phrases: [
    ...SHAPE_PHRASES,
    `the envelope is ${tick(UNITY.envelope.status)} and the normalized structure is ${tick(STRUCT.unity.status)}`,
    `Source roles: ${ROLES.map((r) => tick(r) + (r === DEFAULT_ROLE ? ' (the default)' : '')).join(', ')}.`,
    `Artifact references have the shape of ${tick(artifactOf.artifact_ref)}, copied locally: the export has family ${tick(artifactOf.family)} and media type ${tick(artifactOf.media_type)}, a source file has family ${tick(SOURCE_REF.artifact.family)}; both have version ${tick(artifactOf.version)}.`,
    `${tick('verifyNativeExportEnvelope')} reports tokens, not messages: ${ENVELOPE_TOKENS.map(tick).join(', ')}.`,
    `${tick('verifyNativeStructureInvariants')} reports ${STRUCTURE_TOKENS.map(tick).join(', ')}.`,
    `the text exporters leave out what they do not model and still succeed, reporting ${list(DIAGNOSTIC_CODES)}`,
    requiredOptions(),
    `a project is found only when its ${tick('package.json')} declares ${list(DETECTED)}; a project that declares only another engine package is not found`,
    holds('adapters/game-next'),
    holds('test/game-next'),
    budgetPhrase(BUDGET),
    ...MEDIA_PHRASES
  ],
  coverage: [...Object.keys(PAIRS), ...Object.values(PAIRS).flat(), ...ROLES, ...DIAGNOSTIC_CODES, ...WARNING_CODES, ...COMPLETENESS, UNITY.envelope.status, STRUCT.unity.status, artifactOf.family, SOURCE_REF.artifact.family, ...Object.keys(FILES).flatMap((key) => [...functionsOf(key), ...constantsOf(key)])]
};
const ALLOWED_LISTS = new Set([...Object.values(EXPECT.tables).flat(), ...EXPECT.phrases].flatMap((line) => line.match(/\{[^{}]*\}/g) ?? []));
const NESTED_LINE = RECORD.commands.find((c) => c.id === 'nested-runner').first_line;
const TOKEN_FORMS = new Set([...ENVELOPE_TOKENS, ...STRUCTURE_TOKENS]);

// ---- vocabulary: every backticked word of the three documents has to be a name that the code, the record or the schemas carry ----
const LITERALS = new Set(Object.values(CODE).flatMap(literalsOf));
const IDENTITY_SRC = read('contracts/next/identity.mjs');
const FOREIGN = ['sbf.contract-ref/1', 'sbf.identity-envelope/1', 'contract_hash'];
function keysDeep(value, out = new Set(), depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return out;
  if (!Array.isArray(value)) for (const key of Object.keys(value)) out.add(key);
  for (const child of Object.values(value)) keysDeep(child, out, depth + 1);
  return out;
}
const OPTION_NAMES = Object.keys(FILES).flatMap((key) => functionsOf(key).flatMap((name) => parametersOf(NS[key][name]).flatMap((p) => p.keys ?? [])));
const VOCAB = new Set([
  ...Object.keys(FILES).flatMap((key) => Object.keys(NS[key])),
  ...Object.values(SRC).flatMap((text) => text.match(/[A-Za-z_][\w-]*/g) ?? []),
  ...LITERALS, ...OPTION_NAMES, ...TOKEN_FORMS, ...LIMITS, ...FOREIGN, ...SAMPLED_KINDS,
  ...keysDeep([ENVELOPES, STRUCT, PARSED, PARTIAL, SCANS, CONTRACT, SNAPSHOT, CHANGED, SOURCE_REF, CALLS]),
  ...Object.keys(RECORD), ...Object.keys(RECORD.verification)
]);
const IDS = new Set([...LITERALS].filter((s) => /^sbf\.[\w.-]+\/[\w.-]+$/.test(s)));
IDS.add(JSON.parse(read('schemas/webgame-contract.schema.json')).$id.replace(/^urn:sbf:/, 'sbf.').replace(/:(\d+)$/, '/$1'));
for (const id of FOREIGN.filter((name) => name.startsWith('sbf.'))) if (IDENTITY_SRC.includes(`'${id}'`)) IDS.add(id);
const EXTENSIONS = new Set([...CODE.exporters.matchAll(/'(\.[a-z]+)'/g)].map((m) => m[1]));
const RUNNER_TEXT = read('scripts/run-next-nested-tests.mjs');
const CI_TEXT = read('.github/workflows/ci.yml');
const CI_STEP = /- name: (T17 game-next)\n\s+run: node scripts\/run-next-nested-tests\.mjs T17\n/.exec(CI_TEXT)?.[1];
const FILE_NAME = /[\w@./-]+\.(?:mjs|cjs|js|json|md|yml|yaml)\b/g;

function fileProblem(span) {
  return [span, `adapters/game-next/${span}`, `test/game-next/${span}`].some((rel) => exists(rel) && !isDir(rel)) ? null : 'is not a file of this repository';
}
function commandProblem(span) {
  if (span === 'npm test') return typeof PKG.scripts?.test === 'string' ? null : 'is not possible, package.json has no test script';
  const words = span.split(' ');
  if (words[1] === '--test') {
    const bad = words.slice(2).filter((f) => !/^test\/game-next\/[\w.-]+\.test\.mjs$/.test(f) || !exists(f));
    return words.length > 2 && bad.length === 0 ? null : `names test files that do not exist: ${bad.join(', ') || '(none)'}`;
  }
  if (words.length === 3 && words[1] === 'scripts/run-next-nested-tests.mjs') {
    return RUNNER_TEXT.includes(`id: '${words[2]}'`) ? null : `names the suite ${words[2]}, which the nested runner does not have`;
  }
  return 'is a command shape that this test does not know';
}
function globProblem(span) {
  if (span === 'test/*.test.mjs') return PKG.scripts?.test?.includes(span) ? null : 'is not the glob of the package.json test script';
  return span.endsWith('/**') && isDir(span.slice(0, -3)) ? null : 'is not a directory glob of this repository';
}
function scanPath(span) {
  let value = SCANS.system;
  for (const part of span.split('.')) value = value?.[part];
  return value !== undefined;
}
function spanProblem(span) {
  if (/^node /.test(span) || span === 'npm test') return commandProblem(span);
  if (/^NESTED_SUITE /.test(span)) return span === NESTED_LINE ? null : `is not the runner line that BASELINE.json records (${NESTED_LINE})`;
  if (/^T\d+ [\w-]+$/.test(span) && span.startsWith('T17 ')) return span === CI_STEP ? null : 'is not the name of the T17 step in ci.yml';
  if (span.includes('*')) return globProblem(span);
  if (/^\.[a-z]+$/.test(span)) return EXTENSIONS.has(span) ? null : 'is not an extension that the exporters accept';
  if (/^sbf\./.test(span)) return IDS.has(span) ? null : 'is not an id that the code, the schemas or the identity module carry';
  if (/\.(?:mjs|json|md)$/.test(span)) return fileProblem(span);
  if (span.includes('/') && !LITERALS.has(span)) return isDir(span.replace(/\/$/, '')) ? null : 'is not a directory of this repository';
  if (VOCAB.has(span) || (/^\w+(?:\.\w+)+$/.test(span) && scanPath(span))) return null;
  return 'is not a name that the code, the record or the schemas carry';
}

// The budget statements ("N MiB") are tested at the boundary: N MiB goes through, one byte more is refused.
const budgetCache = new Map();
function budgetHolds(mib) {
  if (!budgetCache.has(mib)) {
    let inside = true;
    let outside = false;
    try {
      envelopeOf(jsonOf(mib * MIB));
    } catch {
      inside = false;
    }
    try {
      envelopeOf(jsonOf(mib * MIB + 1));
    } catch (error) {
      outside = error instanceof RangeError && /exceeds byte budget/.test(error.message);
    }
    budgetCache.set(mib, inside && outside);
  }
  return budgetCache.get(mib);
}

function sections(text) {
  return new Map(text.split(/^## /m).slice(1).map((part) => [Number(/^(\d+)\./.exec(part)?.[1]), part]));
}
function commonProblems(name, text, docs) {
  const out = [];
  const add = (message) => out.push(`${name}: ${message}`);
  if (BY_NUMBER.test(text)) add('names a pull request or an issue by number');
  if (/^```/m.test(text)) add('has a fenced block, which no check reads; use backticked spans or a table');
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const problem = spanProblem(m[1]);
    if (problem) add(`${tick(m[1])} ${problem}`);
  }
  for (const m of text.replace(/`[^`\n]*`/g, ' ').matchAll(FILE_NAME)) add(`the file name ${m[0]} is written without backticks, so nothing checks it`);
  for (const m of text.matchAll(/\blimits?\s+`([^`\n]+)`/g)) if (!LIMITS.has(m[1])) add(`cites the limit ${m[1]}, which BASELINE.json does not record`);
  for (const m of text.matchAll(/`([a-z]+(?:-[a-z]+){3,})`/g)) if (!LIMITS.has(m[1])) add(`${tick(m[1])} looks like a limit id but BASELINE.json records no such limit`);
  for (const m of text.matchAll(/\bsection (\d+) of `INTERFACE_RFC\.md`/g)) if (!sections(docs.rfc).has(Number(m[1]))) add(`points at section ${m[1]} of INTERFACE_RFC.md, which has no such section`);
  for (const m of text.matchAll(/\bsee "([^"\n]+)"/g)) if (![...text.matchAll(/^#{1,6} (.+)$/gm)].some((h) => h[1].startsWith(m[1]))) add(`says see "${m[1]}", but no heading starts with that`);
  for (const m of text.matchAll(/(\d+) MiB/g)) if (!budgetHolds(Number(m[1]))) add(`states a budget of ${m[1]} MiB, which the code does not apply at that boundary`);
  for (const m of text.matchAll(/\{([^{}\n]*)\}/g)) if (!ALLOWED_LISTS.has(m[0])) add(`the braces ${m[0]} are no key list that a real object has`);
  return out;
}

// ---- RFC checks: each takes the document text and the expected answers, and returns problems ----
const gateCache = new Map();
function gate(track, probe) {
  const key = `${track} ${probe}`;
  if (!gateCache.has(key)) {
    const run = spawnSync(process.execPath, ['next/t00/check-ownership.mjs', 'paths', '--track', track, probe], { cwd: ROOT, encoding: 'utf8' });
    gateCache.set(key, { status: run.status, out: `${run.stdout}${run.stderr}` });
  }
  return gateCache.get(key);
}
const CHECKS = {
  layout(text, expect) {
    const out = [];
    const lines = text.replace(/\n$/, '').split('\n').length;
    if (lines > 120) out.push(`layout: ${lines} lines, the RFC keeps to 120`);
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    if (!same(headings, expect.headings)) out.push(`layout: the headings are ${JSON.stringify(headings)}, expected ${JSON.stringify(expect.headings)}`);
    return out;
  },
  tables(text, expect) {
    return Object.entries(expect.tables).filter(([, lines]) => !text.includes(lines.join('\n'))).map(([name, lines]) => `tables: the ${name} table differs from the code's answers; it should read\n${lines.join('\n')}`);
  },
  phrases(text, expect) {
    const body = flat(text);
    return expect.phrases.filter((phrase) => !body.includes(phrase)).map((phrase) => `phrases: missing "${phrase}"`);
  },
  coverage(text, expect) {
    return [...new Set(expect.coverage)].filter((word) => !text.includes(tick(word))).map((word) => `coverage: the code has ${word}, the RFC does not name it in backticks`);
  },
  ownership(text) {
    const out = [];
    const rows = (sections(text).get(8) ?? '').split('\n').filter((l) => l.startsWith('|')).slice(2).map((l) => l.split('|').slice(1, -1).map((cell) => cell.trim()));
    if (rows.length === 0) out.push('ownership: section 8 has no table');
    for (const [paths, owner, may] of rows) {
      for (const [, p] of paths.matchAll(/`([^`]+)`/g)) {
        if (!exists(p)) {
          out.push(`ownership: ${p} does not exist`);
          continue;
        }
        const result = gate('T17', isDir(p) ? `${p}/probe.mjs` : p);
        const answer = result.out.trim().split('\n')[0];
        if (owner === 'T17' ? result.status !== 0 : result.status === 0) out.push(`ownership: ${p} is listed for ${owner}; the ownership tool says: ${answer}`);
        else if (owner === 'stable surface' && !/PATH_UNOWNED/.test(result.out)) out.push(`ownership: ${p} is listed as stable surface; the ownership tool says: ${answer}`);
        else if (/^T\d+$/.test(owner) && owner !== 'T17' && !result.out.includes(`owned by ${owner}`)) out.push(`ownership: ${p} is listed for ${owner}; the ownership tool says: ${answer}`);
        else if (owner === 'coordinator' && !/PATH_RESERVED_HOT/.test(result.out)) out.push(`ownership: ${p} is listed for the coordinator; the ownership tool says: ${answer}`);
        else if (!['T17', 'stable surface', 'coordinator'].includes(owner) && !/^T\d+$/.test(owner)) out.push(`ownership: the owner ${owner} of ${p} is not one this test knows`);
        if (owner !== 'T17' && /^edit/.test(may)) out.push(`ownership: ${p} is not owned by T17, so T17 cannot be allowed to edit it`);
        if (/pin in `?BASELINE\.json/.test(may) && !RECORD.files.some((f) => f.path === p)) out.push(`ownership: ${p} is said to be pinned, but BASELINE.json has no such file`);
      }
    }
    return out;
  }
};
const rfcProblems = (text, expect = EXPECT) => Object.values(CHECKS).flatMap((check) => check(text, expect));
const readmePhrase = (rfc) => {
  const n = [...sections(rfc)].find(([, body]) => body.includes(EXPECT.tables.engines.join('\n')))?.[0];
  return n === undefined ? null : `(section ${n} of ${tick('INTERFACE_RFC.md')} lists which engine accepts which evidence class)`;
};
const docsProblems = (docs, expect = EXPECT) => [
  ...commonProblems('README.md', docs.readme, docs),
  ...commonProblems('INTERFACE_RFC.md', docs.rfc, docs),
  ...commonProblems('INTEGRATION.md', docs.integration, docs),
  ...rfcProblems(docs.rfc, expect),
  ...(readmePhrase(docs.rfc) === null ? ['README.md: the RFC has no section with the engine table, so the README cannot point at it'] : flat(docs.readme).includes(readmePhrase(docs.rfc)) ? [] : [`README.md: missing "${readmePhrase(docs.rfc)}"`])
];

// ---- tests ----
test('generators: every exported function has a sample call and every sample shape is consistent', () => {
  assert.deepEqual(GEN_PROBLEMS, []);
  assert.deepEqual(sorted(Object.keys(CALLS)), sorted(Object.keys(FILES).flatMap(functionsOf)));
  const declared = [...(SRC.envelope.match(/const ENGINE_PROFILES = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1] ?? '').matchAll(/^\s+(\w+): new Set/gm)].map((m) => m[1]);
  assert.deepEqual(sorted(Object.keys(PAIRS)), sorted(declared), 'the probe finds the engines that the profile table of the envelope module declares');
  assert.ok(Object.keys(PAIRS).length > 0 && ROLES.length > 0 && ENVELOPE_TOKENS.length > 0 && STRUCTURE_TOKENS.length > 0);
});

test('INTERFACE_RFC.md: layout and headings', () => assert.deepEqual(CHECKS.layout(DOCS.rfc, EXPECT), []));
test('INTERFACE_RFC.md: tables equal the code answers', () => assert.deepEqual(CHECKS.tables(DOCS.rfc, EXPECT), []));
test('INTERFACE_RFC.md: key lists, tokens and sentences equal the code answers', () => assert.deepEqual(CHECKS.phrases(DOCS.rfc, EXPECT), []));
test('INTERFACE_RFC.md: every vocabulary item of the code is named', () => assert.deepEqual(CHECKS.coverage(DOCS.rfc, EXPECT), []));
test('INTERFACE_RFC.md: the ownership table agrees with the ownership tool and the record', () => assert.deepEqual(CHECKS.ownership(DOCS.rfc), []));
test('README.md, INTERFACE_RFC.md and INTEGRATION.md: every name, path, command and number they cite exists', () => {
  assert.deepEqual(docsProblems(DOCS), []);
});

// ---- behaviour: the sentences of the RFC that a table cannot carry, each against real calls ----
// The import scan is the one of baseline-record-lib.mjs (not exported there): import and export clauses that start a line,
// side-effect imports and import() or require() with a string literal.
const IMPORT_FORMS = /^[ \t]*(?:import|export)\b[\w$*\s,{}]*?\bfrom\s*(['"])([^'"\n]+)\1|^[ \t]*import\s*(['"])([^'"\n]+)\3|\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\5\s*\)/gm;
const specifiersOf = (code) => [...code.matchAll(IMPORT_FORMS)].map((m) => m[2] ?? m[4] ?? m[6]);
const failure = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};
const refused = (fn, type, pattern, what) => {
  const error = failure(fn);
  assert.ok(error instanceof type && pattern.test(error.message), `${what}: expected ${type.name} matching ${pattern}, got ${error ? `${error.constructor.name}: ${error.message}` : 'no error'}`);
};
const BYTES = '{"schema":"x"}';
const make = (options = {}, bytes = BYTES) => envelopeOf(bytes, options);
const warningCodes = (scan) => scan.warnings.map((w) => w.code ?? w);

test('RFC sections 1 to 3: the shadow modules import only node:crypto and each other, claim nothing and have no Unreal exporter or editor producer', () => {
  const own = SHADOW.map((key) => `./${path.basename(FILES[key])}`);
  for (const key of SHADOW) {
    assert.deepEqual(specifiersOf(CODE[key]).filter((spec) => spec !== 'node:crypto' && !own.includes(spec)), [], `${FILES[key]} imports something besides node:crypto and its siblings`);
  }
  assert.deepEqual(specifiersOf(CODE.envelope), ['node:crypto']);
  for (const key of ['scanner', 'contract']) assert.deepEqual(specifiersOf(CODE[key]).filter((spec) => /game-next|native-/.test(spec)), [], `${FILES[key]} calls a shadow module`);
  const claims = [...Object.values(ENVELOPES), ...Object.values(STRUCT)].map((object) => object.claims);
  assert.ok(claims.length > 3 && claims.every((c) => Object.keys(c).length >= 4 && Object.values(c).every((value) => value === false)));
  assert.deepEqual(Object.keys(X).filter((name) => /unreal/i.test(name)), []);
  assert.ok(!/unreal/i.test(CODE.exporters) && !/editor-export|headless-export/.test(CODE.exporters));
  for (const built of [UNITY, GODOT]) assert.equal(built.envelope.evidence_class, 'source-export');
  for (const name of FOREIGN) for (const key of SHADOW) assert.ok(!SRC[key].includes(name), `${FILES[key]} names ${name}`);
  const emitted = JSON.stringify([ENVELOPES, STRUCT, PARSED, PARTIAL, CALLS]);
  for (const name of FOREIGN) assert.ok(!emitted.includes(name), `an output carries ${name}`);
  const emittedKeys = keysDeep([ENVELOPES, STRUCT]);
  assert.deepEqual([...emittedKeys].filter((key) => /^(feature|project|contract)_|^uid$|_uid$/.test(key)), [], 'no output carries a feature, project or contract identity');
});

test('RFC sections 3 and 6: a value the code does not know is refused, and a true claim is reported', () => {
  refused(() => make({ engine: 'cryengine' }), TypeError, /unsupported native engine/, 'unknown engine');
  refused(() => make({ evidenceClass: 'runtime-export' }), TypeError, /unsupported evidence class/, 'unknown evidence class');
  const classes = new Set(Object.values(PAIRS).flat());
  for (const [engine, accepted] of Object.entries(PAIRS)) {
    for (const evidenceClass of classes) {
      if (!accepted.includes(evidenceClass)) refused(() => make({ engine, evidenceClass, sourceInputs: [PROBE_REF] }), TypeError, /unsupported evidence class/, `${engine} with ${evidenceClass}`);
    }
  }
  refused(() => E.createNativeSourceRef('x', { path: 'a.txt', role: 'boss' }), TypeError, /unsupported source role/, 'unknown role');
  for (const claim of Object.keys(UNITY.envelope.claims)) {
    const tampered = structuredClone(UNITY.envelope);
    tampered.claims[claim] = true;
    assert.deepEqual(E.verifyNativeExportEnvelope(tampered), { valid: false, errors: [`claims.${claim}`] });
  }
  for (const claim of Object.keys(STRUCT.unity.claims)) {
    const tampered = structuredClone(STRUCT.unity);
    tampered.claims[claim] = true;
    assert.deepEqual(N.verifyNativeStructureInvariants(tampered), { valid: false, errors: [`claims.${claim}`] });
  }
  for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) refused(() => make({ producer: { ...PRODUCER, implementation_sha256: bad } }), TypeError, /SHA-256 hex digest/, 'malformed digest');
  const withField = JSON.stringify({ schema: UNREAL_PROFILE, types: [], extra: 1 });
  refused(() => N.normalizeNativeStructureExport(withField, unrealEnvelope(withField)), TypeError, /unsupported fields/, 'unknown payload field');
  const foreign = JSON.stringify({ schema: profileOf('unity', 'editor-export'), types: [] });
  refused(() => N.normalizeNativeStructureExport(foreign, unrealEnvelope(foreign)), Error, /schema mismatch: expected \S+, got \S+/, 'a payload profile of another engine');
  const other = JSON.stringify({ schema: UNREAL_PROFILE, types: [] });
  refused(() => N.normalizeNativeStructureExport(`${other} `, unrealEnvelope(other)), Error, /envelope invalid: artifact-bytes/, 'bytes that are not the bound bytes');
});

test('RFC sections 4 and 5: bytes, budget, media types, source paths and the identity of an export', () => {
  const size = Buffer.byteLength(BYTES);
  for (const bytes of [BYTES, Buffer.from(BYTES), new Uint8Array(Buffer.from(BYTES))]) assert.equal(make({}, bytes).artifact.size_bytes, size);
  for (const bytes of [new ArrayBuffer(size), size, null, {}]) refused(() => make({}, bytes), TypeError, /UTF-8 string, Buffer, or Uint8Array/, 'something that is not bytes');
  refused(() => make({}, Buffer.from([0xff, 0xfe, 0x7b, 0x7d])), Error, /valid UTF-8/, 'bytes that are not UTF-8');
  assert.equal(make({ maxBytes: size }).artifact.size_bytes, size);
  refused(() => make({ maxBytes: size - 1 }), RangeError, /exceeds byte budget/, 'one byte over the budget');
  refused(() => make({ maxBytes: 5 }, 'x'.repeat(40)), RangeError, /exceeds byte budget/, 'the budget is applied before the JSON is read');
  refused(() => make({ maxBytes: 0 }), TypeError, /positive safe integer/, 'a budget of zero');
  refused(() => X.parseUnityTextScene(UNITY_TEXT, { path: 'Assets/Main.unity', maxBytes: 10 }), RangeError, /exceeds byte budget/, 'a source over the budget');
  assert.equal(E.createNativeSourceRef('x', { path: 'a.txt' }).artifact.media_type, 'text/plain');
  assert.equal(E.createNativeSourceRef('x', { path: 'a.txt', mediaType: 'image/svg+xml' }).artifact.media_type, 'image/svg+xml');
  assert.equal(E.createNativeSourceRef('x', { path: 'a.txt', mediaType: 'text/plain;charset=utf-8' }).artifact.media_type, 'text/plain;charset=utf-8', 'a parameter written without white space is accepted as it stands, nothing parses it');
  for (const mediaType of ['text/plain; charset=utf-8', 'textplain', 'text/pl ain', `text/plain${String.fromCharCode(0xa0)}`]) refused(() => E.createNativeSourceRef('x', { path: 'a.txt', mediaType }), TypeError, /media type is invalid/, `media type ${JSON.stringify(mediaType)}`);
  for (const bad of ['', '.', '..', 'a/../b', 'a//b', '/a', 'a\\b', 'C:/a', `a${String.fromCharCode(0)}b`, './a', 'a/.', 'a/b/']) refused(() => E.createNativeSourceRef('x', { path: bad }), TypeError, /source path/, `source path ${JSON.stringify(bad)}`);
  assert.equal(E.createNativeSourceRef('x', { path: 'a/b.txt' }).path, 'a/b.txt');
  const first = E.createNativeSourceRef('a', { path: 'a.txt' });
  const second = E.createNativeSourceRef('b', { path: 'b.txt' });
  assert.deepEqual(make({ evidenceClass: 'source-export', sourceInputs: [second, first] }).source_inputs.map((input) => input.path), ['a.txt', 'b.txt']);
  refused(() => make({ evidenceClass: 'source-export', sourceInputs: [first, first] }), TypeError, /duplicate source input path/, 'a path twice');
  refused(() => make({ evidenceClass: 'source-export' }), TypeError, /requires at least one exact source input/, 'a source export without sources');
  const free = make({ engineVersion: 'any text 5.4 (custom)', platform: 'weird/platform' });
  assert.deepEqual([free.engine_version, free.platform], ['any text 5.4 (custom)', 'weird/platform']);
  const bound = make();
  assert.equal(bound.artifact.byte_sha256, createHash('sha256').update(BYTES).digest('hex'));
  assert.equal(bound.artifact.size_bytes, size);
  assert.notEqual(make({}, '{ "schema": "x" }').artifact.byte_sha256, bound.artifact.byte_sha256, 'the same JSON formatted differently is another artifact');
  const edited = structuredClone(bound);
  edited.payload_descriptor = { declared_schema: 'other', top_level_keys: [] };
  edited.extra = 1;
  delete edited.engine_version;
  assert.deepEqual(E.verifyNativeExportEnvelope(edited), { valid: true, errors: [] }, 'the verifier does not look at the descriptor, extra keys or the engine version');
  const unbound = structuredClone(bound);
  unbound.artifact.byte_sha256 = 'f'.repeat(64);
  assert.deepEqual(E.verifyNativeExportEnvelope(unbound), { valid: true, errors: [] }, 'a hash that fits no bytes is valid until bytes are passed');
  assert.deepEqual(E.verifyNativeExportEnvelope(unbound, { sourceBytes: BYTES }), { valid: false, errors: ['artifact-bytes'] });
  assert.deepEqual(E.verifyNativeExportEnvelope(bound, { sourceBytes: BYTES }), { valid: true, errors: [] });
  const sourced = make({ evidenceClass: 'source-export', sourceInputs: [first] });
  assert.deepEqual(E.verifyNativeExportEnvelope(sourced, { sourceInputBytes: {} }).errors, ['source_input_bytes.missing:a.txt']);
  assert.deepEqual(E.verifyNativeExportEnvelope(sourced, { sourceInputBytes: { 'a.txt': 'zzz' } }).errors, ['source_input_bytes.mismatch:a.txt']);
  assert.deepEqual(E.verifyNativeExportEnvelope(sourced, { sourceInputBytes: { 'a.txt': 'a' } }), { valid: true, errors: [] });
});

test('RFC section 4: five entry points apply the byte budget, three take bytes of any size', () => {
  assert.deepEqual(GEN_PROBLEMS, []);
  assert.deepEqual(BUDGET, { buildGodotTextSceneExport: true, buildUnityTextSceneExport: true, createNativeExportEnvelope: true, createNativeSourceRef: false, normalizeNativeStructureExport: false, parseGodotTextScene: true, parseUnityTextScene: true, verifyNativeExportEnvelope: false });
  const takingBytes = Object.keys(FILES).flatMap((key) => functionsOf(key).filter((name) => /\bsourceBytes\b/.test(NS[key][name].toString())));
  assert.deepEqual(sorted(takingBytes), sorted(Object.keys(BUDGET)), 'every exported function that takes bytes has been offered the over-budget input');
  // The two without a budget answer for 8 MiB + 1 bytes, while the default budget refuses the same bytes elsewhere.
  assert.equal(E.createNativeSourceRef(OVER_BUDGET, { path: 'a.txt' }).artifact.size_bytes, 8 * MIB + 1);
  assert.equal(verified(BIG_ENVELOPE, OVER_BUDGET).valid, true);
  const structure = N.normalizeNativeStructureExport(OVER_STRUCTURE, envelopeOf(OVER_STRUCTURE, { maxBytes: 9 * MIB }));
  assert.equal(structure.source_artifact.size_bytes, 8 * MIB + 1);
  assert.equal(structure.status, 'declared-structure-only');
  refused(() => envelopeOf(OVER_BUDGET), RangeError, /exceeds byte budget/, 'the same bytes as an export with the default budget');
  refused(() => X.parseUnityTextScene(OVER_BUDGET, { path: 'Assets/Main.unity' }), RangeError, /exceeds byte budget/, 'the same bytes as a source');
  // The sentence is generated from the answers: a function that changes its answer is reported against the unchanged RFC.
  for (const name of ['createNativeSourceRef', 'normalizeNativeStructureExport', 'verifyNativeExportEnvelope', 'parseUnityTextScene', 'createNativeExportEnvelope']) {
    const flipped = budgetPhrase({ ...BUDGET, [name]: !BUDGET[name] });
    assert.notEqual(flipped, budgetPhrase(BUDGET));
    assert.ok(docsProblems(DOCS, { ...EXPECT, phrases: EXPECT.phrases.map((p) => (p === budgetPhrase(BUDGET) ? flipped : p)) }).some((p) => /phrases: missing "The budget/.test(p)), `${name}: a changed answer is not reported`);
  }
});

test('RFC section 5: ids of the structure are names inside one export, and a second declaration of an id is refused', () => {
  for (const [engine, structure] of Object.entries(STRUCT)) {
    const ids = [...structure.nodes.map((n) => n.id), ...structure.relations.map((r) => r.id), ...(structure.declarations.signals ?? []).map((s) => s.id)];
    assert.ok(ids.length > 0 && ids.every((id) => id.startsWith(`${engine}:`)), `${engine}: ids ${ids.join(' ')}`);
    assert.equal(new Set(ids).size, ids.length, `${engine}: an id appears twice`);
  }
  const twice = JSON.stringify({ schema: UNREAL_PROFILE, types: [UNREAL_HERO, UNREAL_HERO] });
  refused(() => N.normalizeNativeStructureExport(twice, unrealEnvelope(twice)), Error, /duplicate native node id: unreal:/, 'the same Unreal type twice');
  const copy = structuredClone(STRUCT.unity);
  copy.nodes.push(copy.nodes[0]);
  copy.relations.push(copy.relations[0]);
  assert.deepEqual(N.verifyNativeStructureInvariants(copy).errors, ['nodes.duplicate-id', 'relations.duplicate-id']);
});

test('RFC section 6: a partial reading succeeds, and its diagnostics are in neither the envelope, the payload nor the structure', () => {
  for (const [engine, build, partialText, complete, file] of [['unity', X.buildUnityTextSceneExport, UNITY_PARTIAL, UNITY, 'Assets/Main.unity'], ['godot', X.buildGodotTextSceneExport, GODOT_PARTIAL, GODOT, 'scenes/main.tscn']]) {
    const partial = build(partialText, { path: file, ...COMMON });
    assert.ok(partial.diagnostics.length > 0, `${engine}: the partial sample has diagnostics`);
    const structure = N.normalizeNativeStructureExport(partial.payload_bytes, partial.envelope);
    for (const part of [partial.envelope, partial.payload, structure]) assert.ok(!/UNMODELED/.test(JSON.stringify(part)), `${engine}: a diagnostic leaked`);
    assert.deepEqual([partial.envelope.status, structure.status, Object.keys(partial.payload)], [complete.envelope.status, STRUCT[engine].status, Object.keys(complete.payload)], `${engine}: partial and complete look alike`);
  }
  for (const diagnostic of DIAGNOSTICS) assert.equal(diagnostic.section !== undefined, /SECTION/.test(diagnostic.code), `${diagnostic.code}: the section key belongs to the section diagnostic only`);
  refused(() => X.buildUnityTextSceneExport(UNITY_TEXT, { path: 'Assets/Main.txt', ...COMMON }), TypeError, /must end in/, 'a Unity path of another kind');
  refused(() => X.buildGodotTextSceneExport(UNITY_TEXT, { path: 'scenes/main.tscn', ...COMMON }), Error, /gd_scene/, 'Unity text read as Godot');
});

test('RFC section 7: the legacy scan classifies as the RFC says, and the contract and its check behave as stated', () => {
  const status = Object.fromEntries(Object.entries(SCANS).map(([name, scan]) => [name, scan.completeness.status]));
  assert.deepEqual(status, { blocked: 'blocked', sceneless: 'partial', idle: 'partial', system: 'complete', loop: 'complete', input: 'complete' });
  assert.deepEqual(Object.fromEntries(Object.entries(SCANS).map(([name, scan]) => [name, warningCodes(scan)])), {
    blocked: ['WEBGAME_ENGINE_NOT_DETECTED'],
    sceneless: ['WEBGAME_SCENE_UNRESOLVED'],
    idle: ['WEBGAME_SIMULATION_LOOP_UNRESOLVED'],
    system: [],
    loop: [],
    input: ['WEBGAME_INPUT_EFFECT_UNRESOLVED']
  });
  assert.equal(SCANS.system.schema, 'sbf.webgame-scan/1');
  assert.equal(CONTRACT.sbf_webgame_contract, C.WEBGAME_CONTRACT_VERSION);
  const damaged = makeRepo({}, 'const x = 1;\n');
  fs.writeFileSync(path.join(damaged, 'package.json'), '{not json');
  assert.deepEqual([S.scanWebgame(damaged).completeness.status, warningCodes(S.scanWebgame(damaged))], ['blocked', ['WEBGAME_ENGINE_NOT_DETECTED']], 'a damaged manifest looks like an unsupported engine');
  assert.equal(S.detectWebgameProjects(makeRepo({ phaser: '3', '@babylonjs/core': '7' }, 'x')).length, 0);
  refused(() => C.buildWebgameContract({ ...IDENTITY, scan: SCANS.blocked }), Error, /no supported webgame engine was detected/, 'a blocked scan');
  const partial = C.buildWebgameContract({ ...IDENTITY, scan: SCANS.idle });
  assert.deepEqual([partial.completeness.status, partial.warnings.map((w) => w.code ?? w)], ['partial', warningCodes(SCANS.idle)]);
  assert.equal(C.buildWebgameContract({ featureId: 'x', featureUid: 'not-a-uuid', scan: SCANS.system }).feature_uid, 'not-a-uuid', 'the contract copies the feature uid unchecked');
  assert.deepEqual([SNAPSHOT.current, SNAPSHOT.changes], [true, []]);
  assert.equal(CHANGED.current, false);
  assert.ok(CHANGED.changes.length > 0 && CHANGED.changes.every((change) => same(Object.keys(change), ['field', 'expected', 'actual'])));
  assert.ok(CHANGED.changes.some((change) => change.field === 'feature_id'));
});

// ---- negative tests: each edit of an in-memory copy of a document (or of the expected answers) has to be reported ----
const edit = (docName, change) => ({ ...DOCS, [docName]: change(DOCS[docName]) });
const NUMBERED = ['PR', '12'].join(' ');
const MUTATIONS = [
  ['a row of the engine table is removed', 'rfc', (t) => t.replace(/^\| `godot` .*\n/m, ''), /tables: the engines table differs/],
  ['a constant value is changed', 'rfc', (t) => t.replace(/(`NATIVE_STRUCTURE_REVISION` \| )\d+/, '$17'), /tables: the constants table differs/],
  ['a function is renamed in the table', 'rfc', (t) => t.replace('| `scanWebgame` |', '| `scanWebgameProject` |'), /tables: the functions table differs/],
  ['a key is dropped from a key list', 'rfc', (t) => t.replace('Source input and source reference {path, role, artifact}', 'Source input and source reference {path, artifact}'), /phrases: missing "Source input and source reference/],
  ['a key is invented', 'rfc', (t) => t.replace('{line, code}', '{line, code, severity}'), /braces \{line, code, severity\}/],
  ['a verifier token is lost', 'rfc', (t) => t.replace('`artifact-bytes`, ', ''), /phrases: missing "`verifyNativeExportEnvelope` reports tokens/],
  ['a required option is dropped', 'rfc', (t) => t.replace('`engine`, `evidenceClass`, ', '`engine`, '), /phrases: missing "Required options/],
  ['the default role changes', 'rfc', (t) => t.replace('`active` (the default)', '`active`'), /phrases: missing "Source roles/],
  ['an engine is no longer named', 'rfc', (t) => t.replaceAll('`unreal`', 'unreal'), /coverage: the code has unreal/],
  ['a diagnostic code is no longer named', 'rfc', (t) => t.replaceAll('`UNITY_UNMODELED_LINE`', 'UNITY_UNMODELED_LINE'), /coverage: the code has UNITY_UNMODELED_LINE/],
  ['an exported name that does not exist is invented', 'rfc', (t) => `${t}\nThe bridge is \`projectWebgameIntoGameGraph\`.\n`, /`projectWebgameIntoGameGraph` is not a name that the code/],
  ['a file that does not exist is cited', 'readme', (t) => `${t}\nSee \`legacy-webgame-bridge.mjs\`.\n`, /`legacy-webgame-bridge.mjs` is not a file of this repository/],
  ['a file name is written without backticks', 'integration', (t) => `${t}\nSee native-export-envelope.mjs for details.\n`, /native-export-envelope.mjs is written without backticks/],
  ['a limit that the record does not have is cited', 'rfc', (t) => t.replace('limit `bridge-is-described-but-not-on-main`', 'limit `bridge-is-invented-by-hand`'), /does not record|looks like a limit id/],
  ['a pull request is named by number', 'integration', (t) => `${t}\nSee ${NUMBERED}.\n`, /names a pull request or an issue by number/],
  ['a budget that the code does not apply', 'rfc', (t) => t.replace('8 MiB', '9 MiB'), /states a budget of 9 MiB/],
  ['the budget sentence is made blanket again', 'rfc', (t) => t.replace(/The budget \(option `maxBytes`, 8 MiB by default\) is applied[^.]*\./, 'An export or a source above the budget (option `maxBytes`, 8 MiB by default) is refused before it is read.'), /phrases: missing "The budget/],
  ['a function without a budget is listed as bounded', 'rfc', (t) => t.replace('`parseGodotTextScene` and `parseUnityTextScene`; `createNativeSourceRef`, `normalizeNativeStructureExport` and `verifyNativeExportEnvelope` have no budget', '`parseGodotTextScene`, `parseUnityTextScene` and `createNativeSourceRef`; `normalizeNativeStructureExport` and `verifyNativeExportEnvelope` have no budget'), /phrases: missing "The budget/],
  ['a parameter without white space is said to be refused', 'rfc', (t) => t.replace('text/plain;charset=utf-8 is accepted', 'text/plain;charset=utf-8 is refused'), /phrases: missing "text\/plain;charset=utf-8 is accepted"/],
  ['a space after the semicolon is said to be accepted', 'rfc', (t) => t.replace('text/plain; charset=utf-8 is refused', 'text/plain; charset=utf-8 is accepted'), /phrases: missing "text\/plain; charset=utf-8 is refused"/],
  ['a fenced block is added', 'readme', (t) => `${t}\n${'`'.repeat(3)}\nnode x\n${'`'.repeat(3)}\n`, /has a fenced block/],
  ['a command names a test file that does not exist', 'readme', (t) => t.replace('node --test test/game-next/native-structure-media-type.test.mjs', 'node --test test/game-next/no-such.test.mjs'), /names test files that do not exist/],
  ['the runner line is stale', 'readme', (t) => t.replace(/`NESTED_SUITE T17 RUN \d+ files`/, '`NESTED_SUITE T17 RUN 7 files`'), /is not the runner line that BASELINE.json records/],
  ['a suite is named that the runner does not have', 'readme', (t) => t.replace('scripts/run-next-nested-tests.mjs T17', 'scripts/run-next-nested-tests.mjs T99'), /names the suite T99/],
  ['the README points at another section', 'readme', (t) => t.replace('section 3 of', 'section 4 of'), /README.md: missing "\(section 3 of/],
  ['a heading is lost', 'rfc', (t) => t.replace('## 6. Unknown, partial and unsupported\n', ''), /layout: the headings/],
  ['the RFC grows past 120 lines', 'rfc', (t) => `${t}${'x\n'.repeat(30)}`, /layout: \d+ lines, the RFC keeps to 120/],
  ['an owner is changed', 'rfc', (t) => t.replace('| `contracts/next` | T01 |', '| `contracts/next` | T17 |'), /ownership: contracts\/next is listed for T17/],
  ['T17 is allowed to edit a path it does not own', 'rfc', (t) => t.replace('| T01 | none, no import |', '| T01 | edit |'), /cannot be allowed to edit/],
  ['a reserved path is listed as stable surface', 'rfc', (t) => t.replace('`test/webgame-contract.test.mjs` | stable surface', '`test/webgame-contract.test.mjs`, `package.json` | stable surface'), /ownership: package.json is listed as stable surface/],
  ['a path that does not exist is listed', 'rfc', (t) => t.replace('`lib/trust-next`', '`lib/trust-nxt`'), /ownership: lib\/trust-nxt does not exist/],
  ['a directory listing loses a file', 'rfc', (t) => t.replace('`README.md`, `native-export-envelope.mjs`', '`native-export-envelope.mjs`'), /phrases: missing "`adapters\/game-next` holds exactly/],
  ['the claim about other engines is dropped', 'rfc', (t) => t.replace('a project that declares only another engine package is not found', 'any engine package is found'), /phrases: missing "a project is found only when/]
];
test('the checks can fail: every edit of a copy of a document is reported with a named reason', () => {
  assert.ok(MUTATIONS.length >= 25);
  for (const [name, docName, change, expected] of MUTATIONS) {
    const docs = edit(docName, change);
    assert.notEqual(docs[docName], DOCS[docName], `${name}: the edit changed nothing`);
    const problems = docsProblems(docs);
    assert.ok(problems.some((problem) => expected.test(problem)), `${name}: no problem matches ${expected}; got ${JSON.stringify(problems.slice(0, 3))}`);
  }
});
test('the checks can fail: a code answer that changed is reported against the unchanged documents', () => {
  const engines = [...EXPECT.tables.engines, '| `bevy` | `source-export` | `sbf.game-bevy-scene-export/draft-1` |'];
  assert.ok(docsProblems(DOCS, { ...EXPECT, tables: { ...EXPECT.tables, engines } }).some((p) => /tables: the engines table differs/.test(p)));
  assert.ok(docsProblems(DOCS, { ...EXPECT, phrases: [...EXPECT.phrases, 'a sentence the document does not have'] }).some((p) => /phrases: missing "a sentence the document does not have"/.test(p)));
  assert.ok(docsProblems(DOCS, { ...EXPECT, coverage: [...EXPECT.coverage, 'newExportedFunction'] }).some((p) => /coverage: the code has newExportedFunction/.test(p)));
  assert.ok(docsProblems(DOCS, { ...EXPECT, headings: EXPECT.headings.slice(1) }).some((p) => /layout: the headings/.test(p)));
  const flipped = EXPECT.phrases.map((p) => (p === 'text/plain;charset=utf-8 is accepted' ? 'text/plain;charset=utf-8 is refused' : p));
  assert.ok(docsProblems(DOCS, { ...EXPECT, phrases: flipped }).some((p) => /phrases: missing "text\/plain;charset=utf-8 is refused"/.test(p)), 'a media type that changes its verdict is reported against the unchanged RFC');
  assert.deepEqual(docsProblems(DOCS), [], 'the unedited documents have no problem');
});
