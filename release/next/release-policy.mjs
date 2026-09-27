#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { publicKeyIdFromPublic, verifyPayload } from '../../lib/attest.mjs';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256_REF = /^sha256:[a-f0-9]{64}$/;
const ROLES = ['bskel', 'becoder', 'beval'];
const EXPECTED_ROLE_IDENTITIES = new Map([
  ['bskel', { repo: 'popixoxipop-collab/backend-skeleton', package: 'backend-skeleton' }],
  ['becoder', { repo: 'popixoxipop-collab/backend-decoder', package: 'backend-decoder' }],
  ['beval', { repo: 'popixoxipop-collab/Backend-evaluation', package: 'backend-evaluator' }],
]);
const EXPECTED_STAGES = [
  {
    id: 'M1-consumer-first',
    writer_mode: 'legacy-only',
    consumer_mode: 'legacy-plus-next-readers',
    promotion: false,
    rollback: 'disable additive next readers; do not rewrite historical artifacts',
  },
  {
    id: 'M2-shadow',
    writer_mode: 'legacy-plus-shadow-next',
    consumer_mode: 'compare-only',
    promotion: false,
    rollback: 'stop shadow production; retain referenced evidence',
  },
  {
    id: 'M3-opt-in-writer',
    writer_mode: 'next-for-explicit-approved-profiles',
    consumer_mode: 'approved-combination-only',
    promotion: false,
    rollback: 'turn profile off; keep next artifacts read-only',
  },
  {
    id: 'M4-per-profile-default',
    writer_mode: 'next-only-for-certified-profile',
    consumer_mode: 'certified-package-matrix',
    promotion: false,
    rollback: 'restore previous package/profile and invalidate semantic cache revision',
  },
];
const REQUIRED_PREREQUISITES = new Map([
  ['T00-01', 'ACCEPTED'],
  ['T00-04A', 'ACTIVE_CORE_FREEZE'],
  ['T00-05', 'ACCEPTED'],
  ['T01-06', 'ACCEPTED'],
  ['T19-03', 'ACCEPTED'],
  ['T20-03', 'ACCEPTED'],
]);
const REQUIRED_PROMOTION_EVIDENCE = new Map([
  ['t01_06', 'T01_06_NOT_ACCEPTED'],
  ['t19_03', 'INDEPENDENT_QA_NOT_READY'],
  ['t20_03', 'TRUST_POLICY_NOT_READY'],
]);
const REQUIRED_RELEASE_CHECKS = [
  'bskel npm run test:pack',
  'becoder npm run test:pack',
  'beval npm run test:pack',
  'T01-06 accepted consumer-set evidence',
  'direct exact-head CI for final main release SHAs',
  'historical contract/run replay',
  'rollback rehearsal without destructive database downgrade',
  'T19-03 independent QA acceptance',
  'T20-03 externally observed enforcement acceptance',
  'support matrix generated only from admitted evidence-backed profiles',
];

const EVIDENCE_MANIFEST_SCHEMA = 'bskel.scale-release-evidence-manifest/1';
const RELEASE_EVIDENCE_SCHEMA = 'bskel.scale-release-evidence/1';
const EVIDENCE_AUTHORITY_SCHEMA = 'bskel.scale-release-evidence-authority/1';
const EVIDENCE_ATTESTATION_SCHEMA = 'bskel.scale-release-evidence-attestation/1';
const ACTIVATION_LEASE_SCHEMA = 'bskel.scale-default-activation-lease/1';
const ACTIVATION_ATTESTATION_SCHEMA = 'bskel.scale-default-activation-lease-attestation/1';

function push(errors, code, detail = {}) {
  errors.push({ code, ...detail });
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function repoMap(inventory) {
  return new Map((inventory.repositories ?? []).map((x) => [x.role, x]));
}

function releaseHeads(inventory) {
  const repos = repoMap(inventory);
  return Object.fromEntries(ROLES.map((role) => [role, repos.get(role)?.head_sha ?? null]));
}

function sameHeads(actual, expected) {
  return ROLES.every((role) => actual?.[role] === expected?.[role] && SHA40.test(actual?.[role] ?? ''));
}

function hashRef(bytes) {
  return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
}

function payloadWithoutAttestation(value) {
  const payload = structuredClone(value);
  delete payload.attestation;
  return payload;
}

export function loadEvidenceAuthority(authorityPath, expectedAuthorityRef) {
  const errors = [];
  const keys = new Map();

  if (!authorityPath && !expectedAuthorityRef) {
    return { ok: false, absent: true, errors, keys, ref: null, path: null };
  }
  if (typeof authorityPath !== 'string' || authorityPath.length === 0) {
    push(errors, 'EVIDENCE_AUTHORITY_PATH_REQUIRED');
    return { ok: false, absent: false, errors, keys, ref: null, path: null };
  }
  if (typeof expectedAuthorityRef !== 'string' || !SHA256_REF.test(expectedAuthorityRef)) {
    push(errors, 'EVIDENCE_AUTHORITY_EXPECTED_REF');
    return { ok: false, absent: false, errors, keys, ref: null, path: path.resolve(authorityPath) };
  }

  const authorityFile = path.resolve(authorityPath);
  let bytes;
  let authority;
  try {
    bytes = fs.readFileSync(authorityFile);
    authority = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    push(errors, 'EVIDENCE_AUTHORITY_UNREADABLE', { message: String(error?.message ?? error) });
    return { ok: false, absent: false, errors, keys, ref: null, path: authorityFile };
  }

  const actualRef = hashRef(bytes);
  if (actualRef !== expectedAuthorityRef) {
    push(errors, 'EVIDENCE_AUTHORITY_REF_MISMATCH', { expected: expectedAuthorityRef, actual: actualRef });
  }
  if (authority?.schema !== EVIDENCE_AUTHORITY_SCHEMA) {
    push(errors, 'EVIDENCE_AUTHORITY_SCHEMA');
  }
  if (!Array.isArray(authority?.trusted_keys) || authority.trusted_keys.length === 0) {
    push(errors, 'EVIDENCE_AUTHORITY_KEYS_REQUIRED');
  } else {
    for (const [index, item] of authority.trusted_keys.entries()) {
      if (!plain(item) || typeof item.key_id !== 'string' || typeof item.public_key_pem !== 'string') {
        push(errors, 'EVIDENCE_AUTHORITY_KEY_INVALID', { index });
        continue;
      }
      let computed;
      try {
        const parsedKey = crypto.createPublicKey(item.public_key_pem);
        if (parsedKey.asymmetricKeyType !== 'ed25519') {
          push(errors, 'EVIDENCE_AUTHORITY_KEY_TYPE', { index, actual: parsedKey.asymmetricKeyType ?? null });
          continue;
        }
        computed = publicKeyIdFromPublic(item.public_key_pem);
      } catch {
        push(errors, 'EVIDENCE_AUTHORITY_PUBLIC_KEY_INVALID', { index });
        continue;
      }
      if (computed !== item.key_id) {
        push(errors, 'EVIDENCE_AUTHORITY_KEY_ID_MISMATCH', { index, expected: computed, actual: item.key_id });
        continue;
      }
      if (keys.has(item.key_id)) {
        push(errors, 'EVIDENCE_AUTHORITY_KEY_DUPLICATE', { key_id: item.key_id });
        continue;
      }
      keys.set(item.key_id, item.public_key_pem);
    }
  }

  return {
    ok: errors.length === 0,
    absent: false,
    errors,
    keys,
    ref: actualRef,
    path: authorityFile,
  };
}

function verifySignedObject(value, authority, attestationSchema, errors, prefix) {
  const attestation = value?.attestation;
  if (!authority?.ok) {
    push(errors, prefix + '_AUTHORITY_REQUIRED');
    return false;
  }
  if (!plain(attestation) || attestation.schema !== attestationSchema) {
    push(errors, prefix + '_ATTESTATION_SCHEMA');
    return false;
  }
  if (typeof attestation.key_id !== 'string' || typeof attestation.signature !== 'string') {
    push(errors, prefix + '_ATTESTATION_FIELDS');
    return false;
  }
  const publicKeyPem = authority.keys.get(attestation.key_id);
  if (!publicKeyPem) {
    push(errors, prefix + '_ATTESTATION_UNTRUSTED_KEY', { key_id: attestation.key_id });
    return false;
  }
  const payload = payloadWithoutAttestation(value);
  if (!verifyPayload(payload, attestation.signature, publicKeyPem)) {
    push(errors, prefix + '_ATTESTATION_SIGNATURE');
    return false;
  }
  return true;
}

function validateCheckSpecificEvidence(artifact, errors, ref) {
  const id = artifact.check_id;
  const verifier = artifact.verifier;
  const heads = artifact.release_heads;

  if (!plain(verifier)) {
    push(errors, 'EVIDENCE_VERIFIER_REQUIRED', { ref, check_id: id });
    return;
  }

  const requireInt = (value, field) => {
    if (!Number.isInteger(value) || value < 1) {
      push(errors, 'EVIDENCE_VERIFIER_FIELD', { ref, check_id: id, field });
      return false;
    }
    return true;
  };

  const requireSha = (value, field) => {
    if (!SHA40.test(value ?? '')) {
      push(errors, 'EVIDENCE_VERIFIER_FIELD', { ref, check_id: id, field });
      return false;
    }
    return true;
  };

  const packSpecs = new Map([
    ['bskel npm run test:pack', { role: 'bskel', repo: 'popixoxipop-collab/backend-skeleton' }],
    ['becoder npm run test:pack', { role: 'becoder', repo: 'popixoxipop-collab/backend-decoder' }],
    ['beval npm run test:pack', { role: 'beval', repo: 'popixoxipop-collab/Backend-evaluation' }],
  ]);

  if (packSpecs.has(id)) {
    const spec = packSpecs.get(id);
    if (
      verifier.kind !== 'github-actions'
      || verifier.repository !== spec.repo
      || verifier.head_sha !== heads?.[spec.role]
      || verifier.conclusion !== 'success'
      || verifier.command !== 'npm run test:pack'
      || verifier.exit_code !== 0
    ) {
      push(errors, 'EVIDENCE_PACK_VERIFIER_MISMATCH', { ref, check_id: id });
    }
    requireInt(verifier.run_id, 'run_id');
    requireSha(verifier.head_sha, 'head_sha');
    return;
  }

  if (id === 'T01-06 accepted consumer-set evidence') {
    if (
      verifier.kind !== 't00-gate'
      || verifier.gate !== 'T01-06'
      || verifier.state !== 'ACCEPTED'
      || verifier.subject_sha !== heads?.beval
      || verifier.becoder_passed !== 12
      || verifier.beval_passed !== 12
      || typeof verifier.conformance_pack_sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(verifier.conformance_pack_sha256)
    ) {
      push(errors, 'EVIDENCE_T01_VERIFIER_MISMATCH', { ref });
    }
    return;
  }

  if (id === 'direct exact-head CI for final main release SHAs') {
    if (verifier.kind !== 'github-actions-matrix' || !plain(verifier.runs)) {
      push(errors, 'EVIDENCE_DIRECT_CI_VERIFIER_MISMATCH', { ref });
      return;
    }
    for (const role of ROLES) {
      const run = verifier.runs[role];
      if (
        !plain(run)
        || run.head_sha !== heads?.[role]
        || run.conclusion !== 'success'
        || !Number.isInteger(run.run_id)
        || run.run_id < 1
      ) {
        push(errors, 'EVIDENCE_DIRECT_CI_ROLE_MISMATCH', { ref, role });
      }
    }
    return;
  }

  if (id === 'historical contract/run replay') {
    if (
      verifier.kind !== 't00-replay'
      || !Number.isInteger(verifier.replayed_count)
      || verifier.replayed_count < 1
      || verifier.failed_count !== 0
      || verifier.historical_contracts_verified !== true
    ) {
      push(errors, 'EVIDENCE_REPLAY_VERIFIER_MISMATCH', { ref });
    }
    return;
  }

  if (id === 'rollback rehearsal without destructive database downgrade') {
    if (
      verifier.kind !== 't00-rehearsal'
      || verifier.passed !== true
      || verifier.destructive_down_migration !== false
      || verifier.rollback_restored_previous !== true
    ) {
      push(errors, 'EVIDENCE_REHEARSAL_VERIFIER_MISMATCH', { ref });
    }
    return;
  }

  if (id === 'T19-03 independent QA acceptance') {
    if (
      verifier.kind !== 't19-independent'
      || verifier.gate !== 'T19-03'
      || verifier.state !== 'ACCEPTED'
      || verifier.holdouts_passed !== true
      || !SHA40.test(verifier.qa_head ?? '')
      || !SHA256_REF.test(verifier.release_certificate_ref ?? '')
    ) {
      push(errors, 'EVIDENCE_T19_VERIFIER_MISMATCH', { ref });
    }
    return;
  }

  if (id === 'T20-03 externally observed enforcement acceptance') {
    if (
      verifier.kind !== 't20-external'
      || verifier.gate !== 'T20-03'
      || verifier.state !== 'ACCEPTED'
      || !Number.isInteger(verifier.external_evidence_count)
      || verifier.external_evidence_count < 1
      || !SHA256_REF.test(verifier.closeout_ref ?? '')
    ) {
      push(errors, 'EVIDENCE_T20_VERIFIER_MISMATCH', { ref });
    }
    return;
  }

  if (id === 'support matrix generated only from admitted evidence-backed profiles') {
    if (
      verifier.kind !== 't23-support-matrix'
      || !Number.isInteger(verifier.admitted_profiles)
      || verifier.admitted_profiles < 1
      || !Number.isInteger(verifier.unsupported_profiles)
      || verifier.unsupported_profiles < 0
      || !Array.isArray(verifier.source_evidence_refs)
      || verifier.source_evidence_refs.length === 0
      || verifier.source_evidence_refs.some((item) => typeof item !== 'string' || !SHA256_REF.test(item))
    ) {
      push(errors, 'EVIDENCE_SUPPORT_MATRIX_VERIFIER_MISMATCH', { ref });
    }
    return;
  }

  push(errors, 'EVIDENCE_UNKNOWN_CHECK', { ref, check_id: id });
}

export function loadEvidenceStore(manifestPath, authority = null) {
  const errors = [];
  const entries = new Map();

  if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
    push(errors, 'EVIDENCE_MANIFEST_PATH_REQUIRED');
    return { ok: false, errors, entries };
  }

  const manifestFile = path.resolve(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    push(errors, 'EVIDENCE_MANIFEST_UNREADABLE', { message: String(error?.message ?? error) });
    return { ok: false, errors, entries };
  }
  if (manifest?.schema !== EVIDENCE_MANIFEST_SCHEMA) push(errors, 'EVIDENCE_MANIFEST_SCHEMA');
  if (!Array.isArray(manifest?.entries)) {
    push(errors, 'EVIDENCE_MANIFEST_ENTRIES_REQUIRED');
    return { ok: errors.length === 0, errors, entries };
  }

  const base = path.dirname(manifestFile);
  const artifactRoot = path.resolve(base, 'evidence-artifacts');
  const artifactBoundary = artifactRoot + path.sep;

  for (const [index, item] of manifest.entries.entries()) {
    const errorCount = errors.length;
    const ref = item?.ref;
    const relative = item?.path;

    if (typeof ref !== 'string' || !SHA256_REF.test(ref)) {
      push(errors, 'EVIDENCE_MANIFEST_REF_INVALID', { index });
      continue;
    }
    if (entries.has(ref)) {
      push(errors, 'EVIDENCE_MANIFEST_REF_DUPLICATE', { ref });
      continue;
    }
    if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)) {
      push(errors, 'EVIDENCE_MANIFEST_ARTIFACT_PATH_INVALID', { ref });
      continue;
    }

    const resolved = path.resolve(base, relative);
    if (resolved !== artifactRoot && !resolved.startsWith(artifactBoundary)) {
      push(errors, 'EVIDENCE_MANIFEST_ARTIFACT_PATH_ESCAPE', { ref });
      continue;
    }

    let bytes;
    try {
      bytes = fs.readFileSync(resolved);
    } catch (error) {
      push(errors, 'EVIDENCE_ARTIFACT_UNREADABLE', { ref, message: String(error?.message ?? error) });
      continue;
    }

    const actualRef = hashRef(bytes);
    if (actualRef !== ref) {
      push(errors, 'EVIDENCE_ARTIFACT_DIGEST_MISMATCH', { ref, actual: actualRef });
      continue;
    }

    let artifact;
    try {
      artifact = JSON.parse(bytes.toString('utf8'));
    } catch {
      push(errors, 'EVIDENCE_ARTIFACT_JSON_INVALID', { ref });
      continue;
    }

    if (!plain(artifact)) {
      push(errors, 'EVIDENCE_ARTIFACT_OBJECT_REQUIRED', { ref });
      continue;
    }

    if (artifact.schema !== RELEASE_EVIDENCE_SCHEMA) push(errors, 'EVIDENCE_ARTIFACT_SCHEMA', { ref });
    if (typeof artifact?.check_id !== 'string' || artifact.check_id.length === 0) push(errors, 'EVIDENCE_ARTIFACT_CHECK_ID', { ref });
    if (artifact?.outcome !== 'PASS') push(errors, 'EVIDENCE_ARTIFACT_OUTCOME', { ref, outcome: artifact?.outcome ?? null });
    if (typeof artifact?.observed_at !== 'string' || artifact.observed_at.length === 0) push(errors, 'EVIDENCE_ARTIFACT_OBSERVED_AT', { ref });
    if (!sameHeads(artifact?.release_heads, artifact?.release_heads)) push(errors, 'EVIDENCE_ARTIFACT_RELEASE_HEADS', { ref });

    verifySignedObject(artifact, authority, EVIDENCE_ATTESTATION_SCHEMA, errors, 'EVIDENCE');
    validateCheckSpecificEvidence(artifact, errors, ref);

    if (errors.length === errorCount) entries.set(ref, { artifact, path: resolved });
  }

  for (const [ref, entry] of [...entries]) {
    const artifact = entry.artifact;
    if (artifact?.check_id !== 'support matrix generated only from admitted evidence-backed profiles') continue;

    let sourceFailure = false;
    for (const sourceRef of artifact?.verifier?.source_evidence_refs ?? []) {
      if (sourceRef === ref) {
        push(errors, 'EVIDENCE_SUPPORT_MATRIX_SOURCE_SELF_REFERENCE', { ref, source_ref: sourceRef });
        sourceFailure = true;
        continue;
      }
      const source = entries.get(sourceRef);
      if (!source) {
        push(errors, 'EVIDENCE_SUPPORT_MATRIX_SOURCE_NOT_FOUND', { ref, source_ref: sourceRef });
        sourceFailure = true;
        continue;
      }
      if (source.artifact?.outcome !== 'PASS') {
        push(errors, 'EVIDENCE_SUPPORT_MATRIX_SOURCE_NOT_PASS', { ref, source_ref: sourceRef });
        sourceFailure = true;
        continue;
      }
      if (source.artifact?.check_id === 'support matrix generated only from admitted evidence-backed profiles') {
        push(errors, 'EVIDENCE_SUPPORT_MATRIX_SOURCE_RECURSIVE', { ref, source_ref: sourceRef });
        sourceFailure = true;
        continue;
      }
      if (!sameHeads(source.artifact?.release_heads, artifact.release_heads)) {
        push(errors, 'EVIDENCE_SUPPORT_MATRIX_SOURCE_CONTEXT_MISMATCH', { ref, source_ref: sourceRef });
        sourceFailure = true;
      }
    }
    if (sourceFailure) entries.delete(ref);
  }

  return { ok: errors.length === 0, errors, entries };
}

function evidenceRefsResolve(refs, checkId, inventory, evidenceStore) {
  if (!Array.isArray(refs) || refs.length === 0 || !evidenceStore?.ok) return false;
  const heads = releaseHeads(inventory);

  return refs.every((ref) => {
    if (typeof ref !== 'string' || !SHA256_REF.test(ref)) return false;
    const artifact = evidenceStore.entries?.get(ref)?.artifact;
    return artifact?.schema === RELEASE_EVIDENCE_SCHEMA
      && artifact.check_id === checkId
      && artifact.outcome === 'PASS'
      && sameHeads(artifact.release_heads, heads);
  });
}

function validateEvidenceRefs(refs, checkId, inventory, evidenceStore, errors, prefix) {
  if (!Array.isArray(refs)) {
    push(errors, prefix + '_REFS');
    return false;
  }
  if (refs.length === 0) {
    push(errors, prefix + '_MISSING');
    return false;
  }
  if (!evidenceStore?.ok) {
    push(errors, prefix + '_STORE_INVALID');
    return false;
  }

  const heads = releaseHeads(inventory);
  let ok = true;
  for (const [index, ref] of refs.entries()) {
    if (typeof ref !== 'string' || !SHA256_REF.test(ref)) {
      push(errors, prefix + '_REF_INVALID', { index });
      ok = false;
      continue;
    }
    const entry = evidenceStore.entries.get(ref);
    if (!entry) {
      push(errors, prefix + '_NOT_FOUND', { ref });
      ok = false;
      continue;
    }
    const artifact = entry.artifact;
    if (artifact.check_id !== checkId) {
      push(errors, prefix + '_CHECK_MISMATCH', { ref, expected: checkId, actual: artifact.check_id });
      ok = false;
    }
    if (artifact.outcome !== 'PASS') {
      push(errors, prefix + '_OUTCOME', { ref, actual: artifact.outcome ?? null });
      ok = false;
    }
    if (!sameHeads(artifact.release_heads, heads)) {
      push(errors, prefix + '_CONTEXT_MISMATCH', { ref, expected: heads, actual: artifact.release_heads ?? null });
      ok = false;
    }
  }
  return ok;
}

export function parseExpectedFencingToken(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) return null;
  let value;
  try {
    value = BigInt(raw);
  } catch {
    return null;
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

export function loadActivationLease(
  leasePath,
  authority,
  inventory,
  nowMs = Date.now(),
  expectedFencingToken = null,
  expectedClaimId = null,
) {
  const errors = [];
  if (!leasePath) return { ok: false, absent: true, errors: [{ code: 'DEFAULT_ACTIVATION_LEASE_REQUIRED' }], lease: null };

  const file = path.resolve(leasePath);
  let lease;
  try {
    lease = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    push(errors, 'DEFAULT_ACTIVATION_LEASE_UNREADABLE', { message: String(error?.message ?? error) });
    return { ok: false, absent: false, errors, lease: null, path: file };
  }

  if (lease?.schema !== ACTIVATION_LEASE_SCHEMA) push(errors, 'DEFAULT_ACTIVATION_LEASE_SCHEMA');
  if (lease?.state !== 'ACTIVE') push(errors, 'DEFAULT_ACTIVATION_LEASE_STATE');
  if (lease?.track !== 'T00-DEFAULT-ACTIVATION') push(errors, 'DEFAULT_ACTIVATION_LEASE_TRACK');
  if (lease?.scope !== 'default-activation') push(errors, 'DEFAULT_ACTIVATION_LEASE_SCOPE');
  if (lease?.repo !== 'popixoxipop-collab/backend-skeleton') push(errors, 'DEFAULT_ACTIVATION_LEASE_REPO');
  if (typeof lease?.claim_id !== 'string' || !/^T00-DEFAULT-ACTIVATION-[A-Za-z0-9._-]+$/.test(lease.claim_id)) push(errors, 'DEFAULT_ACTIVATION_LEASE_CLAIM');
  if (!Number.isSafeInteger(lease?.fencing_token) || lease.fencing_token < 1) push(errors, 'DEFAULT_ACTIVATION_LEASE_FENCE');

  if (!Number.isSafeInteger(expectedFencingToken) || expectedFencingToken < 1) {
    push(errors, 'DEFAULT_ACTIVATION_EXPECTED_FENCE_REQUIRED');
  } else if (lease?.fencing_token !== expectedFencingToken) {
    push(errors, 'DEFAULT_ACTIVATION_LEASE_FENCE_MISMATCH', {
      expected: expectedFencingToken,
      actual: lease?.fencing_token ?? null,
    });
  }

  if (typeof expectedClaimId !== 'string' || !/^T00-DEFAULT-ACTIVATION-[A-Za-z0-9._-]+$/.test(expectedClaimId)) {
    push(errors, 'DEFAULT_ACTIVATION_EXPECTED_CLAIM_REQUIRED');
  } else if (lease?.claim_id !== expectedClaimId) {
    push(errors, 'DEFAULT_ACTIVATION_LEASE_CLAIM_MISMATCH', {
      expected: expectedClaimId,
      actual: lease?.claim_id ?? null,
    });
  }

  if (!sameHeads(lease?.release_heads, releaseHeads(inventory))) push(errors, 'DEFAULT_ACTIVATION_LEASE_HEADS');

  const issued = Date.parse(lease?.issued_at ?? '');
  const expires = Date.parse(lease?.expires_at ?? '');
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) push(errors, 'DEFAULT_ACTIVATION_LEASE_TIME');
  if (Number.isFinite(issued) && issued > nowMs) push(errors, 'DEFAULT_ACTIVATION_LEASE_NOT_YET_VALID');
  if (Number.isFinite(expires) && expires <= nowMs) push(errors, 'DEFAULT_ACTIVATION_LEASE_EXPIRED');

  verifySignedObject(lease, authority, ACTIVATION_ATTESTATION_SCHEMA, errors, 'DEFAULT_ACTIVATION_LEASE');

  return { ok: errors.length === 0, absent: false, errors, lease, path: file };
}

export function observedBlockers(inventory) {
  const blockers = new Set();
  const baseline = inventory?.coordination_baseline ?? {};
  if (baseline.accepted !== true || baseline.state !== 'ACCEPTED') blockers.add('BASELINE_NOT_ACCEPTED');

  for (const repo of inventory?.repositories ?? []) {
    if (baseline?.repositories?.[repo.role] !== repo.head_sha) blockers.add('COORDINATION_BASELINE_DRIFT');
    const v = repo.verification ?? {};
    if (v.status !== 'completed' || v.conclusion !== 'success' || !SHA40.test(v.reviewed_head_sha ?? '') || !SHA40.test(v.ci_head_sha ?? '')) {
      blockers.add('CURRENT_MAIN_CI_NOT_GREEN');
      continue;
    }
    if (v.mode === 'zero-delta-merge-tree-equivalence') {
      if (v.ahead_by !== 1 || v.behind_by !== 0 || v.file_delta_count !== 0 || v.ci_head_sha !== v.reviewed_head_sha) blockers.add('MAIN_TREE_NOT_EQUIVALENT');
    }
    if (v.direct_main_ci !== true || v.ci_head_sha !== repo.head_sha) blockers.add('FINAL_MAIN_PUSH_CI_NOT_DIRECT');
  }

  const evidence = inventory?.promotion_evidence;
  for (const [key, blocker] of REQUIRED_PROMOTION_EVIDENCE) {
    const item = evidence?.[key];
    if (!item || item.required_state !== 'ACCEPTED' || item.observed_state !== 'ACCEPTED') blockers.add(blocker);
  }
  return [...blockers].sort();
}

export function releasePlanBlockers(plan, inventory = null, evidenceStore = null, activationLease = null) {
  const blockers = new Set();
  const rehearsal = plan?.release_rehearsal ?? {};

  if (
    rehearsal.observed_state !== 'PASS'
    || rehearsal.required_state !== 'PASS'
    || !inventory
    || !evidenceRefsResolve(rehearsal.evidence_refs, 'rollback rehearsal without destructive database downgrade', inventory, evidenceStore)
  ) {
    blockers.add('FINAL_RELEASE_REHEARSAL_NOT_RUN');
  }

  const resultMap = new Map(
    Array.isArray(plan?.release_check_results)
      ? plan.release_check_results.map((item) => [item?.id, item])
      : [],
  );
  for (const id of REQUIRED_RELEASE_CHECKS) {
    const item = resultMap.get(id);
    if (
      item?.required_state !== 'PASS'
      || item?.observed_state !== 'PASS'
      || !inventory
      || !evidenceRefsResolve(item?.evidence_refs, id, inventory, evidenceStore)
    ) {
      blockers.add('RELEASE_CHECKS_NOT_COMPLETE');
      break;
    }
  }

  if (plan?.default_activation_allowed === true && activationLease?.ok !== true) {
    blockers.add('DEFAULT_ACTIVATION_LEASE_REQUIRED');
  }

  return [...blockers].sort();
}

export function verifyCompatibilityInventory(inventory) {
  const errors = [];
  if (inventory?.schema !== 'bskel.scale-release-compatibility/2') push(errors, 'INVENTORY_SCHEMA');
  if (inventory?.coordination_baseline?.state !== 'ACCEPTED' || inventory?.coordination_baseline?.accepted !== true) push(errors, 'BASELINE_ACCEPTANCE');
  for (const role of ROLES) if (!SHA40.test(inventory?.coordination_baseline?.repositories?.[role] ?? '')) push(errors, 'BASELINE_SHA', { role });

  const seen = new Set();
  for (const repo of inventory?.repositories ?? []) {
    if (!ROLES.includes(repo.role)) push(errors, 'UNKNOWN_ROLE', { role: repo.role });
    if (seen.has(repo.role)) push(errors, 'DUPLICATE_ROLE', { role: repo.role });
    seen.add(repo.role);

    const expectedIdentity = EXPECTED_ROLE_IDENTITIES.get(repo.role);
    if (expectedIdentity) {
      if (repo.repo !== expectedIdentity.repo) push(errors, 'REPOSITORY_IDENTITY_MISMATCH', { role: repo.role, expected: expectedIdentity.repo, actual: repo.repo ?? null });
      if (repo.package?.name !== expectedIdentity.package) push(errors, 'PACKAGE_IDENTITY_MISMATCH', { role: repo.role, expected: expectedIdentity.package, actual: repo.package?.name ?? null });
    }

    if (repo.default_branch !== 'main') push(errors, 'DEFAULT_BRANCH_DRIFT', { role: repo.role });
    if (!SHA40.test(repo.head_sha ?? '')) push(errors, 'HEAD_SHA', { role: repo.role });
    if (repo.coordination_sha !== inventory?.coordination_baseline?.repositories?.[repo.role]) push(errors, 'COORDINATION_SHA_MISMATCH', { role: repo.role });
    if (repo.package?.pack_test !== 'npm run test:pack') push(errors, 'PACK_TEST_REQUIRED', { role: repo.role });
    if (!SHA40.test(repo.package?.package_json_blob ?? '')) push(errors, 'PACKAGE_JSON_BLOB', { role: repo.role });
    if (!SHA40.test(repo.package?.workflow_blob ?? '')) push(errors, 'WORKFLOW_BLOB', { role: repo.role });

    const v = repo.verification ?? {};
    if (!Number.isInteger(v.ci_run)) push(errors, 'CI_RUN_ID', { role: repo.role });
    if (v.status !== 'completed') push(errors, 'CI_STATUS', { role: repo.role });
    if (v.conclusion !== 'success') push(errors, 'CI_CONCLUSION', { role: repo.role });
    if (!SHA40.test(v.reviewed_head_sha ?? '')) push(errors, 'REVIEWED_HEAD_SHA', { role: repo.role });
    if (!SHA40.test(v.ci_head_sha ?? '')) push(errors, 'CI_HEAD_SHA', { role: repo.role });
    if (v.direct_main_ci === true && v.ci_head_sha !== repo.head_sha) push(errors, 'DIRECT_CI_HEAD_MISMATCH', { role: repo.role });

    if (v.mode === 'zero-delta-merge-tree-equivalence') {
      if (v.ahead_by !== 1 || v.behind_by !== 0 || v.file_delta_count !== 0 || v.ci_head_sha !== v.reviewed_head_sha) {
        push(errors, 'TREE_EQUIVALENCE', { role: repo.role });
      }
    }
  }
  for (const role of ROLES) if (!seen.has(role)) push(errors, 'ROLE_MISSING', { role });

  const promotion = inventory?.promotion_evidence;
  if (!promotion || typeof promotion !== 'object' || Array.isArray(promotion)) push(errors, 'PROMOTION_EVIDENCE_REQUIRED');
  for (const [key] of REQUIRED_PROMOTION_EVIDENCE) {
    const item = promotion?.[key];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      push(errors, 'PROMOTION_EVIDENCE_MISSING', { key });
      continue;
    }
    if (item.required_state !== 'ACCEPTED') push(errors, 'PROMOTION_REQUIRED_STATE', { key, expected: 'ACCEPTED', actual: item.required_state ?? null });
  }

  const inv = inventory?.invariants ?? {};
  if (inv.legacy_http_identity_authoritative !== true) push(errors, 'LEGACY_IDENTITY_AUTHORITY');
  if (inv.next_identity_additive !== true) push(errors, 'NEXT_IDENTITY_NOT_ADDITIVE');
  if (inv.default_writer_changed !== false) push(errors, 'PREMATURE_DEFAULT_WRITER');
  if (inv.production_registry_changed !== false) push(errors, 'PREMATURE_REGISTRY_CHANGE');
  if (inv.release_performed !== false) push(errors, 'PREMATURE_RELEASE_OBSERVATION');

  return { ok: errors.length === 0, errors, observed_blockers: observedBlockers(inventory) };
}

function verifyPrerequisites(plan, errors) {
  const items = plan?.prerequisites;
  if (!Array.isArray(items)) {
    push(errors, 'PREREQUISITES_REQUIRED');
    return false;
  }

  const seen = new Set();
  let allAccepted = true;
  for (const item of items) {
    if (!REQUIRED_PREREQUISITES.has(item?.id)) {
      push(errors, 'UNEXPECTED_PREREQUISITE', { id: item?.id ?? null });
      allAccepted = false;
      continue;
    }
    if (seen.has(item.id)) {
      push(errors, 'DUPLICATE_PREREQUISITE', { id: item.id });
      allAccepted = false;
      continue;
    }
    seen.add(item.id);

    const requiredState = REQUIRED_PREREQUISITES.get(item.id);
    if (item.required_state !== requiredState) {
      push(errors, 'PREREQUISITE_REQUIRED_STATE', { id: item.id, expected: requiredState, actual: item.required_state ?? null });
      allAccepted = false;
    }
    if (item.observed_state !== requiredState) allAccepted = false;
  }

  for (const [id, requiredState] of REQUIRED_PREREQUISITES) {
    if (!seen.has(id)) {
      push(errors, 'PREREQUISITE_MISSING', { id, required_state: requiredState });
      allAccepted = false;
    }
  }

  return allAccepted;
}

function verifyMigrationStages(plan, errors) {
  const actual = plan?.migration_stages;
  if (!Array.isArray(actual)) {
    push(errors, 'MIGRATION_STAGES_REQUIRED');
    return;
  }
  if (actual.length !== EXPECTED_STAGES.length) {
    push(errors, 'MIGRATION_ORDER', { expected_count: EXPECTED_STAGES.length, actual_count: actual.length });
  }

  for (let index = 0; index < EXPECTED_STAGES.length; index += 1) {
    const expected = EXPECTED_STAGES[index];
    const item = actual[index];
    if (item?.id !== expected.id) {
      push(errors, 'MIGRATION_ORDER', { index, expected: expected.id, actual: item?.id ?? null });
      continue;
    }
    for (const field of ['writer_mode', 'consumer_mode', 'promotion', 'rollback']) {
      if (item[field] !== expected[field]) {
        push(errors, 'MIGRATION_STAGE_SEMANTICS', { id: expected.id, field, expected: expected[field], actual: item[field] ?? null });
      }
    }
  }
}

export function verifyReleasePlan(plan, inventory, evidenceStore = null, activationLease = null) {
  const errors = [];

  if (plan?.schema !== 'bskel.scale-release-plan/2') push(errors, 'RELEASE_PLAN_SCHEMA');
  if (plan?.owner_track !== 'T23') push(errors, 'OWNER_TRACK');

  if (plan?.release_allowed === true) {
    const expectedStatus = plan?.default_activation_allowed === true ? 'READY_FOR_DEFAULT_ACTIVATION' : 'READY_FOR_RELEASE';
    if (plan?.status !== expectedStatus) {
      push(errors, 'RELEASE_STATUS_CONTRADICTION', { expected: expectedStatus, actual: plan?.status ?? null });
    }
  }

  const repos = repoMap(inventory);
  for (const role of ROLES) {
    if (plan?.coordination_baseline?.[role] !== inventory?.coordination_baseline?.repositories?.[role]) push(errors, 'PLAN_BASELINE_STALE', { role });
    if (plan?.observed_current_main?.[role] !== repos.get(role)?.head_sha) push(errors, 'PLAN_MAIN_STALE', { role });
  }

  verifyMigrationStages(plan, errors);

  const rollback = plan?.rollback_policy ?? {};
  if (rollback.destructive_down_migration_allowed !== false) push(errors, 'DESTRUCTIVE_DOWN_MIGRATION');
  if (rollback.delete_historical_evidence_allowed !== false) push(errors, 'HISTORICAL_EVIDENCE_DELETE');
  if (rollback.old_binary_and_old_artifacts_must_remain_readable !== true) push(errors, 'OLD_READABILITY_REQUIRED');
  if (rollback.old_writer_may_overwrite_next_artifacts !== false) push(errors, 'OLD_WRITER_OVERWRITE');
  if (rollback.new_data_namespace_must_be_isolated_until_default_cutover !== true) push(errors, 'NEW_DATA_ISOLATION');
  if (rollback.cache_namespace_or_revision_must_change_on_semantic_revision !== true) push(errors, 'CACHE_REVISION_ISOLATION');

  const allAccepted = verifyPrerequisites(plan, errors);
  if (evidenceStore && !evidenceStore.ok) push(errors, 'EVIDENCE_STORE_INVALID', { count: evidenceStore.errors.length });

  const dynamic = [...observedBlockers(inventory), ...releasePlanBlockers(plan, inventory, evidenceStore, activationLease)];
  const declared = new Set(plan?.blockers ?? []);
  for (const code of dynamic) {
    if (!declared.has(code)) push(errors, 'OBSERVED_BLOCKER_NOT_DECLARED', { blocker: code });
  }

  if (plan.release_allowed === true && (!allAccepted || declared.size > 0 || dynamic.length > 0)) {
    push(errors, 'PREMATURE_RELEASE');
  }

  if (plan.default_activation_allowed === true) {
    if (plan.release_allowed !== true) push(errors, 'PREMATURE_DEFAULT_ACTIVATION');
    if (activationLease?.ok !== true) push(errors, 'DEFAULT_ACTIVATION_LEASE_REQUIRED');
  }

  const checkList = plan?.required_release_checks;
  const checks = new Set(Array.isArray(checkList) ? checkList : []);
  if (!Array.isArray(checkList)) push(errors, 'REQUIRED_RELEASE_CHECKS_REQUIRED');
  if (checks.size !== REQUIRED_RELEASE_CHECKS.length) push(errors, 'REQUIRED_RELEASE_CHECK_SET');
  for (const required of REQUIRED_RELEASE_CHECKS) {
    if (!checks.has(required)) push(errors, 'REQUIRED_RELEASE_CHECK_MISSING', { check: required });
  }

  const resultItems = plan?.release_check_results;
  if (!Array.isArray(resultItems)) {
    push(errors, 'RELEASE_CHECK_RESULTS_REQUIRED');
  } else {
    const seenResults = new Set();
    for (const item of resultItems) {
      if (!REQUIRED_RELEASE_CHECKS.includes(item?.id)) {
        push(errors, 'UNEXPECTED_RELEASE_CHECK_RESULT', { id: item?.id ?? null });
        continue;
      }
      if (seenResults.has(item.id)) {
        push(errors, 'DUPLICATE_RELEASE_CHECK_RESULT', { id: item.id });
        continue;
      }
      seenResults.add(item.id);

      if (item.required_state !== 'PASS') {
        push(errors, 'RELEASE_CHECK_REQUIRED_STATE', { id: item.id, expected: 'PASS', actual: item.required_state ?? null });
      }
      if (!['PASS', 'NOT_RUN', 'FAIL', 'BLOCKED'].includes(item.observed_state)) {
        push(errors, 'RELEASE_CHECK_OBSERVED_STATE', { id: item.id, actual: item.observed_state ?? null });
      }

      const refs = item.evidence_refs;
      if (!Array.isArray(refs)) {
        push(errors, 'RELEASE_CHECK_EVIDENCE_REFS', { id: item.id });
      } else {
        for (const [index, ref] of refs.entries()) {
          if (typeof ref !== 'string' || !SHA256_REF.test(ref)) {
            push(errors, 'RELEASE_CHECK_EVIDENCE_REF_INVALID', { id: item.id, index });
          }
        }
        if (item.observed_state === 'PASS') {
          if (refs.length === 0) push(errors, 'RELEASE_CHECK_PASS_WITHOUT_EVIDENCE', { id: item.id });
          else validateEvidenceRefs(refs, item.id, inventory, evidenceStore, errors, 'RELEASE_CHECK_EVIDENCE');
        }
      }
    }
    for (const required of REQUIRED_RELEASE_CHECKS) {
      if (!seenResults.has(required)) push(errors, 'RELEASE_CHECK_RESULT_MISSING', { id: required });
    }
  }

  const rehearsal = plan?.release_rehearsal ?? {};
  if (rehearsal.required_state !== 'PASS') push(errors, 'REHEARSAL_REQUIRED_STATE');
  const rehearsalRefs = rehearsal.evidence_refs;

  if (!Array.isArray(rehearsalRefs)) {
    push(errors, 'REHEARSAL_EVIDENCE_REFS');
  } else {
    for (const [index, ref] of rehearsalRefs.entries()) {
      if (typeof ref !== 'string' || !SHA256_REF.test(ref)) push(errors, 'REHEARSAL_EVIDENCE_REF_INVALID', { index });
    }
    if (rehearsal.observed_state === 'PASS') {
      if (rehearsalRefs.length === 0) push(errors, 'REHEARSAL_PASS_WITHOUT_EVIDENCE');
      else validateEvidenceRefs(
        rehearsalRefs,
        'rollback rehearsal without destructive database downgrade',
        inventory,
        evidenceStore,
        errors,
        'REHEARSAL_EVIDENCE',
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

export function verifyAll(inventory, plan, evidenceStore = null, activationLease = null) {
  const inventoryResult = verifyCompatibilityInventory(inventory);
  const planResult = verifyReleasePlan(plan, inventory, evidenceStore, activationLease);
  return {
    ok: inventoryResult.ok && planResult.ok,
    inventory: inventoryResult,
    release_plan: planResult,
  };
}

function main() {
  const [
    command,
    inventoryPath,
    planPath,
    evidenceManifestPath,
    authorityPath,
    expectedAuthorityRef,
    activationLeasePath,
    expectedActivationFencingTokenRaw,
    expectedActivationClaimId,
  ] = process.argv.slice(2);

  if (command !== 'verify' || !inventoryPath || !planPath || !evidenceManifestPath) {
    console.error(
      'usage: node release-policy.mjs verify <compatibility-inventory.json> <release-plan.json> <evidence-manifest.json> [authority.json expected-authority-ref [activation-lease.json expected-fencing-token expected-claim-id]]',
    );
    process.exit(1);
  }

  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

  const authority = loadEvidenceAuthority(authorityPath, expectedAuthorityRef);
  const evidenceStore = loadEvidenceStore(evidenceManifestPath, authority.ok ? authority : null);
  const expectedActivationFencingToken = parseExpectedFencingToken(expectedActivationFencingTokenRaw);
  const activationLease = activationLeasePath
    ? loadActivationLease(
      activationLeasePath,
      authority.ok ? authority : null,
      inventory,
      Date.now(),
      expectedActivationFencingToken,
      expectedActivationClaimId ?? null,
    )
    : { ok: false, absent: true, errors: [{ code: 'DEFAULT_ACTIVATION_LEASE_REQUIRED' }], lease: null };

  const result = verifyAll(inventory, plan, evidenceStore, activationLease);
  process.stdout.write(JSON.stringify({
    ...result,
    evidence_authority: {
      ok: authority.ok,
      absent: authority.absent,
      ref: authority.ref,
      errors: authority.errors,
    },
    evidence_store: {
      ok: evidenceStore.ok,
      errors: evidenceStore.errors,
      resolved_entries: evidenceStore.entries.size,
    },
    activation_lease: {
      ok: activationLease.ok,
      absent: activationLease.absent,
      errors: activationLease.errors,
    },
  }, null, 2) + '\n');

  process.exit(result.ok ? 0 : 2);
}

if (import.meta.url === 'file://' + process.argv[1]) main();
