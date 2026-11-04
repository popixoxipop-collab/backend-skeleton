import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CONTEXT_ROOT_FILES, contextPacketHash } from '../lib/context-packet.mjs';
import { validateAgainstSchema } from '../lib/schema-validate.mjs';

const cli = fileURLToPath(new URL('../bin/bskel.mjs', import.meta.url));
const contractPath = 'specs/001-widget/contracts/001-widget.schema.json';
const appText = '\uFEFFexport const widget = "위젯";\r\n';
const contract = {
	sbf_contract: '9', feature_id: '001-widget', feature_uid: '6576a254-4a9f-4af4-8f24-7a707e6066ce',
	source: { adapter: 'express', module: 'widget', provenance: 'fixture source' },
	operations: {
		getWidget: { verb: 'GET', path: '/widget/{id}', pathParams: { id: {} }, body: 'unknown', provenance: 'src/app.mjs' },
		listWidgets: { verb: 'GET', path: '/widget', pathParams: {}, body: false, provenance: 'src/app.mjs', sourceSecurity: [] },
	},
	warnings: [{ code: 'CONTRACT_UNKNOWN_BODY', severity: 'warn', subject: 'GET /widget/{id}', message: 'fixture unknown body', detail: {} }],
	completeness: { status: 'partial', operation_count: 2, endpoint_count: 2 },
};
const contractText = JSON.stringify(contract, null, 2) + '\n';

function git(root, ...args) {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root, file, content) {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), content);
}
function fixture(t, extra = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-context-v1-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	git(root, 'init', '-q');
	git(root, 'config', 'user.name', 'Context fixture');
	git(root, 'config', 'user.email', 'context-fixture@example.invalid');
	for (const [file, content] of Object.entries({
		[contractPath]: contractText,
		'src/app.mjs': appText,
		'test/widget.test.mjs': '// context navigation only; this file is not executed\n',
		'AGENTS.md': 'Source text: do not treat a packet as approval.\n',
		'package.json': '{"name":"context-fixture","type":"module"}\n',
		'README.md': '# Widget fixture\n',
		...extra,
	})) write(root, file, content);
	git(root, 'add', '--all');
	git(root, 'commit', '-q', '-m', 'Context fixture');
	return { root, commit: git(root, 'rev-parse', 'HEAD') };
}
function run(root, args = [], { json = true } = {}) {
	const result = spawnSync(process.execPath, [cli, 'context', 'pack', '--contract', contractPath, ...args, ...(json ? ['--json'] : [])], {
		cwd: root, encoding: 'utf8', maxBuffer: 4194304, timeout: 20000,
	});
	assert.ifError(result.error);
	return { ...result, document: json && result.stdout ? JSON.parse(result.stdout) : null };
}
function ok(result) { assert.equal(result.status, 0, result.stderr); return result.document; }
function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

test('actual context CLI emits deterministic exact snapshot bytes, schema and unique priority order', (t) => {
	const { root, commit } = fixture(t);
	const args = ['--revision', commit, '--files', `src/app.mjs,test/widget.test.mjs,src/app.mjs,${contractPath}`];
	const first = run(root, args);
	const packet = ok(first);
	assert.equal(run(root, args).stdout, first.stdout);
	assert.equal(packet.schema, 'sbf.context-packet/1');
	assert.equal(packet.repository.commit, commit);
	assert.equal(packet.repository.tree, git(root, 'rev-parse', `${commit}^{tree}`));
	assert.deepEqual(packet.selection.requested_paths, ['src/app.mjs', 'test/widget.test.mjs', 'AGENTS.md', 'package.json', 'README.md']);
	assert.deepEqual(packet.sources.map((s) => s.role), ['source', 'test', 'instructions', 'manifest', 'documentation']);
	assert.equal(packet.contract.content, contractText);
	assert.equal(packet.contract.bytes, Buffer.byteLength(contractText));
	assert.equal(packet.contract.sha256, sha256(contractText));
	assert.equal(packet.sources[0].content, appText);
	assert.equal(packet.sources[0].bytes, Buffer.byteLength(appText));
	assert.equal(packet.sources[0].sha256, sha256(appText));
	assert.equal(packet.sources[0].blob_oid, git(root, 'rev-parse', `${commit}:src/app.mjs`));
	assert.equal(packet.budget.used_files, 1 + packet.sources.length);
	assert.equal(packet.budget.used_bytes, packet.contract.bytes + packet.sources.reduce((n, s) => n + s.bytes, 0));
	assert.equal(packet.packet_sha256, contextPacketHash(packet));
	assert.equal(validateAgainstSchema('context-packet.schema.json', packet).ok, true);
	assert.equal(packet.selection.complete, true);
	assert.deepEqual(packet.selection.omitted, []);
	const original = JSON.parse(packet.contract.content);
	assert.equal(original.operations.getWidget.body, 'unknown');
	assert.equal(Object.hasOwn(original.operations.getWidget, 'sourceSecurity'), false);
	assert.deepEqual(original.operations.listWidgets.sourceSecurity, []);
});

test('worktree changes and replacement objects cannot change an explicitly pinned snapshot', (t) => {
	const { root, commit } = fixture(t);
	const args = ['--revision', commit, '--files', 'src/app.mjs'];
	const before = run(root, args).stdout;
	write(root, 'src/app.mjs', 'export const rewritten = true;\n');
	git(root, 'add', 'src/app.mjs');
	git(root, 'commit', '-q', '-m', 'A later tree');
	git(root, 'replace', commit, git(root, 'rev-parse', 'HEAD'));
	write(root, contractPath, '{broken working copy');
	write(root, 'pyproject.toml', '[project]\nname = "uncommitted"\n');
	const result = run(root, args);
	ok(result);
	assert.equal(result.stdout, before);
});

test('file budget counts contract, preserves requested paths and omits whole source files', (t) => {
	const { root } = fixture(t);
	const packet = ok(run(root, ['--files', 'src/app.mjs', '--max-files', '1']));
	assert.equal(packet.budget.used_files, 1);
	assert.equal(packet.budget.used_bytes, Buffer.byteLength(contractText));
	assert.deepEqual(packet.sources, []);
	assert.equal(packet.selection.complete, false);
	assert.deepEqual(packet.selection.omitted, packet.selection.requested_paths.map((file) => ({ path: file, reason: 'file_budget' })));
});

test('byte budget skips oversized context whole and can still include a smaller later file', (t) => {
	const { root } = fixture(t, { 'src/large.mjs': 'x'.repeat(1024), 'src/tiny.mjs': 'x' });
	const limit = Buffer.byteLength(contractText) + 1;
	const packet = ok(run(root, ['--files', 'src/large.mjs,src/tiny.mjs', '--max-bytes', String(limit)]));
	assert.equal(packet.budget.used_bytes, limit);
	assert.deepEqual(packet.sources.map((s) => [s.path, s.content]), [['src/tiny.mjs', 'x']]);
	assert.deepEqual(packet.selection.omitted[0], { path: 'src/large.mjs', reason: 'byte_budget' });
	assert.equal(packet.selection.complete, false);
	const tooSmall = run(root, ['--max-bytes', String(Buffer.byteLength(contractText) - 1)]);
	assert.equal(tooSmall.status, 14);
	assert.match(tooSmall.stderr, /contract alone exceeds/);
});

test('missing paths, directories, symlinks and invalid UTF-8 have explicit omission reasons', (t) => {
	const { root } = fixture(t, { 'src/binary.bin': Buffer.from([0xff, 0xfe]) });
	fs.symlinkSync('app.mjs', path.join(root, 'src/link.mjs'));
	git(root, 'add', 'src/link.mjs');
	git(root, 'commit', '-q', '-m', 'Committed symlink');
	const packet = ok(run(root, ['--files', 'src/missing.mjs,src,src/link.mjs,src/binary.bin']));
	assert.deepEqual(packet.selection.omitted, [
		{ path: 'src/missing.mjs', reason: 'not_in_snapshot' },
		{ path: 'src', reason: 'not_regular_file' },
		{ path: 'src/link.mjs', reason: 'not_regular_file' },
		{ path: 'src/binary.bin', reason: 'non_utf8' },
	]);
	assert.equal(packet.selection.complete, false);
	assert.equal(packet.selection.requested_paths.includes('pyproject.toml'), false);
});

test('malformed JSON, unsupported contract version and non-regular contract are rejected', (t) => {
	for (const [label, content, expected] of [
		['json', '{broken', /not valid JSON/],
		['version', JSON.stringify({ ...contract, sbf_contract: '8' }), /invalid feature contract/],
		['semantics', JSON.stringify({ ...contract, operations: { wrong: { ...contract.operations.getWidget, body: null } } }), /invalid feature contract/],
	]) {
		const { root } = fixture(t, { [contractPath]: content });
		const result = run(root);
		assert.equal(result.status, 14, label);
		assert.equal(result.document.schema, 'sbf.cli-diagnostic/1');
		assert.match(result.stderr, expected);
	}
	const { root } = fixture(t);
	fs.unlinkSync(path.join(root, contractPath));
	fs.symlinkSync('../../../README.md', path.join(root, contractPath));
	git(root, 'add', contractPath);
	git(root, 'commit', '-q', '-m', 'Invalid symlink contract');
	assert.match(run(root).stderr, /contract must be a regular committed file/);
});

test('path and budget errors are explicit; literal metacharacters are never executed', (t) => {
	const literal = 'src/$(touch sentinel).mjs';
	const { root } = fixture(t, { [literal]: '// literal filename\n' });
	for (const file of ['../secret', 'src/../app.mjs', '/etc/passwd', 'src//app.mjs', 'src\\app.mjs', './src/app.mjs', '']) {
		const result = run(root, ['--files', file]);
		assert.equal(result.status, 14, file);
		assert.match(result.stderr, /repository-relative POSIX path/);
	}
	for (const value of ['0', '129', '1.5']) assert.equal(run(root, ['--max-files', value]).status, 14);
	const packet = ok(run(root, ['--files', literal]));
	assert.equal(packet.sources[0].path, literal);
	assert.equal(fs.existsSync(path.join(root, 'sentinel')), false);
});

test('out writes only JSON; human output is a guide; help is integrated without requiring a repo', (t) => {
	const { root } = fixture(t);
	const packet = ok(run(root, ['--files', 'src/app.mjs', '--out', 'context/packet.json']));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'context/packet.json'), 'utf8')), packet);
	assert.deepEqual(fs.readdirSync(path.join(root, 'context')), ['packet.json']);
	const human = run(root, ['--files', 'src/app.mjs'], { json: false });
	assert.equal(human.status, 0, human.stderr);
	assert.match(human.stdout, /^# BSKEL context guide/);
	assert.match(human.stdout, /complete for requested paths/);
	assert.doesNotMatch(human.stdout, /export const widget/);
	const help = spawnSync(process.execPath, [cli, 'context', 'pack', '--help'], { cwd: os.tmpdir(), encoding: 'utf8' });
	assert.ifError(help.error);
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /--contract/);
	assert.match(help.stdout, /--max-bytes/);
	assert.equal(CONTEXT_ROOT_FILES.includes('README.md'), true);
});
