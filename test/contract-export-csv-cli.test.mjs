// D-contract-csv: CLI-level tests for `bskel contract export-csv`, through the real CLI against a
// real git repo, reusing test/_contract-fixture.mjs -- the same harness test/contract-export.test.mjs
// drives, not a second copy. Pure-function coverage (exact CSV text, escaping, C2 header shape)
// lives in test/contract-export-csv.test.mjs instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
	run, runCapturingStderr, buildFixtureRepo, initThroughScanDisposition, widgetControllerPath,
} from './_contract-fixture.mjs';

const FEATURE = '001-widget-management';

function setup({ coverage = 'complete', contextPath = null } = {}) {
	const root = buildFixtureRepo({ coverage, contextPath });
	initThroughScanDisposition(root);
	return root;
}

// ---- --out / --json / bare-stdout shapes (C7) -----------------------------------------------

test('--out writes the CSV file and prints a human summary line; --json with --out prints the sbf.contract-export-csv/1 summary instead', () => {
	const root = setup();
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 0);

	const human = run(['contract', 'export-csv', '--feature', FEATURE, '--out', 'ops.csv'], root);
	assert.equal(human.code, 0);
	const written = fs.readFileSync(path.join(root, 'ops.csv'), 'utf8');
	assert.match(written, /^operation_id,verb,path,/);
	assert.match(human.stdout, /wrote ops\.csv -- 3 operation\(s\), completeness: complete/);

	const jsonRun = run(['contract', 'export-csv', '--feature', FEATURE, '--out', 'ops2.csv', '--json'], root);
	assert.equal(jsonRun.code, 0);
	const summary = JSON.parse(jsonRun.stdout);
	assert.equal(summary.schema, 'sbf.contract-export-csv/1');
	assert.equal(summary.feature_id, FEATURE);
	assert.equal(summary.row_count, 3);
	assert.equal(summary.completeness, 'complete');
	assert.equal(summary.path_prefix_warning, null);
	assert.equal(fs.existsSync(path.join(root, 'ops2.csv')), true);
});

test('without --out, the CSV itself is the only thing on stdout, byte-identical to what --out would write', () => {
	const root = setup();
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 0);

	const toFile = run(['contract', 'export-csv', '--feature', FEATURE, '--out', 'ops.csv'], root);
	assert.equal(toFile.code, 0);
	const fileContent = fs.readFileSync(path.join(root, 'ops.csv'), 'utf8');

	const toStdout = run(['contract', 'export-csv', '--feature', FEATURE], root);
	assert.equal(toStdout.code, 0);
	assert.equal(toStdout.stdout, fileContent);
});

test('--json without --out is a loud no-op: the CSV still goes to stdout, and stderr explains why --json did nothing', () => {
	const root = setup();
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 0);

	const result = runCapturingStderr(['contract', 'export-csv', '--feature', FEATURE, '--json'], root);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /^operation_id,verb,path,/);
	assert.match(result.stderr, /--json has no effect without --out/);
});

test('--bom prepends exactly one UTF-8 BOM and changes nothing else', () => {
	const root = setup();
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 0);

	const plain = run(['contract', 'export-csv', '--feature', FEATURE], root);
	const withBom = run(['contract', 'export-csv', '--feature', FEATURE, '--bom'], root);
	assert.equal(withBom.stdout, `﻿${plain.stdout}`);
	assert.equal(withBom.stdout.charCodeAt(0), 0xFEFF);
});

// ---- C5: ungated, unlike `contract export` --------------------------------------------------

test('C5: succeeds with the contract gate NOT passed (awaiting_disposition) -- the behavior that differs from `contract export`', () => {
	const root = setup({ coverage: 'partial' });
	const emitted = run(['contract', 'emit', '--feature', FEATURE], root);
	assert.equal(emitted.code, 3, 'sanity: the gate must genuinely be awaiting_disposition, not passed');

	// `contract export` (the gated sibling) is refused in this exact state -- confirms the fixture
	// really does produce an unpassed gate, not just an untested assumption.
	assert.notEqual(run(['contract', 'export', '--feature', FEATURE], root).code, 0);

	const csv = run(['contract', 'export-csv', '--feature', FEATURE], root);
	assert.equal(csv.code, 0, `export-csv must succeed even though the contract gate has not passed: ${csv.stderr}`);
	assert.match(csv.stdout, /^operation_id,verb,path,/);
});

test('C5: --json --out reports the contract\'s actual completeness status even when it is not "complete"', () => {
	const root = setup({ coverage: 'partial' });
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 3);
	const result = run(['contract', 'export-csv', '--feature', FEATURE, '--out', 'ops.csv', '--json'], root);
	assert.equal(result.code, 0);
	assert.equal(JSON.parse(result.stdout).completeness, 'partial');
});

// ---- zero-operation refusal (kept, unlike the gate check) -------------------------------------

test('a zero-operation contract refuses with exit 14 and writes nothing, same as `contract export`', () => {
	const root = setup();
	assert.equal(run(['contract', 'emit', '--feature', FEATURE, '--module', 'nonexistent-module'], root).code, 3);
	assert.equal(run(['gate', 'force', 'contract', '--feature', FEATURE, '--reason', 'no HTTP surface'], root).code, 0);

	const refused = run(['contract', 'export-csv', '--feature', FEATURE, '--out', 'ops.csv'], root);
	assert.equal(refused.code, 14);
	assert.match(refused.stderr, /zero operations/);
	assert.equal(fs.existsSync(path.join(root, 'ops.csv')), false);
});

// ---- unreflected path prefix: downgraded to a warning, not a refusal (C5) --------------------

test('an unreflected global path-prefix signal downgrades to a stderr warning -- export-csv still succeeds', () => {
	const root = setup({ contextPath: '/api/v0' });
	const emitted = run(['contract', 'emit', '--feature', FEATURE], root);
	assert.equal(emitted.code, 3, 'sanity: contract emit itself already blocks on CONTRACT_UNREFLECTED_PATH_PREFIX');
	assert.match(emitted.stderr, /CONTRACT_UNREFLECTED_PATH_PREFIX/);

	const csv = runCapturingStderr(['contract', 'export-csv', '--feature', FEATURE], root);
	assert.equal(csv.code, 0, `export-csv must succeed despite the unreflected prefix: ${csv.stderr}`);
	assert.match(csv.stderr, /global path-prefix signal \(\/api\/v0\)/);
	assert.match(csv.stdout, /^operation_id,verb,path,/);
});

test('a missing/unreadable scan report is skipped silently -- the prefix check simply never runs, not a refusal', () => {
	const root = setup();
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 0);
	fs.rmSync(path.join(root, `specs/${FEATURE}/brownfield-scan.json`));

	const csv = runCapturingStderr(['contract', 'export-csv', '--feature', FEATURE], root);
	assert.equal(csv.code, 0);
	assert.doesNotMatch(csv.stderr, /path-prefix/);
});

// ---- C2: coverage disclosure ------------------------------------------------------------------

test('a scan-only contract (no --openapi-file) reports which columns are empty for every operation, on stderr', () => {
	const root = setup();
	assert.equal(run(['contract', 'emit', '--feature', FEATURE], root).code, 0);
	const result = runCapturingStderr(['contract', 'export-csv', '--feature', FEATURE], root);
	assert.equal(result.code, 0);
	assert.match(result.stderr, /columns are empty for every operation/);
	assert.match(result.stderr, /summary/);
});

// ---- --help ------------------------------------------------------------------------------------

test('--help renders without crashing and documents every real flag', () => {
	const help = run(['contract', 'export-csv', '--help'], process.cwd());
	assert.equal(help.code, 0);
	assert.match(help.stdout, /usage: bskel contract export-csv/);
	assert.match(help.stdout, /--bom/);
});
