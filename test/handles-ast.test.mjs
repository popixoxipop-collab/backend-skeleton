// A2 Phase 2 (D-java-ast-helper): unit coverage for detectAstHelperAvailable()'s graceful-false
// behavior. Deliberately does NOT include a live end-to-end `--ast` invocation -- that needs a
// real `java` + a real (first-run) Maven Central download, and `npm test` (this file's own glob,
// `test/*.test.mjs`) must stay fast and network-free on every environment, matching this
// codebase's own established precedent for java-compile-smoke.mjs/java-integration-smoke.mjs/
// db-introspect-smoke.mjs -- all of them dedicated `scripts/*-smoke.mjs` entry points kept OUT of
// `npm test`, run only via their own `npm run test:*` script and a dedicated CI job. The real,
// live proof that `--ast` actually classifies both the plain and fully-qualified `@NotNull`
// cases correctly lives in scripts/java-ast-smoke.mjs (CI job: java-ast).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAstHelperAvailable } from '../handles/providers/java-spring/ast-bridge.mjs';

test('detectAstHelperAvailable(): reports unavailable (never throws) when `java` cannot be found on PATH', () => {
	const savedPath = process.env.PATH;
	try {
		process.env.PATH = '';
		const detection = detectAstHelperAvailable();
		assert.equal(detection.available, false);
		assert.match(detection.reason, /java/i);
	} finally {
		process.env.PATH = savedPath;
	}
});

test('detectAstHelperAvailable(): reflects real machine state when PATH is untouched', () => {
	// Not asserting a fixed true/false -- just that the shape is right and it never throws,
	// whichever way this particular CI runner/dev machine happens to be provisioned.
	const detection = detectAstHelperAvailable();
	assert.equal(typeof detection.available, 'boolean');
	if (!detection.available) assert.equal(typeof detection.reason, 'string');
});
