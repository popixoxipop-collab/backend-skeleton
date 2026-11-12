import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {GIN_PROFILE,projectGinFacts} from '../../http-wave-a/gin.mjs';
import {analyzeGoGinSource} from '../../../scanners/language/native-server/go.mjs';
import {handleAnalyzeRequest} from '../../../scanners/language/native-server/index.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const HERE=path.dirname(fileURLToPath(import.meta.url));
const DOC=fs.readFileSync(path.join(HERE,'TARGET_SCOPE.md'),'utf8');
const PIN=JSON.parse(fs.readFileSync(path.join(HERE,'UPSTREAM_PIN.json'),'utf8'));
const MAIN_REL='adapters/http/go-gin/fixtures/upstream/realtime-chat/main.go';
const MOD_REL='adapters/http/go-gin/fixtures/upstream/realtime-chat/go.mod';
const MAIN=fs.readFileSync(path.join(ROOT,MAIN_REL),'utf8');
const MOD=fs.readFileSync(path.join(ROOT,MOD_REL),'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
const pairs=result=>result.routes.map(x=>[x.method,x.path,x.handler]);

test('Gin scope is a static evidence plan, not support, runtime or release authority',()=>{
 assert.match(DOC,/Prerequisite T12-02 is MET/);
 assert.match(DOC,/NOT VERIFIED/);
 assert.match(DOC,/T00 one-row CAS/);
 assert.match(DOC,/global release remain BLOCKED/);
});

test('exact upstream commit, blobs and copied bytes are closed by SHA-1 and SHA-256 pins',()=>{
 assert.equal(PIN.repository,'gin-gonic/examples');
 assert.equal(PIN.commit,'c2f7a0b158e7c8a60336f9ca5e97a517740234dc');
 assert.equal(PIN.files['realtime-chat/main.go'].git_blob_sha1,'5ab04887c7c3543510bac9e4a2b0723f06ee3a3f');
 assert.equal(PIN.files['realtime-chat/go.mod'].git_blob_sha1,'f6bc2e7debdc217370a7c885177c5b7ed8537101');
 assert.equal(sha(MAIN),PIN.files['realtime-chat/main.go'].sha256);
 assert.equal(sha(MOD),PIN.files['realtime-chat/go.mod'].sha256);
});

test('the exact upstream source deterministically yields four literal static routes',()=>{
 const one=analyzeGoGinSource(MAIN,{file:'realtime-chat/main.go'});
 const two=analyzeGoGinSource(MAIN,{file:'realtime-chat/main.go'});
 assert.equal(JSON.stringify(one),JSON.stringify(two));
 assert.deepEqual(pairs(one),[
  ['GET','/room/:roomid','roomGET'],
  ['POST','/room/:roomid','roomPOST'],
  ['DELETE','/room/:roomid','roomDELETE'],
  ['GET','/stream/:roomid','stream'],
 ]);
 assert.deepEqual(one.diagnostics,[]);
});

test('the T08 request and T12 leaf preserve those routes without inventing runtime evidence',()=>{
 const response=handleAnalyzeRequest({protocol:'bskel.native-language/1',kind:'analyze-request',
  requestId:'gin-upstream-pin',language:'go',file:'realtime-chat/main.go',source:MAIN});
 const one=projectGinFacts(response);
 const two=projectGinFacts(response);
 assert.equal(JSON.stringify(one),JSON.stringify(two));
 assert.deepEqual(pairs(one),[
  ['DELETE','/room/:roomid','roomDELETE'],
  ['GET','/room/:roomid','roomGET'],
  ['POST','/room/:roomid','roomPOST'],
  ['GET','/stream/:roomid','stream'],
 ]);
 assert.equal(one.registration,'unregistered');
 assert.equal(one.productionDefault,false);
 assert.equal(one.evidence.runtimeValidated,false);
});

test('same-file nested literal Gin groups compose and output order is canonical',()=>{
 const source='package main\nfunc f(){ r:=gin.New(); api:=r.Group("/api"); v1:=api.Group("/v1"); v1.POST("/z", z); api.GET("/a", a) }';
 const response=handleAnalyzeRequest({protocol:'bskel.native-language/1',kind:'analyze-request',
  requestId:'gin-groups',language:'go',file:'main.go',source});
 assert.deepEqual(pairs(projectGinFacts(response)),[
  ['GET','/api/a','a'],
  ['POST','/api/v1/z','z'],
 ]);
});

test('profile and upstream module agree on the exact Go and Gin declarations',()=>{
 assert.equal(GIN_PROFILE.versionPin.repo,PIN.repository);
 assert.equal(GIN_PROFILE.versionPin.path,PIN.path);
 assert.equal(GIN_PROFILE.versionPin.ref,PIN.commit);
 assert.equal(GIN_PROFILE.versionPin.framework,PIN.declared_gin);
 assert.match(MOD,new RegExp('go '+PIN.declared_go.replaceAll('.','\\.')));
 assert.match(MOD,new RegExp('github\\.com/gin-gonic/gin '+PIN.declared_gin.replaceAll('.','\\.')));
});

test('historical baseline markers remain explicit non-certifying records',()=>{
 const baseline=JSON.parse(fs.readFileSync(path.join(ROOT,'adapters/http-wave-a/BASELINE.json'),'utf8'));
 const profile=baseline.profiles.find(x=>x.id==='go-gin');
 const fixture=baseline.fixtures.find(x=>x.id==='gin-router-upstream');
 assert.equal(profile.real_repo_comparison.kind,'history-needs-leaf-rerun');
 assert.equal(fixture.input_kind,'upstream-real');
 assert.match(fixture.origin,/inline Go Gin source/);
 assert.ok(baseline.limits.some(x=>x.statement.includes('not a comparison against a real third-party repository')));
 assert.match(DOC,/history, not a current pass/);
});

test('ownership and nested-suite inputs retain the Gin target in T12 only',()=>{
 const plan=JSON.parse(fs.readFileSync(path.join(ROOT,'next/t00/fixtures/plan-write-scopes.json'),'utf8'));
 const row=plan.tasks.find(x=>x.id==='HTTP-go-gin-01');
 assert.deepEqual(row,{id:'HTTP-go-gin-01',track:'T12',repository:'bskel',write_scope:['adapters/http/go-gin/**']});
 const runner=fs.readFileSync(path.join(ROOT,'scripts/run-next-nested-tests.mjs'),'utf8');
 assert.match(runner,/id: 'T12', sourcePaths: \['adapters\/http-wave-a'\], testDir: 'test\/http-wave-a'/);
});
