import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	parseDjangoModels,
	detectDjangoOrmPersistence,
	scanDjangoOrmPersistence,
} from '../../scanners/persistence-next/providers/django-orm.mjs';

test('Django explicit db_table, db_column and primary_key become physical facts', () => {
	const ir=parseDjangoModels([{file:'users/models.py',text:`
from django.db import models

class User(models.Model):
    uuid = models.UUIDField(primary_key=True, db_column="user_uuid")
    email = models.EmailField(db_column="email_address", null=True)

    class Meta:
        db_table = "users"
`}]);
	assert.equal(ir.entities.length,1);
	const user=ir.entities[0];
	assert.deepEqual(user.table,{name:'users',schema:null,source:'explicit'});
	assert.deepEqual(user.primary_key.columns,['user_uuid']);
	assert.equal(user.primary_key.type,'UUIDField');
	assert.deepEqual(user.fields.map((f)=>[f.name,f.nullable]),[['user_uuid',null],['email_address',true]]);
});

test('Django app-label table name and implicit id are not guessed', () => {
	const ir=parseDjangoModels([{file:'audit/models.py',text:`
from django.db import models
class Audit(models.Model):
    message = models.TextField()
`}]);
	assert.equal(ir.entities[0].table.name,null);
	assert.deepEqual(ir.entities[0].primary_key.columns,[]);
	assert.ok(ir.diagnostics.some((d)=>d.code==='django-table-unknown'));
	assert.ok(ir.diagnostics.some((d)=>d.code==='django-primary-key-unknown'));
});

test('Django ForeignKey default physical column is candidate source-default and resolves explicit target PK', () => {
	const ir=parseDjangoModels([{file:'app/models.py',text:`
from django.db import models
class Organization(models.Model):
    id = models.UUIDField(primary_key=True)
    class Meta:
        db_table = "organizations"

class Order(models.Model):
    id = models.UUIDField(primary_key=True)
    organization = models.ForeignKey("Organization", on_delete=models.CASCADE)
    class Meta:
        db_table = "orders"
`}]);
	const order=ir.entities.find((e)=>e.name==='Order');
	assert.ok(order.fields.some((f)=>f.name==='organization_id' && f.source==='source-default'));
	assert.deepEqual(order.relations,[{
		kind:'foreign-key',columns:['organization_id'],references_table:'organizations',references_schema:null,references_columns:['id'],pairing:'resolved',source:'source',
	}]);
});

test('Django to_field resolves the target field db_column, not the target PK', () => {
	const ir=parseDjangoModels([{file:'app/models.py',text:`
from django.db import models
class Organization(models.Model):
    id = models.UUIDField(primary_key=True)
    code = models.CharField(max_length=32, db_column="org_code")
    class Meta:
        db_table = "organizations"

class Order(models.Model):
    id = models.UUIDField(primary_key=True)
    organization = models.ForeignKey("Organization", to_field="code", db_column="organization_code", on_delete=models.CASCADE)
    class Meta:
        db_table = "orders"
`}]);
	const relation=ir.entities.find((e)=>e.name==='Order').relations[0];
	assert.deepEqual(relation.columns,['organization_code']);
	assert.deepEqual(relation.references_columns,['org_code']);
	assert.equal(relation.pairing,'resolved');
});

test('Django relation target without explicit table remains diagnostic and no edge is fabricated', () => {
	const ir=parseDjangoModels([{file:'app/models.py',text:`
from django.db import models
class Organization(models.Model):
    id = models.UUIDField(primary_key=True)

class Order(models.Model):
    id = models.UUIDField(primary_key=True)
    organization = models.ForeignKey("Organization", on_delete=models.CASCADE)
    class Meta:
        db_table = "orders"
`}]);
	const order=ir.entities.find((e)=>e.name==='Order');
	assert.equal(order.relations.length,0);
	assert.ok(ir.diagnostics.some((d)=>d.code==='django-relation-target-table-unknown'));
});

test('Django abstract model is not emitted as physical entity', () => {
	const ir=parseDjangoModels([{file:'app/models.py',text:`
from django.db import models
class Base(models.Model):
    id = models.UUIDField(primary_key=True)
    class Meta:
        abstract = True
`}]);
	assert.equal(ir.entities.length,0);
	assert.ok(ir.diagnostics.some((d)=>d.code==='django-abstract-model'));
});

test('Django comments and triple-quoted strings cannot create fake models', () => {
	const ir=parseDjangoModels([{file:'app/models.py',text:`
from django.db import models
"""
class Ghost(models.Model):
    id = models.UUIDField(primary_key=True)
"""
# class CommentGhost(models.Model):
class Real(models.Model):
    id = models.UUIDField(primary_key=True)
    class Meta:
        db_table = "real_rows"
`}]);
	assert.deepEqual(ir.entities.map((e)=>e.name),['Real']);
});

test('Django unsupported direct models field is diagnostic rather than a fabricated physical column', () => {
	const ir=parseDjangoModels([{file:'app/models.py',text:`
from django.db import models
class Item(models.Model):
    id = models.UUIDField(primary_key=True)
    weird = models.CustomDomainField()
    class Meta:
        db_table = "items"
`}]);
	assert.deepEqual(ir.entities[0].fields.map((f)=>f.name),['id']);
	assert.ok(ir.diagnostics.some((d)=>d.code==='django-field-type-unsupported' && d.field==='weird'));
});

test('Django duplicated target class names make relation resolution ambiguous', () => {
	const ir=parseDjangoModels([
		{file:'a/models.py',text:'from django.db import models\nclass User(models.Model):\n    id = models.UUIDField(primary_key=True)\n    class Meta:\n        db_table = "users_a"\n'},
		{file:'b/models.py',text:'from django.db import models\nclass User(models.Model):\n    id = models.UUIDField(primary_key=True)\n    class Meta:\n        db_table = "users_b"\n'},
		{file:'orders/models.py',text:'from django.db import models\nclass Order(models.Model):\n    id = models.UUIDField(primary_key=True)\n    user = models.ForeignKey("User", on_delete=models.CASCADE)\n    class Meta:\n        db_table = "orders"\n'},
	]);
	const order=ir.entities.find((e)=>e.name==='Order');
	assert.equal(order.relations.length,0);
	assert.ok(ir.diagnostics.some((d)=>d.code==='django-relation-target-ambiguous'));
});

test('Django provider detects conventional model files and emits repository-relative refs', () => {
	const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-django-orm-'));
	fs.mkdirSync(path.join(root,'accounts'),{recursive:true});
	fs.writeFileSync(path.join(root,'accounts/models.py'),'from django.db import models\nclass User(models.Model):\n    uuid = models.UUIDField(primary_key=True)\n    class Meta:\n        db_table = "users"\n');
	assert.equal(detectDjangoOrmPersistence(root),true);
	const ir=scanDjangoOrmPersistence(root);
	assert.equal(ir.entities[0].source_refs[0].file,'accounts/models.py');
});
