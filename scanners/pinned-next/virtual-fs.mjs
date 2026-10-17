// Typed-by-contract read-only virtual fs for verified Git memory snapshots.
// Only directory listing, lstat, fd opens/reads/closes are supported.
import nodeFs from 'node:fs';
import path from 'node:path';
import { requireVerifiedSnapshot } from './git-snapshot.mjs';

export function makeSnapshotFs(snapshot, { onBeforeVirtualOpen } = {}) {
  requireVerifiedSnapshot(snapshot);
  if (!snapshot || !Array.isArray(snapshot.entries) || !snapshot.virtualRoot) {
    throw Error('INVALID_PINNED_SNAPSHOT');
  }
  const root = path.resolve(snapshot.virtualRoot);
  const items = new Map();
  items.set('', { relative: '', type: 'directory', text: null, bytes: 0 });
  for (const item of snapshot.entries) {
    const parts = item.relative.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dirname = parts.slice(0, i).join('/');
      const existing = items.get(dirname);
      if (existing && existing.type !== 'directory') throw Error('GIT_TREE_ANCESTOR_NOT_DIRECTORY');
      if (!existing) items.set(dirname, { relative: dirname, type: 'directory', text: null, bytes: 0 });
    }
    if (items.has(item.relative)) throw Error('SNAPSHOT_DUPLICATE_PATH');
    items.set(item.relative, item);
  }
  const sorted = [...items.keys()].sort();
  const inodes = new Map(sorted.map((key, i) => [key, i + 101]));
  const children = new Map();
  for (const name of sorted) {
    if (name === '') continue;
    const slash = name.lastIndexOf('/');
    const parent = slash >= 0 ? name.slice(0, slash) : '';
    const base = slash >= 0 ? name.slice(slash + 1) : name;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(base);
  }
  const descriptors = new Map();
  let fdNext = 300;
  let openCount = 0, readCount = 0;

  function relativeOf(full) {
    if (typeof full !== 'string') throw Error('VIRTUAL_FS_EXPECTED_STRING_PATH');
    const resolved = path.resolve(full);
    if (resolved === root) return '';
    if (!resolved.startsWith(root + path.sep)) throw Error('VIRTUAL_FS_PATH_ESCAPE');
    return resolved.slice(root.length + 1).split(path.sep).join('/');
  }
  function lookup(full) {
    const relative = relativeOf(full);
    const file = items.get(relative);
    if (!file) throw Object.assign(Error('VIRTUAL_FS_NOT_FOUND: ' + relative), { code: 'ENOENT' });
    return { file, relative };
  }
  function stats(file, relative) {
    return Object.freeze({
      dev: 41, ino: inodes.get(relative), mtimeMs: 0,
      size: Number.isInteger(file.bytes) ? file.bytes : 0,
      isFile: () => file.type === 'file',
      isDirectory: () => file.type === 'directory',
      isSymbolicLink: () => file.type === 'symlink',
    });
  }
  function readdirSync(full, options = {}) {
    const { file, relative } = lookup(full);
    if (file.type !== 'directory') throw Object.assign(Error('VIRTUAL_FS_NOT_DIRECTORY'), { code: 'ENOTDIR' });
    if (!options || options.withFileTypes !== true) throw Error('VIRTUAL_FS_DIRENT_ONLY');
    return (children.get(relative) || []).map(name => {
      const child = items.get(relative ? relative + '/' + name : name);
      return Object.freeze({
        name,
        isFile: () => child.type === 'file',
        isDirectory: () => child.type === 'directory',
        isSymbolicLink: () => child.type === 'symlink',
      });
    });
  }
  function lstatSync(full) {
    const { file, relative } = lookup(full);
    return stats(file, relative);
  }
  function openSync(full, flags) {
    if (!Number.isInteger(flags) ||
        !Number.isInteger(nodeFs.constants.O_NOFOLLOW) ||
        (flags & nodeFs.constants.O_NOFOLLOW) !== nodeFs.constants.O_NOFOLLOW ||
        (flags & (nodeFs.constants.O_WRONLY | nodeFs.constants.O_RDWR |
                  nodeFs.constants.O_CREAT | nodeFs.constants.O_TRUNC |
                  nodeFs.constants.O_APPEND)) !== 0) {
      throw Error('VIRTUAL_FS_READONLY_NOFOLLOW_REQUIRED');
    }
    const { file, relative } = lookup(full);
    if (file.type === 'symlink') throw Object.assign(Error('VIRTUAL_FS_SYMLINK'), { code: 'ELOOP' });
    if (file.type !== 'file' || typeof file.text !== 'string') {
      throw Object.assign(Error('VIRTUAL_FS_UNHYDRATED_INPUT'), { code: 'EACCES' });
    }
    let opened = false;
    const performVirtualOpen = () => {
      if (opened) throw Error('VIRTUAL_DESCRIPTOR_OPENED_TWICE');
      opened = true;
      const fd = fdNext++;
      descriptors.set(fd, { file, relative });
      openCount++;
      return fd;
    };
    return onBeforeVirtualOpen
      ? onBeforeVirtualOpen({ relative, virtualRoot: root, performVirtualOpen })
      : performVirtualOpen();
  }
  function fstatSync(fd) {
    const value = descriptors.get(fd);
    if (!value) throw Object.assign(Error('VIRTUAL_FS_BAD_FD'), { code: 'EBADF' });
    return stats(value.file, value.relative);
  }
  function readFileSync(fd, encoding) {
    if (!Number.isInteger(fd) || encoding !== 'utf8') throw Error('VIRTUAL_FS_FD_UTF8_ONLY');
    const value = descriptors.get(fd);
    if (!value) throw Object.assign(Error('VIRTUAL_FS_BAD_FD'), { code: 'EBADF' });
    readCount++;
    return value.file.text;
  }
  function closeSync(fd) {
    if (!descriptors.delete(fd)) throw Object.assign(Error('VIRTUAL_FS_BAD_FD'), { code: 'EBADF' });
  }
  return Object.freeze({
    constants: Object.freeze({ ...nodeFs.constants }),
    readdirSync, lstatSync, openSync, fstatSync, readFileSync, closeSync,
    operationCount: () => Object.freeze({ open: openCount, read: readCount, unclosed: descriptors.size }),
    root,
  });
}
