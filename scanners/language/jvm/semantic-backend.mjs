import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { validateJvmAnalysisRequest } from './protocol.mjs';

function sha256(bytes) {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

function contained(base, candidate) {
	const rel = path.relative(base, candidate);
	return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function realInside(root, relativePath) {
	const lexicalRoot = path.resolve(root);
	const lexical = path.resolve(lexicalRoot, relativePath);
	if (!contained(lexicalRoot, lexical)) {
		throw new Error('resolved path escapes repository root: ' + relativePath);
	}
	const realRoot = fs.realpathSync(lexicalRoot);
	const real = fs.realpathSync(lexical);
	if (!contained(realRoot, real)) {
		throw new Error('real path escapes repository root: ' + relativePath);
	}
	return real;
}

function sourceRootForFile(filePath, roots) {
	const normalized = filePath.split('/');
	let best = null;
	for (const root of roots) {
		const parts = root.split('/');
		const matches = parts.every((part, index) => normalized[index] === part);
		if (matches && (!best || parts.length > best.split('/').length)) best = root;
	}
	return best;
}

// Factory only: T05 does not import the handles-layer JavaParser bridge. The integration owner
// may inject the already-existing runAstClassify/detectAstHelperAvailable functions after the
// cross-layer dependency is approved. This keeps the static JVM layer from silently executing
// Gradle, downloading dependencies or importing downstream provider code.
export function createJvmSemanticRecordBackend({ classify, detect }) {
	if (typeof classify !== 'function' || typeof detect !== 'function') {
		throw new TypeError('classify and detect functions are required');
	}
	return Object.freeze({
		id: 'javaparser-record-fields-adapter',
		coverage: 'record-components; JDK reflection + configured source root; external dependency classpath not proven',
		executesTargetBuild: false,
		async analyze({ request, repoRoot, approvedHelperExecution = false }) {
			const validation = validateJvmAnalysisRequest(request);
			if (!validation.ok) throw new Error('invalid JVM analysis request: ' + validation.errors.join('; '));
			if (request.mode !== 'semantic') throw new Error('semantic backend requires request.mode=semantic');
			if (approvedHelperExecution !== true) throw new Error('semantic helper execution requires explicit approval');
			if (typeof repoRoot !== 'string' || repoRoot.length === 0 || !path.isAbsolute(repoRoot)) {
				throw new Error('repoRoot must be an absolute trusted-host path');
			}

			const availability = await detect();
			if (!availability || availability.available !== true) {
				throw new Error(availability?.reason || 'semantic helper is unavailable');
			}

			const results = [];
			for (const file of request.files) {
				const root = sourceRootForFile(file.path, request.project.sourceRoots);
				if (!root) throw new Error('no declared source root contains ' + file.path);
				const absoluteFile = realInside(repoRoot, file.path);
				const absoluteSourceRoot = realInside(repoRoot, root);
				if (!contained(absoluteSourceRoot, absoluteFile)) {
					throw new Error('source file escapes its declared source root: ' + file.path);
				}
				const bytes = fs.readFileSync(absoluteFile);
				const observed = sha256(bytes);
				if (observed !== file.sha256) {
					throw new Error('source hash mismatch for ' + file.path);
				}
				const raw = await classify(absoluteFile, absoluteSourceRoot);
				results.push({
					path: file.path,
					inputSha256: observed,
					recordName: raw?.recordName ?? null,
					fields: Array.isArray(raw?.fields) ? raw.fields : [],
					note: raw?.note ?? null,
				});
			}

			return {
				schema: 'sbf.jvm.semantic-record-facts/0-draft',
				backend: this.id,
				coverage: this.coverage,
				classpathFingerprint: request.classpathFingerprint,
				results,
			};
		},
	});
}