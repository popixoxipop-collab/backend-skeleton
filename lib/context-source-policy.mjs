// Local-only conservative source-path exclusion policy used by automated
// discovery, focus and slice. This is a heuristic guard, not a secrets scanner.
// Manual explicit source selection uses the existing authenticated packet path.
const restrictedPrefix=/^(?:secrets?|credentials?|private|tokens?|api[_-]?keys?|id[_-]?(?:rsa|ed25519))/i;
const restrictedExt=/\.(?:pem|key|p12|pfx|env)$/i;
export function isSensitiveContextSourcePath(file) {
  if (typeof file!=='string'||!file||file.startsWith('/')||file.includes('\\'))return true;
  for(const segment of file.split('/')){
    if(!segment||segment==='.'||segment==='..'||segment.startsWith('.'))return true;
    // CamelCase file names such as secretHelper.py are normalized before
    // prefix matching. Prefer conservative exclusions over exposing source.
    const canonical=segment.replace(/([a-z])([A-Z])/g,'$1_$2');
    if(restrictedPrefix.test(canonical)||restrictedExt.test(canonical))return true;
  }
  return false;
}
