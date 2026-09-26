import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	JVM_ANALYSIS_REQUEST_SCHEMA,
	validateJvmAnalysisRequest,
	validateJvmSyntaxFacts,
	isRepoRelativePath,
} from '../../scanners/language/jvm/protocol.mjs';
import {
	analyzeJavaSyntax,
	maskJavaNonCode,
} from '../../scanners/language/jvm/java-syntax-facts.mjs';

import { JVM_FIXTURES, jvmFixture } from './fixtures.mjs';

function request(overrides = {}) {
	return {
		schema: JVM_ANALYSIS_REQUEST_SCHEMA,
		language: 'java',
		languageLevel: 17,
		mode: 'syntax',
		allowTargetExecution: false,
		project: {
			root: 'backend-java',
			sourceRoots: ['backend-java/src/main/java'],
			buildFiles: ['backend-java/build.gradle'],
		},
		files: [{ path: 'backend-java/src/main/java/com/example/Widget.java', sha256: 'a'.repeat(64) }],
		...overrides,
	};
}

test('T05 fixture manifest: every declared corpus file exists and produces the expected top-level type names', () => {
	assert.ok(JVM_FIXTURES.length > 0);
	for (const item of JVM_FIXTURES) {
		const facts = analyzeJavaSyntax(item.source, { path: item.path });
		assert.deepEqual(facts.topLevelTypes.map((t) => t.name), item.expectedTopLevelTypes, item.id);
		assert.deepEqual(validateJvmSyntaxFacts(facts), { ok: true, errors: [] }, item.id);
	}
});

test('maskJavaNonCode: keeps offsets while comments, strings, text blocks and char literals cannot fake brace depth or annotations', () => {
	const text = `class A {\n char c = '{';\n String s = "}";\n String block = """\n @Fake { }\n """;\n // @Fake {\n /* } */\n}\nrecord B(String x) {}`;
	const masked = maskJavaNonCode(text);
	assert.equal(masked.length, text.length);
	assert.ok(!masked.includes('@Fake'));
	assert.equal(analyzeJavaSyntax(text, { path: 'A.java' }).topLevelTypes.map((t) => t.name).join(','), 'A,B');
});

test('interface mapping fixture: keeps raw interface inheritance and annotation names, but does not infer route semantics', () => {
	const facts = analyzeJavaSyntax(jvmFixture('interface-mapping').source, { path: 'interface-mapping/Api.java' });
	const api = facts.topLevelTypes[0];
	assert.equal(api.kind, 'interface');
	assert.deepEqual(api.annotations.map((a) => a.name), ['RequestMapping']);
	assert.deepEqual(api.extendsTypes, ['BaseApi<WidgetDto>']);
	assert.deepEqual(api.implementsTypes, []);
	assert.equal(Object.hasOwn(api, 'httpMethod'), false);
});

test('meta-annotation fixture: @interface is a declaration, not mistaken for a pending annotation', () => {
	const facts = analyzeJavaSyntax(jvmFixture('meta-annotation').source, { path: 'meta-annotation/ReadOnlyEndpoint.java' });
	assert.equal(facts.topLevelTypes.length, 1);
	const ann = facts.topLevelTypes[0];
	assert.equal(ann.kind, 'annotation');
	assert.equal(ann.name, 'ReadOnlyEndpoint');
	assert.deepEqual(ann.annotations.map((a) => a.name), ['Target', 'Retention', 'RequestMapping']);
});

test('record generic fixture: nested generic record components and implements clause are preserved as syntax facts', () => {
	const facts = analyzeJavaSyntax(jvmFixture('record-generic').source, { path: 'record-generic/PageEnvelope.java' });
	const record = facts.topLevelTypes[0];
	assert.equal(record.kind, 'record');
	assert.match(record.recordComponentsText, /Map<String, List<T>> grouped/);
	assert.deepEqual(record.implementsTypes, ['java.io.Serializable']);
	assert.match(record.headerText, /<T extends Comparable<T>>/);
});

test('mapped superclass fixture: inheritance is preserved but no inherited primary-key fact is invented', () => {
	const base = analyzeJavaSyntax(jvmFixture('mapped-superclass-base').source, { path: 'mapped-superclass/BaseEntity.java' }).topLevelTypes[0];
	assert.deepEqual(base.annotations.map((a) => a.name), ['MappedSuperclass']);
	assert.ok(base.modifiers.includes('abstract'));

	const child = analyzeJavaSyntax(jvmFixture('mapped-superclass-child').source, { path: 'mapped-superclass/Widget.java' }).topLevelTypes[0];
	assert.deepEqual(child.annotations.map((a) => a.name), ['Entity']);
	assert.deepEqual(child.extendsTypes, ['BaseEntity<java.util.UUID>']);
	assert.deepEqual(child.implementsTypes, ['NamedEntity']);
	assert.equal(Object.hasOwn(child, 'primaryKey'), false);
});

test('imports/package: static and wildcard imports are represented explicitly', () => {
	const src = `package a.b;\nimport static java.util.Collections.*;\nimport java.util.Map;\nclass X {}`;
	const facts = analyzeJavaSyntax(src, { path: 'X.java' });
	assert.equal(facts.packageName, 'a.b');
	assert.deepEqual(facts.imports.map((x) => [x.name, x.static, x.wildcard]), [
		['java.util.Collections.*', true, true],
		['java.util.Map', false, false],
	]);
});

test('UTF-8 byte spans: declaration span uses bytes, not JavaScript UTF-16 code units', () => {
	const src = `// 한글😀\npublic class Café {}`;
	const facts = analyzeJavaSyntax(src, { path: 'Cafe.java' });
	const type = facts.topLevelTypes[0];
	const prefix = src.slice(0, src.indexOf('class'));
	assert.equal(type.byteSpan.start, Buffer.byteLength(prefix, 'utf8'));
});

test('request protocol: syntax mode is target-code-free and accepts repo-relative inputs', () => {
	assert.deepEqual(validateJvmAnalysisRequest(request()), { ok: true, errors: [] });
});

test('request protocol: rejects absolute paths, traversal, Kotlin-in-Java-profile and target execution', () => {
	for (const bad of ['/tmp/X.java', '../X.java', 'a/../X.java', 'C:/X.java', 'a\\X.java']) assert.equal(isRepoRelativePath(bad), false, bad);
	const cases = [
		request({ language: 'kotlin' }),
		request({ allowTargetExecution: true }),
		request({ project: { root: '../escape', sourceRoots: ['src/main/java'], buildFiles: [] } }),
		request({ files: [{ path: '/tmp/X.java', sha256: 'a'.repeat(64) }] }),
	];
	for (const item of cases) assert.equal(validateJvmAnalysisRequest(item).ok, false);
});

test('request protocol: semantic mode requires a classpath fingerprint and syntax mode forbids one', () => {
	assert.equal(validateJvmAnalysisRequest(request({ mode: 'semantic' })).ok, false);
	assert.equal(validateJvmAnalysisRequest(request({ mode: 'semantic', classpathFingerprint: 'b'.repeat(64) })).ok, true);
	assert.equal(validateJvmAnalysisRequest(request({ classpathFingerprint: 'b'.repeat(64) })).ok, false);
});
