import { createHash } from 'node:crypto';

export const MUJOCO_DISCOVERY_REVISION = 1;
export const DEFAULT_MAX_SOURCE_BYTES = 8 * 1024 * 1024;

function toBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('MuJoCo source must be a UTF-8 string, Buffer, or Uint8Array');
}

function decodeUtf8(raw, label = 'MuJoCo source') {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
}

export function assertRepoRelativeXmlPath(value, label = 'MuJoCo source path') {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty path`);
  if (/[\x00-\x1f\x7f]/.test(value) || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
    throw new TypeError(`${label} must be a repo-relative POSIX path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new TypeError(`${label} must not contain empty, dot, or parent segments`);
  }
  if (!value.toLowerCase().endsWith('.xml')) throw new TypeError(`${label} must end in .xml`);
  return value;
}

function bounded(raw, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
  if (raw.byteLength > maxBytes) throw new RangeError(`MuJoCo source exceeds byte budget: ${raw.byteLength} > ${maxBytes}`);
}

function assertXmlDeclaration(instruction) {
  const declaration = instruction.trim();
  if (!/^xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])[A-Za-z][A-Za-z0-9._-]*\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*$/i.test(declaration)) {
    throw new Error('MuJoCo XML declaration is invalid');
  }
}

function stripLeadingXmlNoise(text) {
  let rest = text.replace(/^\uFEFF/, '');
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('<?xml')) {
      const end = rest.indexOf('?>');
      if (end < 0) throw new Error('MuJoCo XML declaration is unterminated');
      assertXmlDeclaration(rest.slice(2, end));
      rest = rest.slice(end + 2);
      continue;
    }
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end < 0) throw new Error('MuJoCo leading comment is unterminated');
      rest = rest.slice(end + 3);
      continue;
    }
    return rest.replace(/^\s+/, '');
  }
}

function rootMujocoOpenTag(text) {
  const rest = stripLeadingXmlNoise(text);
  if (/^<!DOCTYPE\b/i.test(rest) || /^<!ENTITY\b/i.test(rest)) {
    throw new Error('MuJoCo source must not declare DOCTYPE or ENTITY');
  }
  const match = rest.match(/^<mujoco(?:\s|\/?>)/);
  if (!match) return null;
  const end = rest.indexOf('>');
  if (end < 0) throw new Error('MuJoCo root start tag is unterminated');
  return rest.slice(0, end + 1);
}

function readSimpleName(openTag) {
  const match = openTag.match(/\bmodel\s*=\s*(?:"([^"]*)"|'([^']*)')/);
  return (match?.[1] ?? match?.[2] ?? null) || null;
}

export function discoverMujocoSource(sourceBytes, {
  path,
  maxBytes = DEFAULT_MAX_SOURCE_BYTES,
} = {}) {
  const raw = toBytes(sourceBytes);
  bounded(raw, maxBytes);
  const sourcePath = assertRepoRelativeXmlPath(path);
  const text = decodeUtf8(raw);
  if (/<!DOCTYPE\b/i.test(text) || /<!ENTITY\b/i.test(text)) {
    throw new Error('MuJoCo source must not declare DOCTYPE or ENTITY');
  }
  const openTag = rootMujocoOpenTag(text);
  if (!openTag) {
    return {
      detected: false,
      target: null,
      path: sourcePath,
      reason: 'root element is not <mujoco>',
    };
  }
  return {
    detected: true,
    target: 'SIM-mujoco',
    path: sourcePath,
    evidence: 'explicit-mujoco-root',
    model_name: readSimpleName(openTag),
    source: {
      media_type: 'application/xml',
      byte_sha256: createHash('sha256').update(raw).digest('hex'),
      size_bytes: raw.byteLength,
    },
    claims: {
      discovery_only: true,
      declared_structure_only: false,
      effective_model_verified: false,
      runtime_behavior_verified: false,
    },
  };
}

export function mujocoSourceBytes(value) {
  return toBytes(value);
}

export function decodeMujocoUtf8(raw, label = 'MuJoCo source') {
  return decodeUtf8(raw, label);
}
