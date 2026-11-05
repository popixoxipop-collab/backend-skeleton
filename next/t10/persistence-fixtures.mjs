// Existing authored T10-05 source fixtures, reused as development rehearsal inputs.
export const fixtures = [
{ name: 'prisma', args: ['--provider', 'prisma'], files: {
			'prisma/schema.prisma': 'model User {\n id String @id @map("user_uuid")\n @@map("users")\n}\n',
		} },
{ name: 'active-record', args: ['--provider', 'active-record'], files: {
			'app/models/user.rb': 'class User < ApplicationRecord\n self.table_name = "users"\n self.primary_key = "user_uuid"\nend\n',
		} },
{ name: 'django-orm', args: ['--provider', 'django-orm'], files: {
			'users/models.py': 'from django.db import models\nclass User(models.Model):\n    uuid = models.UUIDField(primary_key=True, db_column="user_uuid")\n    class Meta:\n        db_table = "users"\n',
		} },
{ name: 'java-spring', args: ['--adapter', 'java-spring'], files: {
			'build.gradle': "plugins { id 'java' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n",
			'src/main/java/com/example/User.java': 'package com.example;\nimport jakarta.persistence.*;\nimport java.util.UUID;\n@Entity\n@Table(name = "users")\nclass User {\n @Id\n private UUID id;\n}\n',
		} },
{ name: 'python-fastapi', args: ['--adapter', 'python-fastapi'], files: {
			'pyproject.toml': '[project]\nname = "fixture"\nversion = "0.0.0"\ndependencies = ["fastapi", "sqlmodel"]\n',
			'models.py': 'from fastapi import FastAPI\nfrom sqlmodel import SQLModel, Field\napp = FastAPI()\nclass Item(SQLModel, table=True):\n    id: str = Field(primary_key=True)\n',
		} },
{ name: 'typescript-express', args: ['--adapter', 'typescript-express'], files: {
			'package.json': JSON.stringify({ dependencies: { express: '^5.0.0', typeorm: '^0.3.0' } }),
			'src/users.ts': "import { Router } from 'express';\nimport { Entity, PrimaryGeneratedColumn } from 'typeorm';\nconst router = Router();\nrouter.get('/users/:id', getUser);\n@Entity('users')\nexport class User {\n @PrimaryGeneratedColumn('uuid')\n id!: string;\n}\n",
		} },
{ name: 'rails-facts', args: ['--model-facts', 'rails', 'app/models/order.rb'], files: {
			'app/models/order.rb': 'class Organization < ApplicationRecord\n self.table_name = "organizations"\n self.primary_key = "id"\nend\nclass Order < ApplicationRecord\n self.table_name = "orders"\n self.primary_key = "order_uuid"\n belongs_to :organization, class_name: "Organization", foreign_key: :organization_id\nend\n',
		} },
{ name: 'laravel-facts', args: ['--model-facts', 'laravel', 'app/Models/Order.php'], files: {
			'app/Models/Order.php': "<?php\nclass Organization extends Model {\n protected $table = 'organizations';\n protected $primaryKey = 'id';\n}\nclass Order extends Model {\n protected $table = 'orders';\n protected $primaryKey = 'order_uuid';\n public function organization() {\n  return $this->belongsTo(Organization::class, 'organization_id');\n }\n}\n",
		} }
];
