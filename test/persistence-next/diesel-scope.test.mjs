import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { persistenceTargetById } from '../../scanners/persistence-next/catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scope = JSON.parse(fs.readFileSync(path.join(root, 'adapters/persistence/diesel/TARGET_SCOPE.json'), 'utf8'));
const fixtureRoot = 'adapters/persistence/diesel/fixtures';
const fixturePaths = [
  'Cargo.toml', 'rust-toolchain.toml', 'normal/schema.rs', 'normal/models.rs',
  'counterexamples/physical-name/schema.rs', 'counterexamples/composite-key/schema.rs',
  'counterexamples/tenant-search-path/connection.rs'
];
const sourcePaths = [
  'diesel/Cargo.toml', 'diesel/src/macros/mod.rs', 'diesel_derives/src/table.rs',
  'diesel_derives/src/model.rs', 'diesel_derives/src/identifiable.rs',
  'diesel_derives/src/associations.rs'
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureText = rel => fs.readFileSync(path.join(root, fixtureRoot, rel), 'utf8');

function validate(record) {
  assert.equal(record.schema, 'sbf.persistence-target-scope/1');
  assert.equal(record.task, 'ORM-diesel-01');
  assert.equal(record.track, 'T10');
  assert.equal(record.target, 'diesel');
  assert.equal(record.status, 'scope-only');
  assert.equal(record.catalog_state, 'blocked-upstream-facts');
  assert.deepEqual(record.change_request, {
    id: 'CR-T10-004', owner_requested: 'T08', status: 'requested-not-delivered'
  });
  assert.deepEqual(record.claims, {
    t08_facts_delivered: false, rust_compiled: false, new_adapter_implemented: false,
    runtime_tested: false, supported: false, certified: false
  });
  assert.equal(record.upstream_pin.repository, 'diesel-rs/diesel');
  assert.equal(record.upstream_pin.version, '2.3.14');
  assert.equal(record.upstream_pin.tag, 'v2.3.14');
  assert.equal(record.upstream_pin.tag_object, 'af754893304faaf7ae7cf094df0930d3807e2897');
  assert.equal(record.upstream_pin.commit, '4007d771b1e808839f771a693f6bae9f821f0e64');
  assert.equal(record.upstream_pin.rust_minimum_version, '1.86.0');
  assert.deepEqual(record.upstream_pin.sources.map(s => s.path), sourcePaths);
  assert.ok(record.upstream_pin.sources.every(s => /^[a-f0-9]{64}$/.test(s.sha256)));
  assert.equal(record.fixture_root, fixtureRoot);
  assert.deepEqual(record.fixtures.map(f => f.path), fixturePaths);
  assert.deepEqual(record.fixtures.map(f => f.role), [
    'dependency-pin', 'toolchain-pin', 'normal', 'normal',
    'counterexample', 'counterexample', 'counterexample'
  ]);
  for (const fixture of record.fixtures) {
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/);
    const base = path.resolve(root, record.fixture_root);
    const file = path.resolve(base, fixture.path);
    assert.ok(file.startsWith(`${base}${path.sep}`));
    assert.equal(sha256(fs.readFileSync(file)), fixture.sha256, `${fixture.path} changed`);
  }
  assert.deepEqual(record.constructs.map(c => c.id), [
    'table-column-key-and-joinable', 'physical-sql-name',
    'composite-key', 'tenant-search-path'
  ]);
  assert.ok(record.constructs.every(c => c.status !== 'supported'));
  assert.equal(record.runtime_oracle_plan.not_executed_in_this_scope, true);
  assert.deepEqual(record.runtime_oracle_plan.promotion_dependencies, [
    'CR-T10-004', 'ORM-diesel-02', 'ORM-diesel-03', 'T01', 'T16', 'T19', 'T20', 'T00'
  ]);
  assert.equal(persistenceTargetById('diesel')?.state, 'blocked-upstream-facts');
  assert.equal(persistenceTargetById('diesel')?.ingestion, 'persistence-source-facts');
  assert.equal(fs.existsSync(path.join(root, 'adapters/persistence/diesel/provider.mjs')), false);
  assert.match(fs.readFileSync(path.join(root, 'scanners/persistence-next/CHANGE_REQUESTS.md'), 'utf8'),
    /CR-T10-004 — T08 Rust\/Diesel persistence semantic and compiler facts/);
}

test('Diesel target-01 pins exact scope, fixtures, counterexamples and blocked catalog', () => {
  validate(scope);
  assert.match(fixtureText('Cargo.toml'), /version = "=2\.3\.14"/);
  assert.match(fixtureText('rust-toolchain.toml'), /channel = "1\.86\.0"/);
  assert.match(fixtureText('normal/schema.rs'), /joinable!\(invoices -> accounts \(account_id\)\)/);
  assert.match(fixtureText('normal/models.rs'), /belongs_to\(Account, foreign_key = account_id\)/);
  assert.match(fixtureText('counterexamples/physical-name/schema.rs'), /sql_name = "WidgetParts"/);
  assert.match(fixtureText('counterexamples/composite-key/schema.rs'), /primary_key\(tenant_id, invoice_id\)/);
  assert.match(fixtureText('counterexamples/tenant-search-path/connection.rs'), /SET search_path TO tenant_b/);
  assert.ok(scope.runtime_oracle_plan.steps.some(s => s.includes('T08 compile')));
});

test('Diesel target-01 rejects fixture, upstream and authority tampering', () => {
  const changed = () => structuredClone(scope);
  const fixture = changed();
  fixture.fixtures[4].sha256 = '0'.repeat(64);
  assert.throws(() => validate(fixture));
  const upstream = changed();
  upstream.upstream_pin.commit = '0'.repeat(40);
  assert.throws(() => validate(upstream));
  const claim = changed();
  claim.claims.t08_facts_delivered = true;
  assert.throws(() => validate(claim));
  const catalog = changed();
  catalog.catalog_state = 'implemented-draft';
  assert.throws(() => validate(catalog));
});
