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

function authorizationFixture() {
	const launcherSha256 = '1'.repeat(64);
	const permissionSha256 = '2'.repeat(64);
	const artifactPolicySha256 = '3'.repeat(64);
	const runtimeBindingHash = '4'.repeat(64);
	const runnerImplementationHash = '5'.repeat(64);
	const runtimeExecutionPolicyHash = '6'.repeat(64);
	const attemptNonce = '123e4567-e89b-42d3-a456-426614174000';
	const helperRequirements = {
		contract: 'bskel.first-party-helper-requirements/1',
		helper_id: 'java-ast-helper',
		helper_class: 'compiler-helper',
		input_mode: 'approved-files',
		launcher: {
			basename: 'gradlew',
			sha256: launcherSha256,
		},
		runtime: {
			trust_requirements: {
				contract: 'bskel.trust-requirements/1',
				permission: {
					format: 'bskel.trust-permissions-json/1',
					sha256: permissionSha256,
				},
				artifact_policy: {
					format: 'bskel.trust-artifact-policy-json/1',
					sha256: artifactPolicySha256,
					generation: 7,
				},
			},
		},
		target_code_execution: false,
		executable_now: false,
		runtime_binding_required: true,
		evidence_required: true,
	};
	const trustEvidenceEcho = {
		contract: 'bskel.trust-evidence-echo/1',
		permission: {
			format: 'bskel.trust-permissions-json/1',
			sha256: permissionSha256,
			enforced: true,
		},
		artifact_policy: {
			format: 'bskel.trust-artifact-policy-json/1',
			sha256: artifactPolicySha256,
			generation: 7,
			enforced: true,
		},
	};
	const runtimeBinding = {
		runtime_binding: 'beval.runtime-binding/1',
		runner_implementation_hash: runnerImplementationHash,
		runtime_execution_policy_hash: runtimeExecutionPolicyHash,
		attempt_nonce: attemptNonce,
	};
	const runtimeEvidencePair = {
		runtime_evidence_pair: 'beval.runtime-evidence-pair/1',
		runtime_binding_hash: runtimeBindingHash,
		attempt_nonce: attemptNonce,
	};
	return {
		helperRequirements,
		trustEvidenceEcho,
		runtimeBinding,
		runtimeBindingHash,
		runtimeEvidencePair,
	};
}

function t20Proof(authorization) {
	const trust = authorization.helperRequirements.runtime.trust_requirements;
	return {
		verified: true,
		helperRequirementsContract: 'bskel.first-party-helper-requirements/1',
		trustRequirementsContract: 'bskel.trust-requirements/1',
		trustEvidenceContract: 'bskel.trust-evidence-echo/1',
		helperId: authorization.helperRequirements.helper_id,
		launcherBasename: authorization.helperRequirements.launcher.basename,
		launcherSha256: authorization.helperRequirements.launcher.sha256,
		permissionSha256: trust.permission.sha256,
		artifactPolicySha256: trust.artifact_policy.sha256,
		artifactPolicyGeneration: trust.artifact_policy.generation,
	};
}

function t16Proof(authorization) {
	return {
		verified: true,
		runtimeBindingContract: 'beval.runtime-binding/1',
		runtimeEvidenceContract: 'beval.runtime-evidence-pair/1',
		runtimeBindingHash: authorization.runtimeBindingHash,
		attemptNonce: authorization.runtimeBinding.attempt_nonce,
		runnerImplementationHash: authorization.runtimeBinding.runner_implementation_hash,
		runtimeExecutionPolicyHash: authorization.runtimeBinding.runtime_execution_policy_hash,
	};
}

function backendFixture(authorization, overrides = {}) {
	const calls = {
		inspect: 0,
		t20: 0,
		t16: 0,
		classify: 0,
	};
	const backend = createJvmSemanticRecordBackend({
		inspectHelperExecutable: overrides.inspectHelperExecutable ?? (async () => {
			calls.inspect++;
			return {
				basename: authorization.helperRequirements.launcher.basename,
				sha256: authorization.helperRequirements.launcher.sha256,
			};
		}),
		verifyT20Authorization: overrides.verifyT20Authorization ?? (async () => {
			calls.t20++;
			return t20Proof(authorization);
		}),
		verifyT16RuntimeAuthorization: overrides.verifyT16RuntimeAuthorization ?? (async () => {
			calls.t16++;
			return t16Proof(authorization);
		}),
		classify: overrides.classify ?? (async () => {
			calls.classify++;
			return {
				recordName: 'Dto',
				fields: [{
					name: 'name',
					rawType: 'String',
					resolvedType: 'java.lang.String',
					annotations: [],
				}],
			};
		}),
	});
	return { backend, calls };
}

test('semantic backend rejects the legacy boolean-only helper approval before any helper-side callback', async () => {
	const f = fixture();
	const authorization = authorizationFixture();
	try {
		const { backend, calls } = backendFixture(authorization);
		await assert.rejects(
			backend.analyze({
				request: f.request,
				repoRoot: f.root,
				approvedHelperExecution: true,
			}),
			/authorization bundle is required/,
		);
		assert.deepEqual(calls, { inspect: 0, t20: 0, t16: 0, classify: 0 });
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test('semantic backend executes classify only after concrete T20 and T16 proofs match the authorization bundle', async () => {
	const f = fixture();
	const authorization = authorizationFixture();
	try {
		const seen = [];
		const { backend, calls } = backendFixture(authorization, {
			classify: async (filePath, sourceRoot, proof) => {
				calls.classify++;
				seen.push({ filePath, sourceRoot, proof });
				return {
					recordName: 'Dto',
					fields: [{
						name: 'name',
						rawType: 'String',
						resolvedType: 'java.lang.String',
						annotations: [],
					}],
				};
			},
		});
		const result = await backend.analyze({
			request: f.request,
			repoRoot: f.root,
			authorization,
		});
		assert.deepEqual(calls, { inspect: 1, t20: 1, t16: 1, classify: 1 });
		assert.equal(result.schema, 'sbf.jvm.semantic-record-facts/0-draft');
		assert.equal(result.classpathFingerprint, 'c'.repeat(64));
		assert.equal(result.results[0].inputSha256, f.request.files[0].sha256);
		assert.equal(result.results[0].fields[0].resolvedType, 'java.lang.String');
		assert.equal(seen[0].filePath, fs.realpathSync(f.abs));
		assert.equal(seen[0].sourceRoot, fs.realpathSync(path.join(f.root, 'src/main/java')));
		assert.equal(seen[0].proof.t20Proof.launcherSha256, authorization.helperRequirements.launcher.sha256);
		assert.equal(seen[0].proof.t16Proof.runtimeBindingHash, authorization.runtimeBindingHash);
		assert.equal(result.authorization.runtimeBindingHash, authorization.runtimeBindingHash);
		assert.equal(result.authorization.permissionSha256, authorization.helperRequirements.runtime.trust_requirements.permission.sha256);
		assert.match(result.coverage, /external dependency classpath not proven/);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test('semantic backend rejects a boolean-shaped T20 proof before T16 verification or classify', async () => {
	const f = fixture();
	const authorization = authorizationFixture();
	try {
		const { backend, calls } = backendFixture(authorization, {
			verifyT20Authorization: async () => {
				calls.t20++;
				return { verified: true };
			},
		});
		await assert.rejects(
			backend.analyze({ request: f.request, repoRoot: f.root, authorization }),
			/T20 verification proof mismatch/,
		);
		assert.equal(calls.inspect, 1);
		assert.equal(calls.t20, 1);
		assert.equal(calls.t16, 0);
		assert.equal(calls.classify, 0);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test('semantic backend rejects a boolean-shaped T16 proof before classify', async () => {
	const f = fixture();
	const authorization = authorizationFixture();
	try {
		const { backend, calls } = backendFixture(authorization, {
			verifyT16RuntimeAuthorization: async () => {
				calls.t16++;
				return { verified: true };
			},
		});
		await assert.rejects(
			backend.analyze({ request: f.request, repoRoot: f.root, authorization }),
			/T16 verification proof mismatch/,
		);
		assert.equal(calls.inspect, 1);
		assert.equal(calls.t20, 1);
		assert.equal(calls.t16, 1);
		assert.equal(calls.classify, 0);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test('semantic backend rejects source drift before executable inspection or authorization verification', async () => {
	const f = fixture();
	const authorization = authorizationFixture();
	try {
		const { backend, calls } = backendFixture(authorization);
		fs.appendFileSync(f.abs, '// drift\n');
		await assert.rejects(
			backend.analyze({ request: f.request, repoRoot: f.root, authorization }),
			/source hash mismatch/,
		);
		assert.deepEqual(calls, { inspect: 0, t20: 0, t16: 0, classify: 0 });
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test('semantic backend rejects helper executable digest mismatch before T20/T16 verification or classify', async () => {
	const f = fixture();
	const authorization = authorizationFixture();
	try {
		const calls = { inspect: 0, t20: 0, t16: 0, classify: 0 };
		const backend = createJvmSemanticRecordBackend({
			inspectHelperExecutable: async () => {
				calls.inspect++;
				return {
					basename: authorization.helperRequirements.launcher.basename,
					sha256: 'f'.repeat(64),
				};
			},
			verifyT20Authorization: async () => {
				calls.t20++;
				return t20Proof(authorization);
			},
			verifyT16RuntimeAuthorization: async () => {
				calls.t16++;
				return t16Proof(authorization);
			},
			classify: async () => {
				calls.classify++;
				return {};
			},
		});
		await assert.rejects(
			backend.analyze({ request: f.request, repoRoot: f.root, authorization }),
			/helper executable identity does not match/,
		);
		assert.deepEqual(calls, { inspect: 1, t20: 0, t16: 0, classify: 0 });
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test('semantic backend rejects T20 trust evidence mismatch before executable inspection', async () => {
	const f = fixture();
	const authorization = authorizationFixture();
	authorization.trustEvidenceEcho = {
		...authorization.trustEvidenceEcho,
		permission: {
			...authorization.trustEvidenceEcho.permission,
			sha256: '9'.repeat(64),
		},
	};
	try {
		const { backend, calls } = backendFixture(authorization);
		await assert.rejects(
			backend.analyze({ request: f.request, repoRoot: f.root, authorization }),
			/T20 permission enforcement evidence does not match/,
		);
		assert.deepEqual(calls, { inspect: 0, t20: 0, t16: 0, classify: 0 });
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test('semantic backend rejects T16 evidence binding mismatch before executable inspection', async () => {
	const f = fixture();
	const authorization = authorizationFixture();
	authorization.runtimeEvidencePair = {
		...authorization.runtimeEvidencePair,
		runtime_binding_hash: '9'.repeat(64),
	};
	try {
		const { backend, calls } = backendFixture(authorization);
		await assert.rejects(
			backend.analyze({ request: f.request, repoRoot: f.root, authorization }),
			/T16 runtime evidence is not bound/,
		);
		assert.deepEqual(calls, { inspect: 0, t20: 0, t16: 0, classify: 0 });
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test('semantic backend rejects a file outside every declared source root before helper-side callbacks', async () => {
	const f = fixture();
	const authorization = authorizationFixture();
	try {
		const outsideRel = 'other/Dto.java';
		const outsideAbs = path.join(f.root, outsideRel);
		fs.mkdirSync(path.dirname(outsideAbs), { recursive: true });
		fs.writeFileSync(outsideAbs, f.source);
		const request = {
			...f.request,
			files: [{ path: outsideRel, sha256: digest(Buffer.from(f.source)) }],
		};
		const { backend, calls } = backendFixture(authorization);
		await assert.rejects(
			backend.analyze({ request, repoRoot: f.root, authorization }),
			/no declared source root contains/,
		);
		assert.deepEqual(calls, { inspect: 0, t20: 0, t16: 0, classify: 0 });
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test('semantic backend rejects a repository symlink that resolves outside the trusted root before helper-side callbacks', { skip: process.platform === 'win32' }, async () => {
	const f = fixture();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t05-semantic-outside-'));
	const authorization = authorizationFixture();
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
		const { backend, calls } = backendFixture(authorization);
		await assert.rejects(
			backend.analyze({ request, repoRoot: f.root, authorization }),
			/real path escapes repository root/,
		);
		assert.deepEqual(calls, { inspect: 0, t20: 0, t16: 0, classify: 0 });
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test('syntax-mode request cannot cross any semantic helper authorization or execution callback', async () => {
	const f = fixture();
	const authorization = authorizationFixture();
	try {
		const request = { ...f.request, mode: 'syntax' };
		delete request.classpathFingerprint;
		const { backend, calls } = backendFixture(authorization);
		await assert.rejects(
			backend.analyze({ request, repoRoot: f.root, authorization }),
			/mode=semantic/,
		);
		assert.deepEqual(calls, { inspect: 0, t20: 0, t16: 0, classify: 0 });
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});
