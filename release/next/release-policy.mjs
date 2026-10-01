#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publicKeyIdFromPublic, verifyPayload } from '../../lib/attest.mjs';
import { createGithubFetchRun, redactSecrets, secretsFromEnv } from './release-policy-github.mjs';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256_REF = /^sha256:[a-f0-9]{64}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ROLES = ['bskel', 'becoder', 'beval'];
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IDENTITY_CONFORMANCE_PATH = 'schemas/next/identity-conformance.json';
const LEGACY_IDENTITY_HASH_KEY = 'bskel_pack_sha256';
const FILE_REF_KEYS = ['kind', 'path', 'sha256'];
const WAIVER_REF_KEYS = ['kind', 'waiver'];
const WAIVER_FIELDS = ['id', 'approved_by', 'approved_on', 'scope', 'reason'];
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
const PROFILE_ADMISSION_CHECK = 'T23 admitted profile evidence';
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

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

  if (id === PROFILE_ADMISSION_CHECK) {
    if (
      verifier.kind !== 't23-profile-admission'
      || verifier.admitted !== true
      || typeof verifier.profile_id !== 'string'
      || !PROFILE_ID_RE.test(verifier.profile_id)
      || !Array.isArray(verifier.source_evidence_refs)
      || verifier.source_evidence_refs.length === 0
      || verifier.source_evidence_refs.some((item) => typeof item !== 'string' || !SHA256_REF.test(item))
    ) {
      push(errors, 'EVIDENCE_PROFILE_ADMISSION_VERIFIER_MISMATCH', { ref });
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
      || !Array.isArray(verifier.profile_ids)
      || verifier.profile_ids.length !== verifier.admitted_profiles
      || verifier.profile_ids.some((item) => typeof item !== 'string' || !PROFILE_ID_RE.test(item))
      || new Set(verifier.profile_ids).size !== verifier.profile_ids.length
      || !Array.isArray(verifier.source_evidence_refs)
      || verifier.source_evidence_refs.length !== verifier.admitted_profiles
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

  // First resolve each signed profile-admission artifact to concrete, non-profile PASS evidence.
  for (const [ref, entry] of [...entries]) {
    const artifact = entry.artifact;
    if (artifact?.check_id !== PROFILE_ADMISSION_CHECK) continue;

    let sourceFailure = false;
    for (const sourceRef of artifact?.verifier?.source_evidence_refs ?? []) {
      if (sourceRef === ref) {
        push(errors, 'EVIDENCE_PROFILE_ADMISSION_SOURCE_SELF_REFERENCE', { ref, source_ref: sourceRef });
        sourceFailure = true;
        continue;
      }
      const source = entries.get(sourceRef);
      if (!source) {
        push(errors, 'EVIDENCE_PROFILE_ADMISSION_SOURCE_NOT_FOUND', { ref, source_ref: sourceRef });
        sourceFailure = true;
        continue;
      }
      if (source.artifact?.outcome !== 'PASS') {
        push(errors, 'EVIDENCE_PROFILE_ADMISSION_SOURCE_NOT_PASS', { ref, source_ref: sourceRef });
        sourceFailure = true;
        continue;
      }
      if (
        source.artifact?.check_id === PROFILE_ADMISSION_CHECK
        || source.artifact?.check_id === 'support matrix generated only from admitted evidence-backed profiles'
      ) {
        push(errors, 'EVIDENCE_PROFILE_ADMISSION_SOURCE_RECURSIVE', { ref, source_ref: sourceRef });
        sourceFailure = true;
        continue;
      }
      if (!sameHeads(source.artifact?.release_heads, artifact.release_heads)) {
        push(errors, 'EVIDENCE_PROFILE_ADMISSION_SOURCE_CONTEXT_MISMATCH', { ref, source_ref: sourceRef });
        sourceFailure = true;
      }
    }
    if (sourceFailure) entries.delete(ref);
  }

  // Then admit a support matrix only from one unique, resolved profile-admission artifact per profile ID.
  for (const [ref, entry] of [...entries]) {
    const artifact = entry.artifact;
    if (artifact?.check_id !== 'support matrix generated only from admitted evidence-backed profiles') continue;

    let sourceFailure = false;
    const resolvedProfileIds = [];
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
      if (
        source.artifact?.check_id !== PROFILE_ADMISSION_CHECK
        || source.artifact?.verifier?.kind !== 't23-profile-admission'
        || source.artifact?.verifier?.admitted !== true
        || !PROFILE_ID_RE.test(source.artifact?.verifier?.profile_id ?? '')
      ) {
        push(errors, 'EVIDENCE_SUPPORT_MATRIX_SOURCE_NOT_PROFILE_ADMISSION', { ref, source_ref: sourceRef });
        sourceFailure = true;
        continue;
      }
      if (!sameHeads(source.artifact?.release_heads, artifact.release_heads)) {
        push(errors, 'EVIDENCE_SUPPORT_MATRIX_SOURCE_CONTEXT_MISMATCH', { ref, source_ref: sourceRef });
        sourceFailure = true;
        continue;
      }
      resolvedProfileIds.push(source.artifact.verifier.profile_id);
    }

    const expectedProfileIds = [...(artifact?.verifier?.profile_ids ?? [])].sort();
    const observedProfileIds = [...resolvedProfileIds].sort();
    if (
      resolvedProfileIds.length !== artifact?.verifier?.admitted_profiles
      || new Set(resolvedProfileIds).size !== resolvedProfileIds.length
      || JSON.stringify(observedProfileIds) !== JSON.stringify(expectedProfileIds)
    ) {
      push(errors, 'EVIDENCE_SUPPORT_MATRIX_PROFILE_SET_MISMATCH', {
        ref,
        expected_profile_ids: expectedProfileIds,
        observed_profile_ids: observedProfileIds,
      });
      sourceFailure = true;
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

const nonBlank = (value) => typeof value === 'string' && value.trim() !== '';

function sameKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Evidence paths are repo-relative, '/'-separated and canonical: no absolute form, no '.', '..' or empty segment.
function unsafeRelativePath(candidate) {
  if (candidate.includes('\0') || candidate.includes('\\')) return true;
  if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || /^[A-Za-z]:/.test(candidate)) return true;
  return candidate.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function sha256OfRegularFile(file) {
  // O_NONBLOCK keeps open() from hanging on a FIFO; fstat then refuses anything that is not a regular file.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) return { ok: false, reason: 'unreadable' };
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(65536);
    for (let read = fs.readSync(fd, chunk, 0, chunk.length, null); read > 0; read = fs.readSync(fd, chunk, 0, chunk.length, null)) {
      hash.update(chunk.subarray(0, read));
    }
    return { ok: true, sha256: hash.digest('hex') };
  } finally {
    fs.closeSync(fd);
  }
}

function hashRepoFile(repoRoot, relativePath, cache) {
  if (cache.has(relativePath)) return cache.get(relativePath);
  let outcome;
  try {
    const rootReal = fs.realpathSync.native(repoRoot);
    const real = fs.realpathSync.native(path.join(rootReal, ...relativePath.split('/')));
    const relative = path.relative(rootReal, real);
    outcome = relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      ? { ok: false, reason: 'outside_root' }
      : sha256OfRegularFile(real);
  } catch (error) {
    outcome = { ok: false, reason: 'unreadable', detail: typeof error?.code === 'string' ? error.code : 'error' };
  }
  cache.set(relativePath, outcome);
  return outcome;
}

function checkFileRef(key, ref, accepted, errors, repoRoot, cache) {
  if (!sameKeys(ref, FILE_REF_KEYS) || typeof ref.path !== 'string' || ref.path === '' || typeof ref.sha256 !== 'string') {
    push(errors, 'PROMOTION_EVIDENCE_REF_MALFORMED', { key, detail: 'a file ref is exactly {kind:"file", path, sha256}' });
    return;
  }
  const formatOk = SHA256_HEX.test(ref.sha256);
  if (!formatOk) push(errors, 'PROMOTION_EVIDENCE_REF_SHA256_FORMAT', { key });
  const pathOk = !unsafeRelativePath(ref.path);
  if (!pathOk) push(errors, 'PROMOTION_EVIDENCE_REF_PATH_UNSAFE', { key, path: ref.path });
  if (!accepted || !formatOk || !pathOk) return;

  const hashed = hashRepoFile(repoRoot, ref.path, cache);
  if (!hashed.ok) {
    push(errors, hashed.reason === 'outside_root' ? 'PROMOTION_EVIDENCE_REF_OUTSIDE_ROOT' : 'PROMOTION_EVIDENCE_REF_FILE_UNREADABLE', { key, path: ref.path });
  } else if (hashed.sha256 !== ref.sha256) {
    push(errors, 'PROMOTION_EVIDENCE_REF_SHA256_MISMATCH', { key, path: ref.path, expected: ref.sha256, actual: hashed.sha256 });
  }
}

// Returns the waiver when the ref is a complete one, otherwise null (after recording why).
function checkWaiverRef(key, ref, errors) {
  if (!sameKeys(ref, WAIVER_REF_KEYS) || !plain(ref.waiver) || Object.keys(ref.waiver).some((field) => !WAIVER_FIELDS.includes(field))) {
    push(errors, 'PROMOTION_EVIDENCE_REF_MALFORMED', { key, detail: 'a waiver ref is exactly {kind:"waiver", waiver:{id, approved_by, approved_on, scope, reason}}' });
    return null;
  }
  let complete = true;
  for (const field of WAIVER_FIELDS) {
    const value = ref.waiver[field];
    if (field === 'approved_on' ? !isIsoDate(value) : !nonBlank(value)) {
      push(errors, 'PROMOTION_EVIDENCE_WAIVER_INVALID', { key, field });
      complete = false;
    }
  }
  return complete ? ref.waiver : null;
}

function checkIdentityPin(key, item, errors, repoRoot, cache) {
  const pinned = item.identity_conformance_sha256;
  if (typeof pinned !== 'string' || !SHA256_HEX.test(pinned)) {
    push(errors, 'IDENTITY_CONFORMANCE_SHA256_FORMAT', { key });
    return;
  }
  const hashed = hashRepoFile(repoRoot, IDENTITY_CONFORMANCE_PATH, cache);
  if (!hashed.ok) {
    push(errors, 'IDENTITY_CONFORMANCE_FILE_UNREADABLE', { key, path: IDENTITY_CONFORMANCE_PATH, reason: hashed.reason });
  } else if (hashed.sha256 !== pinned) {
    push(errors, 'IDENTITY_CONFORMANCE_SHA256_MISMATCH', { key, path: IDENTITY_CONFORMANCE_PATH, expected: pinned, actual: hashed.sha256 });
  }
}

// An ACCEPTED promotion_evidence entry only counts when it carries a verified evidence_ref: a file whose bytes hash to the
// pinned sha256, or a complete waiver. Every other entry keeps its blocker. A malformed ref is an error wherever it is.
function evaluatePromotionEvidence(inventory, options) {
  const repoRoot = typeof options?.repoRoot === 'string' && options.repoRoot !== '' ? options.repoRoot : DEFAULT_REPO_ROOT;
  const errors = [];
  const backed = new Set();
  const waived = [];
  const cache = new Map();

  for (const key of REQUIRED_PROMOTION_EVIDENCE.keys()) {
    const item = inventory?.promotion_evidence?.[key];
    if (!plain(item)) continue;
    const before = errors.length;
    const accepted = item.required_state === 'ACCEPTED' && item.observed_state === 'ACCEPTED';
    let waiver = null;

    if (Object.hasOwn(item, LEGACY_IDENTITY_HASH_KEY)) push(errors, 'PROMOTION_EVIDENCE_LEGACY_KEY', { key, field: LEGACY_IDENTITY_HASH_KEY });
    if (Object.hasOwn(item, 'identity_conformance_sha256')) checkIdentityPin(key, item, errors, repoRoot, cache);

    if (!Object.hasOwn(item, 'evidence_ref')) {
      if (accepted) push(errors, 'PROMOTION_EVIDENCE_REF_REQUIRED', { key });
    } else if (!plain(item.evidence_ref)) {
      push(errors, 'PROMOTION_EVIDENCE_REF_MALFORMED', { key, detail: 'evidence_ref must be an object' });
    } else if (item.evidence_ref.kind === 'file') {
      checkFileRef(key, item.evidence_ref, accepted, errors, repoRoot, cache);
    } else if (item.evidence_ref.kind === 'waiver') {
      waiver = checkWaiverRef(key, item.evidence_ref, errors);
    } else {
      push(errors, 'PROMOTION_EVIDENCE_REF_MALFORMED', { key, detail: 'evidence_ref.kind must be "file" or "waiver"' });
    }

    if (accepted && errors.length === before) {
      backed.add(key);
      if (waiver) waived.push({ key, ...Object.fromEntries(WAIVER_FIELDS.map((field) => [field, waiver[field]])) });
    }
  }
  return { errors, backed, waived };
}

export function observedBlockers(inventory, options = {}) {
  return blockersFor(inventory, evaluatePromotionEvidence(inventory, options).backed);
}

function blockersFor(inventory, backedEvidence) {
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
    if (!item || item.required_state !== 'ACCEPTED' || item.observed_state !== 'ACCEPTED' || !backedEvidence.has(key)) blockers.add(blocker);
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

export function verifyCompatibilityInventory(inventory, options = {}) {
  const errors = [];
  if (inventory?.schema !== 'bskel.scale-release-compatibility/3') push(errors, 'INVENTORY_SCHEMA');
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
    if (!Number.isSafeInteger(v.ci_run) || v.ci_run <= 0) push(errors, 'CI_RUN_ID', { role: repo.role });
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
  const evidence = evaluatePromotionEvidence(inventory, options);
  errors.push(...evidence.errors);

  const inv = inventory?.invariants ?? {};
  if (inv.legacy_http_identity_authoritative !== true) push(errors, 'LEGACY_IDENTITY_AUTHORITY');
  if (inv.next_identity_additive !== true) push(errors, 'NEXT_IDENTITY_NOT_ADDITIVE');
  if (inv.default_writer_changed !== false) push(errors, 'PREMATURE_DEFAULT_WRITER');
  if (inv.production_registry_changed !== false) push(errors, 'PREMATURE_REGISTRY_CHANGE');
  if (inv.release_performed !== false) push(errors, 'PREMATURE_RELEASE_OBSERVATION');

  return { ok: errors.length === 0, errors, observed_blockers: blockersFor(inventory, evidence.backed), waived_evidence: evidence.waived };
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

export function verifyReleasePlan(plan, inventory, evidenceStore = null, activationLease = null, options = {}) {
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

  const dynamic = [...observedBlockers(inventory, options), ...releasePlanBlockers(plan, inventory, evidenceStore, activationLease)];
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

export function verifyAll(inventory, plan, evidenceStore = null, activationLease = null, options = {}) {
  const inventoryResult = verifyCompatibilityInventory(inventory, options);
  const planResult = verifyReleasePlan(plan, inventory, evidenceStore, activationLease, options);
  return {
    ok: inventoryResult.ok && planResult.ok,
    inventory: inventoryResult,
    release_plan: planResult,
  };
}

const ONLINE_NOT_FOUND_HINT = 'GitHub answers 404 both for a run that does not exist and for a repository the token cannot see; for a private repository, check with a token that can read its Actions runs.';
const ONLINE_UNAUTHORIZED_HINT = 'The token, or the lack of one, is not allowed to read this repository\'s Actions runs; it needs read access to Actions.';

// JSON-safe rendering of a value that came from the inventory or from GitHub.
function show(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}...` : value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  return `<${Array.isArray(value) ? 'array' : typeof value}>`;
}

function describeError(error) {
  let text;
  try {
    text = error instanceof Error ? error.message : String(error);
  } catch {
    text = 'unprintable error';
  }
  return text.slice(0, 300);
}

function classifyRunReply(role, reply, expected) {
  const found = [];
  if (!plain(reply) || !Number.isInteger(reply.status)) {
    push(found, 'ONLINE_RUN_RESPONSE_INVALID', { role, detail: 'fetchRun must return {status, body}' });
    return found;
  }
  const { status, body } = reply;
  if (status === 200) {
    if (!plain(body)) {
      push(found, 'ONLINE_RUN_RESPONSE_INVALID', { role, status, detail: 'a 200 reply must carry the run as a JSON object' });
      return found;
    }
    const checks = [
      ['id', expected.runId, body.id],
      ['repository.full_name', expected.repo, plain(body.repository) ? body.repository.full_name : undefined],
      ['event', 'push', body.event],
      ['head_branch', 'main', body.head_branch],
      ['head_sha', expected.headSha, body.head_sha],
      ['status', 'completed', body.status],
      ['conclusion', 'success', body.conclusion],
    ];
    for (const [field, want, got] of checks) {
      if (got !== want) push(found, 'ONLINE_RUN_MISMATCH', { role, field, expected: want, actual: show(got) });
    }
  } else if (status === 404 || status === 410) {
    push(found, 'ONLINE_RUN_NOT_FOUND', { role, status, hint: ONLINE_NOT_FOUND_HINT });
  } else if (status === 401 || status === 403) {
    push(found, 'ONLINE_RUN_UNAUTHORIZED', { role, status, hint: ONLINE_UNAUTHORIZED_HINT });
  } else if (status === 429 || (status >= 500 && status <= 599)) {
    push(found, 'ONLINE_RUN_UNREACHABLE', { role, status, detail: 'GitHub is rate limiting or unavailable' });
  } else {
    push(found, 'ONLINE_RUN_RESPONSE_INVALID', { role, status, detail: 'unexpected HTTP status' });
  }
  return found;
}

// Online counterpart of the offline checks: each selected role's pinned CI run must exist on GitHub as a completed,
// successful push to main of exactly the pinned head, in exactly the pinned repository. `fetchRun({repo, runId})` must
// resolve to {status, body}; everything that is not a matching 200 fails closed with a distinct code.
export async function verifyOnline(inventory, options) {
  if (!plain(options) || typeof options.fetchRun !== 'function') throw new TypeError('verifyOnline: options.fetchRun must be a function');
  const requested = options.roles === undefined ? ROLES : options.roles;
  if (!Array.isArray(requested)) throw new TypeError('verifyOnline: options.roles must be an array of role names');
  const { fetchRun } = options;

  const errors = [];
  const runs = [];
  const unknown = [...new Set(requested.filter((role) => !ROLES.includes(role)))];
  for (const role of unknown) push(errors, 'ONLINE_ROLE_UNKNOWN', { role: show(role) });
  const selected = unknown.length > 0 ? [] : ROLES.filter((role) => requested.includes(role));
  if (unknown.length === 0 && selected.length === 0) push(errors, 'ONLINE_NO_ROLES');

  const repositories = Array.isArray(inventory?.repositories) ? inventory.repositories : [];
  for (const role of selected) {
    const pinnedRepo = EXPECTED_ROLE_IDENTITIES.get(role).repo;
    const entry = repositories.findLast((candidate) => candidate?.role === role);
    if (!plain(entry)) {
      push(errors, 'ONLINE_ROLE_MISSING', { role });
      runs.push({ role, repo: null, ci_run: null, ci_head_sha: null, ok: false });
      continue;
    }

    const verification = plain(entry.verification) ? entry.verification : {};
    const summary = { role, repo: show(entry.repo), ci_run: show(verification.ci_run), ci_head_sha: show(verification.ci_head_sha) };
    const problems = [];
    if (entry.repo !== pinnedRepo) push(problems, 'ONLINE_REPOSITORY_NOT_PINNED', { role, expected: pinnedRepo, actual: show(entry.repo) });
    if (!Number.isSafeInteger(verification.ci_run) || verification.ci_run <= 0) push(problems, 'ONLINE_CI_RUN_INVALID', { role, actual: show(verification.ci_run) });
    if (typeof verification.ci_head_sha !== 'string' || !SHA40.test(verification.ci_head_sha)) push(problems, 'ONLINE_CI_HEAD_SHA_INVALID', { role, actual: show(verification.ci_head_sha) });
    if (problems.length > 0) {
      errors.push(...problems);
      runs.push({ ...summary, ok: false });
      continue;
    }

    const before = errors.length;
    let reply;
    try {
      reply = await fetchRun({ repo: pinnedRepo, runId: verification.ci_run });
    } catch (error) {
      push(errors, 'ONLINE_RUN_UNREACHABLE', { role, detail: describeError(error) });
      runs.push({ ...summary, ok: false });
      continue;
    }
    errors.push(...classifyRunReply(role, reply, { repo: pinnedRepo, runId: verification.ci_run, headSha: verification.ci_head_sha }));
    runs.push({ ...summary, ok: errors.length === before });
  }

  return {
    ok: errors.length === 0,
    errors,
    checked_roles: selected,
    not_checked_roles: ROLES.filter((role) => !selected.includes(role)),
    runs,
  };
}

const USAGE = [
  'usage: node release-policy.mjs verify [--online [--online-roles bskel[,becoder,beval]]] <compatibility-inventory.json> <release-plan.json> <evidence-manifest.json> [authority.json expected-authority-ref [activation-lease.json expected-fencing-token expected-claim-id]]',
  '  --online        also check, read-only against the GitHub API, that each selected role\'s pinned CI run is a green push to main of the pinned head',
  '                  (token from GH_TOKEN or GITHUB_TOKEN when set; flags must come directly after "verify")',
  `  --online-roles  comma-separated roles for --online (default: ${ROLES.join(',')}); roles that were not checked are listed in the output`,
].join('\n');

class UsageError extends Error {}

function parseVerifyArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== 'verify') throw new UsageError(command === undefined ? 'missing command' : `unknown command: ${command}`);

  let online = false;
  let rolesText = null;
  let index = 0;
  for (; index < rest.length && typeof rest[index] === 'string' && rest[index].startsWith('--'); index += 1) {
    const flag = rest[index];
    if (flag === '--online') {
      online = true;
    } else if (flag === '--online-roles' || flag.startsWith('--online-roles=')) {
      if (rolesText !== null) throw new UsageError('--online-roles was given more than once');
      if (flag === '--online-roles') {
        index += 1;
        if (index >= rest.length) throw new UsageError('--online-roles needs a value');
        rolesText = rest[index];
      } else {
        rolesText = flag.slice('--online-roles='.length);
      }
    } else {
      throw new UsageError(`unknown option: ${flag}`);
    }
  }

  const positionals = rest.slice(index);
  const stray = positionals.find((token) => typeof token === 'string' && token.startsWith('--'));
  if (stray !== undefined) throw new UsageError(`options must come directly after "verify", before the files: ${stray}`);
  if (!positionals[0] || !positionals[1] || !positionals[2]) throw new UsageError('verify needs an inventory, a release plan and an evidence manifest');

  let roles = ROLES;
  if (rolesText !== null) {
    if (!online) throw new UsageError('--online-roles requires --online');
    const listed = rolesText.split(',');
    const bad = listed.find((role) => !ROLES.includes(role));
    if (bad !== undefined) throw new UsageError(bad === '' ? '--online-roles has an empty entry' : `unknown role in --online-roles: ${bad}`);
    roles = ROLES.filter((role) => listed.includes(role));
  }
  return { online, roles, positionals };
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${describeError(error)}`);
  }
}

function redactDeep(value, secrets) {
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, secrets)]));
  return value;
}

// Exit codes: 0 verified, 2 verification failed, 1 usage or I/O error (nothing on stdout). Reports through its return
// value and the given streams only, so it can be driven in-process with a fake `fetch`, environment and clock.
export async function runCli(argv, { env = process.env, fetchImpl = globalThis.fetch, sleep, stdout = process.stdout, stderr = process.stderr } = {}) {
  const secrets = secretsFromEnv(env);
  try {
    const { online, roles, positionals } = parseVerifyArguments(argv);
    const [
      inventoryPath,
      planPath,
      evidenceManifestPath,
      authorityPath,
      expectedAuthorityRef,
      activationLeasePath,
      expectedActivationFencingTokenRaw,
      expectedActivationClaimId,
    ] = positionals;

    const inventory = readJson(inventoryPath, 'inventory');
    const plan = readJson(planPath, 'release plan');

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

    let onlineSection = { enabled: false, checked_roles: [], not_checked_roles: [...ROLES], runs: [], errors: [] };
    if (online) {
      const fetchRun = createGithubFetchRun({ env, fetchImpl, sleep });
      onlineSection = { enabled: true, ...redactDeep(await verifyOnline(inventory, { roles, fetchRun }), secrets) };
    }

    const ok = result.ok && (!online || onlineSection.ok);
    stdout.write(redactSecrets(JSON.stringify({
      ...result,
      ok,
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
      online: onlineSection,
    }, null, 2), secrets) + '\n');
    return ok ? 0 : 2;
  } catch (error) {
    stderr.write(`${redactSecrets(describeError(error), secrets)}\n${error instanceof UsageError ? `${USAGE}\n` : ''}`);
    return 1;
  }
}

function main() {
  runCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${describeError(error)}\n`);
      process.exitCode = 1;
    },
  );
}

// import.meta.url is percent-encoded and symlink-resolved, so compare it with the resolved argv[1] as a file URL.
function invokedAsScript() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedAsScript()) main();
