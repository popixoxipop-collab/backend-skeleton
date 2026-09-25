import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { JVM_ANALYSIS_REQUEST_SCHEMA } from '../../scanners/language/jvm/protocol.mjs';
import { createJvmSemanticRecordBackend } from '../../scanners/language/jvm/semantic-backend.mjs';

function digest(bytes) {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t05-semantic-'));
	const rel = 'src/main/java/p/Dto.java';
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	const source = 'package p; public record Dto(String name) {}\n';
	fs.writeFileSync(abs, source);
	const request = {
		schema: JVM_ANALYSIS_REQUEST_SCHEMA,
		language: 'java',
		languageLevel: 17,
		mode: 'semantic',
		allowTargetExecution: false,
		classpathFingerprint: 'c'.repeat(64),
		project: { root: '.', sourceRoots: ['src/main/java'], buildFiles: [] },
		files: [{ path: rel, sha256: digest(Buffer.from(source)) }],
	};
	return { root, rel, abs, source, request };
}

test('semantic backend refuses execution without explicit helper approval', async () => {
	const f = fixture();
	try {
		let called = false;
		const backend = createJvmSemanticRecordBackend({
			detect: async () => ({ available: true, reason: null }),
			classify: async () => { called = true; return {}; },
		});
		await assert.rejects(
			backend.analyze({ request: f.request, repoRoot: f.root }),
			/explicit approval/,
		);
		assert.equal(called, false);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test('semantic backend binds classification to exact source bytes and declared source root', async () => {
	const f = fixture();
	try {
		const calls = [];
		const backend = createJvmSemanticRecordBackend({
			detect: async () => ({ available: true, reason: null }),
			classify: async (filePath, sourceRoot) => {
				calls.push({ filePath, sourceRoot });
				return {
					recordName: 'Dto',
					fields: [{
						name: 'name', rawType: 'String', resolvedType: 'java.lang.String', annotations: [],
					}],
				};
			},
		});
		const result = await backend.analyze({
			request: f.request,
			repoRoot: f.root,
			approvedHelperExecution: true,
		});
		assert.equal(result.schema, 'sbf.jvm.semantic-record-facts/0-draft');
		assert.equal(result.classpathFingerprint, 'c'.repeat(64));
		assert.equal(result.results[0].inputSha256, f.request.files[0].sha256);
		assert.equal(result.results[0].fields[0].resolvedType, 'java.lang.String');
		assert.equal(calls[0].filePath, f.abs);
		assert.equal(calls[0].sourceRoot, path.join(f.root, 'src/main/java'));
		assert.match(result.coverage, /external dependency classpath not proven/);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test('semantic backend rejects source drift before invoking the helper', async () => {
	const f = fixture();
	try {
		let called = false;
		const backend = createJvmSemanticRecordBackend({
			detect: async () => ({ available: true, reason: null }),
			classify: async () => { called = true; return {}; },
		});
		fs.appendFileSync(f.abs, '// drift\n');
		await assert.rejects(
			backend.analyze({ request: f.request, repoRoot: f.root, approvedHelperExecution: true }),
			/source hash mismatch/,
		);
		assert.equal(called, false);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test('semantic backend propagates helper unavailability without falling back to guessed facts', async () => {
	const f = fixture();
	try {
		const backend = createJvmSemanticRecordBackend({
			detect: async () => ({ available: false, reason: 'JDK missing in approved runtime' }),
			classify: async () => ({ recordName: 'should-not-run' }),
		});
		await assert.rejects(
			backend.analyze({ request: f.request, repoRoot: f.root, approvedHelperExecution: true }),
			/JDK missing/,
		);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test('semantic backend does not accept a syntax-mode request', async () => {
	const f = fixture();
	try {
		const request = { ...f.request, mode: 'syntax' };
		delete request.classpathFingerprint;
		const backend = createJvmSemanticRecordBackend({
			detect: async () => ({ available: true }),
			classify: async () => ({}),
		});
		await assert.rejects(
			backend.analyze({ request, repoRoot: f.root, approvedHelperExecution: true }),
			/mode=semantic/,
		);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test('semantic backend rejects a repository symlink that resolves outside the trusted root', { skip: process.platform === 'win32' }, async () => {
	const f = fixture();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t05-semantic-outside-'));
	try {
		const external = path.join(outside, 'Dto.java');
		const source = 'package p; public record Dto(String leaked) {}\n';
		fs.writeFileSync(external, source);
		fs.rmSync(f.abs, { force: true });
		fs.symlinkSync(external, f.abs);
		const request = {
			...f.request,
			files: [{ path: f.rel, sha256: digest(Buffer.from(source)) }],
		};
		let called = false;
		const backend = createJvmSemanticRecordBackend({
			detect: async () => ({ available: true, reason: null }),
			classify: async () => { called = true; return {}; },
		});
		await assert.rejects(
			backend.analyze({ request, repoRoot: f.root, approvedHelperExecution: true }),
			/real path escapes repository root/,
		);
		assert.equal(called, false);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});
