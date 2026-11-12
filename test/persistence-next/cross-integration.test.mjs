import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function write(root, name, contents) {
	const file = path.join(root, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, contents);
}

function checked(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
	assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
	return result.stdout;
}

test('packed T10 consumer runs provider, legacy adapter, and actual T07 fact-producer combinations', async (t) => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t10-packed-'));
	t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
	const pack = JSON.parse(checked('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], repo));
	assert.equal(pack.length, 1);
	const installed = path.join(temp, 'node_modules', 'backend-skeleton');
	fs.mkdirSync(installed, { recursive: true });
	checked('tar', ['-xzf', path.join(temp, pack[0].filename), '-C', installed, '--strip-components=1'], temp);
	const cli = path.join(installed, 'scanners', 'persistence-next', 'observe-cli.mjs');
	assert.ok(fs.existsSync(cli), 'T10 consumer must exist in the published tarball');
	assert.ok(fs.existsSync(path.join(installed, 'scanners', 'language', 'ruby-php', 'model-facts.mjs')), 'the real T07 producer must be packed');

	const run = (name, args, files) => {
		const project = path.join(temp, name);
		fs.mkdirSync(project);
		for (const [file, contents] of Object.entries(files)) write(project, file, contents);
		return JSON.parse(checked(process.execPath, [cli, project, ...args], temp));
	};

	await t.test('Prisma provider via registry', () => {
		const ir = run('prisma', ['--provider', 'prisma'], {
			'prisma/schema.prisma': 'model User {\n id String @id @map("user_uuid")\n @@map("users")\n}\n',
		});
		assert.equal(ir.provider, 'prisma');
		assert.deepEqual(ir.entities[0].primary_key.columns, ['user_uuid']);
	});
	await t.test('ActiveRecord provider via registry', () => {
		const ir = run('active-record', ['--provider', 'active-record'], {
			'app/models/user.rb': 'class User < ApplicationRecord\n self.table_name = "users"\n self.primary_key = "user_uuid"\nend\n',
		});
		assert.equal(ir.provider, 'active-record');
		assert.equal(ir.entities[0].table.name, 'users');
	});
	await t.test('Django provider via registry', () => {
		const ir = run('django-orm', ['--provider', 'django-orm'], {
			'users/models.py': 'from django.db import models\nclass User(models.Model):\n    uuid = models.UUIDField(primary_key=True, db_column="user_uuid")\n    class Meta:\n        db_table = "users"\n',
		});
		assert.equal(ir.provider, 'django-orm');
		assert.deepEqual(ir.entities[0].primary_key.columns, ['user_uuid']);
	});
	await t.test('real Spring adapter to JPA IR', () => {
		const ir = run('java-spring', ['--adapter', 'java-spring'], {
			'build.gradle': "plugins { id 'java' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n",
			'src/main/java/com/example/User.java': 'package com.example;\nimport jakarta.persistence.*;\nimport java.util.UUID;\n@Entity\n@Table(name = "users")\nclass User {\n @Id\n private UUID id;\n}\n',
		});
		assert.equal(ir.provider, 'jpa-hibernate');
		assert.equal(ir.entities[0].table.name, 'users');
	});
	await t.test('real FastAPI adapter to SQLModel IR', () => {
		const ir = run('python-fastapi', ['--adapter', 'python-fastapi'], {
			'pyproject.toml': '[project]\nname = "fixture"\nversion = "0.0.0"\ndependencies = ["fastapi", "sqlmodel"]\n',
			'models.py': 'from fastapi import FastAPI\nfrom sqlmodel import SQLModel, Field\napp = FastAPI()\nclass Item(SQLModel, table=True):\n    id: str = Field(primary_key=True)\n',
		});
		assert.equal(ir.provider, 'sqlalchemy-sqlmodel');
		assert.equal(ir.entities[0].table.source, 'inferred');
	});
	await t.test('real Express adapter to TypeORM IR', () => {
		const ir = run('typescript-express', ['--adapter', 'typescript-express'], {
			'package.json': JSON.stringify({ dependencies: { express: '^5.0.0', typeorm: '^0.3.0' } }),
			'src/users.ts': "import { Router } from 'express';\nimport { Entity, PrimaryGeneratedColumn } from 'typeorm';\nconst router = Router();\nrouter.get('/users/:id', getUser);\n@Entity('users')\nexport class User {\n @PrimaryGeneratedColumn('uuid')\n id!: string;\n}\n",
		});
		assert.equal(ir.provider, 'typeorm');
		assert.equal(ir.entities[0].primary_key.type, 'uuid');
	});
	await t.test('actual T07 Rails output to T10 bridge', () => {
		const ir = run('rails-facts', ['--model-facts', 'rails', 'app/models/order.rb'], {
			'app/models/order.rb': 'class Organization < ApplicationRecord\n self.table_name = "organizations"\n self.primary_key = "id"\nend\nclass Order < ApplicationRecord\n self.table_name = "orders"\n self.primary_key = "order_uuid"\n belongs_to :organization, class_name: "Organization", foreign_key: :organization_id\nend\n',
		});
		assert.equal(ir.metadata.upstream_contract, 'sbf.model-facts/1');
		assert.equal(ir.entities.find((entity) => entity.name === 'Order').relations[0].references_table, 'organizations');
	});
	await t.test('actual T07 Eloquent output to T10 bridge', () => {
		const ir = run('laravel-facts', ['--model-facts', 'laravel', 'app/Models/Order.php'], {
			'app/Models/Order.php': "<?php\nclass Organization extends Model {\n protected $table = 'organizations';\n protected $primaryKey = 'id';\n}\nclass Order extends Model {\n protected $table = 'orders';\n protected $primaryKey = 'order_uuid';\n public function organization() {\n  return $this->belongsTo(Organization::class, 'organization_id');\n }\n}\n",
		});
		assert.equal(ir.metadata.upstream_contract, 'sbf.model-facts/1');
		assert.equal(ir.entities.find((entity) => entity.name === 'Order').relations[0].references_table, 'organizations');
	});
});

test('T10 consumer rejects escaped T07 model paths and ambiguous mode selection', () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t10-path-'));
	try {
		write(temp, 'app/models/user.rb', 'class User < ApplicationRecord\nend\n');
		const cli = path.join(repo, 'scanners', 'persistence-next', 'observe-cli.mjs');
		const escaped = spawnSync(process.execPath, [cli, temp, '--model-facts', 'rails', '../user.rb'], { encoding: 'utf8' });
		assert.equal(escaped.status, 2);
		assert.match(escaped.stderr, /within project root/);
		const missing = spawnSync(process.execPath, [cli, temp, '--provider', 'prisma', 'extra'], { encoding: 'utf8' });
		assert.equal(missing.status, 2);
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
});
