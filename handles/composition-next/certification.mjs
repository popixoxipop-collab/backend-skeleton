import { resolveApprovedCombination } from './catalog.mjs';

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

export function requiredEvidenceFor({ providerId, level }) {
  if (!LEVELS.includes(level)) throw new Error(`unknown certification level "${String(level)}"`);
  const required = ['composition-unit', 'package-install'];
  if (level === 'build-tested' || level === 'behavior-tested') {
    const buildEvidence = PROVIDER_BUILD_EVIDENCE[providerId];
    if (!buildEvidence) throw new Error(`no build evidence profile for provider ${providerId}`);
    required.push(buildEvidence);
  }
  if (level === 'behavior-tested') {
    required.push('persistence-conformance', 'runtime-behavior');
  }
  return required;
}

// T14-06: pure, fail-closed certification evaluator. It does not query CI, sign a certificate,
// merge a PR, or convert a preview into an apply permission. The caller must provide immutable
// evidence records already bound to the exact candidate revision. This keeps T10/T16 runtime and
// persistence evidence authoritative instead of letting T14 infer success from provider names.
export function evaluateCompositionCertification({
  providerId,
  persistenceId,
  keyType,
  revision,
  level,
  providerBaselineAudit,
  generationPreview,
  evidence = [],
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
  if (generationPreview?.status !== 'ready') {
    blockers.push({ code: 'generation-preview-not-ready', message: 'generation preview is not ready' });
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

  return {
    schema: 'sbf.handles-composition-certification/0',
    status: blockers.length === 0 ? 'certified' : 'blocked',
    requestedLevel: level,
    certifiedLevel: blockers.length === 0 ? level : null,
    revision,
    combination,
    applyAllowed: false,
    acceptedEvidence,
    blockers,
  };
}
