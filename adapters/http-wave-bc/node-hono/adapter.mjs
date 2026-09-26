import fs from 'node:fs';
import path from 'node:path';
import { isHonoCodeIndex, maskHonoSourceComments, scanHonoProject } from './route-graph.mjs';

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.git', 'coverage']);
const HONO_IMPORT_RE = /\bfrom\s*['"]hono(?:\/(?:quick|tiny))?['"]/;
const HONO_REQUIRE_RE = /\brequire\s*\(\s*['"]hono(?:\/(?:quick|tiny))?['"]\s*\)/;
const HONO_CONSTRUCTOR_RE = /\bnew\s+Hono(?:\s*<[^>\n]{1,500}>)?\s*\(/;

function listFilesRecursive(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function declaresHono(pkg) {
  return Boolean(pkg?.dependencies?.hono || pkg?.devDependencies?.hono || pkg?.peerDependencies?.hono);
}

function packageCandidates(repoRoot) {
  return listFilesRecursive(repoRoot)
    .filter((file) => path.basename(file) === 'package.json')
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
}

function sourceFiles(projectRoot) {
  return listFilesRecursive(projectRoot)
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
    .sort();
}

function hasCodeMatch(masked, re) {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  for (const match of masked.matchAll(new RegExp(re.source, flags))) {
    if (isHonoCodeIndex(masked, match.index)) return true;
  }
  return false;
}

function hasLiveHonoImport(masked) {
  return hasCodeMatch(masked, HONO_IMPORT_RE) || hasCodeMatch(masked, HONO_REQUIRE_RE);
}

export function detectHonoRoot(repoRoot) {
  for (const packageFile of packageCandidates(repoRoot)) {
    const pkg = readJson(packageFile);
    if (!declaresHono(pkg)) continue;

    const projectRoot = path.dirname(packageFile);
    const detected = sourceFiles(projectRoot).some((file) => {
      try {
        const masked = maskHonoSourceComments(fs.readFileSync(file, 'utf8'));
        return hasLiveHonoImport(masked) && hasCodeMatch(masked, HONO_CONSTRUCTOR_RE);
      } catch {
        return false;
      }
    });
    if (detected) return { projectRoot, packageFile };
  }
  return null;
}

export function scanHono(repoRoot, detection = detectHonoRoot(repoRoot)) {
  if (!detection) return { modules: [], filesRead: [], scanNotes: ['Hono was not detected.'] };
  return scanHonoProject({
    repoRoot,
    projectRoot: detection.projectRoot,
    packageFile: detection.packageFile,
  });
}

export const adapter = {
  contract: 'sbf.adapter/2',
  id: 'node-hono',
  title: 'Hono HTTP routes (T13 experimental leaf)',
  specificity: 55,
  confidence: 'high',
  verificationBasis: 'synthetic-only',
  capabilities: {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  },
  detect(repoRoot) {
    return detectHonoRoot(repoRoot);
  },
  scan(repoRoot, detection) {
    return scanHono(repoRoot, detection);
  },
  listReadSet(repoRoot, detection = detectHonoRoot(repoRoot)) {
    return detection ? scanHono(repoRoot, detection).filesRead : [];
  },
  diagnostics(repoRoot) {
    const detection = detectHonoRoot(repoRoot);
    return detection
      ? [{
          level: 'info',
          code: 't13-experimental-hono',
          message: 'Hono detected by package dependency plus a live hono/hono/quick/hono/tiny import and new Hono() source signal. This T13 leaf is not registered in the production scanner registry yet.',
        }]
      : [{
          level: 'info',
          code: 'hono-not-detected',
          message: 'no package declaring hono with a live supported Hono import plus new Hono() source signal was found',
        }];
  },
};
