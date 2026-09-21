import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreflightRunner } from '../lib/preflight-runner.mjs';

test('preflight runner leaves non-Windows platforms to the script shebang', () => {
	assert.equal(resolvePreflightRunner({ platform: 'linux' }), null);
});

test('preflight runner prefers an explicit Git Bash path on Windows', () => {
	const configured = 'D:\\tools\\bash.exe';
	assert.deepEqual(
		resolvePreflightRunner({ platform: 'win32', env: { BSKEL_BASH: configured }, exists: (p) => p === configured }),
		{ command: configured, argsPrefix: [] },
	);
});

test('preflight runner reports no candidate when Git Bash is unavailable on Windows', () => {
	assert.equal(resolvePreflightRunner({ platform: 'win32', env: {}, exists: () => false }), null);
});
