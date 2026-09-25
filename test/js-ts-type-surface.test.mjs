import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTypeScriptSurface, JS_TS_TYPE_SURFACE_CONTRACT } from '../scanners/language/js-ts/type-surface.mjs';

test('interface data properties project without claiming runtime validation',()=> {
  const r=projectTypeScriptSurface(`export interface UserDto {
 readonly id: string;
 email: string;
 nickname?: string;
 active: boolean;
}
`,{filePath:'src/UserDto.ts'});
  assert.equal(r.contract,JS_TS_TYPE_SURFACE_CONTRACT);
  assert.equal(r.complete,true);
  assert.equal(r.syntaxValidated,false);
  assert.equal(r.runtimeValidated,false);
  assert.deepEqual(r.projections[0],{
    name:'UserDto',
    status:'projected',
    basis:'typescript-static-type',
    runtimeValidated:false,
    schema:{
      type:'object',
      properties:{id:{type:'string'},email:{type:'string'},nickname:{type:'string'},active:{type:'boolean'}},
      required:['id','email','active'],
      'x-bskel-structural-type':true,
    },
    unsupported:[],
  });
});

test('union literal/null/array/reference surfaces remain explicit',()=> {
  const r=projectTypeScriptSurface(`type Mode = 'a' | 'b';
interface X { tags: string[]; mode: Mode; note: string | null; children: Array<X>; }`);
  const x=r.projections.find(x=>x.name==='X');
  assert.deepEqual(x.schema.properties.note,{anyOf:[{type:'string'},{type:'null'}]});
  assert.deepEqual(x.schema.properties.tags,{type:'array',items:{type:'string'}});
  assert.deepEqual(x.schema.properties.mode,{'x-bskel-type-ref':'Mode'});
});

test('methods and index signatures are not mistaken for data properties',()=> {
  const r=projectTypeScriptSurface(`interface X { [key: string]: string; run(x: string): void; ok: number; }`);
  assert.deepEqual(r.declarations[0].properties.map(p=>p.name),['ok']);
  assert.ok(r.diagnostics.some(d=>d.code==='index-signature-unprojected'));
  assert.ok(r.diagnostics.some(d=>d.code==='method-member-unprojected'));
});

test('unsupported generics and intersections are partial/diagnostic, never silently widened',()=> {
  const r=projectTypeScriptSurface(`interface Box<T> { value: T }
type Both = A & B;`);
  assert.ok(r.diagnostics.some(d=>d.code==='generic-declaration-unprojected'));
  const box=r.projections.find(x=>x.name==='Box');
  assert.equal(box.status,'partial');
  assert.ok(box.unsupported.includes('generic-parameters'));
  const both=r.projections.find(x=>x.name==='Both');
  assert.equal(both.status,'partial');
});

test('extends is preserved but not merged',()=> {
  const r=projectTypeScriptSurface(`interface A { a: string } interface B extends A { b: number }`);
  const b=r.declarations.find(x=>x.name==='B');
  assert.deepEqual(b.extends,['A']);
  assert.deepEqual(b.properties.map(p=>p.name),['b']);
  const bp=r.projections.find(x=>x.name==='B');
  assert.equal(bp.status,'partial');
  assert.deepEqual(bp.unsupported,['extends:A']);
});

test('object type alias projects like an interface',()=> {
  const r=projectTypeScriptSurface(`type CreateUser = { email: string; age?: number };`);
  const p=r.projections[0];
  assert.equal(p.status,'projected');
  assert.deepEqual(p.schema.required,['email']);
});

test('duplicate declaration names are preserved with diagnostic rather than merged',()=> {
  const r=projectTypeScriptSurface(`interface X { a: string } interface X { b: string }`);
  assert.equal(r.declarations.length,2);
  assert.ok(r.diagnostics.some(d=>d.code==='duplicate-type-declaration'));
});

test('UTF-8 byte provenance is exact',()=> {
  const src=`const x='한글😀';
interface X { a: string }`;
  const r=projectTypeScriptSurface(src,{filePath:'src/x.ts'});
  const d=r.declarations[0];
  const bytes=Buffer.from(src);
  assert.equal(bytes.subarray(d.source.byteStart,d.source.byteEnd).toString('utf8'),'interface X { a: string }');
  assert.equal(d.source.line,2);
});

test('byte/token limits fail closed with no partial declarations',()=> {
  const a=projectTypeScriptSurface('interface X { a: string }',{maxBytes:2});
  assert.equal(a.complete,false);
  assert.deepEqual(a.declarations,[]);
  const b=projectTypeScriptSurface('interface X { a: string }',{maxTokens:2});
  assert.equal(b.complete,false);
  assert.deepEqual(b.declarations,[]);
});

test('comments cannot manufacture declarations',()=> {
  const r=projectTypeScriptSurface(`// interface Fake { x: string }
/* type Nope = string */
interface Real { x: string }`);
  assert.deepEqual(r.declarations.map(d=>d.name),['Real']);
});

test('ReadonlyArray, boolean literals and numeric literals project explicitly',()=> {
  const r=projectTypeScriptSurface(`type Scores = ReadonlyArray<number>;
type Flag = true | false;
type Code = 1 | 2 | 3;`);
  const scores=r.projections.find(x=>x.name==='Scores');
  const flag=r.projections.find(x=>x.name==='Flag');
  const code=r.projections.find(x=>x.name==='Code');
  assert.deepEqual(scores.schema,{type:'array',items:{type:'number'}});
  assert.deepEqual(flag.schema,{anyOf:[{const:true},{const:false}]});
  assert.deepEqual(code.schema,{anyOf:[{const:1},{const:2},{const:3}]});
});

test('conditional generic alias stays partial and never claims runtime validation',()=> {
  const r=projectTypeScriptSurface(`type Select<T> = T extends string ? A : B;`);
  const p=r.projections[0];
  assert.equal(p.status,'partial');
  assert.equal(p.runtimeValidated,false);
  assert.ok(p.unsupported.includes('generic-parameters'));
  assert.ok(p.unsupported.includes('alias-type'));
  assert.equal(r.runtimeValidated,false);
  assert.equal(r.syntaxValidated,false);
});

test('string prose cannot manufacture declarations',()=> {
  const r=projectTypeScriptSurface(`const prose = "interface Fake { x: string }";
const prose2 = 'type Hidden = number';
interface Real { id: string }`);
  assert.deepEqual(r.declarations.map(d=>d.name),['Real']);
});

test('projection never executes target code',()=> {
  globalThis.__BSKEL_T04_TYPE_SENTINEL__=0;
  const r=projectTypeScriptSurface(`globalThis.__BSKEL_T04_TYPE_SENTINEL__=99;
interface Real { id: string }`);
  assert.equal(globalThis.__BSKEL_T04_TYPE_SENTINEL__,0);
  assert.equal(r.projections[0].name,'Real');
  delete globalThis.__BSKEL_T04_TYPE_SENTINEL__;
});

test('same input and options produce byte-identical JSON',()=> {
  const src=`export interface User { id: string; name?: string; }`;
  const a=projectTypeScriptSurface(src,{filePath:'src/user.ts'});
  const b=projectTypeScriptSurface(src,{filePath:'src/user.ts'});
  assert.equal(JSON.stringify(a),JSON.stringify(b));
});

