// First-party, source-declaration-only OpenAPI security oracles.
// This fixture does not send HTTP requests, authenticate a principal, or certify
// runtime enforcement. It tests precisely what index/reconciliation can prove.
import assert from 'node:assert/strict';
import {indexOpenApiDocument,reconcileModule} from '../../contracts/openapi.mjs';
const schemes={
 bearerAuth:{type:'http',scheme:'bearer'},
 apiKeyAuth:{type:'apiKey',in:'header',name:'X-Fixture-Key'},
};
function select(operations,globalSecurity=[{bearerAuth:[]}]){
 const paths={}, endpoints=[];
 for(const [name,source] of Object.entries(operations)){
  paths['/api/v0/'+name]={post:{
   operationId:name,
   ...(source===null?{}:{security:source}),
   responses:{'204':{description:'ok'}},
  }};
  endpoints.push({verb:'POST',path:'/'+name,method:name,operationId:name});
 }
 const indexed=indexOpenApiDocument({
  openapi:'3.1.0',components:{securitySchemes:schemes},
  security:globalSecurity,paths,
 });
 assert.equal(indexed.ok,true);
 const module={module:'auth-fixture',controllers:[{className:'Fixture',basePath:'/',file:null,endpoints}]};
 const result=reconcileModule({index:indexed,module,pathPrefix:'/api/v0'});
 const matched=new Map(endpoints.map((endpoint,i)=>{
  const value=result.byEndpoint.get('0:'+i);
  assert.equal(value?.kind,'matched');
  return [endpoint.operationId,value];
 }));
 return {matched,stats:result.stats,sourceSecuritySchemes:result.sourceSecuritySchemes};
}
export function checkDeclaredSecurityNotRuntimeProof(){
 const r=select({protected:[{bearerAuth:[]}]});
 const endpoint=r.matched.get('protected');
 assert.deepEqual(endpoint.sourceSecurity,[{bearerAuth:[]}]);
 assert.deepEqual([...r.sourceSecuritySchemes.keys()],['bearerAuth']);
 assert.equal(r.stats.security_copied,1);
 for(const key of ['runtimeEnforced','securityEnforced','securityVerified',
    'authzPassed','credentialsVerified','userAuthorized']){
  assert.equal(Object.hasOwn(endpoint,key),false,
   'source OpenAPI declaration alone cannot certify '+key);
 }
 const absent=select({notDeclared:null});
 assert.equal(Object.hasOwn(absent.matched.get('notDeclared'),'sourceSecurity'),false);
 assert.equal(absent.stats.security_none,1);
}
export function checkPerOperationPublicAndProtectedOverrides(){
 const r=select({
  public:[],
  protected:[{bearerAuth:[]}],
  notDeclared:null,
 });
 assert.deepEqual(r.matched.get('public').sourceSecurity,[],
  'explicit per-operation public override is not an absent declaration');
 assert.deepEqual(r.matched.get('protected').sourceSecurity,[{bearerAuth:[]}]);
 assert.equal(Object.hasOwn(r.matched.get('notDeclared'),'sourceSecurity'),false,
  'an absent operation-level declaration must not be guessed as enforced');
 assert.equal(r.stats.security_public,1);
 assert.equal(r.stats.security_copied,1);
 assert.equal(r.stats.security_none,1);
 assert.deepEqual([...r.sourceSecuritySchemes.keys()],['bearerAuth']);
}
export function checkAndVsOrAlternatives(){
 const and=[{bearerAuth:[],apiKeyAuth:[]}];
 const or=[{bearerAuth:[]},{apiKeyAuth:[]}];
 const r=select({bothRequired:and,eitherAccepted:or});
 const gotAnd=r.matched.get('bothRequired').sourceSecurity;
 const gotOr=r.matched.get('eitherAccepted').sourceSecurity;
 assert.deepEqual(gotAnd,and,
  'one requirement object means both schemes jointly required in this declaration');
 assert.deepEqual(gotOr,or,
  'two separate requirement objects are alternative credential schemes');
 assert.equal(gotAnd.length,1);
 assert.equal(Object.keys(gotAnd[0]).length,2);
 assert.equal(gotOr.length,2);
 assert.equal(Object.keys(gotOr[0]).length,1);
 assert.equal(Object.keys(gotOr[1]).length,1);
 assert.deepEqual([...r.sourceSecuritySchemes.keys()],['bearerAuth','apiKeyAuth']);
 assert.equal(r.stats.security_copied,2);
}
