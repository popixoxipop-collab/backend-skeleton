import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { adapter as spring } from '../../scanners/adapters/java-spring.mjs';
import { adapter as fastapi } from '../../scanners/adapters/python-fastapi.mjs';
import { adapter as expressTs } from '../../scanners/adapters/typescript-express.mjs';
import { fromLegacyAdapterScan } from '../../scanners/persistence-next/legacy.mjs';

function root(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function entities(scan) { return scan.modules.flatMap((module) => module.entities ?? []); }

test('actual Spring adapter entity facts bridge into Persistence IR without changing the adapter', () => {
	const repo = root('bskel-persist-spring-');
	fs.writeFileSync(path.join(repo, 'build.gradle'), "plugins { id 'java' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n");
	const src = path.join(repo, 'src/main/java/com/example/users');
	fs.mkdirSync(src, { recursive: true });
	fs.writeFileSync(path.join(src, 'User.java'), `package com.example.users;\nimport jakarta.persistence.*;\nimport java.util.UUID;\n@Entity\n@Table(name = "users")\nclass User {\n @Id\n private UUID id;\n}\n`);
	const scan = spring.scan(repo);
	assert.equal(entities(scan).length, 1);
	const ir = fromLegacyAdapterScan({ adapterId: spring.id, scan, repoRoot: repo });
	assert.equal(ir.entities[0].name, 'User');
	assert.equal(ir.entities[0].table.name, 'users');
	assert.equal(ir.entities[0].table.source, 'explicit');
	assert.deepEqual(ir.entities[0].primary_key.columns, ['id']);
	assert.equal(ir.entities[0].primary_key.type, 'UUID');
});

test('actual FastAPI adapter preserves SQLModel inferred-vs-explicit table provenance', () => {
	const repo = root('bskel-persist-fastapi-');
	fs.writeFileSync(path.join(repo, 'pyproject.toml'), `[project]\nname = "fixture"\nversion = "0.0.0"\ndependencies = ["fastapi", "sqlmodel"]\n`);
	fs.writeFileSync(path.join(repo, 'models.py'), `from fastapi import FastAPI\nfrom sqlmodel import SQLModel, Field\napp = FastAPI()\nclass Item(SQLModel, table=True):\n    id: str = Field(primary_key=True)\n`);
	const detected = fastapi.detect(repo);
	assert.equal(detected, repo);
	const scan = fastapi.scan(repo, detected);
	assert.equal(entities(scan).length, 1);
	const ir = fromLegacyAdapterScan({ adapterId: fastapi.id, scan, repoRoot: repo });
	assert.equal(ir.entities[0].table.name, 'item');
	assert.equal(ir.entities[0].table.source, 'inferred');
	assert.deepEqual(ir.entities[0].primary_key.columns, ['id']);
});

test('actual TypeScript Express adapter carries TypeORM UUID identity into Persistence IR', () => {
	const repo = root('bskel-persist-express-');
	fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { express: '^5.0.0', typeorm: '^0.3.0' } }));
	const src = path.join(repo, 'src');
	fs.mkdirSync(src, { recursive: true });
	fs.writeFileSync(path.join(src, 'users.ts'), `import { Router } from 'express';\nimport { Entity, PrimaryGeneratedColumn } from 'typeorm';\nconst router = Router();\nrouter.get('/users/:id', getUser);\n@Entity('users')\nexport class User {\n @PrimaryGeneratedColumn('uuid')\n id!: string;\n}\n`);
	const detected = expressTs.detect(repo);
	assert.equal(detected, repo);
	const scan = expressTs.scan(repo, detected);
	assert.equal(entities(scan).length, 1);
	const ir = fromLegacyAdapterScan({ adapterId: expressTs.id, scan, repoRoot: repo });
	assert.equal(ir.entities[0].table.name, 'users');
	assert.equal(ir.entities[0].table.source, 'explicit');
	assert.equal(ir.entities[0].primary_key.type, 'uuid');
});
