// Unit tests for stack/bootstrap/_lib.sh's shell helper functions -- run via `bash -c` against
// a real (but synthetic) fixture, not by invoking real ngrok. Locks in what was verified by
// hand against a mock local HTTP server during Phase 4 development (see DECISIONS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_SH = path.join(__dirname, '..', 'stack', 'bootstrap', '_lib.sh');

function sh(script) {
	return execFileSync('bash', ['-c', `source "${LIB_SH}" && ${script}`], { encoding: 'utf8' });
}

// execFileSync blocks this process's event loop -- fine for the other tests here, but fatal
// for testing against an in-process http.createServer: the server can never actually send its
// response while the sync call is blocking the loop that would deliver it. Use the async
// exec variant for the two tests that talk to a same-process mock server.
function shAsync(script) {
	return execFileAsync('bash', ['-c', `source "${LIB_SH}" && ${script}`], { encoding: 'utf8' });
}

test('env_upsert: creates a fresh key, then replaces it idempotently', () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-lib-')), '.env');
	sh(`env_upsert "${file}" PUBLIC_BASE_URL "https://a.example"`);
	assert.equal(fs.readFileSync(file, 'utf8').trim(), 'PUBLIC_BASE_URL=https://a.example');
	sh(`env_upsert "${file}" PUBLIC_BASE_URL "https://b.example"`);
	assert.equal(fs.readFileSync(file, 'utf8').trim(), 'PUBLIC_BASE_URL=https://b.example');
});

// D-security-5 regression: env_upsert must always leave the file at 0600, even if it started
// looser (the pre-fix version replaced the file via `mv` from a temp file created at the
// process umask, silently downgrading permissions on every key update).
test('env_upsert: forces file mode to 0600 even if it started looser', () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-lib-')), '.env');
	fs.writeFileSync(file, 'NGROK_AUTHTOKEN=x\n');
	fs.chmodSync(file, 0o644);
	sh(`env_upsert "${file}" NGROK_AUTHTOKEN "y"`);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.equal(fs.readFileSync(file, 'utf8').trim(), 'NGROK_AUTHTOKEN=y');

	// A second update (the replace branch, not the create branch) must also re-assert 0600.
	fs.chmodSync(file, 0o644);
	sh(`env_upsert "${file}" NGROK_AUTHTOKEN "z"`);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

// D-security-5 regression: the swap must go through an unpredictable mktemp name, not a
// PID-based `${file}.$$.tmp` -- confirms no such predictable sibling is left behind after a
// replace (the shape an attacker would need to pre-place a symlink at).
test('env_upsert: does not leave a predictable ${file}.$$.tmp sibling behind', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-lib-'));
	const file = path.join(dir, '.env');
	fs.writeFileSync(file, 'KEY=old\n');
	const before = new Set(fs.readdirSync(dir));
	sh(`env_upsert "${file}" KEY "new"`);
	const after = fs.readdirSync(dir).filter((f) => !before.has(f));
	assert.deepEqual(after, [], `no leftover sibling files expected, got: ${after.join(', ')}`);
	const predictablePath = `${file}.$$`;
	assert.ok(!fs.existsSync(predictablePath));
});

test('env_append_unique: builds a comma list and de-duplicates', () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-lib-')), '.env');
	sh(`env_append_unique "${file}" AUTH_LOGIN_ALLOWED_ORIGINS "http://localhost:5173"`);
	sh(`env_append_unique "${file}" AUTH_LOGIN_ALLOWED_ORIGINS "https://tunnel.example"`);
	sh(`env_append_unique "${file}" AUTH_LOGIN_ALLOWED_ORIGINS "https://tunnel.example"`); // duplicate, no-op
	const content = fs.readFileSync(file, 'utf8').trim();
	assert.equal(content, 'AUTH_LOGIN_ALLOWED_ORIGINS=http://localhost:5173,https://tunnel.example');
});

test('extract_https_url: picks the https public_url out of a multi-tunnel response', () => {
	const json = '{"tunnels":[{"proto":"http","public_url":"http://x.ngrok.app"},{"proto":"https","public_url":"https://x.ngrok.app"}]}';
	const out = sh(`extract_https_url '${json}'`).trim();
	assert.equal(out, 'https://x.ngrok.app');
});

test('wait_for_tunnel: succeeds against a real local server serving a tunnels response', async () => {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ tunnels: [{ proto: 'https', public_url: 'https://mock.ngrok.app' }] }));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = server.address().port;
	try {
		const { stdout } = await shAsync(`wait_for_tunnel "http://127.0.0.1:${port}/api/tunnels" 5`);
		assert.match(stdout.trim(), /mock\.ngrok\.app/);
	} finally {
		server.close();
	}
});

test('wait_for_tunnel: times out (non-zero exit) when nothing is listening', async () => {
	await assert.rejects(() => shAsync('wait_for_tunnel "http://127.0.0.1:1/api/tunnels" 1'));
});
