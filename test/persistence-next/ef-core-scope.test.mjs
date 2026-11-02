import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { persistenceTargetById } from '../../scanners/persistence-next/catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scope = JSON.parse(fs.readFileSync(path.join(root, 'adapters/persistence/ef-core/TARGET_SCOPE.json'), 'utf8'));
const fixtureRoot = 'adapters/persistence/ef-core/fixtures';
const expectedFiles = [
  'Plan.csproj', 'normal/Models.cs', 'counterexamples/fluent-override/Models.cs',
  'counterexamples/composite-key/Models.cs', 'counterexamples/shadow-fk/Models.cs',
  'counterexamples/runtime-schema/Models.cs'
];
const upstreamSources = [
  'src/EFCore/Metadata/Builders/EntityTypeBuilder.cs',
  'src/EFCore.Relational/Extensions/RelationalEntityTypeBuilderExtensions.cs',
  'src/EFCore.Relational/Extensions/RelationalPropertyBuilderExtensions.cs',
  'src/EFCore/Metadata/Builders/ReferenceCollectionBuilder.cs',
  'src/EFCore/Metadata/Conventions/KeyDiscoveryConvention.cs',
  'src/EFCore.Relational/Metadata/Conventions/RelationalTableAttributeConvention.cs'
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureText = (rel) => fs.readFileSync(path.join(root, fixtureRoot, rel), 'utf8');

function validate(record) {
  assert.equal(record.schema, 'sbf.persistence-target-scope/1');
  assert.equal(record.task, 'ORM-ef-core-01');
  assert.equal(record.track, 'T10');
  assert.equal(record.target, 'ef-core');
  assert.equal(record.status, 'scope-only');
  assert.equal(record.catalog_state, 'blocked-upstream-facts');
  assert.deepEqual(record.claims, {
    t08_source_facts_delivered: false,
    adapter_implemented: false,
    runtime_tested: false,
    supported: false,
    certified: false
  });
  assert.equal(record.upstream_pin.repository, 'dotnet/efcore');
  assert.equal(record.upstream_pin.version, '10.0.12');
  assert.equal(record.upstream_pin.tag, 'v10.0.12');
  assert.equal(record.upstream_pin.commit, '001bfac21c1910cdf1110ca256c9ea0a06f374ca');
  assert.deepEqual(record.upstream_pin.sources.map((s) => s.path), upstreamSources);
  assert.ok(record.upstream_pin.sources.every((s) => /^[a-f0-9]{64}$/.test(s.sha256)));
  assert.match(record.upstream_pin.version_boundary, /EF Core 11 preview.*excluded/);
  assert.equal(record.fixture_root, fixtureRoot);
  assert.deepEqual(record.fixtures.map((f) => f.path), expectedFiles);
  assert.deepEqual(record.fixtures.map((f) => f.role),
    ['dependency-pin', 'normal', 'counterexample', 'counterexample', 'counterexample', 'counterexample']);
  for (const fixture of record.fixtures) {
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/);
    const base = path.resolve(root, record.fixture_root);
    const file = path.resolve(base, fixture.path);
    assert.ok(file.startsWith(`${base}${path.sep}`));
    assert.equal(sha256(fs.readFileSync(file)), fixture.sha256, `${fixture.path} changed`);
  }
  assert.match(fixtureText('Plan.csproj'), /Microsoft\.EntityFrameworkCore\.Relational" Version="10\.0\.12"/);
  assert.equal(record.runtime_oracle_plan.not_executed_in_this_scope, true);
  assert.deepEqual(record.runtime_oracle_plan.promotion_dependencies,
    ['CR-T10-002/T08 C# facts', 'ORM-ef-core-02', 'ORM-ef-core-03', 'T01', 'T16', 'T19', 'T20', 'T00']);
  assert.equal(persistenceTargetById('ef-core')?.state, 'blocked-upstream-facts');
  assert.equal(fs.existsSync(path.join(root, 'adapters/persistence/ef-core/provider.mjs')), false);
}

test('EF Core target-01 pins model scope, negative fixtures and future oracle', () => {
  validate(scope);
  assert.deepEqual(scope.constructs.map((c) => c.id),
    ['explicit-table-column-key-and-relation', 'fluent-overrides-annotation',
      'composite-key', 'shadow-foreign-key', 'runtime-schema']);
  assert.ok(scope.constructs.every((c) => c.status !== 'supported'));
  assert.match(fixtureText(expectedFiles[1]), /HasForeignKey\(invoice => invoice\.AccountId\)/);
  assert.match(fixtureText(expectedFiles[2]), /ToTable\("current_accounts"\)/);
  assert.match(fixtureText(expectedFiles[3]), /new \{ item\.TenantId, item\.UserId \}/);
  assert.match(fixtureText(expectedFiles[4]), /HasForeignKey\("PrincipalId"\)/);
  assert.match(fixtureText(expectedFiles[5]), /GetEnvironmentVariable\("TENANT_SCHEMA"\)/);
  assert.ok(scope.runtime_oracle_plan.steps.some((s) => s.includes('DbContext.Model')));
  assert.ok(scope.limits.some((s) => s.includes('blocked-upstream-facts')));
});

test('EF Core target-01 rejects fixture, upstream and authority tampering', () => {
  const changed = () => structuredClone(scope);
  const fixtureTamper = changed();
  fixtureTamper.fixtures[2].sha256 = '0'.repeat(64);
  assert.throws(() => validate(fixtureTamper));
  const upstreamTamper = changed();
  upstreamTamper.upstream_pin.commit = '0'.repeat(40);
  assert.throws(() => validate(upstreamTamper));
  const claimTamper = changed();
  claimTamper.claims.t08_source_facts_delivered = true;
  assert.throws(() => validate(claimTamper));
});
