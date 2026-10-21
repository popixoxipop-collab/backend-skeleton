// Shared original first-party OpenAPI schema probes for exact one-case mutation oracles.
// All source data is local and synthetic; no request, provider or network is executed.
import assert from 'node:assert/strict';
import {inlineSchema,indexOpenApiDocument,reconcileModule} from '../../contracts/openapi.mjs';

const moduleFor=(operationId,path)=>({
 module:'wave7-schema',controllers:[{className:'Wave7',basePath:'/',file:null,
 endpoints:[{verb:'POST',path,operationId,method:operationId}]}]
});
const matched=(operationId,path,operation)=>{
 const doc={openapi:'3.1.0',
  paths:{['/api/v0'+path]:{post:{operationId,...operation}}}};
 const indexed=indexOpenApiDocument(doc);
 assert.equal(indexed.ok,true);
 const result=reconcileModule({index:indexed,module:moduleFor(operationId,path),pathPrefix:'/api/v0'});
 assert.equal(result.byEndpoint.get('0:0')?.kind,'matched');
 return {entry:result.byEndpoint.get('0:0'),stats:result.stats};
};

export function checkLossyKeywordFailsClosed(){
 const lost=inlineSchema({type:'object',
  patternProperties:{'^prefix_':{type:'string'}}},new Map());
 assert.deepEqual(lost,{ok:false,reason:'unsupported-keyword:patternProperties'},
  'dropping an assertion would weaken a request schema without disclosure');
 const supported=inlineSchema({type:'object',
  properties:{code:{type:'string'}},required:['code']},new Map());
 assert.equal(supported.ok,true);
 assert.deepEqual(supported.schema.required,['code']);
}
export function checkUnionsAndDiscriminatorPreserved(){
 const node={oneOf:[
   {type:'object',required:['kind'],properties:{kind:{const:'a'}}},
   {type:'object',required:['kind'],properties:{kind:{const:'b'}}},
  ],discriminator:{propertyName:'kind',mapping:{a:'#/components/schemas/A',b:'#/components/schemas/B'}}};
 const union=inlineSchema(node,new Map());
 assert.equal(union.ok,true);
 assert.equal(union.schema.oneOf.length,2);
 assert.deepEqual(union.schema.oneOf.map(v=>v.properties.kind.const),['a','b']);
 assert.deepEqual(union.schema.discriminator,node.discriminator,
  'source discriminator metadata is retained, not silently stripped');
 const any=inlineSchema({anyOf:[{type:'string',minLength:1},{type:'integer',minimum:0}]},new Map());
 assert.equal(any.ok,true);
 assert.equal(any.schema.anyOf.length,2);
 assert.equal(Object.hasOwn(any.schema,'oneOf'),false,'anyOf must not turn into oneOf');
}
export function checkNullAndOptionalDistinct(){
 const nullable=inlineSchema({type:['string','null']},new Map());
 assert.equal(nullable.ok,true);
 assert.deepEqual(nullable.schema.type,['string','null']);
 const required=inlineSchema({type:'object',required:['label'],
  properties:{label:{type:['string','null']}}},new Map());
 const optional=inlineSchema({type:'object',
  properties:{label:{type:['string','null']}}},new Map());
 assert.equal(required.ok,true);
 assert.equal(optional.ok,true);
 assert.deepEqual(required.schema.required,['label']);
 assert.equal(Object.hasOwn(optional.schema,'required'),false);
 assert.deepEqual(required.schema.properties.label.type,optional.schema.properties.label.type);
 const legacy=inlineSchema({type:'string',nullable:true},new Map());
 assert.deepEqual(legacy,{ok:false,reason:'unsupported-keyword:nullable'},
  'OpenAPI 3.0 nullable keyword is not silently interpreted as 3.1 type array');
}
export function checkRequestResponseDirections(){
 const {entry,stats}=matched('createWidget','/widgets',{
  requestBody:{required:true,content:{'application/json':{schema:{
    type:'object',required:['nickname'],properties:{nickname:{type:'string'}}
  }}}},
  responses:{'200':{description:'ok',content:{'application/json':{schema:{
    type:'object',required:['id'],properties:{id:{type:'integer',format:'int64'}}
  }}}}},
 });
 assert.deepEqual(entry.requestBodySchema.required,['nickname']);
 assert.ok(entry.responseSchema && Array.isArray(entry.responseSchema.required),
  'the matched success response must keep its own schema; a non-response is not success');
 assert.deepEqual(entry.responseSchema.required,['id']);
 assert.ok(Object.hasOwn(entry.requestBodySchema.properties,'nickname'));
 assert.ok(Object.hasOwn(entry.responseSchema.properties,'id'));
 assert.equal(Object.hasOwn(entry.responseSchema.properties,'nickname'),false);
 assert.equal(Object.hasOwn(entry.requestBodySchema.properties,'id'),false);
 assert.equal(stats.schema_resolved,1);
 assert.equal(stats.response_schema_resolved,1);
 const readOnly=inlineSchema({type:'string',readOnly:true},new Map(),{includeFieldDocs:true});
 assert.equal(readOnly.ok,true);
 assert.equal(readOnly.schema.readOnly,true);
 const writeOnly=inlineSchema({type:'string',writeOnly:true},new Map(),{includeFieldDocs:true});
 assert.deepEqual(writeOnly,{ok:false,reason:'unsupported-keyword:writeOnly'},
   'unsupported directional annotation must not silently disappear');
}
export function checkMultipartTransportDistinct(){
 const {entry,stats}=matched('uploadFile','/upload',{
  requestBody:{required:true,content:{'multipart/form-data':{schema:{
   type:'object',properties:{file:{type:'string',format:'binary'}}
  }}}},
  responses:{'201':{description:'created'}},
 });
 assert.equal(entry.requestBodySchema,undefined);
 assert.equal(stats.schema_skipped_media_type,1);
 assert.equal(stats.schema_resolved,0);
 assert.equal(stats.request_media_types_copied,1);
 assert.deepEqual(Object.keys(entry.sourceRequestBody.content),['multipart/form-data']);
 assert.equal(entry.sourceRequestBody.required,true);
 assert.equal(entry.sourceRequestBody.content['multipart/form-data'].schema.properties.file.format,'binary');
 assert.equal(Object.hasOwn(entry,'requestBodySchema'),false,
  'multipart is not silently transformed into a plain JSON request body');
}
export function checkInt64AndParameterSerialization(){
 const int64=inlineSchema({type:'integer',format:'int64'},new Map());
 const decimal=inlineSchema({type:'number',format:'decimal'},new Map());
 assert.equal(int64.ok,true);
 assert.deepEqual(int64.schema,{format:'int64',type:'integer'});
 assert.deepEqual(decimal,{ok:false,reason:'unsupported-format:decimal'},
  'unknown decimal precision must not be rewritten to a lossy number');
 const {entry,stats}=matched('findLimit','/limit',{
  parameters:[{name:'limit',in:'query',required:true,style:'form',explode:true,
   schema:{type:'integer',format:'int64'}}],
  responses:{'200':{description:'done'}},
 });
 assert.equal(stats.parameters_copied,1);
 assert.equal(stats.parameters_unresolved,0);
 assert.equal(entry.sourceParameters.length,1);
 assert.deepEqual(entry.sourceParameters[0],{
  name:'limit',in:'query',required:true,style:'form',explode:true,
  schema:{format:'int64',type:'integer'}
 },'query serialization and int64 format must be retained byte-for-value');
}
