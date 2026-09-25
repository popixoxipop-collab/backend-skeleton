// T04: conservative TypeScript static type-surface projection.
// Provisional internal shape. This does not execute TypeScript, validators, decorators, or target code.

export const JS_TS_TYPE_SURFACE_CONTRACT = 'bskel.internal.js-ts-type-surface/0';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOKENS = 250_000;
const IDENT_START = /[A-Za-z_$]/;
const IDENT_CONTINUE = /[A-Za-z0-9_$]/;

function diagnostic(code, message, start = null) {
  return { level: 'info', code, message, ...(start === null ? {} : { start }) };
}

function isIdentStart(ch) { return typeof ch === 'string' && IDENT_START.test(ch); }
function isIdentContinue(ch) { return typeof ch === 'string' && IDENT_CONTINUE.test(ch); }

function skipLineComment(source, start) {
  let i = start + 2;
  while (i < source.length && source[i] !== '\n') i++;
  return i;
}
function skipBlockComment(source, start) {
  const end = source.indexOf('*/', start + 2);
  return end === -1 ? source.length : end + 2;
}
function readQuoted(source, start, quote) {
  let i = start + 1, value = '';
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') return { end: skipQuoted(source, start, quote), value: null, complete: true, escaped: true };
    if (ch === quote) return { end: i + 1, value, complete: true };
    if (ch === '\n' || ch === '\r') return { end: i, value: null, complete: false };
    value += ch; i++;
  }
  return { end: source.length, value: null, complete: false };
}
function skipQuoted(source, start, quote) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === quote) return i + 1;
    if (source[i] === '\n' || source[i] === '\r') return i;
    i++;
  }
  return source.length;
}
function skipTemplate(source, start) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === '`') return i + 1;
    i++;
  }
  return source.length;
}

function tokenize(source, maxTokens) {
  const tokens = [], diagnostics = [];
  let i = 0;
  while (i < source.length) {
    if (tokens.length >= maxTokens) {
      diagnostics.push(diagnostic('token-limit', `token limit ${maxTokens} reached; no partial type surface emitted`, i));
      return { tokens: [], diagnostics, complete: false };
    }
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && source[i + 1] === '/') { i = skipLineComment(source, i); continue; }
    if (ch === '/' && source[i + 1] === '*') { i = skipBlockComment(source, i); continue; }
    if (ch === '\'' || ch === '"') {
      const r = readQuoted(source, i, ch);
      tokens.push({ type: 'string', value: r.value, start: i, end: r.end, literalComplete: r.complete && r.value !== null });
      if (!r.complete) diagnostics.push(diagnostic('unterminated-string', 'unterminated string literal', i));
      else if (r.escaped) diagnostics.push(diagnostic('escaped-type-literal', 'escaped string literal is not decoded by the bounded type parser', i));
      i = Math.max(i + 1, r.end); continue;
    }
    if (ch === '`') { diagnostics.push(diagnostic('template-type-unparsed', 'template literal types are not parsed by this projection', i)); i = skipTemplate(source, i); continue; }
    if (isIdentStart(ch)) {
      let end = i + 1; while (end < source.length && isIdentContinue(source[end])) end++;
      tokens.push({ type: 'identifier', value: source.slice(i, end), start: i, end }); i = end; continue;
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1; while (end < source.length && /[0-9._]/.test(source[end])) end++;
      tokens.push({ type: 'number', value: source.slice(i, end), start: i, end }); i = end; continue;
    }
    tokens.push({ type: 'punct', value: ch, start: i, end: i + 1 }); i++;
  }
  return { tokens, diagnostics, complete: true };
}

function tokenIs(tokens, i, type, value = undefined) {
  const t = tokens[i]; return Boolean(t && t.type === type && (value === undefined || t.value === value));
}
function findMatching(tokens, open, left, right) {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokenIs(tokens, i, 'punct', left)) depth++;
    else if (tokenIs(tokens, i, 'punct', right)) {
      depth--; if (depth === 0) return i;
    }
  }
  return -1;
}
function splitTopLevel(tokens, start, end, delimiter = '|') {
  const parts = []; let partStart = start; let angle = 0, paren = 0, bracket = 0, brace = 0;
  for (let i = start; i < end; i++) {
    const t = tokens[i]; if (t.type !== 'punct') continue;
    if (t.value === '<') angle++;
    else if (t.value === '>') angle = Math.max(0, angle - 1);
    else if (t.value === '(') paren++;
    else if (t.value === ')') paren = Math.max(0, paren - 1);
    else if (t.value === '[') bracket++;
    else if (t.value === ']') bracket = Math.max(0, bracket - 1);
    else if (t.value === '{') brace++;
    else if (t.value === '}') brace = Math.max(0, brace - 1);
    else if (t.value === delimiter && angle === 0 && paren === 0 && bracket === 0 && brace === 0) {
      parts.push([partStart, i]); partStart = i + 1;
    }
  }
  parts.push([partStart, end]);
  return parts.filter(([a,b]) => a < b);
}

function parseType(tokens, start, end) {
  while (start < end && tokenIs(tokens, start, 'punct', '(') && tokenIs(tokens, end - 1, 'punct', ')')) {
    const close = findMatching(tokens, start, '(', ')');
    if (close !== end - 1) break;
    start++; end--;
  }
  const unions = splitTopLevel(tokens, start, end, '|');
  if (unions.length > 1) {
    return { kind: 'union', variants: unions.map(([a,b]) => parseType(tokens, a, b)) };
  }
  if (end - start >= 2 && tokenIs(tokens, end - 2, 'punct', '[') && tokenIs(tokens, end - 1, 'punct', ']')) {
    return { kind: 'array', items: parseType(tokens, start, end - 2) };
  }
  if (end - start === 1) {
    const t = tokens[start];
    if (t.type === 'string' && t.literalComplete) return { kind: 'literal', value: t.value };
    if (t.type === 'number') return { kind: 'number-literal', value: t.value };
    if (t.type === 'identifier') {
      if (['string','number','boolean','bigint','symbol','unknown','any','never','object','undefined','null'].includes(t.value)) return { kind: 'primitive', name: t.value };
      if (t.value === 'true') return { kind: 'literal', value: true };
      if (t.value === 'false') return { kind: 'literal', value: false };
      return { kind: 'reference', name: t.value };
    }
  }
  if (tokenIs(tokens, start, 'identifier', 'Array') && tokenIs(tokens, start + 1, 'punct', '<') && tokenIs(tokens, end - 1, 'punct', '>')) {
    return { kind: 'array', items: parseType(tokens, start + 2, end - 1) };
  }
  if (tokenIs(tokens, start, 'identifier', 'ReadonlyArray') && tokenIs(tokens, start + 1, 'punct', '<') && tokenIs(tokens, end - 1, 'punct', '>')) {
    return { kind: 'array', readonly: true, items: parseType(tokens, start + 2, end - 1) };
  }
  return { kind: 'unsupported', text: tokens.slice(start,end).map(t=>t.value ?? '').join(' ') };
}

function findMemberEnd(tokens, start, close) {
  let angle=0,paren=0,bracket=0,brace=0;
  for(let i=start;i<close;i++) {
    const t=tokens[i]; if(t.type!=='punct') continue;
    if(t.value==='<') angle++; else if(t.value==='>') angle=Math.max(0,angle-1);
    else if(t.value==='(') paren++; else if(t.value===')') paren=Math.max(0,paren-1);
    else if(t.value==='[') bracket++; else if(t.value===']') bracket=Math.max(0,bracket-1);
    else if(t.value==='{') brace++; else if(t.value==='}') brace=Math.max(0,brace-1);
    else if((t.value===';' || t.value===',') && !angle&&!paren&&!bracket&&!brace) return i;
  }
  return close;
}

function parseMembers(tokens, open, close, diagnostics) {
  const properties=[]; let i=open+1;
  while(i<close) {
    while(i<close && tokenIs(tokens,i,'punct',';')) i++;
    if(i>=close) break;
    const start=i; let readonly=false;
    if(tokenIs(tokens,i,'identifier','readonly')) { readonly=true; i++; }
    if(tokenIs(tokens,i,'punct','[')) {
      const end=findMemberEnd(tokens,i,close); diagnostics.push(diagnostic('index-signature-unprojected','index/computed member is not projected',tokens[start].start)); i=end+1; continue;
    }
    const nameTok=tokens[i];
    if(!(nameTok?.type==='identifier' || (nameTok?.type==='string' && nameTok.literalComplete))) {
      const end=findMemberEnd(tokens,i,close); diagnostics.push(diagnostic('member-unprojected','member shape is not supported',tokens[start]?.start ?? null)); i=end+1; continue;
    }
    const name=nameTok.value; i++;
    let optional=false;
    if(tokenIs(tokens,i,'punct','?')) { optional=true; i++; }
    if(tokenIs(tokens,i,'punct','(') || tokenIs(tokens,i,'punct','<')) {
      const end=findMemberEnd(tokens,i,close); diagnostics.push(diagnostic('method-member-unprojected',`${name}: methods/call signatures are not data properties`,nameTok.start)); i=end+1; continue;
    }
    if(!tokenIs(tokens,i,'punct',':')) {
      const end=findMemberEnd(tokens,i,close); diagnostics.push(diagnostic('member-unprojected',`${name}: expected ':' for a data property`,nameTok.start)); i=end+1; continue;
    }
    const typeStart=++i; const memberEnd=findMemberEnd(tokens,i,close);
    const type=parseType(tokens,typeStart,memberEnd);
    properties.push({ name, optional, readonly, type, source:{start:nameTok.start,end:(tokens[Math.max(typeStart,memberEnd-1)]?.end ?? nameTok.end)} });
    if(type.kind==='unsupported') diagnostics.push(diagnostic('property-type-unprojected',`${name}: type surface is outside the bounded projection`,nameTok.start));
    i=memberEnd + (memberEnd<close ? 1:0);
  }
  return properties;
}

function findDeclarationEnd(tokens, start) {
  for(let i=start;i<tokens.length;i++) if(tokenIs(tokens,i,'punct',';')) return i;
  return tokens.length;
}

function declarationPrefix(tokens,i) {
  let exported=false, declared=false;
  while(i<tokens.length && tokenIs(tokens,i,'identifier') && ['export','declare'].includes(tokens[i].value)) {
    if(tokens[i].value==='export') exported=true; else declared=true; i++;
  }
  return {i,exported,declared};
}

function parseDeclarations(tokens, diagnostics) {
  const declarations=[];
  for(let cursor=0;cursor<tokens.length;cursor++) {
    const p=declarationPrefix(tokens,cursor); let i=p.i;
    if(!tokenIs(tokens,i,'identifier') || !['interface','type'].includes(tokens[i].value)) continue;
    const kind=tokens[i].value; const keyword=tokens[i];
    if(!tokenIs(tokens,i+1,'identifier')) { diagnostics.push(diagnostic('anonymous-type-declaration','type declaration name missing',keyword.start)); continue; }
    const nameTok=tokens[i+1]; const name=nameTok.value; i+=2;
    if(tokenIs(tokens,i,'punct','<')) {
      const close=findMatching(tokens,i,'<','>');
      diagnostics.push(diagnostic('generic-declaration-unprojected',`${name}: generic declarations are not projected`,nameTok.start));
      if(close<0) continue; i=close+1;
    }
    const extendsRefs=[];
    if(kind==='interface' && tokenIs(tokens,i,'identifier','extends')) {
      i++;
      while(i<tokens.length && !tokenIs(tokens,i,'punct','{')) {
        if(tokenIs(tokens,i,'identifier')) extendsRefs.push(tokens[i].value);
        i++;
      }
    }
    if(kind==='interface') {
      if(!tokenIs(tokens,i,'punct','{')) { diagnostics.push(diagnostic('interface-body-unprojected',`${name}: interface body not found`,nameTok.start)); continue; }
      const close=findMatching(tokens,i,'{','}'); if(close<0){diagnostics.push(diagnostic('unterminated-interface',`${name}: interface body not terminated`,nameTok.start));continue;}
      declarations.push({name,kind,exported:p.exported,declared:p.declared,extends:[...new Set(extendsRefs)],properties:parseMembers(tokens,i,close,diagnostics),source:{start:keyword.start,end:tokens[close].end}});
      cursor=close; continue;
    }
    if(!tokenIs(tokens,i,'punct','=')) { diagnostics.push(diagnostic('type-alias-unprojected',`${name}: expected '='`,nameTok.start)); continue; }
    i++;
    if(tokenIs(tokens,i,'punct','{')) {
      const close=findMatching(tokens,i,'{','}'); if(close<0){diagnostics.push(diagnostic('unterminated-type-object',`${name}: object type not terminated`,nameTok.start));continue;}
      declarations.push({name,kind:'type-object',exported:p.exported,declared:p.declared,extends:[],properties:parseMembers(tokens,i,close,diagnostics),source:{start:keyword.start,end:tokens[close].end}});
      cursor=close; continue;
    }
    const end=findDeclarationEnd(tokens,i);
    declarations.push({name,kind:'type-alias',exported:p.exported,declared:p.declared,extends:[],alias:parseType(tokens,i,end),properties:[],source:{start:keyword.start,end:(tokens[Math.max(i,end-1)]?.end ?? nameTok.end)}});
    if(declarations.at(-1).alias.kind==='unsupported') diagnostics.push(diagnostic('type-alias-unprojected',`${name}: alias is outside the bounded projection`,nameTok.start));
    cursor=end;
  }
  const names=new Set();
  for(const d of declarations){ if(names.has(d.name)) diagnostics.push(diagnostic('duplicate-type-declaration',`${d.name}: duplicate declaration is preserved; no merge is attempted`,d.source.start)); names.add(d.name); }
  return declarations;
}

function byteMap(source, positions) {
  const sorted=[...new Set(positions)].sort((a,b)=>a-b); const out=new Map(); let cu=0,bytes=0;
  for(const wanted of sorted){
    while(cu<wanted){const cp=source.codePointAt(cu);const width=cp>0xffff?2:1;bytes+=Buffer.byteLength(source.slice(cu,cu+width),'utf8');cu+=width;}
    if(cu!==wanted) throw new Error(`span boundary ${wanted} falls inside surrogate pair`); out.set(wanted,bytes);
  }
  return out;
}
function lineAt(source,index){let line=1;for(let i=0;i<index;i++)if(source[i]==='\n')line++;return line;}
function addSourceSpans(source,declarations,diagnostics){
  const pos=[];for(const d of declarations){pos.push(d.source.start,d.source.end);for(const p of d.properties)pos.push(p.source.start,p.source.end);}for(const d of diagnostics)if(d.start!==undefined)pos.push(d.start);
  const m=byteMap(source,pos);
  const ds=declarations.map(d=>({...d,source:{byteStart:m.get(d.source.start),byteEnd:m.get(d.source.end),line:lineAt(source,d.source.start)},properties:d.properties.map(p=>({...p,source:{byteStart:m.get(p.source.start),byteEnd:m.get(p.source.end),line:lineAt(source,p.source.start)}}))}));
  const di=diagnostics.map(({start,...d})=>start===undefined?d:{...d,source:{byteStart:m.get(start),line:lineAt(source,start)}});
  return {declarations:ds,diagnostics:di};
}

function scalarSchema(type) {
  if(type.kind==='primitive') {
    if(type.name==='string') return {type:'string'};
    if(type.name==='number') return {type:'number'};
    if(type.name==='boolean') return {type:'boolean'};
    if(type.name==='null') return {type:'null'};
    if(type.name==='unknown' || type.name==='any') return {};
    return null;
  }
  if(type.kind==='literal') return {const:type.value};
  if(type.kind==='number-literal') { const n=Number(type.value.replaceAll('_','')); return Number.isFinite(n)?{const:n}:null; }
  if(type.kind==='reference') return {'x-bskel-type-ref':type.name};
  if(type.kind==='array') { const items=scalarSchema(type.items); return items===null?null:{type:'array',items}; }
  if(type.kind==='union') {
    const variants=type.variants.map(scalarSchema); if(variants.some(v=>v===null)) return null; return {anyOf:variants};
  }
  return null;
}

function projectDeclaration(decl) {
  if(decl.kind==='type-alias') {
    const schema=scalarSchema(decl.alias);
    return {name:decl.name,status:schema===null?'partial':'projected',basis:'typescript-static-type',runtimeValidated:false,schema:schema??{},unsupported:schema===null?['alias-type']:[]};
  }
  const properties={}; const required=[]; const unsupported=[];
  for(const p of decl.properties){
    const schema=scalarSchema(p.type);
    if(schema===null){unsupported.push(p.name);continue;}
    properties[p.name]=schema;if(!p.optional)required.push(p.name);
  }
  return {name:decl.name,status:unsupported.length?'partial':'projected',basis:'typescript-static-type',runtimeValidated:false,schema:{type:'object',properties,...(required.length?{required}:{}),'x-bskel-structural-type':true},unsupported};
}

export function projectTypeScriptSurface(source,{filePath='<memory>',maxBytes=DEFAULT_MAX_BYTES,maxTokens=DEFAULT_MAX_TOKENS}={}){
  if(typeof source!=='string') throw new TypeError('source must be a string');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<=0) throw new TypeError('maxBytes must be a positive safe integer');
  if(!Number.isSafeInteger(maxTokens)||maxTokens<=0) throw new TypeError('maxTokens must be a positive safe integer');
  const inputBytes=Buffer.byteLength(source,'utf8');
  if(inputBytes>maxBytes)return{contract:JS_TS_TYPE_SURFACE_CONTRACT,filePath,complete:false,syntaxValidated:false,runtimeValidated:false,inputBytes,declarations:[],projections:[],diagnostics:[{level:'info',code:'input-too-large',message:`input is ${inputBytes} bytes; limit is ${maxBytes}; no partial type surface emitted`}]};
  const lexed=tokenize(source,maxTokens);if(!lexed.complete)return{contract:JS_TS_TYPE_SURFACE_CONTRACT,filePath,complete:false,syntaxValidated:false,runtimeValidated:false,inputBytes,declarations:[],projections:[],diagnostics:lexed.diagnostics};
  const diagnostics=[...lexed.diagnostics];const declarations=parseDeclarations(lexed.tokens,diagnostics);const spanned=addSourceSpans(source,declarations,diagnostics);
  return{contract:JS_TS_TYPE_SURFACE_CONTRACT,filePath,complete:true,syntaxValidated:false,runtimeValidated:false,inputBytes,declarations:spanned.declarations,projections:spanned.declarations.map(projectDeclaration),diagnostics:spanned.diagnostics};
}
