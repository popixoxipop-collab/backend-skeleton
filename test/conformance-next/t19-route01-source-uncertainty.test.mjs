import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {detectTypeScriptExpressRoot,scanTypeScriptExpress,adapter as expressAdapter} from '../../scanners/adapters/typescript-express.mjs';
import {runScan} from '../../scanners/index.mjs';

function probe(t,source,extraFiles={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'t19-neg-route01-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'src'));
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({
  name:'t19-route-unknown-probe',version:'1.0.0',
  dependencies:{express:'^4.18.2'}
 })+'\n');
 fs.writeFileSync(path.join(root,'tsconfig.json'),'{}\n');
 fs.writeFileSync(path.join(root,'src/app.ts'),source+'\n');
 for(const [rel,content] of Object.entries(extraFiles)){
  const filename=path.join(root,rel);
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  fs.writeFileSync(filename,content+'\n');
 }
 const project=detectTypeScriptExpressRoot(root);
 assert.equal(project,root,'fixture must satisfy real package + Router syntax detection');
 const scan=scanTypeScriptExpress(root,project);
 return {root,scan,endpoints:scan.modules.flatMap(m=>m.controllers).flatMap(c=>c.endpoints)
  .map(ep=>ep.verb+' '+ep.path).sort()};
}

test('NEG-ROUTE-01 dynamic parent mount must not certify unprefixed child path',t=>{
 const src=[
  "import express,{Router} from 'express';",
  "const app=express(); const child=Router();",
  "const prefix=process.env.API_PREFIX;",
  "app.use(prefix,child);",
  "child.get('/ping', pingHandler);",
  "app.get('/health', healthHandler);"
 ].join('\n');
 const {scan,endpoints}=probe(t,src);
 assert.deepEqual(endpoints,['GET /health'],
  'app.use(variable, child) does not prove GET /ping is a complete literal route');
 assert.ok(scan.scanNotes.some(note=>note.includes('computed mount prefix') &&
  note.includes('src/app.ts:4')),
  'unresolved mount must be visible rather than disappearing silently');
});

test('NEG-ROUTE-01 nested computed mount must not inherit a false known parent prefix',t=>{
 const src=[
  "import express,{Router} from 'express';",
  "const app=express(); const outer=Router(); const inner=Router();",
  "const dynamicPrefix=getConfiguredPrefix();",
  "app.use('/v1',outer); outer.use(dynamicPrefix,inner);",
  "outer.get('/users', users);",
  "inner.get('/ping', ping);"
 ].join('\n');
 const {scan,endpoints}=probe(t,src);
 assert.deepEqual(endpoints,['GET /v1/users'],
  'unknown inner mount cannot be treated as literal /v1/ping');
 assert.ok(scan.scanNotes.some(note=>note.includes('computed mount prefix') &&
  note.includes('src/app.ts:4')));
});

test('NEG-ROUTE-01 literal alternative remains provable even when same child has dynamic incoming mount',t=>{
 const src=[
  "import express,{Router} from 'express';",
  "const app=express(); const child=Router();",
  "const dynamicPrefix=process.env.API_PREFIX;",
  "app.use(dynamicPrefix,child);",
  "app.use('/known',child);",
  "child.get('/item',item);",
  "app.get('/health',health);"
 ].join('\n');
 const {scan,endpoints}=probe(t,src);
 assert.deepEqual(endpoints,['GET /health','GET /known/item'],
  'a dynamic alternative cannot invalidate an independent proven literal mount');
 assert.ok(scan.scanNotes.some(note=>note.includes('src/app.ts:4')));
});

test('literal mount-only baseline and truly unmounted router behavior remain stable',t=>{
 const src=[
  "import express,{Router} from 'express';",
  "const app=express();const child=Router();const free=Router();",
  "app.use('/api',child);",
  "child.get('/real',good);",
  "free.get('/standalone',other);"
 ].join('\n');
 const {scan,endpoints}=probe(t,src);
 assert.deepEqual(endpoints,['GET /api/real','GET /standalone']);
 assert.deepEqual(scan.scanNotes,[]);
});

test('NEG-ROUTE-01 dynamic imported child remains unknown across trusted default imports',t=>{
 const src=[
  "import express,{Router} from 'express';",
  "import child from './child';",
  "const app=express(); const prefix=getPrefixFromEnv();",
  "app.use(prefix,child);",
  "app.get('/health',health);"
 ].join('\n');
 const child=[
  "import {Router} from 'express';",
  "const router=Router();",
  "router.get('/ping',ping);",
  "export default router;"
 ].join('\n');
 const {scan,endpoints}=probe(t,src,{'src/child.ts':child});
 assert.deepEqual(endpoints,['GET /health']);
 assert.ok(scan.scanNotes.some(note=>note.includes('src/app.ts:4')),
  'a proved relative import mount is still dynamic if its prefix is not a literal');
});

test('NEG-ROUTE-01 computed template mount stays unresolved without losing separately known paths',t=>{
 const source=[
  "import express,{Router} from 'express';",
  "const app=express();const router=Router();",
  "const version=getVersion();",
  "app.use(" + String.fromCharCode(96) + "/v" + String.fromCharCode(36) + "{version}" + String.fromCharCode(96) + ",router);",
  "app.use('/literal',router);",
  "router.get('/item',item);"
 ].join('\n');
 const {scan,endpoints}=probe(t,source);
 assert.deepEqual(endpoints,['GET /literal/item']);
 assert.ok(scan.scanNotes.some(note=>note.includes('src/app.ts:4')));
});


test('NEG-ROUTE-01 scan-report unknowns carry the dynamic mount warning through the real adapter',t=>{
 const src=[
  "import express,{Router} from 'express';",
  "const app=express();const child=Router();",
  "const dynamic=process.env.API_PREFIX;",
  "app.use(dynamic,child);",
  "child.get('/should-not-appear',wrongHandler);",
  "app.get('/health',health);"
 ].join('\n');
 const {root}=probe(t,src);
 const report=runScan({
  repoRoot:root,terms:[],includeDb:false,adapters:[expressAdapter],
 });
 assert.equal(report.adapter,'typescript-express');
 assert.equal(report.verdict,'inventory');
 const paths=report.related_modules.flatMap(m=>m.controllers)
  .flatMap(c=>c.endpoints).map(x=>x.path).sort();
 assert.deepEqual(paths,['/health']);
 assert.ok(report.unknowns.some(note=>note.includes('computed mount prefix') &&
  note.includes('src/app.ts:4')),
  'diagnostics must survive the real public scan report, not only the adapter');
});
