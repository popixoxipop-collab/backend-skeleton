// T14-02: checks the interface RFC (handles/composition-next/INTERFACE_RFC.md) against the vocabulary file beside this test and
// against the code. Three things must agree: what the code does, what interface-rfc.vocabulary.json pins, and what the RFC says.
// Everything that reads the code sits between BEGIN derive and END derive; the vocabulary is written by running that section.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as lib from './baseline-record-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DIR = 'handles/composition-next';
const TESTS = 'test/provider-composition-next';
const RFC_FILE = path.join(ROOT, DIR, 'INTERFACE_RFC.md');
const VOCAB_FILE = path.join(HERE, 'interface-rfc.vocabulary.json');

// BEGIN derive
const REV = 'a'.repeat(40);
const PROFILE = 'legacy-http-fixture/1';
const PROVIDERS = ['java-spring', 'python-fastapi', 'typescript-express'];
const H = (c) => c.repeat(64);

// The JSON byte rule of the evidence boundary, written again here: key sorted, two spaces, one trailing newline.
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
}
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(sorted(value), null, 2)}\n`, 'utf8');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const hashJson = (value) => sha(jsonBytes(value));
const refOf = (bytes, family, version) => ({ artifact_ref: 'sbf.artifact-ref/1', family, version, media_type: 'application/json', byte_sha256: sha(bytes), size_bytes: bytes.length });
const seal = (doc, family, version, bytes = jsonBytes(doc)) => ({ bytes, ref: refOf(bytes, family, version) });
const clone = (value) => (Buffer.isBuffer(value) ? Buffer.from(value) : Array.isArray(value) ? value.map(clone) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) : value);

// A complete, consistent set of inputs that every evidence inspector accepts. The elicitation below damages one value at a time.
function documents(combination) {
  const binding = {
    runtime_binding: 'beval.runtime-binding/1', run_id: 'run-001', case_revision_hash: H('1'), oracle_profile_approval_hash: H('2'),
    contract_hash: H('3'), flow_hash: H('4'), config_hash: H('5'), candidate_hash: H('c'), original_hash: H('6'),
    runner_implementation_hash: H('7'), runtime_execution_policy_hash: H('8'), artifacts: { fixture: H('9') },
    attempt_nonce: '11111111-1111-4111-8111-111111111111'
  };
  const evidenceDoc = (target) => ({
    execution_evidence: 'beval.execution-evidence/1', target, contract_hash: binding.contract_hash, operations: ['001-demo:getUser'],
    exchanges: [{ operation: '001-demo:getUser', status: 200, schema_verdict: 'valid' }],
    flow_runs: [{ id: 'read', assertions: [{ step: 0, passed: true, code: null }] }]
  });
  const oracle = evidenceDoc('oracle');
  const candidate = evidenceDoc('candidate');
  const pair = {
    runtime_evidence_pair: 'beval.runtime-evidence-pair/1', family: 'http', runtime_binding_hash: hashJson(binding), attempt_nonce: binding.attempt_nonce,
    oracle_evidence_hash: hashJson(oracle), candidate_evidence_hash: hashJson(candidate)
  };
  const handoff = {
    contract: 'sbf.persistence-generation-handoff/1', status: 'ready', providerId: combination.providerId, persistenceId: combination.persistenceId,
    keyType: combination.keyType, resourceId: 'users', entityId: 'entity:user', blockers: []
  };
  const evidence = {
    evidence: 'bskel.internal.handles-composition-evidence/0', kind: 'package-install', revision: REV, status: 'success', provider_id: combination.providerId,
    combination_id: combination.id, profile_id: PROFILE, execution_ref: 'ci:package-install:run-001', assertions: null
  };
  const projection = (sealed) => ({
    candidateRevision: REV, combinationId: combination.id, profileId: PROFILE, profileApprovalHash: binding.oracle_profile_approval_hash,
    runtimeBindingHash: pair.runtime_binding_hash, runtimeBindingArtifactSha256: sealed.binding.ref.byte_sha256, evidencePairArtifactSha256: sealed.pair.ref.byte_sha256,
    oracleEvidenceArtifactSha256: sealed.oracle.ref.byte_sha256, candidateEvidenceArtifactSha256: sealed.candidate.ref.byte_sha256, candidateArtifactSha256: binding.candidate_hash,
    runId: binding.run_id, attemptNonce: binding.attempt_nonce, executionRef: 'beval-run:run-001', verdict: 'success', producerApproval: 'accepted',
    assertions: { expected: 1, executed: 1, passed: 1, failed: 0, unresolved: 0 }
  });
  return { combination, binding, oracle, candidate, pair, handoff, evidence, projection };
}

// Elicitation: the vocabulary is what the code emits when it is called, so the inspectors are called with one value damaged at a
// time (every path of every document, every replacement below) and each blocker code, status, thrown message and error string
// that comes back is recorded. A value that no probe reaches is listed as not reached instead of being assumed.
const REPLACEMENTS = [undefined, null, 0, 7, -1, 1.5, '', 'x', 'invalid', true, false, [], ['x'], {}, '0'.repeat(40), '0'.repeat(64)];
const WHOLE = [undefined, null, [], 7, 'x', true];

function pathsOf(value, prefix = []) {
  const out = [];
  if (Array.isArray(value)) value.forEach((item, i) => out.push([...prefix, i], ...pathsOf(item, [...prefix, i])));
  else if (value && typeof value === 'object' && !Buffer.isBuffer(value)) for (const [key, item] of Object.entries(value)) out.push([...prefix, key], ...pathsOf(item, [...prefix, key]));
  return out;
}
function damaged(doc, at, replacement) {
  const copy = clone(doc);
  let node = copy;
  for (const key of at.slice(0, -1)) node = node[key];
  const last = at[at.length - 1];
  if (replacement === undefined) { if (Array.isArray(node)) node.splice(last, 1); else delete node[last]; } else node[last] = replacement;
  return copy;
}
// Every one-value change of a document, the document replaced by a value of another type, and one unexpected extra field.
function* variants(doc) {
  for (const at of pathsOf(doc)) for (const replacement of REPLACEMENTS) yield damaged(doc, at, replacement);
  for (const whole of WHOLE) yield whole;
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) yield { ...clone(doc), zz_extra: 1 };
}

function recorder() {
  const rec = { codes: {}, extra: {}, statuses: {}, shapeStatuses: {}, thrown: {}, errors: {}, shapes: {}, schemas: {}, flags: {}, results: 0 };
  const add = (bag, name, value) => { (bag[name] ??= new Set()).add(value); };
  const scan = (name, blockers, depth = 0) => {
    for (const item of Array.isArray(blockers) ? blockers : []) {
      add(rec.codes, name, item.code);
      for (const key of Object.keys(item).filter((k) => !['code', 'message'].includes(k))) add(rec.extra, item.code, key);
      if (Array.isArray(item.reasons) && depth < 2) scan(`${name}.reasons`, item.reasons, depth + 1);
    }
  };
  rec.result = (name, result) => {
    rec.results += 1;
    if (Array.isArray(result)) add(rec.shapes, name, 'array');
    else if (result && typeof result === 'object') {
      add(rec.shapes, name, Object.keys(result).join(','));
      if (typeof result.status === 'string') add(rec.statuses, name, result.status);
      if (typeof result.schema === 'string') add(rec.schemas, name, result.schema);
      if ('applyAllowed' in result) add(rec.flags, `${name}.applyAllowed`, String(result.applyAllowed));
      if (typeof result.ok === 'boolean') add(rec.statuses, `${name}.ok`, String(result.ok));
      if (typeof result.status === 'string') add(rec.shapeStatuses, `${name}|${Object.keys(result).join(',')}`, result.status);
      else if (typeof result.ok === 'boolean') add(rec.shapeStatuses, `${name}|${Object.keys(result).join(',')}`, `ok=${result.ok}`);
      scan(name, result.blockers);
    }
  };
  rec.call = (name, fn, input) => {
    try { rec.result(name, fn(input)); } catch (error) { add(rec.thrown, name, `${error.name}: ${error.message}`); }
  };
  rec.errorStrings = (name, list) => { for (const item of Array.isArray(list) ? list : []) add(rec.errors, name, String(item)); };
  return rec;
}

function elicitEvidence(M, combination, rec, fuzz = true) {
  const V = (doc) => (fuzz ? variants(doc) : []);
  const d = documents(combination);
  const expected = { ...combination, candidateRevision: REV, profileId: PROFILE };
  const FAMILY = { evidence: ['bskel-handles-composition-evidence', '0'], handoff: ['bskel-persistence-generation-handoff', '1'], binding: ['beval-runtime-binding', '1'], pair: ['beval-runtime-evidence-pair', '1'], execution: ['beval-execution-evidence', '1'] };
  const bytesVariants = (sealed) => [7, null, undefined, Buffer.from('not json'), Buffer.from(`${sealed.bytes}x`), Buffer.from(JSON.stringify(JSON.parse(sealed.bytes.toString('utf8')))), new Uint8Array(sealed.bytes), sealed.bytes.toString('utf8'), Buffer.from('[]\n'), Buffer.from('null\n')];

  // validateBoundCertificationEvidence
  const validate = (over) => rec.call('validateBoundCertificationEvidence', M.evidence.validateBoundCertificationEvidence, { expectedKind: 'package-install', revision: REV, providerId: combination.providerId, combinationId: combination.id, profileId: PROFILE, ...over });
  const ev = seal(d.evidence, ...FAMILY.evidence);
  validate({ evidence: { bytes: ev.bytes, artifactRef: ev.ref } });
  for (const doc of V(d.evidence)) { const s = seal(doc, ...FAMILY.evidence); validate({ evidence: { bytes: s.bytes, artifactRef: s.ref } }); }
  for (const bytes of bytesVariants(ev)) validate({ evidence: { bytes, artifactRef: ev.ref } });
  for (const bytes of bytesVariants(ev)) { try { validate({ evidence: { bytes, artifactRef: refOf(Buffer.from(bytes ?? ''), ...FAMILY.evidence) } }); } catch { /* a non-byte value has no reference */ } }
  for (const ref of V(ev.ref)) validate({ evidence: { bytes: ev.bytes, artifactRef: ref } });
  for (const evidence of WHOLE) validate({ evidence });
  for (const over of [{ expectedKind: 'other' }, { revision: 'b'.repeat(40) }, { revision: null }, { providerId: 'other' }, { combinationId: 'other' }, { profileId: '' }, { profileId: null }, { profileId: 'other' }]) validate({ ...over, evidence: { bytes: ev.bytes, artifactRef: ev.ref } });
  const assertionsDoc = (assertions) => { const s = seal({ ...d.evidence, assertions }, ...FAMILY.evidence); return { bytes: s.bytes, artifactRef: s.ref }; };
  for (const assertions of [{ expected: 1, executed: 1, passed: 1, failed: 0, unresolved: 0 }, { expected: -1, executed: 1.5, passed: '1', failed: null, unresolved: 0 }, { expected: 1 }, []]) validate({ evidence: assertionsDoc(assertions) });

  // inspectPersistenceHandoff
  const hs = seal(d.handoff, ...FAMILY.handoff);
  const provenance = { status: 'accepted', producerRevision: 'b'.repeat(40), candidateRevision: REV, providerId: combination.providerId, combinationId: combination.id, profileId: PROFILE, executionRef: 't10-live-read:fixture-001', artifactRef: hs.ref };
  const persist = (over) => rec.call('inspectPersistenceHandoff', M.evidence.inspectPersistenceHandoff, { expected, handoffBytes: hs.bytes, handoffRef: hs.ref, provenance, ...over });
  persist({});
  for (const doc of V(d.handoff)) { const s = seal(doc, ...FAMILY.handoff); persist({ handoffBytes: s.bytes, handoffRef: s.ref, provenance: { ...provenance, artifactRef: s.ref } }); }
  for (const bytes of bytesVariants(hs)) persist({ handoffBytes: bytes });
  for (const ref of V(hs.ref)) persist({ handoffRef: ref });
  for (const p of V(provenance)) persist({ provenance: p });
  for (const e of V(expected)) persist({ expected: e });

  // inspectRuntimeBehaviorProjection
  const sealed = { binding: seal(d.binding, ...FAMILY.binding), pair: seal(d.pair, ...FAMILY.pair), oracle: seal(d.oracle, ...FAMILY.execution), candidate: seal(d.candidate, ...FAMILY.execution) };
  const projection = d.projection(sealed);
  const parts = (s) => ({ bindingBytes: s.binding.bytes, bindingRef: s.binding.ref, pairBytes: s.pair.bytes, pairRef: s.pair.ref, oracleEvidenceBytes: s.oracle.bytes, oracleEvidenceRef: s.oracle.ref, candidateEvidenceBytes: s.candidate.bytes, candidateEvidenceRef: s.candidate.ref });
  const runtime = (over) => rec.call('inspectRuntimeBehaviorProjection', M.evidence.inspectRuntimeBehaviorProjection, { expected, ...parts(sealed), projection, ...over });
  runtime({});
  const slots = { binding: ['bindingBytes', 'bindingRef', d.binding, FAMILY.binding], pair: ['pairBytes', 'pairRef', d.pair, FAMILY.pair], oracle: ['oracleEvidenceBytes', 'oracleEvidenceRef', d.oracle, FAMILY.execution], candidate: ['candidateEvidenceBytes', 'candidateEvidenceRef', d.candidate, FAMILY.execution] };
  for (const [name, [bytesKey, refKey, doc, family]] of Object.entries(slots)) {
    for (const variant of V(doc)) { const s = seal(variant, ...family); runtime({ [bytesKey]: s.bytes, [refKey]: s.ref }); }
    for (const bytes of bytesVariants(sealed[name])) runtime({ [bytesKey]: bytes });
    for (const ref of V(sealed[name].ref)) runtime({ [refKey]: ref });
  }
  for (const p of V(projection)) runtime({ projection: p });
  for (const e of V(expected)) runtime({ expected: e });
  const failing = (mutate) => { const doc = clone(d.candidate); mutate(doc); const s = seal(doc, ...FAMILY.execution); runtime({ candidateEvidenceBytes: s.bytes, candidateEvidenceRef: s.ref }); };
  failing((doc) => { doc.exchanges[0].schema_verdict = 'error'; });
  failing((doc) => { doc.flow_runs[0].assertions = []; });
  failing((doc) => { doc.flow_runs[0].assertions[0].passed = false; });
  failing((doc) => { doc.flow_runs[0].assertions[0].passed = 'maybe'; });
  failing((doc) => { doc.flow_runs.push(null); });
  failing((doc) => { doc.state_hash = H('d'); });
  return { documents: d, expected, persistenceHandoff: { handoffBytes: hs.bytes, handoffRef: hs.ref, provenance }, runtimeBehavior: { ...parts(sealed), projection } };
}

const stubProvider = (id, over = {}) => ({ id, contract: 'sbf.handles-provider/1', requiresCapabilities: ['resource.fetch'], outputs: { spec: ['handles/migration.sql'] }, plan() { return {}; }, emit() { return {}; }, ...over });

function elicitAudit(M, rec) {
  const triple = (patches = []) => PROVIDERS.map((id, i) => stubProvider(id, patches[i] ?? {}));
  const audit = (providers, options) => { const result = M.legacy.auditLegacyProviders(providers, options); rec.result('auditLegacyProviders', result); rec.errorStrings('auditLegacyProviders', result.errors); return result; };
  const good = audit(triple(), { revision: REV });
  audit([], { revision: REV });
  audit(null);
  audit(undefined, {});
  audit([stubProvider('java-spring')]);
  audit([null, undefined, {}, 'x']);
  for (const patch of [{ contract: 'sbf.handles-provider/2' }, { contract: undefined }, { requiresCapabilities: [] }, { requiresCapabilities: 'resource.fetch' }, { requiresCapabilities: undefined }, { requiresCapabilities: ['resource.fetch', 'resource.patch'] }, { outputs: { spec: [] } }, { outputs: { spec: 'x' } }, { outputs: {} }, { outputs: undefined }, { plan: null }, { emit: 'emit' }]) {
    for (let at = 0; at < 3; at += 1) audit(triple(PROVIDERS.map((_, i) => (i === at ? patch : {}))), { revision: REV });
  }
  audit([...triple(), stubProvider('future-provider')]);
  return { good, ids: M.legacy.LEGACY_PROVIDER_IDS };
}

function elicitSafety(M, rec) {
  const plan = { resources: [{ type: 'User', willGenerateResolver: true, idFieldIsUuid: true }, { type: 'Legacy', willGenerateResolver: false, idFieldIsUuid: false }, { type: 'Key', willGenerateResolver: true, idFieldIsUuid: false }] };
  const out = { profiles: {}, resultKeys: new Set(), decisionKeys: new Set(), manualKeys: new Set(), reasons: new Set(), areas: new Set(), columns: new Set(), manualReasons: new Set() };
  for (const providerId of PROVIDERS) {
    const result = M.safety.describeResourceGeneration({ providerId, handlesPlan: plan });
    rec.result('describeResourceGeneration', result);
    out.resultKeys.add(Object.keys(result).join(','));
    const generated = result.decisions.find((d) => d.generated);
    out.profiles[providerId] = { fetch: generated.fetch, authorization: generated.authorization, patch: generated.patch, recover: generated.recover };
    for (const decision of result.decisions) {
      out.decisionKeys.add(Object.keys(decision).join(','));
      for (const reason of decision.reasons) out.reasons.add(reason);
      for (const column of ['fetch', 'authorization', 'patch', 'recover']) out.columns.add(decision[column]);
    }
    for (const item of result.manualCompletions) { out.manualKeys.add(Object.keys(item).join(',')); out.areas.add(item.area); out.manualReasons.add(item.reason); }
  }
  for (const args of [{ providerId: 'future-provider', handlesPlan: plan }, { providerId: undefined, handlesPlan: plan }, { providerId: 'constructor', handlesPlan: plan }]) rec.call('describeResourceGeneration', M.safety.describeResourceGeneration, args);
  return out;
}

function elicitPlan(M, combination, rec) {
  const id = combination.providerId;
  const emitted = [];
  let emitResult;
  const provider = stubProvider(id, { emit: (args) => { emitted.push(args); return emitResult; } });
  const resources = [{ type: 'User', willGenerateResolver: true, idFieldIsUuid: true }, { type: 'Legacy', willGenerateResolver: false }];
  const base = { provider, repoRoot: '/repo', featureId: 'feature-1', revision: REV, handlesPlan: { provider: id, resources }, persistenceId: combination.persistenceId, keyType: combination.keyType };
  const shapeOf = (result) => (result.forcedWrites ? 'full' : result.resourceDecisions ? 'preflight' : 'short');
  const preview = (over = {}) => {
    try {
      const result = M.plan.previewGeneration({ ...base, ...over });
      rec.result('previewGeneration', result);
      rec.result(`previewGeneration.${shapeOf(result)}`, result);
    } catch (error) { rec.call('previewGeneration', () => { throw error; }); }
  };
  const rich = { written: ['a.txt', 7], forced: ['b.txt'], actions: [{ path: 'a.txt', kind: 'file', action: 'create', resourceType: 'User' }, null, { path: 'b.txt' }], notes: ['n1', 4], postEmitNotes: ['n2'] };
  for (const result of [rich, undefined, null, { written: 'x', forced: {}, actions: 'x', notes: 7, postEmitNotes: null, conflicts: 'x', orphans: 1, registrationGaps: {} },
    { ...rich, conflicts: [{ path: 'x', reason: 'r' }, {}, null], orphans: [{ path: 'y', reason: 'o' }, {}, null], registrationGaps: [{ file: 'f', resourceType: 'User', note: 'n' }, {}, null] }]) { emitResult = result; preview(); }
  emitResult = rich;
  for (const over of [{ keyType: 'bigint' }, { persistenceId: 'prisma' }, { persistenceId: undefined }, { resourceFilter: ['Ghost'] }, { resourceFilter: ['User', 'Legacy'] }, { resourceFilter: ['Legacy'] }, { handlesPlan: { resources: [] } }, { handlesPlan: { provider: id } },
    { handlesPlan: { resources }, resourceFilter: ['User'], enforceRegistry: true }, { revision: undefined }]) preview(over);
  for (const over of [{ provider: undefined }, { provider: null }, { provider: 'x' }, { provider: {} }, { provider: { id: '', emit() {} } }, { provider: { id, emit: 'x' } }, { repoRoot: '' }, { repoRoot: 7 }, { featureId: '' }, { featureId: null }, { handlesPlan: null }, { handlesPlan: 'x' }, { handlesPlan: { provider: 'other', resources } }]) preview(over);
  return { emitted };
}

function elicitCertification(M, combination, rec, behavior, fuzz = true) {
  const providerId = combination.providerId;
  const entry = (kind, over = {}) => ({ kind, revision: REV, status: 'success', source: 'ci', runId: 'run-1', artifactRef: null, scope: { providerId, combinationId: combination.id }, ...over });
  const kinds = (level) => { try { return M.cert.requiredEvidenceFor({ providerId, level }); } catch { return []; } };
  const input = (level) => ({
    providerId, persistenceId: combination.persistenceId, keyType: combination.keyType, revision: REV, profileId: PROFILE, level,
    providerBaselineAudit: { ok: true, revision: REV },
    generationPreview: { status: 'ready', revision: REV, applyAllowed: false, providerId, combination: { id: combination.id } },
    evidence: kinds(level).map((kind) => entry(kind)),
    persistenceHandoff: behavior.persistenceHandoff, runtimeBehavior: behavior.runtimeBehavior
  });
  const run = (value) => rec.call('evaluateCompositionCertification', M.cert.evaluateCompositionCertification, value);
  const required = {};
  for (const level of ['preview-tested', 'build-tested', 'behavior-tested']) {
    required[level] = Object.fromEntries(PROVIDERS.map((id) => [id, M.cert.requiredEvidenceFor({ providerId: id, level })]));
    const base = input(level);
    run(base);
    for (const variant of (fuzz ? variants(base) : [])) run(variant);
    run({ ...base, evidence: undefined }); run({ ...base, evidence: [] }); run({ ...base, evidence: [entry(kinds(level)[0], { status: 'failed' })] });
  }
  for (const over of [{ level: 'ship-it' }, { level: undefined }, { providerId: 'future-provider', level: 'build-tested' }, { providerId: 'future-provider' }, { providerId: 'constructor', level: 'build-tested' }, { profileId: null, level: 'behavior-tested' }, { persistenceHandoff: null, runtimeBehavior: null, level: 'behavior-tested' }]) run({ ...input('behavior-tested'), ...over });
  for (const args of [{ providerId, level: 'ship-it' }, { providerId: 'future-provider', level: 'build-tested' }, { providerId: 'constructor', level: 'behavior-tested' }]) rec.call('requiredEvidenceFor', M.cert.requiredEvidenceFor, args);
  return { required, input };
}

// Static scans read the module text; nothing in a scanned file is executed by them.
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A template such as `${prefix}-evidence-json-invalid` or `unknown level "${x}"` becomes a matcher for the values it can produce.
const matcherOf = (template) => new RegExp(`^${template.split(/\$\{[^}]*\}/).map(escapeRe).join('[\\s\\S]*')}$`);
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');
const uniqueSorted = (items) => [...new Set(items)].sort();

function scanSource(source) {
  const code = stripComments(source);
  const literal = (m, a, b) => m[a] ?? m[b];
  const codes = [...code.matchAll(/\bcode:\s*(?:'([^'\n]*)'|`([^`\n]*)`)/g)].map((m) => literal(m, 1, 2));
  const thrown = [...code.matchAll(/\bthrow new (\w+)\(\s*(?:'([^'\n]*)'|`([^`\n]*)`)/g)].map((m) => `${m[1]}: ${literal(m, 2, 3)}`);
  const contracts = [...code.matchAll(/(['"`])((?:sbf|bskel|beval)\.[A-Za-z0-9.-]+\/\d+)\1/g)].map((m) => m[2]);
  const lists = [...code.matchAll(/\[\s*((?:'[^'\n]*'\s*,\s*)+'[^'\n]*')\s*,?\s*\]/g)].map((m) => [...m[1].matchAll(/'([^'\n]*)'/g)].map((x) => x[1]).join(', '));
  const auditTemplates = [...code.matchAll(/`(\$\{\w+\}: [^`\n]*)`/g)].map((m) => m[1]);
  return { codes: uniqueSorted(codes), thrown: uniqueSorted(thrown), contracts: uniqueSorted(contracts), lists: uniqueSorted(lists), auditTemplates: uniqueSorted(auditTemplates) };
}

// The text between the parentheses of `export function name(`, spaces collapsed: the declared inputs, defaults included.
function parametersOf(source, name) {
  const start = source.indexOf(`export function ${name}(`);
  if (start < 0) return null;
  let depth = 0;
  const from = start + `export function ${name}`.length;
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    if (source[i] === ')') { depth -= 1; if (depth === 0) return source.slice(from + 1, i).replace(/\s+/g, ' ').replace(/,\s*\}/g, ' }').replace(/\{\s+/g, '{ ').replace(/\s+\}/g, ' }').trim(); }
  }
  return null;
}

const FILES = { catalog: 'catalog.mjs', safety: 'safety-profile.mjs', legacy: 'legacy-baseline.mjs', plan: 'plan.mjs', cert: 'certification.mjs', evidence: 'evidence-boundary.mjs' };
const lists = (bag) => Object.fromEntries(Object.keys(bag).sort().map((key) => [key, [...bag[key]].sort()]));
const flat = (bag) => uniqueSorted(Object.values(bag).flatMap((set) => [...set]));

// Runs the six modules and reads their text: the result is every name, status, code, message and shape this layer emits.
async function derive({ root = ROOT, moduleDir = path.join(root, DIR), testDir = path.join(root, TESTS) } = {}) {
  const M = {};
  const sources = {};
  for (const [key, file] of Object.entries(FILES)) {
    const full = path.join(moduleDir, file);
    sources[key] = fs.readFileSync(full, 'utf8');
    M[key] = await import(pathToFileURL(full).href);
  }
  const rec = recorder();
  const combos = M.catalog.listApprovedCombinations();
  const runs = combos.map((combination, i) => {
    const evidence = elicitEvidence(M, combination, rec, i === 0);
    const behavior = { persistenceHandoff: evidence.persistenceHandoff, runtimeBehavior: evidence.runtimeBehavior };
    return { combination, plan: elicitPlan(M, combination, rec), cert: elicitCertification(M, combination, rec, behavior, i === 0), behavior };
  });
  const audit = elicitAudit(M, rec);
  const safety = elicitSafety(M, rec);
  // Every exported function that takes one object is also called with no argument and with null.
  for (const ns of Object.values(M)) for (const [name, fn] of Object.entries(ns)) if (typeof fn === 'function' && fn.length > 0 && !['auditLegacyProviders', 't16HashJson'].includes(name)) { rec.call(name, fn, undefined); rec.call(name, fn, null); }
  const scans = Object.fromEntries(Object.entries(sources).map(([key, source]) => [FILES[key], scanSource(source)]));

  // Which statically visible codes and thrown messages did the probes reach, and which probe results match nothing in the text.
  const staticCodes = uniqueSorted(Object.values(scans).flatMap((scan) => scan.codes));
  const staticThrown = uniqueSorted(Object.values(scans).flatMap((scan) => scan.thrown));
  const reachedCodes = flat(rec.codes);
  const reachedThrown = flat(rec.thrown);
  // A thrown error whose text is in no module is raised by the JavaScript engine: only its class is recorded, never its wording.
  const declared = {};
  const crashes = {};
  for (const [name, set] of Object.entries(rec.thrown)) for (const value of set) (staticThrown.some((item) => matcherOf(item).test(value)) ? (declared[name] ??= new Set()) : (crashes[name] ??= new Set())).add(staticThrown.some((item) => matcherOf(item).test(value)) ? value : value.split(':')[0]);
  const hit = (items, values) => items.filter((item) => values.some((value) => matcherOf(item).test(value)));
  const miss = (values, items) => values.filter((value) => !items.some((item) => matcherOf(item).test(value)));
  const auditStatic = scans['legacy-baseline.mjs'].auditTemplates;
  const auditReached = flat(rec.errors);

  const modules = {};
  for (const [key, ns] of Object.entries(M)) {
    const { specs, opaque } = lib.importsOf(sources[key]);
    modules[FILES[key]] = {
      exports: Object.keys(ns).sort().map((name) => (typeof ns[name] === 'function' ? { name, kind: 'function', parameters: parametersOf(sources[key], name) } : { name, kind: 'constant' })),
      imports: uniqueSorted(specs),
      opaque_imports: opaque.length,
      contracts: scans[FILES[key]].contracts
    };
  }
  const level = (name) => M.cert.evaluateCompositionCertification(runs[0].cert.input(name));
  const samples = Object.fromEntries(['preview-tested', 'build-tested', 'behavior-tested'].map((name) => {
    const result = level(name);
    return [name, { status: result.status, certifiedLevel: result.certifiedLevel, acceptedKeys: Object.keys(result.acceptedEvidence[0] ?? {}).join(','), crossTrack: result.crossTrackEvidence ? Object.keys(result.crossTrackEvidence).join(',') : null, blockers: result.blockers.map((item) => item.code) }];
  }));

  return {
    directory: { files: fs.readdirSync(moduleDir).sort(), tests: fs.readdirSync(testDir).sort() },
    modules,
    catalog: { entries: combos, entryKeys: uniqueSorted(combos.map((c) => Object.keys(c).join(','))) },
    legacy: { ids: [...M.legacy.LEGACY_PROVIDER_IDS], clean: audit.good, templates: auditStatic, templatesReached: hit(auditStatic, auditReached), reachedWithoutTemplate: miss(auditReached, auditStatic) },
    safety: { profiles: safety.profiles, resultKeys: [...safety.resultKeys], decisionKeys: [...safety.decisionKeys], manualKeys: [...safety.manualKeys], reasons: [...safety.reasons].sort(), areas: [...safety.areas].sort(), columns: [...safety.columns].sort(), manualReasons: [...safety.manualReasons].sort() },
    plan: { emitInput: Object.keys(runs[0].plan.emitted[0] ?? {}).join(','), emitInputShapes: uniqueSorted(runs.flatMap((run) => run.plan.emitted.map((args) => Object.keys(args).join(',')))) },
    certification: { required: runs[0].cert.required, samples },
    results: { schemas: lists(rec.schemas), statuses: lists(rec.statuses), shapeStatuses: lists(rec.shapeStatuses), flags: lists(rec.flags), shapes: lists(rec.shapes), codes: lists(rec.codes), extras: lists(rec.extra), thrown: lists(declared), crashes: lists(crashes) },
    text: { codes: Object.fromEntries(Object.entries(scans).map(([file, scan]) => [file, scan.codes])), thrown: Object.fromEntries(Object.entries(scans).map(([file, scan]) => [file, scan.thrown])), keyLists: scans['evidence-boundary.mjs'].lists },
    coverage: {
      codesNotReached: staticCodes.filter((item) => !hit([item], reachedCodes).length),
      codesWithoutText: miss(reachedCodes, staticCodes),
      thrownNotReached: staticThrown.filter((item) => !hit([item], reachedThrown).length)
    }
  };
}

// The RFC tables are written from the vocabulary by these functions, and the test compares the RFC with their output line for line.
const q = (text) => `\`${text}\``;
const qs = (items) => items.map(q).join(', ');
const cell = (text) => String(text).replace(/\|/g, '\\|');
const tableOf = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n');
// A lookup that never answers with an inherited member: the keys here are file names, function names and codes.
const own = (object, key) => (object && typeof object === 'object' && Object.hasOwn(object, key) ? object[key] : undefined);
const text = (value) => (typeof value === 'string' ? value : `MISSING(${String(value)})`);

// The strings found at a slash path of the derived part (names such as previewGeneration.short contain dots); an array on the way is walked item by item.
function stringsAt(derived, slashPath) {
  let current = [derived];
  for (const segment of slashPath.split('/')) current = current.flatMap((item) => (Array.isArray(item) ? item : [item])).map((item) => own(item, segment)).filter((item) => item !== undefined);
  return current.flatMap((item) => (Array.isArray(item) ? item : [item])).filter((item) => typeof item === 'string');
}

function familiesOf(narrative, derived) {
  return narrative.families.map((family) => {
    const all = own(derived.results.codes, family.function) ?? [];
    return { ...family, codes: all.filter((code) => new RegExp(family.pattern).test(code)) };
  });
}

function blocksOf(vocab, record) {
  const d = vocab.derived;
  const n = vocab.narrative;
  const recorded = record.files.filter((file) => file.role === 'test');
  const recordedNames = recorded.map((file) => path.posix.basename(file.path));
  const functions = Object.entries(d.modules).flatMap(([file, module]) => module.exports.filter((item) => item.kind === 'function').map((item) => [item.name, file, item.parameters]));
  const shapeKeys = Object.keys(d.results.shapes).filter((key) => key !== 'previewGeneration').sort();
  const resultRows = shapeKeys.flatMap((key) => d.results.shapes[key].map((keys) => {
    const label = key.startsWith('previewGeneration.') ? `${q('previewGeneration')} (${text(own(n.shapeLabels, key))})` : q(key);
    const status = own(d.results.shapeStatuses, `${key}|${keys}`) ?? [];
    return [label, own(d.results.schemas, key) ? qs(d.results.schemas[key]) : '-', status.length ? qs(status) : '-', keys === 'array' ? 'an `array` of strings, the evidence kinds' : q(keys.split(',').join(', '))];
  }));
  const wordRows = n.words.map((word) => [q(word.word), qs(word.where), word.meaning]);
  const thrownRows = Object.entries(d.text.thrown).flatMap(([file, items]) => items.map((item) => [q(file), q(item), d.coverage.thrownNotReached.includes(item) ? 'no' : 'yes']));
  return {
    files: tableOf(['file', 'role', 'exported names'], d.directory.files.map((file) => [q(file), text(own(n.files, file)?.role), own(d.modules, file) ? qs(d.modules[file].exports.map((item) => item.name)) : '-'])),
    recordedTests: tableOf(['test file', 'tests', 'covers'], recorded.map((file, i) => [q(recordedNames[i]), String(file.test_count), text(own(n.recordedTests, recordedNames[i])?.covers)])),
    otherTests: tableOf(['file', 'role'], d.directory.tests.filter((file) => !recordedNames.includes(file)).map((file) => [q(file), text(own(n.testFiles, file)?.role)])),
    inputs: tableOf(['function', 'module', 'inputs, defaults as written'], functions.map(([name, file, parameters]) => [q(name), q(file), parameters === '' ? 'none' : q(parameters)])),
    results: tableOf(['function', 'schema id', 'status values', 'keys, in the order the code writes them'], resultRows),
    catalog: tableOf(d.catalog.entryKeys[0].split(','), d.catalog.entries.map((entry) => Object.values(entry).map((value) => q(value)))),
    profiles: tableOf(['provider', 'fetch', 'authorization', 'patch', 'recover'], Object.entries(d.safety.profiles).map(([id, p]) => [q(id), q(p.fetch), q(p.authorization), q(p.patch), q(p.recover)])),
    safetyWords: tableOf(['kind', 'value'], [
      ...d.safety.columns.map((value) => ['column word', q(value)]), ...d.safety.reasons.map((value) => ['decision reason', q(value)]),
      ...d.safety.areas.map((value) => ['manual completion area', q(value)]), ...d.safety.manualReasons.map((value) => ['manual completion reason', q(value)]),
      ['result keys', q(d.safety.resultKeys[0].split(',').join(', '))], ['decision keys', q(d.safety.decisionKeys[0].split(',').join(', '))], ['manual completion keys', q(d.safety.manualKeys[0].split(',').join(', '))]
    ]),
    auditErrors: tableOf(['audit error, as the code writes it'], d.legacy.templates.map((item) => [q(item)])),
    required: tableOf(['level', 'provider', 'required evidence kinds, in order'], Object.entries(d.certification.required).flatMap(([level, byProvider]) => Object.entries(byProvider).map(([id, kinds]) => [q(level), q(id), qs(kinds)]))),
    samples: tableOf(['level', 'status', 'certified level', 'blocker codes'], Object.entries(d.certification.samples).map(([level, s]) => [q(level), q(s.status), s.certifiedLevel ? q(s.certifiedLevel) : 'null', s.blockers.length ? qs(s.blockers) : '-'])),
    codes: tableOf(['function', 'family', 'codes'], familiesOf(n, d).map((family) => [q(family.function), family.family, qs(family.codes)])),
    extras: tableOf(['code', 'extra fields next to code and message'], Object.entries(d.results.extras).map(([code, fields]) => [q(code), qs(fields)])),
    thrown: tableOf(['module', 'message, with placeholders as written', 'reached by the probes'], thrownRows),
    crashes: tableOf(['function', 'error class', 'cause'], Object.entries(d.results.crashes).map(([name, classes]) => [q(name), qs(classes), text(n.crashes.find((item) => item.function === name)?.cause)])),
    keySets: tableOf(['name', 'keys', 'used by'], n.keySets.map((item) => [item.name, q(item.keys), item.usedBy])),
    words: tableOf(['word', 'found at', 'meaning'], wordRows),
    imports: tableOf(['module', 'imports', 'computed imports'], Object.entries(d.modules).map(([file, module]) => [q(file), module.imports.length ? qs(module.imports) : 'none', String(module.opaque_imports)])),
    rules: tableOf(['rule', 'what the document claims', 'checked by'], n.rules.map((item) => [q(item.id), item.statement, `test "rule ${item.id}"`])),
    fields: tableOf(['field', 'module', 'what identifies or binds'], n.fields.map((item) => [q(item.name), q(item.module), item.meaning])),
    contracts: tableOf(['contract or schema id', 'role', 'found in'], n.contracts.map((item) => [q(item.id), item.role, qs(Object.entries(d.modules).filter(([, module]) => module.contracts.includes(item.id)).map(([file]) => file))])),
    commands: tableOf(['command id', 'command', 'result at the base commit'], record.commands.map((item) => [q(item.id), q(item.command), `exit ${item.exit_code}; ${item.result.tests} tests, ${item.result.pass} pass, ${item.result.fail} fail, ${item.result.skipped} skipped${item.first_line ? `; first line ${q(item.first_line)}` : ''}`])),
    limits: tableOf(['limit id', 'status'], record.limits.map((limit) => [q(limit.id), q(limit.status)])),
    ownership: tableOf(['path', 'owner verdict', 'relation to this layer'], n.ownership.map((item) => [q(item.path), item.owner ? `${item.verdict} (${item.owner})` : item.verdict, item.relation]))
  };
}
// END derive

// ---- The checks. Everything below works on plain values, so the negative tests can feed it damaged copies. ----
const VOCAB_SCHEMA = 'bskel.t14-interface-vocabulary/1';
const NARRATIVE_KEYS = ['contracts', 'crashes', 'families', 'fields', 'files', 'headings', 'keySets', 'ownership', 'prose', 'recordedTests', 'rules', 'shapeLabels', 'testFiles', 'words'];
const VERDICTS = ['OK', 'PATH_OWNED_BY_OTHER_TRACK', 'PATH_RESERVED_HOT', 'PATH_UNOWNED'];
// Text that may reach GitHub: no issue or pull request numbers in any form (the baseline lib forbids the same forms in the record).
const FORBIDDEN = /#\d|\bPR\s*\d|\/pull\/\d|\/issues\/\d|GH-\d|refs\/pull/;
const LINE_CAP = 440;
// Names whose claims belong to the compared tables and rules: a sentence between the tables may not name one, because no test
// compares such a sentence with the code (the finding on the hash function: "any value" stood in a sentence between the tables).
const TABLE_ONLY_NAMES = ['t16HashJson'];

// Names through which a module could read the clock, a random source or the process, print, or wait for something.
const HOST_ACCESS = /\b(?:process|Date|performance|globalThis|setTimeout|setInterval|setImmediate|queueMicrotask|console|await|async|Promise|randomUUID|randomBytes|randomInt|getRandomValues)\b|Math\.random/g;
const hostAccessOf = (source) => [...new Set(source.match(HOST_ACCESS) ?? [])].sort();

const readText = (file) => fs.readFileSync(file, 'utf8');
const shorten = (value) => { const text = JSON.stringify(value) ?? 'undefined'; return text.length > 80 ? `${text.slice(0, 77)}...` : text; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameSet = (label, actual, expected) => (same([...new Set(actual)].sort(), [...new Set(expected)].sort()) ? [] : [`${label}: ${shorten([...new Set(actual)].sort())} is not ${shorten([...new Set(expected)].sort())}`]);
const duplicates = (items) => items.filter((item, i) => items.indexOf(item) !== i);

// The slash paths where two JSON values differ, at most `limit` of them: readable failure messages for a deep comparison.
function differences(a, b, at = '', out = [], limit = 6) {
  if (out.length >= limit || same(a, b)) return out;
  const nested = a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b);
  if (!nested) { out.push(`${at || '/'}: ${shorten(a)} is not ${shorten(b)}`); return out; }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(own(a, key), own(b, key), `${at}/${key}`, out, limit);
  return out;
}

// Backtick spans of a document and the identifier-like words inside them. A word may contain dots, slashes, plus signs, colons and hyphens.
const spansOf = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const wordsOf = (text) => (String(text).match(/[A-Za-z0-9_][\w.\/+:-]*/g) ?? []).map((word) => word.replace(/[.:\/+-]+$/, '')).filter(Boolean);
const csv = (text) => String(text).split(/,\s*/).filter(Boolean);

// A table is a run of lines that start with a pipe.
function tableRuns(text) {
  const runs = [];
  let current = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('|')) current.push(line);
    else { if (current.length) runs.push(current.join('\n')); current = []; }
  }
  if (current.length) runs.push(current.join('\n'));
  return runs;
}

// Every name that the code or the record gives to something: the document must spell each one.
function namesOf(vocab, record) {
  const d = vocab.derived;
  const names = new Set();
  const add = (...items) => items.flat(Infinity).forEach((item) => { if (typeof item === 'string' && item) names.add(item); });
  for (const [file, module] of Object.entries(d.modules)) { add(file, module.contracts, module.exports.map((item) => item.name)); }
  add(d.directory.files, d.directory.tests, d.catalog.entries.map((entry) => Object.values(entry)));
  add(d.legacy.ids, d.legacy.templates, d.safety.columns, d.safety.reasons, d.safety.areas, d.safety.manualReasons);
  add([...d.safety.resultKeys, ...d.safety.decisionKeys, ...d.safety.manualKeys, ...d.text.keyLists].flatMap(csv));
  add(Object.values(d.results.shapes).flat().flatMap(csv), d.plan.emitInputShapes.flatMap(csv), d.safety.resultKeys.flatMap(csv));
  add(Object.values(d.certification.required).flatMap((byProvider) => Object.values(byProvider)), Object.keys(d.certification.required));
  for (const sample of Object.values(d.certification.samples)) add(sample.status, sample.certifiedLevel, sample.blockers, csv(sample.acceptedKeys), csv(sample.crossTrack ?? ''));
  const r = d.results;
  add(Object.values(r.schemas), Object.entries(r.statuses).filter(([key]) => !key.endsWith('.ok')).map(([, values]) => values), Object.values(r.codes), Object.keys(r.extras), Object.values(r.extras));
  // A code that a source builds from a template is spelled by the codes it expands to, which the probes reach.
  add(Object.values(d.text.codes).flat().filter((code) => !code.includes('${')), Object.values(d.text.thrown), Object.keys(r.crashes), Object.values(r.crashes));
  add(vocab.narrative.words.map((item) => item.word), vocab.narrative.rules.map((item) => item.id), vocab.narrative.fields.map((item) => item.name));
  add(record.limits.map((item) => item.id), record.commands.map((item) => item.id), record.commands.map((item) => item.command));
  return names;
}

// Everything that a backtick span of the document may legally contain: what the code emits, the identifier fields of the narrative
// and the record, and the reviewed list of extra words. The prose fields of the narrative do not count.
function knownTokens(vocab, record) {
  const spans = new Set();
  const words = new Set();
  const PROSE = new Set(['role', 'meaning', 'relation', 'cause', 'family', 'usedBy', 'covers', 'statement', 'pattern', 'reason']);
  const add = (value) => { if (typeof value === 'string') { spans.add(value); wordsOf(value).forEach((word) => words.add(word)); } };
  const walk = (value) => {
    if (typeof value === 'string') add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { add(key); if (!PROSE.has(key)) walk(item); }
  };
  walk(vocab.derived);
  walk({ ...vocab.narrative, prose: vocab.narrative.prose.map((item) => item.token) });
  for (const item of [...record.limits, ...record.fixtures, ...record.commands]) add(item.id);
  for (const item of record.commands) { add(item.command); add(item.first_line); }
  for (const item of record.limits) add(item.status);
  for (const file of record.files) { add(file.path); add(path.posix.basename(file.path)); }
  add(record.source_dir); add(record.test_dir); add(record.base_commit);
  return { spans, words };
}
const isKnown = (span, known) => known.spans.has(span) || wordsOf(span).every((word) => known.words.has(word));

// Each function returns a list of problems; an empty list is a pass. Nothing here throws on damaged input.
function narrativeProblems(vocab, record, sourceOf = (file) => readText(path.join(ROOT, DIR, file))) {
  const problems = [];
  const n = vocab.narrative;
  const d = vocab.derived;
  if (!n || typeof n !== 'object') return ['narrative is missing'];
  problems.push(...sameSet('narrative keys', Object.keys(n), NARRATIVE_KEYS));
  if (problems.length) return problems;
  const recorded = record.files.filter((file) => file.role === 'test').map((file) => path.posix.basename(file.path));
  problems.push(...sameSet('narrative.files', Object.keys(n.files), d.directory.files));
  problems.push(...sameSet('narrative.recordedTests', Object.keys(n.recordedTests), recorded));
  problems.push(...sameSet('narrative.testFiles', Object.keys(n.testFiles), d.directory.tests.filter((file) => !recorded.includes(file))));
  problems.push(...sameSet('narrative.shapeLabels', Object.keys(n.shapeLabels), Object.keys(d.results.shapes).filter((key) => key.startsWith('previewGeneration.'))));
  const contractIds = Object.values(d.modules).flatMap((module) => module.contracts);
  problems.push(...sameSet('narrative.contracts', n.contracts.map((item) => item.id), contractIds));
  problems.push(...duplicates(n.contracts.map((item) => item.id)).map((id) => `narrative.contracts: ${id} twice`));
  // Every code of a function belongs to exactly one family; every family has at least one code.
  const partitioned = Object.keys(d.results.codes).filter((key) => !key.endsWith('.reasons') && key !== 'previewGeneration');
  for (const key of partitioned) if (!n.families.some((family) => family.function === key)) problems.push(`narrative.families: no family for ${key}`);
  for (const family of n.families) if (!own(d.results.codes, family.function)) problems.push(`narrative.families: unknown function ${family.function}`);
  for (const key of partitioned) {
    const families = n.families.filter((family) => family.function === key);
    for (const code of d.results.codes[key]) {
      const hits = families.filter((family) => new RegExp(family.pattern).test(code));
      if (hits.length !== 1) problems.push(`narrative.families: ${code} of ${key} is in ${hits.length} families`);
    }
    for (const family of families) if (!d.results.codes[key].some((code) => new RegExp(family.pattern).test(code))) problems.push(`narrative.families: no code of ${key} in the family ${family.family}`);
  }
  problems.push(...sameSet('narrative.crashes', n.crashes.map((item) => item.function), Object.keys(d.results.crashes)));
  problems.push(...duplicates(n.words.map((item) => item.word)).map((word) => `narrative.words: ${word} twice`));
  for (const item of n.words) {
    if (!item.where.length) problems.push(`narrative.words: ${item.word} is found nowhere`);
    for (const at of item.where) if (!stringsAt(d, at).includes(item.word)) problems.push(`narrative.words: ${item.word} is not at ${at}`);
  }
  problems.push(...sameSet('narrative.keySets', n.keySets.map((item) => item.keys), d.text.keyLists));
  problems.push(...duplicates(n.keySets.map((item) => item.name)).map((name) => `narrative.keySets: ${name} twice`));
  for (const row of n.ownership) {
    if (!VERDICTS.includes(row.verdict)) problems.push(`narrative.ownership: ${row.path} has the verdict ${shorten(row.verdict)}`);
    if ((row.verdict === 'PATH_OWNED_BY_OTHER_TRACK') !== (typeof row.owner === 'string')) problems.push(`narrative.ownership: ${row.path} has verdict and owner that do not belong together`);
  }
  problems.push(...duplicates(n.ownership.map((row) => row.path)).map((file) => `narrative.ownership: ${file} twice`));
  // A field named in the identity table must exist in the source of the module that the table names.
  for (const item of n.fields) {
    if (!item.name || !item.module || !item.meaning) { problems.push(`narrative.fields: incomplete entry ${shorten(item)}`); continue; }
    if (!own(d.modules, item.module)) { problems.push(`narrative.fields: ${item.name} names ${item.module}, which is not a module of the layer`); continue; }
    if (!new RegExp(`(?<![\\w$])${item.name.replace(/[$]/g, '\\$&')}(?![\\w$])`).test(sourceOf(item.module))) problems.push(`narrative.fields: ${item.name} does not occur in ${item.module}`);
  }
  problems.push(...duplicates(n.fields.map((item) => `${item.name} in ${item.module}`)).map((key) => `narrative.fields: ${key} twice`));
  problems.push(...duplicates(n.rules.map((item) => item.id)).map((id) => `narrative.rules: ${id} twice`));
  problems.push(...n.rules.filter((item) => !item.id || !item.statement).map((item) => `narrative.rules: incomplete rule ${shorten(item)}`));
  problems.push(...n.prose.filter((item) => !item.token || !item.reason).map((item) => `narrative.prose: incomplete entry ${shorten(item)}`));
  problems.push(...n.headings.filter((item) => !/^#{1,3} \S/.test(item)).map((item) => `narrative.headings: ${shorten(item)}`));
  return problems;
}

// The vocabulary file against the code (derived is a fresh run of derive) and against itself.
function vocabProblems(vocab, derived, record, sourceOf) {
  if (!vocab || typeof vocab !== 'object') return ['vocabulary is not an object'];
  const problems = [];
  if (vocab.schema !== VOCAB_SCHEMA) problems.push(`schema is ${shorten(vocab.schema)}, not ${VOCAB_SCHEMA}`);
  problems.push(...sameSet('vocabulary keys', Object.keys(vocab), ['schema', 'derived', 'narrative']));
  problems.push(...differences(vocab.derived, derived).map((line) => `derived part differs from the code at ${line}`));
  problems.push(...['codesNotReached', 'codesWithoutText', 'thrownNotReached'].filter((key) => !same(own(derived.coverage, key), [])).map((key) => `coverage ${key} is not empty: ${shorten(derived.coverage[key])}`));
  if (!problems.length) problems.push(...narrativeProblems(vocab, record, sourceOf));
  return problems;
}

// The document against the vocabulary: tables verbatim, headings, names both ways, text rules.
function rfcProblems(rfc, vocab, record) {
  const problems = [];
  const blocks = blocksOf(vocab, record);
  const runs = tableRuns(rfc);
  for (const [name, block] of Object.entries(blocks)) {
    const count = runs.filter((run) => run === block).length;
    if (count !== 1) problems.push(`table ${name} stands ${count} times in the document (once expected)`);
  }
  const rendered = new Set(Object.values(blocks));
  for (const run of runs) if (!rendered.has(run)) problems.push(`a table is not rendered from the vocabulary: ${shorten(run.split('\n')[0])}`);
  const headings = rfc.split('\n').filter((line) => /^#{1,6} /.test(line));
  if (!same(headings, vocab.narrative.headings)) problems.push(`headings differ from the vocabulary: ${shorten(headings.filter((line) => !vocab.narrative.headings.includes(line)))} / missing ${shorten(vocab.narrative.headings.filter((line) => !headings.includes(line)))}`);
  const found = FORBIDDEN.exec(rfc);
  if (found) problems.push(`forbidden text ${shorten(found[0])}`);
  for (const name of TABLE_ONLY_NAMES) {
    const line = rfc.split('\n').find((text) => !text.startsWith('|') && text.includes(name));
    if (line !== undefined) problems.push(`${name} is named between the tables, where no test compares a sentence with the code: ${shorten(line)}`);
  }
  if (/\t/.test(rfc)) problems.push('a tab character');
  if (/\r/.test(rfc)) problems.push('a carriage return');
  if (/[ ]+$/m.test(rfc)) problems.push('trailing spaces');
  if (!rfc.endsWith('\n') || rfc.endsWith('\n\n')) problems.push('the document must end with exactly one newline');
  if (rfc.split('\n').length > LINE_CAP) problems.push(`more than ${LINE_CAP} lines`);
  const spans = new Set(spansOf(rfc));
  const words = new Set([...spans].flatMap(wordsOf));
  const known = knownTokens(vocab, record);
  for (const span of spans) if (!isKnown(span, known)) problems.push(`unknown name in the document: ${span}`);
  for (const name of namesOf(vocab, record)) if (!spans.has(name) && !words.has(name)) problems.push(`the document does not spell ${name}`);
  for (const item of vocab.narrative.prose) if (!spans.has(item.token) && !words.has(item.token)) problems.push(`prose token ${item.token} is not used`);
  for (const item of vocab.narrative.rules) if (!rfc.includes(item.statement)) problems.push(`rule ${item.id} is not stated in the document`);
  return problems;
}

// The ownership table against the output of the checker (one call for all rows).
function ownershipProblems(rows, output) {
  const problems = [];
  const seen = new Map();
  for (const line of output.split('\n').filter(Boolean)) {
    const m = /^FAIL (\w+) (\S+) (.*)$/.exec(line);
    if (m) seen.set(m[2], { code: m[1], text: m[3] }); else problems.push(`unreadable checker line ${shorten(line)}`);
  }
  for (const row of rows) {
    const got = seen.get(row.path);
    const owner = got ? /^owned by (\w+),/.exec(got.text)?.[1] ?? null : null;
    if ((got ? got.code : 'OK') !== row.verdict) problems.push(`${row.path}: the checker says ${got ? got.code : 'OK'}, the table says ${row.verdict}`);
    if (owner !== (row.owner ?? null)) problems.push(`${row.path}: the checker names the owner ${owner ?? 'none'}, the table ${row.owner ?? 'none'}`);
  }
  for (const file of seen.keys()) if (!rows.some((row) => row.path === file)) problems.push(`${file}: the checker reports a path that the table lacks`);
  return problems;
}

// ---- The tests ----
const record = lib.readRecord(ROOT);
const onDisk = () => ({ vocab: JSON.parse(readText(VOCAB_FILE)), rfc: readText(RFC_FILE) });

async function loadModules(moduleDir = path.join(ROOT, DIR)) {
  const M = {};
  for (const [key, file] of Object.entries(FILES)) M[key] = await import(pathToFileURL(path.join(moduleDir, file)).href);
  return M;
}
// Valid inputs for every function, built by the same elicitation functions as the vocabulary (no fuzzing).
async function validInputs(combinationIndex = 0) {
  const M = await loadModules();
  const combination = M.catalog.listApprovedCombinations()[combinationIndex];
  const rec = recorder();
  const evidence = elicitEvidence(M, combination, rec, false);
  elicitPlan(M, combination, rec);
  const certification = elicitCertification(M, combination, rec, { persistenceHandoff: evidence.persistenceHandoff, runtimeBehavior: evidence.runtimeBehavior }, false);
  return { M, combination, rec, evidence, certification };
}
const codesOf = (result) => result.blockers.map((item) => item.code);

test('the vocabulary file is what the code emits', async () => {
  const { vocab } = onDisk();
  assert.equal(readText(VOCAB_FILE), `${JSON.stringify(vocab, null, 2)}\n`, 'the file is written with two-space indentation and a final newline');
  assert.doesNotMatch(readText(VOCAB_FILE), FORBIDDEN);
  assert.deepEqual(vocabProblems(vocab, await derive(), record), []);
});

test('the tables, headings, names and rule statements of the document match the vocabulary', () => {
  const { vocab, rfc } = onDisk();
  assert.deepEqual(rfcProblems(rfc, vocab, record), []);
});

test('the ownership table agrees with the ownership checker', () => {
  const { vocab } = onDisk();
  const rows = vocab.narrative.ownership;
  const run = spawnSync(process.execPath, [path.join(ROOT, 'next/t00/check-ownership.mjs'), 'paths', '--track', lib.TRACK.suiteId, ...rows.map((row) => row.path)], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, rows.some((row) => row.verdict !== 'OK') ? 2 : 0, run.stderr);
  assert.deepEqual(ownershipProblems(rows, run.stdout), []);
  for (const row of rows.filter((item) => item.verdict === 'OK' && item.path.startsWith(DIR))) assert.ok(fs.existsSync(path.join(ROOT, row.path)), `${row.path} exists`);
});

test('every rule of the vocabulary has a test and every test a rule', () => {
  const { vocab } = onDisk();
  assert.deepEqual(sameSet('rules', vocab.narrative.rules.map((item) => item.id), Object.keys(RULE_TESTS)), []);
});

// Each rule is a sentence of the document; the test below it calls the code and shows that the sentence is true.
const RULE_TESTS = {
  'shadow-only': async () => {
    const { rec } = await validInputs();
    const flags = lists(rec.flags);
    assert.deepEqual(Object.keys(flags).sort(), ['evaluateCompositionCertification.applyAllowed', 'previewGeneration.applyAllowed', 'previewGeneration.full.applyAllowed', 'previewGeneration.preflight.applyAllowed', 'previewGeneration.short.applyAllowed']);
    for (const values of Object.values(flags)) assert.deepEqual(values, ['false']);
    assert.deepEqual(lists(rec.statuses).evaluateCompositionCertification, ['blocked', 'certified'], 'the flag was seen on both statuses');
  },
  'isolated-modules': async () => {
    const allowed = { 'catalog.mjs': [], 'safety-profile.mjs': [], 'legacy-baseline.mjs': [], 'plan.mjs': ['./catalog.mjs', './safety-profile.mjs'], 'certification.mjs': ['./catalog.mjs', './evidence-boundary.mjs'], 'evidence-boundary.mjs': ['node:crypto'] };
    for (const file of Object.values(FILES)) {
      const { specs, opaque } = lib.importsOf(readText(path.join(ROOT, DIR, file)));
      assert.deepEqual([...specs].sort(), allowed[file], file);
      assert.deepEqual(opaque, [], `${file} has no computed import`);
      assert.deepEqual(hostAccessOf(readText(path.join(ROOT, DIR, file))), [], `${file} reads no clock, random source or process, prints nothing and is not asynchronous`);
    }
  },
  'closed-catalog': async () => {
    const { M } = await validInputs();
    const entries = M.catalog.listApprovedCombinations();
    assert.equal(entries.length, 3);
    for (const entry of entries) {
      assert.equal(entry.id, `${entry.providerId}+${entry.persistenceId}+${entry.keyType}`);
      assert.deepEqual(M.catalog.resolveApprovedCombination(entry), entry);
      for (const field of ['providerId', 'persistenceId', 'keyType']) for (const value of [`${entry[field]}-x`, undefined, '', null]) assert.equal(M.catalog.resolveApprovedCombination({ ...entry, [field]: value }), null, `${field} ${String(value)}`);
    }
    assert.equal(M.catalog.resolveApprovedCombination({ providerId: entries[0].providerId, persistenceId: entries[1].persistenceId, keyType: 'uuid' }), null, 'two entries do not mix');
    assert.equal(M.catalog.resolveApprovedCombination({}), null);
  },
  'catalog-copies': async () => {
    const { M } = await validInputs();
    const before = JSON.stringify(M.catalog.listApprovedCombinations());
    const [first] = M.catalog.listApprovedCombinations();
    first.keyType = 'bigint'; first.extra = true;
    const resolved = M.catalog.resolveApprovedCombination(M.catalog.listApprovedCombinations()[1]);
    resolved.providerId = 'changed';
    assert.equal(JSON.stringify(M.catalog.listApprovedCombinations()), before);
    assert.equal(Object.isFrozen(M.catalog.APPROVED_COMBINATIONS), true);
  },
  'preview-is-a-dry-run': async () => {
    const { M, combination } = await validInputs();
    const resources = [{ type: 'User', willGenerateResolver: true, idFieldIsUuid: true }];
    const run = (over = {}) => {
      const emitted = [];
      const provider = stubProvider(combination.providerId, { emit: (args) => { emitted.push(args); return { written: [], forced: [], actions: [], notes: [], postEmitNotes: [] }; } });
      const result = M.plan.previewGeneration({ provider, repoRoot: '/repo', featureId: 'feature-1', revision: REV, handlesPlan: { provider: combination.providerId, resources }, persistenceId: combination.persistenceId, keyType: combination.keyType, ...over });
      return { result, emitted };
    };
    const ok = run();
    assert.equal(ok.result.status, 'ready');
    assert.equal(ok.emitted.length, 1);
    assert.deepEqual({ force: ok.emitted[0].force, reason: ok.emitted[0].reason, dryRun: ok.emitted[0].dryRun, computeDiff: ok.emitted[0].computeDiff }, { force: false, reason: '', dryRun: true, computeDiff: false });
    const outside = run({ keyType: 'bigint' });
    assert.deepEqual([outside.result.status, outside.emitted.length, codesOf(outside.result)], ['blocked', 0, ['unsupported-combination']]);
    const preflight = run({ resourceFilter: ['Ghost'] });
    assert.deepEqual([preflight.result.status, preflight.emitted.length, codesOf(preflight.result)], ['blocked', 0, ['requested-resource-missing', 'no-generatable-resources']]);
  },
  'behavior-never-certifies': async () => {
    const { M, evidence, certification } = await validInputs();
    assert.equal(M.evidence.inspectPersistenceHandoff({ expected: evidence.expected, ...evidence.persistenceHandoff }).status, 'eligible');
    assert.equal(M.evidence.inspectRuntimeBehaviorProjection({ expected: evidence.expected, ...evidence.runtimeBehavior }).status, 'eligible');
    for (const level of ['preview-tested', 'build-tested']) assert.equal(M.cert.evaluateCompositionCertification(certification.input(level)).status, 'certified', level);
    const behavior = M.cert.evaluateCompositionCertification(certification.input('behavior-tested'));
    assert.deepEqual([behavior.status, behavior.certifiedLevel, behavior.requestedLevel, codesOf(behavior)], ['blocked', null, 'behavior-tested', ['behavior-handoff-not-integrated']]);
  },
  'exact-revision': async () => {
    const { M, certification } = await validInputs();
    const evaluate = (over) => M.cert.evaluateCompositionCertification({ ...certification.input('build-tested'), ...over });
    assert.equal(evaluate({}).status, 'certified');
    for (const revision of ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'main', '', null, undefined]) assert.ok(codesOf(evaluate({ revision })).includes('invalid-revision'), String(revision));
    const input = certification.input('build-tested');
    input.evidence[0] = { ...input.evidence[0], revision: 'b'.repeat(40) };
    const stale = M.cert.evaluateCompositionCertification(input);
    assert.deepEqual([stale.status, ...stale.blockers.map((item) => `${item.code}:${item.kind}`)], ['blocked', `invalid-evidence:${input.evidence[0].kind}`]);
  },
  'plain-evidence': async () => {
    const { M, certification, combination } = await validInputs();
    const input = certification.input('build-tested');
    input.evidence = input.evidence.map((entry) => ({ ...entry, bytes: 7, artifactRef: 'not a reference' }));
    const result = M.cert.evaluateCompositionCertification(input);
    assert.equal(result.status, 'certified');
    assert.deepEqual(result.acceptedEvidence.map((item) => item.artifactRef), input.evidence.map(() => 'not a reference'));
    const bound = M.evidence.validateBoundCertificationEvidence({ expectedKind: input.evidence[0].kind, revision: REV, providerId: combination.providerId, combinationId: combination.id, profileId: PROFILE, evidence: input.evidence[0] });
    assert.equal(bound.ok, false);
    assert.ok(bound.blockers.some((item) => item.code === 'artifact-bytes-invalid'));
  },
  'bound-is-not-accepted': async () => {
    const { M, evidence } = await validInputs();
    const inspect = (status) => M.evidence.inspectPersistenceHandoff({ expected: evidence.expected, ...evidence.persistenceHandoff, provenance: { ...evidence.persistenceHandoff.provenance, status } });
    assert.equal(inspect('accepted').status, 'eligible');
    for (const status of ['bound', 'pending', undefined, null]) assert.deepEqual([inspect(status).status, codesOf(inspect(status))], ['blocked', ['handoff-not-approved']], String(status));
  },
  'hash-rule': async () => {
    const { M, evidence } = await validInputs();
    const value = { b: 1, a: [2, { d: 3, c: 4 }] };
    const text = '{\n  "a": [\n    2,\n    {\n      "c": 4,\n      "d": 3\n    }\n  ],\n  "b": 1\n}\n';
    assert.equal(M.evidence.t16HashJson(value), crypto.createHash('sha256').update(text).digest('hex'));
    const runtime = M.evidence.inspectRuntimeBehaviorProjection({ expected: evidence.expected, ...evidence.runtimeBehavior });
    assert.equal(runtime.bindingHash, M.evidence.t16HashJson(evidence.documents.binding));
    const hash = (input) => M.evidence.t16HashJson(input);
    assert.equal(hash({ a: 1, b: { y: [{ n: 1, m: 2 }], x: 3 } }), hash({ b: { x: 3, y: [{ m: 2, n: 1 }] }, a: 1 }));
    const writtenOrder = ['0', '2', '10', '4294967294', '-1', '01', '4294967295', 'B', 'b', String.fromCharCode(0xe9), String.fromCodePoint(0x10000), String.fromCharCode(0xffff)];
    const withValues = writtenOrder.map((key, index) => [key, index]);
    const orderedText = `{\n${withValues.map(([key, index]) => `  ${JSON.stringify(key)}: ${index}`).join(',\n')}\n}\n`;
    for (const entries of [withValues, [...withValues].reverse()]) assert.equal(hash(Object.fromEntries(entries)), crypto.createHash('sha256').update(orderedText).digest('hex'));
  },
  'hash-input-domain': async () => {
    const { M } = await validInputs();
    const hash = (value) => M.evidence.t16HashJson(value);
    const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
    const errorName = (call) => {
      try {
        call();
      } catch (error) {
        return error?.name;
      }
      return 'no error';
    };
    class Keyed {
      constructor(keys) {
        for (const key of keys) this[key] = 1;
      }
    }
    const plainOf = (keys) => Object.fromEntries(keys.map((key) => [key, 1]));
    const unsortedKinds = [
      ['a class instance', (keys) => new Keyed(keys)],
      ['an object without prototype', (keys) => Object.assign(Object.create(null), plainOf(keys))]
    ];
    for (const [label, make] of unsortedKinds) {
      assert.notEqual(hash(make(['b', 'a'])), hash(make(['a', 'b'])), `${label}: the same keys added in another order give another hash`);
      assert.equal(hash(make(['a', 'b'])), hash(plainOf(['a', 'b'])), `${label} whose keys were added in sorted order is written as the plain object is`);
      assert.equal(hash(make(['10', '2'])), hash(make(['2', '10'])), `${label}: array indexes come out in numeric order whatever the order added`);
      const holding = (keys) => {
        const holder = make(['k']);
        holder.k = plainOf(keys);
        holder.list = [plainOf(keys)];
        return holder;
      };
      assert.notEqual(hash(holding(['b', 'a'])), hash(holding(['a', 'b'])), `${label}: the plain objects and arrays inside it are not sorted`);
      assert.notEqual(hash({ outer: [make(['b', 'a'])] }), hash({ outer: [make(['a', 'b'])] }), `${label} inside plain objects and arrays is still not sorted`);
    }
    const loop = { a: 1 };
    loop.self = loop;
    const ring = [1];
    ring.push(ring);
    const back = {};
    back.next = { back };
    class Holder {
      constructor(owner) {
        this.owner = owner;
      }
    }
    const owner = {};
    owner.held = new Holder(owner);
    const own = new Holder(null);
    own.owner = own;
    const bare = Object.create(null);
    bare.me = bare;
    let deep = 1;
    for (let level = 0; level < 100000; level += 1) deep = [deep];
    const thrown = [
      ['a BigInt as the value', 10n, 'TypeError'],
      ['a BigInt in an array', [1n], 'TypeError'],
      ['a BigInt as a property', { a: 1n }, 'TypeError'],
      ['a BigInt nested in objects and arrays', { z: 1, a: { b: { c: [{ d: 2n }] } } }, 'TypeError'],
      ['an object that holds itself', loop, 'RangeError'],
      ['an array that holds itself', ring, 'RangeError'],
      ['a cycle through two plain objects', back, 'RangeError'],
      ['nesting of 100000 arrays', deep, 'RangeError'],
      ['a cycle from a plain object through a class instance', owner, 'TypeError'],
      ['a class instance that holds itself', own, 'TypeError'],
      ['a cycle through an object without prototype', bare, 'TypeError']
    ];
    for (const [label, value, name] of thrown) assert.equal(errorName(() => hash(value)), name, label);
    const undefinedHash = sha('undefined\n');
    const nullHash = sha('null\n');
    assert.notEqual(undefinedHash, nullHash);
    for (const [label, call] of [['undefined', () => hash(undefined)], ['a call without an argument', () => hash()], ['a function', () => hash(() => 1)], ['a symbol', () => hash(Symbol('s'))]]) assert.equal(call(), undefinedHash, label);
    for (const [label, value] of [['null', null], ['NaN', NaN], ['Infinity', Infinity]]) assert.equal(hash(value), nullHash, label);
    for (const value of [undefined, null, 0, 'x', [], {}, { a: [1, 'x', null, true] }]) assert.match(hash(value), /^[0-9a-f]{64}$/);
  },
  'reference-equality': async () => {
    const { M, evidence } = await validInputs();
    const handoff = evidence.persistenceHandoff;
    const ref = handoff.handoffRef;
    // The hand-off bytes and the hand-off reference stay valid in every call; only provenance.artifactRef changes,
    // so the field-by-field comparison is the one check that can see the change and its blocker code is asserted.
    const verdict = (artifactRef) => {
      const result = M.evidence.inspectPersistenceHandoff({ expected: evidence.expected, ...handoff, provenance: { ...handoff.provenance, artifactRef } });
      return [result.status, codesOf(result)];
    };
    const changed = (key) => (key === 'size_bytes' ? ref[key] + 1 : key === 'byte_sha256' ? `${ref[key][0] === '0' ? '1' : '0'}${ref[key].slice(1)}` : `${ref[key]}x`);
    assert.deepEqual(Object.keys(ref).sort(), ['artifact_ref', 'byte_sha256', 'family', 'media_type', 'size_bytes', 'version']);
    assert.deepEqual(handoff.provenance.artifactRef, ref);
    assert.deepEqual(verdict(ref), ['eligible', []]);
    assert.match(changed('byte_sha256'), /^[0-9a-f]{64}$/);
    for (const key of Object.keys(ref)) assert.deepEqual(verdict({ ...ref, [key]: changed(key) }), ['blocked', ['provenance-artifact-mismatch']], key);
    assert.deepEqual(verdict({ ...ref, extra: 1 }), ['blocked', ['provenance-artifact-mismatch']], 'a seventh field');
  },
  'values-are-compared': async () => {
    const { M, combination } = await validInputs();
    const d = documents(combination);
    const inspect = ({ bindingOver = {}, pairOver = {} } = {}) => {
      const binding = { ...d.binding, ...bindingOver };
      const oracle = { ...d.oracle, contract_hash: binding.contract_hash };
      const candidate = { ...d.candidate, contract_hash: binding.contract_hash };
      const pair = { ...d.pair, runtime_binding_hash: hashJson(binding), attempt_nonce: binding.attempt_nonce, oracle_evidence_hash: hashJson(oracle), candidate_evidence_hash: hashJson(candidate), ...pairOver };
      const sealed = { binding: seal(binding, 'runtime', '1'), pair: seal(pair, 'runtime', '1'), oracle: seal(oracle, 'runtime', '1'), candidate: seal(candidate, 'runtime', '1') };
      const projection = { ...d.projection(sealed), runtimeBindingHash: hashJson(binding), profileApprovalHash: binding.oracle_profile_approval_hash, candidateArtifactSha256: binding.candidate_hash, runId: binding.run_id, attemptNonce: binding.attempt_nonce };
      return M.evidence.inspectRuntimeBehaviorProjection({
        expected: { ...combination, candidateRevision: REV, profileId: PROFILE },
        bindingBytes: sealed.binding.bytes, bindingRef: sealed.binding.ref, pairBytes: sealed.pair.bytes, pairRef: sealed.pair.ref,
        oracleEvidenceBytes: sealed.oracle.bytes, oracleEvidenceRef: sealed.oracle.ref, candidateEvidenceBytes: sealed.candidate.bytes, candidateEvidenceRef: sealed.candidate.ref, projection
      });
    };
    const verdict = (result) => [result.status, result.blockers.map((item) => item.code)];
    assert.deepEqual(verdict(inspect()), ['eligible', []]);
    assert.deepEqual(verdict(inspect({ pairOver: { oracle_evidence_hash: H('0') } })), ['blocked', ['oracle-evidence-hash-mismatch']]);
    for (const hash of ['', null, 0]) assert.deepEqual(verdict(inspect({ pairOver: { oracle_evidence_hash: hash, candidate_evidence_hash: hash } })), ['eligible', []], `pair hash ${String(hash)}`);
    for (const over of [{ run_id: '' }, { attempt_nonce: '' }, { contract_hash: null }, { oracle_profile_approval_hash: '' }, { case_revision_hash: 'zz' }, { flow_hash: null }, { artifacts: [] }]) assert.deepEqual(verdict(inspect({ bindingOver: over })), ['eligible', []], JSON.stringify(over));
    assert.deepEqual(verdict(inspect({ bindingOver: { candidate_hash: 'zz' } })), ['blocked', ['candidate-artifact-unbound']]);
  },
  'no-unknown-status': async () => {
    const statuses = Object.entries((await derive()).results.statuses).filter(([key]) => !key.endsWith('.ok')).flatMap(([, values]) => values);
    assert.deepEqual([...new Set(statuses)].sort(), ['blocked', 'certified', 'eligible', 'ready']);
  },
  'fail-closed-profiles': async () => {
    const { M } = await validInputs();
    const handlesPlan = { resources: [{ type: 'User', willGenerateResolver: true, idFieldIsUuid: true }] };
    const columns = { 'java-spring': ['provider-backed-read', 'provider-policy', 'provider-policy', 'provider-policy'], 'python-fastapi': ['provider-backed-read', 'fail-closed-stub', 'fail-closed-stub', 'gated-by-access-stub'], 'typescript-express': ['provider-backed-read', 'fail-closed-stub', 'fail-closed-stub', 'gated-by-access-stub'] };
    for (const [providerId, expected] of Object.entries(columns)) {
      const result = M.safety.describeResourceGeneration({ providerId, handlesPlan });
      const [decision] = result.decisions;
      assert.deepEqual([decision.fetch, decision.authorization, decision.patch, decision.recover], expected, providerId);
      assert.deepEqual(result.manualCompletions.map((item) => item.area).sort(), providerId === 'java-spring' ? [] : ['authorization', 'patch'], providerId);
    }
  },
  'inherited-names': async () => {
    const { M } = await validInputs();
    const handlesPlan = { resources: [{ type: 'User', willGenerateResolver: true, idFieldIsUuid: true }] };
    for (const providerId of ['constructor', 'toString', 'hasOwnProperty']) {
      const [decision] = M.safety.describeResourceGeneration({ providerId, handlesPlan }).decisions;
      assert.deepEqual([decision.generated, decision.fetch, decision.authorization, decision.patch, decision.recover], [true, undefined, undefined, undefined, undefined], `${providerId}: a profile was found where none exists`);
      assert.equal(typeof M.cert.requiredEvidenceFor({ providerId, level: 'build-tested' })[2], 'function', `${providerId}: a function is listed where an evidence kind belongs`);
    }
    assert.throws(() => M.safety.describeResourceGeneration({ providerId: 'future-provider', handlesPlan }), /no conservative generation profile/);
  }
};
for (const [id, body] of Object.entries(RULE_TESTS)) test(`rule ${id}`, body);

// ---- Negative tests: every checker above must fail when the thing it guards drifts ----
const damage = (value, mutate) => { const copy = clone(value); mutate(copy); return copy; };
const mentions = (problems, pattern) => problems.some((line) => pattern.test(line));
const checkerRun = (rows) => spawnSync(process.execPath, [path.join(ROOT, 'next/t00/check-ownership.mjs'), 'paths', '--track', lib.TRACK.suiteId, ...rows.map((row) => row.path)], { cwd: ROOT, encoding: 'utf8' });

test('negative: a vocabulary that differs from the code is reported', async () => {
  const { vocab } = onDisk();
  const derived = await derive();
  assert.deepEqual(vocabProblems(vocab, derived, record), [], 'control: the pinned vocabulary has no problem');
  const cases = [
    ['a code removed', (v) => { v.derived.results.codes.inspectPersistenceHandoff.pop(); }, /results\/codes\/inspectPersistenceHandoff/],
    ['a status renamed', (v) => { v.derived.results.statuses.previewGeneration[0] = 'partial'; }, /results\/statuses\/previewGeneration/],
    ['an export added', (v) => { v.derived.modules['catalog.mjs'].exports.push({ name: 'extra', kind: 'constant' }); }, /modules\/catalog\.mjs\/exports/],
    ['a catalog entry changed', (v) => { v.derived.catalog.entries[0].keyType = 'bigint'; }, /catalog\/entries/],
    ['a file added to the directory', (v) => { v.derived.directory.files.push('extra.mjs'); }, /directory\/files/],
    ['a flag changed', (v) => { v.derived.results.flags['previewGeneration.applyAllowed'] = ['true']; }, /results\/flags/],
    ['a crash class changed', (v) => { v.derived.results.crashes.previewGeneration = ['RangeError']; }, /results\/crashes/],
    ['an import added', (v) => { v.derived.modules['catalog.mjs'].imports.push('node:fs'); }, /modules\/catalog\.mjs\/imports/],
    ['the schema renamed', (v) => { v.schema = 'bskel.t14-interface-vocabulary/2'; }, /schema is/],
    ['a key added', (v) => { v.extra = 1; }, /vocabulary keys/]
  ];
  for (const [label, mutate, pattern] of cases) assert.ok(mentions(vocabProblems(damage(vocab, mutate), derived, record), pattern), label);
  assert.ok(mentions(vocabProblems(null, derived, record), /not an object/));
});

test('negative: a narrative that does not fit the code is reported', () => {
  const { vocab } = onDisk();
  const check = (mutate) => vocabProblems(damage(vocab, mutate), vocab.derived, record);
  assert.deepEqual(vocabProblems(vocab, vocab.derived, record), [], 'control');
  const cases = [
    ['a file without a role', (v) => { delete v.narrative.files['plan.mjs']; }, /narrative\.files/],
    ['a role for a file that is gone', (v) => { v.narrative.files['gone.mjs'] = { role: 'x' }; }, /narrative\.files/],
    ['a recorded test without a description', (v) => { delete v.narrative.recordedTests['evidence-boundary.test.mjs']; }, /narrative\.recordedTests/],
    ['a family removed', (v) => { v.narrative.families.pop(); }, /narrative\.families/],
    ['a family pattern widened', (v) => { v.narrative.families[0].pattern = '.'; }, /in 2 families|in 3 families/],
    ['a word at the wrong place', (v) => { v.narrative.words[0].where = ['results/codes/inspectPersistenceHandoff']; }, /narrative\.words/],
    ['a word found nowhere', (v) => { v.narrative.words[0].where = []; }, /found nowhere/],
    ['a word twice', (v) => { v.narrative.words.push(v.narrative.words[0]); }, /narrative\.words: .* twice/],
    ['a key set changed', (v) => { v.narrative.keySets[0].keys += ', extra'; }, /narrative\.keySets/],
    ['a contract missing', (v) => { v.narrative.contracts.pop(); }, /narrative\.contracts/],
    ['a crash missing', (v) => { v.narrative.crashes.pop(); }, /narrative\.crashes/],
    ['a field of a module that does not exist', (v) => { v.narrative.fields[0].module = 'gone.mjs'; }, /not a module of the layer/],
    ['a field that is not in its module', (v) => { v.narrative.fields[0].name = 'noSuchField'; }, /does not occur in/],
    ['a field twice', (v) => { v.narrative.fields.push(v.narrative.fields[0]); }, /narrative\.fields: .* twice/],
    ['an incomplete field entry', (v) => { v.narrative.fields.push({ name: 'x' }); }, /narrative\.fields: incomplete/],
    ['a verdict that does not exist', (v) => { v.narrative.ownership[0].verdict = 'MAYBE'; }, /verdict/],
    ['an owner without a foreign verdict', (v) => { v.narrative.ownership[0].owner = 'T99'; }, /do not belong together/],
    ['a rule twice', (v) => { v.narrative.rules.push(v.narrative.rules[0]); }, /narrative\.rules: .* twice/],
    ['an incomplete prose entry', (v) => { v.narrative.prose.push({ token: 'x' }); }, /narrative\.prose/],
    ['a section added to the narrative', (v) => { v.narrative.extra = []; }, /narrative keys/],
    ['a heading that is not a heading', (v) => { v.narrative.headings.push('text'); }, /narrative\.headings/]
  ];
  for (const [label, mutate, pattern] of cases) assert.ok(mentions(check(mutate), pattern), label);
});

test('negative: a document whose tables, headings, names or rule statements drift from the vocabulary is reported', () => {
  const { vocab, rfc } = onDisk();
  assert.deepEqual(rfcProblems(rfc, vocab, record), [], 'control');
  const blocks = blocksOf(vocab, record);
  const hash = '#';
  const slash = '/';
  const cases = [
    ['a table row removed', rfc.replace(`${blocks.catalog.split('\n')[2]}\n`, ''), /table catalog stands 0 times/],
    ['a table cell changed', rfc.replace(blocks.profiles, blocks.profiles.replace('fail-closed-stub', 'fail-open-stub')), /table profiles stands 0 times/],
    ['a table that is not rendered', `${rfc}\n| a | b |\n| --- | --- |\n| c | d |\n`, /not rendered from the vocabulary/],
    ['an unknown name', `${rfc}\nCall \`noSuchFunction\` first.\n`, /unknown name in the document: noSuchFunction/],
    ['a code renamed in the whole document', rfc.split('requested-resource-missing').join('requested-resource-gone'), /does not spell requested-resource-missing/],
    ['a heading renamed', rfc.replace(vocab.narrative.headings[1], `${vocab.narrative.headings[1]} (old)`), /headings differ/],
    ['an issue number', `${rfc}\nSee ${hash}${'12'}.\n`, /forbidden text/],
    ['a pull request number', `${rfc}\nSee ${['PR', '12'].join(' ')}.\n`, /forbidden text/],
    ['a pull request path', `${rfc}\nSee ${slash}pull${slash}12.\n`, /forbidden text/],
    ['an issue path', `${rfc}\nSee ${slash}issues${slash}12.\n`, /forbidden text/],
    ['a short issue label', `${rfc}\nSee ${['GH', '12'].join('-')}.\n`, /forbidden text/],
    ['a pull ref', `${rfc}\nSee refs${slash}pull${slash}head.\n`, /forbidden text/],
    ['a tab', `${rfc}\tx\n`, /tab character/],
    ['a carriage return', rfc.replace('\n', '\r\n'), /carriage return/],
    ['trailing spaces', rfc.replace('\n', ' \n'), /trailing spaces/],
    ['no final newline', rfc.trimEnd(), /exactly one newline/],
    ['two final newlines', `${rfc}\n`, /exactly one newline/],
    ['too many lines', `${rfc}${'filler\n'.repeat(LINE_CAP)}`, /more than/],
    ['the hash function named in a sentence between the tables (a sentence added)', `${rfc}\nThe function \`t16HashJson\` returns a hash for every value.\n`, /t16HashJson is named between the tables/],
    ['the hash function named in a sentence between the tables (a sentence rewritten)', rfc.replace('the hash function of the evidence module', '`t16HashJson`'), /t16HashJson is named between the tables/]
  ];
  for (const [label, text, pattern] of cases) assert.ok(mentions(rfcProblems(text, vocab, record), pattern), label);
  const withProse = damage(vocab, (v) => { v.narrative.prose.push({ token: 'neverUsedToken', reason: 'x' }); });
  assert.ok(mentions(rfcProblems(rfc, withProse, record), /prose token neverUsedToken is not used/));
  const withRule = damage(vocab, (v) => { v.narrative.rules.push({ id: 'extra', statement: 'A sentence that the document does not contain.' }); });
  assert.ok(mentions(rfcProblems(rfc, withRule, record), /rule extra is not stated/));
});

test('negative: a changed or added file is reported against the pinned vocabulary', async () => {
  const { vocab } = onDisk();
  // Each case works on a fresh copy of the module directory; the copy is imported from its own path, so nothing is cached.
  const copyProblems = async (edit) => {
    const dir = lib.tmpDir('t14-modules-');
    fs.cpSync(path.join(ROOT, DIR), dir, { recursive: true });
    edit(dir);
    try { return vocabProblems(vocab, await derive({ moduleDir: dir }), record); } catch (error) { return [`derive failed: ${error.message}`]; }
  };
  const editFile = (file, change) => (dir) => {
    const target = path.join(dir, file);
    const before = readText(target);
    const after = change(before);
    assert.notEqual(after, before, `${file}: the edit changed nothing`);
    fs.writeFileSync(target, after);
  };
  assert.deepEqual(await copyProblems(() => {}), [], 'control: an unchanged copy has no problem');
  const cases = [
    ['a code renamed', editFile('plan.mjs', (s) => s.replaceAll("'requested-resource-missing'", "'requested-resource-absent'")), /results\/codes|text\/codes/],
    ['a blocker code renamed in the evidence boundary', editFile('evidence-boundary.mjs', (s) => s.replaceAll("'handoff-not-approved'", "'handoff-not-accepted'")), /results\/codes|text\/codes/],
    ['a status renamed', editFile('plan.mjs', (s) => s.replace("'ready'", "'partial'")), /results\/statuses/],
    ['an export added', editFile('catalog.mjs', (s) => `${s}export const EXTRA_ENTRY = Object.freeze({});\n`), /modules\/catalog\.mjs\/exports/],
    ['a code that no probe reaches', editFile('safety-profile.mjs', (s) => `${s}export function neverCalled() { return { code: 'never-reached-code' }; }\n`), /coverage codesNotReached/],
    ['a thrown message reworded', editFile('certification.mjs', (s) => s.replace('unknown certification level', 'unsupported certification level')), /thrown/],
    ['a key type changed', editFile('catalog.mjs', (s) => s.replaceAll("keyType: 'uuid'", "keyType: 'bigint'")), /catalog\/entries|derive failed/],
    ['an import added', editFile('catalog.mjs', (s) => `import crypto from 'node:crypto';\n${s}`), /modules\/catalog\.mjs\/imports/],
    ['a file added to the module directory', (dir) => fs.writeFileSync(path.join(dir, 'extra.mjs'), ''), /directory\/files/]
  ];
  for (const [label, edit, pattern] of cases) assert.ok(mentions(await copyProblems(edit), pattern), label);
  // An added test file is a change of the test directory listing.
  const testDir = lib.tmpDir('t14-tests-');
  for (const name of [...vocab.derived.directory.tests, 'extra.test.mjs']) fs.writeFileSync(path.join(testDir, name), '');
  assert.ok(mentions(vocabProblems(vocab, await derive({ testDir }), record), /directory\/tests/));
});

test('negative: a wrong ownership table is reported', () => {
  const { vocab } = onDisk();
  const rows = vocab.narrative.ownership;
  const output = checkerRun(rows).stdout;
  assert.deepEqual(ownershipProblems(rows, output), [], 'control');
  const edit = (path1, change) => damage(rows, (list) => change(list.find((row) => row.path === path1)));
  const cases = [
    ['a verdict changed', ownershipProblems(edit('handles/providers/java-spring.mjs', (row) => { row.verdict = 'PATH_RESERVED_HOT'; }), output), /the checker says PATH_UNOWNED/],
    ['an owner changed', ownershipProblems(edit('scanners/persistence-next/generation-handoff.mjs', (row) => { row.owner = 'T11'; }), output), /names the owner T10/],
    ['an own path claimed foreign', ownershipProblems(edit('handles/composition-next/plan.mjs', (row) => { row.verdict = 'PATH_UNOWNED'; }), output), /the checker says OK/],
    ['a row removed', ownershipProblems(rows.filter((row) => row.path !== 'package.json'), output), /reports a path that the table lacks/],
    ['a checker line missing', ownershipProblems(rows, output.split('\n').slice(1).join('\n')), /the checker says OK, the table says PATH_UNOWNED/],
    ['an unreadable line', ownershipProblems(rows, `${output}garbage\n`), /unreadable checker line/]
  ];
  for (const [label, problems, pattern] of cases) assert.ok(mentions(problems, pattern), label);
});

test('keys that every object inherits never resolve as names', () => {
  const { vocab } = onDisk();
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(own({}, key), undefined, key);
    assert.deepEqual(stringsAt(vocab.derived, key), [], key);
    assert.deepEqual(stringsAt(vocab.derived, `results/${key}/x`), [], key);
  }
  // JSON.parse makes __proto__ an ordinary own key: the lookups skip it and the checks report it.
  const hostile = JSON.parse(JSON.stringify(vocab).replace('"files":{', '"files":{"__proto__":{"role":"x"},'));
  assert.ok(Object.hasOwn(hostile.narrative.files, '__proto__'));
  assert.doesNotThrow(() => blocksOf(hostile, record));
  assert.ok(mentions(vocabProblems(hostile, vocab.derived, record), /narrative\.files/));
});

test('importsOf reads static, re-export, side-effect and dynamic imports and flags computed ones', () => {
  const cases = [
    ["import a from './a.mjs';", ['./a.mjs'], 0],
    ['import { x } from "node:crypto";', ['node:crypto'], 0],
    ["export * from './b.mjs';\nexport { y } from './c.mjs';", ['./b.mjs', './c.mjs'], 0],
    ["import './side.mjs';", ['./side.mjs'], 0],
    ["const m = await import('./d.mjs');", ['./d.mjs'], 0],
    ["// import z from './no.mjs';\n/* import q from './no2.mjs' */\nconst s = 1;", [], 0],
    ["const name = './e.mjs'; await import(name);", [], 1],
    ["const r = require('./f.cjs');", [], 1],
    ["import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);", ['node:module'], 2],
    ['', [], 0]
  ];
  for (const [source, specs, opaque] of cases) {
    const found = lib.importsOf(source);
    assert.deepEqual([found.specs, found.opaque.length], [specs, opaque], source);
  }
});

test('hostAccessOf reports clock, random, process, console and asynchronous constructs', () => {
  assert.deepEqual(hostAccessOf('export const a = (x) => x + 1;\n'), []);
  assert.deepEqual(hostAccessOf('const t = Date.now(); const r = Math.random(); console.log(process.env.X);'), ['Date', 'Math.random', 'console', 'process']);
  assert.deepEqual(hostAccessOf('export async function f() { return await g(); }'), ['async', 'await']);
  assert.deepEqual(hostAccessOf('const b = crypto.randomBytes(4); setTimeout(f, 1); new Promise(r);'), ['Promise', 'randomBytes', 'setTimeout']);
  assert.deepEqual(hostAccessOf('const dated = 1; const processed = 2; const awaiting = 3;'), []);
});
