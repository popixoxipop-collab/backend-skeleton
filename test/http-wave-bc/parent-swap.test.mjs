// T13-04 pre-review QA only: deterministic test of a PARENT directory swap.
// This is a standalone negative fixture, not a T19 signoff or release gate.
// It does not edit a repository, run user code, or use real user paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanNext } from '../../adapters/http-wave-bc/typescript-nextjs/adapter.mjs';

function put(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}
function setup(t) {
  const container=fs.mkdtempSync(path.join(os.tmpdir(), 't13-parent-swap-'));
  t.after(() => fs.rmSync(container, {recursive:true,force:true}));
  const project=path.join(container,'project');
  const outside=path.join(container,'outside');
  const parent=path.join(project,'app','api');
  const leaf=path.join(parent,'route.ts');
  put(path.join(project,'package.json'),JSON.stringify({name:'qa',dependencies:{next:'16.4.0-canary.45'}}));
  put(leaf,'export async function GET() {}\n');
  put(path.join(outside,'route.ts'),'export async function POST() {}\n');
  return {project,parent,leaf,outside};
}
function verbs(report) {
  return report.modules.flatMap(m => m.controllers.flatMap(c => c.endpoints.map(e => e.verb)));
}
test('stable regular app/api/route.ts produces only GET',t=>{
  const {project}=setup(t);
  assert.deepEqual(verbs(scanNext(project)),['GET']);
});
test('app/api changed into outside symlink before route leaf open must not emit external POST',t=>{
  const {project,parent,leaf,outside}=setup(t);
  const original=fs.lstatSync;
  let swapped=false;
  try {
    fs.lstatSync=function(p,...args){
      if(!swapped && p===leaf) {
        // The route file path was enumerated by the scanner already.
        swapped=true;
        fs.renameSync(parent,parent+'-before-swap');
        fs.symlinkSync(outside,parent,'dir');
      }
      return original.call(fs,p,...args);
    };
    const report=scanNext(project);
    assert.equal(swapped,true,'injection must happen at the real source read');
    assert.ok(!verbs(report).includes('POST'),
      'FAIL_CLOSED expected: externally authored POST route was emitted through symlinked parent: '+JSON.stringify(verbs(report)));
  } finally {
    fs.lstatSync=original;
  }
});

test('root app directory swapped into an outside symlink must not emit external DELETE',t=>{
  const {project,parent,leaf,outside}=setup(t);
  put(path.join(outside,'api','route.ts'),'export async function DELETE() {}\n');
  const appRoot=path.dirname(parent);
  const original=fs.lstatSync;
  let swapped=false;
  try {
    fs.lstatSync=function(p,...args) {
      if(!swapped && p===leaf) {
        swapped=true;
        fs.renameSync(appRoot,appRoot+'-before-swap');
        fs.symlinkSync(outside,appRoot,'dir');
      }
      return original.call(fs,p,...args);
    };
    const report=scanNext(project);
    assert.equal(swapped,true,'root app swap hook must run at the actual source read');
    assert.ok(!verbs(report).includes('DELETE'),
      'externally authored DELETE was emitted through replaced app root: '+JSON.stringify(verbs(report)));
  } finally {
    fs.lstatSync=original;
  }
});
