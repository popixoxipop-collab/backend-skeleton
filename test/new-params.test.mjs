// P2b (D-greenfield-parameters): the pure validators in new/params.mjs.
//
// Every case below is one of the fail-OPEN results actually MEASURED against the live
// start.spring.io API (see D-greenfield-parameters' validation matrix): a groupId Initializr accepts
// with HTTP 200 and turns into a project that cannot compile. The point of these tests is that the
// rejection happens locally, with no network round-trip at all -- so each one asserts a stubbed
// `global.fetch` was never called, not just that an error was thrown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	requireValidJavaPackageName, requireValidArtifactId, requireValidPythonProjectName,
	requireValidPythonVersion, requireValidLicense, requireValidDatabase, requireSingleLineText,
	requireSupportedJavaVersion, fetchSupportedJavaVersions, INITIALIZR_METADATA_URL,
	JAVA_RESERVED_WORDS, DATABASE_CHOICES, FASTAPI_TEMPLATE_MIN_PYTHON,
} from '../new/params.mjs';

// Runs `fn` with global.fetch replaced by a spy that records every call, and returns the call count.
function withFetchSpy(fn) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (...args) => { calls.push(args); throw new Error('this test must never reach the network'); };
	try {
		fn();
	} finally {
		globalThis.fetch = original;
	}
	return calls.length;
}

// ---- Java package names (--group-id / --package-name) ---------------------------------------

test('requireValidJavaPackageName: a JLS reserved word as a segment is rejected -- start.spring.io answers groupId=com.new with HTTP 200 and generates com.new.<x>, which never compiles', () => {
	const fetches = withFetchSpy(() => {
		assert.throws(() => requireValidJavaPackageName('com.new', 'group-id'), /reserved word/);
		assert.throws(() => requireValidJavaPackageName('com.class.thing', 'group-id'), /reserved word/);
		assert.throws(() => requireValidJavaPackageName('int', 'package-name'), /reserved word/);
	});
	assert.equal(fetches, 0, 'a locally-decidable rejection must never cost a network round-trip');
});

test('requireValidJavaPackageName: a space is rejected -- also measured as HTTP 200 upstream', () => {
	const fetches = withFetchSpy(() => {
		assert.throws(() => requireValidJavaPackageName('has space', 'group-id'), /not a Java identifier/);
		assert.throws(() => requireValidJavaPackageName('com.has space', 'group-id'), /not a Java identifier/);
	});
	assert.equal(fetches, 0);
});

test('requireValidJavaPackageName: a segment starting with a digit is rejected', () => {
	const fetches = withFetchSpy(() => {
		assert.throws(() => requireValidJavaPackageName('com.1abc', 'group-id'), /not a Java identifier/);
	});
	assert.equal(fetches, 0);
});

test('requireValidJavaPackageName: a trailing dot, a leading dot and a doubled dot each report an empty segment, not a confusing identifier error', () => {
	const fetches = withFetchSpy(() => {
		assert.throws(() => requireValidJavaPackageName('com.example.', 'group-id'), /empty package segment/);
		assert.throws(() => requireValidJavaPackageName('.com.example', 'group-id'), /empty package segment/);
		assert.throws(() => requireValidJavaPackageName('com..x', 'group-id'), /empty package segment/);
	});
	assert.equal(fetches, 0);
});

test('requireValidJavaPackageName: a non-ASCII identifier is rejected (narrower than the Java language, deliberately -- a scaffolder writes a directory tree)', () => {
	const fetches = withFetchSpy(() => {
		assert.throws(() => requireValidJavaPackageName('com.café', 'group-id'), /not a Java identifier/);
		assert.throws(() => requireValidJavaPackageName('com.éxample', 'package-name'), /not a Java identifier/);
	});
	assert.equal(fetches, 0);
});

test('requireValidJavaPackageName: an empty value is rejected, and every real-world shape is accepted', () => {
	assert.throws(() => requireValidJavaPackageName('', 'group-id'), /expected a dot-separated Java package name/);
	assert.throws(() => requireValidJavaPackageName(null, 'group-id'), /expected a dot-separated Java package name/);
	assert.equal(requireValidJavaPackageName('com.example', 'group-id'), 'com.example');
	assert.equal(requireValidJavaPackageName('com', 'group-id'), 'com');
	assert.equal(requireValidJavaPackageName('io.github.acme_corp.svc2', 'group-id'), 'io.github.acme_corp.svc2');
	assert.equal(requireValidJavaPackageName('_underscore.start', 'group-id'), '_underscore.start');
});

test('JAVA_RESERVED_WORDS covers the JLS 3.9 list including the Java 9 `_` keyword and the three reserved literals, and excludes contextual keywords that are still legal identifiers', () => {
	for (const kw of ['abstract', 'goto', 'strictfp', 'synchronized', 'volatile', 'instanceof', '_', 'true', 'false', 'null']) {
		assert.ok(JAVA_RESERVED_WORDS.has(kw), `${kw} must be treated as reserved`);
	}
	for (const contextual of ['var', 'record', 'yield', 'sealed', 'permits', 'module']) {
		assert.ok(!JAVA_RESERVED_WORDS.has(contextual), `${contextual} is contextual, not reserved -- rejecting it would be over-validation`);
	}
	assert.equal(JAVA_RESERVED_WORDS.size, 54, "JLS 3.9's 51 keywords (50 classic + `_`) plus the reserved literals true/false/null");
});

// ---- --artifact-id reuses lib/featureid.mjs's own SLUG_RE ------------------------------------

test('requireValidArtifactId: accepts exactly what --slug accepts, and nothing else', () => {
	assert.equal(requireValidArtifactId('my-service'), 'my-service');
	assert.equal(requireValidArtifactId('svc2'), 'svc2');
	assert.throws(() => requireValidArtifactId('My-Service'), /invalid --artifact-id/);
	assert.throws(() => requireValidArtifactId('my_service'), /invalid --artifact-id/);
	assert.throws(() => requireValidArtifactId('2fast'), /invalid --artifact-id/);
	assert.throws(() => requireValidArtifactId('trailing-'), /invalid --artifact-id/);
});

// ---- --name on the FastAPI side (found live: pip rejects a name with spaces) ------------------

test('requireValidPythonProjectName: a prose name with spaces is rejected -- it lands in pyproject.toml\'s [project] name, which pip validates', () => {
	assert.throws(() => requireValidPythonProjectName('Demo Service'), /valid Python project name/);
	assert.throws(() => requireValidPythonProjectName('-leading'), /valid Python project name/);
	assert.throws(() => requireValidPythonProjectName('trailing.'), /valid Python project name/);
	assert.throws(() => requireValidPythonProjectName(''), /valid Python project name/);
	assert.equal(requireValidPythonProjectName('demo-app'), 'demo-app');
	assert.equal(requireValidPythonProjectName('Demo_App.v2'), 'Demo_App.v2');
});

// ---- --python-version -------------------------------------------------------------------------

test('requireValidPythonVersion: a bare version normalizes to a >= floor; an explicit single-operator floor is preserved verbatim', () => {
	assert.equal(requireValidPythonVersion('3.12').requiresPython, '>=3.12');
	assert.equal(requireValidPythonVersion('3.12.1').requiresPython, '>=3.12.1');
	assert.equal(requireValidPythonVersion('>=3.11').requiresPython, '>=3.11');
	assert.equal(requireValidPythonVersion('>3.11').requiresPython, '>3.11');
	assert.equal(requireValidPythonVersion('~=3.11').requiresPython, '~=3.11');
	assert.equal(requireValidPythonVersion('==3.11.4').requiresPython, '==3.11.4');
});

test('requireValidPythonVersion: a bare upper bound or a compound specifier is rejected -- this flag sets a FLOOR, and silently accepting the opposite would encode a claim the user never made', () => {
	assert.throws(() => requireValidPythonVersion('<3.13'), /expected a bare version/);
	assert.throws(() => requireValidPythonVersion('>=3.11,<4.0'), /expected a bare version/);
	assert.throws(() => requireValidPythonVersion('3.*'), /expected a bare version/);
	assert.throws(() => requireValidPythonVersion('python3.12'), /expected a bare version/);
	assert.throws(() => requireValidPythonVersion(''), /expected a bare version/);
});

test('requireValidPythonVersion: a floor below the shipped template\'s own PEP 585 requirement warns but does not refuse (same "warn loudly, then trust the user" register as --dependencies)', () => {
	const below = requireValidPythonVersion('3.8');
	assert.equal(below.requiresPython, '>=3.8');
	assert.equal(below.warnings.length, 1);
	assert.match(below.warnings[0], /PEP 585 builtin generic/);
	assert.equal(requireValidPythonVersion(`3.${FASTAPI_TEMPLATE_MIN_PYTHON.minor}`).warnings.length, 0);
	assert.equal(requireValidPythonVersion('3.13').warnings.length, 0);
});

// ---- --license / --database --------------------------------------------------------------------

test('requireValidLicense: shape only -- an SPDX id or short expression passes, a quote or newline never does (no local copy of the real SPDX list is kept)', () => {
	assert.equal(requireValidLicense('MIT'), 'MIT');
	assert.equal(requireValidLicense('Apache-2.0'), 'Apache-2.0');
	assert.equal(requireValidLicense('MIT OR Apache-2.0'), 'MIT OR Apache-2.0');
	assert.throws(() => requireValidLicense('MIT"'), /invalid --license/);
	assert.throws(() => requireValidLicense('-MIT'), /invalid --license/);
	assert.throws(() => requireValidLicense(''), /invalid --license/);
});

test('requireValidDatabase: only the three declared choices', () => {
	for (const choice of DATABASE_CHOICES) assert.equal(requireValidDatabase(choice), choice);
	assert.throws(() => requireValidDatabase('mysql'), /expected one of: postgres, sqlite, none/);
	assert.throws(() => requireValidDatabase('Postgres'), /expected one of/);
});

test('requireSingleLineText: a newline or control character is rejected (the value is written verbatim into a generated TOML/Python string literal)', () => {
	assert.equal(requireSingleLineText('A demo service', 'description'), 'A demo service');
	assert.throws(() => requireSingleLineText('two\nlines', 'description'), /newlines or control characters/);
	assert.throws(() => requireSingleLineText('tab\there', 'description'), /newlines or control characters/);
	assert.throws(() => requireSingleLineText(`bell${String.fromCharCode(7)}`, "description"), /newlines or control characters/);
	assert.throws(() => requireSingleLineText(`del${String.fromCharCode(127)}`, "description"), /newlines or control characters/);
});

// ---- --java-version: the one parameter validated against a LIVE document ----------------------
//
// Mocked fetch throughout: no existing test in this project hits a live external service and CI must
// not start now (D-greenfield-bootstrap's own test strategy). The real response shape was measured
// once by hand and is reproduced faithfully here.

function metadataResponse(ids) {
	return {
		ok: true,
		status: 200,
		statusText: 'OK',
		json: async () => ({ javaVersion: { type: 'single-select', default: '17', values: ids.map((id) => ({ id, name: id })) } }),
	};
}

test('fetchSupportedJavaVersions: parses javaVersion.values[].id out of the real metadata shape, and asks the documented endpoint', async () => {
	const seen = [];
	const ids = await fetchSupportedJavaVersions({
		fetchImpl: async (url, init) => { seen.push({ url, init }); return metadataResponse(['26', '25', '21', '17']); },
	});
	assert.deepEqual(ids, ['26', '25', '21', '17']);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].url, INITIALIZR_METADATA_URL);
	assert.equal(seen[0].init.headers.Accept, 'application/json');
});

test('requireSupportedJavaVersion: an id the live document offers passes through', async () => {
	const value = await requireSupportedJavaVersion('21', { fetchImpl: async () => metadataResponse(['26', '25', '21', '17']) });
	assert.equal(value, '21');
});

test('requireSupportedJavaVersion: an id the live document does NOT offer is rejected, and the message explains why this cannot be left to start.spring.io (measured: javaVersion=99 returns HTTP 200)', async () => {
	await assert.rejects(
		() => requireSupportedJavaVersion('99', { fetchImpl: async () => metadataResponse(['26', '25', '21', '17']) }),
		/not one start\.spring\.io currently offers \(it offers: 26, 25, 21, 17\)[\s\S]*HTTP 200/,
	);
});

test('requireSupportedJavaVersion: a network failure produces a clean, actionable message, never a raw stack trace', async () => {
	await assert.rejects(
		() => requireSupportedJavaVersion('21', { fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND start.spring.io'); } }),
		/could not reach start\.spring\.io to validate --java-version \(getaddrinfo ENOTFOUND start\.spring\.io\)/,
	);
});

test('requireSupportedJavaVersion: a non-ok metadata response, unreadable JSON, and a shape change upstream each fail cleanly rather than throwing a TypeError', async () => {
	await assert.rejects(
		() => requireSupportedJavaVersion('21', { fetchImpl: async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' }) }),
		/returned 503 Service Unavailable for its own version metadata/,
	);
	await assert.rejects(
		() => requireSupportedJavaVersion('21', { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('Unexpected token <'); } }) }),
		/was not readable JSON/,
	);
	await assert.rejects(
		() => requireSupportedJavaVersion('21', { fetchImpl: async () => ({ ok: true, json: async () => ({ somethingElse: true }) }) }),
		/carried no javaVersion\.values list/,
	);
});
