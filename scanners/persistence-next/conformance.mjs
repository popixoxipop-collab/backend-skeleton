export const PERSISTENCE_CONFORMANCE_PROFILE = 'bskel.persistence-conformance-profile/1';
export const PERSISTENCE_CONFORMANCE_REPORT = 'bskel.persistence-conformance-report/1';

const EVIDENCE_CLASSES = new Set(['synthetic','pinned-repo','runtime']);
const SCOPES = new Set(['discovery','contract','runtime']);

function nonEmpty(value,label){
	if(typeof value!=='string'||value.trim()==='') throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

function stringArray(value,label){
	if(!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
	return value.map((item,index)=>nonEmpty(item,`${label}[${index}]`));
}

function stable(value){
	return JSON.stringify(value);
}

function relationKey(relation){
	return stable({
		columns:relation?.columns??[],
		references_table:relation?.references_table??null,
		references_schema:relation?.references_schema??null,
		references_columns:relation?.references_columns??[],
		pairing:relation?.pairing??'unknown',
	});
}

function fieldKey(field){
	return stable({
		name:field?.name??null,
		type:field?.type??null,
		nullable:typeof field?.nullable==='boolean'?field.nullable:null,
	});
}

function entityByName(ir){
	const map=new Map();
	for(const entity of ir.entities??[]){
		if(!map.has(entity.name)) map.set(entity.name,[]);
		map.get(entity.name).push(entity);
	}
	return map;
}

export function validatePersistenceConformanceProfile(profile){
	if(!profile||typeof profile!=='object') throw new TypeError('profile must be an object');
	if(profile.contract!==PERSISTENCE_CONFORMANCE_PROFILE) throw new TypeError(`expected ${PERSISTENCE_CONFORMANCE_PROFILE}`);
	const id=nonEmpty(profile.id,'profile.id');
	const persistenceId=nonEmpty(profile.persistence_id,'profile.persistence_id');
	if(!EVIDENCE_CLASSES.has(profile.evidence_class)) throw new TypeError('profile.evidence_class must be synthetic, pinned-repo, or runtime');
	if(!SCOPES.has(profile.requested_scope)) throw new TypeError('profile.requested_scope must be discovery, contract, or runtime');
	if(profile.requested_scope==='runtime'&&profile.evidence_class!=='runtime') throw new TypeError('runtime scope requires runtime evidence_class');
	if(!Array.isArray(profile.entities)||!Array.isArray(profile.required_diagnostics)||!Array.isArray(profile.forbidden_diagnostics)) {
		throw new TypeError('profile requires entities[], required_diagnostics[], forbidden_diagnostics[]');
	}
	const entities=profile.entities.map((entity,index)=>{
		const label=`profile.entities[${index}]`;
		if(!entity||typeof entity!=='object') throw new TypeError(`${label} must be an object`);
		const mode=entity.mode??'exact';
		if(!['exact','subset'].includes(mode)) throw new TypeError(`${label}.mode must be exact or subset`);
		const normalized={
			name:nonEmpty(entity.name,`${label}.name`),
			mode,
			table:entity.table??null,
			primary_key:entity.primary_key??null,
			fields:Array.isArray(entity.fields)?entity.fields:[],
			relations:Array.isArray(entity.relations)?entity.relations:[],
		};
		return normalized;
	});
	return {
		contract:PERSISTENCE_CONFORMANCE_PROFILE,
		id,persistence_id:persistenceId,
		evidence_class:profile.evidence_class,
		requested_scope:profile.requested_scope,
		source_ref:profile.source_ref??null,
		entities,
		required_diagnostics:stringArray(profile.required_diagnostics,'profile.required_diagnostics'),
		forbidden_diagnostics:stringArray(profile.forbidden_diagnostics,'profile.forbidden_diagnostics'),
		allow_extra_entities:profile.allow_extra_entities===true,
	};
}

function compareEntity(actual,expected,failures){
	const prefix=`entity ${expected.name}`;
	if(expected.table){
		for(const key of ['name','schema','source']){
			if(Object.hasOwn(expected.table,key)&&actual.table?.[key]!==expected.table[key]){
				failures.push({code:'table-mismatch',entity:expected.name,field:key,expected:expected.table[key],actual:actual.table?.[key]??null});
			}
		}
	}
	if(expected.primary_key){
		if(Object.hasOwn(expected.primary_key,'columns')&&stable(actual.primary_key?.columns??[])!==stable(expected.primary_key.columns)){
			failures.push({code:'primary-key-columns-mismatch',entity:expected.name,expected:expected.primary_key.columns,actual:actual.primary_key?.columns??[]});
		}
		if(Object.hasOwn(expected.primary_key,'type')&&actual.primary_key?.type!==expected.primary_key.type){
			failures.push({code:'primary-key-type-mismatch',entity:expected.name,expected:expected.primary_key.type,actual:actual.primary_key?.type??null});
		}
		if(Object.hasOwn(expected.primary_key,'source')&&actual.primary_key?.source!==expected.primary_key.source){
			failures.push({code:'primary-key-source-mismatch',entity:expected.name,expected:expected.primary_key.source,actual:actual.primary_key?.source??null});
		}
	}
	const actualFields=new Set((actual.fields??[]).map(fieldKey));
	const expectedFields=new Set(expected.fields.map(fieldKey));
	for(const key of expectedFields){
		if(!actualFields.has(key)) failures.push({code:'field-missing-or-mismatched',entity:expected.name,expected:JSON.parse(key)});
	}
	if(expected.mode==='exact'){
		for(const key of actualFields){
			if(!expectedFields.has(key)) failures.push({code:'unexpected-field',entity:expected.name,actual:JSON.parse(key)});
		}
	}
	const actualRelations=new Set((actual.relations??[]).map(relationKey));
	const expectedRelations=new Set(expected.relations.map(relationKey));
	for(const key of expectedRelations){
		if(!actualRelations.has(key)) failures.push({code:'relation-missing-or-mismatched',entity:expected.name,expected:JSON.parse(key)});
	}
	if(expected.mode==='exact'){
		for(const key of actualRelations){
			if(!expectedRelations.has(key)) failures.push({code:'unexpected-relation',entity:expected.name,actual:JSON.parse(key)});
		}
	}
}

export function evaluatePersistenceConformance({ir,profile}){
	const p=validatePersistenceConformanceProfile(profile);
	const failures=[];
	if(!ir||ir.contract!=='sbf.persistence-ir/1'){
		return {contract:PERSISTENCE_CONFORMANCE_REPORT,profile_id:p.id,status:'fail',evidence_class:p.evidence_class,requested_scope:p.requested_scope,certified_scope:null,failures:[{code:'invalid-persistence-ir'}]};
	}
	if(ir.provider!==p.persistence_id) failures.push({code:'provider-mismatch',expected:p.persistence_id,actual:ir.provider??null});
	const byName=entityByName(ir);
	for(const expected of p.entities){
		const matches=byName.get(expected.name)??[];
		if(matches.length===0){failures.push({code:'entity-missing',entity:expected.name});continue;}
		if(matches.length>1){failures.push({code:'entity-ambiguous',entity:expected.name,count:matches.length});continue;}
		compareEntity(matches[0],expected,failures);
	}
	if(!p.allow_extra_entities){
		const expectedNames=new Set(p.entities.map((entity)=>entity.name));
		for(const actual of ir.entities??[]) if(!expectedNames.has(actual.name)) failures.push({code:'unexpected-entity',entity:actual.name});
	}
	const diagCodes=new Set((ir.diagnostics??[]).map((diagnostic)=>diagnostic.code));
	for(const code of p.required_diagnostics) if(!diagCodes.has(code)) failures.push({code:'required-diagnostic-missing',diagnostic:code});
	for(const code of p.forbidden_diagnostics) if(diagCodes.has(code)) failures.push({code:'forbidden-diagnostic-present',diagnostic:code});
	const pass=failures.length===0;
	let certifiedScope=null;
	if(pass){
		if(p.evidence_class==='runtime') certifiedScope=p.requested_scope;
		else if(p.evidence_class==='pinned-repo') certifiedScope=p.requested_scope==='runtime'?'contract':p.requested_scope;
		else certifiedScope='fixture-'+p.requested_scope;
	}
	return {
		contract:PERSISTENCE_CONFORMANCE_REPORT,
		profile_id:p.id,
		persistence_id:p.persistence_id,
		status:pass?'pass':'fail',
		evidence_class:p.evidence_class,
		requested_scope:p.requested_scope,
		certified_scope:certifiedScope,
		failures,
		counts:{
			expected_entities:p.entities.length,
			actual_entities:Array.isArray(ir.entities)?ir.entities.length:0,
			diagnostics:Array.isArray(ir.diagnostics)?ir.diagnostics.length:0,
		},
	};
}
