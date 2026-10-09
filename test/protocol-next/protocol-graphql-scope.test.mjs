import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTarget, runCase } from './_target-helpers.mjs';
import { mustScan, registerOracleTests, registerReplayTests } from './_target-test-kit.mjs';

const { scope, fixtures, oracle } = loadTarget('graphql');
const byId = new Map(fixtures.cases.map((fixture) => [fixture.id, fixture]));

registerReplayTests('graphql');
registerOracleTests('graphql');

function keysDeep(value, found = new Set()) {
  if (Array.isArray(value)) for (const item of value) keysDeep(item, found);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { found.add(key); keysDeep(child, found); }
  return found;
}

test('graphql spec edition is pinned as a reference and stays unknown for the importer', () => {
  assert.match(scope.profile.versions.importer_spec_edition, /^UNKNOWN/);
  assert.deepEqual(scope.profile.versions.reference_editions, ['October2021', 'September2025']);
  const editions = scope.pins.documents.filter((document) => document.kind === 'graphql-spec');
  assert.deepEqual(editions.map((document) => document.edition).sort(), ['October2021', 'September2025']);
  for (const edition of editions) {
    assert.equal(edition.repo, 'https://github.com/graphql/graphql-spec');
    assert.match(edition.commit, /^[0-9a-f]{40}$/);
    assert.match(edition.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(editions.find((edition) => edition.edition === 'October2021').one_of_mentions, 0);
  assert.ok(editions.find((edition) => edition.edition === 'September2025').one_of_mentions > 0);
  for (const fixture of fixtures.cases) {
    const outcome = runCase('graphql', fixture);
    if (!outcome.ok) continue;
    assert.doesNotMatch(outcome.scan.dialect, /October|September|202\d/, fixture.id + ' dialect names no edition');
    assert.ok(outcome.scan.warnings.every((warning) => !/EDITION|SPEC_VERSION/.test(warning.code)), fixture.id + ' raises no edition warning');
  }
  const oneOf = mustScan('graphql', byId.get('gql-c11-oneof-input-edition-dependent'));
  assert.ok(byId.get('gql-c11-oneof-input-edition-dependent').input.text.includes('@oneOf'), 'the fixture uses the edition dependent directive');
  assert.equal(JSON.stringify(oneOf).includes('oneOf'), false, 'the directive is accepted and ignored like any other directive');
});

test('graphql federation, directive and resolver semantics are not recorded', () => {
  const sdlCases = fixtures.cases.filter((fixture) => fixture.input.file !== undefined && /\.(graphql|gql|graphqls)$/.test(fixture.input.file) && fixture.expect.outcome === 'scan');
  assert.ok(sdlCases.length >= 10);
  for (const fixture of sdlCases) {
    const found = keysDeep(mustScan('graphql', fixture));
    for (const key of ['directives', 'directive', 'federation', 'resolvers', 'implements', 'members']) assert.equal(found.has(key), false, fixture.id + ' has no ' + key + ' key');
  }
  const federation = byId.get('gql-c01-federation-subgraph');
  assert.ok(/@key\(/.test(federation.input.text), 'the federation fixture really declares an entity key');
  const resolver = fixtures.cases.find((fixture) => fixture.claim_ids.includes('U-GQL-RESOLVERS'));
  assert.equal(resolver.expect.outcome, 'error');
  assert.equal(runCase('graphql', resolver).ok, false);
  assert.ok(scope.unsupported.some((claim) => claim.id === 'U-GQL-FEDERATION' && claim.behavior === 'dropped' || claim.id === 'U-GQL-FEDERATION'));
});

test('graphql static oracle ran on two library versions that agree, and runtime stays blocked', () => {
  const versions = oracle.oracle_packages.flatMap((group) => group.packages.filter((pkg) => pkg.name === 'graphql').map((pkg) => pkg.version)).sort();
  assert.deepEqual(versions, ['16.14.2', '17.0.2']);
  for (const [id, result] of Object.entries(oracle.results)) {
    if (result.oracle.versions) assert.equal(result.oracle.versions_agree, true, id + ' library versions agree');
  }
  assert.equal(scope.runtime_oracle.runtime.status, 'BLOCKED');
  assert.ok(scope.runtime_oracle.oracle.limits.some((limit) => limit.includes('executes no server')));
});
