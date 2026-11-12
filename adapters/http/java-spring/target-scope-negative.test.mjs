import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {findClassLevelMappingArgs,findMappingAnnotations} from '../../../scanners/adapters/_java-spring-analyzer.mjs';
import {detectJavaSpringRoot,scanJavaSpring} from '../../../scanners/adapters/java-spring.mjs';
import {runScan} from '../../../scanners/index.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const FIX=path.join(ROOT,'test/fixtures/java-spring');
const DOC=fs.readFileSync(new URL('./TARGET_SCOPE.md',import.meta.url),'utf8');
function guard(s){
 const required=['static','3.3.0','Java **17**','Java **21**','NOT VERIFIED','dynamic annotation constants','Global prefixes','T00 one-row CAS'];
 const missing=required.filter(x=>!s.includes(x));
 const forbidden=['all Spring Boot versions','runtime route equality verified','production certified','stable cross-tool contract approved'];
 return [...missing,...forbidden.filter(x=>s.includes(x))];
}

test('scope statement fails on missing dynamic/prefix limits or false runtime claims',()=>{
 assert.deepEqual(guard(DOC),[]);
 assert.ok(guard(DOC.replaceAll('NOT VERIFIED','PASSED')).length>0);
 assert.ok(guard(DOC+'\nall Spring Boot versions').length>0);
});

test('dynamic annotation constants and factories are observed but never resolved as literals',()=>{
 const source=['@RequestMapping(ApiPaths.ROOT)','public class WidgetController {',' @GetMapping(RouteFactory.item())',' public void get() {}','}'].join('\n');
 assert.equal(findClassLevelMappingArgs(source),'ApiPaths.ROOT');
 const [mapping]=findMappingAnnotations(source);
 assert.equal(mapping.argsText,'RouteFactory.item()');
 assert.doesNotMatch(mapping.argsText,/"[^"]*"/);
 assert.match(DOC,/are \*\*NOT VERIFIED\*\*/);
});

test('multi-verb RequestMapping remains unresolved instead of choosing one verb',()=>{
 const source='@RequestMapping(method = {RequestMethod.GET, RequestMethod.POST})\npublic void both() {}';
 assert.deepEqual(findMappingAnnotations(source),[]);
});

test('global prefix signal is not silently prepended to static controller paths',()=>{
 const scan=scanJavaSpring(FIX);
 const org=scan.modules.find(x=>x.module==='organization').controllers.find(x=>x.className==='OrganizationController');
 assert.ok(org.endpoints.some(x=>x.path==='/organizations'));
 assert.ok(org.endpoints.every(x=>!x.path.startsWith('/api/v0/')));
 const report=runScan({repoRoot:FIX,terms:['organization']});
 assert.ok(report.path_prefix_signals.some(x=>x.prefix==='/api/v0'));
 assert.ok(report.unknowns.some(x=>x.includes('missing it')));
});

test('build marker without source and source without build both fail detection',()=>{
 const one=fs.mkdtempSync(path.join(os.tmpdir(),'spring-scope-no-src-'));
 fs.writeFileSync(path.join(one,'build.gradle'),"plugins { id 'org.springframework.boot' version '3.3.0' }\n");
 assert.equal(detectJavaSpringRoot(one),null);
 const two=fs.mkdtempSync(path.join(os.tmpdir(),'spring-scope-no-build-'));
 fs.mkdirSync(path.join(two,'src/main/java'),{recursive:true});
 assert.equal(detectJavaSpringRoot(two),null);
});

test('oracle corpus stays diagnostic and absent from default CI commands',()=>{
 const workflow=fs.readFileSync(path.join(ROOT,'.github/workflows/ci.yml'),'utf8');
 const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));
 assert.equal(pkg.scripts['test:oracle-corpus'],'node scripts/shadow-validation-smoke.mjs --manifest test/fixtures/oracle-manifest.json');
 assert.doesNotMatch(workflow,/npm run test:oracle-corpus/);
 assert.match(DOC,/not run by default CI/);
 assert.match(DOC,/scanner-versus-runtime route equality remains \*\*NOT VERIFIED\*\*/);
});
