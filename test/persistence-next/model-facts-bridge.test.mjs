import test from 'node:test';
import assert from 'node:assert/strict';
import { fromRubyPhpModelFacts } from '../../scanners/persistence-next/model-facts-bridge.mjs';

function source(file,line=1){ return {file,line,start:0,end:1,sha256:'0'.repeat(64)}; }
function report(framework,models,unknowns=[]){
	return { contract:'sbf.model-facts/1', framework, language:framework==='rails'?'ruby':'php', source:{file:'models',sha256:'1'.repeat(64),bytes:1}, models, unknowns };
}

test('T07 Rails facts bridge explicit table, key and belongs_to relation',()=>{
	const ir=fromRubyPhpModelFacts(report('rails',[
		{className:'Organization',table:{value:'organizations',explicit:true},primaryKey:{value:'id',explicit:true},relations:[],source:source('app/models/organization.rb')},
		{className:'Order',table:{value:'orders',explicit:true},primaryKey:{value:'order_uuid',explicit:true},relations:[
			{kind:'belongs_to',name:'organization',className:'Organization',foreignKey:'organization_id',polymorphic:false}
		],source:source('app/models/order.rb')}
	]));
	const order=ir.entities.find((e)=>e.name==='Order');
	assert.equal(ir.provider,'active-record');
	assert.deepEqual(order.primary_key.columns,['order_uuid']);
	assert.ok(order.fields.some((f)=>f.name==='organization_id'));
	assert.deepEqual(order.relations,[{
		kind:'foreign-key',columns:['organization_id'],references_table:'organizations',references_schema:null,references_columns:['id'],pairing:'resolved',source:'source',
	}]);
});

test('T07 Rails implicit table/key stay unknown in persistence IR',()=>{
	const ir=fromRubyPhpModelFacts(report('rails',[
		{className:'Person',table:null,primaryKey:null,relations:[],source:source('app/models/person.rb')}
	],[{code:'MODEL_TABLE_IMPLICIT',model:'Person',reason:'implicit'},{code:'MODEL_PRIMARY_KEY_IMPLICIT',model:'Person',reason:'implicit'}]));
	assert.equal(ir.entities[0].table.name,null);
	assert.deepEqual(ir.entities[0].primary_key.columns,[]);
	assert.ok(ir.diagnostics.some((d)=>d.code==='persistence-table-unknown'));
	assert.ok(ir.diagnostics.some((d)=>d.source_code==='MODEL_TABLE_IMPLICIT'));
});

test('T07 Rails polymorphic relation never becomes one physical edge',()=>{
	const ir=fromRubyPhpModelFacts(report('rails',[
		{className:'Picture',table:{value:'pictures',explicit:true},primaryKey:{value:'id',explicit:true},relations:[
			{kind:'belongs_to',name:'imageable',className:null,foreignKey:'imageable_id',polymorphic:true}
		],source:source('app/models/picture.rb')}
	]));
	assert.equal(ir.entities[0].relations.length,0);
	assert.ok(ir.diagnostics.some((d)=>d.code==='persistence-polymorphic-relation-unresolved'));
});

test('T07 Eloquent facts bridge explicit key type and belongsTo relation',()=>{
	const ir=fromRubyPhpModelFacts(report('laravel',[
		{className:'Organization',table:{value:'organizations',explicit:true},primaryKey:{value:'id',explicit:true},keyType:'string',relations:[],source:source('app/Models/Organization.php')},
		{className:'Order',table:{value:'orders',explicit:true},primaryKey:{value:'order_uuid',explicit:true},keyType:'string',relations:[
			{kind:'belongsTo',name:'organization',targetClass:'Organization',foreignKey:'organization_id',polymorphic:false},
			{kind:'hasMany',name:'lines',targetClass:'Line',foreignKey:'order_id',polymorphic:false},
		],source:source('app/Models/Order.php')}
	]));
	const order=ir.entities.find((e)=>e.name==='Order');
	assert.equal(ir.provider,'eloquent');
	assert.equal(order.primary_key.type,'string');
	assert.equal(order.relations.length,1,'hasMany foreign key lives on the target and is not emitted as a local FK');
	assert.equal(order.relations[0].references_table,'organizations');
});

test('T07 Eloquent implicit target table blocks physical relation',()=>{
	const ir=fromRubyPhpModelFacts(report('laravel',[
		{className:'Organization',table:null,primaryKey:{value:'id',explicit:true},relations:[],source:source('app/Models/Organization.php')},
		{className:'Order',table:{value:'orders',explicit:true},primaryKey:{value:'id',explicit:true},relations:[
			{kind:'belongsTo',name:'organization',targetClass:'Organization',foreignKey:'organization_id',polymorphic:false}
		],source:source('app/Models/Order.php')}
	]));
	const order=ir.entities.find((e)=>e.name==='Order');
	assert.equal(order.relations.length,0);
	assert.ok(ir.diagnostics.some((d)=>d.code==='persistence-relation-target-table-unknown'));
});

test('duplicate target class facts are ambiguous rather than first-match',()=>{
	const ir=fromRubyPhpModelFacts(report('rails',[
		{className:'User',table:{value:'users_a',explicit:true},primaryKey:{value:'id',explicit:true},relations:[],source:source('a.rb')},
		{className:'User',table:{value:'users_b',explicit:true},primaryKey:{value:'id',explicit:true},relations:[],source:source('b.rb')},
		{className:'Audit',table:{value:'audit',explicit:true},primaryKey:{value:'id',explicit:true},relations:[
			{kind:'belongs_to',name:'user',className:'User',foreignKey:'user_id',polymorphic:false}
		],source:source('audit.rb')}
	]));
	assert.equal(ir.entities.find((e)=>e.name==='Audit').relations.length,0);
	assert.ok(ir.diagnostics.some((d)=>d.code==='persistence-relation-target-ambiguous'));
});

test('model-facts bridge rejects unsupported contract/framework',()=>{
	assert.throws(()=>fromRubyPhpModelFacts({contract:'bad',models:[],unknowns:[]}),/sbf.model-facts\/1/);
	assert.throws(()=>fromRubyPhpModelFacts(report('unknown',[])),/unsupported model-facts framework/);
});
