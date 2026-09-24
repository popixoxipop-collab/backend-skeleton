// Web-game static scanner: a deliberately separate plane from the backend adapter registry.
// It currently targets Three.js and React Three Fiber projects. It extracts only source-backed
// facts; it never invents input-to-effect causality, scene hierarchy, or runtime state transitions.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lineNumberAt } from './text-util.mjs';
import { maskJsComments } from './adapters/_express-shared.mjs';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache']);
const THREE_PACKAGES = new Set(['three', '@react-three/fiber']);
const PHYSICS_PACKAGES = [
  '@dimforge/rapier3d',
  '@dimforge/rapier3d-compat',
  '@react-three/rapier',
  'cannon-es',
  'ammo.js',
  '@babylonjs/havok',
];

function walkFiles(root, predicate) {
  const out = [];
  function visit(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && predicate(full)) out.push(full);
    }
  }
  visit(root);
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function allDependencies(pkg) {
  return { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}), ...(pkg?.peerDependencies ?? {}) };
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function aggregateSourceHash(root, files) {
  const h = createHash('sha256');
  for (const file of files) {
    h.update(rel(root, file));
    h.update('\0');
    h.update(fs.readFileSync(file));
    h.update('\0');
  }
  return h.digest('hex');
}

export function detectWebgameProjects(repoRoot) {
  const packageFiles = walkFiles(repoRoot, (f) => path.basename(f) === 'package.json');
  const projects = [];
  for (const packageFile of packageFiles) {
    const pkg = readJson(packageFile);
    const deps = allDependencies(pkg);
    const engines = [...THREE_PACKAGES].filter((name) => Object.hasOwn(deps, name));
    if (engines.length === 0) continue;
    projects.push({
      root: path.dirname(packageFile),
      packageFile,
      engines,
      physics: PHYSICS_PACKAGES.filter((name) => Object.hasOwn(deps, name)),
    });
  }
  return projects.sort((a, b) => rel(repoRoot, a.root).localeCompare(rel(repoRoot, b.root)));
}

function importedThreeConstructors(text) {
  const named = new Set();
  const namespaces = new Set();
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]three(?:\/[^'"]*)?['"]/g)) {
    for (const raw of m[1].split(',')) {
      const piece = raw.trim();
      if (!piece) continue;
      const parts = piece.split(/\s+as\s+/);
      named.add((parts[1] ?? parts[0]).trim());
    }
  }
  for (const m of text.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]three(?:\/[^'"]*)?['"]/g)) namespaces.add(m[1]);
  return { named, namespaces };
}

function trustedThreeCtor(rawCtor, imports) {
  const parts = rawCtor.split('.');
  const ctor = parts[parts.length - 1];
  if (parts.length === 1) return imports.named.has(ctor);
  return imports.namespaces.has(parts[0]);
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractFile(root, file) {
  const raw = fs.readFileSync(file, 'utf8');
  const text = maskJsComments(raw);
  const fileRel = rel(root, file);
  const imports = importedThreeConstructors(text);
  const scenes = [];
  const entities = [];
  const hierarchy = [];
  const listeners = [];
  const keys = [];
  const systems = [];
  const loops = [];
  const renderers = [];
  const sockets = [];
  const assets = [];

  const assignNew = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;
  for (const m of text.matchAll(assignNew)) {
    if (!trustedThreeCtor(m[2], imports)) continue;
    const ctorParts = m[2].split('.');
    const ctor = ctorParts[ctorParts.length - 1];
    const base = { symbol: m[1], file: fileRel, line: lineNumberAt(text, m.index), provenance: 'static-new-expression' };
    if (ctor === 'Scene') scenes.push({ ...base, kind: 'three-scene' });
    if (['Mesh', 'SkinnedMesh', 'InstancedMesh', 'Group', 'Object3D', 'Sprite'].includes(ctor)) {
      entities.push({ ...base, kind: ctor });
    }
    if (['WebGLRenderer', 'WebGPURenderer'].includes(ctor)) renderers.push({ ...base, kind: ctor });
  }

  for (const m of text.matchAll(/<\s*Canvas\b/g)) {
    const line = lineNumberAt(text, m.index);
    scenes.push({ symbol: 'r3f-canvas@' + line, file: fileRel, line, kind: 'react-three-fiber-canvas', provenance: 'jsx-canvas' });
    renderers.push({ symbol: 'r3f-renderer@' + line, file: fileRel, line, kind: 'ReactThreeFiber', provenance: 'jsx-canvas' });
  }
  for (const m of text.matchAll(/<\s*(mesh|group|sprite|instancedMesh|skinnedMesh)\b([^>]*)>/g)) {
    const line = lineNumberAt(text, m.index);
    const name = m[2].match(/\bname\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
    entities.push({
      symbol: name ?? ('jsx-' + m[1] + '@' + line),
      file: fileRel,
      line,
      kind: 'jsx:' + m[1],
      provenance: 'jsx-tag',
    });
  }

  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\.add\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    hierarchy.push({ parent: m[1], child: m[2], file: fileRel, line: lineNumberAt(text, m.index), provenance: 'static-add-call' });
  }

  for (const m of text.matchAll(/\b(?:(window|document|canvas)\s*\.)?addEventListener\s*\(\s*["']([^"']+)["']\s*,\s*([A-Za-z_$][\w$]*)/g)) {
    listeners.push({
      target: m[1] ?? 'unknown',
      event: m[2],
      handler: m[3],
      file: fileRel,
      line: lineNumberAt(text, m.index),
      provenance: 'dom-listener',
    });
  }
  for (const m of text.matchAll(/\b(onClick|onPointerDown|onPointerUp|onPointerMove|onWheel|onKeyDown|onKeyUp)\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) {
    listeners.push({
      target: 'jsx',
      event: m[1],
      handler: m[2],
      file: fileRel,
      line: lineNumberAt(text, m.index),
      provenance: 'jsx-handler',
    });
  }
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\.(code|key)\s*===?\s*["']([^"']+)["']/g)) {
    keys.push({
      accessor: m[2],
      value: m[3],
      file: fileRel,
      line: lineNumberAt(text, m.index),
      provenance: 'literal-key-check',
    });
  }

  for (const m of text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!/^(?:update|tick|step|animate|render|physics|simulate|move)/i.test(m[1])) continue;
    systems.push({ symbol: m[1], file: fileRel, line: lineNumberAt(text, m.index), provenance: 'named-function' });
  }
  for (const m of text.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)) {
    if (!/^(?:update|tick|step|animate|render|physics|simulate|move)/i.test(m[1])) continue;
    systems.push({ symbol: m[1], file: fileRel, line: lineNumberAt(text, m.index), provenance: 'named-arrow-function' });
  }
  for (const m of text.matchAll(/\b(requestAnimationFrame|setAnimationLoop)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    loops.push({ kind: m[1], callback: m[2], file: fileRel, line: lineNumberAt(text, m.index), provenance: 'loop-registration' });
  }

  for (const m of text.matchAll(/\bnew\s+WebSocket\s*\(\s*["']([^"']+)["']/g)) {
    sockets.push({ kind: 'WebSocket', endpoint: m[1], file: fileRel, line: lineNumberAt(text, m.index), provenance: 'literal-constructor' });
  }
  for (const m of text.matchAll(/\bio\s*\(\s*["']([^"']+)["']/g)) {
    sockets.push({ kind: 'socket.io', endpoint: m[1], file: fileRel, line: lineNumberAt(text, m.index), provenance: 'literal-connect-call' });
  }

  for (const m of text.matchAll(/\b(?:(?:useGLTF|useTexture)\s*|(?:[A-Za-z_$][\w$]*\.)?(?:load|loadAsync)\s*)\(\s*["']([^"']+)["']/g)) {
    assets.push({ uri: m[1], file: fileRel, line: lineNumberAt(text, m.index), provenance: 'literal-asset-reference' });
  }

  return { scenes, entities, hierarchy, listeners, keys, systems, loops, renderers, sockets, assets };
}

export function scanWebgame(repoRoot) {
  const projects = detectWebgameProjects(repoRoot);
  if (projects.length === 0) {
    return {
      schema: 'sbf.webgame-scan/1',
      adapter: 'typescript-webgame',
      engines: [],
      project_roots: [],
      source_hash: null,
      files_read: [],
      scenes: [],
      entities: [],
      hierarchy: [],
      input: { listeners: [], keys: [] },
      simulation: { systems: [], loops: [], physics: [] },
      render: { renderers: [] },
      network: { sockets: [] },
      assets: [],
      warnings: [{ code: 'WEBGAME_ENGINE_NOT_DETECTED', message: 'no package.json declared three or @react-three/fiber' }],
      completeness: { status: 'blocked', scene_count: 0, entity_count: 0, loop_count: 0 },
    };
  }

  const sourceFiles = uniqueBy(
    projects.flatMap((p) => walkFiles(p.root, (f) => SOURCE_EXTENSIONS.has(path.extname(f)))),
    (f) => f,
  ).sort();

  const merged = {
    scenes: [], entities: [], hierarchy: [], listeners: [], keys: [],
    systems: [], loops: [], renderers: [], sockets: [], assets: [],
  };
  for (const file of sourceFiles) {
    const part = extractFile(repoRoot, file);
    for (const key of Object.keys(merged)) merged[key].push(...part[key]);
  }

  for (const key of Object.keys(merged)) {
    merged[key] = uniqueBy(merged[key], (x) => JSON.stringify(x))
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  const physics = uniqueBy(
    projects.flatMap((p) => p.physics.map((name) => ({ package: name, project_root: rel(repoRoot, p.root) || '.' }))),
    (x) => x.project_root + ':' + x.package,
  ).sort((a, b) => a.project_root.localeCompare(b.project_root) || a.package.localeCompare(b.package));

  const engines = uniqueBy(projects.flatMap((p) => p.engines), (x) => x).sort();
  const warnings = [];
  if (merged.scenes.length === 0) warnings.push({ code: 'WEBGAME_SCENE_UNRESOLVED', message: 'engine detected but no statically addressable Scene or React Three Fiber <Canvas> was found' });
  if (merged.loops.length === 0 && merged.systems.length === 0) warnings.push({ code: 'WEBGAME_SIMULATION_LOOP_UNRESOLVED', message: 'no named update/tick/animate system or animation-loop registration was found' });
  if (merged.listeners.length > 0 || merged.keys.length > 0) {
    warnings.push({ code: 'WEBGAME_INPUT_EFFECT_UNRESOLVED', message: 'input triggers were found, but v1 deliberately does not infer which state/entity mutation each trigger causes' });
  }

  const status = merged.scenes.length === 0
    ? 'partial'
    : (merged.loops.length === 0 && merged.systems.length === 0 ? 'partial' : 'complete');

  return {
    schema: 'sbf.webgame-scan/1',
    adapter: 'typescript-webgame',
    engines,
    project_roots: projects.map((p) => rel(repoRoot, p.root) || '.'),
    source_hash: aggregateSourceHash(repoRoot, sourceFiles),
    files_read: sourceFiles.map((f) => rel(repoRoot, f)),
    scenes: merged.scenes,
    entities: merged.entities,
    hierarchy: merged.hierarchy,
    input: { listeners: merged.listeners, keys: merged.keys },
    simulation: { systems: merged.systems, loops: merged.loops, physics },
    render: { renderers: merged.renderers },
    network: { sockets: merged.sockets },
    assets: merged.assets,
    warnings,
    completeness: {
      status,
      scene_count: merged.scenes.length,
      entity_count: merged.entities.length,
      loop_count: merged.loops.length,
    },
  };
}
