// T14-02: observed non-string id coercion is a limitation, not an approved provider identity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { describeResourceGeneration } from '../../handles/composition-next/safety-profile.mjs';
import { requiredEvidenceFor, evaluateCompositionCertification } from '../../handles/composition-next/certification.mjs';
import { resolveApprovedCombination } from '../../handles/composition-next/catalog.mjs';
import { previewGeneration } from '../../handles/composition-next/plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RFC = path.resolve(here, '../../handles/composition-next/INTERFACE_RFC.md');
const resources = [{ type: 'Post', willGenerateResolver: true, idFieldIsUuid: true }];
const variants = [
  ['single-element array', () => ['java-spring']],
  ['String object', () => new String('java-spring')],
  ['toString object', () => ({ toString: () => 'java-spring' })],
];

test('a non-string provider id is coerced in profile and build-evidence lookups', () => {
  for (const [label, create] of variants) {
    const id = create();
    assert.equal(typeof id, 'object', label);
    const output = describeResourceGeneration({ providerId: id, handlesPlan: { resources } });
    assert.equal(output.decisions.length, 1, label);
    assert.equal(output.decisions[0].authorization, 'provider-policy', label);
    assert.deepEqual(requiredEvidenceFor({ providerId: id, level: 'build-tested' }),
      ['composition-unit', 'package-install', 'java-integration'], label);
  }
});

test('the same non-string ids do not become approved catalog or preview identities', () => {
  const revision = 'a'.repeat(40);
  const namedCombination = { id: 'java-spring+jpa-hibernate+uuid' };
  for (const [label, create] of variants) {
    const id = create();
    assert.equal(resolveApprovedCombination({ providerId: id, persistenceId: 'jpa-hibernate', keyType: 'uuid' }), null, label);
    assert.throws(() => previewGeneration({
      provider: { id, emit: () => ({}) }, repoRoot: '/test/only', featureId: 'fixture', revision,
      handlesPlan: { provider: 'java-spring', resources }, persistenceId: 'jpa-hibernate', keyType: 'uuid',
    }), /provider\.id is required/, label);
    const certification = evaluateCompositionCertification({
      providerId: id, persistenceId: 'jpa-hibernate', keyType: 'uuid',
      revision, level: 'build-tested', providerBaselineAudit: { ok: true, revision },
      generationPreview: { status: 'ready', revision, applyAllowed: false,
        combination: namedCombination, providerId: id }, evidence: [],
    });
    assert.equal(certification.status, 'blocked', label);
    assert.equal(certification.applyAllowed, false, label);
    assert.ok(certification.blockers.some((blocker) => blocker.code === 'unsupported-combination'), label);
  }
});

test('RFC distinguishes observed behavior and bounded absence searches from unsupported global claims', () => {
  const rfc = fs.readFileSync(RFC, 'utf8');
  assert.match(rfc, /two profile lookup helpers do not enforce that type/);
  assert.match(rfc, /a one-element array, a String object or an object whose toString returns that name/);
  assert.match(rfc, /absence remains UNKNOWN rather than proven/);
  assert.match(rfc, /not a proof of absence/);
  assert.match(rfc, /source scan is not exhaustive across quote styles/);
});
