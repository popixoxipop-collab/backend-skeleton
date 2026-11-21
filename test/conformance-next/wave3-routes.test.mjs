import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {detectTypeScriptExpressRoot,scanTypeScriptExpress} from '../../scanners/adapters/typescript-express.mjs';

test('NEG-ROUTE-02 one Router mounted twice retains both proven absolute paths',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave3-routes-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'src'));
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'t19-mount-fixture',dependencies:{express:'^4.18.2'}}));
 fs.writeFileSync(path.join(root,'tsconfig.json'),'{}');
 fs.writeFileSync(path.join(root,'src/routes.ts'),`import express,{Router} from 'express';
 const app=express();const router=Router();
 app.use('/one',router);app.use('/two',router);
 router.get('/ping',ping);app.get('/health',health);`);
 const detected=detectTypeScriptExpressRoot(root);assert.ok(detected);
 const scan=scanTypeScriptExpress(root,detected);
 const endpoints=scan.modules.flatMap(m=>m.controllers).flatMap(c=>c.endpoints).map(e=>e.verb+' '+e.path).sort();
 assert.deepEqual(endpoints,['GET /health','GET /one/ping','GET /two/ping']);
});
