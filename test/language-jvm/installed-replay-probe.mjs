// T05-06: execute source-only Java facts from the disposable installed package.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, slot] = process.argv.slice(2);
assert.ok(root && ['previous', 'candidate'].includes(slot));
const modulePath = name => path.join(root, 'scanners/language/jvm', name);
const modules = ['protocol.mjs', 'java-syntax-facts.mjs', 'member-facts.mjs',
  'jpa-direct-facts.mjs', 'framework-profiles.mjs'];
if (slot === 'previous') {
  for (const name of modules) assert.equal(fs.existsSync(modulePath(name)), false, name);
  console.log(JSON.stringify({ expected: slot, vectors: 1, release_authorized: false }));
} else {
  for (const name of modules) assert.equal(fs.existsSync(modulePath(name)), true, name);
  const load = async name => import(pathToFileURL(modulePath(name)).href);
  const { analyzeJavaSyntax } = await load('java-syntax-facts.mjs');
  const { analyzeJavaMemberFacts } = await load('member-facts.mjs');
  const { analyzeJvmJpaDirectFacts } = await load('jpa-direct-facts.mjs');
  const { getJvmFrameworkProfile, assessJvmFrameworkProfile } = await load('framework-profiles.mjs');
  const { JVM_ANALYSIS_REQUEST_SCHEMA, validateJvmAnalysisRequest, validateJvmSyntaxFacts } = await load('protocol.mjs');

  const api = analyzeJavaSyntax('package p;\n@RequestMapping("/widgets")\ninterface Api extends BaseApi<Widget> {}',
    { path: 'src/Api.java' });
  assert.deepEqual(validateJvmSyntaxFacts(api), { ok: true, errors: [] });
  assert.deepEqual(api.topLevelTypes[0].annotations.map(a => a.name), ['RequestMapping']);
  assert.deepEqual(api.topLevelTypes[0].extendsTypes, ['BaseApi<Widget>']);
  assert.equal(Object.hasOwn(api.topLevelTypes[0], 'httpMethod'), false);

  const base = { path: 'src/BaseEntity.java', source: 'package p;\nimport jakarta.persistence.Id;\n@jakarta.persistence.MappedSuperclass\nabstract class BaseEntity<ID> {\n @Id\n protected ID id;\n}' };
  const child = { path: 'src/Widget.java', source: 'package p;\n@jakarta.persistence.Entity\nclass Widget extends BaseEntity<java.util.UUID> {}' };
  const jpa = analyzeJvmJpaDirectFacts([base, child]);
  const baseType = jpa.types.find(t => t.fqn === 'p.BaseEntity');
  const childType = jpa.types.find(t => t.fqn === 'p.Widget');
  assert.deepEqual(baseType.directPrimaryKeyFields, ['id']);
  assert.deepEqual(childType.directPrimaryKeyFields, []);
  assert.equal(childType.inheritedPrimaryKey, 'not-evaluated');

  const wildcard = analyzeJvmJpaDirectFacts([{ path: 'src/A.java', source:
    'package p;\nimport jakarta.persistence.*;\n@Entity\nclass A {\n @Id\n String id;\n}' }]);
  assert.deepEqual(wildcard.types[0].directPrimaryKeyFields, []);
  assert.equal(wildcard.types[0].fields[0].annotations[0].resolution.status, 'unknown');

  const members = analyzeJavaMemberFacts('package p;\nclass Sample {\n int good;\n String left, right;\n void run() {}\n}',
    { path: 'src/Sample.java' });
  assert.deepEqual(members.types[0].fields.map(f => f.name), ['good']);
  assert.ok(members.diagnostics.some(d => d.code === 'JVM_MULTI_DECLARATOR_FIELD_UNSUPPORTED'));

  const spring = getJvmFrameworkProfile('spring-web-java');
  const ready = assessJvmFrameworkProfile(spring.id, spring.requiredFacts);
  assert.equal(ready.status, 'facts-ready');
  assert.equal(ready.semanticAdapterImplemented, false);
  assert.equal(ready.runtimeVerified, false);
  assert.equal(assessJvmFrameworkProfile('ktor-kotlin', []).status, 'blocked');

  const request = { schema: JVM_ANALYSIS_REQUEST_SCHEMA, language: 'java', languageLevel: 17,
    mode: 'syntax', allowTargetExecution: false, project: { root: 'src', sourceRoots: ['src'], buildFiles: [] },
    files: [{ path: 'src/Api.java', sha256: 'a'.repeat(64) }] };
  assert.deepEqual(validateJvmAnalysisRequest(request), { ok: true, errors: [] });
  assert.equal(validateJvmAnalysisRequest({ ...request, mode: 'semantic' }).ok, false);
  assert.equal(validateJvmAnalysisRequest({ ...request, allowTargetExecution: true }).ok, false);

  if (process.env.T05_TEST_INTERRUPT_PROBE === '1') process.kill(process.pid, 'SIGTERM');
  console.log(JSON.stringify({ expected: slot, vectors: 6, release_authorized: false }));
}
