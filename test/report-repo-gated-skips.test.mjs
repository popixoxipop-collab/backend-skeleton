// ROADMAP.md Phase 5d: regression guard for scripts/report-repo-gated-skips.mjs -- a pure-function
// unit test (no subprocess, no real npm test run) since the exported functions are already
// side-effect-free string/count logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countKnownGatedTests, countSkippedInOutput, buildReport, formatMessage, GATED_TEST_FILES } from '../scripts/report-repo-gated-skips.mjs';

test('countKnownGatedTests finds exactly the real skip: !repoPresent sites in scan.test.mjs + contract.test.mjs', () => {
	const count = countKnownGatedTests(GATED_TEST_FILES);
	assert.equal(count, 10, `expected 10 known Team-IZ-Backend-gated tests (2 in scan.test.mjs + 8 in contract.test.mjs) -- got ${count}. If this legitimately changed, it means a real-repo-gated test was added or removed -- not a bug in this counter.`);
});

test('countSkippedInOutput counts occurrences of the shared skip-reason substring, and only that', () => {
	const output = [
		'﹣ smoke (real Team-IZ-Backend, when present): a (0.1ms) # Team-IZ-Backend not present on this machine',
		'﹣ smoke (real Team-IZ-Backend, when present): b (0.1ms) # Team-IZ-Backend not present',
		'✔ some unrelated passing test (1ms)',
		'ℹ skipped 2',
	].join('\n');
	assert.equal(countSkippedInOutput(output), 2);
});

test('countSkippedInOutput returns 0 on output with no skips (the common case on a machine with the repo present)', () => {
	const output = '✔ smoke (real Team-IZ-Backend, when present): a (1ms)\nℹ skipped 0\n';
	assert.equal(countSkippedInOutput(output), 0);
});

test('formatMessage: zero skipped -> a plain informational line, no GitHub Actions warning annotation', () => {
	const msg = formatMessage({ expected: 10, actual: 0 });
	assert.match(msg, /all 10 real-Team-IZ-Backend-gated test\(s\) ran for real/);
	assert.ok(!msg.startsWith('::warning::'));
});

test('formatMessage: some skipped -> a "::warning::" GitHub Actions annotation naming the exact count', () => {
	const msg = formatMessage({ expected: 10, actual: 10 });
	assert.match(msg, /^::warning::10\/10 real-Team-IZ-Backend-gated test\(s\) were SKIPPED/);
});

test('formatMessage: a partial skip (fewer skipped than known -- e.g. some ran, others failed for an unrelated reason) still reports the real fraction', () => {
	const msg = formatMessage({ expected: 10, actual: 3 });
	assert.match(msg, /^::warning::3\/10 real-Team-IZ-Backend-gated test\(s\) were SKIPPED/);
});

test('buildReport composes countKnownGatedTests + countSkippedInOutput correctly', () => {
	const output = 'ℹ skipped 2\n# Team-IZ-Backend not present\n# Team-IZ-Backend not present on this machine\n';
	const report = buildReport(output, GATED_TEST_FILES);
	assert.equal(report.expected, 10);
	assert.equal(report.actual, 2);
});
