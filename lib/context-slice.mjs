import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { focusOperationContext } from './context-focus.mjs';
import { isSensitiveContextSourcePath } from './context-source-policy.mjs';

// Advisory only: source bytes are untrusted data; no source code is executed.
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const OID=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sha=b=>createHash('sha256').update(b).digest('hex');
function git(root,...args) {
  try{return execFileSync('git',['--no-optional-locks','--literal-pathspecs',...args],{
    cwd:root,timeout:12000,maxBuffer:12_000_000,stdio:['ignore','pipe','pipe'],
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1'}
  });}catch{throw new Error('context slice: immutable local Git source unavailable');}
}
function canonical(x){
  if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
  if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
  return JSON.stringify(x);
}
function requireLimit(n,low,high,label){
  if(!Number.isSafeInteger(n)||n<low||n>high)throw new Error('context slice: invalid '+label);
}
function lines(s){return s.match(/[^\n]*\n|[^\n]+$/g)??[];}
function indent(s){return (s.match(/^[ \t]*/)?.[0]??'').length;}
function rx(s){return s.replace(/[.*+?^$()|{}[\]\\]/g,'\\$&');}
function clean(s){
  // Quote/comment-aware lexical mask used only as conservative evidence.
  // Preserve all real newlines, including after Python # line comments.
  const out=[];
  let state='code',delimiter='',triple=false;
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(state==='comment'){
      if(c==='\n'){out.push('\n');state='code';}
      else out.push(' ');
      continue;
    }
    if(state==='string'){
      if(triple&&s.slice(i,i+3)===delimiter.repeat(3)){
        out.push(' ',' ',' ');i+=2;state='code';continue;
      }
      if(!triple&&c==='\\'&&i+1<s.length){
        out.push(' ');
        const escaped=s[++i];
        out.push(escaped==='\n'?'\n':' ');
        continue;
      }
      if(!triple&&c===delimiter){out.push(' ');state='code';continue;}
      out.push(c==='\n'?'\n':' ');
      continue;
    }
    if(c==='#'){state='comment';out.push(' ');continue;}
    if(c==='"'||c==="'"){
      delimiter=c;triple=s.slice(i,i+3)===c.repeat(3);state='string';
      if(triple){out.push(' ',' ',' ');i+=2;}
      else out.push(' ');
      continue;
    }
    out.push(c);
  }
  return out.join('');
}
function used(s,symbol,member=false){
  return new RegExp('(?:^|[^A-Za-z0-9_])'+rx(symbol)+(member?'\\s*\\.':'(?![A-Za-z0-9_])')).test(s);
}
function treeMap(repo,commit){
  const raw=git(repo,'ls-tree','-r','-z','--full-tree',commit);
  let s;try{s=utf8.decode(raw);}catch{throw new Error('context slice: invalid UTF-8 path');}
  const map=new Map();
  for(const line of s.split('\0').filter(Boolean)){
    const tab=line.indexOf('\t');if(tab<0)throw new Error('context slice: invalid tree entry');
    const [mode,type,oid]=line.slice(0,tab).split(' '),file=line.slice(tab+1);
    if(!OID.test(oid)||!file||file.startsWith('/')||file.includes('\\')||
      file.split('/').some(t=>!t||t==='.'||t==='..')||map.has(file))throw new Error('context slice: bad Git path');
    if(type==='blob'&&['100644','100755'].includes(mode))map.set(file,{oid});
  }
  return map;
}
function readBlob(repo,record){
  const n=Number(git(repo,'cat-file','-s',record.oid).toString().trim());
  if(!Number.isSafeInteger(n)||n<0||n>262144)throw new Error('context slice: blob size limit');
  const data=git(repo,'cat-file','blob',record.oid);
  if(data.length!==n||data.includes(0))throw new Error('context slice: invalid blob bytes');
  let text;try{text=utf8.decode(data);}catch{throw new Error('context slice: non UTF-8 blob');}
  if(!Buffer.from(text).equals(data))throw new Error('context slice: non-canonical UTF-8 blob');
  return {raw:data,text};
}
function localModule(module,sourceFile,available){
  if(typeof module!=='string'||!/^\.{0,3}[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(module))
    return {kind:'invalid',paths:[]};
  const dots=module.match(/^\.+/)?.[0].length??0;
  let stem;
  if(dots>0){
    let parent=path.posix.dirname(sourceFile);
    for(let i=1;i<dots;i++)parent=path.posix.dirname(parent);
    stem=path.posix.join(parent,...module.slice(dots).split('.').filter(Boolean));
  }else stem=module.replaceAll('.','/');
  const targets=[stem+'.py',path.posix.join(stem,'__init__.py')];
  let paths=targets.filter(p=>available.has(p));
  // Never map an absolute import to a sole coincidental basename in a
  // different package root. Such resolution requires a trusted package map.
  if(!dots&&!paths.length){
    const matches=[...available.keys()].filter(p=>targets.some(t=>p.endsWith('/'+t)));
    if(matches.length)return {kind:'unresolved_root',paths:[]};
  }
  const accepted=paths.filter(p=>p.endsWith('.py')&&
    !/(^|\/)(?:tests?|__tests__|fixtures?|generated|vendor|\.venv)(\/|$)/i.test(p)&&
    !isSensitiveContextSourcePath(p)&&
    !p.split('/').some(x=>x.startsWith('.')));
  if(paths.length&&!accepted.length)return {kind:'restricted',paths:[]};
  paths=accepted;
  return {kind:paths.length===1?'local':paths.length?'ambiguous':'external',paths:[...new Set(paths)].sort()};
}
function extractPythonRange(text,start,declaration,maxLines,requiresSignature){
  const original=lines(text),visible=lines(clean(text));
  const base=indent(original[declaration]??'');
  let depth=0,opened=false,signatureComplete=!requiresSignature;
  let explicitContinuation=false;
  let end=original.length;
  for(let i=declaration;i<original.length;i++){
    const line=visible[i]??'';
    // Explicit backslash continuations are valid Python despite the next
    // line having zero indentation. They must never end a source slice.
    if(i>declaration&&signatureComplete&&depth===0&&!explicitContinuation&&line.trim()&&
       indent(original[i])<=base){end=i;break;}
    if(i-start>=maxLines)return {error:'python_block_line_budget',required_lines:i-start+1};
    for(const c of line){
      if(c==='('||c==='['||c==='{'){depth++;if(c==='(')opened=true;}
      else if(c===')'||c===']'||c==='}')depth=Math.max(0,depth-1);
      if(!signatureComplete&&opened&&depth===0&&c===':')signatureComplete=true;
    }
    explicitContinuation=line.trimEnd().endsWith('\\');
  }
  if(!signatureComplete)return {error:'python_signature_unclosed'};
  if(explicitContinuation)return {error:'python_explicit_continuation_unclosed'};
  if(end-start>maxLines)return {error:'python_block_line_budget',required_lines:end-start};
  if(end<=start)return {error:'python_block_empty'};
  const excerpt=original.slice(start,end).join('');
  return {excerpt,bytes:Buffer.byteLength(excerpt),line_range:{start:start+1,end}};
}
function handlerBlock(text,focused,maxLines){
  const all=lines(text),start=focused.line_range.start-1,decl=focused.declaration_line-1;
  if(start<0||decl<start||decl>=all.length)return {error:'invalid_focus_source_range'};
  return extractPythonRange(text,start,decl,maxLines,true);
}
function symbolBlock(text,symbol,maxLines=80){
  const all=lines(text);
  const m=new RegExp('^([ \\t]*)(?:(?:async\\s+)?def\\s+|class\\s+)'+rx(symbol)+'(?:\\s*\\(|\\s*:|\\b)');
  const scalar=new RegExp('^([ \\t]*)'+rx(symbol)+'\\s*=');
  const found=[];
  for(let i=0;i<all.length;i++)if(m.test(all[i])||scalar.test(all[i]))found.push(i);
  if(found.length!==1)return {error:found.length?'ambiguous_dependency_symbol':'dependency_symbol_not_found'};
  const decl=found[0],line=all[decl],tab=indent(line);
  let start=decl;
  // One-line decorators and their immediate continuation lines are included
  // only if a same-level decorator precedes this symbol.
  for(let j=decl-1;j>=Math.max(0,decl-80);j--){
    const t=all[j];if(!t.trim())break;
    if(indent(t)<tab)break;
    if(indent(t)===tab&&/^\s*@/.test(t)){start=j;continue;}
    if(indent(t)===tab&&/^\s*(?:async\s+)?def\s+/.test(t))break;
  }
  const def=/^\s*(?:async\s+)?def\s+/.test(line);
  const result=extractPythonRange(text,start,decl,maxLines,def);
  if(result.error)return result;
  return {...result,symbol};
}
function referencedImports(fullSource,handlerText,file,available){
  const present=clean(handlerText),found=[],warn=[];
  const source=clean(fullSource).split(/\r?\n/);
  // Every source byte was already bounded to <=256 KiB by Git readBlob; do
  // not silently stop after 400 lines and claim complete dependency coverage.
  // Also reject aliases created with "from importlib import import_module":
  // importing the call helper itself does not resolve the dynamic target.
  if(/\b(?:importlib\s*\.\s*import_module|__import__|import_module)\s*\(/.test(present))
    warn.push({reason:'dynamic_import_not_resolved'});
  // Embedded f-string expressions may execute imported helpers, but this
  // lexical matcher deliberately does not parse inside quoted Python text.
  if(/(?:^|[^A-Za-z0-9_])(?:[fF][rR]?|[rR][fF])(?:["'])/.test(handlerText))
    warn.push({reason:'f_string_expression_not_resolved'});
  for(const [i,line] of source.entries()){
    const m=line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+?)\s*$/);
    if(m){
      const [,module,names]=m;
      if(names.includes('(')||names.includes('*')){
        warn.push({reason:'complex_import_not_traced',line:i+1});continue;
      }
      for(const n of names.split(',')){
        const bits=n.trim().match(/^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/);
        if(!bits){warn.push({reason:'complex_import_not_traced',line:i+1});continue;}
        const symbol=bits[1],alias=bits[2]??symbol;
        if(!used(present,alias))continue;
        if(module==='importlib'&&symbol==='import_module'){
          warn.push({reason:'dynamic_import_not_resolved',line:i+1,alias});
          continue;
        }
        // A symbol imported from a package may itself be a module.
        const member=localModule(module+'.'+symbol,file,available);
        if(member.kind!=='external'){
          warn.push({reason:'package_module_member_not_resolved',line:i+1,
                     module,symbol,kind:member.kind});
          continue;
        }
        const result=localModule(module,file,available);
        if(result.kind==='local')found.push({path:result.paths[0],symbol,alias,line:i+1});
        else if(result.kind==='external'&&module.startsWith('.'))
          warn.push({reason:'unresolved_relative_import',line:i+1,module,symbol});
        else if(result.kind==='ambiguous'||result.kind==='invalid'||result.kind==='restricted'||result.kind==='unresolved_root')
          warn.push({reason:'ambiguous_or_invalid_import',line:i+1,module,symbol,kind:result.kind});
      }
      continue;
    }
    const ordinary=line.match(/^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/);
    if(ordinary){
      const module=ordinary[1];
      const rootAlias=ordinary[2]??module.split('.')[0];
      const hit=used(present,rootAlias,true);
      if(hit){
        const result=localModule(module,file,available);
        if(module==='importlib')
          warn.push({reason:'dynamic_import_not_resolved',line:i+1,module});
        else if(result.kind!=='external')
          warn.push({reason:'module_member_not_resolved',line:i+1,module,kind:result.kind});
      }
    }else if(/^\s*(?:import|from)\s+/.test(line)){
      warn.push({reason:'complex_import_not_traced',line:i+1});
    }
  }
  return {found:found.filter((r,i,a)=>a.findIndex(s=>s.path===r.path&&s.symbol===r.symbol)===i),warn};
}
export function sliceOperationContext({
  repoRoot,contractPath,operationId,revision='HEAD',maxBytes=8192,
  maxDependencies=3,maxHandlerLines=100,maxScanFiles=2500,maxScanBytes=8*1024*1024,maxCandidates=4
}){
  requireLimit(maxBytes,128,65536,'maxBytes');
  requireLimit(maxDependencies,0,8,'maxDependencies');
  requireLimit(maxHandlerLines,1,180,'maxHandlerLines');
  requireLimit(maxCandidates,1,16,'maxCandidates');
  const repo=path.resolve(repoRoot);
  const focus=focusOperationContext({repoRoot:repo,contractPath,operationId,revision,
    maxBytes,maxScanFiles,maxScanBytes,maxCandidates});
  const selected=focus.focus.selected;
  let handler=null,dependencies=[],warnings=[],unresolved=[],reason=focus.reason,status='abstained',remaining=maxBytes;
  if(selected){
    const available=treeMap(repo,focus.repository.commit),entry=available.get(selected.path);
    if(!entry||entry.oid!==selected.git_oid)throw new Error('context slice: focus OID does not match commit');
    const {raw,text}=readBlob(repo,entry);
    if(sha(raw)!==selected.source_sha256||raw.length!==selected.source_bytes)
      throw new Error('context slice: focused source digest mismatch');
    let block={excerpt:selected.excerpt,bytes:selected.bytes,line_range:selected.line_range};
    if(selected.language==='python'){
      const entire=handlerBlock(text,selected,maxHandlerLines);
      if(!entire.error)block=entire;
      else warnings.push({reason:entire.error,lines:entire.required_lines});
    }else warnings.push({reason:'language_import_analysis_unsupported',language:selected.language});
    if(block.bytes>remaining){reason='handler_byte_budget';}
    else{
      handler={path:selected.path,git_oid:entry.oid,source_sha256:sha(raw),source_bytes:raw.length,
        excerpt:block.excerpt,excerpt_sha256:sha(Buffer.from(block.excerpt)),bytes:block.bytes,
        line_range:block.line_range,trust:'untrusted_committed_source'};
      remaining-=block.bytes;
      if(selected.language==='python'){
        const refs=referencedImports(text,block.excerpt,selected.path,available);
        for(const warning of refs.warn){
          if(warning.reason==='unresolved_relative_import')unresolved.push(warning);
          else warnings.push(warning);
        }
        for(const ref of refs.found){
          if(dependencies.length>=maxDependencies){
            unresolved.push({reason:'dependency_count_budget',path:ref.path,symbol:ref.symbol});continue;
          }
          const record=available.get(ref.path);
          try{
            const {raw:bytes,text:code}=readBlob(repo,record);
            const snippet=symbolBlock(code,ref.symbol);
            if(snippet.error){unresolved.push({reason:snippet.error,path:ref.path,symbol:ref.symbol});continue;}
            if(snippet.bytes>remaining){unresolved.push({reason:'dependency_byte_budget',path:ref.path,symbol:ref.symbol,required_bytes:snippet.bytes});continue;}
            dependencies.push({path:ref.path,symbol:ref.symbol,alias:ref.alias,import_line:ref.line,git_oid:record.oid,
              source_sha256:sha(bytes),source_bytes:bytes.length,excerpt:snippet.excerpt,
              excerpt_sha256:sha(Buffer.from(snippet.excerpt)),bytes:snippet.bytes,
              line_range:snippet.line_range,trust:'untrusted_committed_source'});
            remaining-=snippet.bytes;
          }catch{unresolved.push({reason:'unavailable_local_dependency',path:ref.path,symbol:ref.symbol});}
        }
      }
      status=warnings.length||unresolved.length||focus.status!=='advisory_complete'?'advisory_incomplete':'advisory_complete';
      reason=null;
    }
  }
  const body={
    schema:'bskel.context-slice/1',repository:focus.repository,contract:focus.contract,
    focus_sha256:focus.focus_sha256,status,reason,handler,dependencies,
    budget:{max_bytes:maxBytes,used_bytes:maxBytes-remaining,max_dependencies:maxDependencies,
      selected_dependencies:dependencies.length},
    warnings,unresolved,
    incomplete_reasons:[...new Set([...warnings.map(r=>r.reason),...unresolved.map(r=>r.reason),
      ...(focus.status==='advisory_complete'?[]:['focus_incomplete'])])],
    trust:'UNTRUSTED_SOURCE_DATA_ONLY',authority:'ADVISORY_NO_RELEASE_NO_CODE_EXECUTION',
    note:'One-hop static local import hints only, not full closure, SBF packet, BEVAL verification or executable authorization.'};
  return {...body,slice_sha256:sha(Buffer.from(canonical(body)))};
}
