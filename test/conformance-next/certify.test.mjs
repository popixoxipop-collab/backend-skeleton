import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assembleCertification, evaluateDifferentialGate, evaluateNegativeVectorRun, holdoutAttestationPayload, injectHoldoutManifest, verifyEvidencePackFromDisk, verifyHoldoutAttestationWithRegistry } from './certify.mjs';
import { sha256 } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'corpus-next', 'corpus-manifest.json'), 'utf8'));
const VECTORS = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'corpus-next', 'negative-vectors.json'), 'utf8'));
const MUTATIONS = JSON.parse(fs.readFileSync(path.join(HERE, 'mutations.json'), 'utf8'));
const PRODUCT_MUTATIONS = JSON.parse(fs.readFileSync(path.join(HERE, 'product-mutations.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

function corpusSource(entry) {
  return { owner: entry.owner, repo: entry.repo, ref: entry.ref, path: entry.path ?? null };
}

function addCorpusEntryEvidence(root, entry, differential, artifacts, { signingKey = null, keyId = 'test-attestor', releaseSourceCommit = 'd'.repeat(40) } = {}) {
  const inventoryId = entry.id + ':inventory';
  const result = {
    entry_id: entry.id,
    source: corpusSource(entry),
    gold: [inventoryId],
    observed: [{ id: inventoryId, status: 'verified' }],
    evidence_artifact: 'corpus/' + entry.id + '.json',
  };
  const doc = {
    contract: 'sbf.qa-corpus-entry-result/1',
    entry_id: result.entry_id,
    source: result.source,
    run: {
      kind: 'controlled-checkout',
      runner_id: 't19-test-runner',
      run_id: 'run-' + entry.id,
      checkout_commit: entry.ref,
      command: 'bskel scan --json',
      exit_code: 0,
    },
    release_source_commit: releaseSourceCommit,
    gold: result.gold,
    observed: result.observed,
  };
  if (signingKey) {
    doc.attestation = { alg: 'ed25519', key_id: keyId, signature_b64: '' };
    doc.attestation.signature_b64 = sign(null, holdoutAttestationPayload(doc), signingKey).toString('base64');
  }
  const bytes = Buffer.from(JSON.stringify(doc) + '\n');
  fs.mkdirSync(path.join(root, 'corpus'), { recursive: true });
  fs.writeFileSync(path.join(root, result.evidence_artifact), bytes);
  differential.entry_results.push(result);
  artifacts.push({ path: result.evidence_artifact, sha256: sha256(bytes), size_bytes: bytes.length });
  return result;
}

function passingInput(root) {
  const body = Buffer.from('evidence\n');
  fs.writeFileSync(path.join(root, 'evidence.txt'), body);
  const releaseCommit = 'd'.repeat(40);
  const differential = { source_commit: releaseCommit, gold: ['A', 'B'], observed: [{ id: 'A', status: 'verified' }, { id: 'B', status: 'verified' }], entry_results: [] };
  const artifacts = [{ path: 'evidence.txt', sha256: sha256(body), size_bytes: body.length }];
  for (const entry of CORPUS.entries) addCorpusEntryEvidence(root, entry, differential, artifacts);
  return {
    corpus: clone(CORPUS),
    negative_vectors: clone(VECTORS),
    differential,
    negative_run: { source_commit: releaseCommit, results: VECTORS.vectors.map((v) => ({ id: v.id, status: 'caught' })) },
    mutation: {
      contract: 'sbf.qa-mutation-bundle/1',
      source_commit: releaseCommit,
      harness: { contract: 'sbf.qa-mutation-report/1', source_commit: releaseCommit, catalog_sha256: sha256(Buffer.from(JSON.stringify(MUTATIONS))), mutants: MUTATIONS.mutants.map((m) => ({ id: m.id, critical: m.critical, status: 'killed' })) },
      product: { contract: 'sbf.qa-product-mutation-report/1', source_commit: releaseCommit, catalog_sha256: sha256(Buffer.from(JSON.stringify(PRODUCT_MUTATIONS))), source_materialization: 'git-archive', dependency_install: { mode: 'npm-ci-ignore-scripts', package_lock_sha256: 'a'.repeat(64) }, mutants: PRODUCT_MUTATIONS.mutants.map((m) => ({ id: m.id, critical: m.critical, status: 'killed' })) },
    },
    evidence: {
      contract: 'sbf.qa-evidence/1', scope: 'fixture:all', source_commit: 'd'.repeat(40), adapter_id: 'fixture', target_profile: 'node-test', verdict: 'pass',
      commands: [{ argv: 'node --test', status: 'executed', exit_code: 0 }],
      assertions: [{ id: 'all', required: true, status: 'passed' }],
      artifacts,
    },
  };
}

test('differential gate meets initial precision/recall thresholds only with explicit denominators', () => {
  const ok = evaluateDifferentialGate({ gold: ['A','B'], observed: [{id:'A',status:'verified'},{id:'B',status:'verified'}] });
  assert.equal(ok.pass, true);
  const empty = evaluateDifferentialGate({ gold: [], observed: [] });
  assert.equal(empty.pass, false);
  assert.match(empty.reasons.join(' '), /denominator|undefined/);
});

test('negative vector run fails a missing critical result instead of shrinking the denominator', () => {
  const results = VECTORS.vectors.filter((v) => v.id !== 'NEG-RUN-01').map((v) => ({ id: v.id, status: 'caught' }));
  const out = evaluateNegativeVectorRun({ catalog: VECTORS, results });
  assert.equal(out.pass, false);
  assert.ok(out.critical_failures.includes('NEG-RUN-01'));
  assert.ok(out.reasons.some((x) => x.includes('missing negative vector result')));
});

test('negative vector run fails when any executable noncritical vector is missed', () => {
  const results = VECTORS.vectors.map((v) => ({ id: v.id, status: 'caught' }));
  const noncritical = VECTORS.vectors.find((v) => !v.critical);
  assert.ok(noncritical);
  results.find((r) => r.id === noncritical.id).status = 'missed';
  const out = evaluateNegativeVectorRun({ catalog: VECTORS, results });
  assert.equal(out.pass, false);
  assert.ok(out.reasons.some((x) => x.includes('executable coverage')));
});

test('mutation equivalence requires explicit approval in the committed mutation catalog', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-mut-eq-'));
  try {
    const input=passingInput(root);
    const noncritical=input.mutation.harness.mutants.find((m)=>!m.critical);
    assert.ok(noncritical);
    noncritical.status='equivalent';
    const report=assembleCertification(input,{artifact_root:root,require_holdout:false,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('equivalent result is not approved by the committed mutation catalog')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('negative vector equivalence requires explicit approval in the committed catalog', () => {
  const results = VECTORS.vectors.map((v) => ({ id: v.id, status: 'caught' }));
  const noncritical = VECTORS.vectors.find((v) => !v.critical);
  assert.ok(noncritical);
  results.find((r) => r.id === noncritical.id).status = 'equivalent';
  const out = evaluateNegativeVectorRun({ catalog: VECTORS, results });
  assert.equal(out.pass, false);
  assert.ok(out.reasons.some((x) => x.includes('not approved by the committed catalog')));
});

test('disk evidence verifier rejects path traversal and missing artifact bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t19-evidence-'));
  try {
    const pack = {
      contract:'sbf.qa-evidence/1',scope:'x',source_commit:'e'.repeat(40),adapter_id:'x',target_profile:'x',verdict:'pass',
      commands:[{argv:'x',status:'executed',exit_code:0}],assertions:[{id:'x',required:true,status:'passed'}],
      artifacts:[{path:'../escape',sha256:'0'.repeat(64),size_bytes:0}],
    };
    const out = verifyEvidencePackFromDisk(pack,{artifact_root:root});
    assert.equal(out.ok,false);
    assert.ok(out.errors.some((x)=>x.includes('unsafe artifact path')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('external holdout injection rejects source-family leakage into the reference corpus', () => {
  const holdout = {
    contract: 'sbf.qa-holdout/1',
    entries: [{ ...CORPUS.entries[0], id: 'leaked-holdout' }],
  };
  const result = injectHoldoutManifest(clone(CORPUS), holdout);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => x.includes('crosses reference and holdout')));
});

test('external holdout injection keeps the public corpus unchanged and can satisfy the holdout readiness gate', () => {
  const holdout = {
    contract: 'sbf.qa-holdout/1',
    entries: [{
      id: 'private-holdout-fixture',
      adapter: 'java-spring',
      owner: 'example-owner',
      repo: 'example-private-holdout',
      ref: '9'.repeat(40),
      path: null,
      terms: ['widget'],
      license_spdx: 'MIT',
      source_family: 'private-holdout-fixture-family',
      golden_basis: 'Synthetic unit-test-only external holdout metadata; not a production certification corpus.',
      expected_limitations: ['Unit-test-only metadata.'],
    }],
  };
  const before = JSON.stringify(CORPUS);
  const result = injectHoldoutManifest(clone(CORPUS), holdout);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.corpus.holdout_entries.length, 1);
  assert.equal(JSON.stringify(CORPUS), before);
});

test('certification requires an external release commit and rejects stale evidence from another head', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const input=passingInput(root);
    const missing=assembleCertification(input,{artifact_root:root,require_holdout:false});
    assert.equal(missing.verdict,'fail');
    assert.ok(missing.reasons.some((x)=>x.includes('--source-commit')));
    const stale=assembleCertification(input,{artifact_root:root,require_holdout:false,source_commit:'e'.repeat(40)});
    assert.equal(stale.verdict,'fail');
    assert.ok(stale.reasons.some((x)=>x.includes('does not match certified release commit')));
    const exact=assembleCertification(input,{artifact_root:root,require_holdout:false,source_commit:'d'.repeat(40)});
    assert.equal(exact.verdict,'pass',exact.reasons.join('\n'));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('certification rejects stale differential, negative, and mutation reports even when generic evidence is fresh', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-report-head-'));
  try {
    for (const section of ['differential','negative_run','mutation']) {
      const input=passingInput(root);
      input[section].source_commit='e'.repeat(40);
      const report=assembleCertification(input,{artifact_root:root,require_holdout:false,source_commit:'d'.repeat(40)});
      assert.equal(report.verdict,'fail');
      assert.ok(report.reasons.some((x)=>x.includes(section === 'negative_run' ? 'negative: source_commit' : section + ': source_commit') || x.includes('mutation bundle: source_commit')));
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('artifact-bearing evidence requires an artifact root before certification can pass', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const report=assembleCertification(passingInput(root),{artifact_root:null,require_holdout:false,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('artifact_root is required')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('certification stays blocked with an empty holdout even when every executable gate passes', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const report=assembleCertification(passingInput(root),{artifact_root:root,require_holdout:true,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'blocked');
    assert.match(report.reasons.at(-1),/holdout corpus is empty/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('reference-only internal validation can pass only when explicitly allowing no holdout', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const report=assembleCertification(passingInput(root),{artifact_root:root,require_holdout:false,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'pass',report.reasons.join('\n'));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('pass evidence requires an executed success and a passed assertion even when records are optional', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const input=passingInput(root);
    input.evidence.commands=[{argv:'node --test',status:'skipped',reason:'not run',required:false}];
    input.evidence.assertions=[{id:'optional',status:'skipped',required:false}];
    const report=assembleCertification(input,{artifact_root:root,require_holdout:false,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('successfully executed command')));
    assert.ok(report.reasons.some((x)=>x.includes('passed assertion')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('a structurally valid FAIL evidence pack forces certification to fail', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const input=passingInput(root);
    input.evidence.verdict='fail';
    input.evidence.commands=[{argv:'node product-test.mjs',status:'executed',exit_code:1}];
    input.evidence.assertions=[{id:'product-behavior',required:true,status:'failed'}];
    const report=assembleCertification(input,{artifact_root:root,require_holdout:false,source_commit:'d'.repeat(40)});
    assert.equal(report.gates.evidence.ok,true,report.gates.evidence.errors.join('\n'));
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('failed product/conformance run')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('holdout absence never downgrades a real conformance failure into blocked', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const input=passingInput(root);
    input.mutation.harness.mutants[0].status='survived';
    const report=assembleCertification(input,{artifact_root:root,require_holdout:true,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('mutation')));
    assert.ok(report.reasons.some((x)=>x.includes('holdout corpus is empty')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('certification requires the exact committed reference corpus entries', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const input=passingInput(root);
    input.corpus.entries=input.corpus.entries.slice(1);
    const report=assembleCertification(input,{artifact_root:root,require_holdout:false,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('reference corpus entries do not exactly match')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('certification requires the exact committed 79-vector catalog', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const input=passingInput(root);
    input.negative_vectors.vectors=input.negative_vectors.vectors.slice(1);
    input.negative_run.results=input.negative_run.results.slice(1);
    const report=assembleCertification(input,{artifact_root:root,require_holdout:false,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('committed 79-vector manifest')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('certification rejects product mutation reports without controlled commit materialization metadata', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-product-provenance-'));
  try {
    for (const mutate of [
      (product)=>{ delete product.source_materialization; },
      (product)=>{ product.dependency_install.mode='live-node-modules'; },
      (product)=>{ product.dependency_install.package_lock_sha256='not-a-digest'; },
    ]) {
      const input=passingInput(root);
      mutate(input.mutation.product);
      const report=assembleCertification(input,{artifact_root:root,require_holdout:false,source_commit:'d'.repeat(40)});
      assert.equal(report.verdict,'fail');
      assert.ok(report.reasons.some((x)=>x.includes('product:')));
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('certification rejects mutation reports whose catalog digest is not the committed definition set', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-mut-digest-'));
  try {
    const input=passingInput(root);
    input.mutation.harness.catalog_sha256='0'.repeat(64);
    const report=assembleCertification(input,{artifact_root:root,require_holdout:false,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('catalog_sha256') && x.includes('committed catalog')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('certification rejects a mutation bundle that omits committed harness/product mutants', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const input=passingInput(root);
    input.mutation.harness.mutants=input.mutation.harness.mutants.slice(0,1);
    const report=assembleCertification(input,{artifact_root:root,require_holdout:false,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('missing mutant result')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('certification fails when a critical mutation survives', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const input=passingInput(root);
    input.mutation.harness.mutants[0].status='survived';
    const report=assembleCertification(input,{artifact_root:root,require_holdout:false,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('mutation')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('CLI emits JSON and exit 2 for a fully passing reference-only bundle whose holdout is not ready', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cli-'));
  try {
    const input=passingInput(root);
    const r=spawnSync(process.execPath,[path.join(HERE,'certify.mjs'),'--artifact-root',root,'--source-commit','d'.repeat(40)],{input:JSON.stringify(input),encoding:'utf8'});
    assert.equal(r.status,2,r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict,'blocked');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('an injected holdout without exact-id differential coverage stays failed', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-holdout-bind-'));
  try {
    const input=passingInput(root);
    const injected=injectHoldoutManifest(input.corpus,{contract:'sbf.qa-holdout/1',entries:[{
      id:'bound-holdout',adapter:'java-spring',owner:'example-owner',repo:'bound-holdout',ref:'7'.repeat(40),path:null,
      terms:['widget'],license_spdx:'MIT',source_family:'bound-holdout-family',golden_basis:'unit test',expected_limitations:[],
    }]});
    assert.equal(injected.ok,true,injected.errors.join('\n'));
    input.corpus=injected.corpus;
    const report=assembleCertification(input,{artifact_root:root,require_holdout:true,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('requires exactly one differential entry result')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('holdout inventory artifact without controlled checkout provenance cannot certify', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-holdout-provenance-'));
  try {
    const input=passingInput(root);
    const entry={id:'prov-holdout',adapter:'java-spring',owner:'example-owner',repo:'prov-holdout',ref:'6'.repeat(40),path:null,terms:['widget'],license_spdx:'MIT',source_family:'prov-family',golden_basis:'unit test',expected_limitations:[]};
    const injected=injectHoldoutManifest(input.corpus,{contract:'sbf.qa-holdout/1',entries:[entry]});
    assert.equal(injected.ok,true,injected.errors.join('\n'));
    input.corpus=injected.corpus;
    const result=addCorpusEntryEvidence(root,entry,input.differential,input.evidence.artifacts);
    const artifactPath=path.join(root,result.evidence_artifact);
    const doc=JSON.parse(fs.readFileSync(artifactPath,'utf8'));
    delete doc.run;
    const bytes=Buffer.from(JSON.stringify(doc)+'\n');
    fs.writeFileSync(artifactPath,bytes);
    const declared=input.evidence.artifacts.find((a)=>a.path===result.evidence_artifact);
    declared.sha256=sha256(bytes); declared.size_bytes=bytes.length;
    const report=assembleCertification(input,{artifact_root:root,require_holdout:true,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('controlled-checkout provenance')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('private holdout self-attestation is rejected without an independently supplied public key', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-holdout-self-'));
  try {
    const input=passingInput(root);
    const entry={
      id:'runtime-holdout-fixture',adapter:'java-spring',owner:'example-owner',repo:'holdout-fixture',
      ref:'8'.repeat(40),path:null,terms:['widget'],license_spdx:'MIT',source_family:'runtime-holdout-family',
      golden_basis:'Synthetic CLI test metadata supplied from outside the repository.',expected_limitations:['Unit-test-only metadata.'],
    };
    const injected=injectHoldoutManifest(input.corpus,{contract:'sbf.qa-holdout/1',entries:[entry]});
    assert.equal(injected.ok,true,injected.errors.join('\n'));
    input.corpus=injected.corpus;
    addCorpusEntryEvidence(root,entry,input.differential,input.evidence.artifacts);
    const report=assembleCertification(input,{artifact_root:root,require_holdout:true,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('private holdout attestation rejected')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('a valid holdout signature for an older release commit cannot certify a newer release', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-holdout-release-'));
  try {
    const {publicKey,privateKey}=generateKeyPairSync('ed25519');
    const publicKeyPath=path.join(root,'holdout-public.pem');
    fs.writeFileSync(publicKeyPath,publicKey.export({type:'spki',format:'pem'}));
    const input=passingInput(root);
    const entry={id:'signed-old-head',adapter:'java-spring',owner:'example-owner',repo:'holdout-fixture',ref:'8'.repeat(40),path:null,terms:['widget'],license_spdx:'MIT',source_family:'signed-old-family',golden_basis:'test',expected_limitations:[]};
    const injected=injectHoldoutManifest(input.corpus,{contract:'sbf.qa-holdout/1',entries:[entry]});
    assert.equal(injected.ok,true,injected.errors.join('\n'));
    input.corpus=injected.corpus;
    addCorpusEntryEvidence(root,entry,input.differential,input.evidence.artifacts,{signingKey:privateKey,releaseSourceCommit:'c'.repeat(40)});
    const report=assembleCertification(input,{artifact_root:root,require_holdout:true,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('signed holdout release_source_commit')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('holdout signature verification succeeds only against an explicitly trusted registry entry', () => {
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const doc={
    contract:'sbf.qa-corpus-entry-result/1',entry_id:'signed-unit',
    source:{owner:'example-owner',repo:'holdout-fixture',ref:'8'.repeat(40),path:null},
    run:{kind:'controlled-checkout',runner_id:'independent-runner',run_id:'run-1',checkout_commit:'8'.repeat(40),command:'bskel scan --json',exit_code:0},
    release_source_commit:'d'.repeat(40),gold:['x'],observed:[{id:'x',status:'verified'}],
    attestation:{alg:'ed25519',key_id:'unit-independent',signature_b64:''},
  };
  doc.attestation.signature_b64=sign(null,holdoutAttestationPayload(doc),privateKey).toString('base64');
  const registry={contract:'sbf.qa-holdout-attestors/1',keys:[{
    id:'unit-independent',alg:'ed25519',purpose:'t19-private-holdout',status:'active',
    public_key_pem:publicKey.export({type:'spki',format:'pem'}).toString(),
  }]};
  assert.equal(verifyHoldoutAttestationWithRegistry(doc,registry).ok,true);
  assert.equal(verifyHoldoutAttestationWithRegistry(doc,{contract:'sbf.qa-holdout-attestors/1',keys:[]}).ok,false);
});

test('release certification rejects caller-generated signed holdout keys not present in the committed trust registry', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-holdout-untrusted-'));
  try {
    const {privateKey}=generateKeyPairSync('ed25519');
    const input=passingInput(root);
    const entry={
      id:'runtime-holdout-fixture',adapter:'java-spring',owner:'example-owner',repo:'holdout-fixture',
      ref:'8'.repeat(40),path:null,terms:['widget'],license_spdx:'MIT',source_family:'runtime-holdout-family',
      golden_basis:'Synthetic CLI test metadata supplied from outside the repository.',expected_limitations:['Unit-test-only metadata.'],
    };
    const injected=injectHoldoutManifest(input.corpus,{contract:'sbf.qa-holdout/1',entries:[entry]});
    assert.equal(injected.ok,true,injected.errors.join('\\n'));
    input.corpus=injected.corpus;
    addCorpusEntryEvidence(root,entry,input.differential,input.evidence.artifacts,{signingKey:privateKey,keyId:'caller-generated'});
    const report=assembleCertification(input,{artifact_root:root,require_holdout:true,source_commit:'d'.repeat(40)});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('caller-generated') && x.includes('not trusted by committed registry')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('CLI --input reads the same certification payload from a file without shell redirection', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-input-cli-'));
  try {
    const input=passingInput(root);
    const inputPath=path.join(root,'input.json');
    fs.writeFileSync(inputPath,JSON.stringify(input));
    const r=spawnSync(process.execPath,[path.join(HERE,'certify.mjs'),'--artifact-root',root,'--source-commit','d'.repeat(40),'--input',inputPath,'--allow-no-holdout'],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict,'pass');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('CLI --allow-no-holdout is explicit and returns pass for the same internal validation bundle', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cli-'));
  try {
    const input=passingInput(root);
    const r=spawnSync(process.execPath,[path.join(HERE,'certify.mjs'),'--artifact-root',root,'--source-commit','d'.repeat(40),'--allow-no-holdout'],{input:JSON.stringify(input),encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict,'pass');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
