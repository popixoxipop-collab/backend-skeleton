import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { persistenceTargetById } from '../../scanners/persistence-next/catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scope = JSON.parse(fs.readFileSync(path.join(root, 'adapters/persistence/jpa-hibernate/TARGET_SCOPE.json'), 'utf8'));
const fixtureRoot = 'adapters/persistence/jpa-hibernate/fixtures';
const fixturePaths = [
  'pom.xml', 'normal/Models.java', 'counterexamples/naming-strategy/NamingStrategy.java',
  'counterexamples/tenant-scope/TenantSessions.java',
  'counterexamples/property-access/PropertyAccessRecord.java',
  'counterexamples/composite-key/CompositeInvoice.java'
];
const upstreamPaths = [
  'hibernate-core/src/main/java/org/hibernate/boot/model/naming/PhysicalNamingStrategy.java',
  'hibernate-core/src/main/java/org/hibernate/boot/model/naming/ImplicitNamingStrategy.java',
  'hibernate-core/src/main/java/org/hibernate/boot/model/naming/PhysicalNamingStrategyStandardImpl.java',
  'hibernate-core/src/main/java/org/hibernate/context/spi/CurrentTenantIdentifierResolver.java',
  'hibernate-core/src/main/java/org/hibernate/engine/jdbc/connections/spi/MultiTenantConnectionProvider.java',
  'hibernate-core/src/main/java/org/hibernate/boot/model/relational/Namespace.java'
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureText = (rel) => fs.readFileSync(path.join(root, fixtureRoot, rel), 'utf8');

function validate(record) {
  assert.equal(record.schema, 'sbf.persistence-target-scope/1');
  assert.equal(record.task, 'ORM-jpa-hibernate-01');
  assert.equal(record.track, 'T10');
  assert.equal(record.target, 'jpa-hibernate');
  assert.equal(record.status, 'scope-only');
  assert.equal(record.catalog_state, 'implemented-draft');
  assert.deepEqual(record.existing_bridge, {
    ingestion: 'legacy-adapter-bridge', producer: 'java-spring',
    requires_live_verification: true,
    boundary: 'Only facts already emitted by the current Spring scanner are bridged. A jpa-hibernate persistence id is not a verified Hibernate physical model.'
  });
  assert.deepEqual(record.claims, {
    new_adapter_implemented: false, naming_strategy_extracted: false,
    tenant_scope_extracted: false, runtime_tested: false, supported: false, certified: false
  });
  assert.equal(record.upstream_pin.repository, 'hibernate/hibernate-orm');
  assert.equal(record.upstream_pin.version, '7.4.15.Final');
  assert.equal(record.upstream_pin.tag, '7.4.15');
  assert.equal(record.upstream_pin.tag_object, '7fd0b166d0f6a53fd0e7c9b3cdb4f05acdeccfdf');
  assert.equal(record.upstream_pin.commit, 'b690b0c9fcd724813b1e7579f8073b536deadb3a');
  assert.deepEqual(record.upstream_pin.sources.map(s => s.path), upstreamPaths);
  assert.ok(record.upstream_pin.sources.every(s => /^[a-f0-9]{64}$/.test(s.sha256)));
  assert.deepEqual(record.upstream_pin.runtime, {
    vendor: 'Eclipse Temurin', version: '21.0.13+9',
    artifact: 'OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.13_9.tar.gz',
    artifact_sha256: 'bf036b35b071bfb2f54f2c0af8ee8d88afa95ee6eb3dce02c0f94cfc2524d04a',
    release: 'https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.13%2B9',
    installed_or_executed: false
  });
  assert.equal(record.upstream_pin.jakarta_persistence, '3.2');
  assert.match(record.upstream_pin.version_boundary, /Hibernate ORM 7\.4\.15\.Final.*excluded/);
  assert.equal(record.fixture_root, fixtureRoot);
  assert.deepEqual(record.fixtures.map(f => f.path), fixturePaths);
  assert.deepEqual(record.fixtures.map(f => f.role),
    ['dependency-pin', 'normal', 'counterexample', 'counterexample', 'counterexample', 'counterexample']);
  for (const fixture of record.fixtures) {
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/);
    const base = path.resolve(root, record.fixture_root);
    const file = path.resolve(base, fixture.path);
    assert.ok(file.startsWith(`${base}${path.sep}`));
    assert.equal(sha256(fs.readFileSync(file)), fixture.sha256, `${fixture.path} changed`);
  }
  assert.equal(record.runtime_oracle_plan.not_executed_in_this_scope, true);
  assert.deepEqual(record.runtime_oracle_plan.promotion_dependencies,
    ['ORM-jpa-hibernate-02', 'ORM-jpa-hibernate-03', 'T01', 'T16', 'T19', 'T20', 'T00']);
  assert.equal(persistenceTargetById('jpa-hibernate')?.state, 'implemented-draft');
  assert.equal(persistenceTargetById('jpa-hibernate')?.ingestion, 'legacy-adapter-bridge');
  assert.equal(fs.existsSync(path.join(root, 'adapters/persistence/jpa-hibernate/provider.mjs')), false);
}

test('JPA/Hibernate target-01 pins exact scope, fixtures, counterexamples and future oracle', () => {
  validate(scope);
  assert.deepEqual(scope.constructs.map(c => c.id), [
    'explicit-table-column-key-and-relation', 'physical-naming-strategy',
    'tenant-scope', 'property-access', 'composite-key'
  ]);
  assert.ok(scope.constructs.every(c => c.status !== 'supported'));
  assert.match(fixtureText('pom.xml'), /hibernate-core<\/artifactId>\s*<version>7\.4\.15\.Final/);
  assert.match(fixtureText('normal/Models.java'), /@Table\(name = "accounts", schema = "billing"\)/);
  assert.match(fixtureText('counterexamples/naming-strategy/NamingStrategy.java'), /toPhysicalTableName/);
  assert.match(fixtureText('counterexamples/tenant-scope/TenantSessions.java'), /tenantIdentifier\(tenant\)/);
  assert.match(fixtureText('counterexamples/property-access/PropertyAccessRecord.java'), /@Id\s*public Long getId/);
  assert.match(fixtureText('counterexamples/composite-key/CompositeInvoice.java'), /@EmbeddedId/);
  assert.ok(scope.runtime_oracle_plan.steps.some(s => s.includes('MultiTenantConnectionProvider')));
  assert.ok(scope.limits.some(s => s.includes('implemented-draft')));
});

test('JPA/Hibernate target-01 rejects fixture, upstream and authority tampering', () => {
  const changed = () => structuredClone(scope);
  const fixture = changed();
  fixture.fixtures[2].sha256 = '0'.repeat(64);
  assert.throws(() => validate(fixture));
  const upstream = changed();
  upstream.upstream_pin.commit = '0'.repeat(40);
  assert.throws(() => validate(upstream));
  const runtime = changed();
  runtime.upstream_pin.runtime.installed_or_executed = true;
  assert.throws(() => validate(runtime));
  const claim = changed();
  claim.claims.supported = true;
  assert.throws(() => validate(claim));
});
