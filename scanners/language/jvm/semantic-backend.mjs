import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { validateJvmAnalysisRequest } from './protocol.mjs';

const SHA256_RE = /^[0-9a-f]{64}$/;
const T20_HELPER_REQUIREMENTS_CONTRACT = 'bskel.first-party-helper-requirements/1';
const T20_TRUST_REQUIREMENTS_CONTRACT = 'bskel.trust-requirements/1';
const T20_TRUST_ECHO_CONTRACT = 'bskel.trust-evidence-echo/1';
const T16_RUNTIME_BINDING_CONTRACT = 'beval.runtime-binding/1';
const T16_RUNTIME_EVIDENCE_CONTRACT = 'beval.runtime-evidence-pair/1';

function sha256(bytes) {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

function plain(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireSha(value, label) {
	if (typeof value !== 'string' || !SHA256_RE.test(value)) {
		throw new Error(label + ' must be a lowercase sha256 digest');
	}
	return value;
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

function requireAuthorizationBundle(authorization) {
	if (!plain(authorization)) throw new Error('semantic helper authorization bundle is required');
	const {
		helperRequirements,
		trustEvidenceEcho,
		runtimeBinding,
		runtimeBindingHash,
		runtimeEvidencePair,
	} = authorization;
	if (!plain(helperRequirements) || helperRequirements.contract !== T20_HELPER_REQUIREMENTS_CONTRACT) {
		throw new Error('T20 helper requirements are required');
	}
	if (helperRequirements.helper_class !== 'compiler-helper') {
		throw new Error('T20 helper requirements must describe compiler-helper');
	}
	if (helperRequirements.input_mode !== 'approved-files') {
		throw new Error('T20 compiler-helper must use approved-files');
	}
	if (helperRequirements.target_code_execution !== false) {
		throw new Error('T20 helper requirements must forbid target code execution');
	}
	if (helperRequirements.executable_now !== false ||
		helperRequirements.runtime_binding_required !== true ||
		helperRequirements.evidence_required !== true) {
		throw new Error('T20 helper requirements must remain runtime/evidence gated');
	}
	if (!plain(helperRequirements.launcher)) throw new Error('T20 helper launcher identity is required');
	if (typeof helperRequirements.launcher.basename !== 'string' || helperRequirements.launcher.basename.length === 0) {
		throw new Error('T20 helper launcher basename is required');
	}
	requireSha(helperRequirements.launcher.sha256, 'T20 helper launcher sha256');

	const trustRequirements = helperRequirements.runtime?.trust_requirements;
	if (!plain(trustRequirements) || trustRequirements.contract !== T20_TRUST_REQUIREMENTS_CONTRACT) {
		throw new Error('T20 runtime trust requirements are required');
	}
	requireSha(trustRequirements.permission?.sha256, 'T20 permission digest');
	requireSha(trustRequirements.artifact_policy?.sha256, 'T20 artifact policy digest');
	if (!Number.isSafeInteger(trustRequirements.artifact_policy?.generation) ||
		trustRequirements.artifact_policy.generation < 1) {
		throw new Error('T20 artifact policy generation must be a positive safe integer');
	}

	if (!plain(trustEvidenceEcho) || trustEvidenceEcho.contract !== T20_TRUST_ECHO_CONTRACT) {
		throw new Error('T20 trust evidence echo is required');
	}
	if (trustEvidenceEcho.permission?.sha256 !== trustRequirements.permission.sha256 ||
		trustEvidenceEcho.permission?.enforced !== true) {
		throw new Error('T20 permission enforcement evidence does not match helper requirements');
	}
	if (trustEvidenceEcho.artifact_policy?.sha256 !== trustRequirements.artifact_policy.sha256 ||
		trustEvidenceEcho.artifact_policy?.generation !== trustRequirements.artifact_policy.generation ||
		trustEvidenceEcho.artifact_policy?.enforced !== true) {
		throw new Error('T20 artifact trust evidence does not match helper requirements');
	}

	if (!plain(runtimeBinding) || runtimeBinding.runtime_binding !== T16_RUNTIME_BINDING_CONTRACT) {
		throw new Error('T16 runtime binding is required');
	}
	requireSha(runtimeBindingHash, 'T16 runtime binding hash');
	requireSha(runtimeBinding.runner_implementation_hash, 'T16 runner implementation hash');
	requireSha(runtimeBinding.runtime_execution_policy_hash, 'T16 runtime execution policy hash');
	if (typeof runtimeBinding.attempt_nonce !== 'string' || runtimeBinding.attempt_nonce.length === 0) {
		throw new Error('T16 runtime attempt nonce is required');
	}

	if (!plain(runtimeEvidencePair) || runtimeEvidencePair.runtime_evidence_pair !== T16_RUNTIME_EVIDENCE_CONTRACT) {
		throw new Error('T16 runtime evidence pair is required');
	}
	if (runtimeEvidencePair.runtime_binding_hash !== runtimeBindingHash ||
		runtimeEvidencePair.attempt_nonce !== runtimeBinding.attempt_nonce) {
		throw new Error('T16 runtime evidence is not bound to the requested execution');
	}

	return {
		helperRequirements,
		trustEvidenceEcho,
		trustRequirements,
		runtimeBinding,
		runtimeBindingHash,
		runtimeEvidencePair,
	};
}

function preflightSources(request, repoRoot) {
	const files = [];
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
		files.push({
			path: file.path,
			inputSha256: observed,
			absoluteFile,
			absoluteSourceRoot,
		});
	}
	return files;
}

function requireObservedHelperIdentity(value) {
	if (!plain(value)) throw new Error('observed helper executable identity is required');
	if (typeof value.basename !== 'string' || value.basename.length === 0) {
		throw new Error('observed helper executable basename is required');
	}
	requireSha(value.sha256, 'observed helper executable sha256');
	return { basename: value.basename, sha256: value.sha256 };
}

function requireT20Proof(proof, bundle, observedHelper) {
	if (!plain(proof) || proof.verified !== true) {
		throw new Error('T20 helper/trust verification proof is required');
	}
	const expected = {
		helperRequirementsContract: T20_HELPER_REQUIREMENTS_CONTRACT,
		trustRequirementsContract: T20_TRUST_REQUIREMENTS_CONTRACT,
		trustEvidenceContract: T20_TRUST_ECHO_CONTRACT,
		helperId: bundle.helperRequirements.helper_id,
		launcherBasename: bundle.helperRequirements.launcher.basename,
		launcherSha256: bundle.helperRequirements.launcher.sha256,
		permissionSha256: bundle.trustRequirements.permission.sha256,
		artifactPolicySha256: bundle.trustRequirements.artifact_policy.sha256,
		artifactPolicyGeneration: bundle.trustRequirements.artifact_policy.generation,
	};
	for (const [field, wanted] of Object.entries(expected)) {
		if (proof[field] !== wanted) throw new Error('T20 verification proof mismatch: ' + field);
	}
	if (observedHelper.basename !== expected.launcherBasename ||
		observedHelper.sha256 !== expected.launcherSha256) {
		throw new Error('helper executable identity does not match T20-approved launcher');
	}
	return Object.freeze({ ...expected });
}

function requireT16Proof(proof, bundle) {
	if (!plain(proof) || proof.verified !== true) {
		throw new Error('T16 runtime/evidence verification proof is required');
	}
	const expected = {
		runtimeBindingContract: T16_RUNTIME_BINDING_CONTRACT,
		runtimeEvidenceContract: T16_RUNTIME_EVIDENCE_CONTRACT,
		runtimeBindingHash: bundle.runtimeBindingHash,
		attemptNonce: bundle.runtimeBinding.attempt_nonce,
		runnerImplementationHash: bundle.runtimeBinding.runner_implementation_hash,
		runtimeExecutionPolicyHash: bundle.runtimeBinding.runtime_execution_policy_hash,
	};
	for (const [field, wanted] of Object.entries(expected)) {
		if (proof[field] !== wanted) throw new Error('T16 verification proof mismatch: ' + field);
	}
	return Object.freeze({ ...expected });
}

// Factory only: T05 never imports the handles-layer JavaParser bridge or T20/T16 implementations.
// The integration owner injects pure T20/T16 verifiers plus a non-executing executable-identity
// inspector. Only classify() is allowed to cross the helper execution boundary, and it is called
// after source/root/hash checks, exact helper identity, T20 proof and T16 runtime/evidence proof.
export function createJvmSemanticRecordBackend({
	classify,
	inspectHelperExecutable,
	verifyT20Authorization,
	verifyT16RuntimeAuthorization,
}) {
	if (typeof classify !== 'function' ||
		typeof inspectHelperExecutable !== 'function' ||
		typeof verifyT20Authorization !== 'function' ||
		typeof verifyT16RuntimeAuthorization !== 'function') {
		throw new TypeError('classify, inspectHelperExecutable, verifyT20Authorization and verifyT16RuntimeAuthorization are required');
	}
	return Object.freeze({
		id: 'javaparser-record-fields-adapter',
		coverage: 'record-components; JDK reflection + configured source root; external dependency classpath not proven',
		executesTargetBuild: false,
		async analyze({ request, repoRoot, authorization }) {
			const validation = validateJvmAnalysisRequest(request);
			if (!validation.ok) throw new Error('invalid JVM analysis request: ' + validation.errors.join('; '));
			if (request.mode !== 'semantic') throw new Error('semantic backend requires request.mode=semantic');
			if (typeof repoRoot !== 'string' || repoRoot.length === 0 || !path.isAbsolute(repoRoot)) {
				throw new Error('repoRoot must be an absolute trusted-host path');
			}

			const bundle = requireAuthorizationBundle(authorization);
			const files = preflightSources(request, repoRoot);

			const observedHelper = requireObservedHelperIdentity(await inspectHelperExecutable({
				helperRequirements: bundle.helperRequirements,
			}));
			if (observedHelper.basename !== bundle.helperRequirements.launcher.basename ||
				observedHelper.sha256 !== bundle.helperRequirements.launcher.sha256) {
				throw new Error('helper executable identity does not match T20-approved launcher');
			}

			const t20Proof = requireT20Proof(await verifyT20Authorization({
				helperRequirements: bundle.helperRequirements,
				trustEvidenceEcho: bundle.trustEvidenceEcho,
				observedHelper,
			}), bundle, observedHelper);

			const t16Proof = requireT16Proof(await verifyT16RuntimeAuthorization({
				runtimeBinding: bundle.runtimeBinding,
				runtimeBindingHash: bundle.runtimeBindingHash,
				runtimeEvidencePair: bundle.runtimeEvidencePair,
				t20Proof,
			}), bundle);

			const results = [];
			for (const file of files) {
				const raw = await classify(file.absoluteFile, file.absoluteSourceRoot, {
					t20Proof,
					t16Proof,
				});
				results.push({
					path: file.path,
					inputSha256: file.inputSha256,
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
				authorization: {
					helperId: t20Proof.helperId,
					launcherSha256: t20Proof.launcherSha256,
					permissionSha256: t20Proof.permissionSha256,
					artifactPolicySha256: t20Proof.artifactPolicySha256,
					artifactPolicyGeneration: t20Proof.artifactPolicyGeneration,
					runtimeBindingHash: t16Proof.runtimeBindingHash,
					attemptNonce: t16Proof.attemptNonce,
					runnerImplementationHash: t16Proof.runnerImplementationHash,
					runtimeExecutionPolicyHash: t16Proof.runtimeExecutionPolicyHash,
				},
				results,
			};
		},
	});
}
