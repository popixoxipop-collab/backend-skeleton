import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildProjectGraph,buildProjectScanPlan} from '../../scanners/project-graph/index.mjs';

test('NEG-PROJ-06 a corrupted partial package manifest is incomplete and never certified as a framework',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave5-partial-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'package.json'),'{incomplete json');
 const graph=buildProjectGraph({repoRoot:root,adapters:[]});
 assert.deepEqual(graph.projects.map(p=>p.root),['.']);
 assert.equal(graph.projects[0].local_package,null);
 assert.equal(graph.projects[0].facets.http.selected_adapter,null);
 assert.equal(graph.projects[0].kind,'unrecognized');
 assert.deepEqual(buildProjectScanPlan(graph),[]);
 const errors=graph.unresolved.filter(x=>x.kind==='package-metadata-read');
 assert.equal(errors.length,1,'do not silently drop a failed manifest parse');
 assert.equal(errors[0].path,'package.json');
 assert.equal(errors[0].project_id,'project:.');
});