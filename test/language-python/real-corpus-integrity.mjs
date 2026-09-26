import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function inside(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export function gitBlobSha(bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const header = Buffer.from(`blob ${body.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(header).update(body).digest('hex');
}

export function verifySelectedCorpusFiles(checkout, repoSubroot, records) {
  const checkoutReal = fs.realpathSync(checkout);
  const projectRoot = fs.realpathSync(path.join(checkoutReal, repoSubroot || ''));
  if (!inside(checkoutReal, projectRoot)) throw new Error('corpus project root escapes checkout');
  if (!Array.isArray(records) || records.length === 0) throw new Error('corpus case requires selected files');

  const selected = [];
  const seen = new Set();
  for (const record of records) {
    if (!record || typeof record.path !== 'string' || !record.path ||
        typeof record.blobSha !== 'string' || !/^[0-9a-f]{40}$/.test(record.blobSha)) {
      throw new Error('corpus file record requires path and 40-hex Git blob SHA');
    }
    const requested = path.resolve(projectRoot, record.path);
    const real = fs.realpathSync(requested);
    if (!inside(projectRoot, real) || real === projectRoot) {
      throw new Error(`corpus source escapes project root: ${record.path}`);
    }
    if (!fs.statSync(real).isFile()) throw new Error(`corpus source is not a regular file: ${record.path}`);
    if (seen.has(real)) throw new Error(`duplicate corpus source after realpath resolution: ${record.path}`);
    seen.add(real);
    const bytes = fs.readFileSync(real);
    const actual = gitBlobSha(bytes);
    if (actual !== record.blobSha) {
      throw new Error(`corpus source blob mismatch for ${record.path}: expected ${record.blobSha}, got ${actual}`);
    }
    selected.push({ path: record.path, blobSha: actual, sizeBytes: bytes.length });
  }
  return { projectRoot, selected };
}
