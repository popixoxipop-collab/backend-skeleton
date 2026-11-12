import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runScan} from '../../../scanners/index.mjs';
import {detectRubyRailsRoot,scanRubyRails} from '../../../scanners/adapters/ruby-rails.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const FIX=path.join(ROOT,'test/fixtures/ruby-rails/backend');
const scope=fs.readFileSync(new URL('./TARGET_SCOPE.md',import.meta.url),'utf8');
const oracle=JSON.parse(fs.readFileSync(path.join(ROOT,'test/fixtures/oracle-manifest.json'),'utf8'));

test('Rails scope is an evidence plan, not a support or release claim',()=>{
 assert.match(scope,/NOT VERIFIED/);
 assert.match(scope,/T11-02/);
 assert.match(scope,/T00 one-row CAS/);
 assert.match(scope,/global release remains BLOCKED/);
});

test('fixture detection needs a real Rails project and conservatively selects ruby-rails',()=>{
 assert.equal(detectRubyRailsRoot(FIX),FIX);
 assert.equal(runScan({repoRoot:FIX,terms:['article']}).adapter,'ruby-rails');
});

test('same exact fixture gives a deterministic, byte-identical static scan report',()=>{
 const one=runScan({repoRoot:FIX,terms:['article']});
 const two=runScan({repoRoot:FIX,terms:['article']});
 assert.equal(JSON.stringify(one),JSON.stringify(two));
 assert.match(one.api_surface_source,/static/i);
});

test('literal routes retain provenance and do not adopt source OpenAPI operation IDs',()=>{
 const result=scanRubyRails(FIX,FIX);
 const article=result.modules.find(x=>x.module==='articles');
 assert.ok(article);
 assert.equal(article.controllers[0].endpoints.length,8);
 const endpoints=article.controllers[0].endpoints;
 assert.ok(endpoints.some(x=>x.path==='/api/v1/articles/{id}/preview'));
 assert.ok(endpoints.some(x=>x.path==='/api/v1/articles/featured'));
 assert.ok(endpoints.every(x=>x.operationIdSource==='bskel-synthesized'));
 assert.equal(new Set(endpoints.map(x=>x.operationId)).size,8);
});

test('explicit table/id facts are explicit, not silently invented',()=>{
 const result=scanRubyRails(FIX,FIX);
 const article=result.modules.find(x=>x.module==='articles');
 const entity=article.entities.find(x=>x.className==='Article');
 assert.equal(entity.table,'published_articles');
 assert.equal(entity.tableSource,'explicit');
 assert.equal(entity.idField,'article_id');
});

test('unknown Rails DSL and dynamic interpolation remain visible',()=>{
 const result=scanRubyRails(FIX,FIX);
 assert.ok(result.scanNotes.some(x=>x.includes('unsupported-dsl')));
 assert.ok(result.scanNotes.some(x=>x.includes('dynamic-path')));
 assert.ok(result.modules.flatMap(x=>x.controllers).flatMap(x=>x.endpoints)
   .every(x=>!x.path.includes('/dynamic/')));
});

test('external Rails oracle commits are exact pins, not runtime proof',()=>{
 const rows=oracle.adapters['ruby-rails'];
 assert.deepEqual(rows.map(x=>x.id),['discourse','forem','mastodon']);
 assert.deepEqual(rows.map(x=>x.terms),[['topic'],['article'],['account']]);
 assert.ok(rows.every(x=>/^[0-9a-f]{40}$/.test(x.ref)));
 const obs=JSON.parse(fs.readFileSync(path.join(ROOT,'test/language-ruby-php/corpus-observed-2026-09-26.json'),'utf8'));
 assert.equal(obs.runtime_route_equivalence_verified,false);
});

test('Rails version statement remains narrower than broad framework certification',()=>{
 assert.match(scope,/8\.0\.5\.1/);
 assert.match(scope,/8\.1\.3\.1/);
 assert.match(scope,/not certify other Rails versions/i);
 const gem=fs.readFileSync(path.join(FIX,'Gemfile'),'utf8');
 assert.match(gem,/~> 8\.1/);
});
