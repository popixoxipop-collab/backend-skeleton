import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	parsePrismaSchema,
	detectPrismaPersistence,
	scanPrismaPersistence,
} from '../../scanners/persistence-next/providers/prisma.mjs';

test('Prisma single @id, @@map, @@schema and @map become physical persistence facts', () => {
	const ir = parsePrismaSchema(`
model User {
  id       String @id @default(uuid()) @map("user_id")
  email    String @unique
  nickname String?
  @@map("users")
  @@schema("auth")
}
`, { file: '/repo/prisma/schema.prisma', repoRoot: '/repo' });
	assert.equal(ir.entities.length, 1);
	const user = ir.entities[0];
	assert.deepEqual(user.table, { name: 'users', schema: 'auth', source: 'explicit' });
	assert.deepEqual(user.primary_key.columns, ['user_id']);
	assert.equal(user.primary_key.type, 'String');
	assert.deepEqual(user.fields.map((f) => [f.name, f.nullable]), [['user_id', false], ['email', false], ['nickname', true]]);
	assert.equal(user.source_refs[0].file, 'prisma/schema.prisma');
});

test('Prisma composite @@id preserves declared order and mapped physical names', () => {
	const ir = parsePrismaSchema(`
model Membership {
  tenantId String @map("tenant_id")
  userId   String @map("user_id")
  @@id([tenantId, userId])
  @@map("memberships")
}
`);
	assert.deepEqual(ir.entities[0].primary_key.columns, ['tenant_id', 'user_id']);
	assert.equal(ir.entities[0].primary_key.type, 'composite');
});

test('Prisma relation maps local and referenced logical fields to physical columns in order', () => {
	const ir = parsePrismaSchema(`
model TenantUser {
  tenantId String @map("tenant_id")
  userId String @map("user_id")
  tenant Tenant @relation(fields: [tenantId], references: [id])
  user User @relation(fields: [userId], references: [id])
  @@id([tenantId, userId])
  @@map("tenant_users")
}
model Tenant {
  id String @id @map("tenant_pk")
  members TenantUser[]
  @@map("tenants")
}
model User {
  id String @id @map("user_pk")
  members TenantUser[]
  @@map("users")
}
`);
	const child = ir.entities.find((e) => e.name === 'TenantUser');
	assert.deepEqual(child.relations.map((r) => ({ columns:r.columns, table:r.references_table, refs:r.references_columns, pairing:r.pairing })), [
		{ columns:['tenant_id'], table:'tenants', refs:['tenant_pk'], pairing:'resolved' },
		{ columns:['user_id'], table:'users', refs:['user_pk'], pairing:'resolved' },
	]);
	assert.deepEqual(child.fields.map((f) => f.name), ['tenant_id', 'user_id'], 'relation object fields are not physical columns');
});

test('Prisma composite relation preserves paired field order', () => {
	const ir = parsePrismaSchema(`
model Parent {
  tenantId String @map("tenant_id")
  id String @map("parent_id")
  children Child[]
  @@id([tenantId, id])
  @@map("parents")
}
model Child {
  tenantId String @map("tenant_id")
  parentId String @map("parent_id")
  parent Parent @relation(fields: [tenantId, parentId], references: [tenantId, id])
  @@id([tenantId, parentId])
  @@map("children")
}
`);
	const relation = ir.entities.find((e) => e.name === 'Child').relations[0];
	assert.deepEqual(relation.columns, ['tenant_id', 'parent_id']);
	assert.deepEqual(relation.references_columns, ['tenant_id', 'parent_id']);
	assert.equal(relation.pairing, 'resolved');
});

test('Prisma default model table stays inferred, never upgraded to explicit', () => {
	const ir = parsePrismaSchema(`model Audit {\n id Int @id\n }`);
	assert.equal(ir.entities[0].table.name, 'Audit');
	assert.equal(ir.entities[0].table.source, 'inferred');
});

test('Prisma unknown relation target is diagnostic and never fabricated as a physical edge', () => {
	const ir = parsePrismaSchema(`
model Child {
  parentId String
  parent Missing @relation(fields: [parentId], references: [id])
  @@map("children")
}
`);
	assert.equal(ir.entities[0].relations.length, 0);
	assert.ok(ir.diagnostics.some((d) => d.code === 'prisma-relation-target-unknown'));
});

test('Prisma provider detects and scans only explicit default schema candidates in Slice 1', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-prisma-'));
	fs.mkdirSync(path.join(root, 'prisma'), { recursive: true });
	fs.writeFileSync(path.join(root, 'prisma/schema.prisma'), 'model User {\n id String @id\n @@map("users")\n}\n');
	assert.equal(detectPrismaPersistence(root), true);
	const ir = scanPrismaPersistence(root);
	assert.equal(ir.entities[0].table.name, 'users');
	assert.deepEqual(ir.metadata.schema_files, ['prisma/schema.prisma']);
});

test('Prisma parser ignores fake model declarations inside comments and quoted datasource strings', () => {
	const ir = parsePrismaSchema(`
datasource db {
  provider = "postgresql"
  url = "model Ghost { id String @id }"
}
// model CommentGhost { id String @id }
/* model BlockGhost { id String @id } */
model Real {
  id String @id
}
`);
	assert.deepEqual(ir.entities.map((e) => e.name), ['Real']);
});

test('unresolved relation object is not fabricated as a physical column', () => {
	const ir = parsePrismaSchema(`
model Child {
  parentId String
  parent Missing @relation(fields: [parentId], references: [id])
  @@map("children")
}
`);
	assert.deepEqual(ir.entities[0].fields.map((field) => field.name), ['parentId']);
	assert.equal(ir.entities[0].relations.length, 0);
});


test('Prisma provider refuses to merge two default schema roots implicitly', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-prisma-ambiguous-'));
	fs.mkdirSync(path.join(root, 'prisma'), { recursive: true });
	fs.writeFileSync(path.join(root, 'prisma/schema.prisma'), 'model A {\n id String @id\n}\n');
	fs.writeFileSync(path.join(root, 'schema.prisma'), 'model B {\n id String @id\n}\n');
	const ir = scanPrismaPersistence(root);
	assert.equal(ir.entities.length, 0);
	assert.ok(ir.diagnostics.some((d) => d.code === 'prisma-schema-root-ambiguous'));
});

test('Prisma @id on an unresolved custom type stays unknown instead of becoming a physical PK', () => {
	const ir = parsePrismaSchema(`model Strange {\n id CustomType @id\n}`);
	assert.deepEqual(ir.entities[0].fields, []);
	assert.deepEqual(ir.entities[0].primary_key.columns, []);
	assert.equal(ir.entities[0].primary_key.source, 'unknown');
	assert.ok(ir.diagnostics.some((d) => d.code === 'prisma-primary-key-unresolved'));
});

test('Prisma relation reference to a non-physical relation field stays unresolved', () => {
	const ir = parsePrismaSchema(`
model A {
  id String @id
  bs B[]
}
model B {
  id String @id
  aId String
  a A @relation(fields: [aId], references: [bs])
}
`);
	const relation = ir.entities.find((e) => e.name === 'B').relations[0];
	assert.equal(relation.pairing, 'unknown');
	assert.deepEqual(relation.references_columns, []);
	assert.ok(ir.diagnostics.some((d) => d.code === 'prisma-relation-unresolved'));
});
