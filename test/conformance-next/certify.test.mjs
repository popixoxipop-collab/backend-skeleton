import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assembleCertification, evaluateDifferentialGate, evaluateNegativeVectorRun, injectHoldoutManifest, verifyEvidencePackFromDisk } from './certify.mjs';
import { sha256 } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'corpus-next', 'corpus-manifest.json'), 'utf8'));
const VECTORS = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'corpus-next', 'negative-vectors.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

function passingInput(root) {
  const body = Buffer.from('evidence\n');
  fs.writeFileSync(path.join(root, 'evidence.txt'), body);
  return {
    corpus: clone(CORPUS),
    negative_vectors: clone(VECTORS),
    differential: { gold: ['A', 'B'], observed: [{ id: 'A', status: 'verified' }, { id: 'B', status: 'verified' }] },
    negative_run: VECTORS.vectors.map((v) => ({ id: v.id, status: 'caught' })),
    mutation: { mutants: [{ id: 'critical', critical: true, status: 'killed' }, { id: 'normal', critical: false, status: 'killed' }] },
    evidence: {
      contract: 'sbf.qa-evidence/1', scope: 'fixture:all', source_commit: 'd'.repeat(40), adapter_id: 'fixture', target_profile: 'node-test', verdict: 'pass',
      commands: [{ argv: 'node --test', status: 'executed', exit_code: 0 }],
      assertions: [{ id: 'all', required: true, status: 'passed' }],
      artifacts: [{ path: 'evidence.txt', sha256: sha256(body), size_bytes: body.length }],
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

test('certification stays blocked with an empty holdout even when every executable gate passes', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const report=assembleCertification(passingInput(root),{artifact_root:root,require_holdout:true});
    assert.equal(report.verdict,'blocked');
    assert.match(report.reasons.at(-1),/holdout corpus is empty/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('reference-only internal validation can pass only when explicitly allowing no holdout', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const report=assembleCertification(passingInput(root),{artifact_root:root,require_holdout:false});
    assert.equal(report.verdict,'pass',report.reasons.join('\n'));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('a structurally valid FAIL evidence pack forces certification to fail', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const input=passingInput(root);
    input.evidence.verdict='fail';
    input.evidence.commands=[{argv:'node product-test.mjs',status:'executed',exit_code:1}];
    input.evidence.assertions=[{id:'product-behavior',required:true,status:'failed'}];
    const report=assembleCertification(input,{artifact_root:root,require_holdout:false});
    assert.equal(report.gates.evidence.ok,true,report.gates.evidence.errors.join('\n'));
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('failed product/conformance run')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('holdout absence never downgrades a real conformance failure into blocked', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const input=passingInput(root);
    input.mutation.mutants[0].status='survived';
    const report=assembleCertification(input,{artifact_root:root,require_holdout:true});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('mutation')));
    assert.ok(report.reasons.some((x)=>x.includes('holdout corpus is empty')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('certification fails when a critical mutation survives', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cert-'));
  try {
    const input=passingInput(root);
    input.mutation.mutants[0].status='survived';
    const report=assembleCertification(input,{artifact_root:root,require_holdout:false});
    assert.equal(report.verdict,'fail');
    assert.ok(report.reasons.some((x)=>x.includes('mutation')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('CLI emits JSON and exit 2 for a fully passing reference-only bundle whose holdout is not ready', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cli-'));
  try {
    const input=passingInput(root);
    const r=spawnSync(process.execPath,[path.join(HERE,'certify.mjs'),'--artifact-root',root],{input:JSON.stringify(input),encoding:'utf8'});
    assert.equal(r.status,2,r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict,'blocked');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('CLI can inject a non-public holdout manifest at runtime without committing it to the reference corpus', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-holdout-cli-'));
  try {
    const input=passingInput(root);
    const holdoutPath=path.join(root,'holdout.json');
    fs.writeFileSync(holdoutPath, JSON.stringify({
      contract:'sbf.qa-holdout/1',
      entries:[{
        id:'runtime-holdout-fixture',adapter:'java-spring',owner:'example-owner',repo:'holdout-fixture',
        ref:'8'.repeat(40),path:null,terms:['widget'],license_spdx:'MIT',source_family:'runtime-holdout-family',
        golden_basis:'Synthetic CLI test metadata supplied from outside the repository.',
        expected_limitations:['Unit-test-only metadata.'],
      }],
    }));
    const r=spawnSync(process.execPath,[path.join(HERE,'certify.mjs'),'--artifact-root',root,'--holdout-manifest',holdoutPath],{input:JSON.stringify(input),encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    const report=JSON.parse(r.stdout);
    assert.equal(report.verdict,'pass',report.reasons.join('\n'));
    assert.equal(report.gates.corpus.stats.holdout_entries,1);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('CLI --input reads the same certification payload from a file without shell redirection', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-input-cli-'));
  try {
    const input=passingInput(root);
    const inputPath=path.join(root,'input.json');
    fs.writeFileSync(inputPath,JSON.stringify(input));
    const r=spawnSync(process.execPath,[path.join(HERE,'certify.mjs'),'--artifact-root',root,'--input',inputPath,'--allow-no-holdout'],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict,'pass');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('CLI --allow-no-holdout is explicit and returns pass for the same internal validation bundle', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-t19-cli-'));
  try {
    const input=passingInput(root);
    const r=spawnSync(process.execPath,[path.join(HERE,'certify.mjs'),'--artifact-root',root,'--allow-no-holdout'],{input:JSON.stringify(input),encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict,'pass');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
