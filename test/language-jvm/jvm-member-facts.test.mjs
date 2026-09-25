import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeJavaMemberFacts } from '../../scanners/language/jvm/member-facts.mjs';
import { analyzeJvmJpaDirectFacts } from '../../scanners/language/jvm/jpa-direct-facts.mjs';
import { jvmFixture } from './fixtures.mjs';

function file(id) {
	const fixture = jvmFixture(id);
	return { path: fixture.path, source: fixture.source };
}

test('direct member facts: mapped superclass field is captured without walking inheritance', () => {
	const fixture = jvmFixture('mapped-superclass-base');
	const facts = analyzeJavaMemberFacts(fixture.source, { path: fixture.path });
	assert.equal(facts.types.length, 1);
	const [base] = facts.types;
	assert.equal(base.fqn, 'com.example.domain.BaseEntity');
	assert.deepEqual(base.fields.map((field) => [field.name, field.rawType]), [['id', 'ID']]);
	assert.deepEqual(base.fields[0].annotations.map((a) => a.name), ['Id']);
	assert.deepEqual(base.fields[0].modifiers, ['protected']);
	assert.deepEqual(base.recordComponents, []);
});

test('direct member facts: generic record components are captured as raw syntax, not resolved types', () => {
	const fixture = jvmFixture('record-generic');
	const facts = analyzeJavaMemberFacts(fixture.source, { path: fixture.path });
	const [record] = facts.types;
	assert.deepEqual(record.recordComponents.map((component) => [component.name, component.rawType, component.generic]), [
		['items', 'List<T>', true],
		['grouped', 'Map<String, List<T>>', true],
	]);
	assert.deepEqual(record.fields, []);
});

test('direct member facts: methods are skipped and multi-declarator fields fail closed with a diagnostic', () => {
	const source = `package p;
public class Sample {
    private int good;
    private String left, right;
    public String method(String input) { return input; }
}`;
	const facts = analyzeJavaMemberFacts(source, { path: 'Sample.java' });
	assert.deepEqual(facts.types[0].fields.map((field) => field.name), ['good']);
	assert.ok(facts.diagnostics.some((d) => d.code === 'JVM_MULTI_DECLARATOR_FIELD_UNSUPPORTED'));
});

test('direct member annotation byte spans are absolute UTF-8 byte offsets', () => {
	const source = `// 😀 unicode prefix
package p;
class A {
    @jakarta.persistence.Id
    private String id;
}`;
	const facts = analyzeJavaMemberFacts(source, { path: 'A.java' });
	const [annotation] = facts.types[0].fields[0].annotations;
	const bytes = Buffer.from(source, 'utf8').subarray(annotation.byteSpan.start, annotation.byteSpan.end).toString('utf8');
	assert.equal(bytes, '@jakarta.persistence.Id');
});

test('JPA direct facts: direct @Id is proven on BaseEntity, but Widget never inherits it by guess', () => {
	const facts = analyzeJvmJpaDirectFacts([
		file('mapped-superclass-base'),
		file('mapped-superclass-child'),
	]);
	const base = facts.types.find((type) => type.fqn === 'com.example.domain.BaseEntity');
	const widget = facts.types.find((type) => type.fqn === 'com.example.domain.Widget');
	assert.deepEqual(base.typeAnnotations.map((a) => a.persistenceFqn).filter(Boolean), ['jakarta.persistence.MappedSuperclass']);
	assert.deepEqual(base.directPrimaryKeyFields, ['id']);
	assert.deepEqual(base.fields[0].directKeyAnnotations, ['jakarta.persistence.Id']);
	assert.equal(base.inheritedPrimaryKey, 'not-evaluated');

	assert.deepEqual(widget.typeAnnotations.map((a) => a.persistenceFqn).filter(Boolean), ['jakarta.persistence.Entity']);
	assert.deepEqual(widget.directPrimaryKeyFields, []);
	assert.equal(widget.inheritedPrimaryKey, 'not-evaluated');
});

test('JPA direct facts: external wildcard imports are insufficient to prove @Id', () => {
	const source = `package p;
import jakarta.persistence.*;
@Entity
class A {
    @Id
    String id;
}`;
	const facts = analyzeJvmJpaDirectFacts([{ path: 'A.java', source }]);
	const [type] = facts.types;
	assert.deepEqual(type.directPrimaryKeyFields, []);
	assert.equal(type.fields[0].annotations[0].resolution.status, 'unknown');
});

test('JPA direct facts: a fully-qualified @Id is proven without imports', () => {
	const source = `package p;
class A {
    @jakarta.persistence.Id
    String id;
}`;
	const facts = analyzeJvmJpaDirectFacts([{ path: 'A.java', source }]);
	assert.deepEqual(facts.types[0].directPrimaryKeyFields, ['id']);
	assert.deepEqual(facts.types[0].fields[0].directKeyAnnotations, ['jakarta.persistence.Id']);
});