import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { discoverOperationContext, executableText } from './context-discovery.mjs';
import { isSensitiveContextSourcePath } from './context-source-policy.mjs';

// Frozen Git-object-only navigation hint, NOT a trusted SBF packet or release gate.
const OID=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
// The parent discovery heuristic can rank any tracked Python file. A
// credential directory must never become focused source text. Exclude the
// entire focused result if any top-ranked source has a sensitive path.
function restrictedGitSourcePath(value){
  return isSensitiveContextSourcePath(value);
}
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
function git(root,...args){
  try { return execFileSync('git',['--no-optional-locks','--literal-pathspecs',...args],{
    cwd:root,stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:400000,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'}
  }); }catch{throw new Error('context focus: immutable local Git object unavailable');}
}
function canonical(x){
  if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
  if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
  return JSON.stringify(x);
}
const GET_DECORATOR=/^\s*@(?:(?:[A-Za-z_$][\w$]*\.)?get|GetMapping)\s*\(/;
const FUNC_PY=/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const FUNC_JVM=/^\s*(?:(?:public|private|protected|static|final|override|suspend|internal)\s+)*(?:(?:[A-Za-z_][\w<>,.?\[\]]*|fun|[A-Za-z_]\w*(?:<[^>]+>)?)\s+)+([A-Za-z_]\w*)\s*\(/;
function declarationLines(lines,language){
  const re=language==='python'?FUNC_PY:language==='jvm'?FUNC_JVM:/\b(?:async\s+)?(?:function\s+)?([A-Za-z_]\w*)\s*\(/;
  const out=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(line.trim().startsWith('//')||line.trim().startsWith('#')||line.trim().startsWith('*'))continue;
    const m=line.match(re);
    if(m)out.push({index:i,symbol:m[1]});
  }
  return out;
}
// A route decorator belongs to the callable only when the entire intervening
// sequence is an uninterrupted decorator stack. A class, assignment, docstring
// or unrelated statement is a hard barrier, including at identical indentation.
function parseOwnedDecorators(structural,original,first,decl,indent){
  let pos=first;
  const stack=[];
  while(pos<decl){
    const code=structural[pos].trim(),raw=original[pos].trim();
    if(!code){
      if(raw===''||raw.startsWith('#')){pos++;continue;}
      return null;
    }
    if((structural[pos].match(/^[ \t]*/)?.[0]??'')!==indent ||
      !/^@[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\s*\(|\s*$)/.test(code))return null;
    const begin=pos;
    let depth=0,opened=false,end=pos;
    for(;end<decl;end++){
      for(const ch of structural[end]){
        if(ch==='('){depth++;opened=true;}
        else if(ch===')'){depth--;if(depth<0)return null;}
      }
      if(!opened)break;
      if(depth===0)break;
    }
    if(end>=decl||depth!==0)return null;
    if(opened&&!structural[end].trimEnd().endsWith(')'))return null;
    if(!opened&&!/^@[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*$/.test(code))return null;
    stack.push({first:begin,last:end});
    pos=end+1;
  }
  return pos===decl&&stack.length?stack:null;
}
function decoratorStart(structural,original,index){
  const indent=(structural[index].match(/^[ \t]*/)?.[0]??'');
  const valid=[];
  for(let first=Math.max(0,index-120);first<index;first++){
    if(!GET_DECORATOR.test(structural[first]))continue;
    const ownership=parseOwnedDecorators(structural,original,first,index,indent);
    if(ownership)valid.push(first);
  }
  return valid.length===1?valid[0]:null;
}
function locate(structural,original,id,language){
  const matches=declarationLines(structural,language).filter(d=>d.symbol===id)
    .map(d=>({...d,decorator:decoratorStart(structural,original,d.index)}));
  const eligible=matches.filter(d=>d.decorator!==null);
  if(eligible.length!==1)return {status:eligible.length?'ambiguous_handler':'handler_not_decorated'};
  return {status:'found',...eligible[0]};
}
function verifyDecoratorRoute(lines,deco,decl,language,expected){
  // Only a direct, statically quoted GET argument is sufficient to claim
  // an exact local route. An arbitrary expression can evaluate differently
  // from its first literal (conditionals, concatenation, indexing, tuples).
  // Anchor at the owned decorator, never search for a fake nested string.
  const annotation=lines.slice(deco,decl).join('').trimStart();
  const pattern=language==='jvm'
    ? /^@GetMapping\s*\(\s*(?:(?:path|value)\s*=\s*)?(["'])([^"'\\]*)\1\s*(?=,|\))/
    : /^@(?:[A-Za-z_$][\w$]*\.)?get\s*\(\s*(?:path\s*=\s*)?(["'])([^"'\\]*)\1\s*(?=,|\))/;
  const match=annotation.match(pattern);
  if(!match)return {verification:'dynamic_or_unresolved',literal_route:null};
  const route=match[2];
  if(route===expected)return {verification:'exact',literal_route:route};
  if(route&&route.startsWith('/')&&expected.endsWith(route)&&expected.length>route.length)
    return {verification:'router_prefix_unverified',literal_route:route};
  return {verification:'mismatch',literal_route:route};
}
function hasLocalNonemptyRouterPrefix(lines,language){
  // Conservative and fail-closed. We do not evaluate arbitrary Java array
  // values, Python tuples, keyword splats or variable expressions used to
  // configure a class/router prefix. Any local evidence of prefix routing
  // makes a full-path claim unverified instead of guessing its value.
  const text=lines.join('');
  if(language==='jvm')return /@RequestMapping\b/.test(text);
  if(language!=='python')return false;
  const makesRouter=/\b(?:APIRouter|include_router)\s*\(/.test(text);
  if(!makesRouter)return false;
  return /\bprefix\s*=/.test(text)||/\*\*/.test(text);
}
function focusWindow(text,id,language,maxBytes,expectedRoute){
  const lines=text.match(/[^\n]*\n|[^\n]+$/g)??[];
  // The route/declaration locator must not count line comments or embedded
  // Python triple-quoted docstrings as executable decorator declarations.
  // The mask preserves positions and line breaks but strips string contents.
  const structural=executableText(text,true).match(/[^\n]*\n|[^\n]+$/g)??[];
  // Literal route strings must remain available, but comment/docstring
  // contents cannot be allowed to inject another apparent GET decorator.
  const routeSource=executableText(text,false).match(/[^\n]*\n|[^\n]+$/g)??[];
  if(structural.length!==lines.length||routeSource.length!==lines.length)
    throw new Error('context focus: source lexical line map changed');
  const m=locate(structural,lines,id,language);
  if(m.status!=='found')return m;
  let route=verifyDecoratorRoute(routeSource,m.decorator,m.index,language,expectedRoute);
  if(route.verification==='exact'&&hasLocalNonemptyRouterPrefix(routeSource,language))
    route={...route,verification:'router_prefix_unverified'};
  // A nested Python decorator may live inside a branch, loop, factory or
  // otherwise unexecuted scope. Local source cannot certify registration.
  if(route.verification==='exact'&&language==='python'&&
     (lines[m.index].match(/^[ \t]*/)?.[0]??'').length>0)
    route={...route,verification:'nested_scope_unverified'};
  if(route.verification==='mismatch')
    return {status:'decorator_route_mismatch',literal_route:route.literal_route};
  let end=m.index,depth=0,opened=false;
  for(let i=m.index;i<Math.min(lines.length,m.index+30);i++){
    for(const c of lines[i]){if(c==='('){depth++;opened=true;}else if(c===')')depth--;}
    end=i;
    if(opened&&depth<=0&&(language!=='python'||lines[i].includes(':')))break;
  }
  // Keep a few implementation lines, but never consume a later endpoint's
  // decorator or another same-level callable. This avoids mixing routes.
  const indent=lines[m.index].match(/^[ \t]*/)?.[0]??'';
  let endBound=Math.min(lines.length,end+7);
  for(let j=end+1;j<endBound;j++){
    const here=lines[j],level=here.match(/^[ \t]*/)?.[0]??'';
    if(level.length<=indent.length &&
       (/^\s*@/.test(here)||/^\s*(?:async\s+)?def\s+/.test(here)||
        /^\s*(?:public|private|protected|fun)\s+/.test(here))){
      endBound=j;break;
    }
  }
  end=endBound;
  const excerpt=lines.slice(m.decorator,end).join('');
  const bytes=Buffer.from(excerpt,'utf8');
  if(bytes.length>maxBytes)return {status:'excerpt_exceeds_budget',required_bytes:bytes.length};
  return {status:'found',excerpt,bytes:bytes.length,
    line_range:{start:m.decorator+1,end},decorator_line:m.decorator+1,
    declaration_line:m.index+1,handler_symbol:m.symbol,excerpt_sha256:sha(bytes),
    contract_route:expectedRoute,decorator_route:route.literal_route,
    route_verification:route.verification};
}
export function focusOperationContext({
  repoRoot,contractPath,operationId,revision='HEAD',
  maxScanFiles=2500,maxScanBytes=8*1024*1024,maxBytes=8192,maxCandidates=4
}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<128||maxBytes>65536)
    throw new Error('context focus: invalid max-bytes');
  if(!Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>16)
    throw new Error('context focus: invalid max-candidates');
  const repo=path.resolve(repoRoot);
  const scan=discoverOperationContext({repoRoot:repo,contractPath,operationId,
    revision,maxScanFiles,maxScanBytes,maxSelectedFiles:maxCandidates});
  const selected=scan.selection.selected;
  const unsupportedMethod=scan.contract.method!=='GET';
  const restricted=selected.some(x=>restrictedGitSourcePath(x.path));
  const ranked=selected.filter(x=>!restrictedGitSourcePath(x.path))
    .map(x=>({path:x.path,score:x.score,declaring:x.signals.includes('handler_declaration'),
      sha256:x.sha256,git_oid:x.blob_oid}));
  let source=null,status='abstained',
    reason=unsupportedMethod?'unsupported_contract_method':
      restricted?'restricted_source_candidate':'no_decorated_declaring_source';
  const candidates=[];
  // Prune the lexical candidates with exact source-level GET decorator +
  // callable evidence, rather than interpreting a name match as a route.
  // All Git bytes are reloaded by validated immutable OIDs and hashed.
  for(const f of ((restricted||unsupportedMethod)?[]:
    selected.filter(x=>x.signals.includes('handler_declaration')))){
    if(!OID.test(f.blob_oid)||f.bytes>262144)throw new Error('context focus: invalid Git source blob');
    const raw=git(repo,'cat-file','blob',f.blob_oid);
    if(raw.length!==f.bytes||sha(raw)!==f.sha256||raw.includes(0))
      throw new Error('context focus: source bytes differ from discovered Git receipt');
    let text;try{text=utf8.decode(raw);}catch{throw new Error('context focus: invalid source UTF-8');}
    if(!Buffer.from(text,'utf8').equals(raw))throw new Error('context focus: source encoding changed');
    const language=f.path.endsWith('.py')?'python':/\.(?:kt|java)$/.test(f.path)?'jvm':'other';
    const window=focusWindow(text,operationId,language,65536,scan.contract.route);
    if(window.status==='found'||window.status==='excerpt_exceeds_budget')
      candidates.push({f,window,language});
    else if(window.status==='decorator_route_mismatch')
      reason='decorator_route_mismatch';
  }
  if(candidates.length===1){
    const {f,window,language}=candidates[0];
    if(window.status==='found'&&window.bytes<=maxBytes){
      source={path:f.path,git_oid:f.blob_oid,source_sha256:f.sha256,source_bytes:f.bytes,
        language,trust:'untrusted-committed-source',...window};
      status=scan.selection.complete&&window.route_verification==='exact'
        ?'advisory_complete':'advisory_incomplete';
      reason=null;
    }else reason='excerpt_exceeds_budget';
  } else if(candidates.length>1){reason='multiple_decorated_sources';}
  else if(!restricted&&!unsupportedMethod&&scan.selection.ambiguous){reason='ambiguous_ranked_candidates';}
  const body={
    schema:'bskel.context-focus/1',repository:scan.repository,contract:scan.contract,
    status,reason,
    discovery:{complete:scan.selection.complete,confidence:scan.selection.confidence,
      incomplete_reasons:scan.selection.incomplete_reasons,source_files_inspected:scan.inventory.inspected_files,
      candidates:ranked,omitted_matching_candidates:scan.selection.omitted_matching_candidates},
    focus:{selected:source,read_only:true,source_files_selected:source?1:0,
      source_excerpt_bytes:source?.bytes??0,max_excerpt_bytes:maxBytes,
      warning:'Untrusted navigation evidence only; not SBF packet, BEVAL validation, execution permission or release gate'}
  };
  return {...body,focus_sha256:sha(canonical(body))};
}
