import { resolveApprovedCombination } from './catalog.mjs';
import {
  inspectPersistenceHandoff,
  inspectRuntimeBehaviorProjection,
  validateBoundCertificationEvidence,
} from './evidence-boundary.mjs';

const LEVELS = Object.freeze(['preview-tested', 'build-tested', 'behavior-tested']);

const PROVIDER_BUILD_EVIDENCE = Object.freeze({
  'java-spring': 'java-integration',
  'python-fastapi': 'python-integration',
  'typescript-express': 'typescript-compile',
});

function validRevision(revision) {
  return typeof revision === 'string' && /^[0-9a-f]{40}$/.test(revision);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

export function requiredEvidenceFor({ providerId, level }) {
  if (!LEVELS.includes(level)) throw new Error(`unknown certification level "${String(level)}"`);
  const required = ['composition-unit', 'package-install'];
  if (level === 'build-tested' || level === 'behavior-tested') {
    const buildEvidence = PROVIDER_BUILD_EVIDENCE[providerId];
    if (!buildEvidence) throw new Error(`no build evidence profile for provider ${providerId}`);
    required.push(buildEvidence);
  }
  // Generic persistence/runtime evidence remains a compatibility-visible requirement for
  // behavior-tested, but it is never sufficient. Typed T10 + T16/T19 handoffs below are also
  // mandatory and the integration lock remains fail-closed.
  if (level === 'behavior-tested') {
    required.push('persistence-conformance', 'runtime-behavior');
  }
  return required;
}

function inspectBehaviorInputs({
  combination,
  revision,
  profileId,
  persistenceHandoff,
  runtimeBehavior,
}) {
  const expected = combination ? {
    ...combination,
    candidateRevision: revision,
    profileId,
  } : {
    candidateRevision: revision,
    profileId,
  };

  const persistence = persistenceHandoff
    ? inspectPersistenceHandoff({ expected, ...persistenceHandoff })
    : {
      status: 'blocked',
      blockers: [{ code: 'persistence-handoff-missing', message: 'accepted T10 persistence handoff is missing' }],
    };

  const runtime = runtimeBehavior
    ? inspectRuntimeBehaviorProjection({ expected, ...runtimeBehavior })
    : {
      status: 'blocked',
      blockers: [{ code: 'runtime-handoff-missing', message: 'accepted T16/T19 behavior handoff is missing' }],
    };

  return { persistence, runtime };
}

// Pure, fail-closed certification evaluator. It does not query CI, sign a certificate, merge a PR,
// or convert a preview into an apply permission.
//
// Every certification level now requires exact artifact-bound evidence with revision, provider,
// combination, profile, and execution identity. A plain caller-created success record cannot mint
// preview-tested/build-tested. behavior-tested additionally requires typed T10 persistence and
// T16/T19 runtime evidence, and remains integration-locked until those producer contracts are
// independently accepted for a concrete fixture/profile.
export function evaluateCompositionCertification({
  providerId,
  persistenceId,
  keyType,
  revision,
  profileId,
  level,
  providerBaselineAudit,
  generationPreview,
  evidence = [],
  persistenceHandoff = null,
  runtimeBehavior = null,
}) {
  const blockers = [];
  const combination = resolveApprovedCombination({ providerId, persistenceId, keyType });

  if (!combination) {
    blockers.push({ code: 'unsupported-combination', message: 'combination is not in the approved catalog' });
  }
  if (!validRevision(revision)) {
    blockers.push({ code: 'invalid-revision', message: 'revision must be an exact 40-character lowercase git SHA' });
  }
  if (!nonEmptyString(profileId)) {
    blockers.push({ code: 'profile-missing', message: 'certification requires an exact profile identity' });
  }
  if (providerBaselineAudit?.ok !== true) {
    blockers.push({ code: 'provider-baseline-drift', message: 'legacy provider baseline audit did not pass' });
  }
  if (providerBaselineAudit?.revision !== revision) {
    blockers.push({ code: 'provider-baseline-revision-mismatch', message: 'provider baseline audit is not bound to this exact revision' });
  }
  if (generationPreview?.status !== 'ready') {
    blockers.push({ code: 'generation-preview-not-ready', message: 'generation preview is not ready' });
  }
  if (generationPreview?.revision !== revision) {
    blockers.push({ code: 'generation-preview-revision-mismatch', message: 'generation preview is not bound to this exact revision' });
  }
  if (generationPreview?.applyAllowed !== false) {
    blockers.push({ code: 'unsafe-preview-contract', message: 'certification only accepts observation-only previews with applyAllowed=false' });
  }
  if (combination && generationPreview?.combination?.id !== combination.id) {
    blockers.push({ code: 'preview-combination-mismatch', message: 'generation preview belongs to a different combination' });
  }
  if (generationPreview?.providerId !== providerId) {
    blockers.push({ code: 'preview-provider-mismatch', message: 'generation preview belongs to a different provider' });
  }

  let required = [];
  try {
    required = requiredEvidenceFor({ providerId, level });
  } catch (err) {
    blockers.push({ code: 'unsupported-certification-level', message: err.message });
  }

  const acceptedEvidence = [];
  for (const kind of required) {
    const matches = evidence.filter((entry) => entry?.kind === kind);
    if (matches.length === 0) {
      blockers.push({ code: 'missing-evidence', kind, message: `missing required evidence: ${kind}` });
      continue;
    }
    if (matches.length > 1) {
      blockers.push({ code: 'duplicate-evidence', kind, message: `multiple evidence envelopes claim kind ${kind}` });
      continue;
    }

    const checked = validateBoundCertificationEvidence({
      expectedKind: kind,
      revision,
      providerId,
      combinationId: combination?.id ?? null,
      profileId,
      evidence: matches[0],
    });
    if (!checked.ok) {
      blockers.push({
        code: 'invalid-evidence',
        kind,
        message: `${kind} evidence is not exact-artifact bound`,
        reasons: checked.blockers,
      });
      continue;
    }
    acceptedEvidence.push(checked.accepted);
  }

  let crossTrackEvidence = null;
  if (level === 'behavior-tested') {
    crossTrackEvidence = inspectBehaviorInputs({
      combination,
      revision,
      profileId,
      persistenceHandoff,
      runtimeBehavior,
    });
    if (crossTrackEvidence.persistence.status !== 'eligible') {
      blockers.push({
        code: 'persistence-handoff-invalid',
        message: 'T10 persistence handoff is not certification-eligible',
        reasons: crossTrackEvidence.persistence.blockers,
      });
    }
    if (crossTrackEvidence.runtime.status !== 'eligible') {
      blockers.push({
        code: 'runtime-handoff-invalid',
        message: 'T16/T19 runtime behavior handoff is not certification-eligible',
        reasons: crossTrackEvidence.runtime.blockers,
      });
    }

    // Merged T16 #52 plus its T19 review approve the immutable runtime core only. They explicitly
    // do not approve an HTTP behavior-success handoff. Keep behavior-tested locked until T00/T19
    // accept versioned T10 + T16/T19 producer artifacts for one concrete fixture/profile.
    blockers.push({
      code: 'behavior-handoff-not-integrated',
      message: 'behavior-tested remains unavailable until accepted T10 and T16/T19 verifier-produced behavior handoffs exist for the exact revision/profile/combination',
    });
  }

  return {
    schema: 'sbf.handles-composition-certification/0',
    status: blockers.length === 0 ? 'certified' : 'blocked',
    requestedLevel: level,
    certifiedLevel: blockers.length === 0 ? level : null,
    revision,
    profileId,
    combination,
    applyAllowed: false,
    acceptedEvidence,
    crossTrackEvidence,
    blockers,
  };
}
