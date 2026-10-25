import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runScan} from '../../../scanners/index.mjs';
import {detectJavaSpringRoot,scanJavaSpring} from '../../../scanners/adapters/java-spring.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const FIX=path.join(ROOT,'test/fixtures/java-spring');
const scope=fs.readFileSync(new URL('./TARGET_SCOPE.md',import.meta.url),'utf8');
const oracle=JSON.parse(fs.readFileSync(path.join(ROOT,'test/fixtures/oracle-manifest.json'),'utf8'));

test('Spring scope is an evidence plan, not a support or release claim',()=>{
 assert.match(scope,/NOT VERIFIED/);
 assert.match(scope,/T11-02/);
 assert.match(scope,/T00 one-row CAS/);
 assert.match(scope,/global release remain BLOCKED/);
});

test('fixture detection needs a real Spring project and conservatively selects java-spring',()=>{
 assert.match(detectJavaSpringRoot(FIX),/src\/main\/java$/);
 assert.equal(runScan({repoRoot:FIX,terms:['organization']}).adapter,'java-spring');
});

test('same exact fixture gives deterministic byte-identical static scan output',()=>{
 const one=scanJavaSpring(FIX);
 const two=scanJavaSpring(FIX);
 assert.equal(JSON.stringify(one),JSON.stringify(two));
 assert.equal(one.filesRead.length,35);
});

test('literal controller routes retain exact operation-id and nested-path facts',()=>{
 const result=scanJavaSpring(FIX);
 const mod=result.modules.find(x=>x.module==='organization');
 const org=mod.controllers.find(x=>x.className==='OrganizationController');
 const operator=mod.controllers.find(x=>x.className==='OperatorController');
 assert.equal(org.endpoints.length,10);
 assert.equal(operator.endpoints.length,5);
 assert.ok(org.endpoints.some(x=>x.verb==='GET'&&x.path==='/organizations/{organizationId}'&&x.operationId==='findOrganization'));
 assert.ok(operator.endpoints.some(x=>x.path==='/organizations/{organizationId}/operators/{operatorId}'&&x.operationId==='findOperator'));
});

test('explicit entity table and UUID identity facts are preserved',()=>{
 const result=scanJavaSpring(FIX);
 const mod=result.modules.find(x=>x.module==='organization');
 const entity=mod.entities.find(x=>x.className==='Organization');
 assert.equal(entity.table,'organizations');
 assert.equal(entity.idField,'id');
 assert.equal(entity.idFieldType,'UUID');
 assert.equal(entity.idFieldIsUuid,true);
});

test('global prefix is surfaced as signals and an unknown, not hidden',()=>{
 const report=runScan({repoRoot:FIX,terms:['organization']});
 const byKind=Object.fromEntries(report.path_prefix_signals.map(x=>[x.kind,x]));
 assert.equal(byKind.configurePathMatch.prefix,'/api/v0');
 assert.equal(byKind['paths-to-match'].pattern,'/api/v0/**');
 assert.ok(report.unknowns.some(x=>x.includes('global path prefix')&&x.includes('/api/v0')));
});

test('external Spring oracle commits are exact source pins, not runtime proof',()=>{
 const rows=oracle.adapters['java-spring'];
 assert.deepEqual(rows.map(x=>x.id),['spring-petclinic','ali-bouali-asymmetric-encryption','realworld-java21-springboot3']);
 assert.deepEqual(rows.map(x=>x.terms),[['owner'],['category'],['article']]);
 assert.ok(rows.every(x=>/^[0-9a-f]{40}$/.test(x.ref)));
 assert.match(scope,/three immutable source shapes only/);
});

test('version statement stays narrower than broad framework certification',()=>{
 const build=fs.readFileSync(path.join(FIX,'build.gradle'),'utf8');
 assert.match(build,/org\.springframework\.boot' version '3\.3\.0'/);
 assert.match(scope,/Java \*\*17\*\*/);
 assert.match(scope,/Java \*\*21\*\*/);
 assert.match(scope,/No other Spring Boot or Java version range is certified/);
});
