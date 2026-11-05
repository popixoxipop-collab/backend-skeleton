import fs from 'node:fs';
import { fixtures } from './persistence-fixtures.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
function snapshot(root) { return fs.readdirSync(root,{recursive:true}).sort().map(name=>{const f=path.join(root,name),s=fs.lstatSync(f);return {name,mode:s.mode,type:s.isDirectory()?'directory':s.isFile()?'file':'other',hash:s.isFile()?createHash('sha256').update(fs.readFileSync(f)).digest('hex'):null};}); }
import { pathToFileURL } from 'node:url';
const [consumerRoot, consumer, fault] = process.argv.slice(2);
assert.ok(fault === undefined || fault === '--test-interrupt');
assert.ok(['present','absent'].includes(consumer));
const root = path.join(consumerRoot, 'node_modules/backend-skeleton');
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
const { scanPersistenceProvider, persistenceProviderById, listPersistenceProviders } = await load('scanners/persistence-next/providers/registry.mjs');
const { certifyPersistenceBindings } = await load('scanners/persistence-next/certification.mjs');
const project = path.join(consumerRoot, 'fixture'); fs.mkdirSync(path.join(project, 'prisma'), {recursive:true});
const schema = 'model User {\n id String @id @map("user_uuid")\n @@map("users")\n}\n';
fs.writeFileSync(path.join(project,'prisma/schema.prisma'),schema);
const checks = [];
const ir = scanPersistenceProvider('prisma', project);
// Controlled test-only SIGTERM of this actual installed API probe; not parent/power-loss recovery.
if (fault === '--test-interrupt') process.kill(process.pid, 'SIGTERM');
assert.equal(ir.contract,'sbf.persistence-ir/1');
assert.equal(ir.provider,'prisma');
assert.deepEqual(ir.entities[0].primary_key.columns,['user_uuid']); checks.push('installed-registry-prisma-physical-key');
assert.equal(persistenceProviderById('unsupported-provider'),null);
assert.throws(()=>scanPersistenceProvider('unsupported-provider',project),/unknown persistence provider/); checks.push('unknown-provider-fail-closed');
assert.equal(listPersistenceProviders().length,3);
const cert = certifyPersistenceBindings({http_provider_id:'java-spring',binding_result:{bindings:[{resource_id:'users',persistence_id:'prisma',capabilities:{verified_read_by_primary_key:false},verification:null}],conflicts:[],unbound_resources:[]}});
assert.equal(cert.status,'partial-or-blocked');
assert.equal(cert.resources[0].scopes.write,false);
assert.equal(cert.resources[0].scopes.generation_candidate,false); checks.push('source-only-certification-blocked');
const entry='scanners/persistence-next/observe-cli.mjs';
assert.equal(fs.existsSync(path.join(root,entry)),consumer==='present');
if(consumer==='present') {
 const {observePersistenceProject}=await load(entry);
 const observed=observePersistenceProject({projectRoot:project,provider:'prisma'});
 assert.deepEqual(observed.entities[0].primary_key.columns,['user_uuid']); checks.push('installed-t10-read-only-consumer');
 assert.throws(()=>observePersistenceProject({projectRoot:project,provider:'unsupported-provider'}),/unknown persistence provider/);
 assert.throws(()=>observePersistenceProject({projectRoot:project,provider:'prisma',adapter:'java-spring'}),/exactly one/);
 assert.throws(()=>observePersistenceProject({projectRoot:project,modelFramework:'rails',modelFile:'../escape.rb'}),/within project root/);
 checks.push('consumer-unknown-ambiguous-path-rejected');
 for (const fixture of fixtures) {
  const fixtureRoot=path.join(consumerRoot,'mode-'+fixture.name); fs.mkdirSync(fixtureRoot);
  for(const [relative,bytes] of Object.entries(fixture.files)) { const target=path.join(fixtureRoot,relative); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,bytes); }
  const before=snapshot(fixtureRoot);
  const [mode,id,modelFile]=fixture.args;
  const result=observePersistenceProject({projectRoot:fixtureRoot,...(mode==='--provider'?{provider:id}:mode==='--adapter'?{adapter:id}:{modelFramework:id,modelFile})});
  assert.equal(result.contract,'sbf.persistence-ir/1'); assert.ok(result.entities.length>0);
  if(mode==='--model-facts') { assert.equal(result.metadata.upstream_contract,'sbf.model-facts/1'); assert.equal(result.entities.find(e=>e.name==='Order').relations[0].references_table,'organizations'); }
  else assert.equal(result.provider,({'java-spring':'jpa-hibernate','python-fastapi':'sqlalchemy-sqlmodel','typescript-express':'typeorm'})[id]??id);
  for(const [relative,bytes] of Object.entries(fixture.files)) assert.equal(fs.readFileSync(path.join(fixtureRoot,relative),'utf8'),bytes);
  assert.deepEqual(snapshot(fixtureRoot),before);
  checks.push('installed-eight-mode-'+fixture.name);
 }
}
assert.equal(fs.readFileSync(path.join(project,'prisma/schema.prisma'),'utf8'),schema);
console.log(JSON.stringify({ok:true,consumer,version:JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version,checks,release_authorized:false,runtime_certified:false,publication_performed:false}));
