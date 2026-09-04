#!/usr/bin/env node
// ROADMAP.md Phase 5d: `test/scan.test.mjs`/`test/contract.test.mjs` carry `skip: !repoPresent`
// gated tests against a real, private `~/Desktop/Team-IZ-Backend` clone (D-fixture-corpus) -- kept
// deliberately, not an oversight, because they have historically caught real bugs the frozen
// fixture corpus couldn't (see D-fixture-corpus's own EXIT). On every CI runner but the one
// machine that happens to have that clone, `node --test`'s own spec reporter marks each one
// `﹣ ... # Team-IZ-Backend not present...` (confirmed live) and rolls it into its own honest
// `ℹ skipped N` summary line -- true, but invisible to anyone scanning a green checkmark without
// expanding the raw log. This script makes that visible: read `npm test`'s own captured output, count how many
// of the KNOWN real-repo-gated tests actually skipped (grepped live from the two test files' own
// `skip: !repoPresent` sites, never hardcoded as "10", so a future test add/remove keeps this in
// sync automatically), and print a `::warning::` GitHub Actions annotation when that count is
// non-zero. Never fails the build -- this is a visibility fix, not a new gate; whether these tests
// ran for real was already an honest fact, just a quiet one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, '..');
export const GATED_TEST_FILES = [path.join(REPO_ROOT, 'test', 'scan.test.mjs'), path.join(REPO_ROOT, 'test', 'contract.test.mjs')];

// The literal substring both files' skip reasons share -- confirmed live (grep) to appear nowhere
// else in test/ or scripts/, so counting its occurrences in `node --test`'s own output is a safe
// proxy for "how many real-Team-IZ-Backend-gated tests did this runner actually skip."
const SKIP_REASON_NEEDLE = 'Team-IZ-Backend not present';

export function countKnownGatedTests(testFiles = GATED_TEST_FILES) {
	let count = 0;
	for (const file of testFiles) {
		const src = fs.readFileSync(file, 'utf8');
		count += (src.match(/skip:\s*!repoPresent/g) ?? []).length;
	}
	return count;
}

export function countSkippedInOutput(output) {
	return (output.match(new RegExp(SKIP_REASON_NEEDLE, 'g')) ?? []).length;
}

export function buildReport(output, testFiles = GATED_TEST_FILES) {
	const expected = countKnownGatedTests(testFiles);
	const actual = countSkippedInOutput(output);
	return { expected, actual };
}

export function formatMessage({ expected, actual }) {
	if (actual === 0) {
		return `report-repo-gated-skips: all ${expected} real-Team-IZ-Backend-gated test(s) ran for real on this runner.`;
	}
	return `::warning::${actual}/${expected} real-Team-IZ-Backend-gated test(s) were SKIPPED on this runner (D-fixture-corpus, ROADMAP.md Phase 5d) -- ~/Desktop/Team-IZ-Backend is not present here. Expected on every runner but the one dev machine that has it cloned; the frozen fixture corpus (test/fixtures/java-spring/) still covers the exact-count assertions, these are a real-repo smoke check on top.`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const logPath = process.argv[2];
	const output = logPath ? fs.readFileSync(logPath, 'utf8') : fs.readFileSync(0, 'utf8');
	console.log(formatMessage(buildReport(output)));
}
