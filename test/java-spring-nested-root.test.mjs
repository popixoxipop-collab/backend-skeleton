// D-cross-adapter-root-detection: java-spring.mjs was the only one of this project's 4 real
// adapters whose detect() assumed repoRoot itself was the project root -- python-fastapi.mjs/
// typescript-express.mjs/javascript-express.mjs already walk the whole repo for their own project
// marker file (see each adapter's own detect() comment). A real polyglot monorepo whose Spring
// project lives under e.g. backend-java/ (build.gradle not at repoRoot) went completely
// undetected -- silently falling through to generic-grep with zero error. These tests prove the
// fix against a real, on-disk copy of test/fixtures/java-spring/, not a synthetic minimal stub, so
// the same assertions test/scan-fixture.test.mjs already makes about the fixture's real content
// (module/operation counts) double as proof the nested path is functionally equivalent to the
// root-level one, not just that detect() returns non-null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectJavaSpringRoot, scanJavaSpring } from '../scanners/adapters/java-spring.mjs';
import { adapter as javaSpringAdapter } from '../scanners/adapters/java-spring.mjs';
import { runScan } from '../scanners/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'java-spring');

function nestedFixtureRepo() {
	const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-spring-nested-'));
	const moduleRoot = path.join(repoRoot, 'backend-java');
	fs.mkdirSync(moduleRoot, { recursive: true });
	fs.cpSync(STATIC_FIXTURE_ROOT, moduleRoot, { recursive: true });
	return { repoRoot, moduleRoot };
}

test('detectJavaSpringRoot still finds a build file directly at repoRoot (unchanged, root-level case)', () => {
	assert.equal(detectJavaSpringRoot(STATIC_FIXTURE_ROOT), path.join(STATIC_FIXTURE_ROOT, 'src', 'main', 'java'));
});

test('detectJavaSpringRoot finds a Spring project nested under a subdirectory (the real monorepo bug this fixes)', () => {
	const { repoRoot, moduleRoot } = nestedFixtureRepo();
	assert.equal(detectJavaSpringRoot(repoRoot), path.join(moduleRoot, 'src', 'main', 'java'));
});

test('detectJavaSpringRoot returns null for a repo with no build file anywhere, not just none at repoRoot', () => {
	const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-spring-none-'));
	assert.equal(detectJavaSpringRoot(repoRoot), null);
});

test('detectJavaSpringRoot skips a root aggregator build.gradle with no src/main/java of its own, and finds the real child module instead', () => {
	const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-spring-aggregator-'));
	// A root aggregator build.gradle -- real multi-module Gradle shape, no src/main/java sibling.
	fs.writeFileSync(path.join(repoRoot, 'build.gradle'), "subprojects {\n\tapply plugin: 'java'\n}\n");
	const moduleRoot = path.join(repoRoot, 'api');
	fs.mkdirSync(moduleRoot, { recursive: true });
	fs.cpSync(STATIC_FIXTURE_ROOT, moduleRoot, { recursive: true });

	assert.equal(detectJavaSpringRoot(repoRoot), path.join(moduleRoot, 'src', 'main', 'java'));
});

test('scanJavaSpring against the nested root finds the exact same modules/operations as the root-level fixture', () => {
	const { repoRoot, moduleRoot } = nestedFixtureRepo();
	const nested = scanJavaSpring(repoRoot);
	const rootLevel = scanJavaSpring(STATIC_FIXTURE_ROOT);

	assert.equal(nested.srcRoot, path.join(moduleRoot, 'src', 'main', 'java'));
	assert.equal(nested.modules.length, rootLevel.modules.length);
	assert.deepEqual(nested.modules.map((m) => m.module).sort(), rootLevel.modules.map((m) => m.module).sort());
	// filesRead is repo-relative to its OWN repoRoot -- must be prefixed with backend-java/, not
	// byte-identical to the root-level fixture's own filesRead.
	assert.ok(nested.filesRead.every((f) => f.startsWith('backend-java' + path.sep) || f.startsWith('backend-java/')));
	assert.equal(nested.filesRead.length, rootLevel.filesRead.length);
});

test('runScan against a nested Spring project actually picks java-spring, not generic-grep (the real, previously-silent failure mode)', () => {
	const { repoRoot } = nestedFixtureRepo();
	const report = runScan({ repoRoot, terms: ['organization'] });
	assert.equal(report.adapter, 'java-spring');
});

test('adapter.detect (the real registry-facing entry point) resolves a nested project the same way', () => {
	const { repoRoot, moduleRoot } = nestedFixtureRepo();
	assert.equal(javaSpringAdapter.detect(repoRoot), path.join(moduleRoot, 'src', 'main', 'java'));
});

test('diagnostics() distinguishes "no build file anywhere" from "build file found but no src/main/java", both recursively', () => {
	const noBuildFile = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-spring-diag-none-'));
	const noBuildFileMsgs = javaSpringAdapter.diagnostics(noBuildFile);
	assert.ok(noBuildFileMsgs.some((m) => m.code === 'no-build-file'));

	const buildFileNoSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-spring-diag-nosrc-'));
	fs.mkdirSync(path.join(buildFileNoSrc, 'nested'), { recursive: true });
	fs.writeFileSync(path.join(buildFileNoSrc, 'nested', 'build.gradle'), '');
	const buildFileNoSrcMsgs = javaSpringAdapter.diagnostics(buildFileNoSrc);
	assert.ok(buildFileNoSrcMsgs.some((m) => m.code === 'no-src-main-java' && /found a build file/.test(m.message)));

	const { repoRoot } = nestedFixtureRepo();
	const okMsgs = javaSpringAdapter.diagnostics(repoRoot);
	assert.ok(!okMsgs.some((m) => m.code === 'no-build-file' || m.code === 'no-src-main-java'));
});

test('detectGlobalPathPrefixSignals finds the fixture\'s own real prefix signals from a nested root, same as the root-level fixture', () => {
	const { repoRoot } = nestedFixtureRepo();
	const nested = scanJavaSpring(repoRoot);
	const rootLevel = scanJavaSpring(STATIC_FIXTURE_ROOT);
	assert.deepEqual(nested.pathPrefixSignals.map((s) => ({ kind: s.kind, prefix: s.prefix, pattern: s.pattern })), rootLevel.pathPrefixSignals.map((s) => ({ kind: s.kind, prefix: s.prefix, pattern: s.pattern })));
});
