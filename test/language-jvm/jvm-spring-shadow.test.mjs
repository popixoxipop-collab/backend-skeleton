import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeJavaMethodFacts } from '../../scanners/language/jvm/method-facts.mjs';
import { compareJavaSpringSourceShadow } from '../../scanners/language/jvm/spring-shadow.mjs';

test('direct method facts capture annotations and signatures but no Spring semantics', () => {
	const source = `package p;
import org.springframework.web.bind.annotation.GetMapping;
class C {
    private String field;

    @GetMapping("/x")
    public String find(String id) { return id; }

    class Nested { public void hidden() {} }
}`;
	const facts = analyzeJavaMethodFacts(source, { path: 'C.java' });
	assert.deepEqual(facts.types[0].methods.map((m) => m.name), ['find']);
	assert.deepEqual(facts.types[0].methods[0].annotations.map((a) => a.name), ['GetMapping']);
	assert.equal(Object.hasOwn(facts.types[0].methods[0], 'httpMethod'), false);
});

test('Spring shadow: class mapping and single-verb method mappings agree with the legacy analyzer', () => {
	const source = `package p;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;

@RestController
@RequestMapping("/widgets")
public class WidgetController {
    @GetMapping("/{id}")
    @PreAuthorize("hasRole('USER')")
    public String get(String id) { return id; }

    @RequestMapping(path = "/", method = POST)
    protected String create(String body) { return body; }
}`;
	const result = compareJavaSpringSourceShadow(source, { path: 'WidgetController.java' });
	assert.equal(result.ok, true, JSON.stringify(result.mismatches));
	assert.deepEqual(result.mismatches, []);
	assert.equal(result.checks.find((c) => c.name === 'method-mappings').status, 'match');
});

test('Spring shadow: unresolved multi-verb RequestMapping is ignored by both paths, not guessed', () => {
	const source = `package p;
import org.springframework.web.bind.annotation.*;
class C {
    @RequestMapping(method = {GET, POST})
    public String mixed() { return "x"; }
}`;
	const result = compareJavaSpringSourceShadow(source, { path: 'C.java' });
	const check = result.checks.find((c) => c.name === 'method-mappings');
	assert.deepEqual(check.legacy, []);
	assert.deepEqual(check.next, []);
	assert.equal(check.status, 'match');
});

test('Spring shadow: RepositoryRestResource interface and generic supertype agree', () => {
	const source = `package p;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.rest.core.annotation.RepositoryRestResource;
import java.util.UUID;

@RepositoryRestResource(path = "widgets")
public interface WidgetRepository extends JpaRepository<Widget, UUID> {}`;
	const result = compareJavaSpringSourceShadow(source, { path: 'WidgetRepository.java' });
	const check = result.checks.find((c) => c.name === 'repository-interface');
	assert.equal(check.status, 'match', JSON.stringify(check));
	assert.deepEqual(check.next, { name: 'WidgetRepository', superType: 'JpaRepository<Widget, UUID>' });
});

test('Spring shadow: comments and strings containing mapping text do not produce phantom mismatches', () => {
	const source = `package p;
// @GetMapping("/phantom")
public class C {
    String prose = "@PostMapping(\\"/fake\\")";
}`;
	const result = compareJavaSpringSourceShadow(source, { path: 'C.java' });
	assert.equal(result.ok, true);
	assert.deepEqual(result.checks.find((c) => c.name === 'method-mappings').next, []);
});