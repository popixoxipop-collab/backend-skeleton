import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {extractRailsDslFacts} from '../../../scanners/language/ruby-php/dsl-facts.mjs';
import {expandDslFacts} from '../../../scanners/language/ruby-php/dsl-expand.mjs';
import {runScan} from '../../../scanners/index.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const FIX=path.join(ROOT,'test/fixtures/ruby-rails/backend');
const DOC=fs.readFileSync(new URL('./TARGET_SCOPE.md',import.meta.url),'utf8');
function guard(s){
 const required=['static','unknown','8.0.5.1','8.1.3.1','NOT VERIFIED','--runtime-routes','T00 one-row CAS'];
 const missing=required.filter(x=>!s.includes(x));
 const forbidden=['Rails 7 certified','every Rails version supported','external runtime equivalence verified','stable cross-tool contract approved'];
 return [...missing,...forbidden.filter(x=>s.includes(x))];
}
test('scope statement fails on missing unknowns or false runtime claims',()=>{
 assert.deepEqual(guard(DOC),[]);
 assert.ok(guard(DOC.replace('NOT VERIFIED','PASSED')).length>0);
 assert.ok(guard(DOC+'\nRails 7 certified').length>0);
});
test('path nil and parenthesized literal nested scope are recognized',()=>{
 const source=['scope path: nil, constraints: { format: :json } do','get "/health", to: "health#show"','end'].join('\n');
 const candidates=expandDslFacts(extractRailsDslFacts(source)).candidates;
 assert.deepEqual(candidates.map(x=>x.method+' '+x.path),['GET /health']);
});
test('runtime Ruby route condition is unknown rather than a supported route',()=>{
 const x=expandDslFacts(extractRailsDslFacts([
  'resources :session, only: [:create] do',
  ' get "become" if !Rails.env.production?',
  'end',
 ].join('\n')));
 assert.ok(x.unknowns.some(v=>v.code==='DSL_DYNAMIC_DECLARATION'));
 assert.equal(x.candidates.some(v=>v.path.includes('become')),false);
});
test('nested literal resource route retains scoped key',()=>{
 const x=expandDslFacts(extractRailsDslFacts([
  'resources :profiles, param: :username do',
  ' resources :messages, only: [:show]',
  'end'
 ].join('\n')));
 assert.ok(x.candidates.some(v=>v.method==='GET'&&v.path==='/profiles/{profile_username}/messages/{id}'));
});
test('default static scan does not present a Rails-computed runtime table',()=>{
 const report=runScan({repoRoot:FIX,terms:['article']});
 assert.match(report.api_surface_source,/static/i);
 assert.doesNotMatch(report.api_surface_source,/Rails-computed/i);
 assert.notEqual(report.runtime_introspection?.status,'used');
});
test('real-oracle inventory agrees with independent T07 Rails reference list',()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'test/fixtures/oracle-manifest.json'),'utf8'));
 const t07=JSON.parse(fs.readFileSync(path.join(ROOT,'test/language-ruby-php/corpus-manifest.json'),'utf8'));
 for(const row of manifest.adapters['ruby-rails']){
  const other=t07.entries.find(x=>x.id==='rails-'+row.id);
  assert.equal(other?.ref,row.ref);
  assert.equal(other?.owner,row.owner);
  assert.equal(other?.repo,row.repo);
 }
});
