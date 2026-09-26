import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	JVM_FRAMEWORK_PROFILES,
	assessJvmFrameworkProfile,
	getJvmFrameworkProfile,
	validateJvmFrameworkProfile,
} from '../../scanners/language/jvm/framework-profiles.mjs';

test('all built-in JVM framework profiles validate', () => {
	for (const profile of Object.values(JVM_FRAMEWORK_PROFILES)) {
		assert.deepEqual(validateJvmFrameworkProfile(profile), { ok: true, errors: [] }, profile.id);
	}
});

test('Spring profile becomes facts-ready only after all declared static fact capabilities exist', () => {
	const profile = getJvmFrameworkProfile('spring-web-java');
	const partial = assessJvmFrameworkProfile(profile.id, ['syntax.top-level-types', 'method.direct']);
	assert.equal(partial.status, 'incomplete');
	assert.ok(partial.missingFacts.includes('annotation.meta-graph'));

	const ready = assessJvmFrameworkProfile(profile.id, profile.requiredFacts);
	assert.equal(ready.status, 'facts-ready');
	assert.equal(ready.semanticAdapterImplemented, false);
	assert.equal(ready.runtimeVerified, false);
});

test('Ktor is explicitly blocked rather than approximated with Java annotation rules', () => {
	const result = assessJvmFrameworkProfile('ktor-kotlin', []);
	assert.equal(result.status, 'blocked');
	assert.ok(result.knownBlockers.some((item) => item.includes('Kotlin DSL')));
});

test('Quarkus and Micronaut profiles declare framework-specific annotations without changing the language facts vocabulary', () => {
	const quarkus = getJvmFrameworkProfile('quarkus-jaxrs-java');
	const micronaut = getJvmFrameworkProfile('micronaut-http-java');
	assert.equal(quarkus.routeAnnotations['jakarta.ws.rs.GET'], 'GET');
	assert.equal(micronaut.routeAnnotations['io.micronaut.http.annotation.Get'], 'GET');
	assert.equal(quarkus.requiredFacts.includes('quarkus.route'), false);
	assert.equal(micronaut.requiredFacts.includes('micronaut.route'), false);
});

test('profile validation refuses hidden target-execution grants and unknown fact names', () => {
	const bad = {
		...getJvmFrameworkProfile('spring-web-java'),
		requiredFacts: ['syntax.top-level-types', 'magic.framework.fact'],
		allowTargetExecution: true,
	};
	const result = validateJvmFrameworkProfile(bad);
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((item) => item.includes('unknown fact capability')));
	assert.ok(result.errors.some((item) => item.includes('must not grant target execution')));
});