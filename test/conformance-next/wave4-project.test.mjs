import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildProjectGraph,buildProjectScanPlan} from '../../scanners/project-graph/index.mjs';

// A real marker is deliberately present in the reference tree. It must remain
// visible as evidence but cannot win the default application scan plan.
test('NEG-PROJ-03 vendored and test fixtures never silently become the default project',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave4-project-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const put=(rel,body)=>{const p=path.join(root,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,body);};
 put('package.json',JSON.stringify({name:'real-application'}));
 put('tests/fixtures/package.json',JSON.stringify({name:'misleading-reference'}));
 put('vendor/sample/package.json',JSON.stringify({name:'untrusted-vendor'}));
 const adapter={id:'node-app',title:'fixture Node',specificity:90,confidence:'high',
   verificationBasis:'synthetic-only',capabilities:{},
   detect:project=>fs.existsSync(path.join(project,'package.json'))?project:null};
 const graph=buildProjectGraph({repoRoot:root,adapters:[adapter]});
 assert.deepEqual(graph.projects.map(x=>[x.root,x.project_role]),
   [['.','active'],['tests/fixtures','reference']]);
 assert.deepEqual(buildProjectScanPlan(graph),[
  {project_id:'project:.',project_root:'.',adapter_id:'node-app',mode:'first-class'}
 ]);
 assert.deepEqual(buildProjectScanPlan(graph,{includeNonActive:true}).map(x=>x.project_root),
  ['.','tests/fixtures']);
});