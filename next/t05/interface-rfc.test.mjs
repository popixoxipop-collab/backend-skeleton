// T05-02 source-backed contract tests; no target Java/build/helper execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  JVM_ANALYSIS_REQUEST_SCHEMA, JVM_SYNTAX_FACTS_SCHEMA,
  validateJvmAnalysisRequest, validateJvmSyntaxFacts, isRepoRelativePath,
} from '../../scanners/language/jvm/protocol.mjs';
import { analyzeJavaSyntax } from '../../scanners/language/jvm/java-syntax-facts.mjs';
import {
  buildJvmProjectIndex, buildJvmAnnotationGraph, resolveJvmAnnotationName,
} from '../../scanners/language/jvm/annotation-graph.mjs';
import { analyzeJavaMemberFacts } from '../../scanners/language/jvm/member-facts.mjs';
import { analyzeJavaMethodFacts } from '../../scanners/language/jvm/method-facts.mjs';
import { analyzeJvmJpaDirectFacts } from '../../scanners/language/jvm/jpa-direct-facts.mjs';
import {
  getJvmFrameworkProfile, validateJvmFrameworkProfile, assessJvmFrameworkProfile,
} from '../../scanners/language/jvm/framework-profiles.mjs';
import { createJvmSemanticRecordBackend } from '../../scanners/language/jvm/semantic-backend.mjs';

const rfc=fs.readFileSync(new URL('./INTERFACE_RFC.md',import.meta.url),'utf8');
function requirementProblems(doc){
  const phrases=[
    'T05-internal', 'not T01 stable SBF', 'Kotlin/Ktor is blocked',
    'sbf.jvm.analysis-request/0-draft','sbf.jvm.syntax-facts/0-draft',
    'unknown','partial','facts-ready','runtimeVerified false',
    'T16','T20','directly written','SHA-256','baseline','CAS'
  ];
  const missing=phrases.filter(x=>!doc.toLowerCase().includes(x.toLowerCase()));
  if(/runtime verified true|kotlin fully supported|automatically authorized|fully parses all java/i.test(doc)) missing.push('unsafe promotion wording');
  return missing;
}
function valid(extra={}){
  return {
    schema:JVM_ANALYSIS_REQUEST_SCHEMA, language:'java',languageLevel:17,
    mode:'syntax',allowTargetExecution:false,
    project:{root:'.',sourceRoots:['src/main/java'],buildFiles:[]},
    files:[{path:'src/main/java/p/A.java',sha256:'a'.repeat(64)}],
    ...extra
  };
}
const source=(path,java)=>({path,source:java});

test('RFC states actual 0-draft JVM boundaries and no false external SBF support',()=>{
  assert.equal(JVM_ANALYSIS_REQUEST_SCHEMA,'sbf.jvm.analysis-request/0-draft');
  assert.equal(JVM_SYNTAX_FACTS_SCHEMA,'sbf.jvm.syntax-facts/0-draft');
  assert.deepEqual(requirementProblems(rfc),[]);
});

test('request validator accepts bounded Java syntax input without executing target code',()=>{
  assert.deepEqual(validateJvmAnalysisRequest(valid()),{ok:true,errors:[]});
  assert.equal(valid().allowTargetExecution,false);
  for(const bad of ['/tmp/A.java','../A.java','a/../A.java','C:/A.java','a\\A.java']){
    assert.equal(isRepoRelativePath(bad),false,bad);
  }
});

test('Kotlin, unsafe paths, execution and invalid source hashes remain rejected',()=>{
  const cases=[
    valid({language:'kotlin'}),
    valid({allowTargetExecution:true}),
    valid({project:{root:'..',sourceRoots:['src/main/java'],buildFiles:[]}}),
    valid({files:[{path:'../escape.java',sha256:'a'.repeat(64)}]}),
    valid({files:[{path:'src/main/java/p/A.java',sha256:'A'.repeat(64)}]}),
    valid({languageLevel:26}),
    valid({languageLevel:7})
  ];
  for(const c of cases) assert.equal(validateJvmAnalysisRequest(c).ok,false,JSON.stringify(c));
});

test('semantic mode needs a classpath digest but digest shape alone is not authorization',()=>{
  assert.equal(validateJvmAnalysisRequest(valid({mode:'semantic'})).ok,false);
  assert.equal(validateJvmAnalysisRequest(valid({mode:'semantic',classpathFingerprint:'b'.repeat(64)})).ok,true);
  assert.equal(validateJvmAnalysisRequest(valid({classpathFingerprint:'b'.repeat(64)})).ok,false);
});

test('lexical source facts retain UTF-8 offsets, never claim complete parser validation',()=>{
  const prefix='/* 한글🙂 */\n';
  const out=analyzeJavaSyntax(prefix+'class A {}',{path:'src/main/java/p/A.java'});
  assert.equal(out.schema,JVM_SYNTAX_FACTS_SCHEMA);
  assert.equal(out.topLevelTypes[0].name,'A');
  assert.equal(out.topLevelTypes[0].byteSpan.start,Buffer.byteLength(prefix));
  assert.equal(Object.hasOwn(out,'syntaxValidated'),false);
  assert.equal(Object.hasOwn(out,'complete'),false);
  assert.deepEqual(validateJvmSyntaxFacts(out),{ok:true,errors:[]});
});

test('comments and string contents cannot produce fake Java types or annotations',()=>{
  const out=analyzeJavaSyntax('/* class Fake {} */\nclass Real { String s="class Ghost {}"; }');
  assert.deepEqual(out.topLevelTypes.map(x=>x.name),['Real']);
});

test('lexical path is only a caller label until a separate facts or request validator checks it',()=>{
  const raw=analyzeJavaSyntax('class A {}',{path:'../outside/A.java'});
  assert.equal(raw.path,'../outside/A.java');
  assert.equal(validateJvmSyntaxFacts(raw).ok,false);
  assert.equal(validateJvmAnalysisRequest(valid({files:[{path:raw.path,sha256:'a'.repeat(64)}]})).ok,false);
});

test('missing external annotation is unknown, qualified spelling is not classpath proof',()=>{
  const index=buildJvmProjectIndex([source('p/A.java','package p; @interface A {}')]);
  const unknown=resolveJvmAnnotationName(index,index.fileFacts[0],'MissingExternal');
  assert.equal(unknown.status,'unknown');
  const written=resolveJvmAnnotationName(index,index.fileFacts[0],'ext.Unknown');
  assert.equal(written.status,'resolved');
  assert.equal(written.basis,'written-qualified');
});

test('duplicate project FQNs are explicit conflicts rather than last-write-wins',()=>{
  const index=buildJvmProjectIndex([
    source('p/A1.java','package p; @interface A {}'),
    source('p/A2.java','package p; @interface A {}')
  ]);
  assert.equal(index.diagnostics[0].code,'JVM_DUPLICATE_TOP_LEVEL_TYPE');
  assert.equal(Array.isArray(index.typesByFqn.get('p.A')),true);
});

test('bounded annotation graph makes truncated traversal partial',()=>{
  const g=buildJvmAnnotationGraph([
    source('p/A.java','package p; @B @interface A {}'),
    source('p/B.java','package p; @C @interface B {}'),
    source('p/C.java','package p; @interface C {}')
  ],{maxDepth:1});
  const out=g.expand('p.A');
  assert.equal(out.status,'partial');
  assert.equal(out.truncated,true);
  assert.throws(()=>buildJvmAnnotationGraph([source('p/C.java','package p; @interface C {}')],{maxDepth:0}),/maxDepth/);
});

test('direct member and method facts do not invent inherited or generated declarations',()=>{
  const src='package p; class X { private int id; public void run() {} }';
  const fields=analyzeJavaMemberFacts(src,{path:'p/X.java'});
  const methods=analyzeJavaMethodFacts(src,{path:'p/X.java'});
  assert.equal(fields.types[0].fqn,'p.X');
  assert.equal(fields.types[0].fields.some(x=>x.name==='id'),true);
  assert.equal(methods.schema,'sbf.jvm.method-facts/0-draft');
  assert.equal(methods.types[0].methods.some(x=>x.name==='run'),true);
  assert.equal(Object.hasOwn(fields.types[0],'inheritedMembers'),false);
});

test('JPA unknown/inherited keys are not promoted to proven direct primary keys',()=>{
  const a=analyzeJvmJpaDirectFacts([source('p/Entity.java','package p; class Entity { @UnknownId Long id; }')]);
  assert.equal(a.schema,'sbf.jvm.jpa-direct-facts/0-draft');
  assert.deepEqual(a.types[0].directPrimaryKeyFields,[]);
  assert.equal(a.types[0].inheritedPrimaryKey,'not-evaluated');
});

test('Spring facts-ready is not runtime ready; Ktor remains blocked',()=>{
  const spring=getJvmFrameworkProfile('spring-web-java');
  assert.deepEqual(validateJvmFrameworkProfile(spring),{ok:true,errors:[]});
  const ready=assessJvmFrameworkProfile(spring.id,spring.requiredFacts);
  assert.equal(ready.status,'facts-ready');
  assert.equal(ready.semanticAdapterImplemented,false);
  assert.equal(ready.runtimeVerified,false);
  assert.equal(assessJvmFrameworkProfile('ktor-kotlin',[]).status,'blocked');
  assert.equal(getJvmFrameworkProfile('quarkus-jaxrs-java').status,'profile-only');
});

test('semantic helper refuses boolean-only T20/T16 authorization before all callbacks',async()=>{
  let calls=0;
  const hit=()=>{calls++;return {};};
  const b=createJvmSemanticRecordBackend({
    classify:hit,inspectHelperExecutable:hit,verifyT20Authorization:hit,verifyT16RuntimeAuthorization:hit
  });
  const req=valid({mode:'semantic',classpathFingerprint:'c'.repeat(64)});
  await assert.rejects(b.analyze({request:req,repoRoot:process.cwd(),authorization:{approvedHelperExecution:true}}),/T20 helper requirements/);
  assert.equal(calls,0);
});

test('Java lexical analysis does not evaluate target text as JavaScript',()=>{
  globalThis.__T05_RFC_SENTINEL__=0;
  try{
    analyzeJavaSyntax('globalThis.__T05_RFC_SENTINEL__=999; class A {}');
    assert.equal(globalThis.__T05_RFC_SENTINEL__,0);
  }finally{delete globalThis.__T05_RFC_SENTINEL__;}
});

test('adversarial edits to the RFC cannot silently grant Kotlin, runtime or stable SBF',()=>{
  const replacements=[
    ['not T01 stable SBF','T01 stable SBF approved'],
    ['Kotlin/Ktor is blocked','Kotlin fully supported'],
    ['runtimeVerified false','runtime verified true']
  ];
  for(const [original,bad] of replacements){
    assert.ok(rfc.includes(original));
    assert.notDeepEqual(requirementProblems(rfc.replaceAll(original,bad)),[]);
  }
});
