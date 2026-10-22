import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {detectTypeScriptExpressRoot,scanTypeScriptExpress} from '../../scanners/adapters/typescript-express.mjs';

function extracted(t,source){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave4-express-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'src'));
 fs.writeFileSync(path.join(root,'package.json'),
  JSON.stringify({name:'fixture',dependencies:{express:'^4.18.2'}}));
 fs.writeFileSync(path.join(root,'tsconfig.json'),'{}');
 fs.writeFileSync(path.join(root,'src/routes.ts'),source);
 const detected=detectTypeScriptExpressRoot(root);
 assert.ok(detected,'fixture must be recognized as actual Express source');
 return scanTypeScriptExpress(root,detected).modules
  .flatMap(m=>m.controllers).flatMap(c=>c.endpoints)
  .map(x=>x.verb+' '+x.path).sort();
}
test('NEG-ROUTE-04 a diamond of concrete Express mounts preserves both distinct absolute routes',t=>{
 const src=[
  "import express,{Router} from 'express';",
  "const app=express();const a=Router();const b=Router();const c=Router();",
  "app.use('/a',a);app.use('/b',b);",
  "a.use('/x',c);b.use('/y',c);",
  "c.get('/ping',onPing);app.get('/health',health);"
 ].join('\n');
 assert.deepEqual(extracted(t,src),['GET /a/x/ping','GET /b/y/ping','GET /health']);
});
test('NEG-ROUTE-06 router.use and router.all are not invented as concrete GET or POST operations',t=>{
 const src=[
  "import express,{Router} from 'express';",
  "const app=express();const router=Router();app.use('/api',router);",
  "router.get('/yes',yes);router.all('/all',allHandler);",
  "router.use('/middleware',middleware);"
 ].join('\n');
 assert.deepEqual(extracted(t,src),['GET /api/yes']);
});
test('NEG-ROUTE-07 literal route case and percent-encoding bytes are not silently normalized',t=>{
 const src=[
  "import express,{Router} from 'express';",
  "const app=express();const router=Router();app.use('/api',router);",
  "router.get('/Items/%2F',upper);router.get('/items/%2f',lower);"
 ].join('\n');
 assert.deepEqual(extracted(t,src),['GET /api/Items/%2F','GET /api/items/%2f']);
});