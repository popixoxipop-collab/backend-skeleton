const SHA40 = /^[0-9a-f]{40}$/;
const ID = /^[a-z][a-z0-9-]*$/;
const ADAPTER = /^[a-z][a-z0-9-]*$/;
const ALLOWED_SOURCE_KINDS = new Set(['repository-fixture', 'real-repo']);
const ALLOWED_COHORTS = new Set(['development', 'holdout']);
const ALLOWED_GOLDEN = new Set(['manual', 'spec', 'original-runtime', 'pending']);
const ALLOWED_REVIEW = new Set(['pending', 'independent-reviewed']);
const ALLOWED_RUNTIME = new Set(['none', 'optional', 'required']);

export const QA_CORPUS_CONTRACT = 'sbf.qa-corpus/1';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function push(errors, at, message) {
  errors.push(\`\${at}: \${message}\`);
}

function validateEntry(entry, index, errors) {
  const at = \`entries[\${index}]\`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    push(errors, at, 'must be an object');
    return;
  }
  const required = ['id', 'adapter_id', 'cohort', 'source', 'golden', 'runtime', 'selection_reason', 'tags'];
  for (const key of required) if (!Object.hasOwn(entry, key)) push(errors, at, \`missing required field \${key}\`);
  if (!ID.test(entry.id ?? '')) push(errors, \`\${at}.id\`, 'must match ^[a-z][a-z0-9-]*$');
  if (!ADAPTER.test(entry.adapter_id ?? '')) push(errors, \`\${at}.adapter_id\`, 'must be a stable adapter/profile id');
  if (!ALLOWED_COHORTS.has(entry.cohort)) push(errors, \`\${at}.cohort\`, 'must be development or holdout');
  if (!nonEmptyString(entry.selection_reason)) push(errors, \`\${at}.selection_reason\`, 'must explain the independent coverage added');
  if (!Array.isArray(entry.tags) || entry.tags.length === 0 || entry.tags.some((x) => !nonEmptyString(x))) {
    push(errors, \`\${at}.tags\`, 'must be a non-empty array of non-empty strings');
  }

  const source = entry.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    push(errors, \`\${at}.source\`, 'must be an object');
  } else {
    if (!ALLOWED_SOURCE_KINDS.has(source.kind)) push(errors, \`\${at}.source.kind\`, 'must be repository-fixture or real-repo');
    if (!nonEmptyString(source.repository)) push(errors, \`\${at}.source.repository\`, 'must name the repository');
    if (!SHA40.test(source.commit ?? '')) push(errors, \`\${at}.source.commit\`, 'must be an exact 40-hex commit SHA');
    if (!nonEmptyString(source.license)) push(errors, \`\${at}.source.license\`, 'must record a license identifier or reviewed license label');
    if (!nonEmptyString(source.root)) push(errors, \`\${at}.source.root\`, 'must be a repo-relative root (use "." for repository root)');
    if (typeof source.root === 'string' && (source.root.startsWith('/') || source.root.includes('..'))) push(errors, \`\${at}.source.root\`, 'must stay repo-relative and may not contain ..');
    if (source.kind === 'repository-fixture' && !nonEmptyString(source.fixture_path)) push(errors, \`\${at}.source.fixture_path\`, 'is required for repository-fixture');
    if (source.kind === 'real-repo' && !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(source.repository ?? '')) {
      push(errors, \`\${at}.source.repository\`, 'real-repo must use canonical https://github.com/owner/repo form');
    }
  }

  const golden = entry.golden;
  if (!golden || typeof golden !== 'object' || Array.isArray(golden)) {
    push(errors, \`\${at}.golden\`, 'must be an object');
  } else {
    if (!ALLOWED_GOLDEN.has(golden.basis)) push(errors, \`\${at}.golden.basis\`, 'must be manual, spec, original-runtime, or pending');
    if (!ALLOWED_REVIEW.has(golden.review_state)) push(errors, \`\${at}.golden.review_state\`, 'must be pending or independent-reviewed');
    if (!nonEmptyString(golden.authored_by)) push(errors, \`\${at}.golden.authored_by\`, 'must identify who authored the expected result');
    if (golden.review_state === 'independent-reviewed') {
      if (!nonEmptyString(golden.reviewed_by)) push(errors, \`\${at}.golden.reviewed_by\`, 'is required after independent review');
      if (golden.reviewed_by === golden.authored_by) push(errors, \`\${at}.golden.reviewed_by\`, 'must differ from authored_by');
      if (golden.basis === 'pending') push(errors, \`\${at}.golden.basis\`, 'cannot remain pending after independent review');
    }
    if (golden.generated_by_candidate === true) push(errors, \`\${at}.golden.generated_by_candidate\`, 'candidate-generated output cannot be the independent golden');
  }

  const runtime = entry.runtime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    push(errors, \`\${at}.runtime\`, 'must be an object');
  } else {
    if (!ALLOWED_RUNTIME.has(runtime.requirement)) push(errors, \`\${at}.runtime.requirement\`, 'must be none, optional, or required');
    if (runtime.requirement === 'required' && !nonEmptyString(runtime.profile)) push(errors, \`\${at}.runtime.profile\`, 'is required when runtime.requirement=required');
  }

  if (entry.cohort === 'holdout' && golden?.review_state !== 'independent-reviewed') {
    push(errors, \`\${at}.cohort\`, 'holdout entries must have an independently reviewed golden before admission');
  }
}

export function validateCorpusManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, errors: ['(root): must be an object'] };
  if (manifest.contract !== QA_CORPUS_CONTRACT) push(errors, 'contract', \`must equal \${QA_CORPUS_CONTRACT}\`);
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) push(errors, 'entries', 'must be a non-empty array');
  if (Array.isArray(manifest.entries)) {
    manifest.entries.forEach((entry, i) => validateEntry(entry, i, errors));
    const seen = new Set();
    for (const entry of manifest.entries) {
      if (!nonEmptyString(entry?.id)) continue;
      if (seen.has(entry.id)) push(errors, 'entries', \`duplicate corpus id \${entry.id}\`);
      seen.add(entry.id);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function summarizeCorpus(manifest) {
  const verdict = validateCorpusManifest(manifest);
  if (!verdict.ok) throw new Error(\`invalid QA corpus manifest:\n\${verdict.errors.join('\n')}\`);
  const summary = { total: 0, development: 0, holdout: 0, reviewed: 0, pending_review: 0, certification_eligible: 0, adapters: {} };
  for (const entry of manifest.entries) {
    summary.total += 1;
    summary[entry.cohort] += 1;
    if (entry.golden.review_state === 'independent-reviewed') summary.reviewed += 1;
    else summary.pending_review += 1;
    const eligible = entry.golden.review_state === 'independent-reviewed' && entry.golden.basis !== 'pending';
    if (eligible) summary.certification_eligible += 1;
    summary.adapters[entry.adapter_id] = (summary.adapters[entry.adapter_id] ?? 0) + 1;
  }
  return summary;
}
