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
const sha=s=>createHash('sha256').update(s).digest('hex');
const request=source=>handleAnalyzeRequest({protocol:'bskel.native-language/1',kind:'analyze-request',
 requestId:'gin-negative',language:'go',file:'main.go',source});

function guard(text){
 const required=['static source','c2f7a0b158e7c8a60336f9ca5e97a517740234dc','Go **1.26.0**',
  'Gin **v1.12.0**','NOT VERIFIED','historical-pass-needs-leaf-rerun','T00 one-row CAS'];
 const forbidden=[/all Gin versions/,/runtime route equality verified/,/production certified/,
  /(?:is|as) a registered scanner adapter/];
 return [...required.filter(x=>!text.includes(x)),...forbidden.filter(x=>x.test(text)).map(String)];
}

test('scope guard rejects missing pins and false runtime or registry claims',()=>{
 assert.deepEqual(guard(DOC),[]);
 assert.ok(guard(DOC.replaceAll('NOT VERIFIED','PASSED')).length);
 assert.ok(guard(DOC+'\nall Gin versions').length);
});

test('dynamic group and route expressions stay diagnostics rather than guessed routes',()=>{
 const result=request('package main\nfunc f(){ r:=gin.New(); api:=r.Group(prefix); r.GET(base+"/x", x) }');
 assert.deepEqual(result.routes,[]);
 assert.deepEqual(result.diagnostics.map(x=>x.code),['GO_GIN_DYNAMIC_GROUP_PATH','GO_GIN_DYNAMIC_ROUTE_PATH']);
 const leaf=projectGinFacts(result);
 assert.deepEqual(leaf.unknowns.map(x=>x.code),['T08_GO_GIN_DYNAMIC_GROUP_PATH','T08_GO_GIN_DYNAMIC_ROUTE_PATH']);
});

test('Gin Any remains one wildcard unknown while explicit routes survive',()=>{
 const result=projectGinFacts(request('package main\nfunc f(){ r:=gin.Default(); r.GET("/ok", ok); r.Any("/wild", wild); r.POST("/also", also) }'));
 assert.deepEqual(result.routes.map(x=>[x.method,x.path]),[['POST','/also'],['GET','/ok']]);
 const wild=result.unknowns.filter(x=>x.code==='ROUTE_METHOD_WILDCARD_UNRESOLVED');
 assert.equal(wild.length,1);
 assert.deepEqual([wild[0].method,wild[0].path,wild[0].handler],['ANY','/wild','wild']);
});

test('wrapper, cross-file alias and Handle registrations are never promoted as supported routes',()=>{
 const source=['package main','func mount(r *gin.Engine){ r.GET("/wrapped", wrapped) }',
  'func f(){ r:=gin.New(); alias:=r; mount(r); alias.GET("/alias", aliasHandler); r.Handle("TRACE", "/trace", traceHandler); r.GET("/ok", ok) }'].join('\n');
 const result=request(source);
 assert.deepEqual(result.routes.map(x=>x.path),['/ok']);
 assert.match(DOC,/Calls outside the narrow matcher/);
 assert.match(DOC,/may be absent rather than diagnosed/);
});

test('comments, strings and unrelated GET receivers cannot create Gin facts',()=>{
 const source=['package main','// r:=gin.Default(); r.GET("/comment", nope)','func f(){',
  ' text := `r.GET("/string", nope)`',' r:=gin.New()',' other.GET("/foreign", nope)',' r.GET("/real", real)','}'].join('\n');
 const result=analyzeGoGinSource(source);
 assert.deepEqual(result.routes.map(x=>x.path),['/real']);
});

test('wrong protocol or language fails and foreign framework facts remain unknown',()=>{
 const base={protocol:'bskel.native-language/1',kind:'analyze-response',requestId:'x',language:'go',
  backend:'static',framework:'gin',diagnostics:[],routes:[]};
 assert.throws(()=>projectGinFacts({...base,language:'csharp'}),/requires a T08/);
 assert.throws(()=>projectGinFacts({...base,protocol:'other/1'}),/requires a T08/);
 const leaf=projectGinFacts({...base,routes:[{method:'GET',path:'/x',handler:'x',framework:'other',
  confidence:'static-literal',source:{file:'x.go',line:1,index:0}}]});
 assert.deepEqual(leaf.routes,[]);
 assert.ok(leaf.unknowns.some(x=>x.code==='GIN_FOREIGN_ROUTE_FACT'));
});

test('the baseline inline label and historical marker cannot become runtime authority',()=>{
 const baseline=JSON.parse(fs.readFileSync(path.join(ROOT,'adapters/http-wave-a/BASELINE.json'),'utf8'));
 const fixture=baseline.fixtures.find(x=>x.id==='gin-router-upstream');
 assert.equal(fixture.call.args[0].$call.args[0].source.includes('router.Run'),false);
 assert.equal(GIN_PROFILE.realRepoComparison,'historical-pass-needs-leaf-rerun');
 assert.equal(GIN_PROFILE.runtimeTested,false);
 assert.match(DOC,/makes no runtime claim/);
});

test('upstream byte or manifest tampering cannot preserve the declared source digest',()=>{
 const main=fs.readFileSync(path.join(HERE,'fixtures/upstream/realtime-chat/main.go'),'utf8');
 assert.equal(sha(main),PIN.files['realtime-chat/main.go'].sha256);
 assert.notEqual(sha(main+'// forged\n'),PIN.files['realtime-chat/main.go'].sha256);
 assert.notEqual({...PIN,commit:'0'.repeat(40)}.commit,GIN_PROFILE.versionPin.ref);
});
