import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildProjectGraph} from '../../scanners/project-graph/index.mjs';

function project(t, rootName) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave6-renamed-project-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const sub=path.join(root,'services',rootName);
 fs.mkdirSync(sub,{recursive:true});
 fs.writeFileSync(path.join(sub,'package.json'),JSON.stringify({
   name:'same-product-under-new-location',private:true,dependencies:{express:'^4.18.2'}
 })+'\n');
 const graph=buildProjectGraph({repoRoot:root,adapters:[]});
 return graph.projects.find(p=>p.root==='services/'+rootName);
}
test('NEG-PROJ-04 renaming an otherwise identical project changes its repo-local identity',t=>{
 const old=project(t,'api');
 const renamed=project(t,'api-renamed');
 assert.ok(old&&renamed);
 assert.equal(old.project_id,'project:services/api');
 assert.equal(renamed.project_id,'project:services/api-renamed');
 assert.notEqual(old.project_id,renamed.project_id);
 assert.equal(old.local_package.name,renamed.local_package.name);
 assert.equal(old.local_package.private,renamed.local_package.private);
 // Neither the source graph nor this test claims an automatic identity migration.
 assert.equal(old.root,'services/api');
 assert.equal(renamed.root,'services/api-renamed');
});