import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanTypeScriptExpress,
  scanTypeScriptExpressHistoricalT11,
  detectTypeScriptExpressRoot,
} from '../scanners/adapters/typescript-express.mjs';

function fixture(t, files) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-unknown-express-mount-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const contents={
    'package.json':JSON.stringify({name:'unknown-express-mount',private:true,dependencies:{express:'^4.18.2'}}),
    'tsconfig.json':'{}',
    ...files,
  };
  for(const [relative,body] of Object.entries(contents)){
    const f=path.join(root,relative);
    fs.mkdirSync(path.dirname(f),{recursive:true});
    fs.writeFileSync(f,body+'\n');
  }
  return root;
}
function routes(root){
  const selected=detectTypeScriptExpressRoot(root);
  assert.equal(selected,root,'fixture really detects Express/Router source');
  const scan=scanTypeScriptExpress(root,selected);
  return {
    routes:scan.modules.flatMap(x=>x.controllers.flatMap(c=>
      c.endpoints.map(e=>e.verb+' '+e.path))).sort(),
    signals:scan.pathPrefixSignals,
  };
}
const header=[
 "import express, {Router} from 'express';",
 'const app=express(); const router=Router();',
];
const route="router.get('/ping',ping); app.get('/health',health);";

test('NEG-ROUTE-01 a computed mount must not fabricate a verified local absolute path',t=>{
  const root=fixture(t,{'src/main.ts':[
   ...header,
   'const prefix=process.env.API_PREFIX;',
   'app.use(prefix,router);',
   route,
  ].join('\n')});
  const scan=routes(root);
  assert.deepEqual(scan.routes,['GET /health'],
    'GET /ping is only a local leaf route; computed mount cannot prove it is an absolute path');
  assert.deepEqual(scan.signals,[{kind:'computed-mount',file:'src/main.ts'}],
    'unknown route coverage must be visible to users');
});

test('literal mounts and unrelated middleware preserve existing absolute endpoints',t=>{
  const root=fixture(t,{'src/main.ts':[
   ...header,
   "app.use('/api',router);",
   'app.use(authMiddleware);',
   route,
  ].join('\n')});
  const scan=routes(root);
  assert.deepEqual(scan.routes,['GET /api/ping','GET /health']);
  assert.deepEqual(scan.signals,[]);
});

test('mixed literal and dynamic mounts keep ONLY proven literal route, with partial-coverage signal',t=>{
  const root=fixture(t,{'src/main.ts':[
   ...header,
   'const prefix=process.env.API_PREFIX;',
   'app.use(prefix,router);',
   "app.use('/stable',router);",
   route,
  ].join('\n')});
  const scan=routes(root);
  assert.deepEqual(scan.routes,['GET /health','GET /stable/ping']);
  assert.deepEqual(scan.signals,[{kind:'computed-mount',file:'src/main.ts'}]);
});

test('a computed mount of an imported default router also cannot invent its local path',t=>{
  const root=fixture(t,{
   'src/main.ts':[
     "import express from 'express';",
     "import child from './child';",
     'const app=express(); const prefix=process.env.API_PREFIX;',
     'app.use(prefix,child);',
     "app.get('/health',health);",
   ].join('\n'),
   'src/child.ts':[
     "import {Router} from 'express';",
     'const router=Router();',
     "router.get('/ping',ping);",
     'export default router;',
   ].join('\n'),
  });
  const scan=routes(root);
  assert.deepEqual(scan.routes,['GET /health']);
  assert.deepEqual(scan.signals,[{kind:'computed-mount',file:'src/main.ts'}]);
});

test('dynamic parent mount propagates unknownness to a statically mounted grandchild',t=>{
  const root=fixture(t,{'src/main.ts':[
   "import express,{Router} from 'express';",
   'const app=express(); const parent=Router(); const child=Router();',
   "parent.use('/inner',child);",
   'app.use(process.env.ROOT_PREFIX,parent);',
   "child.get('/leaf',leafHandler);",
   "app.get('/health',healthHandler);",
  ].join('\n')});
  const scan=routes(root);
  assert.deepEqual(scan.routes,['GET /health']);
  assert.deepEqual(scan.signals,[{kind:'computed-mount',file:'src/main.ts'}]);
});

test('T11 pinned historical reproduction keeps the acknowledged old false route, never the product default',t=>{
  const root=fixture(t,{'src/main.ts':[
   ...header,
   'const prefix=process.env.API_PREFIX;',
   'app.use(prefix,router);',
   route,
  ].join('\n')});
  const selected=detectTypeScriptExpressRoot(root);
  const current=scanTypeScriptExpress(root,selected);
  const original=scanTypeScriptExpressHistoricalT11(root,selected);
  const paths=(scan)=>scan.modules.flatMap(m=>
   m.controllers.flatMap(c=>c.endpoints.map(e=>e.verb+' '+e.path))).sort();
  assert.deepEqual(paths(current),['GET /health']);
  assert.deepEqual(current.pathPrefixSignals,[{kind:'computed-mount',file:'src/main.ts'}]);
  assert.deepEqual(paths(original),['GET /health','GET /ping']);
  assert.deepEqual(original.pathPrefixSignals,[]);
  assert.notDeepEqual(paths(current),paths(original),
   'history is reproduced only under explicitly named legacy mode');
});
