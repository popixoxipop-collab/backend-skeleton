import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'next/t00/met_conveyor.py');
const hash = (b) => createHash('sha256').update(b).digest('hex');
const STATES = ['MET', 'PARTIAL', 'NOT_MET'];
const PY = [
  'import importlib.util,sys,json',
  's=importlib.util.spec_from_file_location("met_conveyor",sys.argv[1])',
  'm=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
  'v=json.load(sys.stdin)',
  'try:',
  ' r=m.analyze(v["plan"],v["audit"],v["planSha"],v["auditSha"],total=v["total"],edges=v["edges"],focus=v["focus"])',
  ' print(json.dumps({"ok":True,"data":r}))',
  'except m.Reject as e:',
  ' print(json.dumps({"ok":False,"error":str(e)}))',
].join('\n');

function fixture() {
  const rows = [];
  for (let n = 0; n < 24; n++)
    for (let phase = 1; phase <= 6; phase++)
      rows.push({ id:'T'+String(n).padStart(2,'0')+'-0'+phase, kind:'core', track:'T'+String(n).padStart(2,'0'),
        repository:'bskel',title:'synthetic core '+n+' phase '+phase,
        state:'planned',depends_on:[],deliverables:['no release claim'],
        mandatory_tests:['normal','negative'],acceptance:['truthful PASS'],write_scope:['next/t00/**']});
  for (let n = 0; n < 49; n++)
    for (let phase = 1; phase <= 3; phase++)
      rows.push({ id:'HTTP-synthetic-'+n+'-0'+phase,kind:'target',track:'T11',
        repository:'bskel',title:'synthetic target '+n+' phase '+phase,
        state:'planned',depends_on:[],deliverables:['no release claim'],
        mandatory_tests:['normal','negative'],acceptance:['independent pin'],write_scope:[] });
  let edges = 0;
  for (let i = 1; i < rows.length; i++) {
    for (let j = i - 1; j >= 0 && j >= i - 4 && edges < 744; j--) {
      rows[i].depends_on.push(rows[j].id);
      edges++;
    }
  }
  assert.equal(edges,744);
  const plan={schema:'bskel.scale-backlog/1',task_count:291,tasks:rows};
  const audit={schema:'t00.task-audit/2',counts:{MET:92,PARTIAL:140,NOT_MET:59,NOT_CHECKED:0},
    basis:{plan_bundle:'synthetic-test-not-production'},
    results:rows.map((t,i)=>({id:t.id,track:t.track,kind:t.kind,title:t.title,
      verdict:i<92?'MET':i<232?'PARTIAL':'NOT_MET',
      evidence:'synthetic test evidence only',gap:i>=92?'No independent runtime or version pin; not wired':'',
    }))};
  return {plan,audit,focus:['HTTP-synthetic-0','HTTP-synthetic-1'],total:291,edges:744,
    planSha:hash(Buffer.from(JSON.stringify(plan))),
    auditSha:hash(Buffer.from(JSON.stringify(audit)))};
}
const run=(v)=> {
  const r=spawnSync('python3',['-c',PY,SCRIPT],{input:JSON.stringify(v),encoding:'utf8',timeout:25000});
  assert.equal(r.status,0,r.stderr);
  return JSON.parse(r.stdout);
};
const clone=(v)=>JSON.parse(JSON.stringify(v));
const tmp=(f)=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'t00-conveyor-test-'));try{return f(root);}finally{fs.rmSync(root,{recursive:true,force:true});}};
function files(dir,v){
  const input=path.join(dir,'inputs');fs.mkdirSync(input);
  const p=path.join(input,'plan.json'),a=path.join(input,'audit.json');
  const plan=Buffer.from(JSON.stringify(v.plan)),audit=Buffer.from(JSON.stringify(v.audit));
  fs.writeFileSync(p,plan);fs.writeFileSync(a,audit);
  return {p,a,shaPlan:hash(plan),shaAudit:hash(audit)};
}
const cli=(...argv)=>spawnSync('python3',[SCRIPT,...argv],{encoding:'utf8',timeout:25000});

test('the complete 291-task, 744-edge test DAG is reconciled and never auto-approved',()=>{
  const data=run(fixture());
  assert.equal(data.ok,true,JSON.stringify(data).slice(0,400));
  const r=data.data;
  assert.deepEqual(r.authority.official_counts,{MET:92,PARTIAL:140,NOT_MET:59,NOT_CHECKED:0});
  assert.equal(r.authority.direct_edges,744);
  assert.equal(r.authority.official_MET_delta,0);
  assert.equal(r.official_audit_unchanged,true);
  assert.equal(r.policy.auto_promote_MET,false);
  assert.equal(r.policy.release_activation,false);
  assert.equal(r.counts.open,199);
  assert.equal(r.counts.ready_dependencies+r.counts.blocked_dependencies,199);
  assert.equal(r.focus_packets.length,2);
  assert.equal(r.target_phases['02'].MET,0);
  assert.equal(r.target_phases['03'].MET,0);
  assert.equal(r.priority_queue.every(x=>x.dependency_clear&&!x.ready_for_independent_adjudication),true);
});

test('duplicate plan ids and broken dependency references both deny',()=>{
 const a=clone(fixture());
 a.plan.tasks[1].id=a.plan.tasks[0].id;
 assert.match(run(a).error,/PLAN_SHAPE/);
 const b=clone(fixture());
 b.plan.tasks[6].depends_on[0]='NOT-A-TASK';
 assert.match(run(b).error,/PLAN_BAD_DEP/);
});

test('DAG cycle is rejected and task count can never be silently padded',()=>{
 const a=clone(fixture());
 a.plan.tasks[1].depends_on[0]=a.plan.tasks[100].id;
 assert.match(run(a).error,/PLAN_CYCLE/);
 const b=clone(fixture());
 b.plan.tasks.pop();
 assert.match(run(b).error,/PLAN_COUNT/);
});

test('fabricated MET, duplicated verdict row and inconsistent counts deny',()=>{
 const a=clone(fixture());
 a.audit.results[100].verdict='MET';
 assert.match(run(a).error,/AUDIT_COUNTS_MISMATCH/);
 const b=clone(fixture());
 b.audit.results[1].id=b.audit.results[0].id;
 assert.match(run(b).error,/AUDIT_ROW/);
 const c=clone(fixture());
 c.audit.counts.MET=93;
 assert.match(run(c).error,/AUDIT_COUNT/);
});

test('false source pins and unknown focus are denied',()=>{
 const a=clone(fixture());
 a.planSha='0'.repeat(64);
 a.focus=['NONEXISTENT'];
 assert.match(run(a).error,/FOCUS/);
 const b=clone(fixture());
 b.auditSha='not-a-digest';
 assert.match(run(b).error,/SOURCE_PIN/);
});

test('CLI materializes only separate new reports under exact source digests',()=>tmp(dir=>{
 const f=files(dir,fixture());
 const out=path.join(dir,'report');
 const flags=['--plan',f.p,'--audit',f.a,'--plan-sha256',f.shaPlan,
   '--audit-sha256',f.shaAudit,'--out-dir',out,'--focus','HTTP-synthetic-0,HTTP-synthetic-1'];
 const run1=cli(...flags);
 assert.equal(run1.status,0,run1.stderr);
 assert.equal(JSON.parse(run1.stdout).state,'TRIAGED_NOT_MET');
 const receipt=JSON.parse(fs.readFileSync(path.join(out,'receipt.json')));
 assert.equal(receipt.official_MET,92);
 assert.equal(receipt.official_delta,0);
 assert.equal(receipt.not_an_adjudication,true);
 assert.equal(receipt.triage_sha256,hash(fs.readFileSync(path.join(out,'triage.json'))));
 assert.equal(hash(fs.readFileSync(f.p)),f.shaPlan);
 assert.equal(hash(fs.readFileSync(f.a)),f.shaAudit);
 assert.match(fs.readFileSync(path.join(out,'brief.md'),'utf8'),/NOT an official MET adjudication/);
 const again=cli(...flags);
 assert.equal(again.status,2);
 assert.match(again.stderr,/OUTPUT_PATH/);
}));

test('CLI rejects changed authority bytes before creating any reports',()=>tmp(dir=>{
 const f=files(dir,fixture());
 const old=fs.readFileSync(f.a);
 const audit=JSON.parse(old);
 audit.results[150].gap+=' changed';
 fs.writeFileSync(f.a,JSON.stringify(audit));
 const out=path.join(dir,'should-not-exist');
 const r=cli('--plan',f.p,'--audit',f.a,'--plan-sha256',f.shaPlan,
   '--audit-sha256',f.shaAudit,'--out-dir',out,'--focus','HTTP-synthetic-0');
 assert.equal(r.status,2);
 assert.match(r.stderr,/INPUT_SHA/);
 assert.equal(fs.existsSync(out),false);
}));

test('CLI rejects absent SHA pins and unknown flags without side effects',()=>tmp(dir=>{
 const f=files(dir,fixture()),out=path.join(dir,'bad');
 const r=cli('--plan',f.p,'--audit',f.a,'--plan-sha256',f.shaPlan,
   '--audit-sha256','0'.repeat(64),'--out-dir',out,'--focus','HTTP-synthetic-0');
 assert.equal(r.status,2);
 assert.match(r.stderr,/INPUT_SHA/);
 const s=cli('--plan',f.p,'--unexpected','yes');
 assert.notEqual(s.status,0);
 assert.equal(fs.existsSync(out),false);
}));

test('plain-language gap tags are heuristic and cannot confer certification',()=>{
 const a=run(fixture()).data;
 assert.equal(a.gap_tag_counts.independent_review>0,true);
 assert.equal(a.focus_packets[0].stages[0].verdict,'PARTIAL');
 assert.equal(a.policy.evidence_is_unverified,true);
 assert.equal(a.policy.completion_checklist.length,7);
});
