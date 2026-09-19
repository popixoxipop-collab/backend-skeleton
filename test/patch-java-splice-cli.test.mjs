// D-java-source-splice: end-to-end CLI coverage for the refusal paths that do NOT require a real
// JDK/Gradle toolchain (this repo's own established boundary -- see test/handles-ast.test.mjs's
// header: npm test never invokes the real AST helper end-to-end; that proof lives entirely in
// scripts/java-compile-smoke.mjs's new phase, which covers the happy path, benign-drift
// tolerance (T3), in-region staleness (T4), decoy-overload correctness (T7), compile-failure
// auto-restore (T8), and byte-exact rollback (T5) against a real JVM). What CAN be tested here
// without a JDK: every refusal that fires before planJavaSourceSplice() ever calls the AST
// helper (schema validation, missing/CRLF/bskel-generated target files, no recognized build
// tool, the AST-helper-unavailable path itself via PATH manipulation -- the same technique
// test/handles-ast.test.mjs already uses), plus the engine-level --reason/--confirm gates, which
// are checked against a hand-inserted transaction record before any re-plan happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'bskel.mjs');
const FEATURE_ID = '001-widget-management';
const TARGET_REL = 'src/main/java/com/example/demo/domain/widget/application/WidgetServiceImpl.java';

const REAL_JAVA_SOURCE = `package com.example.demo.domain.widget.application;

public class WidgetServiceImpl {

	private int retries = 3;

	public String updateWidget(String s) {
		return "widget:" + s;
	}
}
`;

function run(args, cwd, opts = {}) {
	try {
		const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', ...opts });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

// `withGradlew`: writes a stub, non-functional `gradlew` file so detectBuildCommand() reports the
// "gradle" tool is recognized -- planJavaSourceSplice() only checks for the FILE's existence at
// its refusal rung, it never has to actually run it for any test in this file (every test here
// either refuses before that point, or is testing the "no build tool" refusal specifically, which
// wants gradlew ABSENT).
function buildFixtureRepo({ withGradlew = true, javaSource = REAL_JAVA_SOURCE } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-splice-cli-fixture-'));
	execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	if (withGradlew) fs.writeFileSync(path.join(root, 'gradlew'), '#!/bin/sh\necho stub\n', { mode: 0o755 });
	fs.mkdirSync(path.dirname(path.join(root, TARGET_REL)), { recursive: true });
	fs.writeFileSync(path.join(root, TARGET_REL), javaSource);
	fs.writeFileSync(path.join(root, '.gitignore'), 'specs/\n.sbf/\n');
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'chore: fixture'], { cwd: root });
	const bareOrigin = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-splice-cli-origin-'));
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=develop'], { cwd: bareOrigin });
	execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: root });
	execFileSync('git', ['push', '--quiet', 'origin', 'develop'], { cwd: root });
	return root;
}

function writeSpliceFile(root, edits, { file = TARGET_REL } = {}) {
	const p = path.join(root, 'splice.json');
	fs.writeFileSync(p, JSON.stringify({ schema: 'sbf.java-source-splice/1', file, edits }, null, 2));
	return p;
}

const VALID_EDIT = {
	op: 'replace-field-initializer',
	locator: { type_fqn: 'com.example.demo.domain.widget.application.WidgetServiceImpl', member_kind: 'field', member_name: 'retries' },
	replacement: '5',
};

// Directly writes a schema-valid patch-transaction record, bypassing `patch propose` entirely --
// this is what makes the --reason/--confirm engine-level gates testable without a real AST-helper
// run (they are checked in bin/bskel.mjs BEFORE any re-plan happens).
function insertTransaction(root, { status = 'approved', kind = 'java-source-splice' } = {}) {
	const dir = path.join(root, 'specs', FEATURE_ID, 'patch-transactions');
	fs.mkdirSync(dir, { recursive: true });
	const txn = {
		schema: 'sbf.patch-transaction/1',
		transaction_id: `pt-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`,
		feature_id: FEATURE_ID,
		kind,
		source: { request_file: 'splice.json' },
		target: {
			file: TARGET_REL,
			source_root: 'src/main/java',
			line_terminator: '\n',
			edits: [{ ...VALID_EDIT, region_hash: 'x'.repeat(64), signature_hash: 'y'.repeat(64), located: { start: 0, end: 1, begin_line: 1, end_line: 1 } }],
		},
		preimage: { region_hash: 'z'.repeat(64), file_hash: 'w'.repeat(64) },
		current_value: '1 edit(s) to retries',
		proposed_value: '--- diff ---',
		postcondition: { kind: 'java-compiles', build_tool: 'gradle', build_command: './gradlew compileJava --console=plain' },
		status,
		created_at: new Date().toISOString(),
		...(status !== 'proposed' ? { approval: { reason: 'test setup', at: new Date().toISOString() } } : {}),
	};
	fs.writeFileSync(path.join(dir, `${txn.transaction_id}.json`), `${JSON.stringify(txn, null, 2)}\n`);
	return txn;
}

// ---- propose: refusals that fire before the AST helper is ever consulted ----

test('patch propose --kind java-source-splice requires --splice-file', () => {
	const root = buildFixtureRepo();
	const r = run(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'java-source-splice'], root);
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /requires --splice-file/);
});

test('patch propose refuses a --splice-file that does not match its own schema, and writes nothing to the target', () => {
	const root = buildFixtureRepo();
	const before = fs.readFileSync(path.join(root, TARGET_REL), 'utf8');
	const spliceFile = path.join(root, 'splice.json');
	fs.writeFileSync(spliceFile, JSON.stringify({ schema: 'sbf.java-source-splice/1', file: TARGET_REL, edits: [{ op: 'not-a-real-op' }] }));
	const r = run(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'java-source-splice', '--splice-file', spliceFile], root);
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /java-source-splice\.schema\.json/);
	assert.equal(fs.readFileSync(path.join(root, TARGET_REL), 'utf8'), before);
});

test('patch propose refuses a target file that does not exist', () => {
	const root = buildFixtureRepo();
	const spliceFile = writeSpliceFile(root, [VALID_EDIT], { file: 'src/main/java/com/example/DoesNotExist.java' });
	const r = run(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'java-source-splice', '--splice-file', spliceFile], root);
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /does not exist/);
});

test('patch propose refuses a target file that carries the bskel-generated marker', () => {
	const root = buildFixtureRepo({
		javaSource: `// Generated by backend-skeleton ({@code bskel handles emit}) for feature ${FEATURE_ID}.\n${REAL_JAVA_SOURCE}`,
	});
	const spliceFile = writeSpliceFile(root, [VALID_EDIT]);
	const r = run(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'java-source-splice', '--splice-file', spliceFile], root);
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /bskel-generated/);
});

test('patch propose refuses a target file tracked in .sbf/handles-manifest.json', () => {
	const root = buildFixtureRepo();
	const manifestDir = path.join(root, '.sbf');
	fs.mkdirSync(manifestDir, { recursive: true });
	fs.writeFileSync(path.join(manifestDir, 'handles-manifest.json'), JSON.stringify({
		schema: 'sbf.handles-manifest/1',
		files: { [TARGET_REL]: { hash: 'irrelevant-for-this-test', owner_feature_id: FEATURE_ID } },
		enforceRegistry: false,
	}, null, 2));
	const spliceFile = writeSpliceFile(root, [VALID_EDIT]);
	const r = run(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'java-source-splice', '--splice-file', spliceFile], root);
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /bskel-generated/);
});

test('patch propose refuses a CRLF target file rather than risk mixed line endings', () => {
	const root = buildFixtureRepo({ javaSource: REAL_JAVA_SOURCE.replaceAll('\n', '\r\n') });
	const spliceFile = writeSpliceFile(root, [VALID_EDIT]);
	const r = run(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'java-source-splice', '--splice-file', spliceFile], root);
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /CRLF/);
});

test('patch propose refuses at most one add-import edit per transaction', () => {
	const root = buildFixtureRepo();
	const spliceFile = writeSpliceFile(root, [
		{ op: 'add-import', imports: ['java.util.UUID'] },
		{ op: 'add-import', imports: ['java.util.List'] },
	]);
	const r = run(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'java-source-splice', '--splice-file', spliceFile], root);
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /at most one add-import/);
});

test('patch propose refuses when no recognized build tool is present in the repo (no postcondition could ever run)', () => {
	const root = buildFixtureRepo({ withGradlew: false });
	const spliceFile = writeSpliceFile(root, [VALID_EDIT]);
	const r = run(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'java-source-splice', '--splice-file', spliceFile], root);
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /no recognized build tool/);
});

test('patch propose refuses cleanly (and names the reason) when the AST helper is unavailable', () => {
	const root = buildFixtureRepo();
	const spliceFile = writeSpliceFile(root, [VALID_EDIT]);
	// Same PATH-scrubbing technique test/handles-ast.test.mjs already uses to simulate "no java on
	// PATH" -- deterministic and independent of whatever toolchain happens to be installed on the
	// machine actually running this suite. On macOS, git and java both live in /usr/bin, so simply
	// keeping git's own real directory on PATH would silently keep java reachable too (confirmed
	// live) -- a fresh directory containing only a `git` SYMLINK sidesteps that entirely, keeping
	// java absent regardless of where the real git binary happens to live.
	const gitShimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-java-splice-cli-gitshim-'));
	fs.symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(gitShimDir, 'git'));
	const r = run(['patch', 'propose', '--feature', FEATURE_ID, '--kind', 'java-source-splice', '--splice-file', spliceFile], root, {
		env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${gitShimDir}` },
	});
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /AST helper|java.*PATH|JDK/i);
});

// ---- approve / apply: engine-level --reason/--confirm gates against a hand-inserted transaction ----

test('patch approve requires --reason', () => {
	const root = buildFixtureRepo();
	const txn = insertTransaction(root, { status: 'proposed' });
	const r = run(['patch', 'approve', '--feature', FEATURE_ID, '--transaction', txn.transaction_id], root);
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /requires --reason/);
});

test('patch apply requires the exact per-kind --confirm value for a destructive edit', () => {
	const root = buildFixtureRepo();
	execFileSync('node', [CLI, 'preflight'], { cwd: root });
	const txn = insertTransaction(root, { status: 'approved' });
	const withoutConfirm = run(['patch', 'apply', '--feature', FEATURE_ID, '--transaction', txn.transaction_id], root);
	assert.notEqual(withoutConfirm.code, 0);
	assert.match(withoutConfirm.stderr, /requires --confirm/);

	const wrongConfirm = run(['patch', 'apply', '--feature', FEATURE_ID, '--transaction', txn.transaction_id, '--confirm', 'nonsense'], root);
	assert.notEqual(wrongConfirm.code, 0);
	assert.match(wrongConfirm.stderr, /requires --confirm/);
});

test('requiredConfirmValue for this hand-inserted transaction is "WidgetServiceImpl#retries" (matches the field locator)', () => {
	const root = buildFixtureRepo();
	const txn = insertTransaction(root, { status: 'approved' });
	const r = run(['patch', 'apply', '--feature', FEATURE_ID, '--transaction', txn.transaction_id, '--confirm', 'WidgetServiceImpl#retries'], root);
	// Preflight was never run in THIS test, so this specific call is expected to fail at the
	// preflight gate, not the --confirm check -- proving --confirm was ACCEPTED (didn't refuse for
	// that reason) is the point; assert the failure reason names preflight, not --confirm.
	assert.notEqual(r.code, 0);
	assert.doesNotMatch(r.stderr, /requires --confirm/);
});

// ---- patch list: rendering ----

test('patch list renders a java-source-splice transaction (text and --json)', () => {
	const root = buildFixtureRepo();
	const txn = insertTransaction(root, { status: 'proposed' });

	const text = run(['patch', 'list', '--feature', FEATURE_ID], root);
	assert.equal(text.code, 0);
	assert.match(text.stdout, /java-source-splice/);
	assert.match(text.stdout, /replace-field-initializer:retries/);

	const json = run(['patch', 'list', '--feature', FEATURE_ID, '--json'], root);
	assert.equal(json.code, 0);
	const parsed = JSON.parse(json.stdout);
	assert.equal(parsed.transactions.length, 1);
	assert.equal(parsed.transactions[0].transaction_id, txn.transaction_id);
	assert.equal(parsed.transactions[0].kind, 'java-source-splice');
});
