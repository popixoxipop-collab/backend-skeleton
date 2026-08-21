// A2 Phase 1 (D-java-analyzer): direct unit tests for scanners/adapters/_java-spring-analyzer.mjs's
// pure helpers -- this project's established pattern of directly unit-testing a function complex
// enough to warrant it (mirrors classifyFile() in test/handles-manifest.test.mjs). Integration-
// level regression coverage against real controller shapes lives in test/scan-fixture.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	maskNonCode,
	matchBalanced,
	findClassOrRecordDeclaration,
	findClassLevelMappingArgs,
	skipAnnotationsAndWhitespace,
	matchMethodSignatureAfter,
	findMappingAnnotations,
	findMethodParams,
} from '../scanners/adapters/_java-spring-analyzer.mjs';

test('maskNonCode: same length and line count as the input', () => {
	const text = 'a\n/* block\ncomment */b\n// line comment\nc "a string" d\ne """\ntext block\n""" f';
	const masked = maskNonCode(text);
	assert.equal(masked.length, text.length);
	assert.equal(masked.split('\n').length, text.split('\n').length);
});

test('maskNonCode: blanks a block comment entirely, including its own markers', () => {
	const text = 'before /* @GetMapping("/x") */ after';
	const masked = maskNonCode(text);
	assert.equal(masked.length, text.length, 'masking must never change length/offsets');
	assert.ok(!masked.includes('@GetMapping'));
	assert.ok(!masked.includes('/*'));
	assert.match(masked, /^before \s+after$/, 'the comment (markers included) collapses to plain whitespace');
});

test('maskNonCode: blanks a line comment entirely, up to (not including) the newline', () => {
	const masked = maskNonCode('a // operationId = "phantom"\nb');
	assert.ok(!masked.includes('operationId'));
	assert.equal(masked.split('\n')[1], 'b');
});

test('maskNonCode: a regular string literal keeps its outer quotes, blanks only the interior', () => {
	const masked = maskNonCode('operationId = "findWidget"');
	assert.match(masked, /^operationId = "\s+"$/, 'quotes survive, interior content is blanked');
});

test('maskNonCode: a Java text block keeps its """ delimiters, blanks only the interior', () => {
	const text = 'x = """\nhello @GetMapping world\n"""';
	const masked = maskNonCode(text);
	assert.ok(masked.startsWith('x = """'));
	assert.ok(masked.trimEnd().endsWith('"""'));
	assert.ok(!masked.includes('@GetMapping'));
});

test('matchBalanced: nested parens (a default-value expression inside a parameter list)', () => {
	const s = '(@RequestParam(defaultValue = "false") boolean force)';
	assert.equal(matchBalanced(s, 0, '(', ')'), s.length - 1);
});

test('matchBalanced: nested angle brackets (a generic within a generic)', () => {
	const s = '<Map<String, List<Foo>>>';
	assert.equal(matchBalanced(s, 0, '<', '>'), s.length - 1);
});

test('matchBalanced: returns -1 when there is no matching close', () => {
	assert.equal(matchBalanced('(unterminated', 0, '(', ')'), -1);
});

test('findClassOrRecordDeclaration: matches `class` and makes `public` optional', () => {
	assert.deepEqual(findClassOrRecordDeclaration(maskNonCode('class Foo {')), { keyword: 'class', name: 'Foo', index: 0 });
	const m = findClassOrRecordDeclaration(maskNonCode('public class Foo {'));
	assert.equal(m.keyword, 'class');
	assert.equal(m.name, 'Foo');
});

test('findClassOrRecordDeclaration: matches `record`', () => {
	const m = findClassOrRecordDeclaration(maskNonCode('public record Foo() {'));
	assert.equal(m.keyword, 'record');
	assert.equal(m.name, 'Foo');
});

test('skipAnnotationsAndWhitespace: skips zero, one, and multiple intervening annotations', () => {
	const masked = maskNonCode('@GetMapping\n@PreAuthorize("hasRole(\'X\')")\n@Deprecated\npublic void foo() {}');
	const afterFirst = skipAnnotationsAndWhitespace(masked, '@GetMapping'.length);
	assert.equal(masked.slice(afterFirst, afterFirst + 6), 'public');
});

test('skipAnnotationsAndWhitespace: a masked comment in between is skipped like whitespace', () => {
	const text = '@GetMapping\n// a comment\npublic void foo() {}';
	const masked = maskNonCode(text);
	const after = skipAnnotationsAndWhitespace(masked, '@GetMapping'.length);
	assert.equal(masked.slice(after, after + 6), 'public');
});

test('matchMethodSignatureAfter: public + generic return type + method + balanced params', () => {
	const masked = maskNonCode('public ResponseEntity<Map<String, Object>> foo(String a, int b) {');
	const sig = matchMethodSignatureAfter(masked, 0);
	assert.equal(sig.methodName, 'foo');
	assert.equal(masked.slice(sig.paramsStart, sig.paramsEnd), 'String a, int b');
});

test('matchMethodSignatureAfter: no access modifier at all (package-private)', () => {
	const masked = maskNonCode('ResponseEntity<Void> foo() {');
	const sig = matchMethodSignatureAfter(masked, 0);
	assert.equal(sig.methodName, 'foo');
});

test('matchMethodSignatureAfter: returns null when nothing method-shaped follows', () => {
	const masked = maskNonCode('class Foo {');
	assert.equal(matchMethodSignatureAfter(masked, 0), null);
});

test('findMappingAnnotations: single-verb @RequestMapping(method = RequestMethod.X) resolves the verb', () => {
	const text = '@RequestMapping(method = RequestMethod.GET)\npublic void foo() {}';
	const [m] = findMappingAnnotations(text);
	assert.equal(m.verb, 'GET');
	assert.equal(m.methodName, 'foo');
});

test('findMappingAnnotations: a multi-verb @RequestMapping(method = {A, B}) array is left unresolved, not guessed at', () => {
	const text = '@RequestMapping(method = {RequestMethod.GET, RequestMethod.POST})\npublic void foo() {}';
	assert.deepEqual(findMappingAnnotations(text), []);
});

test('findMappingAnnotations: a class-level @RequestMapping is excluded even with an intervening annotation before `class`', () => {
	const text = '@RequestMapping("/foo")\n@RequiredArgsConstructor\npublic class FooController {\n\t@GetMapping\n\tpublic void bar() {}\n}';
	const results = findMappingAnnotations(text);
	assert.equal(results.length, 1, 'only the method-level @GetMapping, not the class-level @RequestMapping');
	assert.equal(results[0].methodName, 'bar');
});

test('findMappingAnnotations: results are in document order', () => {
	const text = '@GetMapping\npublic void a() {}\n@PostMapping\npublic void b() {}\n@DeleteMapping\npublic void c() {}';
	const results = findMappingAnnotations(text);
	assert.deepEqual(results.map((r) => r.methodName), ['a', 'b', 'c']);
});

test('findClassLevelMappingArgs: finds the class-level @RequestMapping past an intervening annotation, returns null when absent', () => {
	const withMapping = '@RequestMapping(value = "/foo")\n@RequiredArgsConstructor\npublic class FooController {}';
	assert.match(findClassLevelMappingArgs(withMapping), /\/foo/);

	const withoutMapping = '@RestController\npublic class FooController {}';
	assert.equal(findClassLevelMappingArgs(withoutMapping), null);
});

test('findMethodParams: a generic return type with an internal space (the exact shape that broke the old regex)', () => {
	const text = 'public ResponseEntity<Map<String, Object>> foo(@RequestBody Payload p) {}';
	assert.match(findMethodParams(text, 'foo'), /@RequestBody/);
});

test('findMethodParams: a default-value expression\'s own nested parens do not truncate the parameter list', () => {
	const text = 'public ResponseEntity<Void> foo(@RequestParam(defaultValue = "false") boolean force, @RequestBody Payload p) {}';
	const params = findMethodParams(text, 'foo');
	assert.match(params, /@RequestBody/);
	assert.match(params, /force/);
});

test('findMethodParams: returns null when the method is not found', () => {
	assert.equal(findMethodParams('public void bar() {}', 'foo'), null);
});
