import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	parseActiveRecordModels,
	detectActiveRecordPersistence,
	scanActiveRecordPersistence,
} from '../../scanners/persistence-next/providers/active-record.mjs';

test('explicit table and primary key become strong ActiveRecord facts', () => {
	const ir = parseActiveRecordModels([{ file:'app/models/user.rb', text:`
class User < ApplicationRecord
  self.table_name = "users"
  self.primary_key = "user_uuid"
end
` }]);
	assert.equal(ir.entities.length,1);
	assert.deepEqual(ir.entities[0].table,{name:'users',schema:null,source:'explicit'});
	assert.deepEqual(ir.entities[0].primary_key.columns,['user_uuid']);
});

test('Rails defaults are not guessed when table and key are implicit', () => {
	const ir = parseActiveRecordModels([{ file:'app/models/person.rb', text:'class Person < ApplicationRecord\nend\n' }]);
	assert.equal(ir.entities[0].table.name,null);
	assert.deepEqual(ir.entities[0].primary_key.columns,[]);
	assert.ok(ir.diagnostics.some((d)=>d.code==='active-record-table-unknown'));
	assert.ok(ir.diagnostics.some((d)=>d.code==='active-record-primary-key-unknown'));
});

test('literal belongs_to mapping resolves only with explicit target table', () => {
	const ir = parseActiveRecordModels([
		{ file:'app/models/org.rb', text:'class Organization < ApplicationRecord\n self.table_name = "organizations"\n self.primary_key = "id"\nend\n' },
		{ file:'app/models/order.rb', text:'class Order < ApplicationRecord\n self.table_name = "orders"\n self.primary_key = "id"\n belongs_to :organization, class_name: "Organization", foreign_key: "organization_id"\nend\n' },
	]);
	const order=ir.entities.find((e)=>e.name==='Order');
	assert.deepEqual(order.relations,[{
		kind:'foreign-key',columns:['organization_id'],references_table:'organizations',references_schema:null,references_columns:['id'],pairing:'resolved',source:'source',
	}]);
	assert.ok(order.fields.some((f)=>f.name==='organization_id'));
});

test('convention-only belongs_to is diagnostic rather than inferred', () => {
	const ir = parseActiveRecordModels([{ file:'app/models/order.rb', text:'class Order < ApplicationRecord\n self.table_name = "orders"\n belongs_to :organization\nend\n' }]);
	assert.equal(ir.entities[0].relations.length,0);
	assert.ok(ir.diagnostics.some((d)=>d.code==='active-record-relation-unresolved'));
});

test('abstract ActiveRecord models are not physical entities', () => {
	const ir = parseActiveRecordModels([{ file:'app/models/base.rb', text:'class Base < ApplicationRecord\n self.abstract_class = true\nend\n' }]);
	assert.equal(ir.entities.length,0);
	assert.ok(ir.diagnostics.some((d)=>d.code==='active-record-abstract-model'));
});

test('multiple ActiveRecord classes in one file are refused instead of misattributed', () => {
	const ir = parseActiveRecordModels([{ file:'app/models/mixed.rb', text:'class A < ApplicationRecord\nend\nclass B < ApplicationRecord\nend\n' }]);
	assert.equal(ir.entities.length,0);
	assert.ok(ir.diagnostics.some((d)=>d.code==='active-record-multiple-models-per-file'));
});

test('comments cannot create fake ActiveRecord models', () => {
	const ir = parseActiveRecordModels([{ file:'app/models/real.rb', text:'# class Ghost < ApplicationRecord\nclass Real < ApplicationRecord\n self.table_name = "real_rows"\nend\n' }]);
	assert.deepEqual(ir.entities.map((e)=>e.name),['Real']);
});

test('provider detects app/models and scans repository-relative source refs', () => {
	const root=fs.mkdtempSync(path.join(os.tmpdir(),'bskel-active-record-'));
	fs.mkdirSync(path.join(root,'app/models'),{recursive:true});
	fs.writeFileSync(path.join(root,'app/models/user.rb'),'class User < ApplicationRecord\n self.table_name = "users"\n self.primary_key = "id"\nend\n');
	assert.equal(detectActiveRecordPersistence(root),true);
	const ir=scanActiveRecordPersistence(root);
	assert.equal(ir.entities[0].source_refs[0].file,'app/models/user.rb');
});
