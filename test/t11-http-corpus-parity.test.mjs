import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 't11-http-corpus-parity.mjs');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'javascript-express', 'backend');

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
