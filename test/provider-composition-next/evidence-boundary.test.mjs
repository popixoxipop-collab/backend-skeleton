import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  inspectPersistenceHandoff,
  inspectRuntimeBehaviorProjection,
  t16HashJson,
} from '../../handles/composition-next/evidence-boundary.mjs';
import { evaluateCompositionCertification } from '../../handles/composition-next/certification.mjs';
import { describeResourceGeneration } from '../../handles/composition-next/safety-profile.mjs';

const H = (c) => c.repeat(64);
const REV = 'a'.repeat(40);
const PROFILE = 'legacy-http-fixture/1';
const COMBINATION = 'python-fastapi+sqlalchemy-sqlmodel+uuid';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
}

function artifact(bytes, family, version) {
  return {
    artifact_ref: 'sbf.artifact-ref/1',
    family,
    version,
    media_type: 'application/json',
    byte_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.length,
  };
}

function runtimeFixture({ assertionPassed = true, assertionPresent = true } = {}) {
  const candidateArtifactSha = H('c');
  const binding = {
    runtime_binding: 'beval.runtime-binding/1',
    run_id: 'run-001',
    case_revision_hash: H('1'),
    oracle_profile_approval_hash: H('2'),
    contract_hash: H('3'),
    flow_hash: H('4'),
    config_hash: H('5'),
    candidate_hash: candidateArtifactSha,
    original_hash: H('6'),
    runner_implementation_hash: H('7'),
    runtime_execution_policy_hash: H('8'),
    artifacts: { fixture: H('9') },
    attempt_nonce: '11111111-1111-4111-8111-111111111111',
  };
  const oracleEvidence = {
    execution_evidence: 'beval.execution-evidence/1',
    target: 'oracle',
    contract_hash: binding.contract_hash,
    operations: ['001-demo:getUser'],
    exchanges: [{ operation: '001-demo:getUser', status: 200, schema_verdict: 'valid' }],
    flow_runs: [{ id: 'read', assertions: [{ step: 0, passed: true, code: null }] }],
  };
  const candidateEvidence = {
    execution_evidence: 'beval.execution-evidence/1',
    target: 'candidate',
    contract_hash: binding.contract_hash,
    operations: ['001-demo:getUser'],
    exchanges: [{ operation: '001-demo:getUser', status: 200, schema_verdict: 'valid' }],
    flow_runs: [{
      id: 'read',
      assertions: assertionPresent ? [{ step: 0, passed: assertionPassed, code: assertionPassed ? null : 'ASSERT_FAILED' }] : [],
    }],
  };

  const bindingBytes = jsonBytes(binding);
  const oracleEvidenceBytes = jsonBytes(oracleEvidence);
  const candidateEvidenceBytes = jsonBytes(candidateEvidence);
  const pair = {
    runtime_evidence_pair: 'beval.runtime-evidence-pair/1',
    family: 'http',
    runtime_binding_hash: t16HashJson(binding),
    attempt_nonce: binding.attempt_nonce,
    oracle_evidence_hash: t16HashJson(oracleEvidence),
    candidate_evidence_hash: t16HashJson(candidateEvidence),
  };
  const pairBytes = jsonBytes(pair);

  const passed = assertionPresent && assertionPassed ? 1 : 0;
  const failed = assertionPresent && !assertionPassed ? 1 : 0;
  const expected = assertionPresent ? 1 : 0;

  return {
    binding,
    pair,
    input: {
      bindingBytes,
      bindingRef: artifact(bindingBytes, 'beval-runtime-binding', '1'),
      pairBytes,
      pairRef: artifact(pairBytes, 'beval-runtime-evidence-pair', '1'),
      oracleEvidenceBytes,
      oracleEvidenceRef: artifact(oracleEvidenceBytes, 'beval-execution-evidence', '1'),
      candidateEvidenceBytes,
      candidateEvidenceRef: artifact(candidateEvidenceBytes, 'beval-execution-evidence', '1'),
      projection: {
        candidateRevision: REV,
        combinationId: COMBINATION,
        profileId: PROFILE,
        profileApprovalHash: binding.oracle_profile_approval_hash,
        runtimeBindingHash: pair.runtime_binding_hash,
        runtimeBindingArtifactSha256: artifact(bindingBytes, 'beval-runtime-binding', '1').byte_sha256,
        evidencePairArtifactSha256: artifact(pairBytes, 'beval-runtime-evidence-pair', '1').byte_sha256,
        oracleEvidenceArtifactSha256: artifact(oracleEvidenceBytes, 'beval-execution-evidence', '1').byte_sha256,
        candidateEvidenceArtifactSha256: artifact(candidateEvidenceBytes, 'beval-execution-evidence', '1').byte_sha256,
        candidateArtifactSha256: candidateArtifactSha,
        runId: binding.run_id,
        attemptNonce: binding.attempt_nonce,
        executionRef: 'beval-run:run-001#attempt=11111111-1111-4111-8111-111111111111',
        verdict: 'success',
        producerApproval: 'accepted',
        assertions: { expected, executed: expected, passed, failed, unresolved: 0 },
      },
    },
  };
}

function persistenceFixture() {
  const handoff = {
    contract: 'sbf.persistence-generation-handoff/1',
    status: 'ready',
    providerId: 'python-fastapi',
    persistenceId: 'sqlalchemy-sqlmodel',
    keyType: 'uuid',
    resourceId: 'users',
    entityId: 'entity:user',
    blockers: [],
  };
  const handoffBytes = jsonBytes(handoff);
  const handoffRef = artifact(handoffBytes, 'bskel-persistence-generation-handoff', '1');
  return {
    handoffBytes,
    handoffRef,
    provenance: {
      status: 'accepted',
      producerRevision: 'b'.repeat(40),
      candidateRevision: REV,
      providerId: 'python-fastapi',
      combinationId: COMBINATION,
      profileId: PROFILE,
      executionRef: 't10-live-read:fixture-001',
      artifactRef: handoffRef,
    },
  };
}


function boundEvidence(kind, {
  revision = REV,
  providerId = 'python-fastapi',
  combinationId = COMBINATION,
  profileId = PROFILE,
  status = 'success',
  executionRef = `ci:${kind}:run-001`,
} = {}) {
  const doc = {
    evidence: 'bskel.internal.handles-composition-evidence/0',
    kind,
    revision,
    status,
    provider_id: providerId,
    combination_id: combinationId,
    profile_id: profileId,
    execution_ref: executionRef,
    assertions: null,
  };
  const bytes = jsonBytes(doc);
  return {
    kind,
    bytes,
    artifactRef: artifact(bytes, 'bskel-handles-composition-evidence', '0'),
  };
}

function expected() {
  return {
    id: COMBINATION,
    providerId: 'python-fastapi',
    persistenceId: 'sqlalchemy-sqlmodel',
    keyType: 'uuid',
    candidateRevision: REV,
    profileId: PROFILE,
  };
}


test('T14 keeps existing build-tested contract while behavior uses typed artifact boundaries', () => {
  const combination = { id: COMBINATION };
  const generic = (kind, overrides = {}) => ({
    kind,
    revision: REV,
    status: 'success',
    source: 'existing-ci-contract',
    runId: 'run-existing',
    artifactRef: null,
    scope: { providerId: 'python-fastapi', combinationId: COMBINATION },
    ...overrides,
  });

  const build = evaluateCompositionCertification({
    providerId: 'python-fastapi',
    persistenceId: 'sqlalchemy-sqlmodel',
    keyType: 'uuid',
    revision: REV,
    level: 'build-tested',
    providerBaselineAudit: { ok: true, revision: REV },
    generationPreview: {
      status: 'ready',
      revision: REV,
      applyAllowed: false,
      providerId: 'python-fastapi',
      combination,
    },
    evidence: [
      generic('composition-unit'),
      generic('package-install'),
      generic('python-integration'),
    ],
  });
  assert.equal(build.status, 'certified', JSON.stringify(build.blockers));
  assert.equal(build.certifiedLevel, 'build-tested');
  assert.equal(build.applyAllowed, false);

  const stale = evaluateCompositionCertification({
    providerId: 'python-fastapi',
    persistenceId: 'sqlalchemy-sqlmodel',
    keyType: 'uuid',
    revision: REV,
    level: 'build-tested',
    providerBaselineAudit: { ok: true, revision: REV },
    generationPreview: {
      status: 'ready',
      revision: REV,
      applyAllowed: false,
      providerId: 'python-fastapi',
      combination,
    },
    evidence: [
      generic('composition-unit'),
      generic('package-install'),
      generic('python-integration', { revision: 'd'.repeat(40) }),
    ],
  });
  assert.equal(stale.status, 'blocked');
  assert.ok(stale.blockers.some((x) => x.code === 'invalid-evidence' && x.kind === 'python-integration'));
});

test('T14 typed persistence boundary accepts only exact tuple/revision/profile/artifact provenance', () => {
  const ok = inspectPersistenceHandoff({ expected: expected(), ...persistenceFixture() });
  assert.equal(ok.status, 'eligible', JSON.stringify(ok.blockers));

  const stale = persistenceFixture();
  stale.provenance = { ...stale.provenance, candidateRevision: 'c'.repeat(40) };
  assert.equal(inspectPersistenceHandoff({ expected: expected(), ...stale }).status, 'blocked');

  const cross = persistenceFixture();
  cross.provenance = { ...cross.provenance, combinationId: 'java-spring+jpa-hibernate+uuid' };
  assert.equal(inspectPersistenceHandoff({ expected: expected(), ...cross }).status, 'blocked');

  const wrongProfile = persistenceFixture();
  wrongProfile.provenance = { ...wrongProfile.provenance, profileId: 'other-profile/1' };
  assert.equal(inspectPersistenceHandoff({ expected: expected(), ...wrongProfile }).status, 'blocked');

  const wrongArtifact = persistenceFixture();
  wrongArtifact.provenance = {
    ...wrongArtifact.provenance,
    artifactRef: { ...wrongArtifact.handoffRef, byte_sha256: H('f') },
  };
  assert.equal(inspectPersistenceHandoff({ expected: expected(), ...wrongArtifact }).status, 'blocked');
});

test('T14 runtime projection requires exact binding/pair/evidence bytes and all candidate assertions passed', () => {
  const fixture = runtimeFixture();
  const ok = inspectRuntimeBehaviorProjection({ expected: expected(), ...fixture.input });
  assert.equal(ok.status, 'eligible', JSON.stringify(ok.blockers));

  const missing = runtimeFixture({ assertionPresent: false });
  const missingResult = inspectRuntimeBehaviorProjection({ expected: expected(), ...missing.input });
  assert.equal(missingResult.status, 'blocked');
  assert.ok(missingResult.blockers.some((b) => b.code === 'assertions-missing'));

  const failed = runtimeFixture({ assertionPassed: false });
  const failedResult = inspectRuntimeBehaviorProjection({ expected: expected(), ...failed.input });
  assert.equal(failedResult.status, 'blocked');
  assert.ok(failedResult.blockers.some((b) => b.code === 'assertions-not-all-passed'));
});

test('T14 runtime projection rejects stale revision, cross combination, profile drift, and artifact swaps', () => {
  for (const [field, value, code] of [
    ['candidateRevision', 'd'.repeat(40), 'candidate-revision-mismatch'],
    ['combinationId', 'java-spring+jpa-hibernate+uuid', 'runtime-combination-mismatch'],
    ['profileId', 'other-profile/1', 'profile-mismatch'],
  ]) {
    const fixture = runtimeFixture();
    fixture.input.projection = { ...fixture.input.projection, [field]: value };
    const result = inspectRuntimeBehaviorProjection({ expected: expected(), ...fixture.input });
    assert.equal(result.status, 'blocked');
    assert.ok(result.blockers.some((b) => b.code === code), `${field}: ${JSON.stringify(result.blockers)}`);
  }

  const swapped = runtimeFixture();
  swapped.input.candidateEvidenceBytes = swapped.input.oracleEvidenceBytes;
  swapped.input.candidateEvidenceRef = swapped.input.oracleEvidenceRef;
  const swappedResult = inspectRuntimeBehaviorProjection({ expected: expected(), ...swapped.input });
  assert.equal(swappedResult.status, 'blocked');
  assert.ok(swappedResult.blockers.some((b) => ['candidate-evidence-target-mismatch', 'candidate-evidence-hash-mismatch'].includes(b.code)));
});

test('RuntimeBinding/build/mock success is insufficient for behavior-tested certification', () => {
  const runtime = runtimeFixture();
  const persistence = persistenceFixture();
  const combination = { id: COMBINATION };
  const generic = (kind) => ({
    kind,
    revision: REV,
    status: 'success',
    scope: { providerId: 'python-fastapi', combinationId: COMBINATION },
  });

  const result = evaluateCompositionCertification({
    providerId: 'python-fastapi',
    persistenceId: 'sqlalchemy-sqlmodel',
    keyType: 'uuid',
    revision: REV,
    profileId: PROFILE,
    level: 'behavior-tested',
    providerBaselineAudit: { ok: true, revision: REV },
    generationPreview: {
      status: 'ready',
      revision: REV,
      applyAllowed: false,
      providerId: 'python-fastapi',
      combination,
    },
    evidence: [
      generic('composition-unit'),
      generic('package-install'),
      generic('python-integration'),
      generic('persistence-conformance'),
      generic('runtime-behavior'),
    ],
    persistenceHandoff: persistence,
    runtimeBehavior: runtime.input,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.certifiedLevel, null);
  assert.equal(result.applyAllowed, false);
  assert.ok(result.blockers.some((b) => b.code === 'behavior-handoff-not-integrated'));
  assert.equal(result.crossTrackEvidence.persistence.status, 'eligible');
  assert.equal(result.crossTrackEvidence.runtime.status, 'eligible');
});

test('T14 keeps existing manual completion boundary fail-closed', () => {
  for (const providerId of ['python-fastapi', 'typescript-express']) {
    const result = describeResourceGeneration({
      providerId,
      handlesPlan: { resources: [{ type: 'User', willGenerateResolver: true }] },
    });
    assert.equal(result.decisions[0].authorization, 'fail-closed-stub');
    assert.equal(result.decisions[0].patch, 'fail-closed-stub');
    assert.deepEqual(result.manualCompletions.map((x) => x.area), ['authorization', 'patch']);
  }

  const python = fs.readFileSync(new URL('../../handles/providers/python-fastapi/templates/resolver.py.tmpl', import.meta.url), 'utf8');
  assert.match(python, /raise HTTPException\(status_code=403/);
  assert.match(python, /raise HTTPException\(status_code=501/);

  const typescript = fs.readFileSync(new URL('../../handles/providers/typescript-express/templates/resolver.ts.tmpl', import.meta.url), 'utf8');
  assert.match(typescript, /throw new HandleAccessDeniedError/);
  assert.match(typescript, /throw new HandleNotImplementedError/);
});

test('current T10 lookup tuple and merged T16 core alone remain behavior-certification blocked', () => {
  const persistence = persistenceFixture();
  persistence.provenance = null;
  const persistenceResult = inspectPersistenceHandoff({ expected: expected(), ...persistence });
  assert.equal(persistenceResult.status, 'blocked');
  assert.ok(persistenceResult.blockers.some((b) => b.code === 'handoff-not-approved'));

  const runtime = runtimeFixture();
  runtime.input.projection = null;
  const runtimeResult = inspectRuntimeBehaviorProjection({ expected: expected(), ...runtime.input });
  assert.equal(runtimeResult.status, 'blocked');
  assert.ok(runtimeResult.blockers.some((b) => b.code === 'runtime-handoff-missing'));

  const generic = (kind) => ({
    kind,
    revision: REV,
    status: 'success',
    scope: { providerId: 'python-fastapi', combinationId: COMBINATION },
  });
  const certification = evaluateCompositionCertification({
    providerId: 'python-fastapi',
    persistenceId: 'sqlalchemy-sqlmodel',
    keyType: 'uuid',
    revision: REV,
    profileId: PROFILE,
    level: 'behavior-tested',
    providerBaselineAudit: { ok: true, revision: REV },
    generationPreview: {
      status: 'ready',
      revision: REV,
      applyAllowed: false,
      providerId: 'python-fastapi',
      combination: { id: COMBINATION },
    },
    evidence: [
      generic('composition-unit'),
      generic('package-install'),
      generic('python-integration'),
      generic('persistence-conformance'),
      generic('runtime-behavior'),
    ],
    persistenceHandoff: persistence,
    runtimeBehavior: runtime.input,
  });
  assert.equal(certification.status, 'blocked');
  assert.equal(certification.certifiedLevel, null);
  assert.equal(certification.applyAllowed, false);
  assert.ok(certification.blockers.some((b) => b.code === 'persistence-handoff-invalid'));
  assert.ok(certification.blockers.some((b) => b.code === 'runtime-handoff-invalid'));
  assert.ok(certification.blockers.some((b) => b.code === 'behavior-handoff-not-integrated'));
});
