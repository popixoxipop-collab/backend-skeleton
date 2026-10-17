import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isSupportedWebgameSource } from '../tools/webgame/parsers/index.mjs';

const HARD_IGNORES = new Set(['.git', '.hg', '.svn', 'node_modules', '.bskel', 'artifacts', 'coverage', '.cache', '.turbo']);
const REFERENCE_SEGMENTS = new Set(['reference', 'references', 'example', 'examples', 'sample', 'samples', 'upstream', 'fixtures-reference', 'fixture', 'fixtures', 'test', 'tests', '__tests__']);
const GENERATED_SEGMENTS = new Set(['dist', 'build', 'generated', 'out', '.svelte-kit', '.next']);
const VENDOR_SEGMENTS = new Set(['vendor', 'vendors', 'third_party', 'third-party']);
const TEMPLATE_SEGMENTS = new Set(['template', 'templates', 'scaffold', 'scaffolds']);

function posixRel(root, target) {
  const rel = path.relative(root, target).split(path.sep).join('/');
  return rel || '.';
}

function digestBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function digestFile(absPath) {
  return digestBytes(fs.readFileSync(absPath));
}

export function classifySourceRole(repoRelativePath) {
  const normalized = repoRelativePath.replace(/\\/g, '/');
  const segments = normalized.toLowerCase().split('/');
  const base = segments.at(-1) ?? '';
  if (segments.some((s) => VENDOR_SEGMENTS.has(s))) return 'vendor';
  if (segments.some((s) => REFERENCE_SEGMENTS.has(s))) return 'reference';
  if (segments.some((s) => GENERATED_SEGMENTS.has(s))) return 'generated';
  if (segments.some((s) => TEMPLATE_SEGMENTS.has(s)) || /\.(?:tmpl|template|mustache|hbs)$/i.test(base)) return 'template';
  return 'active';
}

function safeReadJson(absPath, repoRoot, unresolved, filesRead) {
  const rel = posixRel(repoRoot, absPath);
  filesRead.add(rel);
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    unresolved.push({
      kind: 'package-json',
      message: `could not parse ${rel}: ${err.message}`,
      source_path: rel,
      line: null,
      column: null,
      confidence: 'unresolved',
    });
    return null;
  }
}

function walk(root) {
  const files = [];
  const dirs = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let i = entries.length - 1; i >= 0; i--) {
      const ent = entries[i];
      const abs = path.join(current, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (HARD_IGNORES.has(ent.name)) continue;
        dirs.push(abs);
        stack.push(abs);
      } else if (ent.isFile()) {
        files.push(abs);
      }
    }
  }
  files.sort();
  dirs.sort();
  return { files, dirs };
}

function packageDeps(pkg) {
  if (!pkg) return {};
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
}

function projectId(repoRoot, projectRoot) {
  const rel = posixRel(repoRoot, projectRoot);
  return `project:${rel}`;
}

function nearestProjectRoot(file, roots) {
  let best = null;
  for (const root of roots) {
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!best || root.length > best.length) best = root;
  }
  return best;
}

export function discoverProjects(repoRoot) {
  const absRoot = path.resolve(repoRoot);
  const unresolved = [];
  const filesRead = new Set();
  const { files } = walk(absRoot);
  const packageFiles = files.filter((f) => path.basename(f) === 'package.json');
  const rootPackage = path.join(absRoot, 'package.json');
  const projectRoots = new Set(packageFiles.map((f) => path.dirname(f)));
  if (projectRoots.size === 0) projectRoots.add(absRoot);
  else if (fs.existsSync(rootPackage)) projectRoots.add(absRoot);

  const roots = [...projectRoots].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const projectsByRoot = new Map();
  for (const projectRoot of roots) {
    const packagePath = path.join(projectRoot, 'package.json');
    const pkg = fs.existsSync(packagePath) ? safeReadJson(packagePath, absRoot, unresolved, filesRead) : null;
    const relRoot = posixRel(absRoot, projectRoot);
    projectsByRoot.set(projectRoot, {
      schema: 'sbf.project/1',
      project_id: projectId(absRoot, projectRoot),
      root: relRoot,
      name: pkg?.name ?? (relRoot === '.' ? path.basename(absRoot) : path.basename(projectRoot)),
      package_json: fs.existsSync(packagePath) ? posixRel(absRoot, packagePath) : null,
      package_digest: fs.existsSync(packagePath) ? digestFile(packagePath) : null,
      package_role: fs.existsSync(packagePath) ? classifySourceRole(posixRel(absRoot, packagePath)) : classifySourceRole(relRoot),
      dependencies: packageDeps(pkg),
      scripts_declared: Object.keys(pkg?.scripts ?? {}).sort(),
      source_files: [],
    });
  }

  for (const file of files) {
    if (!isSupportedWebgameSource(file)) continue;
    const owner = nearestProjectRoot(file, roots) ?? absRoot;
    if (!projectsByRoot.has(owner)) {
      projectsByRoot.set(owner, {
        schema: 'sbf.project/1', project_id: projectId(absRoot, owner), root: posixRel(absRoot, owner),
        name: path.basename(owner), package_json: null, package_digest: null, package_role: classifySourceRole(posixRel(absRoot, owner)), dependencies: {}, scripts_declared: [], source_files: [],
      });
    }
    const rel = posixRel(absRoot, file);
    projectsByRoot.get(owner).source_files.push({ path: rel, role: classifySourceRole(rel) });
  }

  const projects = [...projectsByRoot.values()]
    .map((p) => ({ ...p, source_files: p.source_files.sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => a.root.localeCompare(b.root));

  return {
    repo_root: absRoot,
    projects,
    unresolved,
    files_read: [...filesRead].sort(),
  };
}

export function digestSourceTree(repoRoot) {
  const absRoot = path.resolve(repoRoot);
  const { files } = walk(absRoot);
  const h = crypto.createHash('sha256');
  for (const file of files) {
    const rel = posixRel(absRoot, file);
    h.update(rel); h.update('\0');
    h.update(fs.readFileSync(file)); h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}
