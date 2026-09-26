import { resolveApprovedCombination } from './catalog.mjs';
import {
  inspectPersistenceHandoff,
  inspectRuntimeBehaviorProjection,
} from './evidence-boundary.mjs';

const LEVELS = Object.freeze(['preview-tested', 'build-tested', 'behavior-tested']);

const PROVIDER_BUILD_EVIDENCE = Object.freeze({
  'java-spring': 'java-integration',
  'python-fastapi': 'python-integration',
  'typescript-express': 'typescript-compile',
});

function evidenceKey(entry) {
  return entry?.kind ?? null;
}

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
  // Preserve the current public evaluator contract for preview/build callers and existing tests.
  // Generic persistence/runtime records remain necessary inputs for behavior-tested, but are never
  // sufficient: typed T10/T16 boundaries below must also validate and the integration lock remains.
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

// T14-06 remains a pure, fail-closed evaluator. It never queries CI, signs a certificate,
// merges a PR, or converts a preview into an apply permission.
//
// Preview/build compatibility is deliberately preserved for existing callers. behavior-tested is
// stricter: an exact profile plus typed, artifact-bound T10 and T16/T19 inputs are required, and
// the current integration lock remains closed until those cross-track handoffs are independently
// accepted. RuntimeBinding existence, build success, or generic/mock records cannot open it.
export function evaluateCompositionCertification({
  providerId,
  persistenceId,
  keyType,
  revision,
  profileId = null,
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
    const matches = evidence.filter((entry) => evidenceKey(entry) === kind);
    if (matches.length === 0) {
      blockers.push({ code: 'missing-evidence', kind, message: `missing required evidence: ${kind}` });
      continue;
    }
    const exact = matches.find((entry) => (
      entry.revision === revision
      && entry.status === 'success'
      && entry.scope?.providerId === providerId
      && entry.scope?.combinationId === combination?.id
    ));
    if (!exact) {
      blockers.push({
        code: 'invalid-evidence',
        kind,
        message: `no successful ${kind} evidence is bound to this exact revision/provider/combination`,
      });
      continue;
    }
    acceptedEvidence.push({
      kind,
      revision: exact.revision,
      source: exact.source ?? null,
      runId: exact.runId ?? null,
      artifactRef: exact.artifactRef ?? null,
    });
  }

  let crossTrackEvidence = null;
  if (level === 'behavior-tested') {
    if (!nonEmptyString(profileId)) {
      blockers.push({ code: 'profile-missing', message: 'behavior-tested requires an exact profile identity' });
    }

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
