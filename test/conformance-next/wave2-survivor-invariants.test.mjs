import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runNativeServerWorker, NativeWorkerRunError, NATIVE_SERVER_PROTOCOL,
  analyzeRustServerSource } from '../../scanners/language/native-server/index.mjs';
import { scanTypeScriptExpress, detectTypeScriptExpressRoot } from '../../scanners/adapters/typescript-express.mjs';
import { generateKeypair, publicKeyIdFromPublic, signPayload } from '../../lib/attest.mjs';
import { loadEvidenceAuthority, loadEvidenceStore } from '../../release/next/release-policy.mjs';

// Behavioral oracles for five real survivors. No production activation, external
// host, compiler or target application is invoked. Fixture signing keys exist
// only to reach the evidence validator's semantic checks, never as authority.
function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  return root;
}
const request = () => ({protocol:NATIVE_SERVER_PROTOCOL,kind:'analyze-request',
  requestId:'t19-output-limit',language:'go',file:'main.go',source:'package main'});

test('wave2 closeout TRUST-07: process-buffer exhaustion has its exact diagnostic', () => {
  const error = Object.assign(new Error('buffer exhausted'), {code:'ENOBUFS'});
  assert.throws(() => runNativeServerWorker(request(), {spawnFn:() => ({
    error,status:null,signal:'SIGTERM',stdout:'',stderr:'bounded diagnostic',
  })}), err => err instanceof NativeWorkerRunError &&
    err.code === 'WORKER_OUTPUT_LIMIT' && err.stderr === 'bounded diagnostic');
});

test('wave2 closeout TRUST-07 control: a non-buffer spawn failure is not mislabeled', () => {
  const error = Object.assign(new Error('not found'), {code:'ENOENT'});
  assert.throws(() => runNativeServerWorker(request(), {spawnFn:() => ({
    error,status:null,signal:null,stdout:'',stderr:'',
  })}), err => err instanceof NativeWorkerRunError && err.code === 'WORKER_SPAWN_FAILED');
});

test('wave2 closeout ROUTE-03: Rust name-reuse cycle is diagnosed on a reachable graph', () => {
  // Source is statically inspected, not compiled. Reusing a name creates a cycle
  // in the scanner's conservative graph; it must terminate with a diagnostic.
  const source = `fn app() {
    let a = Router::new().route("/a", get(a_handler));
    let b = Router::new().nest("/b", a);
    let a = Router::new().nest("/a", b);
    let app = Router::new().nest("/api", a).route("/health", get(health));
  }`;
  const result = analyzeRustServerSource(source, {file:'cycle.rs'});
  assert.ok(result.diagnostics.some(d => d.code === 'RUST_AXUM_NEST_CYCLE'));
  assert.deepEqual(result.routes.map(r => r.path), ['/health']);
  const acyclic = analyzeRustServerSource(`fn app() {
    let a = Router::new().route("/a", get(a_handler));
    let app = Router::new().nest("/api", a);
  }`);
  assert.deepEqual(acyclic.routes.map(r => r.path), ['/api/a']);
  assert.equal(acyclic.diagnostics.length, 0);
});

for (const cycle of ['two-node','self']) {
  test(`wave2 closeout ROUTE-03: Express ${cycle} cycle retains only finite rooted paths`, t => {
    const root = temporary(t, 't19-express-cycle-');
    fs.mkdirSync(path.join(root,'src'));
    fs.writeFileSync(path.join(root,'package.json'), JSON.stringify({name:'cycle-fixture',dependencies:{express:'^4.18.2'}}));
    fs.writeFileSync(path.join(root,'tsconfig.json'),'{}');
    const prefix = `import express, { Router } from 'express';
      const app = express();
      const a = Router();
      const b = Router();
      app.use('/api', a);
      a.use('/child', b);
      app.get('/health', health);
      a.get('/a', handlerA);
      b.get('/b', handlerB);
    `;
    const target = path.join(root,'src','routes.ts');
    const endpoints = () => {
      const detected = detectTypeScriptExpressRoot(root);
      assert.ok(detected, 'ordinary TypeScript Express fixture must be detected');
      return scanTypeScriptExpress(root,detected).modules.flatMap(m=>m.controllers)
        .flatMap(c=>c.endpoints).map(e=>`${e.verb} ${e.path}`).sort();
    };
    fs.writeFileSync(target, prefix);
    const expected = ['GET /api/a','GET /api/child/b','GET /health'];
    assert.deepEqual(endpoints(), expected, 'acyclic control must expose real routes');
    fs.writeFileSync(target, prefix+(cycle==='self'?"a.use('/self', a);":"b.use('/back', a);"));
    assert.deepEqual(endpoints(), expected, 'cycle must terminate without invented infinite prefixes');
  });
}

const hashRef = bytes => 'sha256:'+createHash('sha256').update(bytes).digest('hex');
function fixtureStore(t, payload) {
  const root=temporary(t,'t19-release-fixture-');
  const keys=generateKeypair(), keyId=publicKeyIdFromPublic(keys.publicKeyPem);
  const authorityBytes=JSON.stringify({schema:'bskel.scale-release-evidence-authority/1',
    trusted_keys:[{key_id:keyId,public_key_pem:keys.publicKeyPem}]})+'\n';
  const authorityPath=path.join(root,'authority.json');fs.writeFileSync(authorityPath,authorityBytes);
  const authority=loadEvidenceAuthority(authorityPath,hashRef(authorityBytes));
  assert.equal(authority.ok,true,JSON.stringify(authority.errors));
  const signed={...payload,attestation:{schema:'bskel.scale-release-evidence-attestation/1',
    key_id:keyId,signature:signPayload(payload,keys.privateKeyPem)}};
  const bytes=JSON.stringify(signed)+'\n',ref=hashRef(bytes);
  fs.mkdirSync(path.join(root,'evidence-artifacts'));
  fs.writeFileSync(path.join(root,'evidence-artifacts','fixture.json'),bytes);
  const manifest=path.join(root,'evidence-manifest.json');
  fs.writeFileSync(manifest,JSON.stringify({schema:'bskel.scale-release-evidence-manifest/1',
    entries:[{ref,path:'evidence-artifacts/fixture.json'}]}));
  return {result:loadEvidenceStore(manifest,authority),ref};
}
const heads={bskel:'1'.repeat(40),becoder:'2'.repeat(40),beval:'3'.repeat(40)};
const basePayload=check_id=>({schema:'bskel.scale-release-evidence/1',check_id,outcome:'PASS',
  observed_at:'2026-10-21T00:00:00Z',release_heads:{...heads}});
for (const [role,repository] of [['bskel','backend-skeleton'],['becoder','backend-decoder'],['beval','Backend-evaluation']]) {
  test(`wave2 closeout RELEASE-01: ${role} signed evidence cannot substitute another head`, t => {
    const payload={...basePayload(`${role} npm run test:pack`),verifier:{kind:'github-actions',
      repository:`popixoxipop-collab/${repository}`,head_sha:heads[role],run_id:1,
      conclusion:'success',command:'npm run test:pack',exit_code:0}};
    const good=fixtureStore(t,payload);assert.equal(good.result.ok,true,JSON.stringify(good.result.errors));
    assert.equal(good.result.entries.has(good.ref),true);
    const bad=fixtureStore(t,{...payload,verifier:{...payload.verifier,head_sha:'f'.repeat(40)}});
    assert.equal(bad.result.ok,false);
    assert.deepEqual(bad.result.errors.map(e=>e.code),['EVIDENCE_PACK_VERIFIER_MISMATCH']);
    assert.equal(bad.result.entries.has(bad.ref),false);
  });
}

test('wave2 closeout RELEASE-05: signed rollback evidence must positively restore previous state', t => {
  const payload={...basePayload('rollback rehearsal without destructive database downgrade'),
    verifier:{kind:'t00-rehearsal',passed:true,destructive_down_migration:false,rollback_restored_previous:true}};
  const good=fixtureStore(t,payload);assert.equal(good.result.ok,true,JSON.stringify(good.result.errors));
  for (const value of [false,null,undefined,'true',1]) {
    const verifier={...payload.verifier,rollback_restored_previous:value};
    if (value===undefined) delete verifier.rollback_restored_previous;
    const bad=fixtureStore(t,{...payload,verifier});
    assert.equal(bad.result.ok,false,`unverified restoration ${String(value)}`);
    assert.deepEqual(bad.result.errors.map(e=>e.code),['EVIDENCE_REHEARSAL_VERIFIER_MISMATCH']);
    assert.equal(bad.result.entries.has(bad.ref),false);
  }
});
