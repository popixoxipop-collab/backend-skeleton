import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const NPM = process.platform === 'win32'
	? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm pack --dry-run --json'] }
	: { file: 'npm', args: ['pack', '--dry-run', '--json'] };

test('T08 packaging: npm pack includes every native-server runtime module and excludes its tests', () => {
	const raw = execFileSync(NPM.file, NPM.args, {
		cwd: ROOT,
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
	});
	const payload = JSON.parse(raw);
	assert.equal(payload.length, 1);
	const files = new Set(payload[0].files.map((entry) => entry.path));
	for (const required of [
		'scanners/language/native-server/ADR.md',
		'scanners/language/native-server/README.md',
		'scanners/language/native-server/csharp.mjs',
		'scanners/language/native-server/go.mjs',
		'scanners/language/native-server/index.mjs',
		'scanners/language/native-server/protocol.mjs',
		'scanners/language/native-server/rust.mjs',
		'scanners/language/native-server/shared.mjs',
		'scanners/language/native-server/worker.mjs',
	]) {
		assert.ok(files.has(required), `npm package is missing T08 runtime file: ${required}`);
	}
	assert.ok(![...files].some((name) => name.startsWith('test/language-native-server/')), 'T08 development tests must not ship in the npm package');
});
