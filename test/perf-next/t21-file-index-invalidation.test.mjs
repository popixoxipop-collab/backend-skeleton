import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFileIndex } from '../../lib/scan-scheduler-next/file-index.mjs';
import { computeInvalidation } from '../../lib/scan-scheduler-next/invalidation.mjs';

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-index-'));
	fs.mkdirSync(path.join(root, 'src'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');
	fs.writeFileSync(path.join(root, 'src', 'b.js'), "import { a } from './a.js';\nexport const b = a;\n");
	fs.writeFileSync(path.join(root, 'config.json'), '{"mode":"test"}\n');
	fs.mkdirSync(path.join(root, 'node_modules', 'ignored'), { recursive: true });
	fs.writeFileSync(path.join(root, 'node_modules', 'ignored', 'x.js'), 'ignored');
	return root;
}

test('file index is deterministic, content-addressed and excludes dependency/build directories', () => {
	const root = fixture();
	const first = buildFileIndex(root);
	const second = buildFileIndex(root);
	assert.equal(first.source_digest, second.source_digest);
	assert.deepEqual(first.entries, second.entries);
	assert.deepEqual(first.entries.map((x) => x.path), ['config.json', 'src/a.js', 'src/b.js']);
	assert.equal(first.stats.files, 3);
});

test('new, deleted and modified source invalidate transitive dependents only', () => {
	const root = fixture();
	const before = buildFileIndex(root);
	fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 2;\n');
	fs.writeFileSync(path.join(root, 'src', 'new.js'), 'export const n = 1;\n');
	fs.unlinkSync(path.join(root, 'config.json'));
	const after = buildFileIndex(root);
	const result = computeInvalidation({
		previousIndex: before,
		nextIndex: after,
		dependencyEdges: [
			{ dependent: 'src/b.js', dependency: 'src/a.js' },
			{ dependent: 'generated/contract.json', dependency: 'src/b.js' },
		],
	});
	assert.deepEqual(result.added, ['src/new.js']);
	assert.deepEqual(result.deleted, ['config.json']);
	assert.deepEqual(result.modified, ['src/a.js']);
	assert.deepEqual(result.invalidated, ['config.json', 'generated/contract.json', 'src/a.js', 'src/b.js', 'src/new.js']);
});

test('global input drift invalidates the complete previous/current file universe', () => {
	const root = fixture();
	const before = buildFileIndex(root);
	const after = buildFileIndex(root);
	const result = computeInvalidation({ previousIndex: before, nextIndex: after, globalInputsChanged: true });
	assert.deepEqual(result.invalidated, ['config.json', 'src/a.js', 'src/b.js']);
});

test('index budgets fail closed before an unbounded tree is hashed', () => {
	const root = fixture();
	assert.throws(() => buildFileIndex(root, { maxFiles: 2 }), (error) => error.code === 'INDEX_BUDGET_EXCEEDED' && error.kind === 'file-count');
	assert.throws(() => buildFileIndex(root, { maxBytes: 1 }), (error) => error.code === 'INDEX_BUDGET_EXCEEDED' && error.kind === 'byte-count');
});

test('file index reports case-fold and Unicode-normalization portability collisions without rewriting paths', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-paths-'));
	fs.mkdirSync(path.join(root, 'src'), { recursive: true });
	for (const name of ['A.js', 'a.js', 'é.js', 'e\u0301.js']) fs.writeFileSync(path.join(root, 'src', name), name);
	const index = buildFileIndex(root);
	assert.deepEqual(index.entries.map((x) => x.path), ['src/A.js', 'src/a.js', 'src/é.js', 'src/é.js']);
	assert.ok(index.portable_path_issues.some((x) => x.kind === 'case-fold-collision' && x.paths.includes('src/A.js') && x.paths.includes('src/a.js')));
	assert.ok(index.portable_path_issues.some((x) => x.kind === 'unicode-nfc-collision' && x.paths.includes('src/é.js') && x.paths.includes('src/é.js')));
	assert.notEqual(index.entries.find((x) => x.path.includes('é.js')).path, index.entries.find((x) => x.path.includes('é.js')).path);
});
