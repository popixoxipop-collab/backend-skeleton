import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scanWebgame} from '../../scanners/webgame.mjs';
import {buildWebgameContract} from '../../contracts/webgame.mjs';
import {buildUnityTextSceneExport} from '../../adapters/game-next/native-text-source-exporters.mjs';
import {
 createNativeExportEnvelope,createNativeSourceRef,verifyNativeExportEnvelope,
} from '../../adapters/game-next/native-export-envelope.mjs';
import {
 normalizeNativeStructureExport,verifyNativeStructureInvariants,
} from '../../adapters/game-next/native-structure-normalizer.mjs';

const producer={id:'t19-wave6-native-source-probe',version:'0-test',implementation_sha256:'5'.repeat(64)};
function gameRoot(t,source) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'t19-wave6-three-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'src'),{recursive:true});
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'fixture',dependencies:{three:'^0.180.0'}}));
 fs.writeFileSync(path.join(root,'src/game.ts'),source);
 return root;
}
function native(engine,payload) {
 const bytes=Buffer.from(JSON.stringify(payload),'utf8');
 const inputBytes=Buffer.from('source-marker');
 const input=createNativeSourceRef(inputBytes,{path:'game/input.src'});
 const envelope=createNativeExportEnvelope(bytes,{
  engine,evidenceClass:'source-export',engineVersion:'fixture',
  platform:'source-only',producer,sourceInputs:[input],
 });
 assert.deepEqual(verifyNativeExportEnvelope(envelope,{
  sourceBytes:bytes,sourceInputBytes:{'game/input.src':inputBytes},
 }),{valid:true,errors:[]});
 return {envelope,normalized:normalizeNativeStructureExport(bytes,envelope)};
}

export function checkWebgameInputCausalityUnknown(t) {
 const source=[
  "import * as THREE from 'three';",
  'const scene = new THREE.Scene();',
  'const player = new THREE.Mesh();',
  'scene.add(player);',
  'function updatePlayer(dt) { player.position.x += dt; }',
  'function animate() { requestAnimationFrame(animate); updatePlayer(1/60); }',
  'function onKey(e) { if(e.code === "KeyW") updatePlayer(1); }',
  "window.addEventListener('keydown', onKey);",
  'animate();',
 ].join('\n');
 const scan=scanWebgame(gameRoot(t,source));
 assert.ok(scan.input.listeners.some(x=>x.event==='keydown'&&x.handler==='onKey'));
 assert.ok(scan.simulation.systems.some(x=>x.symbol==='updatePlayer'));
 assert.ok(scan.warnings.some(x=>x.code==='WEBGAME_INPUT_EFFECT_UNRESOLVED'),
  'nearby declarations cannot imply causal graph or verified runtime behavior');
 const contract=buildWebgameContract({
  featureId:'001-wave6',featureUid:'11111111-1111-4111-8111-111111111111',scan,
 });
 assert.ok(contract.planes.behavior.triggers.some(x=>x.kind==='input-listener'));
 assert.ok(contract.planes.behavior.systems.some(x=>x.symbol==='updatePlayer'));
 assert.deepEqual(Object.keys(contract.planes.behavior).sort(),['systems','triggers']);

}

export function checkNativeSourceNotSelfCertified() {
 const {envelope}=native('godot',{schema:'sbf.game-godot-scene-export/draft-1',
   scenes:[{path:'res://player.tscn',nodes:[{path:'.',name:'Main',type:'Node3D'}],
    resources:[],signal_connections:[]}]});
 assert.deepEqual(envelope.claims,{
  producer_identity_verified:false,runtime_behavior_verified:false,
  causal_edges_verified:false,state_transitions_verified:false,
 });
 const selfCertified=structuredClone(envelope);
 selfCertified.claims.causal_edges_verified=true;
 assert.ok(verifyNativeExportEnvelope(selfCertified).errors.includes('claims.causal_edges_verified'));

}

export function checkGodotSceneScopedIdentity() {
 const payload={schema:'sbf.game-godot-scene-export/draft-1',scenes:[
  {path:'res://levels/one.tscn',nodes:[{path:'.',name:'Hero',type:'Node3D'}],
   resources:[],signal_connections:[]},
  {path:'res://levels/two.tscn',nodes:[{path:'.',name:'Hero',type:'Node3D'}],
   resources:[],signal_connections:[]},
 ]};
 let normalized, failure=null;
 try { normalized=native('godot',payload).normalized; }
 catch (error) { failure=error; }
 // This checks the identical non-throw contract without serializing a nested
 // exception stack into the bounded TAP tail during a mutant run.
 assert.equal(failure===null,true,
  'different scene/object identities may share a local name without collision');
 const heroes=normalized.nodes.filter(x=>x.name==='Hero');
 assert.deepEqual(heroes.map(x=>x.id),[
  'godot:node:res://levels/one.tscn:.',
  'godot:node:res://levels/two.tscn:.',
 ]);
 assert.deepEqual(verifyNativeStructureInvariants(normalized),{valid:true,errors:[]});

}

export function checkUnrealBlueprintRemainsUnexported() {
 const {normalized}=native('unreal',{
  schema:'sbf.game-unreal-structure-export/draft-1',
  types:[{id:'ActorA',kind:'class',name:'Player',specifiers:['Blueprintable'],
   properties:[],functions:[{name:'HandleHit',specifiers:['BlueprintImplementableEvent']}]}],
 });
 assert.equal(normalized.status,'declared-structure-only');
 assert.ok(normalized.nodes.some(x=>x.id==='unreal:function:ActorA:HandleHit'&&
  x.specifiers.includes('BlueprintImplementableEvent')));
 assert.deepEqual(normalized.relations.map(x=>x.kind),['declares']);
 assert.deepEqual(normalized.declarations.rpc,[]);
 assert.deepEqual(normalized.claims,{
  producer_identity_verified:false,source_structure_verified:false,
  runtime_behavior_verified:false,causal_edges_verified:false,
  state_transitions_verified:false,
 });
 assert.deepEqual(verifyNativeStructureInvariants(normalized),{valid:true,errors:[]});

}

export function checkUnityExactGuidSourceBinding() {
 const oldGuid='9cbd8cdf99d44b58972fbc7f6f38088f';
 const newGuid='9cbd8cdf99d44b58972fbc7f6f380880';
 const source=Buffer.from([
  '%YAML 1.1','%TAG !u! tag:unity3d.com,2011:',
  '--- !u!1 &6','GameObject:','  m_Name: Player',
  '--- !u!114 &50','MonoBehaviour:',
  '  m_GameObject: {fileID: 6}',
  '  m_Script: {fileID: 11500000, guid: '+oldGuid+', type: 3}',
  '',
 ].join('\n'),'utf8');
 const make=raw=>buildUnityTextSceneExport(raw,{
  path:'Assets/Scenes/Main.unity',engineVersion:'6000-test',
  platform:'source-only',producer,
 });
 const before=make(source);
 const normalized=normalizeNativeStructureExport(before.payload_bytes,before.envelope);
 const oldRef=normalized.relations.find(x=>x.kind==='serialized-reference');
 assert.ok(oldRef);
 assert.equal(oldRef.target_file_id,'11500000');
 assert.equal(oldRef.target_guid,oldGuid);
 const changed=Buffer.from(source.toString('utf8').replace(oldGuid,newGuid),'utf8');
 const check=verifyNativeExportEnvelope(before.envelope,{
  sourceBytes:before.payload_bytes,
  sourceInputBytes:{'Assets/Scenes/Main.unity':changed},
 });
 assert.equal(check.valid,false,'a changed serialized GUID cannot authenticate using prior source bytes');
 assert.deepEqual(check.errors,['source_input_bytes.mismatch:Assets/Scenes/Main.unity']);
 const after=make(changed);
 assert.notEqual(before.source_inputs[0].artifact.byte_sha256,after.source_inputs[0].artifact.byte_sha256);
 const newRef=normalizeNativeStructureExport(after.payload_bytes,after.envelope)
  .relations.find(x=>x.kind==='serialized-reference');
 assert.ok(newRef);
 assert.equal(newRef.target_guid,newGuid);
 assert.notEqual(oldRef.target_guid,newRef.target_guid);

}
