// Isolated T13-04 P0/P1 proof of concept. No repository/production integration.
// Only trusted Git object storage is read; the working tree is not read.
// This does NOT establish authority over an attacker-controlled .git directory.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { requireGitAuthority, CLEAN_GIT_ENV } from './git-authority.mjs';

const verifiedSnapshots = new WeakSet();
export function requireVerifiedSnapshot(snapshot) {
  if (!verifiedSnapshots.has(snapshot)) throw Error('UNVERIFIED_SNAPSHOT_OBJECT');
  return snapshot;
}

const HEX40 = /^[0-9a-f]{40}$/;
const MAX_TREE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_DEPTH = 32;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const INPUT_FILES = /(?:^|\/)(?:package\.json|next\.config\.(?:js|mjs|cjs|ts)|route\.(?:js|ts))$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const gitObjectId = (type, data) => crypto.createHash('sha1')
  .update(type + ' ' + data.length + '\0').update(data).digest('hex');

function requireOid(oid) {
  if (typeof oid !== 'string' || !HEX40.test(oid)) throw Error('INVALID_EXACT_GIT_OID');
}
export function readRawGitObject(gitAuthority, type, oid, limit = MAX_TREE_BYTES) {
  const trust = requireGitAuthority(gitAuthority);
  requireOid(oid);
  if (!['commit', 'tree', 'blob'].includes(type)) throw Error('INVALID_GIT_OBJECT_TYPE');
  const r = spawnSync(trust.gitExecutable, ['--git-dir', trust.gitDir, 'cat-file', type, oid], {
    encoding: 'buffer', maxBuffer: limit + 64 * 1024, timeout: 6000,
    env: CLEAN_GIT_ENV,
  });
  if (r.error || r.status !== 0 || !Buffer.isBuffer(r.stdout)) {
    throw Error('GIT_OBJECT_UNAVAILABLE: ' + type + ':' + oid);
  }
  if (r.stdout.length > limit) throw Error('GIT_OBJECT_SIZE_LIMIT');
  return r.stdout;
}
function verifiedRead(gitAuthority, type, oid, limit, reader) {
  requireOid(oid);
  const bytes = reader
    ? reader(gitAuthority, type, oid, limit)
    : readRawGitObject(gitAuthority, type, oid, limit);
  if (!Buffer.isBuffer(bytes) || bytes.length > limit) throw Error('GIT_OBJECT_READ_INVALID');
  if (gitObjectId(type, bytes) !== oid) throw Error('GIT_OBJECT_HASH_MISMATCH: ' + type + ':' + oid);
  return bytes;
}
function parseTree(buffer) {
  const list = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0, space + 1);
    if (space <= offset || nul < space || nul + 21 > buffer.length) {
      throw Error('MALFORMED_GIT_TREE');
    }
    const mode = buffer.subarray(offset, space).toString('ascii');
    let name;
    try { name = utf8.decode(buffer.subarray(space + 1, nul)); }
    catch { throw Error('INVALID_GIT_TREE_NAME_ENCODING'); }
    if (!name || name === '.' || name === '..' ||
        name.includes('/') || name.includes('\\') || name.includes('\0')) {
      throw Error('UNSAFE_GIT_TREE_PATH');
    }
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    if (!['40000', '040000', '100644', '100755', '120000'].includes(mode)) {
      throw Error('UNSUPPORTED_GIT_TREE_MODE: ' + mode);
    }
    list.push({ mode, name, oid });
    offset = nul + 21;
  }
  return list;
}
export function loadPinnedSnapshot({
  gitAuthority, commit, objectReader = undefined,
  maxFileBytes = MAX_BLOB_BYTES,
  maxTotalBytes = MAX_TOTAL_BYTES,
} = {}) {
  requireOid(commit);
  requireGitAuthority(gitAuthority);
  const rawCommit = verifiedRead(gitAuthority, 'commit', commit, 1024 * 1024, objectReader);
  const treeMatch = /^tree ([0-9a-f]{40})$/m.exec(rawCommit.toString('utf8'));
  if (!treeMatch) throw Error('COMMIT_WITHOUT_GIT_TREE');
  const rootTree = treeMatch[1];
  const entries = [];
  let totalBytes = 0;
  let count = 0;

  function walk(treeOid, prefix, depth) {
    if (depth > MAX_DEPTH) throw Error('GIT_TREE_DEPTH_LIMIT');
    const children = parseTree(verifiedRead(gitAuthority, 'tree', treeOid, MAX_TREE_BYTES, objectReader));
    for (const child of children) {
      const relative = prefix ? prefix + '/' + child.name : child.name;
      const dir = child.mode === '40000' || child.mode === '040000';
      if (dir) {
        walk(child.oid, relative, depth + 1);
        continue;
      }
      if (++count > MAX_FILES) throw Error('GIT_FILE_COUNT_LIMIT');
      const symlink = child.mode === '120000';
      let text = null, sha256 = null, bytes = null;
      if (!symlink && INPUT_FILES.test(relative)) {
        const raw = verifiedRead(gitAuthority, 'blob', child.oid, maxFileBytes, objectReader);
        totalBytes += raw.length;
        if (totalBytes > maxTotalBytes) throw Error('GIT_HYDRATED_BYTES_LIMIT');
        try { text = utf8.decode(raw); }
        catch { throw Error('UNDECODABLE_GIT_INPUT: ' + relative); }
        sha256 = hash(raw);
        bytes = raw.length;
      }
      entries.push(Object.freeze({
        relative, mode: child.mode, blob: child.oid,
        type: symlink ? 'symlink' : 'file', text, sha256, bytes,
      }));
    }
  }
  walk(rootTree, '', 0);
  entries.sort((a, b) => a.relative.localeCompare(b.relative));
  for (let i = 1; i < entries.length; i++) {
    if (entries[i - 1].relative === entries[i].relative) throw Error('DUPLICATE_TREE_FILE');
  }
  const identity = {
    git_commit: commit,
    git_tree: rootTree,
    file_count: entries.length,
    hydrated_file_count: entries.filter(e => e.text !== null).length,
    hydrated_bytes: totalBytes,
  };
  const manifest = entries.map(e => [e.relative, e.mode, e.blob, e.sha256]);
  const digest = hash(Buffer.from(JSON.stringify({ identity, manifest }), 'utf8'));
  const result = Object.freeze({
    ...identity,
    snapshot_sha256: digest,
    virtualRoot: '/__t13_pinned_git_snapshot__',
    entries: Object.freeze(entries),
    trust_boundary: 'TRUSTED_GIT_OBJECT_STORE_AND_PINNED_COMMIT_ONLY',
  });
  verifiedSnapshots.add(result);
  return result;
}
