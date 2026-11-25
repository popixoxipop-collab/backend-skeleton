import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildProjectGraph} from '../../scanners/project-graph/index.mjs';

test('NEG-PROJ-05 one shared source marker may support multiple competing project facets without forced single ownership',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave8-shared-source-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'src'),{recursive:true});
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'shared-demo'}));
 fs.writeFileSync(path.join(root,'src/shared.ts'),'export const token = 1;\n');
 // Both project recognizers really read the SAME source marker. Neither
 // receives exclusive attribution merely because it was visited first.
 const adapter=id=>({
   id,title:id,specificity:87,confidence:'fixture',
   verificationBasis:'source-local',capabilities:{},
   detect:dir=>fs.existsSync(path.join(dir,'src/shared.ts'))?dir:null,
 });
 const graph=buildProjectGraph({repoRoot:root,adapters:[
  adapter('node-api'),adapter('typescript-api'),
 ]});
 const rootProject=graph.projects.find(x=>x.root==='.');
 assert.ok(rootProject);
 assert.equal(rootProject.kind,'ambiguous');
 assert.equal(rootProject.facets.http.selected_adapter,null);
 assert.equal(rootProject.facets.http.selection_reason,'specificity-tie');
 assert.deepEqual(rootProject.facets.http.candidates.map(x=>x.adapter_id),[
  'node-api','typescript-api',
 ]);
 assert.deepEqual(rootProject.facets.http.ambiguous_adapter_ids,[
  'node-api','typescript-api',
 ]);
});