import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'adapters', 'http-legacy-next', 'corpus-parity-cli.mjs');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'javascript-express', 'backend');
const CORPUS_BASELINES = path.join(REPO_ROOT, 'test', 'http-legacy-next', 'fixtures', 'corpus-baseline.json');
const ORACLE_MANIFEST = path.join(REPO_ROOT, 'test', 'fixtures', 'oracle-manifest.json');

function fixtureRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t11-corpus-'));
	fs.cpSync(FIXTURE, root, { recursive: true });
	execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 't11@example.invalid'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'T11 Fixture'], { cwd: root });
	execFileSync('git', ['add', '-A'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
	const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
	return { root, sha };
}

function run(args) {
	const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
	return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('T11-05 corpus command validates exact ref, expected adapter, and bridge parity on a real git checkout', () => {
	const { root, sha } = fixtureRepo();
	try {
		const result = run(['--repo', root, '--adapter', 'javascript-express', '--ref', sha, '--term', 'user']);
		assert.equal(result.code, 0, result.stderr);
		const report = JSON.parse(result.stdout);
		assert.equal(report.contract, 'sbf.t11-http-corpus-parity/1');
		assert.equal(report.observed_ref, sha);
		assert.equal(report.detected_adapter, 'javascript-express');
		assert.equal(report.bridge_parity.equal, true);
		assert.equal(report.bridge_parity.diffs.length, 0);
		assert.match(report.legacy_semantic_sha256, /^[0-9a-f]{64}$/);
		assert.ok(report.endpoint_count > 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('T11-05 corpus command rejects checkout drift before scanning', () => {
	const { root, sha } = fixtureRepo();
	try {
		const wrong = (sha[0] === '0' ? '1' : '0') + sha.slice(1);
		const result = run(['--repo', root, '--adapter', 'javascript-express', '--ref', wrong, '--term', 'user']);
		assert.equal(result.code, 3);
		assert.match(result.stderr, /checkout ref mismatch/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('T11-05 corpus command rejects an expected-adapter mismatch', () => {
	const { root } = fixtureRepo();
	try {
		const result = run(['--repo', root, '--adapter', 'python-fastapi', '--term', 'user']);
		assert.equal(result.code, 5);
		assert.match(result.stderr, /adapter mismatch/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('T11-05 corpus command rejects missing terms and non-legacy adapters before scanning', () => {
	const noTerm = run(['--repo', '.', '--adapter', 'javascript-express']);
	assert.equal(noTerm.code, 2);
	assert.match(noTerm.stderr, /--term/);

	const generic = run(['--repo', '.', '--adapter', 'generic-grep', '--term', 'x']);
	assert.equal(generic.code, 2);
	assert.match(generic.stderr, /must be one of/);
});


test('T11-05 corpus command rejects semantic drift when an expected regression digest is supplied', () => {
	const { root } = fixtureRepo();
	try {
		const first = run(['--repo', root, '--adapter', 'javascript-express', '--term', 'user']);
		assert.equal(first.code, 0, first.stderr);
		const digest = JSON.parse(first.stdout).legacy_semantic_sha256;
		const good = run(['--repo', root, '--adapter', 'javascript-express', '--semantic-sha256', digest, '--term', 'user']);
		assert.equal(good.code, 0, good.stderr);

		const wrong = (digest[0] === '0' ? '1' : '0') + digest.slice(1);
		const bad = run(['--repo', root, '--adapter', 'javascript-express', '--semantic-sha256', wrong, '--term', 'user']);
		assert.equal(bad.code, 8);
		assert.match(bad.stderr, /semantic digest mismatch/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('T11-05 committed corpus baseline covers every existing pinned oracle-manifest entry exactly once', () => {
	const baselines = JSON.parse(fs.readFileSync(CORPUS_BASELINES, 'utf8'));
	const oracle = JSON.parse(fs.readFileSync(ORACLE_MANIFEST, 'utf8'));
	assert.equal(baselines.contract, 'sbf.t11-http-corpus-baseline/1');

	const expected = [];
	for (const [adapter, entries] of Object.entries(oracle.adapters)) {
		for (const entry of entries) expected.push({ adapter, ...entry });
	}
	assert.equal(baselines.entries.length, expected.length);
	assert.equal(expected.length, 17);

	const byKey = new Map();
	for (const entry of baselines.entries) {
		const key = `${entry.adapter}/${entry.id}`;
		assert.equal(byKey.has(key), false, `duplicate baseline ${key}`);
		byKey.set(key, entry);
		assert.match(entry.ref, /^[0-9a-f]{40}$/);
		assert.match(entry.semantic_sha256, /^[0-9a-f]{64}$/);
		for (const count of ['module_count', 'endpoint_count', 'entity_count', 'files_read_count', 'unknown_count']) {
			assert.ok(Number.isInteger(entry.observed?.[count]) && entry.observed[count] >= 0, `${key} invalid observed.${count}`);
		}
	}

	for (const oracleEntry of expected) {
		const key = `${oracleEntry.adapter}/${oracleEntry.id}`;
		const entry = byKey.get(key);
		assert.ok(entry, `missing corpus baseline for ${key}`);
		assert.equal(entry.owner, oracleEntry.owner);
		assert.equal(entry.repo, oracleEntry.repo);
		assert.equal(entry.ref, oracleEntry.ref);
		assert.equal(entry.path, oracleEntry.path ?? null);
		assert.deepEqual(entry.terms, oracleEntry.terms);
	}

	assert.deepEqual(
		[...byKey.keys()].sort(),
		expected.map((entry) => `${entry.adapter}/${entry.id}`).sort(),
	);
});

test('T11-05 --baseline is fail-closed for unknown ids and for mixed explicit inputs', () => {
	const unknown = run(['--repo', '.', '--baseline', 'does-not-exist']);
	assert.equal(unknown.code, 2);
	assert.match(unknown.stderr, /unknown --baseline/);

	const mixed = run(['--repo', '.', '--baseline', 'spring-petclinic', '--adapter', 'java-spring']);
	assert.equal(mixed.code, 2);
	assert.match(mixed.stderr, /cannot be combined/);
});


test('T11-05 corpus command blocks incomplete sparse checkouts before scanning', () => {
	const { root } = fixtureRepo();
	try {
		execFileSync('git', ['sparse-checkout', 'init', '--cone'], { cwd: root });
		const result = run(['--repo', root, '--adapter', 'javascript-express', '--term', 'user']);
		assert.equal(result.code, 9);
		assert.match(result.stderr, /corpus checkout is incomplete/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
