import { createHash } from 'node:crypto';
import {
  DEFAULT_MAX_SOURCE_BYTES,
  assertRepoRelativeXmlPath,
  decodeMujocoUtf8,
  discoverMujocoSource,
  mujocoSourceBytes,
} from './discover.mjs';

export const MUJOCO_SOURCE_SCHEMA = 'sbf.sim-mujoco-source/draft-1';
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const NUM = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ACTUATORS = new Set(['motor','position','velocity','general','cylinder','muscle','adhesion','intvelocity','damper']);
const SECTIONS = new Set(['actuator','sensor','contact','equality','tendon','asset','keyframe']);

function posInt(v, label) {
  if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return v;
}
function finite(v, label) {
  if (typeof v !== 'string' || !NUM.test(v)) throw new TypeError(`${label} must be a finite numeric literal`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TypeError(`${label} must be finite`);
  return n;
}
function vector(v, label, min = 1, max = Infinity) {
  if (v === undefined) return null;
  const parts = v.trim().split(/\s+/).filter(Boolean);
  if (parts.length < min || parts.length > max) throw new TypeError(`${label} has invalid vector length`);
  return parts.map((x, i) => finite(x, `${label}[${i}]`));
}
function entities(v) {
  return v.replace(/&([^;]+);/g, (_m, e) => {
    const fixed = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[e];
    if (fixed) return fixed;
    let cp = null;
    if (/^#\d+$/.test(e)) cp = Number(e.slice(1));
    if (/^#x[0-9a-f]+$/i.test(e)) cp = Number.parseInt(e.slice(2), 16);
    if (cp !== null && Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff) return String.fromCodePoint(cp);
    throw new Error(`unsupported XML entity &${e};`);
  });
}
function attrs(rest, label) {
  const out = {}; let i = 0;
  while (i < rest.length) {
    while (/\s/.test(rest[i] ?? '')) i++;
    if (i >= rest.length) break;
    const m = rest.slice(i).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
    if (!m) throw new Error(`${label} has malformed attribute syntax`);
    const k = m[1]; i += k.length;
    if (Object.hasOwn(out, k)) throw new Error(`${label} repeats attribute ${k}`);
    while (/\s/.test(rest[i] ?? '')) i++;
    if (rest[i++] !== '=') throw new Error(`${label} attribute ${k} must use =`);
    while (/\s/.test(rest[i] ?? '')) i++;
    const q = rest[i++];
    if (q !== '"' && q !== "'") throw new Error(`${label} attribute ${k} must be quoted`);
    const end = rest.indexOf(q, i);
    if (end < 0) throw new Error(`${label} attribute ${k} is unterminated`);
    const raw = rest.slice(i, end);
    if (raw.includes('<')) throw new Error(`${label} attribute ${k} contains illegal <`);
    out[k] = entities(raw); i = end + 1;
  }
  return out;
}
function tagEnd(text, start) {
  let q = null;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}
function xmlTree(text, {maxDepth, maxElements}) {
  if (/<!DOCTYPE\b/i.test(text) || /<!ENTITY\b/i.test(text)) throw new Error('MuJoCo XML must not declare DOCTYPE or ENTITY');
  const doc = {tag:'#doc', attrs:{}, children:[], locator:'#doc'}; const stack = [doc]; let count = 0; let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { if (text.slice(i).trim()) throw new Error('unexpected XML text'); break; }
    if (text.slice(i, lt).trim()) throw new Error('unsupported XML text node');
    if (text.startsWith('<!--', lt)) { const e=text.indexOf('-->',lt+4); if(e<0)throw new Error('unterminated XML comment'); i=e+3; continue; }
    if (text.startsWith('<?', lt)) { const e=text.indexOf('?>',lt+2); if(e<0)throw new Error('unterminated XML processing instruction'); i=e+2; continue; }
    if (text.startsWith('<!', lt)) throw new Error('unsupported XML declaration');
    const gt = tagEnd(text, lt); if (gt < 0) throw new Error('unterminated XML tag');
    let body = text.slice(lt+1, gt);
    if (body.startsWith('/')) {
      const n = body.slice(1).trim(); if (!NAME.test(n)) throw new Error('invalid closing element');
      const cur = stack.at(-1); if (stack.length===1 || cur.tag!==n) throw new Error(`mismatched closing element </${n}>`);
      stack.pop(); i=gt+1; continue;
    }
    const self = /\/\s*$/.test(body); if (self) body=body.replace(/\/\s*$/,'');
    const m = body.trim().match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/); if(!m)throw new Error('invalid XML element');
    const n=m[1], a=attrs(body.trim().slice(n.length), `element <${n}>`);
    if (++count > maxElements) throw new RangeError('MuJoCo XML exceeds element budget');
    if (stack.length > maxDepth) throw new RangeError('MuJoCo XML exceeds depth budget');
    const parent=stack.at(-1), idx=parent.children.filter(x=>x.tag===n).length+1;
    const node={tag:n,attrs:a,children:[],locator:parent.locator==='#doc'?`${n}[${idx}]`:`${parent.locator}/${n}[${idx}]`};
    parent.children.push(node); if(!self)stack.push(node); i=gt+1;
  }
  if(stack.length!==1)throw new Error(`MuJoCo XML has unclosed element <${stack.at(-1).tag}>`);
  if(doc.children.length!==1)throw new Error('MuJoCo XML must contain exactly one root element');
  return doc.children[0];
}
function id(kind, path, node) { return `${kind}:${createHash('sha256').update(`${path}\0${node.locator}\0${node.attrs.name??''}`).digest('hex').slice(0,20)}`; }
function copy(a, omit=[]) { return Object.fromEntries(Object.keys(a).sort().filter(k=>!omit.includes(k)).map(k=>[k,a[k]])); }
function walk(root) {
  const out=[]; const visit=(n,anc)=>{out.push({node:n,anc}); for(const c of n.children)visit(c,[...anc,n]);}; visit(root,[]); return out;
}
function section(anc) { for(let i=anc.length-1;i>=0;i--)if(SECTIONS.has(anc[i].tag))return anc[i].tag; return null; }
function localDep(v,label) {
  if(typeof v!=='string'||!v)throw new TypeError(`${label} must be a non-empty path`);
  if(v.includes('\0')||v.includes('\\')||v.startsWith('/')||/^[A-Za-z]:\//.test(v))throw new TypeError(`${label} must be repo-relative POSIX`);
  if(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v))throw new TypeError(`${label} must not use URI scheme`);
  if(v.split('/').some(p=>!p||p==='.'||p==='..'))throw new TypeError(`${label} must not contain parent/dot/empty segments`);
  return v;
}
function unique(items, kind) { const seen=new Set(); for(const x of items){if(!x.name)continue;if(seen.has(x.name))throw new Error(`duplicate ${kind} name: ${x.name}`);seen.add(x.name);} }

export function parseMjcfSource(sourceBytes, {path,maxBytes=DEFAULT_MAX_SOURCE_BYTES,maxDepth=64,maxElements=20000,maxDependencies=2000}={}) {
  posInt(maxDepth,'maxDepth'); posInt(maxElements,'maxElements'); posInt(maxDependencies,'maxDependencies');
  const raw=mujocoSourceBytes(sourceBytes); if(!Number.isSafeInteger(maxBytes)||maxBytes<=0)throw new TypeError('maxBytes must be positive');
  if(raw.byteLength>maxBytes)throw new RangeError('MuJoCo source exceeds byte budget');
  const sourcePath=assertRepoRelativeXmlPath(path), text=decodeMujocoUtf8(raw);
  if(!discoverMujocoSource(raw,{path:sourcePath,maxBytes}).detected)throw new Error('MuJoCo source root must be <mujoco>');
  const root=xmlTree(text,{maxDepth,maxElements}); if(root.tag!=='mujoco')throw new Error('MuJoCo source root must be <mujoco>');
  const flat=walk(root), bodyIds=new Map();
  const D={compiler:[],option:[],defaults:[],bodies:[],joints:[],geoms:[],sites:[],actuators:[],sensors:[],contacts:[],equalities:[],tendons:[],keyframes:[]};
  const deps=[], diagnostics=[];
  const parentBody=anc=>{for(let i=anc.length-1;i>=0;i--){const v=bodyIds.get(anc[i].locator);if(v)return v;}return null;};
  for(const {node,anc} of flat) if(node.tag==='body') { const x={id:id('body',sourcePath,node),source_locator:node.locator,source_order:D.bodies.length,name:node.attrs.name??null,parent_body_id:parentBody(anc),pos:vector(node.attrs.pos,'body.pos',3,3),declared_attributes:copy(node.attrs,['name','pos'])}; bodyIds.set(node.locator,x.id);D.bodies.push(x); }
  for(const {node,anc} of flat) {
    const sec=section(anc), pb=parentBody(anc), base=(kind,order)=>({id:id(kind,sourcePath,node),source_locator:node.locator,source_order:order});
    if(node.tag==='joint'&&pb){D.joints.push({...base('joint',D.joints.length),name:node.attrs.name??null,parent_body_id:pb,joint_type:node.attrs.type??'hinge',axis:vector(node.attrs.axis,'joint.axis',3,3),range:vector(node.attrs.range,'joint.range',2,2),declared_attributes:copy(node.attrs,['name','type','axis','range'])});continue;}
    if(node.tag==='geom'&&pb){D.geoms.push({...base('geom',D.geoms.length),name:node.attrs.name??null,parent_body_id:pb,geom_type:node.attrs.type??'sphere',size:vector(node.attrs.size,'geom.size',1,3),declared_attributes:copy(node.attrs,['name','type','size'])});continue;}
    if(node.tag==='site'&&pb){D.sites.push({...base('site',D.sites.length),name:node.attrs.name??null,parent_body_id:pb,pos:vector(node.attrs.pos,'site.pos',3,3),declared_attributes:copy(node.attrs,['name','pos'])});continue;}
    if(sec==='actuator'&&ACTUATORS.has(node.tag)){D.actuators.push({...base('actuator',D.actuators.length),actuator_type:node.tag,name:node.attrs.name??null,joint:node.attrs.joint??null,tendon:node.attrs.tendon??null,site:node.attrs.site??null,ctrlrange:vector(node.attrs.ctrlrange,'actuator.ctrlrange',2,2),gear:vector(node.attrs.gear,'actuator.gear',1,6),declared_attributes:copy(node.attrs,['name','joint','tendon','site','ctrlrange','gear'])});continue;}
    if(sec==='sensor'&&node.tag!=='sensor'){D.sensors.push({...base('sensor',D.sensors.length),sensor_type:node.tag,name:node.attrs.name??null,declared_attributes:copy(node.attrs,['name'])});continue;}
    if(sec==='contact'&&(node.tag==='pair'||node.tag==='exclude')){D.contacts.push({...base('contact',D.contacts.length),contact_type:node.tag,name:node.attrs.name??null,declared_attributes:copy(node.attrs,['name'])});continue;}
    if(sec==='equality'&&node.tag!=='equality'){D.equalities.push({...base('equality',D.equalities.length),equality_type:node.tag,name:node.attrs.name??null,declared_attributes:copy(node.attrs,['name'])});continue;}
    if(sec==='tendon'&&(node.tag==='spatial'||node.tag==='fixed')){D.tendons.push({...base('tendon',D.tendons.length),tendon_type:node.tag,name:node.attrs.name??null,declared_attributes:copy(node.attrs,['name']),elements:node.children.map(c=>({tag:c.tag,source_locator:c.locator,attributes:copy(c.attrs)}))});continue;}
    if(node.tag==='default'){D.defaults.push({...base('default',D.defaults.length),class_name:node.attrs.class??null,declared_attributes:copy(node.attrs,['class'])});continue;}
    if(sec==='keyframe'&&node.tag==='key'){D.keyframes.push({...base('keyframe',D.keyframes.length),name:node.attrs.name??null,time:node.attrs.time===undefined?null:finite(node.attrs.time,'key.time'),qpos:vector(node.attrs.qpos,'key.qpos'),qvel:vector(node.attrs.qvel,'key.qvel'),act:vector(node.attrs.act,'key.act'),ctrl:vector(node.attrs.ctrl,'key.ctrl')});continue;}
    if(node.tag==='include'){const p=localDep(node.attrs.file,'include file');deps.push({kind:'include',path:p,source_locator:node.locator,status:p===sourcePath?'cycle-self':'unresolved'});continue;}
    if(sec==='asset'&&node.attrs.file!==undefined){deps.push({kind:'asset',asset_type:node.tag,path:localDep(node.attrs.file,'asset file'),source_locator:node.locator,status:'unresolved'});continue;}
  }
  if(deps.length>maxDependencies)throw new RangeError('MuJoCo source exceeds dependency budget');
  if(deps.some(d=>d.status==='cycle-self'))throw new Error('MuJoCo source directly includes itself');
  for(const d of deps)diagnostics.push({code:'MUJOCO_DEPENDENCY_UNRESOLVED',path:d.path,source_locator:d.source_locator});
  for(const [k,kind] of [['bodies','body'],['joints','joint'],['geoms','geom'],['sites','site'],['actuators','actuator'],['sensors','sensor']])unique(D[k],kind);
  D.compiler=root.children.filter(n=>n.tag==='compiler').map(n=>({source_locator:n.locator,attributes:copy(n.attrs)}));
  D.option=root.children.filter(n=>n.tag==='option').map(n=>({source_locator:n.locator,attributes:copy(n.attrs),timestep:n.attrs.timestep===undefined?null:finite(n.attrs.timestep,'option.timestep'),gravity:vector(n.attrs.gravity,'option.gravity',3,3)}));
  return {schema:MUJOCO_SOURCE_SCHEMA,target:'SIM-mujoco',source:{path:sourcePath,media_type:'application/xml',byte_sha256:createHash('sha256').update(raw).digest('hex'),size_bytes:raw.byteLength},model:{name:root.attrs.model??null,source_locator:root.locator},declarations:D,dependencies:deps,diagnostics,claims:{declared_structure_only:true,effective_model_verified:false,runtime_behavior_verified:false,causal_edges_verified:false}};
}

export function validateMujocoDependencyGraph({rootPath,edges,maxNodes=10000}={}) {
  const root=assertRepoRelativeXmlPath(rootPath,'dependency root'); posInt(maxNodes,'maxNodes'); if(!Array.isArray(edges))throw new TypeError('edges must be an array');
  const adj=new Map(), nodes=new Set([root]);
  for(const e of edges){if(!e||typeof e!=='object')throw new TypeError('dependency edge must be object');const from=assertRepoRelativeXmlPath(e.from,'edge.from'),to=localDep(e.to,'edge.to');nodes.add(from);nodes.add(to);if(nodes.size>maxNodes)throw new RangeError('dependency graph exceeds node budget');adj.set(from,[...(adj.get(from)??[]),to]);}
  const visiting=new Set(),done=new Set();
  const dfs=(n,trail)=>{if(visiting.has(n))throw new Error(`MuJoCo dependency cycle detected: ${[...trail,n].join(' -> ')}`);if(done.has(n))return;visiting.add(n);for(const x of adj.get(n)??[])dfs(x,[...trail,n]);visiting.delete(n);done.add(n);};
  dfs(root,[]); return {valid:true,root,nodes:[...nodes].sort(),edge_count:edges.length};
}
