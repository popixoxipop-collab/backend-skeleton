// T22-05 owner-authorized review candidate. Scoped utility regressions only.
// No historical baseline updates, adapter execution, CI changes, or MET claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {validSemver,compareSemver,cloneJsonValue,cloneAndFreezeJson,isPlainObject,isJsonValue,stableClone} from '../sdk/next/_util.mjs';

const checks = [
  ['major >2^53 precedence',()=>assert.equal(compareSemver('9007199254740992.0.0','9007199254740993.0.0'),-1)],
  ['minor >2^53 precedence',()=>assert.equal(compareSemver('1.9007199254740992.0','1.9007199254740993.0'),-1)],
  ['patch >2^53 precedence',()=>assert.equal(compareSemver('1.2.9007199254740992','1.2.9007199254740993'),-1)],
  ['prerelease >2^53 precedence',()=>assert.equal(compareSemver('1.2.3-9007199254740992','1.2.3-9007199254740993'),-1)],
  ['build metadata ignored',()=>assert.equal(compareSemver('1.2.3+one','1.2.3+two'),0)],
  ['stable release outranks prerelease',()=>assert.equal(compareSemver('1.2.3','1.2.3-alpha'),1)],
  ['numeric prerelease before text',()=>assert.equal(compareSemver('1.2.3-1','1.2.3-a'),-1)],
  ['normal version precedence',()=>assert.equal(compareSemver('2.0.0','1.9.9'),1)],
  ['invalid leading zero refused',()=>assert.equal(validSemver('1.2.3-01'),false)],
  ['invalid version comparison refused',()=>assert.throws(()=>compareSemver('1.2','1.2.3'),TypeError)],
  ['large valid semver accepted',()=>assert.equal(validSemver('9007199254740993.2.3'),true)],
  ['nested JSON clone unchanged',()=>assert.deepEqual(cloneJsonValue({a:[1,null,'ok'],b:true}),{a:[1,null,'ok'],b:true})],
  ['null-prototype object accepted as data',()=>{const x=Object.create(null);x.a=3;assert.deepEqual(cloneJsonValue(x),{a:3});}],
  ['__proto__ own data cannot pollute',()=>{const x=cloneJsonValue(JSON.parse('{"__proto__":{"admin":true}}'));assert.equal(Object.hasOwn(x,'__proto__'),true);assert.equal(x.admin,undefined);}],
  ['object getter never runs',()=>{let n=0;const x={};Object.defineProperty(x,'a',{enumerable:true,get(){n++;throw Error('getter');}});assert.throws(()=>cloneJsonValue(x),TypeError);assert.equal(n,0);}],
  ['array getter never runs',()=>{let n=0;const x=[1];Object.defineProperty(x,'0',{enumerable:true,get(){n++;throw Error('getter');}});assert.throws(()=>cloneJsonValue(x),TypeError);assert.equal(n,0);}],
  ['nested getter never runs',()=>{let n=0;const x={};Object.defineProperty(x,'a',{enumerable:true,get(){n++;return 4;}});assert.throws(()=>cloneJsonValue({x}),TypeError);assert.equal(n,0);}],
  ['object Proxy traps never run',()=>{let n=0;const p=new Proxy({a:1},{getPrototypeOf(){n++;throw Error('trap');},ownKeys(){n++;throw Error('trap');}});assert.throws(()=>cloneJsonValue(p),/Proxy/);assert.equal(n,0);}],
  ['array Proxy traps never run',()=>{let n=0;const p=new Proxy([1],{get(){n++;throw Error('trap');},ownKeys(){n++;throw Error('trap');}});assert.throws(()=>cloneJsonValue(p),/Proxy/);assert.equal(n,0);}],
  ['isPlainObject rejects Proxy with no trap',()=>{let n=0;const p=new Proxy({}, {getPrototypeOf(){n++;throw Error('trap');}});assert.equal(isPlainObject(p),false);assert.equal(n,0);}],
  ['isJsonValue rejects Proxy with no trap',()=>{let n=0;const p=new Proxy({}, {getPrototypeOf(){n++;throw Error('trap');}});assert.equal(isJsonValue(p),false);assert.equal(n,0);}],
  ['revoked object Proxy rejected',()=>{const {proxy,revoke}=Proxy.revocable({},{});revoke();assert.throws(()=>cloneJsonValue(proxy),/Proxy/);}],
  ['revoked array Proxy rejected',()=>{const {proxy,revoke}=Proxy.revocable([],{});revoke();assert.throws(()=>cloneJsonValue(proxy),/Proxy/);}],
  ['nonenumerable object data rejected',()=>{const x={a:1};Object.defineProperty(x,'hidden',{value:1});assert.throws(()=>cloneJsonValue(x),TypeError);}],
  ['object symbol key rejected',()=>{const x={};x[Symbol('s')]=1;assert.throws(()=>cloneJsonValue(x),TypeError);}],
  ['array symbol key rejected',()=>{const x=[1];x[Symbol('s')]=1;assert.throws(()=>cloneJsonValue(x),TypeError);}],
  ['array extra nonenumerable key rejected',()=>{const x=[1];Object.defineProperty(x,'hidden',{value:2});assert.throws(()=>cloneJsonValue(x),TypeError);}],
  ['array nonenumerable index rejected',()=>{const x=[1];Object.defineProperty(x,'0',{value:1,enumerable:false});assert.throws(()=>cloneJsonValue(x),TypeError);}],
  ['sparse array rejected',()=>assert.throws(()=>cloneJsonValue([,1]),TypeError)],
  ['cyclic object rejected',()=>{const x={};x.self=x;assert.throws(()=>cloneJsonValue(x),TypeError);}],
  ['nonfinite rejected',()=>assert.throws(()=>cloneJsonValue({x:Infinity}),TypeError)],
  ['BigInt JSON value rejected',()=>assert.throws(()=>cloneJsonValue({x:1n}),TypeError)],
  ['function JSON value rejected',()=>assert.throws(()=>cloneJsonValue({x:()=>1}),TypeError)],
  ['node budget enforced',()=>assert.throws(()=>cloneJsonValue({a:1,b:2},{maxNodes:2}),TypeError)],
  ['depth budget enforced',()=>assert.throws(()=>cloneJsonValue({a:{b:1}},{maxDepth:1}),TypeError)],
  ['recursive freezing preserved',()=>{const x=cloneAndFreezeJson({a:[{b:1}]});assert.equal(Object.isFrozen(x),true);assert.equal(Object.isFrozen(x.a[0]),true);}],
  ['stableClone ordinary data preserved',()=>assert.deepEqual(stableClone({b:2,a:1}),{a:1,b:2})],
];
for (const [name,check] of checks) test('T22U '+name,check);
