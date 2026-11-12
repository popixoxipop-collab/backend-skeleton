import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPersistenceIr, makeEntityId } from '../../scanners/persistence-next/ir.mjs';
import * as bindings from '../../scanners/persistence-next/bindings.mjs';
import { certifyPersistenceBindings } from '../../scanners/persistence-next/certification.mjs';
import { parsePrismaSchema } from '../../scanners/persistence-next/providers/prisma.mjs';
import { comparePersistenceIr } from '../../scanners/persistence-next/drift.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(root, 'test/persistence-next/fixtures/versioned');
const snapshot = `sha256:${'a'.repeat(64)}`;
const sha256 = data => createHash('sha256').update(data).digest('hex');

function scenario({ sourceTable = 'users', sourceSchema = 'tenant_a', liveTable = 'users',
  liveSchema = 'tenant_a', liveProvider = 'postgres-introspection',
  liveSnapshot = snapshot, sourceColumns = ['id'], liveColumns = ['id'] } = {}) {
  const source = createPersistenceIr({ provider: 'jpa-hibernate', source_kind: 'source', entities: [{
    provider: 'jpa-hibernate', name: 'User',
    table: { name: sourceTable, schema: sourceSchema, source: 'explicit' },
    primary_key: { columns: sourceColumns, type: sourceColumns.length === 1 ? 'uuid' : 'composite', source: 'source' },
  }] });
  const observed = createPersistenceIr({ provider: liveProvider, source_kind: 'live',
    metadata: { snapshot_ref: liveSnapshot, schema: liveSchema }, entities: [{
      provider: liveProvider, name: liveTable,
      table: { name: liveTable, schema: liveSchema, source: 'observed' },
      primary_key: { columns: liveColumns, type: 'unknown', source: 'live' },
      fields: liveColumns.map(name => ({ name, type: 'uuid', nullable: false, source: 'live' })),
    }] });
  const resources = [{ id: 'user-read', entity_ref: makeEntityId({
    provider: 'jpa-hibernate', className: 'User', table: sourceTable,
  }) }];
  return { source, observed, resources };
}

function check(module, options = {}) {
  const { source, observed, resources } = scenario(options);
  const bound = module.composeResourceBindings({ resources, persistence: source });
  const verified = module.verifyResourceBindingsAgainstObserved({ binding_result: bound, observed,
    expected_live_provider: 'postgres-introspection', expected_live_snapshot_ref: snapshot });
  return { bound, verified };
}

test('normal read is verified, but write permission is absent at binding and certification', () => {
  const { bound, verified } = check(bindings);
  const { source, observed } = scenario();
  assert.deepEqual(comparePersistenceIr({ expected: source, observed }).findings, []);
  assert.equal(bound.bindings[0].capabilities.write, false);
  assert.equal(verified.bindings[0].capabilities.verified_read_by_primary_key, true);
  const polluted = structuredClone(verified);
  polluted.bindings[0].capabilities.write = true;
  polluted.bindings[0].permissions = ['admin', 'write'];
  const cert = certifyPersistenceBindings({ http_provider_id: 'java-spring', binding_result: polluted });
  assert.equal(cert.resources[0].scopes.write, false);
  assert.equal(cert.notes[0], 'T10 certification never grants write behavior.');
});

test('physical naming strategy mismatch cannot verify a logical table as a renamed physical table', () => {
  const { source, observed } = scenario({ liveTable: 'app_users' });
  assert.equal(comparePersistenceIr({ expected: source, observed }).findings[0].code, 'table-missing');
  const { verified } = check(bindings, { liveTable: 'app_users' });
  assert.equal(verified.bindings[0].verification.table, 'missing');
  assert.equal(verified.bindings[0].capabilities.verified_read_by_primary_key, false);
  const cert = certifyPersistenceBindings({ http_provider_id: 'java-spring', binding_result: verified });
  assert.equal(cert.resources[0].status, 'blocked');
  assert.equal(cert.resources[0].scopes.write, false);
});

test('tenant B search path cannot verify a source explicitly scoped to tenant A', () => {
  const { source, observed } = scenario({ liveSchema: 'tenant_b' });
  assert.equal(comparePersistenceIr({ expected: source, observed }).findings[0].code, 'table-missing');
  const { verified } = check(bindings, { liveSchema: 'tenant_b' });
  assert.equal(verified.bindings[0].verification.table, 'missing');
  assert.equal(verified.bindings[0].capabilities.verified_read_by_primary_key, false);
});

test('same-snapshot facts with different provider or snapshot are not authority', () => {
  assert.throws(() => check(bindings, { liveProvider: 'lookalike-introspection' }), /live provider mismatch/);
  assert.throws(() => check(bindings, { liveSnapshot: `sha256:${'b'.repeat(64)}` }), /live snapshot mismatch/);
});

test('Prisma 6.19/7.0 pinned syntax preserves only scoped model facts', () => {
  const pins = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'VERSION_PINS.json'), 'utf8'));
  assert.equal(pins.schema, 'sbf.t10-version-differential-fixtures/1');
  assert.deepEqual(pins.cases.map(item => [item.version, item.tag_object, item.commit]), [
    ['6.19.0', 'f7050711d4b6a261fda50fc0602cb58ecb184817', 'd4ec055ee9e13e62351bf72643fc978b3d315ae3'],
    ['7.0.0', '6843af9e3ab0d03357e064d9c96d579d3c6f6d97', '177882704271b747b3618b0cf6790e46f2432b7a'],
  ]);
  const projections = [];
  for (const item of pins.cases) {
    const bytes = fs.readFileSync(path.join(fixtureRoot, item.schema_path));
    assert.equal(sha256(bytes), item.schema_sha256);
    const ir = parsePrismaSchema(bytes.toString('utf8'), { file: `prisma/${item.version}/schema.prisma` });
    assert.equal(ir.entities.length, 1);
    assert.deepEqual(ir.diagnostics, []);
    projections.push({ table: ir.entities[0].table, key: ir.entities[0].primary_key,
      fields: ir.entities[0].fields.map(field => field.name) });
  }
  assert.deepEqual(projections[0], projections[1]);
  assert.deepEqual(projections[0].table, { name: 'users', schema: null, source: 'explicit' });
  assert.deepEqual(projections[0].key.columns, ['user_id']);
  const v6 = fs.readFileSync(path.join(fixtureRoot, pins.cases[0].schema_path), 'utf8');
  const v7 = fs.readFileSync(path.join(fixtureRoot, pins.cases[1].schema_path), 'utf8');
  const config = fs.readFileSync(path.join(fixtureRoot, pins.cases[1].config_path));
  assert.equal(sha256(config), pins.cases[1].config_sha256);
  assert.match(v6, /url\s*=\s*env\("DATABASE_URL"\)/);
  assert.doesNotMatch(v7, /url\s*=/);
  assert.match(config.toString('utf8'), /url:\s*env\("DATABASE_URL"\)/);
  assert.ok(pins.limits.some(limit => limit.includes('not a Prisma CLI validation')));
});

const source = fs.readFileSync(path.join(root, 'scanners/persistence-next/bindings.mjs'), 'utf8');
const irSource = fs.readFileSync(path.join(root, 'scanners/persistence-next/ir.mjs'), 'utf8');

async function loadProductMutant(t, oldText, newText) {
  assert.equal(source.split(oldText).length, 2, 'mutation target must occur exactly once');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't10-product-mutant-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ir.mjs'), irSource);
  const file = path.join(dir, 'bindings.mjs');
  fs.writeFileSync(file, source.replace(oldText, newText));
  return import(pathToFileURL(file).href);
}

const productMutants = [
  {
    id: 'ignore-live-provider',
    oldText: 'if (live.provider !== expectedLiveProvider) {',
    newText: 'if (false) {',
    probe(module) { assert.throws(() => check(module, { liveProvider: 'lookalike-introspection' }), /live provider mismatch/); },
  },
  {
    id: 'ignore-live-snapshot',
    oldText: 'if (live.metadata?.snapshot_ref !== expectedLiveSnapshotRef) {',
    newText: 'if (false) {',
    probe(module) { assert.throws(() => check(module, { liveSnapshot: `sha256:${'b'.repeat(64)}` }), /live snapshot mismatch/); },
  },
  {
    id: 'ignore-composite-key-order',
    oldText: 'a.every((value, index) => value === b[index])',
    newText: 'a.every((value) => b.includes(value))',
    probe(module) {
      const { verified } = check(module, { sourceColumns: ['tenant_id', 'id'], liveColumns: ['id', 'tenant_id'] });
      assert.equal(verified.bindings[0].capabilities.verified_read_by_primary_key, false);
    },
  },
  {
    id: 'grant-write-at-binding',
    oldText: 'write: false,',
    newText: 'write: true,',
    probe(module) { assert.equal(check(module).bound.bindings[0].capabilities.write, false); },
  },
];

for (const mutant of productMutants) {
  test(`product mutation is killed: ${mutant.id}`, async t => {
    assert.doesNotThrow(() => mutant.probe(bindings), 'control must pass');
    const modified = await loadProductMutant(t, mutant.oldText, mutant.newText);
    assert.throws(() => mutant.probe(modified), 'the product mutant must fail the same probe');
  });
}
