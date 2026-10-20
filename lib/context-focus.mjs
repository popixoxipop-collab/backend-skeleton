import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { discoverOperationContext } from './context-discovery.mjs';

// Frozen Git-object-only navigation hint, NOT a trusted SBF packet or release gate.
const OID=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
// The parent discovery heuristic can rank any tracked Python file. A
// credential directory must never become focused source text. Exclude the
// entire focused result if any top-ranked source has a sensitive path.
function restrictedGitSourcePath(value){
  return /(^|\/)(?:secrets?|credentials?|private(?:_.*)?|tokens?|api_?keys?|id_rsa|id_ed25519)(\/|\.py$)/i.test(value)
    || value.split('/').some(part=>part.startsWith('.'));
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
function decoratorStart(lines,index){
  const indent=(lines[index].match(/^[ \t]*/)?.[0]??'');
  const hits=[];
  for(let i=index-1;i>=Math.max(0,index-120);i--){
    const line=lines[i];
    const same=(line.match(/^[ \t]*/)?.[0]??'')===indent;
    if(same && (/^\s*(?:async\s+)?def\s+/.test(line)||/^\s*(?:public|private|protected)\s+.*\(/.test(line)||/^\s*fun\s+/.test(line)))break;
    if(same&&GET_DECORATOR.test(line))hits.push(i);
  }
  return hits.length?Math.max(...hits):null;
}
function locate(lines,id,language){
  const matches=declarationLines(lines,language).filter(d=>d.symbol===id)
    .map(d=>({...d,decorator:decoratorStart(lines,d.index)}));
  const eligible=matches.filter(d=>d.decorator!==null);
  if(eligible.length!==1)return {status:eligible.length?'ambiguous_handler':'handler_not_decorated'};
  return {status:'found',...eligible[0]};
}
function focusWindow(text,id,language,maxBytes){
  const lines=text.match(/[^\n]*\n|[^\n]+$/g)??[];
  const m=locate(lines,id,language);
  if(m.status!=='found')return m;
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
    declaration_line:m.index+1,handler_symbol:m.symbol,excerpt_sha256:sha(bytes)};
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
  const restricted=selected.some(x=>restrictedGitSourcePath(x.path));
  const ranked=selected.filter(x=>!restrictedGitSourcePath(x.path))
    .map(x=>({path:x.path,score:x.score,declaring:x.signals.includes('handler_declaration'),
      sha256:x.sha256,git_oid:x.blob_oid}));
  let source=null,status='abstained',
    reason=restricted?'restricted_source_candidate':'no_decorated_declaring_source';
  const candidates=[];
  // Prune the lexical candidates with exact source-level GET decorator +
  // callable evidence, rather than interpreting a name match as a route.
  // All Git bytes are reloaded by validated immutable OIDs and hashed.
  for(const f of (restricted?[]:selected.filter(x=>x.signals.includes('handler_declaration')))){
    if(!OID.test(f.blob_oid)||f.bytes>262144)throw new Error('context focus: invalid Git source blob');
    const raw=git(repo,'cat-file','blob',f.blob_oid);
    if(raw.length!==f.bytes||sha(raw)!==f.sha256||raw.includes(0))
      throw new Error('context focus: source bytes differ from discovered Git receipt');
    let text;try{text=utf8.decode(raw);}catch{throw new Error('context focus: invalid source UTF-8');}
    if(!Buffer.from(text,'utf8').equals(raw))throw new Error('context focus: source encoding changed');
    const language=f.path.endsWith('.py')?'python':/\\.(?:kt|java)$/.test(f.path)?'jvm':'other';
    const window=focusWindow(text,operationId,language,65536);
    if(window.status==='found'||window.status==='excerpt_exceeds_budget')
      candidates.push({f,window,language});
  }
  if(candidates.length===1){
    const {f,window,language}=candidates[0];
    if(window.status==='found'&&window.bytes<=maxBytes){
      source={path:f.path,git_oid:f.blob_oid,source_sha256:f.sha256,source_bytes:f.bytes,
        language,trust:'untrusted-committed-source',...window};
      status=scan.selection.complete?'advisory_complete':'advisory_incomplete';
      reason=null;
    }else reason='excerpt_exceeds_budget';
  } else if(candidates.length>1){reason='multiple_decorated_sources';}
  else if(!restricted&&scan.selection.ambiguous){reason='ambiguous_ranked_candidates';}
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
