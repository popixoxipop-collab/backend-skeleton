import crypto from 'node:crypto';

// Build-time review helper ONLY. Runtime scanPinnedNext does not read source,
// generate executable code, evaluate strings, or alter import bindings.
const SOURCE_SHA = '8df6384432f9fa0936a533a1607c8db81a0289e2b3a2b0080189fc20a3e5bffc';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function verifyStaticFactoryParity({ originalSourceBytes, factorySourceBytes }) {
  if (!Buffer.isBuffer(originalSourceBytes) || !Buffer.isBuffer(factorySourceBytes)) {
    throw Error('INVALID_SOURCE_BLOBS');
  }
  if (hash(originalSourceBytes) !== SOURCE_SHA) throw Error('ORIGINAL_SCANNER_SHA_MISMATCH');
  const original = originalSourceBytes.toString('utf8');
  const header = "import fs from 'node:fs';\nimport path from 'node:path';\n";
  if (!original.startsWith(header)) throw Error('PINNED_ORIGINAL_HEADER_MISMATCH');
  let scannerBody = original.slice(header.length);
  for (const [a,b] of [
    ['export function detectNextRoot(', 'function detectNextRoot('],
    ['export function scanNext(', 'function scanNext('],
    ['export const adapter = {', 'const adapter = {'],
  ]) {
    if (scannerBody.split(a).length !== 2) throw Error('EXPECTED_SINGLE_EXPORT_MARKER');
    scannerBody = scannerBody.replace(a,b);
  }
  const factory = factorySourceBytes.toString('utf8');
  const begin = factory.indexOf('const SKIP_DIRS = ');
  const end = factory.indexOf('\n  return Object.freeze({ detectNextRoot, scanNext, adapter });');
  if (begin < 0 || end < begin) throw Error('FACTORY_MARKERS_MISSING');
  const actualBody = factory.slice(begin, end).trim();
  if (actualBody !== scannerBody.trim()) throw Error('STATIC_FACTORY_BODY_MISMATCH');
  if (/\b(?:globalThis\s*\[|eval\s*\(|new\s+Function\s*\(|import\s*\(\s*['"]data:)/.test(factory)) {
    throw Error('DYNAMIC_INJECTION_DETECTED');
  }
  return Object.freeze({
    original_sha256: SOURCE_SHA,
    static_factory_sha256: hash(factorySourceBytes),
    scanner_body_byte_equivalent: true,
    explicit_dependency_injection: true,
    runtime_code_rewriting: false,
  });
}
