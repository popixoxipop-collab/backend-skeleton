import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { isSensitiveContextSourcePath } from './context-source-policy.mjs';

// Git object bytes only. Text inside source and instructions files is never executed.
const sha=b=>createHash('sha256').update(b).digest('hex');
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const OID=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const EXT=/\.(?:py|js|mjs|ts|tsx|jsx|java|kt|rb|go|rs|cs|php)$/i;
const OMIT=new Set(['.git','.venv','venv','node_modules','vendor','dist','build','coverage','__pycache__','.next','.cache','site-packages','target','out','tmp','temp']);
const STOP=new Set(['get','post','put','patch','delete','read','list','find','create','update','the','with','from','that','into','this','api','v1','v2','by','to','all','and','for','id','route','endpoint','controller','handler']);
function git(root,args,maxBuffer=12*1024*1024) {
  try {
    return execFileSync('git',['--no-optional-locks','--literal-pathspecs',...args],{
      cwd:root,maxBuffer,timeout:15000,stdio:['ignore','pipe','pipe'],
      env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'}
    });
  } catch { throw new Error('context discover: immutable local Git object unavailable; no network fallback'); }
}
function bounded(x,min,max,name){
  if(!Number.isSafeInteger(x)||x<min||x>max)throw new Error('context discover: invalid '+name);
}
function validPath(file){
  return typeof file==='string'&&file.length>0&&!file.startsWith('/')&&!file.includes('\\')&&
    !file.split('/').some(x=>!x||x==='.'||x==='..'||OMIT.has(x));
}
function candidate(f){
  const file=f.file;
  return f.type==='blob'&&['100644','100755'].includes(f.mode)&&
    validPath(file)&&EXT.test(file)&&!/(^|\/)\./.test(file)&&
    !/(^|\/)(test|tests|__tests__|evals|fixtures|migrations|generated|docs?|benchmarks?)(\/|$)/i.test(file)&&
    !/(\.test\.|\.spec\.|_test\.|\.min\.)/i.test(file)&&
    !isSensitiveContextSourcePath(file);
}
function toks(x) {
  return [...new Set(String(x).replace(/([a-z0-9])([A-Z])/g,'$1 $2')
    .split(/[^a-zA-Z0-9]+/).map(y=>y.toLowerCase())
    .filter(y=>y.length>=3&&!STOP.has(y)))];
}
function escapeRx(x){return x.replace(/[.*+?^$()|[\]{}\\]/g,'\\$&');}
// Conservative lexical comment stripping. Keeps code string literals (routes)
// but removes JS/Java/Python comments and Python triple-quoted docstrings.
export function executableText(text, stripStrings=false) {
  const out=[];
  let mode='code',quote=0;
  for(let i=0;i<text.length;i++){
    const c=text[i], n=text[i+1], code=text.charCodeAt(i);
    if(mode==='line'){
      if(c==='\n'){mode='code';out.push(c);}else out.push(' ');
      continue;
    }
    if(mode==='block'){
      if(c==='*'&&n==='/'){out.push(' ',' ');i++;mode='code';}
      else out.push(c==='\n'?'\n':' ');
      continue;
    }
    if(mode==='triple'){
      if(code===quote&&text.charCodeAt(i+1)===quote&&text.charCodeAt(i+2)===quote){
        out.push(' ',' ',' ');i+=2;mode='code';
      }else out.push(c==='\n'?'\n':' ');
      continue;
    }
    if(mode==='quote'){
      out.push(stripStrings ? (c==='\n'?'\n':' ') : c);
      if(c==='\\'&&n!==undefined){
        out.push(stripStrings ? (n==='\n'?'\n':' ') : n);i++;continue;
      }
      if(code===quote)mode='code';
      continue;
    }
    if(c==='/'&&n==='/'){out.push(' ',' ');i++;mode='line';continue;}
    if(c==='#'){out.push(' ');mode='line';continue;}
    if(c==='/'&&n==='*'){out.push(' ',' ');i++;mode='block';continue;}
    if(code===39||code===34||code===96){
      quote=code;
      if(code!==96&&text.charCodeAt(i+1)===code&&text.charCodeAt(i+2)===code){
        out.push(' ',' ',' ');i+=2;mode='triple';
      }else{out.push(stripStrings?' ':c);mode='quote';}
      continue;
    }
    out.push(c);
  }
  return out.join('');
}
function declaredHandler(text,id) {
  const name=escapeRx(id);
  const patterns=[
    new RegExp('\\b(?:async\\s+)?def\\s+'+name+'\\s*\\('),
    new RegExp('\\b(?:async\\s+)?function\\s+'+name+'\\s*\\('),
    new RegExp('\\bfun\\s+'+name+'\\s*\\('),
    new RegExp('\\b(?:const|let|var)\\s+'+name+'\\s*=(?:\\s*async)?\\s*(?:\\(|function\\b)'),
    new RegExp('(?:^|\\n)\\s*(?:(?:public|protected|private|static|final|override|suspend)\\s+)+[^\\n;{}]{0,180}?\\b'+name+'\\s*\\('),
    new RegExp('(?:^|\\n)\\s*(?:async\\s+)?'+name+'\\s*\\(')
  ];
  return patterns.some(re=>re.test(text));
}
function score(file,body,id,method,route) {
  const lowFile=file.toLowerCase();
  const clean=executableText(body);
  const declarations=executableText(body,true);
  const symbols=toks(id), routeWords=toks(route);
  const signals=[];let points=0,termHits=0;
  const exactSymbol=new RegExp('(?:^|[^a-z0-9_$])'+escapeRx(id)+'(?=$|[^a-z0-9_$])','i');
  // Only a callable declaration can earn strong symbol-location evidence.
  // A mention in a comment, string or callsite is not a declaration.
  if(declaredHandler(declarations,id)){points+=240;signals.push('handler_declaration');}
  else if(exactSymbol.test(declarations)){points+=25;signals.push('symbol_reference');}
  const full=route.replace(/\/+$/,'')||'/';
  const quoted=(x)=>new RegExp('["\\x27]'+escapeRx(x)+'["\\x27]','i');
  const last=full.split('/').filter(Boolean).at(-1)||'';
  if(quoted(full).test(clean)){points+=100;signals.push('full_route_literal');}
  else if(last&&!last.startsWith('{')&&(quoted(last).test(clean)||quoted('/'+last).test(clean))){
    points+=45;signals.push('leaf_route_literal');
  }
  const reg={
    GET:/@(?:app|router|api|bp)\.get\s*\(|@GetMapping\s*\(|\.get\s*\(\s*["']/i,
    POST:/@(?:app|router|api|bp)\.post\s*\(|@PostMapping\s*\(|\.post\s*\(\s*["']/i,
    PUT:/@(?:app|router|api|bp)\.put\s*\(|@PutMapping\s*\(/i,
    PATCH:/@(?:app|router|api|bp)\.patch\s*\(|@PatchMapping\s*\(/i,
    DELETE:/@(?:app|router|api|bp)\.delete\s*\(|@DeleteMapping\s*\(/i
  };
  if(reg[method]?.test(clean)){points+=25;signals.push('http_method_registration');}
  for(const t of symbols){
    if(lowFile.includes(t)){points+=30;signals.push('filename_operation:'+t);}
    if(new RegExp('(?:^|[^a-z0-9_$])'+escapeRx(t)+'(?=$|[^a-z0-9_$])','i').test(clean)){points+=6;termHits++;}
  }
  for(const t of routeWords){
    if(lowFile.includes(t)){points+=40;signals.push('filename_route:'+t);}
    if(new RegExp('(?:^|[^a-z0-9_$])'+escapeRx(t)+'(?=$|[^a-z0-9_$])','i').test(clean))points+=4;
  }
  if(routeWords.length&&routeWords.every(t=>lowFile.includes(t)))points+=10;
  if(/(?:^|\/)(routes?|controllers?|api|views|endpoints|handlers)(\/|$)/.test(lowFile))points+=10;
  if(!signals.some(s=>s==='handler_declaration'||s==='symbol_reference'||s==='full_route_literal'||s==='leaf_route_literal'||s.startsWith('filename_')))points=0;
  return {points,signals,termHits};
}
export function discoverOperationContext({
  repoRoot,contractPath,operationId,revision='HEAD',
  maxScanFiles=2500,maxScanBytes=8*1024*1024,maxSelectedFiles=4
}){
  bounded(maxScanFiles,1,20000,'maxScanFiles');
  bounded(maxScanBytes,1024,32*1024*1024,'maxScanBytes');
  bounded(maxSelectedFiles,1,16,'maxSelectedFiles');
  if(!validPath(contractPath))throw new Error('context discover: invalid contract path');
  if(typeof operationId!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(operationId))
    throw new Error('context discover: invalid operation ID');
  const repo=path.resolve(repoRoot);
  const commit=git(repo,['rev-parse','--verify','--end-of-options',revision+'^{commit}']).toString().trim();
  const tree=git(repo,['rev-parse','--verify','--end-of-options',commit+'^{tree}']).toString().trim();
  if(!OID.test(commit)||!OID.test(tree))throw new Error('context discover: invalid Git revision');
  // Decode tree filenames without replacement characters: otherwise we could
  // advertise a path that cannot exist in the original Git object database.
  const listing=git(repo,['ls-tree','-r','-z','--full-tree',commit],10*1024*1024);
  let text;
  try { text=utf8.decode(listing); }
  catch { throw new Error('context discover: invalid UTF-8 Git path'); }
  const treeEntries=text.split('\0').filter(Boolean).map(line=>{
    const tab=line.indexOf('\t');
    if(tab<0)throw new Error('context discover: invalid Git tree record');
    const [mode,type,oid]=line.slice(0,tab).split(' ');
    if(!OID.test(oid))throw new Error('context discover: invalid Git blob oid');
    return {file:line.slice(tab+1),mode,type,oid};
  });
  const contractEntry=treeEntries.find(e=>e.file===contractPath);
  if(!contractEntry||contractEntry.type!=='blob'||!['100644','100755'].includes(contractEntry.mode))
    throw new Error('context discover: regular committed contract required');
  const contractSize=Number(git(repo,['cat-file','-s',contractEntry.oid]).toString().trim());
  if(!Number.isSafeInteger(contractSize)||contractSize<1||contractSize>1024*1024)
    throw new Error('context discover: contract exceeds bounded read');
  const contractRaw=git(repo,['cat-file','blob',contractEntry.oid],contractSize+1024);
  if(contractRaw.length!==contractSize)throw new Error('context discover: contract blob size changed');
  let contract;
  try{contract=JSON.parse(utf8.decode(contractRaw));}
  catch{throw new Error('context discover: invalid contract encoding/JSON');}
  if(contract.sbf_contract!=='9'||!contract.operations||!Object.hasOwn(contract.operations,operationId))
    throw new Error('context discover: operation absent from v9 contract');
  const op=contract.operations[operationId];
  if(typeof op.path!=='string'||typeof op.verb!=='string')throw new Error('context discover: operation malformed');
  // Excluded sensitive files are counted, not read or named in output.
  // A discovery that bypassed them cannot certify a complete source scan.
  const restrictedSourceFiles=treeEntries.filter(f=>f.file!==contractPath&&
    f.type==='blob'&&['100644','100755'].includes(f.mode)&&
    validPath(f.file)&&EXT.test(f.file)&&isSensitiveContextSourcePath(f.file)).length;
  const entries=treeEntries.filter(f=>f.file!==contractPath&&candidate(f))
    .sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
  let inspected=0,visited=0,scannedBytes=0,budgetLimited=false;const ranked=[];
  const rejected={oversize:0,binary:0,non_utf8:0};
  for(const f of entries){
    // Count every attempted blob, even ones rejected before their contents
    // are read. This prevents 20,000 oversized entries bypassing maxScanFiles.
    if(inspected>=maxScanFiles||scannedBytes>=maxScanBytes){budgetLimited=true;break;}
    inspected++;
    const size=Number(git(repo,['cat-file','-s',f.oid]).toString().trim());
    if(!Number.isSafeInteger(size)||size<0)throw new Error('context discover: invalid blob size');
    if(size>262144){rejected.oversize++;continue;}
    if(scannedBytes+size>maxScanBytes){budgetLimited=true;break;}
    scannedBytes+=size;visited++;
    const raw=git(repo,['cat-file','blob',f.oid],size+1024);
    if(raw.length!==size)throw new Error('context discover: Git blob bytes changed');
    if(raw.includes(0)){rejected.binary++;continue;}
    let content;
    try{content=utf8.decode(raw);}catch{rejected.non_utf8++;continue;}
    if(!Buffer.from(content,'utf8').equals(raw)){rejected.non_utf8++;continue;}
    const result=score(f.file,content,operationId,op.verb,op.path);
    if(result.points>=25&&result.signals.length){
      ranked.push({path:f.file,blob_oid:f.oid,sha256:sha(raw),bytes:size,
        score:result.points,signals:[...new Set(result.signals)],term_hits:result.termHits,
        trust:'untrusted-git-source'});
    }
  }
  ranked.sort((a,b)=>b.score-a.score||(a.path<b.path?-1:a.path>b.path?1:0));
  const selected=ranked.slice(0,maxSelectedFiles),gap=ranked.length>1?ranked[0].score-ranked[1].score:null;
  const hasDeclaration=selected[0]?.signals.includes('handler_declaration')??false;
  const hasRouteRegistration=selected[0]?.signals.includes('http_method_registration')??false;
  const hasRouteLiteral=selected[0]?.signals.some(s=>s==='full_route_literal'||s==='leaf_route_literal')??false;
  const confidence=!selected.length?'none':hasDeclaration?(gap===null||gap>=30?'high':'medium'):
    (hasRouteRegistration&&hasRouteLiteral?'medium':'low');
  const ambiguous=gap!==null&&gap<30;
  const incompleteReasons=[];
  if(budgetLimited)incompleteReasons.push('scan_budget');
  if(Object.values(rejected).some(n=>n>0))incompleteReasons.push('excluded_source_bytes');
  if(restrictedSourceFiles>0)incompleteReasons.push('restricted_source_files_excluded');
  if(ranked.length>maxSelectedFiles)incompleteReasons.push('ranked_candidates_truncated');
  if(confidence==='none'||confidence==='low')incompleteReasons.push('no_confirmed_declaration');
  if(ambiguous)incompleteReasons.push('ambiguous_top_scores');
  if(!hasDeclaration)incompleteReasons.push('no_confirmed_handler_declaration');
  const complete=incompleteReasons.length===0;
  return {
    schema:'bskel.context-discovery/1',
    repository:{commit,tree},
    contract:{path:contractPath,sha256:sha(contractRaw),operation_id:operationId,method:op.verb,route:op.path},
    constraints:{max_scan_files:maxScanFiles,max_scan_bytes:maxScanBytes,max_selected_files:maxSelectedFiles,max_blob_bytes:262144},
    inventory:{eligible_files:entries.length,restricted_source_files:restrictedSourceFiles,inspected_files:inspected,scanned_files:visited,
      scanned_bytes:scannedBytes,budget_limited:budgetLimited,rejected,matched_files:ranked.length},
    selection:{selected,confidence,ambiguous,complete,incomplete_reasons:incompleteReasons,
      omitted_matching_candidates:Math.max(0,ranked.length-selected.length),
      caveat:'Filename and route heuristics only. Complete means this bounded heuristic scan had no known exclusions, not semantic proof or import closure.'}
  };
}
