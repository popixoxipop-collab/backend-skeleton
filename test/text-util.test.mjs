import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listRgFiles } from '../scanners/text-util.mjs';

test('listRgFiles does not collapse a production-size (>1 MiB) path list into an empty scan', () => {
	const output = Array.from({ length: 16_000 }, (_, i) => `/tmp/app/models/${String(i).padStart(5, '0')}_${'x'.repeat(60)}.rb`).join('\n');
	assert.ok(Buffer.byteLength(output) > 1024 * 1024, 'fixture must exceed Node execFileSync\'s default buffer');
	const files = listRgFiles('/tmp/app', ['*.rb'], [], (_command, _args, options) => {
		assert.ok(options.maxBuffer > Buffer.byteLength(output), 'caller must explicitly raise maxBuffer');
		return output;
	});
	assert.equal(files.length, 16_000);
});
