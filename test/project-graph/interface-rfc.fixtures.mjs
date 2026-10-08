// Fixture helpers for the T02 interface RFC probe. Not a test file: the nested runner only
// collects files ending in `.test.mjs`. Everything here is synthetic and order-stable (sorted
// directory listings) so probe output does not depend on the host filesystem.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created = [];

export function fixture(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t02-rfc-')));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

export function createdRoots() {
  return [...created];
}

export function cleanup() {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])]));
  }
  return value;
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function adapter(id, specificity, detect, extra = {}) {
  return {
    id, title: id, specificity, confidence: 'high', verificationBasis: 'synthetic-only',
    capabilities: {}, detect, ...extra,
  };
}

export const hasFile = (name, needle = null) => (dir) => {
  const file = path.join(dir, name);
  return fs.existsSync(file) && (needle === null || fs.readFileSync(file, 'utf8').includes(needle));
};

// Mirrors the legacy adapters: recognise the candidate itself, otherwise recurse into children
// (sorted) and report the first nested match. T02 must not let the parent steal that child.
export function markerAdapter(id, specificity, matches, shape = 'root', extra = {}) {
  const findChild = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      if (!ent.isDirectory() || ent.name === 'node_modules') continue;
      const child = path.join(dir, ent.name);
      if (matches(child)) return child;
      const deeper = findChild(child);
      if (deeper) return deeper;
    }
    return null;
  };
  return adapter(id, specificity, (candidateRoot) => {
    if (matches(candidateRoot)) {
      if (shape === 'srcRoot') return path.join(candidateRoot, 'src', 'main', 'java');
      if (shape === 'object') return { projectRoot: candidateRoot, globs: ['*.js'] };
      return candidateRoot;
    }
    return findChild(candidateRoot);
  }, extra);
}

export function listJs(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJs(abs, base));
    else if (ent.name.endsWith('.js')) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

export const scanStub = (projectRoot) => ({
  modules: [{ module: path.basename(projectRoot), controllers: [], entities: [], enums: [], dtos: [] }],
  filesRead: [],
});

export const fallback = adapter('generic-grep', 0, () => true, { confidence: 'low' });
export const express = (extra = {}) =>
  markerAdapter('javascript-express', 80, hasFile('package.json', '"express"'), 'object', extra);
export const spring = (extra = {}) =>
  markerAdapter('java-spring', 100, hasFile('pom.xml'), 'srcRoot', extra);
