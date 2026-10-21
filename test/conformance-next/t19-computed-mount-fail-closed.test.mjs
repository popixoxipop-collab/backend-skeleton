import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {detectTypeScriptExpressRoot,scanTypeScriptExpress} from '../../scanners/adapters/typescript-express.mjs';

function scanFixture(t, sources) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'t19-computed-express-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'src'),{recursive:true});
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({
  name:'route-fixture',private:true,
  dependencies:{express:'^4.18.2'}
 })+'\n');
 fs.writeFileSync(path.join(root,'tsconfig.json'),'{}\n');
 for(const [rel,body] of Object.entries(sources)){
  const dest=path.join(root,'src',rel);
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.writeFileSync(dest,body);
 }
 const detected=detectTypeScriptExpressRoot(root);
 assert.ok(detected,'actual Express/Router fixture detection');
 const scan=scanTypeScriptExpress(root,detected);
 return {
  endpoints:scan.modules.flatMap(x=>x.controllers).flatMap(x=>x.endpoints)
    .map(x=>x.verb+' '+x.path).sort(),
  signals:scan.pathPrefixSignals,
 };
}
function signalsFor(scan) {
 return scan.signals.map(x=>({
  kind:x.kind,file:x.file,pattern:x.pattern,
 }));
}
const header="import express,{Router} from 'express';\n";
test('NEG-ROUTE-01 computed-only app mount cannot become invented root GET /ping',t=>{
 const scan=scanFixture(t,{'app.ts':header+
  "const app=express();const r=Router();const prefix=getPrefix();"+
  "app.use(prefix,r);r.get('/ping',ping);app.get('/health',health);\n"});
 assert.deepEqual(scan.endpoints,['GET /health']);
 assert.deepEqual(signalsFor(scan),[{
  kind:'computed-express-mount-prefix',
  file:path.join('src','app.ts'),pattern:'nonliteral expression',
 }]);
});
test('NEG-ROUTE-01 verified static mount survives an additional computed mount',t=>{
 const scan=scanFixture(t,{'app.ts':header+
  "const app=express();const r=Router();const prefix=getPrefix();"+
  "app.use('/safe',r);app.use(prefix,r);r.get('/ping',ping);"+
  "app.get('/health',health);\n"});
 assert.deepEqual(scan.endpoints,['GET /health','GET /safe/ping']);
 assert.equal(scan.signals.length,1);
});
test('NEG-ROUTE-01 computed parent mount taints nested literal child paths',t=>{
 const scan=scanFixture(t,{'app.ts':header+
  "const app=express();const parent=Router();const child=Router();"+
  "const prefix=getPrefix();app.use(prefix,parent);"+
  "parent.use('/nested',child);child.get('/ping',ping);app.get('/health',health);\n"});
 assert.deepEqual(scan.endpoints,['GET /health']);
 assert.equal(scan.signals.length,1);
});
test('NEG-ROUTE-01 computed prefix to resolved relative-imported router does not mint absolute endpoint',t=>{
 const scan=scanFixture(t,{
  'app.ts':header+"import child from './child';const app=express();"+
   "const prefix=getPrefix();app.use(prefix,child);app.get('/health',health);\n",
  'child.ts':header+"const child=Router();child.get('/ping',ping);export default child;\n",
 });
 assert.deepEqual(scan.endpoints,['GET /health']);
 assert.equal(scan.signals.length,1);
});
test('NEG-ROUTE-01 static literal mount still yields exact concrete path with no computed warning',t=>{
 const scan=scanFixture(t,{'app.ts':header+
  "const app=express();const r=Router();app.use('/api',r);"+
  "r.get('/ping',ping);app.get('/health',health);\n"});
 assert.deepEqual(scan.endpoints,['GET /api/ping','GET /health']);
 assert.deepEqual(scan.signals,[]);
});
test('NEG-ROUTE-01 unrelated dynamic middleware is not misidentified as router mount',t=>{
 const scan=scanFixture(t,{'app.ts':header+
  "const app=express();const r=Router();const prefix=getPrefix();"+
  "app.use(prefix,middleware);app.use('/safe',r);"+
  "r.get('/ping',ping);app.get('/health',health);\n"});
 assert.deepEqual(scan.endpoints,['GET /health','GET /safe/ping']);
 assert.deepEqual(scan.signals,[]);
});
