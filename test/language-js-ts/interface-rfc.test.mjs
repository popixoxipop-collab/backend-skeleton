// T04-02: executable source-backed RFC contract and risk-boundary checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { JS_TS_FACTS_CONTRACT, analyzeJsTsSource } from '../../scanners/language/js-ts/source-facts.mjs';
import { JS_TS_RESOLUTION_CONTRACT, resolveJsTsModuleEdge, resolveJsTsModuleEdges } from '../../scanners/language/js-ts/module-resolver.mjs';
import { JS_TS_SNAPSHOT_CONTRACT, analyzeJsTsSnapshot } from '../../scanners/language/js-ts/snapshot-graph.mjs';
import { JS_TS_BACKEND_CONTRACT, lexicalJsTsBackend, analyzeWithJsTsBackend, compareJsTsBackends } from '../../scanners/language/js-ts/backend-comparison.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rfc = fs.readFileSync(path.join(ROOT, 'scanners/language/js-ts/INTERFACE_RFC.md'), 'utf8');

function contractProblems(text) {
  const missing = [];
  const needed = [
    'not an SBF stable contract',
    'bskel.internal.js-ts-source-facts/0',
    'bskel.internal.js-ts-resolution/0',
    'bskel.internal.js-ts-snapshot/0',
    'bskel.internal.js-ts-backend/0',
    'syntaxValidated: false',
    'complete: true',
    'allResolved: false',
    'allResolved: true',
    'not** that JS/TS syntax is valid',
    'untrusted parser plugins',
    'T01 owns stable',
    'not* a sandbox',
    'not an SBF v1 promotion',
    'official_MET_delta: 0',
    'release_activation: false',
    'scanners/language/js-ts/BASELINE.json',
    'node test/language-js-ts/interface-rfc-evidence.mjs --check',
  ];
  for (const item of needed) if (!text.includes(item)) missing.push('missing bounded contract language: ' + item);
  if (/\ball supported\b|\bfully syntax validated\b|\bautomatic runtime certification\b|syntaxValidated:\s*true/i.test(text)) {
    missing.push('unsafe support or syntax-validation claim');
  }
  return missing;
}

test('T04 RFC names all four exact internal contracts, no external SBF promotion', () => {
  assert.equal(JS_TS_FACTS_CONTRACT, 'bskel.internal.js-ts-source-facts/0');
  assert.equal(JS_TS_RESOLUTION_CONTRACT, 'bskel.internal.js-ts-resolution/0');
  assert.equal(JS_TS_SNAPSHOT_CONTRACT, 'bskel.internal.js-ts-snapshot/0');
  assert.equal(JS_TS_BACKEND_CONTRACT, 'bskel.internal.js-ts-backend/0');
  assert.deepEqual(contractProblems(rfc), []);
});

test('source facts emit literal provenance with exact UTF-8 offsets and no syntax claim', () => {
  const source = "const title = '한글🙂';\nimport v from './v.ts';\n";
  const output = analyzeJsTsSource(source, {filePath:'src/app.ts',language:'typescript'});
  assert.equal(output.contract, JS_TS_FACTS_CONTRACT);
  assert.equal(output.complete, true);
  assert.equal(output.syntaxValidated, false);
  assert.equal(output.moduleEdges.length, 1);
  const edge = output.moduleEdges[0];
  assert.equal(edge.basis, 'lexical-literal');
  assert.equal(edge.resolution, 'unresolved');
  assert.equal(edge.kind, 'import');
  assert.equal(edge.specifier, './v.ts');
  assert.equal(Buffer.from(source).subarray(edge.source.byteStart, edge.source.byteEnd).toString(), "import v from './v.ts'");
  assert.equal(edge.source.line, 2);
});

test('comments, regex and dynamic nonliteral imports cannot create verified edges', () => {
  const out = analyzeJsTsSource(String.raw`// import bad from 'comment';
  const fake = /require\('bad-regex'\)/;
  const ignored = import(variable);
  import real from './real';
  `);
  assert.deepEqual(out.moduleEdges.map(e=>e.specifier), ['./real']);
  assert.ok(out.diagnostics.some(d=>d.code==='dynamic-import-nonliteral'));
  assert.equal(out.syntaxValidated, false);
});

test('bad lexical input or invalid language throws and size/token limits return no partial edges', () => {
  assert.throws(() => analyzeJsTsSource(12), /source must be a string/);
  assert.throws(() => analyzeJsTsSource('', {language:'python'}), /unsupported language mode/);
  const input = "import k from './k';";
  for (const options of [{maxBytes:4},{maxTokens:1}]) {
    const o=analyzeJsTsSource(input, options);
    assert.equal(o.complete, false);
    assert.equal(o.syntaxValidated, false);
    assert.deepEqual(o.moduleEdges, []);
    assert.ok(o.diagnostics.length>0);
  }
});

test('repository inventory resolver distinguishes resolved, missing, ambiguous, bare, blocked and unsupported', () => {
  const from={filePath:'src/app.ts',knownFiles:['src/foo.ts','src/foo.js']};
  const statuses=[
    ['./foo.ts','resolved'],
    ['./foo.js','resolved'],
    ['./missing','missing'],
    ['./foo','ambiguous'],
    ['express','bare'],
    ['../../secrets','blocked'],
    ['./foo.ts?raw','unsupported'],
  ];
  for (const [specifier,status] of statuses) {
    const o=resolveJsTsModuleEdge({specifier},from);
    assert.equal(o.status,status,JSON.stringify(o));
    if(status!=='resolved') assert.equal('target' in o,false);
  }
  assert.throws(() => resolveJsTsModuleEdge({specifier:'./foo'}, {...from,filePath:'../../private.ts'}),/escapes the repository root/);
});

test('complete lexical pass does not imply all imports resolved or syntax proven', () => {
  const src="import x from './x'; import y from 'some-package';";
  const facts=analyzeJsTsSource(src, {filePath:'src/app.ts',language:'typescript'});
  const result=resolveJsTsModuleEdges(facts,{knownFiles:['src/app.ts','src/x.ts']});
  assert.equal(result.contract,JS_TS_RESOLUTION_CONTRACT);
  assert.equal(result.complete,true);
  assert.equal(result.allResolved,false);
  assert.equal(result.sourceSyntaxValidated,false);
  assert.deepEqual(result.resolutions.map(r=>r.status),['resolved','bare']);
  assert.equal(result.diagnostics[0].code,'module-bare');
});

test('incomplete lexical facts fail closed before resolver reads the inventory', () => {
  const incomplete=analyzeJsTsSource("import x from './x';", {filePath:'src/a.ts',maxBytes:1});
  const out=resolveJsTsModuleEdges(incomplete);
  assert.equal(out.complete,false);
  assert.equal(out.allResolved,false);
  assert.deepEqual(out.resolutions,[]);
  assert.ok(out.diagnostics.some(d=>d.code==='source-facts-incomplete'));
});

test('snapshot path identity, order, allResolved and syntaxValidated are independently checked', () => {
  const entries=[
    {path:'src/x.ts',source:'export const x = 1;'},
    {path:'src/app.ts',source:"import { x } from './x';"},
  ];
  const a=analyzeJsTsSnapshot(entries);
  const b=analyzeJsTsSnapshot([...entries].reverse());
  assert.equal(JSON.stringify(a),JSON.stringify(b));
  assert.equal(a.contract,JS_TS_SNAPSHOT_CONTRACT);
  assert.equal(a.complete,true);
  assert.equal(a.allResolved,true);
  assert.equal(a.syntaxValidated,false);
  assert.equal(a.moduleGraph[0].target,'src/x.ts');
  assert.deepEqual(a.files.map(f=>f.path),['src/app.ts','src/x.ts']);
});

test('snapshots refuse out-of-bounds inputs without partial graph or fabricated parse claims', () => {
  for(const [entries,limits,code] of [
    [[{path:'a.js',source:''},{path:'b.js',source:''}],{maxFiles:1},'file-limit'],
    [[{path:'a.ts',source:"import x from './x';"}],{maxTotalBytes:3},'snapshot-too-large'],
    [[{path:'a.vue',source:'const x=1;'}],{},'unsupported-extension'],
    [[{path:'a.ts',source:"import x from './x';"}],{maxFileBytes:2},'input-too-large'],
  ]){
    const out=analyzeJsTsSnapshot(entries,limits);
    assert.equal(out.complete,false,code);
    assert.equal(out.syntaxValidated,false,code);
    assert.deepEqual(out.files,[],code);
    assert.deepEqual(out.moduleGraph,[],code);
    assert.ok(out.diagnostics.some(d=>d.code===code),JSON.stringify(out.diagnostics));
  }
  assert.throws(() => analyzeJsTsSnapshot([{path:'a.ts',source:''},{path:'./a.ts',source:''}]),/duplicate snapshot path/);
});

test('backend comparator reports a failure, never treats a backend error as agreement', () => {
  const lexical=lexicalJsTsBackend();
  const broken={contract:JS_TS_BACKEND_CONTRACT,id:'known-broken',syntaxValidated:false,analyze(){throw new TypeError('fixture-error');}};
  const result=compareJsTsBackends([broken,lexical],[{id:'fixture',source:"import x from './x';",options:{filePath:'a.ts'}}]);
  assert.equal(result.contract,JS_TS_BACKEND_CONTRACT);
  assert.equal(result.referenceBackendId,'bounded-lexical');
  const entry=result.cases[0];
  assert.equal(entry.comparisons[0].backendId,'known-broken');
  assert.deepEqual(entry.comparisons[0].differences,['backend-error']);
  assert.equal(entry.comparisons[0].agrees,false);
  assert.equal(entry.outcomes.find(x=>x.backendId==='known-broken').status,'error');
});

test('backend declaring syntaxValidated false cannot elevate untrusted semantic authority', () => {
  const lexical=lexicalJsTsBackend();
  const pretender={...lexical,id:'pretender',analyze(s,o){return {...lexical.analyze(s,o),syntaxValidated:true};}};
  assert.throws(() => analyzeWithJsTsBackend(pretender,'const x = 1;'), /declared syntaxValidated=false/);
  assert.throws(() => compareJsTsBackends([lexical],[{id:'x',source:'x',options:{shellCommand:'curl'}}]),/unsupported common analysis option/);
  assert.throws(() => compareJsTsBackends([lexical],[{id:'x',source:'import x from "x";'}],{maxCases:0}),/positive safe integer/);
});

test('lexical analysis does not execute target JS project source', () => {
  globalThis.__BSKEL_T04_RFC_SENTINEL__=0;
  try {
    const out=analyzeJsTsSource("globalThis.__BSKEL_T04_RFC_SENTINEL__=999; import x from './x';");
    assert.equal(globalThis.__BSKEL_T04_RFC_SENTINEL__,0);
    assert.deepEqual(out.moduleEdges.map(x=>x.specifier),['./x']);
  } finally {
    delete globalThis.__BSKEL_T04_RFC_SENTINEL__;
  }
});

test('RFC red-team text edits cannot promote internals to production or erase boundaries', () => {
  const falseClaims=[
    ['not an SBF stable contract','a frozen cross-tool SBF stable contract'],
    ['syntaxValidated: false','syntaxValidated: true'],
    ['not** that JS/TS syntax is valid','proof that JS/TS syntax is valid'],
    ['not* a sandbox','an approved plugin sandbox'],
    ['official_MET_delta: 0','official_MET_delta: 1'],
    ['release_activation: false','release_activation: true']
  ];
  for(const [trueText,badText] of falseClaims){
    assert.ok(rfc.includes(trueText),'required original contract text missing: '+trueText);
    assert.notDeepEqual(contractProblems(rfc.replaceAll(trueText,badText)),[],'unsafe edit accepted: '+badText);
  }
});

test('ownership T04 is limited to T04 source/tests/next evidence, not T01 or shared CI', () => {
  const paths=['scanners/language/js-ts/INTERFACE_RFC.md','test/language-js-ts/interface-rfc.test.mjs',
    'test/language-js-ts/interface-rfc-evidence.mjs','test/language-js-ts/interface-rfc-evidence.test.mjs',
    'next/t04/INTERFACE_RFC_EVIDENCE.json'];
  const ok=spawnSync(process.execPath,['next/t00/check-ownership.mjs','paths','--track','T04','--repository','bskel',...paths],
    {cwd:ROOT,encoding:'utf8',timeout:20000});
  assert.equal(ok.status,0,ok.stderr??ok.stdout);
  assert.match(ok.stdout,/OK 5 paths belong to T04 only/);
  const denied=spawnSync(process.execPath,['next/t00/check-ownership.mjs','paths','--track','T04','--repository','bskel','contracts/next','package-lock.json'],
    {cwd:ROOT,encoding:'utf8',timeout:20000});
  assert.notEqual(denied.status,0);
});
